// MongoDB has no SQL: this only satisfies the shared code that asks every engine for its dialect.
module.exports = {
  id: 'mongodb',
  kindOf: () => 'text',
  qi: (s) => String(s),
  sqlLiteral: (v) => (v === null || v === undefined ? '' : String(v)),
  scriptStart: '',
  commit: '',
  splitDialect: 'clickhouse',
  formatLanguage: 'sql',
};
