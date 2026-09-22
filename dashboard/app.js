let tablets = [];
let ws;
let adminUnlocked = false;
const $ = id => document.getElementById(id);

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => $("connection").textContent = "● Local server connected";
  ws.onclose = () => { $("connection").textContent = "○ Reconnecting…"; setTimeout(connect, 1500); };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") { tablets = msg.tablets; render(); }
  };
}
async function load() {
  const r = await fetch("/api/tablets");
  const j = await r.json();
  tablets = j.tablets; render();
}
function fmt(sec) {
  sec = Math.max(0, Number(sec||0));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return h ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
async function screenCommand(id, action) {
  const r = await fetch(`/api/tablets/${encodeURIComponent(id)}/screen`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action})
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return alert(j.error || "Screen command failed.");
  if (!j.sent) return alert("Command saved, but tablet is offline.");
  const btn = document.querySelector(`[data-screen="${CSS.escape(id)}"]`);
  if (btn) { const old=btn.textContent; btn.textContent="Sent ✓"; setTimeout(()=>btn.textContent=old,1200); }
}
async function command(id, command, seconds=0) {
  await fetch(`/api/tablets/${encodeURIComponent(id)}/command`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command,seconds})
  });
  load();
}
function render() {
  $("summary").textContent = `${tablets.length} tablet(s)`;
  $("grid").innerHTML = tablets.map(t => `
    <article class="card ${t.lowBattery ? "low":""}">
      <div class="top">
        <div><div class="name">${esc(t.name)}</div><small>${esc(t.id)}</small></div>
        <span class="status ${t.connected ? "online":"offline"}">${t.connected ? "ONLINE":"OFFLINE"}</span>
      </div>
      <div class="battery">${t.battery}% ${t.lowBattery ? '<div class="warning">⚠ BATTERY LOW</div>':''}</div>
      <div class="timer">${fmt(t.remainingSeconds)}</div>
      <div class="add">
        <button onclick="command('${t.id}','add',300)">+5m</button>
        <button onclick="command('${t.id}','add',600)">+10m</button>
        <button onclick="command('${t.id}','add',1800)">+30m</button>
      </div>
      <div class="controls screen-controls">
        <button data-screen="${esc(t.id)}" onclick="screenCommand('${t.id}','on')">SCREEN ON</button>
        <button onclick="screenCommand('${t.id}','off')">SCREEN OFF</button>
      </div>
      <div class="controls">
        <button onclick="command('${t.id}','pause')">Pause</button>
        <button onclick="command('${t.id}','resume')">Resume</button>
        <button onclick="command('${t.id}','stop')">Stop</button>
        <button onclick="addCustom('${t.id}')">Custom</button>
      </div>
      <button class="rename" onclick="renameTablet('${t.id}')">Rename</button>
    </article>
  `).join("");
}
async function addCustom(id) {
  const mins = Number(prompt("Minutes to add:"));
  if (mins > 0) command(id,"add",Math.round(mins*60));
}
async function renameTablet(id) {
  if (!adminUnlocked) return alert("Admin unlock required.");
  const name = prompt("New tablet name:");
  if (!name) return;
  await fetch(`/api/tablets/${encodeURIComponent(id)}/rename`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name})
  });
  load();
}
function esc(s) { return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

$("adminBtn").onclick = () => $("adminDialog").showModal();
$("adminForm").onsubmit = async e => {
  e.preventDefault();
  const pin = $("pin").value;
  const r = await fetch("/api/admin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pin})});
  const j = await r.json();
  if (j.ok) {
    adminUnlocked = true; $("adminDialog").close(); $("pin").value="";
    alert("Admin unlocked.");
  } else alert("Wrong PIN.");
};
$("refreshBtn").onclick = load;

setInterval(render, 1000);
connect();
load();
