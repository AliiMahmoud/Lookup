// ClickHouse DDL from SHOW CREATE (the server's own, formatted definition).
const { qname } = require('./sqlgen');

async function ddlOn(conn, schema, name, type) {
  const what = type === 'DICTIONARY' ? 'DICTIONARY' : 'TABLE'; // views and materialized views too
  const r = await conn.execute(`SHOW CREATE ${what} ${qname(schema, name)}`);
  const text = r.rows && r.rows[0] ? String(r.rows[0][0]).trim() : '';
  return text ? `${text};` : `-- No DDL for ${schema}.${name}`;
}

const ddl = (s, schema, name, type) => ddlOn(s.conn, schema, name, type);

module.exports = { ddl, ddlOn };
