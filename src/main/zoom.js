// Zoom: Ctrl+= / Ctrl+- / Ctrl+0 zoom the SQL editor when it has focus, otherwise every connection view.
const { BrowserWindow, ipcMain } = require('electron');
const { writeSettings, settings } = require('./app-settings');
const { winFor, activeWc } = require('./windows');

// Shell (title bar) <-> workspace messaging
// Ctrl+= / Ctrl+- / Ctrl+0 go to the active connection view first: if the SQL editor has focus
// it zooms just that editor; otherwise it asks for the whole window to zoom (ws:zoomWindow).
const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];

 // percent, like a browser
function zoomKey(dir) {
  const wc = activeWc();
  if (wc) wc.send('ws:action', { action: 'zoom', dir });
}

function zoomWindow(win, dir) {
  const cur = settings.zoom || 100;
  const next = dir === 0 ? 100
    : (dir > 0 ? ZOOM_STEPS.find((s) => s > cur) : [...ZOOM_STEPS].reverse().find((s) => s < cur)) || cur;
  settings.zoom = next;
  writeSettings(settings);
  for (const w of BrowserWindow.getAllWindows()) for (const ws of w.workspaces || []) ws.view.webContents.setZoomFactor(next / 100);
  return next;
}

ipcMain.handle('ws:zoomWindow', (event, dir) => {
  try { return { ok: true, data: zoomWindow(winFor(event.sender.id), dir) }; } catch (e) { return { ok: false, error: e.message }; }
});

module.exports = { zoomKey };
