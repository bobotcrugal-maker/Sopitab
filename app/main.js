const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 8090;
const DATA_DIR_NAME = 'data';
let serverProcess = null;
let mainWindow = null;

function paths() {
  if (app.isPackaged) {
    const root = process.resourcesPath;
    return {
      node: path.join(root, 'pisotab-runtime', 'node.exe'),
      serverDir: path.join(root, 'pisotab-server', 'server'),
      serverJs: path.join(root, 'pisotab-server', 'server', 'server.js'),
      logDir: path.join(app.getPath('userData'), 'logs'),
      dataDir: path.join(app.getPath('userData'), 'data')
    };
  }
  const root = path.resolve(__dirname, '..');
  return {
    node: process.execPath,
    serverDir: path.join(root, 'server'),
    serverJs: path.join(root, 'server', 'server.js'),
    logDir: path.join(root, 'logs'),
    dataDir: path.join(root, 'data')
  };
}

function startServer() {
  const p = paths();
  fs.mkdirSync(p.logDir, { recursive: true });
  fs.mkdirSync(p.dataDir, { recursive: true });
  const logFile = path.join(p.logDir, 'server.log');
  if (!fs.existsSync(p.node)) throw new Error(`Missing bundled Node runtime: ${p.node}`);
  if (!fs.existsSync(p.serverJs)) throw new Error(`Missing PisoTab server: ${p.serverJs}`);
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  out.write(`\n--- PisoTab ${new Date().toISOString()} ---\n`);
  serverProcess = spawn(p.node, [p.serverJs], {
    cwd: p.serverDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PISOTAB_PORT: String(PORT), PISOTAB_DATA_DIR: p.dataDir }
  });
  serverProcess.stdout.pipe(out);
  serverProcess.stderr.pipe(out);
  serverProcess.on('error', err => out.write(`SPAWN ERROR: ${err.stack || err}\n`));
  serverProcess.on('exit', (code, signal) => out.write(`SERVER EXIT code=${code} signal=${signal}\n`));
  return logFile;
}

function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise(resolve => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/`, res => { res.resume(); resolve(true); });
      req.on('error', () => {
        if (Date.now() - start >= timeoutMs) resolve(false);
        else setTimeout(check, 500);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    check();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 650,
    title: 'PisoTab Dashboard', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  const ok = await waitForServer();
  if (!ok) {
    const logFile = paths().logDir + path.sep + 'server.log';
    dialog.showErrorBox('PisoTab Server Error',
      `Hindi ma-start ang PisoTab server sa port ${PORT}.\n\nLog file:\n${logFile}`);
    return;
  }
  await mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
}

app.whenReady().then(async () => {
  try {
    startServer();
    await createWindow();
  } catch (e) {
    dialog.showErrorBox('PisoTab Server Error', String(e.stack || e));
    app.quit();
  }
});

app.on('before-quit', () => {
  try { if (serverProcess && !serverProcess.killed) serverProcess.kill(); } catch (_) {}
});
app.on('window-all-closed', () => app.quit());
