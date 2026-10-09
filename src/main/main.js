// Lookup main process: loads the modules in start-up order and runs the app lifecycle.
const { app, BrowserWindow } = require('electron');

// Order matters: the data folder must be chosen (portable mode, OraDesk carry-over) before the
// settings are read, and the settings' Chromium flags must be applied before the app is ready.
require('./app-data');
require('./app-settings');

const db = require('./db');
const { isMac, createWindow } = require('./windows');
const { buildMenu } = require('./app-menu');

// IPC handlers and menus register themselves when loaded.
require('./connection-menus');
require('./zoom');
require('./settings-menu');
require('./ipc/shell');
require('./ipc/db');
require('./ipc/files');

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Close Oracle sessions cleanly before the process exits, so the server frees them at once.
let quitting = false;

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  db.disconnectAll().finally(() => app.quit());
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { db.disconnectAll().finally(() => app.exit(0)); });
}

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
