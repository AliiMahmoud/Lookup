// MySQL / MariaDB SQL dialect for exports and the editor: quoting, literals in INSERT exports,
// script splitting and the formatter language.
const { kindOf, qi } = require('./sqlgen');

// Backslash is an escape character in MySQL strings (unless NO_BACKSLASH_ESCAPES is set).
const esc = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0') + "'";

/** A value as a MySQL literal; null when a binary was only partly fetched. */
function sqlLiteral(v, type) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object' && v.$bin !== undefined) {
    if (v.$bin.length / 2 < v.len) return null;
    return v.len ? `0x${v.$bin}` : "''";
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = String(v);
  if (kindOf(type) === 'number') return /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? s : esc(s);
  return esc(s);
}

module.exports = {
  id: 'mysql',
  kindOf,
  qi,
  sqlLiteral,
  scriptStart: '',
  commit: 'COMMIT;',
  splitDialect: 'mysql',
  formatLanguage: 'mysql',
  formatOptions: { paramTypes: { positional: true } },
};
