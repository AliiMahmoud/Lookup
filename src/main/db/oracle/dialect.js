// Oracle SQL dialect for exports and the editor: quoting, literals in INSERT exports, script
// splitting and the formatter language.
const { kindOf, qi } = require('./sqlgen');

function sqlString(s) {
  // Oracle string literals are limited to 4000 bytes; longer text is concatenated as CLOB chunks.
  const esc = (x) => "'" + x.replace(/'/g, "''") + "'";
  if (Buffer.byteLength(s, 'utf8') <= 3800) return esc(s);
  const parts = [];
  for (let i = 0; i < s.length; i += 1000) parts.push('TO_CLOB(' + esc(s.slice(i, i + 1000)) + ')');
  return parts.join(' || ');
}

/** A value as an Oracle literal; null when a binary is too large (or only partly fetched) to write. */
function sqlLiteral(v, type) {
  if (v === null || v === undefined) return 'NULL';
  const k = kindOf(type);
  const t = String(type || '').toUpperCase();
  if (typeof v === 'object' && v.$bin !== undefined) {
    if (v.$bin.length / 2 < v.len) return null; // truncated preview, cannot export
    if (v.len > 2000) return null;
    return t === 'BLOB' ? `TO_BLOB(HEXTORAW('${v.$bin}'))` : `HEXTORAW('${v.$bin}')`;
  }
  const s = String(v);
  if (k === 'number') return /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? s : sqlString(s);
  if (k === 'date') return `TO_DATE('${s.slice(0, 19)}', 'YYYY-MM-DD HH24:MI:SS')`;
  if (k === 'timestamp') return `TO_TIMESTAMP('${s}', 'YYYY-MM-DD HH24:MI:SS.FF')`;
  return sqlString(s);
}

module.exports = {
  id: 'oracle',
  kindOf,
  qi,
  sqlLiteral,
  scriptStart: 'SET DEFINE OFF;\n\n', // SQL*Plus / SQL Developer: don't treat & as a substitution variable
  commit: 'COMMIT;',
  splitDialect: 'oracle',
  formatLanguage: 'plsql',
  formatOptions: { paramTypes: { named: [':'] } },
};
