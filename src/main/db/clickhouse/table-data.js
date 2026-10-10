// ClickHouse Table Data view: paged rows with filters, sorting and a row count (read-only: ClickHouse
// is built for analytics, and single-row edits are slow mutations there).
const { qname, buildPageQuery } = require('./sqlgen');
const { tableColumns } = require('./metadata');
const { columnsFrom, serializeRows } = require('./values');

async function tableData(s, { owner, name, offset = 0, limit = 300, filters = [], sort = null, withCount = true }) {
  const cols = await tableColumns(s, owner, name);
  const { sql, params, where, countParams } = buildPageQuery({ owner, name, cols, filters, sort, offset, limit });
  const t0 = Date.now();
  const r = await s.conn.execute(sql, params);
  const ms = Date.now() - t0;
  let total = null;
  if (withCount) {
    // count() without a filter is answered from the table's metadata, so it stays cheap on big tables.
    try {
      const c = await s.conn.execute(`SELECT count() FROM ${qname(owner, name)}${where}`, countParams);
      total = Number(c.rows[0][0]);
    } catch { total = null; }
  }
  const meta = columnsFrom(r.names, r.types);
  const rows = serializeRows(r.rows || []);
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  meta.forEach((m) => { const c = byName[m.name]; if (c) { m.fullType = c.fullType; m.nullable = c.nullable; } });
  return { columns: meta, rows, rowids: null, total, editable: false, keyColumns: [], ms, sql };
}

module.exports = { tableData };
