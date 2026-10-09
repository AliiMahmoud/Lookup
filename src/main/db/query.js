// Running the user's SQL from query tabs (row limit, DBMS_OUTPUT, Stop).
const { ora } = require('./driver');
const { columnsFromMeta, serializeRows } = require('./values');
const { get } = require('./sessions');

async function readDbmsOutput(conn) {
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

/** Runs statements one by one; stops at the first error. */
const DEFAULT_MAX_ROWS = 500;

async function run(winId, statements, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  // 0 = No limit (the last option in the picker); anything else invalid falls back to 500.
  maxRows = Number(maxRows) === 0 ? 0 : Math.floor(Number(maxRows)) > 0 ? Math.floor(Number(maxRows)) : DEFAULT_MAX_ROWS;
  const s = get(winId);
  if (s.busy) throw new Error('Another query is still running');
  s.busy = true;
  s.breakSent = false;
  // Stop / a lost connection reject this, so the run ends even if the server never answers.
  let abortRun;
  const aborted = new Promise((_, rej) => { abortRun = rej; });
  aborted.catch(() => {});
  s.abortRun = abortRun;
  const g = (p) => Promise.race([p, aborted]);
  const results = [];
  try {
    for (const sql of statements) {
      const t0 = Date.now();
      try {
        const r = await g(s.conn.rawExecute(sql, [], { resultSet: true, autoCommit: s.autoCommit })); // user's own query: not logged
        let out;
        if (r.resultSet) {
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
          out = { kind: 'rows', columns: columnsFromMeta(r.metaData), rows: serializeRows(rows, r.metaData), truncated };
        } else {
          out = { kind: 'exec', rowsAffected: r.rowsAffected };
        }
        out.ms = Date.now() - t0;
        out.sql = sql;
        out.output = await g(readDbmsOutput(s.conn));
        results.push(out);
      } catch (e) {
        results.push({ kind: 'error', sql, ms: Date.now() - t0, message: e.message, code: e.code, offset: e.offset, lost: !!s.lost });
        break;
      }
    }
  } finally {
    s.busy = false;
    s.abortRun = null;
  }
  return results;
}

module.exports = { run };
