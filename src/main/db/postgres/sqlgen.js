// PostgreSQL: identifier quoting, column kinds, and the bound SQL for browsing table data ($1, $2 …).

// Words that must be quoted when used as names (PostgreSQL reserved key words).
const RESERVED = new Set(`all analyse analyze and any array as asc asymmetric authorization binary both case cast check
  collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema
  current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for
  foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading
  left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing
  primary references returning right select session_user similar some symmetric system_user table tablesample then to
  trailing true union unique user using variadic verbose when where window with`.split(/\s+/));

/** A name as PostgreSQL needs it written: plain lower-case names stay bare, anything else is quoted. */
function qi(name) {
  const s = String(name);
  if (/^[a-z_][a-z0-9_$]*$/.test(s) && !RESERVED.has(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}
const qname = (schema, name) => qi(schema) + '.' + qi(name);
const lit = (v) => "'" + String(v).replace(/'/g, "''") + "'";

function kindOf(type) {
  const t = String(type || '').toLowerCase().replace(/\(.*$/, '').trim();
  if (t === 'date') return 'date';
  if (t.startsWith('timestamp')) return 'timestamp';
  if (['smallint', 'integer', 'bigint', 'int', 'int2', 'int4', 'int8', 'numeric', 'decimal', 'real', 'double precision',
    'float4', 'float8', 'money', 'oid', 'smallserial', 'serial', 'bigserial'].includes(t)) return 'number';
  if (t === 'bytea') return 'binary';
  return 'text';
}

const OPS = { '=': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=', LIKE: 'LIKE', 'NOT LIKE': 'NOT LIKE', CONTAINS: 'ILIKE' };

/** filters = [{ col, op, value }] or [{ op: 'RAW', value: '<where text>' }]; params continue from `start`. */
function buildWhere(columns, filters, start = 0) {
  const typeOf = Object.fromEntries(columns.map((c) => [c.name, c.type]));
  const parts = [];
  const params = [];
  const p = (v) => { params.push(v); return '$' + (start + params.length); };
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
      if (items.length) parts.push(`${col}::text IN (${items.map(p).join(', ')})`);
      continue;
    }
    const op = OPS[f.op];
    if (!op) continue;
    if (op.includes('LIKE')) {
      const v = f.op === 'CONTAINS' ? `%${f.value ?? ''}%` : String(f.value ?? '');
      parts.push(`${col}::text ${op} ${p(v)}`);
      continue;
    }
    // The server converts the text to the column's type ('5' for a number, '2026-01-01' for a date).
    const k = kindOf(typeOf[f.col]);
    parts.push(k === 'binary' ? `${col} ${op} decode(${p(String(f.value ?? '').replace(/^\\x|^0x/i, ''))}, 'hex')` : `${col} ${op} ${p(String(f.value ?? ''))}`);
  }
  return { where: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params };
}

/** One page of a table or view. Without a sort, rows follow the primary key so pages don't overlap. */
function buildPageQuery({ owner, name, cols, filters, sort, offset = 0, limit = 300, keyCols = [] }) {
  const { where, params } = buildWhere(cols, filters);
  let order = '';
  if (sort && cols.some((c) => c.name === sort.col)) order = ` ORDER BY ${qi(sort.col)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  else if (keyCols.length) order = ` ORDER BY ${keyCols.map(qi).join(', ')}`;
  const n = params.length;
  const sql = `SELECT * FROM ${qname(owner, name)} t${where}${order} LIMIT $${n + 1} OFFSET $${n + 2}`;
  return { sql, params: [...params, Number(limit), Number(offset)], where, countParams: params };
}

module.exports = { qi, qname, lit, kindOf, buildWhere, buildPageQuery, RESERVED };
