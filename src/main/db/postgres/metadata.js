// PostgreSQL schema browsing from the system catalogs: schemas, objects, columns, table structure,
// and the databases on the server. Every function takes the open session (s) first.
const { kindOf } = require('./sqlgen');

const SYSTEM_SCHEMA = (name) => name === 'information_schema' || name.startsWith('pg_');

async function schemas(s) {
  const r = await s.conn.execute(
    `SELECT nspname FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_temp\\_%' AND nspname NOT LIKE 'pg\\_toast%'
      ORDER BY nspname`
  );
  return r.rows.map(([name]) => ({ name, system: SYSTEM_SCHEMA(name) }));
}

async function objects(s, schema) {
  const r = await s.conn.execute(
    `SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND NOT c.relispartition
     UNION
     SELECT p.proname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     UNION
     SELECT t.tgname, 'TRIGGER'
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal
     UNION
     SELECT t.typname, 'TYPE'
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1
        AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
      ORDER BY 1`,
    [schema]
  );
  return r.rows.map(([name, type]) => ({ name, type, invalid: false }));
}

/** oid of schema.name (table, view, sequence…), or null. */
async function relOid(s, schema, name) {
  const r = await s.conn.execute(
    `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name]
  );
  return r.rows.length ? r.rows[0][0] : null;
}

async function tableColumns(s, schema, table) {
  const key = schema + '.' + table;
  if (s.colCache.has(key)) return s.colCache.get(key);
  const r = await s.conn.execute(
    `SELECT a.attname, format_type(a.atttypid, NULL), format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
            pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum), a.attnum, a.attidentity
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table]
  );
  const cols = r.rows.map(([name, type, fullType, nullable, def, comments, id, identity]) => ({
    name, type, fullType, nullable, default: def, comments, id: Number(id), kind: kindOf(type),
    identity: identity === 'a' ? 'ALWAYS' : identity === 'd' ? 'BY DEFAULT' : null,
  }));
  s.colCache.set(key, cols);
  return cols;
}

const columns = (s, schema, table) => tableColumns(s, schema, table);

/** Primary key columns in key order ([] when the table has none). */
async function primaryKey(s, schema, table) {
  const r = await s.conn.execute(
    `SELECT a.attname
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'p'
      ORDER BY k.ord`,
    [schema, table]
  );
  return r.rows.map((x) => x[0]);
}

const CON_TYPE = { p: 'PRIMARY KEY', u: 'UNIQUE', f: 'FOREIGN KEY', c: 'CHECK', x: 'EXCLUDE' };

async function structure(s, schema, name) {
  s.colCache.delete(schema + '.' + name);
  const cols = await tableColumns(s, schema, name);
  const oid = await relOid(s, schema, name);
  if (oid === null) throw new Error(`${schema}.${name} not found`);
  const cons = await s.conn.execute(
    `SELECT con.conname, con.contype, pg_get_constraintdef(con.oid, true),
            (SELECT string_agg(a.attname, ', ' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum),
            ci.relname, con.convalidated
       FROM pg_constraint con LEFT JOIN pg_class ci ON ci.oid = con.conindid AND con.contype IN ('p', 'u', 'x')
      WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'f', 'c', 'x')
      ORDER BY CASE con.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, con.conname`,
    [oid]
  );
  const constraints = cons.rows.map(([cname, ctype, def, ccols, indexName, validated]) => ({
    name: cname, type: CON_TYPE[ctype] || ctype, status: validated ? 'ENABLED' : 'NOT VALIDATED', columns: ccols || '', indexName,
    generated: false,
    detail: ctype === 'f' ? '→ ' + String(def).replace(/^FOREIGN KEY \([^)]*\) REFERENCES /, '') : ctype === 'c' ? String(def).replace(/^CHECK /, '') : '',
  }));
  const pk = constraints.find((c) => c.type === 'PRIMARY KEY');
  const pkCols = new Set(pk ? pk.columns.split(', ') : []);
  const idx = await s.conn.execute(
    `SELECT i.relname, am.amname, ix.indisunique, ix.indisvalid, pg_get_indexdef(ix.indexrelid)
       FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_am am ON am.oid = i.relam
      WHERE ix.indrelid = $1 ORDER BY i.relname`,
    [oid]
  );
  const backing = new Set(constraints.filter((c) => c.indexName).map((c) => c.indexName));
  const indexes = idx.rows.map(([iname, method, unique, valid, def]) => {
    const m = /USING \w+ \((.*)\)/.exec(def);
    return { name: iname, type: String(method).toUpperCase(), unique, status: valid ? 'VALID' : 'INVALID', columns: m ? m[1] : def, constraint: backing.has(iname) };
  });
  const tc = await s.conn.execute(`SELECT obj_description($1::oid, 'pg_class')`, [oid]);
  return {
    columns: cols.map((c) => ({ ...c, pk: pkCols.has(c.name) })),
    constraints, indexes, comment: tc.rows[0] ? tc.rows[0][0] : null,
  };
}

/** Databases on this server (the databases ▾ menu); another one opens with the same login. */
async function databases(s) {
  const r = await s.conn.execute(
    `SELECT datname, datallowconn, current_database() FROM pg_database WHERE NOT datistemplate ORDER BY datname`
  );
  const current = r.rows.length ? r.rows[0][2] : null;
  return {
    current,
    list: r.rows.map(([name, allow]) => ({ name, open: !!allow, openMode: allow ? 'open' : 'no connections allowed' })),
    note: null,
  };
}

module.exports = { schemas, objects, relOid, tableColumns, columns, primaryKey, structure, databases };
