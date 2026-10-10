// MySQL / MariaDB schema browsing from information_schema: schemas (= databases), objects, columns
// and table structure. Every function takes the open session (s) first.
const { kindOf } = require('./sqlgen');

const SYSTEM = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

async function schemas(s) {
  const r = await s.conn.execute(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`);
  return r.rows.map(([name]) => ({ name, system: SYSTEM.has(String(name).toLowerCase()) }));
}

async function objects(s, schema) {
  const r = await s.conn.execute(
    `SELECT TABLE_NAME, CASE TABLE_TYPE WHEN 'VIEW' THEN 'VIEW' WHEN 'SYSTEM VIEW' THEN 'VIEW' WHEN 'SEQUENCE' THEN 'SEQUENCE' ELSE 'TABLE' END
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
     UNION ALL
     SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
     UNION ALL
     SELECT TRIGGER_NAME, 'TRIGGER' FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
     UNION ALL
     SELECT EVENT_NAME, 'EVENT' FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?
     ORDER BY 1`,
    [schema, schema, schema, schema]
  );
  return r.rows.map(([name, type]) => ({ name, type, invalid: false }));
}

async function tableColumns(s, schema, table) {
  const key = schema + '.' + table;
  if (s.colCache.has(key)) return s.colCache.get(key);
  const r = await s.conn.execute(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, ORDINAL_POSITION, EXTRA, COLUMN_KEY
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [schema, table]
  );
  const cols = r.rows.map(([name, type, fullType, nullable, def, comments, id, extra, key]) => ({
    name, type: String(type).toLowerCase(), fullType, nullable: nullable === 'YES',
    default: def === null || def === undefined ? null : String(def), comments: comments || null, id: Number(id),
    kind: kindOf(type), identity: /auto_increment/i.test(extra || '') ? 'AUTO_INCREMENT' : null, extra: extra || '', key,
  }));
  s.colCache.set(key, cols);
  return cols;
}

const columns = (s, schema, table) => tableColumns(s, schema, table);

async function primaryKey(s, schema, table) {
  const r = await s.conn.execute(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`,
    [schema, table]
  );
  return r.rows.map((x) => x[0]);
}

async function structure(s, schema, name) {
  s.colCache.delete(schema + '.' + name);
  const cols = await tableColumns(s, schema, name);
  const cons = await s.conn.execute(
    `SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE,
            (SELECT GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', ') FROM information_schema.KEY_COLUMN_USAGE k
              WHERE k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME),
            (SELECT CONCAT(k.REFERENCED_TABLE_SCHEMA, '.', k.REFERENCED_TABLE_NAME, ' (',
                    GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', '), ')')
               FROM information_schema.KEY_COLUMN_USAGE k
              WHERE k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                AND k.REFERENCED_TABLE_NAME IS NOT NULL
              GROUP BY k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME),
            (SELECT rc.DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS rc
              WHERE rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND rc.TABLE_NAME = tc.TABLE_NAME AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME)
       FROM information_schema.TABLE_CONSTRAINTS tc
      WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
      ORDER BY FIELD(tc.CONSTRAINT_TYPE, 'PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK'), tc.CONSTRAINT_NAME`,
    [schema, name]
  );
  let checks = new Map();
  try {
    const c = await s.conn.execute(
      `SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, name]
    );
    checks = new Map(c.rows.map(([n, clause]) => [n, clause]));
  } catch { /* MySQL before 8.0.16 has no CHECK_CONSTRAINTS */ }
  const constraints = cons.rows
    .map(([cname, type, ccols, ref, delRule]) => ({
      name: cname, type, status: 'ENABLED', columns: ccols || '', indexName: type === 'FOREIGN KEY' || type === 'CHECK' ? null : cname, generated: false,
      detail: type === 'FOREIGN KEY'
        ? `→ ${ref || '?'}${delRule && delRule !== 'RESTRICT' && delRule !== 'NO ACTION' ? ` on delete ${delRule.toLowerCase()}` : ''}`
        : type === 'CHECK' ? checks.get(cname) || '' : '',
    }));
  const pk = constraints.find((c) => c.type === 'PRIMARY KEY');
  const pkCols = new Set(pk ? pk.columns.split(', ') : []);
  const idx = await s.conn.execute(
    `SELECT INDEX_NAME, MAX(INDEX_TYPE), MIN(NON_UNIQUE),
            GROUP_CONCAT(CONCAT(COALESCE(COLUMN_NAME, EXPRESSION_PLACEHOLDER), IF(COLLATION = 'D', ' DESC', '')) ORDER BY SEQ_IN_INDEX SEPARATOR ', ')
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME ORDER BY INDEX_NAME`.replace('EXPRESSION_PLACEHOLDER', await expressionColumn(s)),
    [schema, name]
  );
  const backing = new Set(constraints.filter((c) => c.indexName).map((c) => c.indexName));
  const indexes = idx.rows.map(([iname, type, nonUnique, icols]) => ({
    name: iname, type, unique: Number(nonUnique) === 0, status: 'VALID', columns: icols, constraint: backing.has(iname),
  }));
  const tc = await s.conn.execute(`SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [schema, name]);
  return {
    columns: cols.map((c) => ({ ...c, pk: pkCols.has(c.name) })),
    constraints, indexes, comment: tc.rows[0] && tc.rows[0][0] ? tc.rows[0][0] : null,
  };
}

/** MySQL 8 has STATISTICS.EXPRESSION (functional indexes); MariaDB and older MySQL don't. */
async function expressionColumn(s) {
  if (s.hasIndexExpression === undefined) {
    const r = await s.conn.execute(
      `SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'information_schema' AND TABLE_NAME = 'STATISTICS' AND COLUMN_NAME = 'EXPRESSION'`
    );
    s.hasIndexExpression = Number(r.rows[0][0]) > 0;
  }
  return s.hasIndexExpression ? 'EXPRESSION' : 'NULL';
}

module.exports = { schemas, objects, tableColumns, columns, primaryKey, structure, SYSTEM };
