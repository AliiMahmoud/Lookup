// SQLite: identifier quoting, column kinds (from declared types, by SQLite's affinity rules), and the
// bound SQL for browsing table data (? params).

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const qname = (schema, name) => qi(schema) + '.' + qi(name);

/** Kind for the grid from a declared type (SQLite stores any value in any column; this is a hint). */
function kindOf(type) {
  const t = String(type || '').toUpperCase();
  if (!t) return 'text';
  if (/^DATE$/.test(t)) return 'date';
  if (/DATETIME|TIMESTAMP/.test(t)) return 'timestamp';
  if (/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL|BOOL/.test(t)) return 'number';
  if (/BLOB/.test(t)) return 'binary';
  return 'text';
}

const OPS = { '=': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=', LIKE: 'LIKE', 'NOT LIKE': 'NOT LIKE', CONTAINS: 'LIKE' };

/** filters = [{ col, op, value }] or [{ op: 'RAW', value: '<where text>' }] */
function buildWhere(columns, filters) {
  const typeOf = Object.fromEntries(columns.map((c) => [c.name, c.type]));
  const parts = [];
  const params = [];
  const p = (v) => { params.push(v); return '?'; };
  // Numbers typed in a filter compare as numbers in numeric columns.
  const val = (k, v) => (k === 'number' && /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : String(v ?? ''));
  for (const f of filters || []) {
    if (f.op === 'RAW') {
      if (String(f.value || '').trim()) parts.push('(' + f.value + ')');
      continue;
    }
    if (!(f.col in typeOf)) continue;
    const col = qi(f.col);
    const k = kindOf(typeOf[f.col]);
    if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') { parts.push(`${col} ${f.op}`); continue; }
    if (f.op === 'IN') {
      const items = String(f.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length) parts.push(`${col} IN (${items.map((v) => p(val(k, v))).join(', ')})`);
      continue;
    }
    const op = OPS[f.op];
    if (!op) continue;
    if (op.includes('LIKE')) {
      const v = f.op === 'CONTAINS' ? `%${f.value ?? ''}%` : String(f.value ?? '');
      parts.push(`CAST(${col} AS TEXT) ${op} ${p(v)}`);
      continue;
    }
    parts.push(k === 'binary' ? `${col} ${op} unhex(${p(String(f.value ?? '').replace(/^0x|^x'|'$/gi, ''))})` : `${col} ${op} ${p(val(k, f.value))}`);
  }
  return { where: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params };
}

/** One page. Without a sort, tables follow the primary key (or rowid) so pages don't overlap. */
function buildPageQuery({ owner, name, cols, filters, sort, offset = 0, limit = 300, keyCols = [] }) {
  const { where, params } = buildWhere(cols, filters);
  let order = '';
  if (sort && cols.some((c) => c.name === sort.col)) order = ` ORDER BY ${qi(sort.col)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  else if (keyCols.length) order = ` ORDER BY ${keyCols.map(qi).join(', ')}`;
  const sql = `SELECT * FROM ${qname(owner, name)} t${where}${order} LIMIT ? OFFSET ?`;
  return { sql, params: [...params, Number(limit), Number(offset)], where, countParams: params };
}

module.exports = { qi, qname, kindOf, buildWhere, buildPageQuery };
