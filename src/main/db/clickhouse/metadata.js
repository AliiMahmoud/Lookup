// ClickHouse schema browsing from the system tables: databases (shown as schemas), tables, views,
// materialized views, dictionaries, columns, keys and data-skipping indexes.
const { kindOf } = require('./sqlgen');

const SYSTEM = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema']);

async function schemas(s) {
  const r = await s.conn.execute(`SELECT name FROM system.databases ORDER BY name`);
  return r.rows.map(([name]) => ({ name, system: SYSTEM.has(name) }));
}

const TYPE_OF_ENGINE = (engine) => (engine === 'View' ? 'VIEW' : engine === 'MaterializedView' ? 'MATERIALIZED VIEW' : engine === 'Dictionary' ? 'DICTIONARY' : 'TABLE');

async function objects(s, schema) {
  const r = await s.conn.execute(
    `SELECT name, engine FROM system.tables WHERE database = {db:String} AND NOT startsWith(name, '.inner') ORDER BY name`,
    { db: schema }
  );
  return r.rows.map(([name, engine]) => ({ name, type: TYPE_OF_ENGINE(engine), engine, invalid: false }));
}

async function tableColumns(s, schema, table) {
  const key = schema + '.' + table;
  if (s.colCache.has(key)) return s.colCache.get(key);
  const r = await s.conn.execute(
    `SELECT name, type, default_kind, default_expression, comment, position, is_in_primary_key, is_in_sorting_key
       FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`,
    { db: schema, t: table }
  );
  const cols = r.rows.map(([name, type, defaultKind, def, comment, position, inPk, inSort]) => ({
    name, type, fullType: type, nullable: /^(LowCardinality\()?Nullable\(/.test(type),
    default: def ? `${defaultKind && defaultKind !== 'DEFAULT' ? defaultKind + ' ' : ''}${def}` : null,
    comments: comment || null, id: Number(position), kind: kindOf(type), pkFlag: !!Number(inPk), sortFlag: !!Number(inSort), identity: null,
  }));
  s.colCache.set(key, cols);
  return cols;
}

const columns = (s, schema, table) => tableColumns(s, schema, table);

/** CHECK / ASSUME constraints from CREATE TABLE text: each expression runs to the next top-level ',' or ')'. */
function constraintsIn(create) {
  const out = [];
  const re = /CONSTRAINT\s+(`(?:[^`\\]|\\.)+`|\w+)\s+(CHECK|ASSUME)\s+/g;
  let m;
  while ((m = re.exec(create))) {
    let i = re.lastIndex;
    let depth = 0;
    let quote = null;
    for (; i < create.length; i++) {
      const c = create[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === "'" || c === '`' || c === '"') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') { if (!depth) break; depth--; } else if (c === ',' && !depth) break;
    }
    out.push({ name: m[1].replace(/^`|`$/g, ''), type: m[2], detail: create.slice(re.lastIndex, i).trim() });
  }
  return out;
}

/** Table keys and data-skipping indexes; ClickHouse "constraints" are CHECK / ASSUME rules in the DDL. */
async function structure(s, schema, name) {
  s.colCache.delete(schema + '.' + name);
  const cols = await tableColumns(s, schema, name);
  const t = await s.conn.execute(
    `SELECT engine, primary_key, sorting_key, partition_key, sampling_key, comment, total_rows, create_table_query
       FROM system.tables WHERE database = {db:String} AND name = {t:String}`,
    { db: schema, t: name }
  );
  if (!t.rows.length) throw new Error(`${schema}.${name} not found`);
  const [engine, pk, sortKey, partKey, sampleKey, comment, , create] = t.rows[0];
  const constraints = [];
  const key = (type, cols2) => { if (cols2) constraints.push({ name: type, type, status: 'ENABLED', columns: cols2, indexName: null, generated: true, detail: '' }); };
  key('PRIMARY KEY', pk);
  if (sortKey && sortKey !== pk) key('ORDER BY', sortKey);
  key('PARTITION BY', partKey);
  key('SAMPLE BY', sampleKey);
  for (const k of constraintsIn(String(create || ''))) constraints.push({ ...k, status: 'ENABLED', columns: '', indexName: null, generated: false });
  const idx = await s.conn.execute(
    `SELECT name, type_full, expr, granularity FROM system.data_skipping_indices WHERE database = {db:String} AND table = {t:String} ORDER BY name`,
    { db: schema, t: name }
  );
  const indexes = idx.rows.map(([iname, type, expr, gran]) => ({ name: iname, type: `${type} · granularity ${gran}`, unique: false, status: 'VALID', columns: expr, constraint: false }));
  return {
    columns: cols.map((c) => ({ ...c, pk: c.pkFlag })),
    constraints, indexes, comment: [comment, engine ? `Engine: ${engine}` : ''].filter(Boolean).join(' — ') || null,
    tableComment: comment || '', // the comment alone, for the Structure editor
  };
}

module.exports = { schemas, objects, tableColumns, columns, structure, SYSTEM };
