// SQLite: running one statement of the user's SQL on the file's worker thread. With auto-commit off,
// the first change opens a transaction (like Oracle); a failed statement is undone on its own and the
// transaction stays open. Stop ends the worker; what it was doing is rolled back (see connect.js).
const { columnsFrom, serializeRows } = require('./values');

const BEGIN = /^\s*begin\b/i;
const END = /^\s*(commit|end|rollback)\b(?!\s+to\b)(?![\s\S]*\bto\s+savepoint\b)/i;
const TX_CONTROL = /^\s*(begin|commit|end|rollback|savepoint|release)\b/i;
const READ_ONLY = /^\s*(select|explain|pragma|values|attach|detach|vacuum|analyze)\b/i;

function opensTransaction(sql) {
  if (TX_CONTROL.test(sql)) return false;
  if (/^\s*with\b/i.test(sql)) return /\b(insert|update|delete|replace)\b/i.test(sql);
  return !READ_ONLY.test(sql);
}

/** g() races each wait against Stop. maxRows 0 = no limit. */
async function runStatement(s, sql, { maxRows, g }) {
  const conn = s.conn;
  if (!s.autoCommit && !conn.inTx && opensTransaction(sql)) {
    await g(conn.call('query', { sql: 'BEGIN' }));
    conn.inTx = true;
  }
  // Outside a transaction a change runs under a savepoint: if Stop leaves the statement behind, it is
  // rolled back with its connection instead of committing later.
  const guard = !conn.inTx && opensTransaction(sql);
  if (guard) await g(conn.call('query', { sql: 'SAVEPOINT lookup_stmt' }));
  let r;
  try {
    r = await g(conn.call('run', { sql, maxRows }));
  } catch (e) {
    if (guard && e.code !== 'LOOKUP_STOPPED') await conn.call('query', { sql: 'ROLLBACK TO lookup_stmt' }).then(() => conn.call('query', { sql: 'RELEASE lookup_stmt' })).catch(() => {});
    throw e;
  }
  if (guard) await g(conn.call('query', { sql: 'RELEASE lookup_stmt' }));
  if (BEGIN.test(sql)) conn.inTx = true;
  else if (END.test(sql)) conn.inTx = false;
  if (!r.columns) return { kind: 'exec', rowsAffected: /^\s*(insert|update|delete|replace)\b/i.test(sql) || /^\s*with\b/i.test(sql) ? r.changes : undefined };
  const columns = columnsFrom(r.columns);
  return { kind: 'rows', columns, rows: serializeRows(r.rows), truncated: r.truncated };
}

const inTransaction = (s) => !!s.conn.inTx;

module.exports = { runStatement, inTransaction, opensTransaction };
