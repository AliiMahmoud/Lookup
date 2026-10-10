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

/** g() races each wait against Stop / a lost connection. maxRows 0 = no limit. */
async function runStatement(s, sql, { maxRows, g }) {
  const r = await g(s.conn.rawExecute(sql, [], { resultSet: true, autoCommit: s.autoCommit })); // user's own query: not logged
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
