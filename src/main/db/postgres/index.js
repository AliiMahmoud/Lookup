// PostgreSQL engine (node-postgres: pure JavaScript, no libpq). Same set of functions as oracle/index.js;
// functions that work on an open session take it first.
const { open, targetKey, cfgForDatabase } = require('./connect');
const { schemas, objects, columns, structure, databases } = require('./metadata');
const { ddl, ddlOn } = require('./ddl');
const { tableData, previewChanges, applyChanges } = require('./table-data');
const { runStatement, readOutput, inTransaction } = require('./query');
const { tableExportQuery, streamQuery, cancelOn } = require('./export');

// Connection-level SQLSTATE classes (08 = connection exception, 57P0x = server shutting down / crash).
const LOST_CODES = /^(08\d{3}|57P01|57P02|57P03)$/;
const LOST_TEXT = /Connection terminated|not queryable|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|socket hang up|Client was closed/i;

const isLostError = (e) => !!e && (LOST_CODES.test(String(e.code || '')) || LOST_TEXT.test(String(e.message || '')));

/** 57014 query_canceled: the server confirmed Stop. */
const isCancelError = (e) => !!e && e.code === '57014';

/** What the server is: { version, schema, dbName }. */
async function describe(conn) {
  const r = await conn.execute(`SELECT current_setting('server_version'), current_schema(), current_database()`);
  const [version, schema, dbName] = r.rows[0];
  return { version: String(version).split(' ')[0], schema: schema || 'public', dbName };
}

async function prepareSession() { return {}; }

/** Stop: PostgreSQL's cancel request for the session's running statement. */
const cancel = (s) => s.conn.cancelRunning();

module.exports = {
  id: 'postgres',
  profile: require('./profile'),
  dialect: require('./dialect'),
  // connecting
  open, describe, prepareSession, targetKey, cfgForDatabase,
  isLostError, isCancelError, cancel,
  // browsing
  schemas, objects, columns, structure, databases, ddl, ddlFor: ddlOn,
  // table data (read-only for now)
  tableData, previewChanges, applyChanges,
  // query tabs
  runStatement, readOutput, inTransaction,
  // exports
  tableExportQuery, streamQuery, cancelOn,
};
