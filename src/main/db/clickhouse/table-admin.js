// ClickHouse: creating, altering, truncating and dropping tables. No transactions, so a Structure change runs step by step
// and reports what already ran.
const { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable } = require('./ddlgen');
const { structure } = require('./metadata');
const { runSteps } = require('../common/ddl-run');

const forget = (s, owner, table) => s.colCache && s.colCache.delete(`${owner}.${table}`);

const createTableSql = (_s, spec) => buildCreateTable(spec).sql;

async function createTable(s, spec) {
  const { sql, table } = buildCreateTable(spec);
  await s.conn.execute(sql);
  forget(s, spec.owner, table);
  return { table, sql };
}

/** Needs the table's constraint and index names (automatic names must not clash, key rows can't be dropped). */
async function alterTableSql(s, plan) {
  return buildAlterTable(plan, await structure(s, plan.owner, plan.table));
}

async function alterTable(s, plan) {
  let steps;
  try { steps = buildAlterTable(plan, await structure(s, plan.owner, plan.table)); } catch (e) { return { ok: false, done: [], error: e.message, total: 0 }; }
  const r = await runSteps(s, steps, { transactional: false });
  forget(s, plan.owner, plan.table);
  return r;
}

async function truncateTable(s, owner, table) { await s.conn.execute(buildTruncate(owner, table)); }

async function dropTable(s, owner, table) {
  await s.conn.execute(buildDropTable(owner, table));
  forget(s, owner, table);
}

module.exports = { createTableSql, createTable, alterTableSql, alterTable, truncateTable, dropTable };
