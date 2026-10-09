// Creating, altering, truncating and dropping tables.
const { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable } = require('../sqlgen');
const { get } = require('./sessions');

function createTableSql(_winId, spec) {
  return buildCreateTable(spec).sql;
}

/** Runs CREATE TABLE (DDL commits on its own in Oracle). Returns the stored table name. */
async function createTable(winId, spec) {
  const s = get(winId);
  const { sql, table } = buildCreateTable(spec);
  await s.conn.execute(sql);
  s.colCache.delete(`${spec.owner}.${table}`);
  return { table, sql };
}

function alterTableSql(_winId, plan) {
  return buildAlterTable(plan);
}

/**
 * Runs the Structure tab's changes one statement at a time (each DDL commits on its own).
 * Stops at the first error and reports what already ran.
 */
async function alterTable(winId, plan) {
  const s = get(winId);
  const steps = buildAlterTable(plan);
  const done = [];
  for (const st of steps) {
    try {
      await s.conn.execute(st.sql);
      done.push(st);
    } catch (e) {
      s.colCache.delete(`${plan.owner}.${plan.table}`);
      return { ok: false, done, failed: st, error: e.message, total: steps.length };
    }
  }
  s.colCache.delete(`${plan.owner}.${plan.table}`);
  return { ok: true, done, total: steps.length };
}

async function truncateTable(winId, owner, table) {
  await get(winId).conn.execute(buildTruncate(owner, table));
}

async function dropTable(winId, owner, table, opts) {
  const s = get(winId);
  await s.conn.execute(buildDropTable(owner, table, opts));
  s.colCache.delete(`${owner}.${table}`);
}

module.exports = { truncateTable, dropTable, createTableSql, createTable, alterTableSql, alterTable };
