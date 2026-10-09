// Full DDL via DBMS_METADATA, with options (storage, indexes, comments, triggers, grants).
const { get } = require('./sessions');

const DDL_TYPE = {
  'MATERIALIZED VIEW': 'MATERIALIZED_VIEW',
  'PACKAGE BODY': 'PACKAGE_BODY',
  'TYPE BODY': 'TYPE_BODY',
};

const DDL_DEFAULTS = { storage: false, indexes: true, comments: true, triggers: true, grants: false, schema: true };

async function setDdlTransforms(conn, o) {
  const b = (v) => (v ? 'TRUE' : 'FALSE');
  await conn.execute(`BEGIN
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', ${b(o.storage)});
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', ${b(o.storage)});
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'TABLESPACE', ${b(o.storage)});
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
    DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE);
  END;`);
  try {
    // 12.2+: drop the "OWNER". prefix when asked
    await conn.execute(`BEGIN DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'EMIT_SCHEMA', ${b(o.schema)}); END;`);
  } catch { /* older database */ }
}

async function metaDdl(conn, sql, binds) {
  try {
    const r = await conn.execute(sql, binds);
    return String(r.rows[0][0] || '').trim();
  } catch (e) {
    if (/ORA-31608|ORA-31603/.test(e.message)) return ''; // no such dependent objects
    throw e;
  }
}

/** Full DDL: the object itself plus (for tables/views) indexes, comments, triggers and grants. */
async function ddlOn(conn, owner, name, type, options = {}) {
  const o = { ...DDL_DEFAULTS, ...options };
  await setDdlTransforms(conn, o);
  const parts = [];
  const main = await metaDdl(conn, `SELECT DBMS_METADATA.GET_DDL(:t, :n, :o) FROM dual`, { t: DDL_TYPE[type] || type, n: name, o: owner });
  if (main) parts.push(main);
  const tabular = ['TABLE', 'VIEW', 'MATERIALIZED VIEW'].includes(type);
  if (tabular && o.indexes && type !== 'VIEW') {
    const idx = await conn.execute(
      `SELECT i.owner, i.index_name FROM all_indexes i
        WHERE i.table_owner = :o AND i.table_name = :t
          AND i.index_type NOT IN ('LOB', 'IOT - TOP')
          AND NOT EXISTS (SELECT 1 FROM all_constraints c
                           WHERE c.owner = i.table_owner AND c.table_name = i.table_name
                             AND c.index_name = i.index_name AND c.constraint_type IN ('P', 'U'))
        ORDER BY i.index_name`,
      { o: owner, t: name }
    );
    const ddls = [];
    for (const [iowner, iname] of idx.rows) {
      const d = await metaDdl(conn, `SELECT DBMS_METADATA.GET_DDL('INDEX', :n, :o) FROM dual`, { n: iname, o: iowner });
      if (d) ddls.push(d);
    }
    if (ddls.length) parts.push('-- Indexes\n' + ddls.join('\n\n'));
  }
  const dependent = async (kind, label) => {
    const d = await metaDdl(conn, `SELECT DBMS_METADATA.GET_DEPENDENT_DDL(:k, :n, :o) FROM dual`, { k: kind, n: name, o: owner });
    if (d) parts.push(`-- ${label}\n${d}`);
  };
  if (tabular && o.comments) await dependent('COMMENT', 'Comments');
  if (tabular && o.triggers) await dependent('TRIGGER', 'Triggers');
  if (o.grants) await dependent('OBJECT_GRANT', 'Grants');
  return parts.join('\n\n');
}

async function ddl(winId, owner, name, type, options) {
  return ddlOn(get(winId).conn, owner, name, type, options);
}

module.exports = { ddlOn, ddl };
