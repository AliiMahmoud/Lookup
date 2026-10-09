// Oracle access layer: the one entry point the rest of the app uses (require('./db')).
// Uses node-oracledb in Thin mode (pure JavaScript, no Oracle Instant Client); one session per
// connection workspace. Each area lives in its own file in this folder.

const { test, connect, disconnect, disconnectAll, cancel, setAutoCommit, commit, rollback, reconnect, cancelConnect, closeStuckSession } = require('./connection');
const { connectString, connectOptions, configure } = require('./settings');
const { setOnLost, isLostError } = require('./health');
const { sqlLog, clearSqlLog, trackConnection, newLog } = require('./sql-log');
const { pdbs, schemas, objects, columns, structure } = require('./metadata');
const { ddl } = require('./ddl');
const { tableData, previewChanges, applyChanges } = require('./table-data');
const { run } = require('./query');
const { truncateTable, dropTable, createTableSql, createTable, alterTableSql, alterTable } = require('./table-admin');
const { exportData, cancelExport } = require('./export-job');

module.exports = {
  test, connect, disconnect, disconnectAll, cancel, setAutoCommit, commit, rollback, reconnect, cancelConnect, closeStuckSession,
  connectString, connectOptions, configure,
  setOnLost, isLostError,
  sqlLog, clearSqlLog, trackConnection, newLog,
  pdbs, schemas, objects, columns, structure,
  ddl,
  tableData, previewChanges, applyChanges,
  run,
  truncateTable, dropTable, createTableSql, createTable, alterTableSql, alterTable,
  exportData, cancelExport,
};
