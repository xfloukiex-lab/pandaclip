const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

// The multi-source watcher needs node:sqlite (system node >= 22.5); Electron's
// bundled Node is too old, so it runs as a child of the system node. In a
// packaged app it must run from the asarUnpacked copy — external node cannot
// read inside app.asar.
const WATCHER = path.join(__dirname, "watcher.js").replace("app.asar", "app.asar.unpacked");
const ICON = path.join(__dirname, "..", "ui", "assets", "icon.ico");

let win = null;
let overlay = null;
let tray = null;
let child = null;

function send(chan, payload) {
  for (const w of [win, overlay]) {
    if (w && !w.isDestroyed()) w.webContents.send(chan, payload);
  }
}

function startWatcher() {
  child = spawn("node", [WATCHER], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "event") send("lens:event", msg);
    else if (msg.type === "clipboard_snapshot") send("lens:clipboard", msg.entries);
    else if (msg.type === "projects") send("lens:projects", msg.projects);
    else if (msg.type === "ready") send("lens:status", { connected: true, sources: msg.sources });
  });
  child.on("error", () => send("lens:status", { connected: false, error: "system node not found — install Node.js >= 22.5" }));
  child.on("exit", (code) => {
    send("lens:status", { connected: false, error: `watcher exited (${code}) — retrying` });
    setTimeout(startWatcher, 3000);
  });
}

function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    width: 360,
    height: 540,
    x: workArea.x + workArea.width - 380,
    y: workArea.y + 20,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.loadFile(path.join(__dirname, "..", "ui", "overlay.html"));
}

function toggleOverlay() {
  if (!overlay || overlay.isDestroyed()) return createOverlay();
  overlay.isVisible() ? overlay.hide() : overlay.show();
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    backgroundColor: "#f4f7ee",
    title: "PandaClip",
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "..", "ui", "index.html"));
  createOverlay();

  tray = new Tray(ICON);
  tray.setToolTip("PandaClip — agent activity lens (Ctrl+Alt+L toggles the hover panel)");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show main window", click: () => { win?.show(); win?.focus(); } },
    { label: "Toggle hover panel\tCtrl+Alt+L", click: toggleOverlay },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", toggleOverlay);
  globalShortcut.register("Control+Alt+L", toggleOverlay);

  ipcMain.handle("lens:bootstrap", () => ({}));
  ipcMain.on("lens:overlay-hide", () => overlay?.hide());
  ipcMain.on("lens:overlay-toggle", toggleOverlay);
  ipcMain.on("lens:overlay-open-main", () => { win?.show(); win?.focus(); });
  startWatcher();
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("window-all-closed", () => {
  try { child?.kill(); } catch { /* already dead */ }
  app.quit();
});
