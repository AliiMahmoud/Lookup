// MySQL / MariaDB Table Data view: paged rows with filters, sorting and a row count, and grid edits by
// primary key (previewed, then applied in one transaction; see common/key-edits.js).
const { qi, qname, buildPageQuery } = require('./sqlgen');
const { sqlLiteral } = require('./dialect');
const { keyRowids, buildKeyedChanges, runKeyedChanges } = require('../common/key-edits');
const { tableColumns, primaryKey } = require('./metadata');
const { columnsFromFields, serializeRows } = require('./values');

async function tableData(s, { owner, name, type, offset = 0, limit = 300, filters = [], sort = null, withCount = true }) {
  const cols = await tableColumns(s, owner, name);
  const keyCols = type === 'TABLE' ? await primaryKey(s, owner, name) : [];
  const { sql, params, where, countParams } = buildPageQuery({ owner, name, cols, filters, sort, offset, limit, keyCols });
  const t0 = Date.now();
  const r = await s.conn.execute(sql, params);
  const ms = Date.now() - t0;
  let total = null;
  if (withCount) {
    try {
      const c = await s.conn.execute(`SELECT COUNT(*) FROM ${qname(owner, name)} t${where}`, countParams);
      total = Number(c.rows[0][0]);
    } catch { total = null; }
  }
  const meta = columnsFromFields(r.fields);
  const rows = serializeRows(r.rows || []);
  // Prefer the catalog's types (e.g. varchar(100), enum('a','b')) for display.
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  meta.forEach((m) => { const c = byName[m.name]; if (c) { m.fullType = c.fullType; m.nullable = c.nullable; m.type = c.type; m.kind = c.kind; } });
  // Editable when the table has a primary key (rows are matched by it).
  const rowids = type === 'TABLE' && keyCols.length ? keyRowids(meta, rows, keyCols) : null;
  const readOnlyReason = type !== 'TABLE' ? null
    : !keyCols.length ? 'this table has no primary key, so its rows can\'t be matched safely. Use a query tab (Ctrl+T) to change data.' : null;
  return { columns: meta, rows, rowids, total, editable: !!rowids, keyColumns: keyCols, readOnlyReason, ms, sql };
}

/** A grid value as the driver wants it: binaries (shown as hex) back to bytes. */
const toParam = (v) => (v && typeof v === 'object' && v.$bin !== undefined ? Buffer.from(v.$bin, 'hex') : v);

const dialectOf = (owner, name) => ({ qi, target: qname(owner, name), param: () => '?', literal: (v, type) => sqlLiteral(v, type) ?? 'NULL', toParam });

async function previewChanges(s, { owner, name, changes }) {
  const cols = await tableColumns(s, owner, name);
  const keyCols = await primaryKey(s, owner, name);
  return buildKeyedChanges(dialectOf(owner, name), cols, keyCols, changes).map((x) => x.preview).join('\n');
}

async function applyChanges(s, { owner, name, changes }) {
  const cols = await tableColumns(s, owner, name);
  const keyCols = await primaryKey(s, owner, name);
  if (!keyCols.length) throw new Error('This table has no primary key, so its rows can\'t be changed from the grid.');
  const stmts = buildKeyedChanges(dialectOf(owner, name), cols, keyCols, changes);
  return runKeyedChanges(s, stmts, {
    inTx: () => !!s.conn.inTx,
    begin: 'START TRANSACTION',
    affected: (r) => r.rowsAffected,
  });
}

module.exports = { tableData, previewChanges, applyChanges };
