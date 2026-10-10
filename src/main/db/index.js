// Database access: the one entry point the rest of the app uses (require('./db')); tests stub it.
// Shared, engine-neutral parts live in common/ (sessions, connecting, Stop, lost connections, SQL
// log, query runs, exports). Each engine (oracle/, postgres/, mysql/) does the database-specific
// work; calls on an open workspace go to the engine of that workspace's session.
const { engine, engineFor } = require('./engines');
const { sessions, get } = require('./common/sessions');
const { test, connect, disconnect, disconnectAll, cancel, setAutoCommit, commit, rollback, reconnect, cancelConnect, closeStuckSession } = require('./common/connection');
const { configure } = require('./common/net');
const { setOnLost } = require('./common/health');
const { sqlLog, clearSqlLog, trackConnection, newLog } = require('./common/sql-log');
const { run } = require('./common/query');
// Export jobs are loaded on the first export.
const exportData = (...a) => require('./common/export-job').exportData(...a);
const cancelExport = (...a) => require('./common/export-job').cancelExport(...a);

/** A call on the workspace's open session, answered by its engine. */
const onSession = (name) => async (winId, ...args) => {
  const s = get(winId);
  if (typeof s.engine[name] !== 'function') throw new Error(`${s.engine.profile.label} does not support this yet`);
  return s.engine[name](s, ...args);
};

// Engine-specific operations (Redis: key browser, Workbench, Shell …): db.engineOp(winId, name, params).
// Messages the engine sends on its own (Shell SUBSCRIBE / MONITOR output) go to the window via onPush.
let onPush = () => {};
function setOnPush(fn) { onPush = fn; }
async function engineOp(winId, name, params = {}) {
  const s = get(winId);
  const ops = s.engine.ops || {};
  if (!Object.prototype.hasOwnProperty.call(ops, name)) throw new Error(`${s.engine.profile.label} does not support this`);
  return ops[name](s, { winId, emit: (msg) => onPush(winId, msg) }, params || {});
}

/** SQL dialect (formatter language, script splitting) of the workspace's session, else of the
 *  engine the workspace names (before connecting, or in tests). */
const dialectOf = (winId, engineId) => {
  const s = sessions.get(winId);
  return (s ? s.engine : engine(engineId)).dialect;
};

module.exports = {
  test, connect, disconnect, disconnectAll, cancel, setAutoCommit, commit, rollback, reconnect, cancelConnect, closeStuckSession,
  configure, setOnLost,
  sqlLog, clearSqlLog, trackConnection, newLog,
  run,
  exportData, cancelExport,
  dialectOf,
  engineOp, setOnPush,
  // saved-connection helpers (by the connection's engine, no session needed)
  targetKey: (cfg) => engineFor(cfg).targetKey(cfg),
  cfgForDatabase: (cfg, item) => engineFor(cfg).cfgForDatabase(cfg, item),
  // file-based engines (SQLite): create an empty database file from the connection form
  createDatabaseFile: (engineId, file) => engine(engineId).createFile(file),
  // browsing
  databases: onSession('databases'),
  schemas: onSession('schemas'),
  objects: onSession('objects'),
  columns: onSession('columns'),
  structure: onSession('structure'),
  ddl: onSession('ddl'),
  // table data and grid edits
  tableData: onSession('tableData'),
  previewChanges: onSession('previewChanges'),
  applyChanges: onSession('applyChanges'),
  // table design
  truncateTable: onSession('truncateTable'),
  dropTable: onSession('dropTable'),
  createTableSql: onSession('createTableSql'),
  createTable: onSession('createTable'),
  alterTableSql: onSession('alterTableSql'),
  alterTable: onSession('alterTable'),
};
