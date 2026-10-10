// MySQL / MariaDB: running one statement of the user's SQL. Rows are streamed and only the first
// "row limit" are kept; a plain SELECT also gets a LIMIT so the server doesn't send the rest.
// With auto-commit off, the first change opens a transaction (like Oracle). A failed statement is
// undone on its own by InnoDB and the transaction stays open.
const { withRowLimit } = require('./sqlgen');
const { columnsFromFields, serializeRows } = require('./values');

const TX_CONTROL = /^\s*(begin|start\s+transaction|commit|rollback|savepoint|release|xa\s|set\s+(session\s+)?autocommit|lock\s+tables|unlock\s+tables)\b/i;
const READ_ONLY = /^\s*((\(\s*)*select|show|describe|desc|explain|analyze|help|use|set|do|check|checksum|handler)\b/i;
// Statements that commit any open transaction by themselves (implicit commit).
const DDL = /^\s*(create|alter|drop|rename|truncate|grant|revoke|install|uninstall|optimize|repair|analyze\s+table|flush|reset|load\s+index|cache\s+index)\b/i;

function opensTransaction(sql) {
  if (TX_CONTROL.test(sql) || DDL.test(sql)) return false;
  if (/^\s*with\b/i.test(sql)) return /\b(insert|update|delete)\b/i.test(sql);
  return !READ_ONLY.test(sql);
}

/** "… near 'xyz' at line 1": point the editor at xyz. */
function withOffset(e, sql) {
  const m = /near '([\s\S]{1,80}?)' at line \d+/.exec(String(e && e.message));
  if (m && e.offset === undefined) {
    const i = sql.indexOf(m[1].slice(0, 40));
    if (i >= 0) e.offset = i;
  }
  return e;
}

/** Runs sql and keeps at most `cap` rows of the first result set (cap 0 = all). */
function streamQuery(raw, sql, cap) {
  return new Promise((resolve, reject) => {
    const out = { fields: null, rows: [], truncated: false, header: null };
    let set = -1;
    const q = raw.query({ sql, rowsAsArray: true });
    q.on('fields', (fields) => { set++; if (set === 0) out.fields = fields; });
    q.on('result', (row) => {
      if (!Array.isArray(row)) { out.header = row; return; } // OK packet: rows affected, status
      if (set !== 0) return;
      if (cap && out.rows.length >= cap) { out.truncated = true; return; }
      out.rows.push(row);
    });
    q.on('error', reject);
    q.on('end', () => resolve(out));
  });
}

/** g() races each wait against Stop / a lost connection. maxRows 0 = no limit. */
async function runStatement(s, sql, { maxRows, g }) {
  const conn = s.conn;
  if (conn.broken) throw conn.broken;
  if (!s.autoCommit && !conn.inTx && opensTransaction(sql)) {
    await g(conn.query('START TRANSACTION'));
    conn.inTx = true;
  }
  const text = maxRows ? withRowLimit(sql, maxRows + 1) : sql;
  let r;
  try {
    r = await g(streamQuery(conn.raw, text, maxRows ? maxRows + 1 : 0));
  } catch (e) {
    throw withOffset(e, sql);
  }
  conn.track(r.header);
  if (!r.header) conn.warnings = -1; // row results don't carry the warning count: ask afterwards
  if (DDL.test(sql)) conn.inTx = false;
  if (r.fields) {
    const truncated = !!maxRows && (r.rows.length > maxRows || r.truncated);
    if (r.rows.length > maxRows && maxRows) r.rows.length = maxRows;
    const columns = columnsFromFields(r.fields);
    return { kind: 'rows', columns, rows: serializeRows(r.rows), truncated };
  }
  const h = r.header || {};
  return { kind: 'exec', rowsAffected: typeof h.affectedRows === 'number' ? h.affectedRows : undefined, insertId: h.insertId || undefined };
}

/** Warnings from the last statement (like DBMS_OUTPUT, shown under the result). */
async function readOutput(s) {
  const conn = s.conn;
  if (!conn.warnings) return [];
  try {
    if (conn.warnings < 0 && !Number((await conn.query('SELECT @@warning_count')).rows[0][0])) return [];
    const { rows } = await conn.query('SHOW WARNINGS');
    return rows.map(([level, code, message]) => `${level} ${code}: ${message}`);
  } catch {
    return [];
  } finally {
    conn.warnings = 0;
  }
}

const inTransaction = (s) => !!s.conn.inTx;

module.exports = { runStatement, readOutput, inTransaction, opensTransaction, streamQuery };
