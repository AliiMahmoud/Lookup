// IPC for saved connections, history and the database layer (one database session per workspace).
const { clipboard } = require('electron');
const db = require('../db');
const store = require('../store');
const { wsByWc, createWindow } = require('../windows');
const { handle } = require('./handle');

handle('conn:list', () => store.connections.list());

handle('conn:save', (_id, conn) => store.connections.save(conn));

// Show-password button in the connection form: only on an explicit click, for one saved connection.
handle('conn:revealPassword', (_id, connId) => (store.connections.get(connId) || {}).password || '');

// Export / import with passwords: sealed with the password the user chose for the file.
handle('conn:sealPasswords', (_id, filePassword) => {
  const plain = {};
  for (const c of store.connections.list()) {
    const pw = c.hasPassword ? (store.connections.get(c.id) || {}).password : '';
    if (pw) plain[c.id] = pw;
  }
  return require('../conn-seal').seal(plain, filePassword);
});
handle('conn:openPasswords', (_id, sealed, filePassword) => require('../conn-seal').open(sealed, filePassword));
handle('conn:delete', (_id, connId) => store.connections.remove(connId));
handle('conn:reorder', (_id, ids) => store.connections.reorder(ids));

handle('conn:test', (_id, cfg) => {
  let full = cfg;
  if (cfg.keepPassword && cfg.id) full = { ...cfg, password: (store.connections.get(cfg.id) || {}).password };
  return db.test(full);
});

handle('db:connect', (winId, connId, password) => {
  const cfg = store.connections.get(connId);
  if (!cfg) throw new Error('Connection not found');
  return db.connect(winId, password !== undefined ? { ...cfg, password } : cfg);
});

handle('db:connectWith', (winId, cfg) => db.connect(winId, cfg));

handle('db:reconnect', (winId) => db.reconnect(winId));

handle('db:cancelConnect', (winId) => db.cancelConnect(winId));

// The database went away (Stop got no answer, a call failed with a broken-connection error, or the
// idle health check timed out): tell that connection's view so it can offer Reconnect.
db.setOnLost((winId, message) => {
  const ws = wsByWc.get(winId);
  if (ws && !ws.view.webContents.isDestroyed()) ws.view.webContents.send('ws:action', { action: 'connectionLost', message });
});

// Engine-specific calls (Redis), and what the engine sends on its own (Shell subscriptions).
handle('db:op', (winId, name, params) => db.engineOp(winId, name, params));
db.setOnPush((winId, msg) => {
  const ws = wsByWc.get(winId);
  if (ws && !ws.view.webContents.isDestroyed()) ws.view.webContents.send('db:push', msg);
});

handle('db:disconnect', (winId) => db.disconnect(winId));

handle('db:cancel', (winId) => db.cancel(winId));

handle('db:closeStuckSession', (winId) => db.closeStuckSession(winId));

handle('db:schemas', (winId) => db.schemas(winId));

handle('db:objects', (winId, owner) => db.objects(winId, owner));

handle('db:columns', (winId, owner, table) => db.columns(winId, owner, table));

handle('db:tableData', (winId, opts) => db.tableData(winId, opts));

handle('db:structure', (winId, owner, name) => db.structure(winId, owner, name));

handle('db:ddl', (winId, owner, name, type, options) => db.ddl(winId, owner, name, type, options));

// The formatter (about 8 MB) is loaded on first use.
handle('sql:format', (winId, text, engineId) => require('../format').formatScript(String(text || ''), db.dialectOf(winId, engineId)));

handle('db:run', (winId, statements, opts) => db.run(winId, statements, opts));

handle('db:createTableSql', (winId, spec) => db.createTableSql(winId, spec));

handle('db:createTable', (winId, spec) => db.createTable(winId, spec));

handle('db:alterTableSql', (winId, plan) => db.alterTableSql(winId, plan));

handle('db:alterTable', (winId, plan) => db.alterTable(winId, plan));

handle('db:sqlLog', (winId, sinceId) => db.sqlLog(winId, sinceId));

handle('db:sqlLogClear', (winId) => db.clearSqlLog(winId));

handle('db:truncateTable', (winId, owner, table) => db.truncateTable(winId, owner, table));

handle('db:dropTable', (winId, owner, table, opts) => db.dropTable(winId, owner, table, opts));

handle('db:setAutoCommit', (winId, on) => db.setAutoCommit(winId, on));

handle('db:commit', (winId) => db.commit(winId));

handle('db:rollback', (winId) => db.rollback(winId));

handle('db:previewChanges', (winId, payload) => db.previewChanges(winId, payload));

handle('db:applyChanges', (winId, payload) => db.applyChanges(winId, payload));

handle('history:list', (_id, connId) => store.history.list(connId));

handle('history:add', (_id, connId, sql) => store.history.add(connId, sql));

handle('app:newWindow', () => { createWindow(); });

handle('app:isEmbedded', () => true);

handle('app:platform', () => process.platform);

handle('app:copy', (_id, text) => clipboard.writeText(String(text)));
