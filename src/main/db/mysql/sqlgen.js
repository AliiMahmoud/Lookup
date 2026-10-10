// MySQL / MariaDB: identifier quoting, column kinds, and the bound SQL for browsing table data (? params).

const qi = (name) => '`' + String(name).replace(/`/g, '``') + '`';
const qname = (schema, name) => qi(schema) + '.' + qi(name);

function kindOf(type) {
  const t = String(type || '').toLowerCase().replace(/\(.*$/, '').replace(/\s+unsigned|\s+zerofill/g, '').trim();
  if (t === 'date') return 'date';
  if (t === 'datetime' || t === 'timestamp') return 'timestamp';
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year'].includes(t)) return 'number';
  if (['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit', 'geometry'].includes(t)) return 'binary';
  return 'text';
}

const OPS = { '=': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=', LIKE: 'LIKE', 'NOT LIKE': 'NOT LIKE', CONTAINS: 'LIKE' };

/** filters = [{ col, op, value }] or [{ op: 'RAW', value: '<where text>' }] */
function buildWhere(columns, filters) {
  const typeOf = Object.fromEntries(columns.map((c) => [c.name, c.type]));
  const parts = [];
  const params = [];
  const p = (v) => { params.push(v); return '?'; };
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
      if (items.length) parts.push(`${col} IN (${items.map(p).join(', ')})`);
      continue;
    }
    const op = OPS[f.op];
    if (!op) continue;
    if (op.includes('LIKE')) {
      const v = f.op === 'CONTAINS' ? `%${f.value ?? ''}%` : String(f.value ?? '');
      parts.push(`${k === 'text' ? col : `CAST(${col} AS CHAR)`} ${op} ${p(v)}`);
      continue;
    }
    parts.push(k === 'binary' ? `${col} ${op} UNHEX(${p(String(f.value ?? '').replace(/^0x/i, ''))})` : `${col} ${op} ${p(String(f.value ?? ''))}`);
  }
  return { where: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params };
}

/** One page of a table or view. Without a sort, rows follow the primary key so pages don't overlap.
 *  MySQL has no NULLS LAST, so nulls are sorted last with "col IS NULL" first. */
function buildPageQuery({ owner, name, cols, filters, sort, offset = 0, limit = 300, keyCols = [] }) {
  const { where, params } = buildWhere(cols, filters);
  let order = '';
  if (sort && cols.some((c) => c.name === sort.col)) order = ` ORDER BY ${qi(sort.col)} IS NULL, ${qi(sort.col)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
  else if (keyCols.length) order = ` ORDER BY ${keyCols.map(qi).join(', ')}`;
  const sql = `SELECT * FROM ${qname(owner, name)} t${where}${order} LIMIT ? OFFSET ?`;
  return { sql, params: [...params, Number(limit), Number(offset)], where, countParams: params };
}

/**
 * Adds LIMIT to a plain SELECT, so the server only sends the rows the row limit shows (as MySQL
 * Workbench does). Statements that already limit, lock or write rows are left as they are.
 */
function withRowLimit(sql, n) {
  const text = String(sql).replace(/(\s|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)+$/g, '');
  if (!/^\s*(\(\s*)*select\b/i.test(text)) return sql;
  if (/\blimit\s+\d+(\s*(,|offset)\s*\d+)?\s*\)?\s*$/i.test(text)) return sql;
  if (/\b(into|for\s+update|lock\s+in\s+share\s+mode|for\s+share|procedure\s+analyse)\b/i.test(text)) return sql;
  return `${text} LIMIT ${Number(n)}`;
}

module.exports = { qi, qname, kindOf, buildWhere, buildPageQuery, withRowLimit };
