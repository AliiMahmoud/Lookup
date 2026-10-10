// IPC for files: export (pick file, run, cancel), CSV, open / save .sql, show in folder.
const path = require('path');
const fs = require('fs');
const { ipcMain, dialog, shell } = require('electron');
const db = require('../db');
// export.js (and exceljs behind it) is loaded on the first export, not at start.
const exportFormats = () => require('../export').FORMATS;
const { winFor } = require('../windows');
const { handle } = require('./handle');

handle('export:pickFile', async (winId, { format, name }) => {
  const f = exportFormats()[format];
  const win = winFor(winId);
  const safe = String(name || 'export').replace(/[\\/:*?"<>|]+/g, '_');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `${safe}.${f.ext}`,
    filters: [{ name: f.label, extensions: [f.ext] }],
  });
  return canceled ? null : filePath;
});

ipcMain.handle('export:run', async (event, job) => {
  try {
    const data = await db.exportData(event.sender.id, job, (rows) => {
      if (!event.sender.isDestroyed()) event.sender.send('export:progress', { jobId: job.jobId, rows });
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: { message: e.message, code: e.code } };
  }
});

handle('export:cancel', (_id, jobId) => db.cancelExport(jobId));

handle('shell:showItem', (_id, p) => shell.showItemInFolder(p));

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.$bin !== undefined) v = v.$bin;
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

handle('file:exportCsv', async (winId, { name, columns, rows }) => {
  const win = winFor(winId);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: (name || 'export') + '.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return null;
  const lines = [columns.map(csvCell).join(',')].concat(rows.map((r) => r.map(csvCell).join(',')));
  fs.writeFileSync(filePath, '﻿' + lines.join('\r\n'), 'utf8');
  return filePath;
});

handle('file:openSql', async (winId) => {
  const win = winFor(winId);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'SQL', extensions: ['sql', 'pls', 'pks', 'pkb', 'txt'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  return { name: path.basename(filePaths[0]), text: fs.readFileSync(filePaths[0], 'utf8') };
});

// Connections import / export (Oracle SQL Developer format; the window reads and writes the XML).
handle('conn:openFile', async (winId) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(winFor(winId), {
    title: 'Import connections',
    filters: [{ name: 'SQL Developer connections', extensions: ['xml', 'json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  if (fs.statSync(filePaths[0]).size > 20 * 1024 * 1024) throw new Error('That file is too large to be a connections export.');
  return { name: path.basename(filePaths[0]), text: fs.readFileSync(filePaths[0], 'utf8') };
});
handle('conn:saveFile', async (winId, text) => {
  const { canceled, filePath } = await dialog.showSaveDialog(winFor(winId), {
    title: 'Export connections',
    defaultPath: 'connections.xml',
    filters: [{ name: 'SQL Developer connections', extensions: ['xml'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, String(text), 'utf8');
  return filePath;
});

// SQLite connection form: pick a database file, or create a new empty one.
const SQLITE_FILES = [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'] }, { name: 'All files', extensions: ['*'] }];
handle('sqlite:pickFile', async (winId, current) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(winFor(winId), {
    title: 'Open SQLite database', defaultPath: current || undefined, filters: SQLITE_FILES, properties: ['openFile'],
  });
  return canceled || !filePaths[0] ? null : filePaths[0];
});
handle('sqlite:newFile', async (winId) => {
  const { canceled, filePath } = await dialog.showSaveDialog(winFor(winId), {
    title: 'New SQLite database', defaultPath: 'database.db', filters: SQLITE_FILES,
  });
  if (canceled || !filePath) return null;
  if (fs.existsSync(filePath)) throw new Error('A file with that name already exists. Use Open file to connect to it.');
  return db.createDatabaseFile('sqlite', filePath);
});

handle('file:saveSql', async (winId, { name, text }) => {
  const win = winFor(winId);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: (name || 'query') + '.sql',
    filters: [{ name: 'SQL', extensions: ['sql'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
});
