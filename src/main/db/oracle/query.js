// Oracle: running one statement of the user's SQL (result set with row limit) and reading DBMS_OUTPUT.
const { ora } = require('./driver');
const { columnsFromMeta, serializeRows } = require('./values');

async function readOutput(s) {
  const conn = s.conn;
  try {
    const r = await (conn.rawExecute || conn.execute)(
      `DECLARE l VARCHAR2(32767); st INTEGER; buf CLOB; n PLS_INTEGER := 0;
       BEGIN
         LOOP
           DBMS_OUTPUT.GET_LINE(l, st);
           EXIT WHEN st <> 0 OR n >= 5000;
           buf := buf || l || CHR(10);
           n := n + 1;
         END LOOP;
         :out := buf;
       END;`,
      { out: { type: ora().CLOB, dir: ora().BIND_OUT } }
    );
    const lob = r.outBinds.out;
    if (!lob) return [];
    const text = await lob.getData();
    lob.destroy();
    return text ? text.replace(/\n$/, '').split('\n') : [];
  } catch {
    return [];
  }
}

// CREATE of a stored object; the driver only warns (NJS-700) when it compiles with errors.
const CREATE_RE = /^\s*create\s+(?:or\s+replace\s+)?(?:(?:editionable|noneditionable)\s+)?(?:(?:no)?force\s+)?(package\s+body|type\s+body|procedure|function|package|trigger|type|view)\s+((?:"[^"]+"|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|[\w$#]+))?)/i;
const ident = (x) => (x.startsWith('"') ? x.slice(1, -1) : x.toUpperCase());

/** Error thrown for "created with compilation errors": the compiler messages from ALL_ERRORS, offset at the first one. */
async function compileError(s, sql, warning, g) {
  const m = CREATE_RE.exec(sql);
  const err = new Error(warning.message);
  err.code = warning.code;
  if (!m) return err;
  const type = m[1].replace(/\s+/g, ' ').toUpperCase();
  const parts = m[2].split(/\s*\.\s*/).map(ident);
  const [owner, name] = parts.length > 1 ? parts : [null, parts[0]];
  let rows = [];
  try {
    const r = await g(s.conn.rawExecute(
      `SELECT line, position, text, attribute FROM all_errors
        WHERE owner = NVL(:owner, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')) AND name = :name AND type = :type
        ORDER BY sequence`, { owner, name, type }, { outFormat: ora().OUT_FORMAT_ARRAY }));
    rows = r.rows || [];
  } catch { /* no access: keep the warning alone */ }
  if (!rows.length) return err;
  const what = `${type} ${owner ? owner + '.' : ''}${name}`;
  err.message = `${type.charAt(0) + type.slice(1).toLowerCase()} created with compilation errors: ${what}\n\n`
    + rows.map(([line, pos, text, attr]) => `${Number(line) ? `Line ${line}, column ${pos}: ` : ''}${attr === 'WARNING' ? 'Warning: ' : ''}${String(text).trim()}`).join('\n');
  // The stored source starts at the object type keyword: its line 1 is the line that keyword is on.
  const [line, pos] = (rows.find((x) => x[3] !== 'WARNING') || rows[0]).map(Number); // NUMBERs are fetched as strings
  const kw = m.index + m[0].indexOf(m[1], m[0].search(/create/i) + 6);
  const kwLineStart = sql.lastIndexOf('\n', kw - 1) + 1;
  const lines = sql.slice(kwLineStart).split('\n');
  if (line >= 1 && line <= lines.length) {
    const base = kwLineStart + lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    const col = Math.max(0, pos - 1) + (line === 1 ? kw - kwLineStart : 0);
    err.offset = base + Math.min(col, lines[line - 1].length);
  }
  return err;
}

/** g() races each wait against Stop / a lost connection. maxRows 0 = no limit. */
async function runStatement(s, sql, { maxRows, g }) {
  // SQL*Plus's SET DEFINE (first line of Lookup's own SQL INSERT exports): Lookup has no substitution
  // variables, so there is nothing to switch; the server would answer ORA-00922.
  if (/^\s*set\s+def(ine)?\s+(off|on)\s*$/i.test(sql)) return { kind: 'exec' };
  const r = await g(s.conn.rawExecute(sql, [], { resultSet: true, autoCommit: s.autoCommit })); // user's own query: not logged
  if (r.warning && /NJS-700|ORA-24344/.test(`${r.warning.code} ${r.warning.message}`)) throw await compileError(s, sql, r.warning, g);
  if (!r.resultSet) return { kind: 'exec', rowsAffected: r.rowsAffected };
  let rows;
  let truncated = false;
  if (!maxRows) {
    // No limit: fetch everything in batches (every row is kept in memory).
    rows = [];
    for (;;) {
      const batch = await g(r.resultSet.getRows(2000));
      if (!batch.length) break;
      for (const x of batch) rows.push(x);
    }
  } else {
    rows = await g(r.resultSet.getRows(maxRows + 1));
    truncated = rows.length > maxRows;
    if (truncated) rows.length = maxRows;
  }
  await g(r.resultSet.close());
  return { kind: 'rows', columns: columnsFromMeta(r.metaData), rows: serializeRows(rows, r.metaData), truncated };
}

module.exports = { runStatement, readOutput };
