// SQLite: creating, altering (directly, or by rebuilding the table), truncating (DELETE) and dropping tables. Every
// change runs in one transaction; inside an open transaction under a savepoint, then committed with it.
const { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable } = require('./ddlgen');
const { runSteps } = require('../common/ddl-run');

const forget = (s, owner, table) => s.colCache && s.colCache.delete(`${owner}.${table}`);

/** Foreign key checks must be off while a table is rebuilt (dropping it would otherwise act on other tables). */
const tx = (s, steps = []) => ({
  transactional: true,
  inTx: () => !!s.conn.inTx,
  begin: 'BEGIN',
  afterBegin: () => { s.conn.inTx = true; },
  before: async (sx, open) => {
    if (!steps.some((st) => st.run)) return;
    const on = Number((await sx.conn.execute('PRAGMA foreign_keys')).rows[0][0]);
    if (!on) return;
    if (open) throw new Error('Foreign keys are switched on in this session and a transaction is open: commit or roll back first, then apply.');
    await sx.conn.execute('PRAGMA foreign_keys = OFF');
    sx.fkRestore = true;
  },
  after: async (sx) => { if (sx.fkRestore) { sx.fkRestore = false; await sx.conn.execute('PRAGMA foreign_keys = ON'); } },
});

async function runOne(s, sql) {
  const r = await runSteps(s, [{ sql, label: sql }], tx(s));
  if (!r.ok) throw new Error(r.error);
}

const createTableSql = (_s, spec) => buildCreateTable(spec).sql;

async function createTable(s, spec) {
  const { sql, table } = buildCreateTable(spec);
  await runOne(s, sql);
  forget(s, spec.owner, table);
  return { table, sql };
}

async function alterTableSql(s, plan) {
  return (await buildAlterTable(s, plan)).map(({ sql, label }) => ({ sql, label }));
}

async function alterTable(s, plan) {
  let steps;
  try { steps = await buildAlterTable(s, plan); } catch (e) { return { ok: false, done: [], error: e.message, total: 0, rolledBack: true }; }
  const r = await runSteps(s, steps, tx(s, steps));
  forget(s, plan.owner, plan.table);
  return r;
}

async function truncateTable(s, owner, table) { await runOne(s, buildTruncate(owner, table)); }

async function dropTable(s, owner, table) {
  await runOne(s, buildDropTable(owner, table));
  forget(s, owner, table);
}

module.exports = { createTableSql, createTable, alterTableSql, alterTable, truncateTable, dropTable };
