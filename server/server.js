const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const Database = require("better-sqlite3");

const ROOT = __dirname;
const DATA_DIR = process.env.PISOTAB_DATA_DIR || ROOT;
fs.mkdirSync(DATA_DIR, { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const PORT = Number(process.env.PISOTAB_PORT || config.port || 8090);
const HEARTBEAT_TIMEOUT = Number(config.heartbeatTimeoutSeconds || 20) * 1000;

const db = new Database(path.join(DATA_DIR, "pisotab.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS tablets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  battery INTEGER NOT NULL DEFAULT 0,
  connected INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  timer_end_at INTEGER,
  paused_seconds INTEGER NOT NULL DEFAULT 0,
  low_battery INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tablet_id TEXT,
  type TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, "..", "dashboard")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
const sockets = new Map();

function now() { return Date.now(); }

function rowToTablet(row) {
  const remaining = row.timer_end_at ? Math.max(0, Math.ceil((row.timer_end_at - now()) / 1000)) : 0;
  return {
    id: row.id,
    name: row.name,
    battery: row.battery,
    connected: Boolean(row.connected),
    lastSeen: row.last_seen,
    remainingSeconds: row.timer_end_at ? remaining : row.paused_seconds,
    running: Boolean(row.timer_end_at && remaining > 0),
    paused: Boolean(!row.timer_end_at && row.paused_seconds > 0),
    lowBattery: Boolean(row.low_battery)
  };
}

function allTablets() {
  return db.prepare("SELECT * FROM tablets ORDER BY name, id").all().map(rowToTablet);
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of sockets.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastState() {
  broadcast({ type: "state", tablets: allTablets() });
}

function logEvent(tabletId, type, data = {}) {
  db.prepare("INSERT INTO events(tablet_id,type,data,created_at) VALUES(?,?,?,?)")
    .run(tabletId, type, JSON.stringify(data), now());
}

function sendToTablet(id, obj) {
  const ws = sockets.get(id);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function setTimer(id, seconds) {
  const row = db.prepare("SELECT * FROM tablets WHERE id=?").get(id);
  if (!row) return;
  const base = row.timer_end_at ? Math.max(row.timer_end_at, now()) : now();
  const end = base + Math.max(0, Number(seconds)) * 1000;
  db.prepare("UPDATE tablets SET timer_end_at=?, paused_seconds=0, updated_at=? WHERE id=?")
    .run(end, now(), id);
  logEvent(id, "add_time", { seconds });
  sendToTablet(id, { type: "timer", remainingSeconds: Math.ceil((end - now()) / 1000), running: true });
}

function pauseTimer(id) {
  const row = db.prepare("SELECT * FROM tablets WHERE id=?").get(id);
  if (!row) return;
  const remaining = row.timer_end_at ? Math.max(0, Math.ceil((row.timer_end_at - now()) / 1000)) : row.paused_seconds;
  db.prepare("UPDATE tablets SET timer_end_at=NULL, paused_seconds=?, updated_at=? WHERE id=?")
    .run(remaining, now(), id);
  logEvent(id, "pause", { remaining });
  sendToTablet(id, { type: "timer", remainingSeconds: remaining, running: false });
}

function resumeTimer(id) {
  const row = db.prepare("SELECT * FROM tablets WHERE id=?").get(id);
  if (!row || row.paused_seconds <= 0) return;
  const end = now() + row.paused_seconds * 1000;
  db.prepare("UPDATE tablets SET timer_end_at=?, paused_seconds=0, updated_at=? WHERE id=?")
    .run(end, now(), id);
  logEvent(id, "resume", {});
  sendToTablet(id, { type: "timer", remainingSeconds: row.paused_seconds, running: true });
}

function stopTimer(id) {
  db.prepare("UPDATE tablets SET timer_end_at=NULL, paused_seconds=0, updated_at=? WHERE id=?").run(now(), id);
  logEvent(id, "stop", {});
  sendToTablet(id, { type: "timer", remainingSeconds: 0, running: false });
}

app.get("/api/health", (req, res) => res.json({ ok: true, now: now() }));
app.get("/api/tablets", (req, res) => res.json({ tablets: allTablets() }));

app.post("/api/admin", (req, res) => {
  res.json({ ok: req.body && req.body.pin === String(config.adminPin) });
});

app.post("/api/tablets/:id/command", (req, res) => {
  const { id } = req.params;
  const { command, seconds } = req.body || {};
  if (!["add", "pause", "resume", "stop"].includes(command)) return res.status(400).json({ error: "Invalid command" });
  if (!db.prepare("SELECT 1 FROM tablets WHERE id=?").get(id)) return res.status(404).json({ error: "Tablet not found" });

  if (command === "add") setTimer(id, Number(seconds || 0));
  if (command === "pause") pauseTimer(id);
  if (command === "resume") resumeTimer(id);
  if (command === "stop") stopTimer(id);

  broadcastState();
  res.json({ ok: true });
});

app.post("/api/tablets/:id/screen", (req, res) => {
  const { id } = req.params;
  const action = String(req.body?.action || "").toLowerCase();
  if (!["on", "off"].includes(action)) return res.status(400).json({ error: "Invalid screen action" });
  if (!db.prepare("SELECT 1 FROM tablets WHERE id=?").get(id)) return res.status(404).json({ error: "Tablet not found" });
  const sent = sendToTablet(id, { type: "screen", action });
  logEvent(id, "screen_command", { action, sent });
  res.json({ ok: true, sent });
});

app.post("/api/tablets/:id/rename", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name required" });
  db.prepare("UPDATE tablets SET name=?, updated_at=? WHERE id=?").run(name, now(), req.params.id);
  logEvent(req.params.id, "rename", { name });
  broadcastState();
  res.json({ ok: true });
});

wss.on("connection", (ws) => {
  let tabletId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "register") {
      tabletId = String(msg.id || "").trim();
      if (!tabletId) return ws.close();

      const existing = db.prepare("SELECT * FROM tablets WHERE id=?").get(tabletId);
      const t = now();
      if (existing) {
        db.prepare("UPDATE tablets SET name=?, battery=?, connected=1, last_seen=?, updated_at=? WHERE id=?")
          .run(String(msg.name || existing.name), Number(msg.battery || 0), 1, t, t, tabletId);
      } else {
        db.prepare("INSERT INTO tablets(id,name,battery,connected,last_seen,updated_at) VALUES(?,?,?,?,?,?)")
          .run(tabletId, String(msg.name || tabletId), Number(msg.battery || 0), 1, t, t);
      }
      sockets.set(tabletId, ws);
      logEvent(tabletId, "connect", {});
      const row = db.prepare("SELECT * FROM tablets WHERE id=?").get(tabletId);
      ws.send(JSON.stringify({ type: "welcome", tablet: rowToTablet(row) }));
      broadcastState();
      return;
    }

    if (!tabletId) return;

    if (msg.type === "screenAck") {
      logEvent(tabletId, "screen_ack", {
        action: String(msg.action || ""),
        success: Boolean(msg.success)
      });
      return;
    }

    if (msg.type === "heartbeat") {
      const battery = Math.max(0, Math.min(100, Number(msg.battery || 0)));
      const low = battery <= 20 ? 1 : 0;
      db.prepare("UPDATE tablets SET battery=?, connected=1, last_seen=?, low_battery=?, updated_at=? WHERE id=?")
        .run(battery, now(), low, now(), tabletId);
      broadcastState();
    }
  });

  ws.on("close", () => {
    if (tabletId) {
      if (sockets.get(tabletId) === ws) sockets.delete(tabletId);
      db.prepare("UPDATE tablets SET connected=0, updated_at=? WHERE id=?").run(now(), tabletId);
      broadcastState();
    }
  });
});

setInterval(() => {
  const cutoff = now() - HEARTBEAT_TIMEOUT;
  const stale = db.prepare("SELECT id FROM tablets WHERE connected=1 AND last_seen < ?").all(cutoff);
  for (const t of stale) {
    db.prepare("UPDATE tablets SET connected=0, updated_at=? WHERE id=?").run(now(), t.id);
    const ws = sockets.get(t.id);
    if (ws) sockets.delete(t.id);
  }

  const expired = db.prepare("SELECT id FROM tablets WHERE timer_end_at IS NOT NULL AND timer_end_at <= ?").all(now());
  for (const t of expired) {
    db.prepare("UPDATE tablets SET timer_end_at=NULL, paused_seconds=0, updated_at=? WHERE id=?").run(now(), t.id);
    sendToTablet(t.id, { type: "timer", remainingSeconds: 0, running: false });
    logEvent(t.id, "expired", {});
  }
  broadcastState();
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PisoTab v0.2 running on http://0.0.0.0:${PORT}`);
  console.log("Local Wi-Fi mode: no cloud service is used.");
});
