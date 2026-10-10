// ClickHouse: identifier quoting, column kinds, and the SQL for browsing table data. Values are
// passed as typed query parameters ({p0:String}), never pasted into the SQL text.

const qi = (name) => '`' + String(name).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
const qname = (schema, name) => qi(schema) + '.' + qi(name);
const lit = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

/** Inner type of Nullable(...) / LowCardinality(...). */
const baseType = (type) => String(type || '').replace(/^(Nullable|LowCardinality)\((.*)\)$/, '$2').replace(/^(Nullable|LowCardinality)\((.*)\)$/, '$2');

function kindOf(type) {
  const t = baseType(type);
  if (/^Date(32)?$/.test(t)) return 'date';
  if (/^DateTime/.test(t)) return 'timestamp';
  if (/^(U?Int\d+|Float\d+|Decimal|BFloat16)/.test(t)) return 'number';
  return 'text';
}

const OPS = { '=': '=', '<>': '!=', '<': '<', '>': '>', '<=': '<=', '>=': '>=', LIKE: 'LIKE', 'NOT LIKE': 'NOT LIKE', CONTAINS: 'ILIKE' };

/** filters = [{ col, op, value }] or [{ op: 'RAW', value: '<where text>' }] */
function buildWhere(columns, filters) {
  const typeOf = Object.fromEntries(columns.map((c) => [c.name, c.type]));
  const parts = [];
  const params = {};
  let n = 0;
  const p = (v) => { const k = `p${n++}`; params[k] = String(v); return `{${k}:String}`; };
  // Compare in the column's own type: the text is converted by the server.
  const typed = (col, v) => `CAST(${p(v)}, ${lit(baseType(typeOf[col]))})`;
  for (const f of filters || []) {
    if (f.op === 'RAW') {
      if (String(f.value || '').trim()) parts.push('(' + f.value + ')');
      continue;
    }
    if (!(f.col in typeOf)) continue;
    const col = qi(f.col);
    if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') { parts.push(`${col} ${f.op}`); continue; }
    if (f.op === 'IN') {
      const items = String(f.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length) parts.push(`${col} IN (${items.map((v) => typed(f.col, v)).join(', ')})`);
      continue;
    }
    const op = OPS[f.op];
    if (!op) continue;
    if (op.includes('LIKE')) {
      const v = f.op === 'CONTAINS' ? `%${f.value ?? ''}%` : String(f.value ?? '');
      parts.push(`toString(${col}) ${op} ${p(v)}`);
      continue;
    }
    parts.push(`${col} ${op} ${typed(f.col, f.value ?? '')}`);
  }
  return { where: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params };
}

/** One page. Rows are in the table's own order unless a sort is chosen (ordering a large table costs). */
function buildPageQuery({ owner, name, cols, filters, sort, offset = 0, limit = 300 }) {
  const { where, params } = buildWhere(cols, filters);
  let order = '';
  if (sort && cols.some((c) => c.name === sort.col)) order = ` ORDER BY ${qi(sort.col)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  const sql = `SELECT * FROM ${qname(owner, name)}${where}${order} LIMIT ${Math.max(0, Math.floor(Number(limit)))} OFFSET ${Math.max(0, Math.floor(Number(offset)))}`;
  return { sql, params, where, countParams: params };
}

module.exports = { qi, qname, lit, kindOf, baseType, buildWhere, buildPageQuery };
