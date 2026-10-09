// Safe bridge for a connection workspace: exposes window.api (IPC to the main process) and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

// Unwraps { ok, data } / { ok: false, error } from the main process.
const call = async (channel, ...args) => {
  let res;
  try {
    res = await ipcRenderer.invoke(channel, ...args);
  } catch (e) {
    // The window has newer code than the running app process (files updated while Lookup was open).
    if (/No handler registered/.test(e.message)) {
      throw new Error('Lookup was updated while it was running. Quit Lookup completely (close every window) and start it again with npm start.');
    }
    throw e;
  }
  if (res && res.ok) return res.data;
  const err = new Error(res && res.error ? res.error.message : 'Unknown error');
  if (res && res.error) Object.assign(err, res.error);
  throw err;
};

contextBridge.exposeInMainWorld('api', {
  // Connection-tab plumbing (this page is one tab of a window)
  wsState: (state) => ipcRenderer.send('ws:state', state),
  onWsAction: (cb) => ipcRenderer.on('ws:action', (_e, msg) => cb(msg)),
  closeSelf: () => ipcRenderer.send('ws:closeSelf'),
  openConnection: (connId) => ipcRenderer.send('ws:openConnection', connId),
  focusExisting: (connId) => call('ws:focusExisting', connId),
  listConnections: () => call('conn:list'),
  zoomWindow: (dir) => call('ws:zoomWindow', dir),
  revealPassword: (connId) => call('conn:revealPassword', connId),
  saveConnection: (c) => call('conn:save', c),
  deleteConnection: (id) => call('conn:delete', id),
  testConnection: (c) => call('conn:test', c),
  connect: (id, password) => call('db:connect', id, password),
  disconnect: () => call('db:disconnect'),
  cancel: () => call('db:cancel'),
  closeStuckSession: () => call('db:closeStuckSession'),
  reconnect: () => call('db:reconnect'),
  cancelConnect: () => call('db:cancelConnect'),
  appSettings: () => call('app:settings'),
  setAppSetting: (key, value) => call('app:setSetting', key, value),
  schemas: () => call('db:schemas'),
  objects: (owner) => call('db:objects', owner),
  columns: (owner, table) => call('db:columns', owner, table),
  tableData: (opts) => call('db:tableData', opts),
  structure: (owner, name) => call('db:structure', owner, name),
  ddl: (owner, name, type, options) => call('db:ddl', owner, name, type, options),
  exportPickFile: (format, name) => call('export:pickFile', { format, name }),
  exportRun: (job) => call('export:run', job),
  exportCancel: (jobId) => call('export:cancel', jobId),
  onExportProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('export:progress', fn);
    return () => ipcRenderer.removeListener('export:progress', fn);
  },
  showInFolder: (p) => call('shell:showItem', p),
  formatSql: (text) => call('sql:format', text),
  run: (statements, opts) => call('db:run', statements, opts),
  createTableSql: (spec) => call('db:createTableSql', spec),
  createTable: (spec) => call('db:createTable', spec),
  alterTableSql: (plan) => call('db:alterTableSql', plan),
  alterTable: (plan) => call('db:alterTable', plan),
  sqlLog: (sinceId) => call('db:sqlLog', sinceId),
  sqlLogClear: () => call('db:sqlLogClear'),
  truncateTable: (owner, table) => call('db:truncateTable', owner, table),
  dropTable: (owner, table, opts) => call('db:dropTable', owner, table, opts),
  setAutoCommit: (on) => call('db:setAutoCommit', on),
  commit: () => call('db:commit'),
  rollback: () => call('db:rollback'),
  previewChanges: (p) => call('db:previewChanges', p),
  applyChanges: (p) => call('db:applyChanges', p),
  history: (connId) => call('history:list', connId),
  addHistory: (connId, sql) => call('history:add', connId, sql),
  exportCsv: (p) => call('file:exportCsv', p),
  openSql: () => call('file:openSql'),
  openConnectionsFile: () => call('conn:openFile'),
  saveConnectionsFile: (text) => call('conn:saveFile', text),
  sealPasswords: (filePassword) => call('conn:sealPasswords', filePassword),
  openPasswords: (sealed, filePassword) => call('conn:openPasswords', sealed, filePassword),
  saveSql: (p) => call('file:saveSql', p),
  newWindow: () => call('app:newWindow'),
  platform: () => call('app:platform'),
  version: () => call('app:version'),
  copy: (text) => call('app:copy', text),
});
