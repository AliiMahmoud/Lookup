// SQLite engine (node:sqlite, built into Electron: no driver to install). Same set of functions as
// oracle/index.js; functions that work on an open session take it first. Each open file runs on its
// own worker thread (worker.js).
const path = require('path');
const { open, targetKey } = require('./connect');
const { schemas, objects, columns, structure } = require('./metadata');
const { ddl, ddlOn } = require('./ddl');
const { tableData, previewChanges, applyChanges } = require('./table-data');
const { createTableSql, createTable, alterTableSql, alterTable, truncateTable, dropTable } = require('./table-admin');
const { runStatement, inTransaction } = require('./query');
const { tableExportQuery, streamQuery, cancelOn } = require('./export');

/** The worker ended unexpectedly (Stop is reported as a cancel instead). */
const isLostError = (e) => !!e && e.code === 'LOOKUP_WORKER_GONE';

const isCancelError = (e) => !!e && e.code === 'LOOKUP_STOPPED';

async function describe(conn) {
  return { version: conn.version, schema: 'main', dbName: conn.file === ':memory:' ? ':memory:' : path.basename(conn.file) };
}

async function prepareSession() { return {}; }

const cancel = (s) => s.conn.cancelRunning();

/** "New database file…" in the form: creates an empty SQLite file. */
async function createFile(file) {
  const conn = await open({ file }, { create: true });
  await conn.close();
  return file;
}

module.exports = {
  id: 'sqlite',
  profile: require('./profile'),
  dialect: require('./dialect'),
  // connecting
  open, describe, prepareSession, targetKey, cfgForDatabase: (cfg) => cfg, createFile,
  isLostError, isCancelError, cancel,
  // browsing
  schemas, objects, columns, structure, ddl, ddlFor: ddlOn,
  // table data (grid edits by primary key) and table design
  tableData, previewChanges, applyChanges,
  createTableSql, createTable, alterTableSql, alterTable, truncateTable, dropTable,
  // query tabs
  runStatement, inTransaction,
  // exports
  tableExportQuery, streamQuery, cancelOn,
};
