// MySQL / MariaDB engine (mysql2: pure JavaScript). Same set of functions as oracle/index.js;
// functions that work on an open session take it first.
const { open, targetKey, cfgForDatabase } = require('./connect');
const { schemas, objects, columns, structure } = require('./metadata');
const { ddl, ddlOn } = require('./ddl');
const { tableData, previewChanges, applyChanges } = require('./table-data');
const { runStatement, readOutput, inTransaction } = require('./query');
const { tableExportQuery, streamQuery, cancelOn } = require('./export');

const LOST_CODES = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ER_SERVER_SHUTDOWN',
  'ER_CONNECTION_KILLED', 'PROTOCOL_SEQUENCE_TIMEOUT', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR']);

/** mysql2 marks errors that end the connection as fatal. */
const isLostError = (e) => !!e && (e.fatal === true || LOST_CODES.has(e.code) || /connection is in closed state|Connection lost/i.test(String(e.message || '')));

/** 1317 ER_QUERY_INTERRUPTED: the server confirmed Stop (KILL QUERY). */
const isCancelError = (e) => !!e && (e.errno === 1317 || e.code === 'ER_QUERY_INTERRUPTED');

/** What the server is: { version, schema, dbName, product }. Without a default database the first
 *  user database is shown in the sidebar. */
async function describe(conn) {
  const r = await conn.execute(`SELECT VERSION(), DATABASE(), @@version_comment`);
  const [version, current, comment] = r.rows[0];
  const product = /mariadb/i.test(`${version} ${comment}`) ? 'MariaDB' : 'MySQL';
  let schema = current;
  if (!schema) {
    const d = await conn.execute(
      `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY SCHEMA_NAME LIMIT 1`
    );
    schema = d.rows.length ? d.rows[0][0] : 'information_schema';
  }
  return { version: String(version).replace(/-MariaDB.*$/i, ''), schema, dbName: current || null, product };
}

async function prepareSession() { return {}; }

/** Stop: KILL QUERY for the session's running statement. */
const cancel = (s) => s.conn.cancelRunning();

module.exports = {
  id: 'mysql',
  profile: require('./profile'),
  dialect: require('./dialect'),
  // connecting
  open, describe, prepareSession, targetKey, cfgForDatabase,
  isLostError, isCancelError, cancel,
  // browsing
  schemas, objects, columns, structure, ddl, ddlFor: ddlOn,
  // table data (read-only for now)
  tableData, previewChanges, applyChanges,
  // query tabs
  runStatement, readOutput, inTransaction,
  // exports
  tableExportQuery, streamQuery, cancelOn,
};
