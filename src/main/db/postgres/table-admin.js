// PostgreSQL: creating, altering, truncating and dropping tables. PostgreSQL's DDL is transactional, so a Structure
// change applies all or nothing; inside an open transaction it runs under a savepoint and is committed with it.
const { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable } = require('./ddlgen');
const { runSteps } = require('../common/ddl-run');

const tx = (s) => ({
  transactional: true,
  inTx: () => s.conn.inTransaction(),
  begin: 'BEGIN',
  // PgConn.execute adds a savepoint of its own inside transactions; ours is kept apart.
  control: (sql) => s.conn.lock(() => s.conn.query(sql)),
});
const forget = (s, owner, table) => s.colCache && s.colCache.delete(`${owner}.${table}`);

/** One statement as a change of its own (create, truncate, drop): fails → rolled back, nothing changed. */
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

const alterTableSql = (_s, plan) => buildAlterTable(plan);

async function alterTable(s, plan) {
  const r = await runSteps(s, buildAlterTable(plan), tx(s));
  forget(s, plan.owner, plan.table);
  return r;
}

async function truncateTable(s, owner, table) { await runOne(s, buildTruncate(owner, table)); }

async function dropTable(s, owner, table, opts) {
  await runOne(s, buildDropTable(owner, table, opts));
  forget(s, owner, table);
}

module.exports = { createTableSql, createTable, alterTableSql, alterTable, truncateTable, dropTable };
