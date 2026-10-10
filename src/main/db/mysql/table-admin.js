// MySQL / MariaDB: creating, altering, truncating and dropping tables. Every DDL statement commits on its own (and
// commits an open transaction first), so a Structure change runs step by step and reports what already ran.
const { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable } = require('./ddlgen');
const { structure } = require('./metadata');
const { runSteps } = require('../common/ddl-run');

const forget = (s, owner, table) => s.colCache && s.colCache.delete(`${owner}.${table}`);
const settled = (s) => { s.conn.inTx = false; }; // DDL commits implicitly

const createTableSql = (_s, spec) => buildCreateTable(spec).sql;

async function createTable(s, spec) {
  const { sql, table } = buildCreateTable(spec);
  await s.conn.execute(sql);
  settled(s);
  forget(s, spec.owner, table);
  return { table, sql };
}

/** Needs the table's constraint types: MySQL drops each kind of constraint with different words. */
async function alterTableSql(s, plan) {
  return buildAlterTable(plan, await structure(s, plan.owner, plan.table));
}

async function alterTable(s, plan) {
  const steps = buildAlterTable(plan, await structure(s, plan.owner, plan.table));
  const r = await runSteps(s, steps, { transactional: false });
  if (r.done.length) settled(s);
  forget(s, plan.owner, plan.table);
  return r;
}

async function truncateTable(s, owner, table) { await s.conn.execute(buildTruncate(owner, table)); settled(s); }

async function dropTable(s, owner, table) {
  await s.conn.execute(buildDropTable(owner, table));
  settled(s);
  forget(s, owner, table);
}

module.exports = { createTableSql, createTable, alterTableSql, alterTable, truncateTable, dropTable };
