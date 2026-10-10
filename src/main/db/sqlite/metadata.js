// SQLite schema browsing: schemas (main, temp and attached databases), objects from sqlite_master,
// columns, keys and indexes from the table-valued pragmas. Every function takes the session (s) first.
const { qi, kindOf } = require('./sqlgen');

async function schemas(s) {
  const r = await s.conn.execute(`SELECT name FROM pragma_database_list ORDER BY seq`);
  const names = r.rows.map(([name]) => name);
  // SQLite only lists temp once something was created in it; show it always (temporary tables).
  if (!names.includes('temp')) names.splice(1, 0, 'temp');
  return names.map((name) => ({ name, system: name === 'temp' }));
}

async function objects(s, schema) {
  const r = await s.conn.execute(
    `SELECT name, upper(type) FROM ${qi(schema)}.sqlite_master
      WHERE type IN ('table', 'view', 'index', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      ORDER BY name`
  );
  return r.rows.map(([name, type]) => ({ name, type, invalid: false }));
}

async function tableSql(s, schema, name) {
  const r = await s.conn.execute(`SELECT sql FROM ${qi(schema)}.sqlite_master WHERE name = ? AND type IN ('table', 'view')`, [name]);
  return r.rows.length ? String(r.rows[0][0] || '') : '';
}

async function tableColumns(s, schema, table) {
  const key = schema + '.' + table;
  if (s.colCache.has(key)) return s.colCache.get(key);
  const r = await s.conn.execute(`SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) ORDER BY cid`, [table, schema]);
  const create = await tableSql(s, schema, table);
  const autoinc = /\bAUTOINCREMENT\b/i.test(create);
  const pkCount = r.rows.filter((x) => Number(x[5]) > 0).length;
  const cols = r.rows.filter((x) => Number(x[6]) !== 1).map(([cid, name, type, notnull, def, pk, hidden]) => {
    const rowidAlias = Number(pk) > 0 && pkCount === 1 && /^INTEGER$/i.test(String(type || '').trim());
    return {
      name, type: String(type || ''), fullType: String(type || '') || '(any)', nullable: !Number(notnull) && !rowidAlias,
      default: def === null || def === undefined ? null : String(def), comments: Number(hidden) > 1 ? 'generated column' : null,
      id: Number(cid) + 1, kind: kindOf(type), pkOrder: Number(pk),
      identity: rowidAlias ? (autoinc ? 'AUTOINCREMENT' : 'ROWID') : null,
    };
  });
  s.colCache.set(key, cols);
  return cols;
}

const columns = (s, schema, table) => tableColumns(s, schema, table);

async function primaryKey(s, schema, table) {
  const cols = await tableColumns(s, schema, table);
  return cols.filter((c) => c.pkOrder > 0).sort((a, b) => a.pkOrder - b.pkOrder).map((c) => c.name);
}

async function structure(s, schema, name) {
  s.colCache.delete(schema + '.' + name);
  const cols = await tableColumns(s, schema, name);
  const pk = cols.filter((c) => c.pkOrder > 0).sort((a, b) => a.pkOrder - b.pkOrder);
  const constraints = [];
  if (pk.length) constraints.push({ name: 'PRIMARY KEY', type: 'PRIMARY KEY', status: 'ENABLED', columns: pk.map((c) => c.name).join(', '), indexName: null, generated: true, detail: '' });
  const idx = await s.conn.execute(`SELECT name, "unique", origin, partial FROM pragma_index_list(?, ?) ORDER BY name`, [name, schema]);
  const indexes = [];
  for (const [iname, unique, origin, partial] of idx.rows) {
    const ic = await s.conn.execute(`SELECT name, "desc" FROM pragma_index_xinfo(?, ?) WHERE key = 1 ORDER BY seqno`, [iname, schema]);
    const icols = ic.rows.map(([c, desc]) => `${c === null ? '(expression)' : c}${Number(desc) ? ' DESC' : ''}`).join(', ');
    indexes.push({ name: iname, type: Number(partial) ? 'PARTIAL' : 'BTREE', unique: !!Number(unique), status: 'VALID', columns: icols, constraint: origin !== 'c' });
    if (origin === 'u') constraints.push({ name: iname, type: 'UNIQUE', status: 'ENABLED', columns: icols, indexName: iname, generated: true, detail: '' });
  }
  const fk = await s.conn.execute(`SELECT id, "from", "table", "to", on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq`, [name, schema]);
  const byId = new Map();
  for (const [id, from, table, to, onDelete] of fk.rows) {
    if (!byId.has(id)) byId.set(id, { from: [], to: [], table, onDelete });
    byId.get(id).from.push(from);
    if (to !== null) byId.get(id).to.push(to);
  }
  for (const [id, f] of byId) {
    constraints.push({
      name: `foreign key ${Number(id) + 1}`, type: 'FOREIGN KEY', status: 'ENABLED', columns: f.from.join(', '), indexName: null, generated: true,
      detail: `→ ${f.table}${f.to.length ? ` (${f.to.join(', ')})` : ''}${f.onDelete && f.onDelete !== 'NO ACTION' ? ` on delete ${String(f.onDelete).toLowerCase()}` : ''}`,
    });
  }
  // CHECK constraints are only in the CREATE TABLE text.
  const create = await tableSql(s, schema, name);
  const re = /(?:CONSTRAINT\s+("[^"]+"|\S+)\s+)?CHECK\s*\(/gi;
  let m;
  let n = 0;
  while ((m = re.exec(create))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < create.length && depth) { if (create[i] === '(') depth++; else if (create[i] === ')') depth--; i++; }
    n++;
    constraints.push({ name: m[1] ? m[1].replace(/^"|"$/g, '') : `check ${n}`, type: 'CHECK', status: 'ENABLED', columns: '', indexName: null, generated: !m[1], detail: create.slice(re.lastIndex, i - 1).trim() });
  }
  return { columns: cols.map((c) => ({ ...c, pk: c.pkOrder > 0 })), constraints, indexes, comment: null };
}

module.exports = { schemas, objects, tableColumns, columns, primaryKey, structure, tableSql };
