// ClickHouse SQL dialect for exports and the editor: quoting, literals in INSERT exports, script
// splitting and the formatter language.
const { kindOf, qi, lit, baseType } = require('./sqlgen');

/** A value as a ClickHouse literal. Arrays, maps and tuples arrive as JSON text, which the server
 *  turns back into the column's type with JSONExtract. */
function sqlLiteral(v, type) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object' && v.$bin !== undefined) return lit(Buffer.from(v.$bin, 'hex').toString('latin1'));
  const s = String(v);
  if (/^(Array|Map|Tuple|Nested)\(/.test(baseType(type))) return `JSONExtract(${lit(s)}, ${lit(String(type))})`;
  if (kindOf(type) === 'number' && /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return s;
  return lit(s);
}

module.exports = {
  id: 'clickhouse',
  kindOf,
  qi,
  sqlLiteral,
  scriptStart: '',
  commit: '', // no transactions
  splitDialect: 'clickhouse',
  formatLanguage: 'clickhouse',
  // Names, functions and types are case-sensitive in ClickHouse, so Beautify only changes the layout.
  formatOptions: { keywordCase: 'preserve', functionCase: 'preserve', dataTypeCase: 'preserve' },
};
