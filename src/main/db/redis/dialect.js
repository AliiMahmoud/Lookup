// Redis has no SQL: this only satisfies the shared code that asks every engine for its dialect
// (exports and Beautify are not offered for Redis).
module.exports = {
  id: 'redis',
  kindOf: () => 'text',
  qi: (s) => String(s),
  sqlLiteral: (v) => (v === null || v === undefined ? '' : String(v)),
  scriptStart: '',
  commit: '',
  splitDialect: 'clickhouse',
  formatLanguage: 'sql',
};
