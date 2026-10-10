// ClickHouse engine (@clickhouse/client over HTTP: pure JavaScript). Same set of functions as
// oracle/index.js; functions that work on an open session take it first.
const { open, targetKey } = require('./connect');
const { schemas, objects, columns, structure } = require('./metadata');
const { ddl, ddlOn } = require('./ddl');
const { tableData } = require('./table-data');
const { runStatement } = require('./query');
const { tableExportQuery, streamQuery, cancelOn } = require('./export');

const LOST = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EPIPE|socket hang up/i;

/** The server can't be reached (HTTP has no session to lose, but the UI offers Reconnect the same way). */
const isLostError = (e) => !!e && !isCancelError(e) && (LOST.test(String(e.code || '')) || LOST.test(String(e.message || '')));

/** Stop: our own abort, or the server's QUERY_WAS_CANCELLED (394). */
function isCancelError(e) {
  return !!e && (e.name === 'AbortError' || /aborted|QUERY_WAS_CANCELLED/i.test(String(e.message || '')) || String(e.code) === '394');
}

async function describe(conn) {
  const r = await conn.execute(`SELECT version(), currentDatabase()`);
  const [version, database] = r.rows[0];
  return { version, schema: database, dbName: database };
}

async function prepareSession() { return {}; }

const cancel = (s) => s.conn.cancelRunning();

module.exports = {
  id: 'clickhouse',
  profile: require('./profile'),
  dialect: require('./dialect'),
  // connecting
  open, describe, prepareSession, targetKey, cfgForDatabase: (cfg, db) => ({ ...cfg, database: db.name }),
  isLostError, isCancelError, cancel,
  // browsing
  schemas, objects, columns, structure, ddl, ddlFor: ddlOn,
  // table data (read-only)
  tableData,
  // query tabs
  runStatement,
  // exports
  tableExportQuery, streamQuery, cancelOn,
};
