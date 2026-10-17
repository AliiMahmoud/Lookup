// PostgreSQL: running one statement of the user's SQL. Rows are read through a cursor, so a row
// limit really limits what is fetched. With auto-commit off, the first change opens a transaction
// (like Oracle), and every statement inside a transaction is protected by a savepoint: a failing
// statement is undone on its own instead of aborting the whole transaction (as psql's ON_ERROR_ROLLBACK).
const { driver } = require('./driver');
const { withDetails } = require('./connect');
const { columnsFromFields, serializeRows } = require('./values');

const TX_CONTROL = /^\s*(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/i;
// Statements PostgreSQL refuses inside a transaction block.
const NO_TX = /^\s*(vacuum|create\s+database|drop\s+database|alter\s+system|create\s+tablespace|drop\s+tablespace|(create|drop)\s+(unique\s+)?index\s+concurrently|reindex\b[^;]*\bconcurrently)\b/i;
// Plain reads don't open a transaction (a WITH that changes data does).
const READ_ONLY = /^\s*(select|show|values|table|explain(?!\s+(\(\s*)?analy[sz]e))\b/i;

function opensTransaction(sql) {
  if (TX_CONTROL.test(sql) || NO_TX.test(sql)) return false;
  if (/^\s*with\b/i.test(sql)) return /\b(insert|update|delete|merge)\b/i.test(sql);
  return !READ_ONLY.test(sql);
}

/** Error position (1-based, in characters) -> offset in the statement, for the editor cursor. */
function withOffset(e) {
  if (e && e.position && e.offset === undefined) e.offset = Number(e.position) - 1;
  return withDetails(e);
}

async function readRows(cur, maxRows, g) {
  if (maxRows) {
    const rows = await g(cur.read(maxRows + 1));
    const truncated = rows.length > maxRows;
    if (truncated) rows.length = maxRows;
    return { rows, truncated };
  }
  const rows = [];
  for (;;) {
    const batch = await g(cur.read(2000));
    for (const x of batch) rows.push(x);
    if (batch.length < 2000) break;
  }
  return { rows, truncated: false };
}

/** g() races each wait against Stop / a lost connection. maxRows 0 = no limit. */
function runStatement(s, sql, { maxRows, g }) {
  const conn = s.conn;
  return conn.lock(async () => {
    const q = (text, params) => conn.query(text, params);
    conn.notices = []; // only this statement's messages
    if (!s.autoCommit && !conn.inTransaction() && opensTransaction(sql)) await q('BEGIN');
    const guard = conn.client.getTransactionStatus() === 'T' && !TX_CONTROL.test(sql);
    if (guard) await q('SAVEPOINT lookup_stmt');
    const { Cursor } = driver();
    const cur = conn.client.query(new Cursor(sql, [], { rowMode: 'array' }));
    try {
      const { rows, truncated } = await readRows(cur, maxRows, g);
      const fields = (cur._result && cur._result.fields) || [];
      const command = cur._result && cur._result.command;
      const rowCount = cur._result && cur._result.rowCount;
      await g(cur.close());
      if (guard) await q('RELEASE SAVEPOINT lookup_stmt');
      if (!fields.length) return { kind: 'exec', rowsAffected: rowCount ?? undefined, command };
      const columns = await columnsFromFields(s, fields, q);
      return { kind: 'rows', columns, rows: serializeRows(rows, columns), truncated };
    } catch (e) {
      if (guard && !conn.broken) await q('ROLLBACK TO SAVEPOINT lookup_stmt').catch(() => {});
      throw withOffset(e);
    }
  });
}

/** RAISE NOTICE / server messages since the last statement (shown like DBMS_OUTPUT). */
async function readOutput(s) {
  const out = s.conn.notices;
  s.conn.notices = [];
  return out;
}

const inTransaction = (s) => s.conn.inTransaction();

module.exports = { runStatement, readOutput, inTransaction, opensTransaction };
