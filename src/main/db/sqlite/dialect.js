// SQLite SQL dialect for exports and the editor: quoting, literals in INSERT exports, script
// splitting and the formatter language.
const { kindOf, qi } = require('./sqlgen');

const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** A value as a SQLite literal; null when a binary was only partly fetched. */
function sqlLiteral(v, type) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object' && v.$bin !== undefined) {
    if (v.$bin.length / 2 < v.len) return null;
    return `X'${v.$bin}'`;
  }
  const s = String(v);
  if (kindOf(type) === 'number' && /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return s;
  return esc(s);
}

module.exports = {
  id: 'sqlite',
  kindOf,
  qi,
  sqlLiteral,
  scriptStart: '',
  // No COMMIT lines: with auto-commit on (and in the sqlite3 shell) there is no transaction to commit, and
  // SQLite rejects COMMIT then; with manual commit, the inserts are committed like any other change.
  commit: '',
  splitDialect: 'sqlite',
  formatLanguage: 'sqlite',
  formatOptions: { paramTypes: { positional: true } },
};
