// Oracle engine (node-oracledb Thin mode: pure JavaScript, no Oracle Instant Client).
// Every engine folder exports this same set of functions; functions that work on an open session
// take it first (s = { conn, cfg, schema, colCache, … }, see common/sessions.js).
const { ora } = require('./driver');
const { connectString, connectOptions, open, targetKey, cfgForDatabase } = require('./connect');
const { schemas, objects, columns, structure, databases } = require('./metadata');
const { ddl, ddlOn } = require('./ddl');
const { tableData, previewChanges, applyChanges } = require('./table-data');
const { runStatement, readOutput } = require('./query');
const { truncateTable, dropTable, createTableSql, createTable, alterTableSql, alterTable } = require('./table-admin');
const { tableExportQuery, streamQuery, cancelOn } = require('./export');
const dialect = require('./dialect');

const LOST_RE = /^(NJS-500|NJS-501|NJS-503|NJS-521|DPI-1080|DPI-1010|ORA-03113|ORA-03114|ORA-03135|ORA-02396|ORA-01012|ORA-00028|ORA-12537|ORA-12547|ORA-12570|ORA-12571)\b/;

/** Errors that mean the connection itself is gone (not just a failed statement). */
const isLostError = (e) => !!e && (LOST_RE.test(String(e.message || '')) || LOST_RE.test(String(e.code || '')));

/** ORA-01013: the server confirmed Stop. */
const isCancelError = (e) => !!e && /ORA-01013/.test(String(e.message || ''));

const CONTEXT_SQL = `SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA'), SYS_CONTEXT('USERENV','DB_NAME') FROM dual`;

/** What the server is: { version, schema, dbName }. */
async function describe(conn) {
  const r = await conn.execute(CONTEXT_SQL);
  return { version: conn.oracleServerVersionString, schema: r.rows[0][0], dbName: r.rows[0][1] };
}

/** Session set-up after connecting: DBMS_OUTPUT on, and tidy DBMS_METADATA output. */
async function prepareSession(conn) {
  conn.callTimeout = 0;
  try {
    await conn.execute(`BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`);
  } catch { /* ignore */ }
  try {
    await conn.execute(`BEGIN
      DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);
      DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE);
      DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
      DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE);
    END;`);
  } catch { /* ignore */ }
  return {};
}

/** Stop: one in-band break for the running call (Thin mode has no out-of-band break). */
const cancel = (s) => s.conn.breakExecution();

module.exports = {
  id: 'oracle',
  profile: require('./profile'),
  dialect,
  driver: ora,
  // connecting
  connectString, connectOptions, open, describe, prepareSession, targetKey, cfgForDatabase,
  isLostError, isCancelError, cancel,
  // browsing
  schemas, objects, columns, structure, databases, ddl, ddlFor: ddlOn,
  // table data and grid edits
  tableData, previewChanges, applyChanges,
  // query tabs
  runStatement, readOutput,
  // table design
  truncateTable, dropTable, createTableSql, createTable, alterTableSql, alterTable,
  // exports
  tableExportQuery, streamQuery, cancelOn,
};
