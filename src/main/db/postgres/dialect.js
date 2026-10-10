// PostgreSQL SQL dialect for exports and the editor: quoting, literals in INSERT exports, script
// splitting and the formatter language.
const { kindOf, qi } = require('./sqlgen');

const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** A value as a PostgreSQL literal; null when a binary was only partly fetched. */
function sqlLiteral(v, type) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object' && v.$bin !== undefined) {
    if (v.$bin.length / 2 < v.len) return null;
    return `'\\x${v.$bin}'::bytea`;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = String(v);
  const k = kindOf(type);
  if (k === 'number') return /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? s : esc(s);
  return esc(s);
}

module.exports = {
  id: 'postgres',
  kindOf,
  qi,
  sqlLiteral,
  scriptStart: '',
  commit: 'COMMIT;',
  splitDialect: 'postgres',
  formatLanguage: 'postgresql',
  formatOptions: { paramTypes: { numbered: ['$'] } },
};
