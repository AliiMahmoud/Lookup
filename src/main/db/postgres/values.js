// PostgreSQL: result columns (type names from type ids) and value conversion for the UI and exports.
const { kindOf } = require('./sqlgen');
const { ser } = require('../common/values');

// Common built-in types; others are looked up once per session in pg_type.
const TYPE_NAMES = {
  16: 'boolean', 17: 'bytea', 18: 'char', 19: 'name', 20: 'bigint', 21: 'smallint', 23: 'integer', 25: 'text', 26: 'oid',
  114: 'json', 142: 'xml', 700: 'real', 701: 'double precision', 790: 'money', 1042: 'character', 1043: 'character varying',
  1082: 'date', 1083: 'time without time zone', 1114: 'timestamp without time zone', 1184: 'timestamp with time zone',
  1186: 'interval', 1266: 'time with time zone', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 869: 'inet', 650: 'cidr',
  829: 'macaddr', 1560: 'bit', 1562: 'bit varying', 1007: 'integer[]', 1016: 'bigint[]', 1009: 'text[]', 1015: 'character varying[]',
};

/** Names for the type ids in a result; query(sql, params) runs on the session (unknown ids only). */
async function typeNames(s, fields, query) {
  if (!s.typeNames) s.typeNames = new Map(Object.entries(TYPE_NAMES).map(([k, v]) => [Number(k), v]));
  const missing = [...new Set(fields.map((f) => f.dataTypeID).filter((id) => !s.typeNames.has(id)))];
  if (missing.length) {
    try {
      const r = await query(`SELECT oid::int, format_type(oid, NULL) FROM pg_type WHERE oid = ANY($1::oid[])`, [missing]);
      for (const [id, name] of r.rows) s.typeNames.set(Number(id), name);
    } catch { /* show without a type */ }
    for (const id of missing) if (!s.typeNames.has(id)) s.typeNames.set(id, 'text');
  }
  return fields.map((f) => s.typeNames.get(f.dataTypeID));
}

async function columnsFromFields(s, fields, query) {
  const names = await typeNames(s, fields, query);
  return fields.map((f, i) => ({ name: f.name, type: names[i], kind: kindOf(names[i]) }));
}

const withMs = (type) => /^timestamp|^time /.test(type || '');

/** Converts values in place (dates arrive as the server's text; binaries as Buffers). */
function serializeRows(rows, columns, full) {
  const ms = columns.map((c) => withMs(c.type));
  for (const r of rows) for (let i = 0; i < r.length; i++) r[i] = ser(r[i], ms[i], full);
  return rows;
}

module.exports = { typeNames, columnsFromFields, serializeRows };
