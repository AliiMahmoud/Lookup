// Oracle: creating, altering, truncating and dropping tables.
const { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable } = require('./sqlgen');
const { forgetTable } = require('./metadata');

function createTableSql(_s, spec) {
  return buildCreateTable(spec).sql;
}

/** Runs CREATE TABLE (DDL commits on its own in Oracle). Returns the stored table name. */
async function createTable(s, spec) {
  const { sql, table } = buildCreateTable(spec);
  await s.conn.execute(sql);
  forgetTable(s, spec.owner, table);
  return { table, sql };
}

function alterTableSql(_s, plan) {
  return buildAlterTable(plan);
}

/**
 * Runs the Structure tab's changes one statement at a time (each DDL commits on its own).
 * Stops at the first error and reports what already ran.
 */
async function alterTable(s, plan) {
  const steps = buildAlterTable(plan);
  const done = [];
  for (const st of steps) {
    try {
      await s.conn.execute(st.sql);
      done.push(st);
    } catch (e) {
      forgetTable(s, plan.owner, plan.table);
      return { ok: false, done, failed: st, error: e.message, total: steps.length };
    }
  }
  forgetTable(s, plan.owner, plan.table);
  return { ok: true, done, total: steps.length };
}

async function truncateTable(s, owner, table) {
  await s.conn.execute(buildTruncate(owner, table));
}

async function dropTable(s, owner, table, opts) {
  await s.conn.execute(buildDropTable(owner, table, opts));
  forgetTable(s, owner, table);
}

module.exports = { truncateTable, dropTable, createTableSql, createTable, alterTableSql, alterTable };
