// PostgreSQL Table Data view: paged rows with filters, sorting and a row count (read-only for now;
// editing by primary key comes later).
const { qname, buildPageQuery } = require('./sqlgen');
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
  const meta = await columnsFromFields(s, r.fields, (q, p) => s.conn.execute(q, p));
  const rows = serializeRows(r.rows || [], meta);
  // Prefer catalog types (e.g. character varying(50)) for display.
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  meta.forEach((m) => { const c = byName[m.name]; if (c) { m.fullType = c.fullType; m.nullable = c.nullable; m.type = c.type; } });
  return { columns: meta, rows, rowids: null, total, editable: false, keyColumns: keyCols, ms, sql };
}

module.exports = { tableData };
