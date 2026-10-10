// What the workspace UI needs to know about Oracle: names, sidebar sections and which features exist.
module.exports = {
  id: 'oracle',
  label: 'Oracle',
  badge: 'Oc',
  schemaWord: 'Schema',
  databasesWord: 'PDB',
  splitDialect: 'oracle',
  quote: '"',
  // Sidebar sections, in order: [object type, title]; collapsed ones start closed.
  sections: [
    ['TABLE', 'Tables'], ['VIEW', 'Views'], ['MATERIALIZED VIEW', 'Materialized Views'], ['SEQUENCE', 'Sequences'],
    ['PACKAGE', 'Packages'], ['PROCEDURE', 'Procedures'], ['FUNCTION', 'Functions'], ['TRIGGER', 'Triggers'],
    ['TYPE', 'Types'], ['SYNONYM', 'Synonyms'],
  ],
  collapsed: ['SEQUENCE', 'TRIGGER', 'TYPE', 'SYNONYM'],
  tableTypes: ['TABLE'],
  dataTypes: ['VIEW', 'MATERIALIZED VIEW', 'SYNONYM'],
  codeTypes: ['PACKAGE', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'TYPE'],
  systemSchemasLabel: 'Oracle-maintained',
  features: {
    databases: true, // databases ▾ menu (PDBs)
    editRows: true, // grid edits (by ROWID)
    createTable: true,
    alterTable: true,
    truncate: true,
    dropTable: true,
    explain: true,
    dbmsOutput: true,
    ddlOptions: true, // storage / grants options in the DDL view
    ddlCommits: true, // DDL commits the open transaction
    sequences: true,
  },
  explain: [
    'EXPLAIN PLAN FOR {sql}',
    "SELECT plan_table_output AS \"Plan\" FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'TYPICAL'))",
  ],
  nextval: 'SELECT {qname}.NEXTVAL FROM dual;',
  selectTop: 'SELECT *\n  FROM {qname}\n FETCH FIRST 100 ROWS ONLY;',
  defaultPort: 1521,
};
