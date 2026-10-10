// What the workspace UI needs to know about SQLite: names, sidebar sections and which features exist.
// Schemas are main, temp and any attached database files.
module.exports = {
  id: 'sqlite',
  label: 'SQLite',
  badge: 'Sq',
  schemaWord: 'Database',
  databasesWord: null,
  splitDialect: 'sqlite',
  quote: '"',
  sections: [['TABLE', 'Tables'], ['VIEW', 'Views'], ['INDEX', 'Indexes'], ['TRIGGER', 'Triggers']],
  collapsed: ['INDEX', 'TRIGGER'],
  tableTypes: ['TABLE'],
  dataTypes: ['VIEW'],
  codeTypes: ['INDEX', 'TRIGGER'],
  systemSchemasLabel: 'Temporary',
  features: {
    databases: false,
    editRows: true, // grid edits by primary key (tables without one stay read-only)
    createTable: false,
    alterTable: false,
    truncate: false,
    dropTable: false,
    explain: true,
    dbmsOutput: false,
    ddlOptions: false,
    ddlCommits: false,
    sequences: false,
  },
  explain: ['EXPLAIN QUERY PLAN {sql}'],
  selectTop: 'SELECT *\n  FROM {qname}\n LIMIT 100;',
  defaultPort: null,
};
