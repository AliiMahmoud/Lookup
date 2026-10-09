// Windows and their connection workspaces: one shell (title bar + rail) and one view per connection.
const path = require('path');
const { BrowserWindow, WebContentsView, nativeTheme, shell } = require('electron');
const db = require('./db');
const { settings } = require('./app-settings');

const isMac = process.platform === 'darwin';

function overlayColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#1b1d22', symbolColor: '#c9ccd3', height: 40 }
    : { color: '#f4f4f2', symbolColor: '#3a3d44', height: 40 };
}

const TITLE_H = 40;

const RAIL_W = 76;

 // left rail with one tile per open connection
const wsByWc = new Map();

 // workspace webContents id -> { win, view, state }

const webPrefs = () => ({
  preload: path.join(__dirname, '../preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
});

// A window = a title bar with connection tabs (the "shell") + one workspace view per connection.
function createWindow({ connectId } = {}) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    title: 'Lookup',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181c' : '#fbfbfa',
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? undefined : overlayColors(),
    trafficLightPosition: { x: 14, y: 13 },
    icon: path.join(__dirname, '../../build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { ...webPrefs(), preload: path.join(__dirname, '../shell-preload.js') },
  });
  win.workspaces = [];
  win.activeWs = null;
  win.loadFile(path.join(__dirname, '../renderer/shell.html'));
  win.on('resize', () => layout(win));
  win.on('closed', () => {
    for (const ws of win.workspaces) {
      wsByWc.delete(ws.id);
      db.disconnect(ws.id);
    }
  });
  win.webContents.once('did-finish-load', () => addWorkspace(win, { connectId }));
  return win;
}

function addWorkspace(win, { connectId } = {}) {
  const view = new WebContentsView({ webPreferences: webPrefs() });
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#16181c' : '#fbfbfa');
  const id = view.webContents.id;
  const ws = { id, win, view, state: { connected: false, title: 'New connection' } };
  wsByWc.set(id, ws);
  win.workspaces.push(ws);
  win.contentView.addChildView(view);
  view.webContents.loadFile(path.join(__dirname, '../renderer/index.html'), {
    query: connectId ? { embedded: '1', connect: connectId } : { embedded: '1' },
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  view.webContents.on('destroyed', () => db.disconnect(id));
  view.webContents.on('did-finish-load', () => view.webContents.setZoomFactor((settings.zoom || 100) / 100)); // window zoom applies to every connection
  activateWorkspace(win, id);
  return ws;
}

function layout(win) {
  if (win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  for (const ws of win.workspaces) {
    ws.view.setBounds({ x: RAIL_W, y: TITLE_H, width: Math.max(0, w - RAIL_W), height: Math.max(0, h - TITLE_H) });
    ws.view.setVisible(ws.id === win.activeWs);
  }
}

function activateWorkspace(win, id) {
  const ws = win.workspaces.find((x) => x.id === id);
  if (!ws) return;
  // Leaving an empty "New" tile (not connected, not connecting) removes it.
  const prev = win.workspaces.find((x) => x.id === win.activeWs);
  if (prev && prev !== ws && !prev.state.connected && !prev.state.connecting && win.workspaces.length > 1) {
    win.workspaces.splice(win.workspaces.indexOf(prev), 1);
    wsByWc.delete(prev.id);
    win.contentView.removeChildView(prev.view);
    if (!prev.view.webContents.isDestroyed()) prev.view.webContents.close();
  }
  win.activeWs = id;
  layout(win);
  ws.view.webContents.focus();
  ws.view.webContents.send('ws:action', { action: 'shown' });
  pushShell(win);
}

function closeWorkspace(win, id) {
  const i = win.workspaces.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [ws] = win.workspaces.splice(i, 1);
  wsByWc.delete(id);
  win.contentView.removeChildView(ws.view);
  db.disconnect(id).finally(() => { if (!ws.view.webContents.isDestroyed()) ws.view.webContents.close(); });
  if (!win.workspaces.length) addWorkspace(win);
  else if (win.activeWs === id) activateWorkspace(win, (win.workspaces[i] || win.workspaces[i - 1]).id);
  else pushShell(win);
}

function cycleWorkspace(win, dir) {
  if (!win || !win.workspaces.length) return;
  const i = win.workspaces.findIndex((x) => x.id === win.activeWs);
  const n = win.workspaces[(i + dir + win.workspaces.length) % win.workspaces.length];
  activateWorkspace(win, n.id);
}

function pushShell(win) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('shell:workspaces', {
    active: win.activeWs,
    list: win.workspaces.map((ws) => ({ id: ws.id, ...ws.state })),
  });
  const active = win.workspaces.find((x) => x.id === win.activeWs);
  win.setTitle(active && active.state.connected ? `${active.state.title} — Lookup` : 'Lookup');
}

/** The BrowserWindow hosting a workspace (or shell) webContents id. */
function winFor(wcId) {
  const ws = wsByWc.get(wcId);
  if (ws) return ws.win;
  return BrowserWindow.getAllWindows().find((w) => w.webContents.id === wcId) || BrowserWindow.getFocusedWindow();
}

function activeWorkspaceOf(win) {
  return win && win.workspaces ? win.workspaces.find((x) => x.id === win.activeWs) : null;
}

nativeTheme.on('updated', () => {
  const bg = nativeTheme.shouldUseDarkColors ? '#16181c' : '#fbfbfa';
  for (const w of BrowserWindow.getAllWindows()) {
    w.setBackgroundColor(bg);
    for (const ws of w.workspaces || []) ws.view.setBackgroundColor(bg);
    if (!isMac) { try { w.setTitleBarOverlay(overlayColors()); } catch { /* not supported */ } }
  }
});

function focusedWin() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
}

function activeWc() {
  const ws = activeWorkspaceOf(focusedWin());
  return ws ? ws.view.webContents : null;
}

module.exports = { isMac, TITLE_H, RAIL_W, wsByWc, createWindow, addWorkspace, activateWorkspace, closeWorkspace, cycleWorkspace, pushShell, winFor, activeWorkspaceOf, focusedWin, activeWc };
