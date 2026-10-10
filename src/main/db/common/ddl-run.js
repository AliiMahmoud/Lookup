// Running a list of structure changes (CREATE / ALTER / DROP …) for engines with their own DDL generator. Engine-neutral.
//
// Transactional engines (PostgreSQL, SQLite) run every step in one transaction: if one fails nothing is changed. Inside a
// transaction the user already has open (query tabs, auto-commit off) the steps run under a savepoint and are then
// committed together with it (the window asked first). MySQL commits each DDL statement on its own, so steps run one by
// one and a failure reports what already ran, as Oracle does.
//
// A step is { sql, label } or { label, sql (for the preview), run(s) } when its statements are only known at run time
// (SQLite's table rebuild reads the table's indexes and triggers after earlier steps ran).

/**
 * tx = { transactional, inTx(), begin, control?(sql), before?(s), after?(s) } → { ok, done, failed?, error?, total, rolledBack? }.
 * before / after run outside the transaction (SQLite's PRAGMA foreign_keys can't change inside one).
 */
async function runSteps(s, steps, tx) {
  const done = [];
  const exec = async (st) => { if (st.run) await st.run(s); else await s.conn.execute(st.sql); };
  if (!steps.length) return { ok: true, done, total: 0 };
  if (!tx.transactional) {
    for (const st of steps) {
      try { await exec(st); done.push(st); } catch (e) { return { ok: false, done: strip(done), failed: strip([st])[0], error: e.message, total: steps.length }; }
    }
    return { ok: true, done: strip(done), total: steps.length };
  }
  const control = tx.control || ((sql) => s.conn.execute(sql));
  const open = tx.inTx();
  if (tx.before) await tx.before(s, open);
  try {
    if (open) await control('SAVEPOINT lookup_ddl');
    else { await s.conn.execute(tx.begin); if (tx.afterBegin) tx.afterBegin(s); }
    let current = null;
    try {
      for (const st of steps) { current = st; await exec(st); done.push(st); }
      if (open) await control('RELEASE SAVEPOINT lookup_ddl');
      await s.conn.commit();
      return { ok: true, done: strip(done), total: steps.length };
    } catch (e) {
      if (open) {
        await control('ROLLBACK TO SAVEPOINT lookup_ddl').catch(() => {});
        await control('RELEASE SAVEPOINT lookup_ddl').catch(() => {});
      } else await s.conn.rollback().catch(() => {});
      return { ok: false, done: [], failed: strip([current])[0], error: e.message, total: steps.length, rolledBack: true };
    }
  } finally {
    if (tx.after) await tx.after(s, open).catch(() => {});
  }
}

/** Steps as plain data for the window (no functions). */
const strip = (list) => list.map((st) => ({ sql: st.sql, label: st.label }));

module.exports = { runSteps };
