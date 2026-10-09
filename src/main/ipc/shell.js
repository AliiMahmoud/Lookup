// Messages between the title bar / rail (shell) and the connection workspaces.
const { BrowserWindow, ipcMain } = require('electron');
const store = require('../store');
const { wsByWc, activateWorkspace, closeWorkspace, pushShell, activeWorkspaceOf } = require('../windows');
const { connKey, focusExisting, openConnection, popupPdbMenu, popupConnectMenu } = require('../connection-menus');
const { showMenu } = require('../popup-menu');
const { handle } = require('./handle');

ipcMain.on('ws:state', (event, state) => {
  const ws = wsByWc.get(event.sender.id);
  if (!ws) return;
  ws.state = { ...ws.state, ...state };
  ws.state.connKey = state.connId ? connKey(store.connections.get(state.connId)) : null;
  pushShell(ws.win);
});

ipcMain.on('ws:closeSelf', (event) => {
  const ws = wsByWc.get(event.sender.id);
  if (ws) closeWorkspace(ws.win, ws.id);
});

ipcMain.on('ws:openConnection', (event, connId) => {
  const ws = wsByWc.get(event.sender.id);
  if (ws) openConnection(ws.win, connId, null);
});

// Asked by a tab right before it connects: if that database is already open elsewhere, switch there.
handle('ws:focusExisting', (wcId, connId) => focusExisting(connId, wcId));

ipcMain.on('shell:ready', (event) => { const w = BrowserWindow.fromWebContents(event.sender); if (w) pushShell(w); });

ipcMain.on('shell:activate', (event, id) => activateWorkspace(BrowserWindow.fromWebContents(event.sender), id));

ipcMain.on('shell:close', (event, id) => {
  const ws = wsByWc.get(id);
  if (ws) ws.view.webContents.send('ws:action', { action: 'close' }); // lets it ask about unsaved edits first
});

ipcMain.on('shell:connectMenu', (event, at) => popupConnectMenu(BrowserWindow.fromWebContents(event.sender), { at }));

ipcMain.on('shell:pdbMenu', (event, at) => popupPdbMenu(BrowserWindow.fromWebContents(event.sender), at));

// Right-click on a rail tile.
ipcMain.on('shell:tileMenu', (event, id) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const ws = wsByWc.get(id);
  if (!win || !ws) return;
  const i = win.workspaces.indexOf(ws);
  const move = (to) => { win.workspaces.splice(i, 1); win.workspaces.splice(to, 0, ws); pushShell(win); };
  showMenu(win, [
    { label: ws.state.connected ? 'Disconnect' : 'Close', accelerator: 'CmdOrCtrl+Shift+W', click: () => ws.view.webContents.send('ws:action', { action: 'close' }) },
    { type: 'separator' },
    { label: 'Move up', enabled: i > 0, click: () => move(i - 1) },
    { label: 'Move down', enabled: i < win.workspaces.length - 1, click: () => move(i + 1) },
    { type: 'separator' },
    { label: 'Disconnect all others', enabled: win.workspaces.length > 1, click: () => win.workspaces.filter((x) => x !== ws).forEach((x) => x.view.webContents.send('ws:action', { action: 'close' })) },
  ].filter(Boolean));
});

ipcMain.on('shell:action', (event, action) => {
  const ws = activeWorkspaceOf(BrowserWindow.fromWebContents(event.sender));
  if (ws) ws.view.webContents.send('ws:action', { action });
});

ipcMain.on('shell:move', (event, { id, to }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const i = win.workspaces.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [ws] = win.workspaces.splice(i, 1);
  win.workspaces.splice(Math.max(0, Math.min(to, win.workspaces.length)), 0, ws);
  pushShell(win);
});
