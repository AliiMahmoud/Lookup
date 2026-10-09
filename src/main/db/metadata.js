// Schema browsing: schemas, objects, columns, table structure, and PDBs on the server.
const { kindOf } = require('../sqlgen');
const { get } = require('./sessions');

async function schemas(winId) {
  const { conn } = get(winId);
  let rows;
  try {
    rows = (await conn.execute(`SELECT username, oracle_maintained FROM all_users ORDER BY username`)).rows;
  } catch {
    rows = (await conn.execute(`SELECT username, 'N' FROM all_users ORDER BY username`)).rows;
  }
  return rows.map(([name, om]) => ({ name, system: om === 'Y' }));
}

async function objects(winId, owner) {
  const { conn } = get(winId);
  const r = await conn.execute(
    `SELECT object_name, object_type, status FROM all_objects
      WHERE owner = :o
        AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','TRIGGER','SYNONYM','TYPE')
        AND object_name NOT LIKE 'BIN$%'
      ORDER BY object_name`,
    { o: owner }
  );
  const mviews = new Set(r.rows.filter((x) => x[1] === 'MATERIALIZED VIEW').map((x) => x[0]));
  return r.rows
    .filter(([name, type]) => !(type === 'TABLE' && mviews.has(name)))
    .map(([name, type, status]) => ({ name, type, invalid: status !== 'VALID' }));
}

async function tableColumns(s, owner, table) {
  const key = owner + '.' + table;
  if (s.colCache.has(key)) return s.colCache.get(key);
  const r = await s.conn.execute(
    `SELECT c.column_name, c.data_type, c.data_length, c.char_length, c.char_used, c.data_precision, c.data_scale,
            c.nullable, c.data_default, cc.comments, c.column_id
       FROM all_tab_columns c
       LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
      WHERE c.owner = :o AND c.table_name = :t
      ORDER BY c.column_id`,
    { o: owner, t: table }
  );
  const cols = r.rows.map(([name, type, len, charLen, charUsed, prec, scale, nullable, def, comments, id]) => {
    let full = type;
    if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR'].includes(type)) full += `(${charLen}${charUsed === 'C' && type.startsWith('VAR') ? ' CHAR' : ''})`;
    else if (type === 'RAW') full += `(${len})`;
    else if (type === 'NUMBER' && prec != null) full += scale && scale !== '0' ? `(${prec},${scale})` : `(${prec})`;
    return {
      name, type, fullType: full, nullable: nullable === 'Y',
      default: def == null ? null : String(def).trim(), comments, id: Number(id), kind: kindOf(type),
    };
  });
  s.colCache.set(key, cols);
  return cols;
}

async function columns(winId, owner, table) {
  return tableColumns(get(winId), owner, table);
}

async function structure(winId, owner, name) {
  const s = get(winId);
  s.colCache.delete(owner + '.' + name);
  const cols = await tableColumns(s, owner, name);
  const cons = await s.conn.execute(
    `SELECT c.constraint_name, c.constraint_type, c.status, c.search_condition_vc, c.r_owner, c.r_constraint_name,
            (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
               FROM all_cons_columns cc WHERE cc.owner = c.owner AND cc.constraint_name = c.constraint_name) cols,
            (SELECT rc.table_name FROM all_constraints rc WHERE rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name) r_table,
            c.delete_rule, c.index_name, c.generated,
            (SELECT LISTAGG(rcc.column_name, ', ') WITHIN GROUP (ORDER BY rcc.position)
               FROM all_cons_columns rcc WHERE rcc.owner = c.r_owner AND rcc.constraint_name = c.r_constraint_name) r_cols
       FROM all_constraints c
      WHERE c.owner = :o AND c.table_name = :t AND c.constraint_name NOT LIKE 'BIN$%'
      ORDER BY DECODE(c.constraint_type, 'P', 1, 'U', 2, 'R', 3, 4), c.constraint_name`,
    { o: owner, t: name }
  ).catch(() => s.conn.execute(
    // 11g has no SEARCH_CONDITION_VC
    `SELECT c.constraint_name, c.constraint_type, c.status, NULL, c.r_owner, c.r_constraint_name,
            (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
               FROM all_cons_columns cc WHERE cc.owner = c.owner AND cc.constraint_name = c.constraint_name) cols,
            (SELECT rc.table_name FROM all_constraints rc WHERE rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name) r_table,
            c.delete_rule, c.index_name, c.generated, NULL
       FROM all_constraints c WHERE c.owner = :o AND c.table_name = :t ORDER BY c.constraint_name`,
    { o: owner, t: name }
  ));
  const typeName = { P: 'PRIMARY KEY', U: 'UNIQUE', R: 'FOREIGN KEY', C: 'CHECK', V: 'VIEW CHECK', O: 'READ ONLY' };
  const constraints = cons.rows
    .filter((r) => !(r[1] === 'C' && /IS NOT NULL$/i.test(r[3] || '')))
    .map(([cname, ctype, status, cond, rOwner, rCons, ccols, rTable, delRule, indexName, generated, rCols]) => ({
      name: cname, type: typeName[ctype] || ctype, status, columns: ccols, indexName,
      generated: generated === 'GENERATED NAME',
      detail: ctype === 'R'
        ? `→ ${rOwner}.${rTable}${rCols ? ` (${rCols})` : ''}${delRule && delRule !== 'NO ACTION' ? ` on delete ${delRule.toLowerCase()}` : ''}`
        : ctype === 'C' ? cond : '',
    }));
  const pk = constraints.find((c) => c.type === 'PRIMARY KEY');
  const pkCols = new Set(pk ? pk.columns.split(', ') : []);
  const idx = await s.conn.execute(
    `SELECT i.index_name, i.index_type, i.uniqueness, i.status,
            (SELECT LISTAGG(ic.column_name || DECODE(ic.descend, 'DESC', ' DESC', ''), ', ') WITHIN GROUP (ORDER BY ic.column_position)
               FROM all_ind_columns ic WHERE ic.index_owner = i.owner AND ic.index_name = i.index_name) cols
       FROM all_indexes i WHERE i.table_owner = :o AND i.table_name = :t ORDER BY i.index_name`,
    { o: owner, t: name }
  );
  const backing = new Set(constraints.filter((c) => c.indexName).map((c) => c.indexName));
  const indexes = idx.rows.map(([iname, itype, uniq, status, icols]) => ({
    name: iname, type: itype, unique: uniq === 'UNIQUE', status, columns: icols,
    constraint: backing.has(iname) || itype === 'LOB',
  }));
  let identity = new Map();
  try {
    const ic = await s.conn.execute(`SELECT column_name, generation_type FROM all_tab_identity_columns WHERE owner = :o AND table_name = :t`, { o: owner, t: name });
    identity = new Map(ic.rows.map(([c, g]) => [c, g]));
  } catch { /* before 12c */ }
  let comment = null;
  try {
    const tc = await s.conn.execute(`SELECT comments FROM all_tab_comments WHERE owner = :o AND table_name = :t`, { o: owner, t: name });
    comment = tc.rows[0] ? tc.rows[0][0] : null;
  } catch { /* ignore */ }
  return {
    columns: cols.map((c) => ({ ...c, pk: pkCols.has(c.name), identity: identity.has(c.name) ? identity.get(c.name) : null })),
    constraints, indexes, comment,
  };
}

/** Pluggable databases visible from this session, with the service name to reach each. */
async function pdbs(winId) {
  const { conn } = get(winId);
  const one = async (sql) => { try { const r = await conn.execute(sql); return r.rows; } catch { return null; } };
  const ctx = await one(`SELECT SYS_CONTEXT('USERENV','CON_NAME'), SYS_CONTEXT('USERENV','DB_NAME') FROM dual`);
  const current = ctx ? ctx[0][0] : null;
  const dbName = ctx ? ctx[0][1] : null;
  const domainRows = await one(`SELECT value FROM v$parameter WHERE name = 'db_domain'`);
  const domain = domainRows && domainRows[0] && domainRows[0][0] ? String(domainRows[0][0]).trim() : '';
  const withDomain = (n) => (domain ? `${n}.${domain}` : n);
  const rows = await one(`SELECT name, open_mode, con_id FROM v$pdbs ORDER BY con_id`);
  if (rows === null) return { current, list: [], note: 'This login cannot see V$PDBS (needs SELECT_CATALOG_ROLE or a DBA role).' };
  const list = rows
    .filter(([name]) => name !== 'PDB$SEED')
    .map(([name, openMode]) => ({ name, openMode, open: /READ/.test(openMode || ''), service: withDomain(String(name).toLowerCase()) }));
  if (current === 'CDB$ROOT') {
    const svc = await one(`SELECT value FROM v$parameter WHERE name = 'service_names'`);
    const rootSvc = svc && svc[0] && svc[0][0] ? String(svc[0][0]).split(',')[0].trim() : withDomain(String(dbName || '').toLowerCase());
    list.unshift({ name: 'CDB$ROOT', openMode: 'READ WRITE', open: true, service: rootSvc, root: true });
  }
  let note = null;
  if (!list.length) note = 'No pluggable databases (this is not a container database).';
  else if (current !== 'CDB$ROOT' && list.length === 1) note = 'Connected inside a PDB: other PDBs are only visible from CDB$ROOT.';
  return { current, list, note };
}

module.exports = { tableColumns, pdbs, schemas, objects, columns, structure };
