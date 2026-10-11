// Oracle: full DDL via DBMS_METADATA, with options (storage, indexes, comments, triggers, grants).
const crypto = require('crypto');
const { ora } = require('./driver');

const DDL_TYPE = {
  'MATERIALIZED VIEW': 'MATERIALIZED_VIEW',
  'PACKAGE BODY': 'PACKAGE_BODY',
  'TYPE BODY': 'TYPE_BODY',
};

const DDL_DEFAULTS = { storage: false, indexes: true, comments: true, triggers: true, grants: false, schema: true };

/** Indexes of a table that don't back a primary / unique key (those come with the constraint). */
const INDEX_SQL = (owner, table) => `SELECT i.owner, i.index_name FROM all_indexes i
        WHERE i.table_owner = ${owner} AND i.table_name = ${table}
          AND i.index_type NOT IN ('LOB', 'IOT - TOP')
          AND NOT EXISTS (SELECT 1 FROM all_constraints c
                           WHERE c.owner = i.table_owner AND c.table_name = i.table_name
                             AND c.index_name = i.index_name AND c.constraint_type IN ('P', 'U'))
        ORDER BY i.index_name`;

// Everything in one call to the database: one round trip instead of one per DBMS_METADATA call
// (6 to 10 for a table), which is what counts on a remote server.
// ORA-31603 / ORA-31608 = no such object / no such dependent objects: that part is left empty.
const DDL_BLOCK = `DECLARE
  v_owner VARCHAR2(128) := :o;
  v_name  VARCHAR2(128) := :n;
  v_sep   VARCHAR2(64) := :sep;
  v_store BOOLEAN := :storage = 1;
  v_st    NUMBER := DBMS_METADATA.SESSION_TRANSFORM;
  v_main  CLOB;
  v_one   CLOB;
  v_idx   CLOB;
  v_com   CLOB;
  v_trg   CLOB;
  v_grt   CLOB;
  FUNCTION missing RETURN BOOLEAN IS
    v_err VARCHAR2(4000) := DBMS_UTILITY.FORMAT_ERROR_STACK;
  BEGIN
    RETURN INSTR(v_err, 'ORA-31608') > 0 OR INSTR(v_err, 'ORA-31603') > 0;
  END;
  FUNCTION obj(p_type VARCHAR2, p_name VARCHAR2, p_owner VARCHAR2) RETURN CLOB IS
  BEGIN
    RETURN DBMS_METADATA.GET_DDL(p_type, p_name, p_owner);
  EXCEPTION WHEN OTHERS THEN
    IF missing THEN RETURN NULL; END IF;
    RAISE;
  END;
  FUNCTION dep(p_kind VARCHAR2) RETURN CLOB IS
  BEGIN
    RETURN DBMS_METADATA.GET_DEPENDENT_DDL(p_kind, v_name, v_owner);
  EXCEPTION WHEN OTHERS THEN
    IF missing THEN RETURN NULL; END IF;
    RAISE;
  END;
BEGIN
  DBMS_METADATA.SET_TRANSFORM_PARAM(v_st, 'SEGMENT_ATTRIBUTES', v_store);
  DBMS_METADATA.SET_TRANSFORM_PARAM(v_st, 'STORAGE', v_store);
  DBMS_METADATA.SET_TRANSFORM_PARAM(v_st, 'TABLESPACE', v_store);
  DBMS_METADATA.SET_TRANSFORM_PARAM(v_st, 'SQLTERMINATOR', TRUE);
  DBMS_METADATA.SET_TRANSFORM_PARAM(v_st, 'PRETTY', TRUE);
  BEGIN
    -- 12.2+: drop the "OWNER". prefix when asked
    DBMS_METADATA.SET_TRANSFORM_PARAM(v_st, 'EMIT_SCHEMA', :emit = 1);
  EXCEPTION WHEN OTHERS THEN NULL; -- older database
  END;
  v_main := obj(:t, v_name, v_owner);
  IF :indexes = 1 THEN
    FOR r IN (${INDEX_SQL('v_owner', 'v_name')}) LOOP
      v_one := obj('INDEX', r.index_name, r.owner);
      IF v_one IS NOT NULL THEN v_idx := v_idx || v_sep || v_one; END IF;
    END LOOP;
  END IF;
  IF :comments = 1 THEN v_com := dep('COMMENT'); END IF;
  IF :triggers = 1 THEN v_trg := dep('TRIGGER'); END IF;
  IF :grants = 1 THEN v_grt := dep('OBJECT_GRANT'); END IF;
  :parts := v_main || v_sep || v_com || v_sep || v_trg || v_sep || v_grt || v_idx;
END;`;

const text = (v) => String(v || '').trim();

async function ddlParts(conn, owner, name, type, o, want) {
  const n = (v) => (v ? 1 : 0);
  // The parts come back as one long string in the same call; the separator between them is random
  // so it can't be part of the DDL.
  const sep = `\n\u001e${crypto.randomBytes(12).toString('hex')}\u001e\n`;
  const r = await conn.execute(DDL_BLOCK, {
    o: owner, n: name, t: DDL_TYPE[type] || type, sep,
    storage: n(o.storage), emit: n(o.schema),
    indexes: n(want.indexes), comments: n(want.comments), triggers: n(want.triggers), grants: n(want.grants),
    parts: { dir: ora().BIND_OUT, type: ora().STRING, maxSize: 1024 * 1024 * 1024 - 1 },
  });
  const [main, comments, triggers, grants, ...indexes] = String(r.outBinds.parts || '').split(sep).map(text);
  if (grants === undefined) throw new Error('Incomplete DDL answer');
  return { main, indexes: indexes.filter(Boolean), comments, triggers, grants };
}

// ---------- one statement per part (used when the single call above fails) ----------

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
    return text(r.rows[0][0]);
  } catch (e) {
    if (/ORA-31608|ORA-31603/.test(e.message)) return ''; // no such dependent objects
    throw e;
  }
}

async function ddlPartsEach(conn, owner, name, type, o, want) {
  await setDdlTransforms(conn, o);
  const parts = { main: '', indexes: [], comments: '', triggers: '', grants: '' };
  parts.main = await metaDdl(conn, `SELECT DBMS_METADATA.GET_DDL(:t, :n, :o) FROM dual`, { t: DDL_TYPE[type] || type, n: name, o: owner });
  if (want.indexes) {
    const idx = await conn.execute(INDEX_SQL(':o', ':t'), { o: owner, t: name });
    for (const [iowner, iname] of idx.rows) {
      const d = await metaDdl(conn, `SELECT DBMS_METADATA.GET_DDL('INDEX', :n, :o) FROM dual`, { n: iname, o: iowner });
      if (d) parts.indexes.push(d);
    }
  }
  const dependent = (kind) => metaDdl(conn, `SELECT DBMS_METADATA.GET_DEPENDENT_DDL(:k, :n, :o) FROM dual`, { k: kind, n: name, o: owner });
  if (want.comments) parts.comments = await dependent('COMMENT');
  if (want.triggers) parts.triggers = await dependent('TRIGGER');
  if (want.grants) parts.grants = await dependent('OBJECT_GRANT');
  return parts;
}

/** Full DDL: the object itself plus (for tables/views) indexes, comments, triggers and grants. */
async function ddlOn(conn, owner, name, type, options = {}) {
  const o = { ...DDL_DEFAULTS, ...options };
  const tabular = ['TABLE', 'VIEW', 'MATERIALIZED VIEW'].includes(type);
  const want = {
    indexes: tabular && o.indexes && type !== 'VIEW', comments: tabular && o.comments,
    triggers: tabular && o.triggers, grants: !!o.grants,
  };
  let p;
  try {
    p = await ddlParts(conn, owner, name, type, o, want);
  } catch {
    // Whatever went wrong, the statement-by-statement way gives the result or the database's own error.
    p = await ddlPartsEach(conn, owner, name, type, o, want);
  }
  const parts = [];
  if (p.main) parts.push(p.main);
  if (p.indexes.length) parts.push('-- Indexes\n' + p.indexes.join('\n\n'));
  if (p.comments) parts.push(`-- Comments\n${p.comments}`);
  if (p.triggers) parts.push(`-- Triggers\n${p.triggers}`);
  if (p.grants) parts.push(`-- Grants\n${p.grants}`);
  return parts.join('\n\n');
}

async function ddl(s, owner, name, type, options) {
  return ddlOn(s.conn, owner, name, type, options);
}

module.exports = { ddlOn, ddl };
