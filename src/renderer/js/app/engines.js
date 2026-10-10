// Database types in the UI: names, badges and form defaults per engine, and what the connected
// engine supports (its profile arrives from the main process when connecting: S.info.engine).
(function () {
  const Lookup = window.Lookup;
  const { S } = Lookup;

  const ENGINES = {
    oracle: {
      id: 'oracle', label: 'Oracle', badge: 'Oc', color: '#d0473a', port: 1521,
      blurb: 'Thin mode, no Instant Client · service name, SID or TNS descriptor',
    },
    postgres: {
      id: 'postgres', label: 'PostgreSQL', badge: 'Pg', color: '#3b74c4', port: 5432,
      blurb: 'PostgreSQL 11 and later · also Amazon RDS, Aurora, Supabase, Neon',
    },
    mysql: {
      id: 'mysql', label: 'MySQL', badge: 'My', color: '#e48e2a', port: 3306,
      blurb: 'MySQL 5.7 and later, and MariaDB · also Amazon RDS, PlanetScale',
    },
    sqlite: {
      id: 'sqlite', label: 'SQLite', badge: 'Sq', color: '#0f80cc', port: null, file: true,
      blurb: 'A database file on this computer · open one or create a new file',
    },
    clickhouse: {
      id: 'clickhouse', label: 'ClickHouse', badge: 'Ch', color: '#c9a800', port: 8123,
      blurb: 'ClickHouse over HTTP(S) · also ClickHouse Cloud · read-only grid',
    },
    redis: {
      id: 'redis', label: 'Redis', badge: 'Rd', color: '#d82c20', port: 6379, passwordOptional: true,
      blurb: 'Redis 5 and later, also Valkey · key browser, Workbench and Shell',
    },
    mongodb: {
      id: 'mongodb', label: 'MongoDB', badge: 'Mg', color: '#13aa52', port: 27017, passwordOptional: true,
      blurb: 'MongoDB 4.2 and later, also Atlas · documents, aggregations, schema, shell',
    },
  };

  /** Engine of a saved connection; connections from before multi-database support are Oracle. */
  const engineOf = (c) => ENGINES[(c && c.engine) || 'oracle'] || ENGINES.oracle;

  // What the connected engine supports; Oracle's set before any profile arrived (older stubs, tests).
  const ORACLE_FALLBACK = {
    id: 'oracle', label: 'Oracle', badge: 'Oc', schemaWord: 'Schema', databasesWord: 'PDB', splitDialect: 'oracle',
    sections: [['TABLE', 'Tables'], ['VIEW', 'Views'], ['MATERIALIZED VIEW', 'Materialized Views'], ['SEQUENCE', 'Sequences'],
      ['PACKAGE', 'Packages'], ['PROCEDURE', 'Procedures'], ['FUNCTION', 'Functions'], ['TRIGGER', 'Triggers'],
      ['TYPE', 'Types'], ['SYNONYM', 'Synonyms']],
    collapsed: ['SEQUENCE', 'TRIGGER', 'TYPE', 'SYNONYM'],
    systemSchemasLabel: 'Oracle-maintained',
    features: { databases: true, editRows: true, createTable: true, alterTable: true, truncate: true, dropTable: true, explain: true, dbmsOutput: true, ddlOptions: true, ddlCommits: true, sequences: true },
    explain: ['EXPLAIN PLAN FOR {sql}', "SELECT plan_table_output AS \"Plan\" FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'TYPICAL'))"],
    nextval: 'SELECT {qname}.NEXTVAL FROM dual;',
    selectTop: 'SELECT *\n  FROM {qname}\n FETCH FIRST 100 ROWS ONLY;',
  };
  const profile = () => (S.info && S.info.engine) || (S.current && S.current.engine && S.current.engine !== 'oracle'
    ? { ...ORACLE_FALLBACK, id: S.current.engine, splitDialect: S.current.engine, features: {} } : ORACLE_FALLBACK);
  const feature = (name) => !!(profile().features || {})[name];
  const dialect = () => profile().splitDialect || 'oracle';
  const engineId = () => profile().id || 'oracle';

  /** A name written so the connected database reads it back exactly. */
  function qident(n) {
    const id = engineId();
    if (id === 'mysql') return '`' + String(n).replace(/`/g, '``') + '`';
    if (id === 'clickhouse') return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : '`' + String(n).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
    if (id === 'sqlite') return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : '"' + String(n).replace(/"/g, '""') + '"';
    if (id === 'postgres') return /^[a-z_][a-z0-9_$]*$/.test(n) ? n : '"' + String(n).replace(/"/g, '""') + '"';
    return /^[A-Z][A-Z0-9_$#]*$/.test(n) ? n : '"' + String(n).replace(/"/g, '""') + '"';
  }
  const qname = (owner, name) => `${qident(owner)}.${qident(name)}`;
  /** Fills a profile SQL template: {qname} = schema.name, {sql} = a statement. */
  const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

  /** "user@host:port/database" (or the URL / connect string) for lists and the status bar. */
  function target(c) {
    const e = engineOf(c);
    if (e.file) return `${c.file || '(no file chosen)'}${c.readOnly ? ' · read-only' : ''}`;
    if (c.mode === 'string') return `${c.user ? c.user + ' · ' : ''}${e.id === 'oracle' ? 'connect string' : 'URL'}`;
    const where = `${c.host || 'localhost'}:${c.port || e.port}`;
    if (e.id === 'oracle') return `${c.user}@${where}/${c.service || ''}`;
    if (e.id === 'mongodb') {
      if (c.mode === 'string') return String(c.connectString || '').replace(/\/\/[^@/]*@/, '//') || 'URL';
      const hosts = String(c.host || 'localhost').split(/[\s,]+/).filter(Boolean);
      const shown = c.srv ? hosts[0] : hosts.map((x) => (/:\d+$/.test(x) ? x : `${x}:${c.port || 27017}`)).join(',');
      return `${c.user ? c.user + '@' : ''}${shown}${c.database ? '/' + c.database : ''}${c.srv ? ' · SRV' : ''}${c.replicaSet ? ' · ' + c.replicaSet : ''}${c.readOnly ? ' · read-only' : ''}`;
    }
    if (e.id === 'redis') return `${c.user || 'default'}@${where}/${Number(c.database) || 0}${c.ssl === 'require' || c.ssl === 'verify' ? ' · TLS' : ''}${c.readOnly ? ' · read-only' : ''}`;
    return `${c.user || ''}@${where}${c.database ? '/' + c.database : ''}`;
  }

  Object.assign(Lookup, { ENGINES, engineOf, profile, feature, dialect, engineId, qident, qname, fill, target });
})();
