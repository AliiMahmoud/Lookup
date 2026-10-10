// MySQL / MariaDB DDL from SHOW CREATE … (the server's own definition of each object).
const { qname } = require('./sqlgen');

const SHOW = {
  TABLE: ['TABLE', 1], VIEW: ['VIEW', 1], SEQUENCE: ['SEQUENCE', 1], PROCEDURE: ['PROCEDURE', 2],
  FUNCTION: ['FUNCTION', 2], TRIGGER: ['TRIGGER', 2], EVENT: ['EVENT', 3],
};

/** Procedural objects contain ';' in their body, so they are written between DELIMITER lines. */
const PROCEDURAL = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT']);

async function ddlOn(conn, schema, name, type, options = {}) {
  const how = SHOW[type];
  if (!how) return `-- No DDL for ${type}`;
  const r = await conn.execute(`SHOW CREATE ${how[0]} ${qname(schema, name)}`);
  const row = r.rows && r.rows[0];
  if (!row || row[how[1]] === null || row[how[1]] === undefined) {
    throw new Error(`The database did not return the definition of ${schema}.${name} (missing privileges?)`);
  }
  let text = String(row[how[1]]).trim();
  if (options.schema && type === 'TABLE') text = text.replace(/^CREATE TABLE `(?:[^`]|``)+`/, `CREATE TABLE ${qname(schema, name)}`);
  if (PROCEDURAL.has(type)) return `DELIMITER $$\n${text}$$\nDELIMITER ;`;
  return text + ';';
}

const ddl = (s, schema, name, type, options) => ddlOn(s.conn, schema, name, type, { schema: false, ...options });

module.exports = { ddl, ddlOn };
