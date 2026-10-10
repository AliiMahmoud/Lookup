// Running the user's SQL from query tabs, for every engine: one statement at a time, row limit,
// Stop and lost connections. The engine runs each statement (engine.runStatement).

const DEFAULT_MAX_ROWS = 500;
const { get } = require('./sessions');
const { lostMessage, markLost } = require('./health');

/** Runs statements one by one; stops at the first error. */
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
        const out = await s.engine.runStatement(s, sql, { maxRows, g });
        out.ms = Date.now() - t0;
        out.sql = sql;
        out.output = s.engine.readOutput ? await g(s.engine.readOutput(s)) : [];
        if (s.engine.inTransaction) out.txOpen = s.engine.inTransaction(s);
        results.push(out);
      } catch (e) {
        if (s.engine.isLostError(e)) markLost(winId, s, lostMessage(e));
        const err = { kind: 'error', sql, ms: Date.now() - t0, message: e.message, code: e.code, offset: e.offset, lost: !!s.lost };
        if (s.engine.isCancelError && s.engine.isCancelError(e)) err.cancelled = true;
        if (s.engine.inTransaction && !s.lost) err.txOpen = s.engine.inTransaction(s);
        results.push(err);
        break;
      }
    }
  } finally {
    s.busy = false;
    s.abortRun = null;
  }
  return results;
}

module.exports = { run, DEFAULT_MAX_ROWS };
