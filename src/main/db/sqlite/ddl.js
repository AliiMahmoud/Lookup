// SQLite DDL: the CREATE statements SQLite keeps in sqlite_master (exactly as they were written),
// plus a table's indexes and triggers.
const { qi } = require('./sqlgen');

const DDL_DEFAULTS = { indexes: true, triggers: true };

async function ddlOn(conn, schema, name, type, options = {}) {
  const o = { ...DDL_DEFAULTS, ...options };
  const master = `${qi(schema)}.sqlite_master`;
  const r = await conn.execute(`SELECT sql FROM ${master} WHERE name = ? AND type = ?`, [name, String(type).toLowerCase()]);
  if (!r.rows.length || !r.rows[0][0]) return `-- ${name}: SQLite keeps no CREATE statement for this object (created automatically)`;
  const parts = [String(r.rows[0][0]).trim() + ';'];
  if (type === 'TABLE' || type === 'VIEW') {
    const dep = async (kind, label) => {
      const d = await conn.execute(`SELECT sql FROM ${master} WHERE type = ? AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`, [kind, name]);
      if (d.rows.length) parts.push(`-- ${label}\n` + d.rows.map((x) => String(x[0]).trim() + ';').join('\n'));
    };
    if (o.indexes && type === 'TABLE') await dep('index', 'Indexes');
    if (o.triggers) await dep('trigger', 'Triggers');
  }
  return parts.join('\n\n');
}

const ddl = (s, schema, name, type, options) => ddlOn(s.conn, schema, name, type, options);

module.exports = { ddl, ddlOn };
