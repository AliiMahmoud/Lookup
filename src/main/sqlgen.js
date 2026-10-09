// Builds safe, bound SQL for grid edits and table browsing.

function qi(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}
function qname(owner, name) {
  return qi(owner) + '.' + qi(name);
}
function lit(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function kindOf(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'DATE') return 'date';
  if (t.startsWith('TIMESTAMP')) return 'timestamp';
  if (['NUMBER', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE', 'INTEGER'].includes(t)) return 'number';
  if (t === 'BLOB' || t === 'RAW' || t === 'LONG RAW' || t === 'BFILE') return 'binary';
  return 'text';
}

function normDate(v) {
  const s = String(v).trim().replace('T', ' ');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + ' 00:00:00' : s;
}

/** Returns { sql, preview } for a value bound as :name, converting by column type. */
function valueExpr(type, bindName, value) {
  if (value === null || value === undefined) return { sql: 'NULL', preview: 'NULL', bind: false };
  const k = kindOf(type);
  if (k === 'date') {
    const v = normDate(value);
    return { sql: `TO_DATE(:${bindName}, 'YYYY-MM-DD HH24:MI:SS')`, preview: `TO_DATE(${lit(v)}, 'YYYY-MM-DD HH24:MI:SS')`, bind: true, value: v };
  }
  if (k === 'timestamp') {
    const v = normDate(value);
    return { sql: `TO_TIMESTAMP(:${bindName}, 'YYYY-MM-DD HH24:MI:SS.FF')`, preview: `TO_TIMESTAMP(${lit(v)}, 'YYYY-MM-DD HH24:MI:SS.FF')`, bind: true, value: v };
  }
  if (k === 'binary') {
    const v = String(value).replace(/^0x/i, '');
    return { sql: `HEXTORAW(:${bindName})`, preview: `HEXTORAW(${lit(v)})`, bind: true, value: v };
  }
  if (k === 'number') {
    const v = String(value).trim();
    return { sql: `:${bindName}`, preview: /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v) ? v : lit(v), bind: true, value: v };
  }
  return { sql: `:${bindName}`, preview: lit(value), bind: true, value: String(value) };
}

/**
 * changes = { updates: [{ rowid, values: {COL: v} }], inserts: [{ values }], deletes: [{ rowid }] }
 * columns = [{ name, type }]
 */
function buildChanges(owner, table, columns, changes) {
  const typeOf = Object.fromEntries(columns.map((c) => [c.name, c.type]));
  const check = (col) => {
    if (!(col in typeOf)) throw new Error(`Unknown column ${col}`);
  };
  const target = qname(owner, table);
  const statements = [];

  for (const d of changes.deletes || []) {
    statements.push({
      sql: `DELETE FROM ${target} WHERE ROWID = :rid`,
      binds: { rid: d.rowid },
      preview: `DELETE FROM ${target} WHERE ROWID = ${lit(d.rowid)};`,
    });
  }
  for (const u of changes.updates || []) {
    const cols = Object.keys(u.values || {});
    if (!cols.length) continue;
    const binds = { rid: u.rowid };
    const sets = [];
    const prev = [];
    cols.forEach((col, i) => {
      check(col);
      const e = valueExpr(typeOf[col], 'v' + i, u.values[col]);
      if (e.bind) binds['v' + i] = e.value;
      sets.push(`${qi(col)} = ${e.sql}`);
      prev.push(`${qi(col)} = ${e.preview}`);
    });
    statements.push({
      sql: `UPDATE ${target} SET ${sets.join(', ')} WHERE ROWID = :rid`,
      binds,
      preview: `UPDATE ${target} SET ${prev.join(', ')} WHERE ROWID = ${lit(u.rowid)};`,
    });
  }
  for (const ins of changes.inserts || []) {
    const cols = Object.keys(ins.values || {}).filter((c) => ins.values[c] !== undefined);
    if (!cols.length) continue;
    const binds = {};
    const vals = [];
    const prev = [];
    cols.forEach((col, i) => {
      check(col);
      const e = valueExpr(typeOf[col], 'v' + i, ins.values[col]);
      if (e.bind) binds['v' + i] = e.value;
      vals.push(e.sql);
      prev.push(e.preview);
    });
    const colList = cols.map(qi).join(', ');
    statements.push({
      sql: `INSERT INTO ${target} (${colList}) VALUES (${vals.join(', ')})`,
      binds,
      preview: `INSERT INTO ${target} (${colList}) VALUES (${prev.join(', ')});`,
    });
  }
  return statements;
}

const OPS = {
  '=': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=',
  LIKE: 'LIKE', 'NOT LIKE': 'NOT LIKE', CONTAINS: 'LIKE',
};

/** filters = [{ col, op, value }] or [{ op: 'RAW', value: '<where text>' }] */
function buildWhere(columns, filters) {
  const typeOf = Object.fromEntries(columns.map((c) => [c.name, c.type]));
  const parts = [];
  const binds = {};
  (filters || []).forEach((f, i) => {
    if (f.op === 'RAW') {
      if (String(f.value || '').trim()) parts.push('(' + f.value + ')');
      return;
    }
    if (!(f.col in typeOf)) return;
    const col = qi(f.col);
    const k = kindOf(typeOf[f.col]);
    if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') { parts.push(`${col} ${f.op}`); return; }
    const b = 'f' + i;
    if (f.op === 'IN') {
      const items = String(f.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!items.length) return;
      const names = items.map((v, j) => { binds[`${b}_${j}`] = v; return ':' + `${b}_${j}`; });
      parts.push(`${col} IN (${names.join(', ')})`);
      return;
    }
    const sqlOp = OPS[f.op];
    if (!sqlOp) return;
    if (sqlOp.includes('LIKE')) {
      const target = k === 'date' ? `TO_CHAR(${col}, 'YYYY-MM-DD HH24:MI:SS')`
        : k === 'timestamp' ? `TO_CHAR(${col}, 'YYYY-MM-DD HH24:MI:SS.FF')`
        : k === 'number' ? `TO_CHAR(${col})` : col;
      binds[b] = f.op === 'CONTAINS' ? `%${f.value ?? ''}%` : String(f.value ?? '');
      parts.push(`${target} ${sqlOp} :${b}`);
      return;
    }
    const e = valueExpr(typeOf[f.col], b, f.value ?? '');
    if (e.bind) binds[b] = e.value;
    parts.push(`${col} ${sqlOp} ${e.sql}`);
  });
  return { where: parts.length ? ' WHERE ' + parts.join(' AND ') : '', binds };
}

/** One page of a table: SQL + binds (bind names must start with a letter in Oracle). */
function buildPageQuery({ owner, name, editable, cols, filters, sort, offset = 0, limit = 300 }) {
  const { where, binds } = buildWhere(cols, filters);
  let order = '';
  if (sort && cols.some((c) => c.name === sort.col)) order = ` ORDER BY ${qi(sort.col)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  else if (editable) order = ' ORDER BY ROWID';
  const select = editable ? 't.ROWID AS "__ROWID", t.*' : 't.*';
  const sql = `SELECT ${select} FROM ${qname(owner, name)} t${where}${order} OFFSET :page_offset ROWS FETCH NEXT :page_limit ROWS ONLY`;
  return { sql, binds: { ...binds, page_offset: Number(offset), page_limit: Number(limit) }, where, countBinds: binds };
}

// ---------- CREATE TABLE ----------
const RESERVED = new Set(`ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT COMPRESS
  CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS FILE FLOAT FOR FROM GRANT
  GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG
  MAXEXTENTS MINUS MLSLABEL MODE MODIFY NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER
  PCTFREE PRIOR PUBLIC RAW RENAME RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START
  SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW
  WHENEVER WHERE WITH`.split(/\s+/));

/**
 * How a name the user typed is written in DDL, and the name Oracle will store.
 * Plain names (letters, digits, _ $ #) stay unquoted, so Oracle stores them in upper case
 * and they can be used without quotes later. Anything else is quoted exactly as typed.
 */
function ddlIdent(raw) {
  const name = String(raw || '').trim();
  if (/^[A-Za-z][A-Za-z0-9_$#]*$/.test(name)) {
    const up = name.toUpperCase();
    return RESERVED.has(up) ? { sql: qi(up), stored: up } : { sql: name, stored: up };
  }
  return { sql: qi(name), stored: name };
}

/**
 * spec = { owner, name, columns: [{ name, type, nullable, default }], primaryKey: [columnName] }
 * Returns { sql, table } or throws with a readable message.
 */
function buildCreateTable(spec) {
  const errors = [];
  const tname = String(spec.name || '').trim();
  if (!tname) errors.push('Give the table a name.');
  const cols = (spec.columns || []).filter((c) => String(c.name || '').trim() || String(c.type || '').trim());
  if (!cols.length) errors.push('Add at least one column.');
  const seen = new Map();
  cols.forEach((c, i) => {
    const n = String(c.name || '').trim();
    if (!n) { errors.push(`Column ${i + 1} has a type but no name.`); return; }
    if (!String(c.type || '').trim()) errors.push(`Column ${n} needs a data type.`);
    const key = ddlIdent(n).stored;
    if (seen.has(key)) errors.push(`Column ${n} is listed twice.`);
    seen.set(key, true);
  });
  const pk = (spec.primaryKey || []).map((n) => String(n).trim()).filter(Boolean);
  pk.forEach((n) => { if (!seen.has(ddlIdent(n).stored)) errors.push(`Primary key column ${n} is not in the column list.`); });
  if (errors.length) throw new Error(errors.join('\n'));

  const t = ddlIdent(tname);
  const target = spec.owner ? `${qi(spec.owner)}.${t.sql}` : t.sql;
  // A column whose data_type already says PRIMARY KEY counts as the primary key.
  const inlinePk = cols.filter((c) => /\bPRIMARY\s+KEY\b/i.test(String(c.type))).map((c) => ddlIdent(c.name).stored);
  if (inlinePk.length > 1) throw new Error('Only one column can have PRIMARY KEY in its data type; use the Primary field for a multi-column key.');
  const pkSet = new Set(pk.map((n) => ddlIdent(n).stored).concat(inlinePk));
  // One key column: write it inline (id NUMBER ... PRIMARY KEY). Several: a table constraint.
  const inline = pkSet.size === 1;
  const lines = cols.map((c) => {
    const id = ddlIdent(c.name);
    const type = String(c.type).trim();
    let line = `  ${id.sql} ${type}`;
    const def = c.default === null || c.default === undefined ? '' : String(c.default).trim();
    if (def && def.toUpperCase() !== 'NULL') line += ` DEFAULT ${def}`;
    const isPk = pkSet.has(id.stored);
    if (c.nullable === false && !isPk && !/\bNOT\s+NULL\b/i.test(type)) line += ' NOT NULL';
    if (inline && isPk && !/\bPRIMARY\s+KEY\b/i.test(type)) line += ' PRIMARY KEY';
    return line;
  });
  if (pkSet.size > 1) {
    // Constraint names: keep within 30 characters so older (pre-12.2) databases accept them too.
    const base = t.stored.replace(/[^A-Za-z0-9_$#]/g, '_').toUpperCase();
    const cname = `${base.slice(0, 27)}_PK`.replace(/^[^A-Za-z]+/, 'T');
    const keyCols = cols.filter((c) => pkSet.has(ddlIdent(c.name).stored));
    const ordered = pk.map((n) => ddlIdent(n)).concat(keyCols.map((c) => ddlIdent(c.name)).filter((x) => !pk.some((n) => ddlIdent(n).stored === x.stored)));
    lines.push(`  CONSTRAINT ${qi(cname)} PRIMARY KEY (${ordered.map((x) => x.sql).join(', ')})`);
  }
  return { sql: `CREATE TABLE ${target} (\n${lines.join(',\n')}\n)`, table: t.stored };
}

// ---------- ALTER TABLE (Structure tab) ----------
function normType(t) {
  return String(t || '').toUpperCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').replace(/ BYTE\)/g, ')').trim();
}
function normDefault(d) {
  const v = d === null || d === undefined ? '' : String(d).trim();
  return v.toUpperCase() === 'NULL' ? '' : v;
}
function sqlText(v) {
  return "'" + String(v || '').replace(/'/g, "''") + "'";
}
function autoName(table, suffix) {
  const base = String(table).replace(/[^A-Za-z0-9_$#]/g, '_').toUpperCase().replace(/^[^A-Z]+/, 'T');
  return `${base.slice(0, 30 - suffix.length - 1)}_${suffix}`;
}

/**
 * plan = {
 *   owner, table,
 *   columns: [{ orig: {name,type,nullable,default,comment,identity} | null, name, type, nullable, default, comment, drop }],
 *   dropConstraints: [name], toggleConstraints: [{ name, enable }],
 *   addConstraints: [{ name, kind: 'PRIMARY KEY'|'UNIQUE'|'FOREIGN KEY'|'CHECK', columns: [name], refTable, refColumns: [name], onDelete, check }],
 *   dropIndexes: [name], addIndexes: [{ name, unique, columns: [name] }],
 *   tableComment: { from, to },
 * }
 * Returns [{ sql, label }] in a safe order. Each statement is DDL and commits on its own in Oracle.
 */
function buildAlterTable(plan) {
  const owner = plan.owner;
  const T = qname(owner, plan.table);
  const out = [];
  const errors = [];
  const add = (sql, label) => out.push({ sql, label });
  const cols = plan.columns || [];
  const original = new Set(cols.filter((c) => c.orig).map((c) => c.orig.name));
  // Refer to a column by its current name: stored names are quoted exactly, new names follow ddlIdent.
  const ref = (n) => {
    const name = String(n).trim();
    if (original.has(name) && !cols.some((c) => c.orig && c.orig.name === name && (c.drop || c.name.trim() !== name))) return qi(name);
    return ddlIdent(name).sql;
  };
  const refs = (list) => (list || []).map(ref).join(', ');

  // Validate
  const live = cols.filter((c) => !c.drop && (c.orig || String(c.name || '').trim() || String(c.type || '').trim()));
  const seen = new Set();
  live.forEach((c) => {
    const n = String(c.name || '').trim();
    if (!n) { errors.push('A column has no name.'); return; }
    if (!c.orig && !String(c.type || '').trim()) errors.push(`New column ${n} needs a data type.`);
    if (c.orig && !String(c.type || '').trim()) errors.push(`Column ${n} needs a data type.`);
    const key = c.orig && n === c.orig.name ? n : ddlIdent(n).stored;
    if (seen.has(key)) errors.push(`Column ${n} is listed twice.`);
    seen.add(key);
  });
  if (!live.length) errors.push('A table needs at least one column.');
  for (const k of plan.addConstraints || []) {
    if (k.kind === 'CHECK' ? !String(k.check || '').trim() : !(k.columns || []).length) errors.push(`${k.kind} constraint needs ${k.kind === 'CHECK' ? 'a condition' : 'at least one column'}.`);
    if (k.kind === 'FOREIGN KEY' && !String(k.refTable || '').trim()) errors.push('Foreign key needs a referenced table.');
  }
  for (const i of plan.addIndexes || []) if (!(i.columns || []).length) errors.push('An index needs at least one column.');
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));

  // 1. Drop indexes and constraints first (they may reference columns being dropped or changed).
  for (const name of plan.dropIndexes || []) add(`DROP INDEX ${qname(owner, name)}`, `Drop index ${name}`);
  for (const name of plan.dropConstraints || []) add(`ALTER TABLE ${T} DROP CONSTRAINT ${qi(name)}`, `Drop constraint ${name}`);
  // 2. Drop columns.
  for (const c of cols) if (c.orig && c.drop) add(`ALTER TABLE ${T} DROP COLUMN ${qi(c.orig.name)}`, `Drop column ${c.orig.name}`);
  // 3. Rename, then modify using the new name.
  for (const c of cols) {
    if (!c.orig || c.drop) continue;
    const newName = String(c.name).trim();
    if (newName !== c.orig.name) add(`ALTER TABLE ${T} RENAME COLUMN ${qi(c.orig.name)} TO ${ddlIdent(newName).sql}`, `Rename ${c.orig.name} to ${newName}`);
  }
  for (const c of cols) {
    if (!c.orig || c.drop) continue;
    const name = newRef(c);
    const parts = [];
    if (!c.orig.identity && normType(c.type) !== normType(c.orig.type)) parts.push(String(c.type).trim());
    if (!c.orig.identity && normDefault(c.default) !== normDefault(c.orig.default)) parts.push(`DEFAULT ${normDefault(c.default) || 'NULL'}`);
    if (!!c.nullable !== !!c.orig.nullable) parts.push(c.nullable ? 'NULL' : 'NOT NULL');
    if (parts.length) add(`ALTER TABLE ${T} MODIFY (${name} ${parts.join(' ')})`, `Change ${String(c.name).trim()}`);
  }
  // 4. Add columns.
  for (const c of cols) {
    if (c.orig || c.drop || !String(c.name || '').trim()) continue;
    let line = `${ddlIdent(c.name).sql} ${String(c.type).trim()}`;
    if (normDefault(c.default)) line += ` DEFAULT ${normDefault(c.default)}`;
    if (c.nullable === false) line += ' NOT NULL';
    add(`ALTER TABLE ${T} ADD (${line})`, `Add column ${String(c.name).trim()}`);
  }
  // 5. Constraints and indexes.
  const counters = { 'PRIMARY KEY': 0, UNIQUE: 0, 'FOREIGN KEY': 0, CHECK: 0 };
  const suffix = { 'PRIMARY KEY': 'PK', UNIQUE: 'UK', 'FOREIGN KEY': 'FK', CHECK: 'CK' };
  for (const k of plan.addConstraints || []) {
    counters[k.kind] = (counters[k.kind] || 0) + 1;
    const cname = String(k.name || '').trim() ? ddlIdent(k.name).sql : qi(autoName(plan.table, k.kind === 'PRIMARY KEY' ? 'PK' : `${suffix[k.kind]}${counters[k.kind]}`));
    let body;
    if (k.kind === 'CHECK') body = `CHECK (${String(k.check).trim()})`;
    else if (k.kind === 'FOREIGN KEY') {
      const rt = String(k.refTable).trim();
      const target = rt.includes('.') ? rt.split('.').map((p) => ddlIdent(p.replace(/"/g, '')).sql).join('.') : `${qi(owner)}.${ddlIdent(rt).sql}`;
      body = `FOREIGN KEY (${refs(k.columns)}) REFERENCES ${target}${(k.refColumns || []).length ? ` (${k.refColumns.map((n) => ddlIdent(n).sql).join(', ')})` : ''}`;
      if (k.onDelete === 'CASCADE') body += ' ON DELETE CASCADE';
      else if (k.onDelete === 'SET NULL') body += ' ON DELETE SET NULL';
    } else body = `${k.kind} (${refs(k.columns)})`;
    add(`ALTER TABLE ${T} ADD CONSTRAINT ${cname} ${body}`, `Add ${k.kind.toLowerCase()}`);
  }
  for (const t of plan.toggleConstraints || []) add(`ALTER TABLE ${T} ${t.enable ? 'ENABLE' : 'DISABLE'} CONSTRAINT ${qi(t.name)}`, `${t.enable ? 'Enable' : 'Disable'} ${t.name}`);
  let ix = 0;
  for (const i of plan.addIndexes || []) {
    ix++;
    const iname = String(i.name || '').trim() ? ddlIdent(i.name).sql : qi(autoName(plan.table, `IX${ix}`));
    add(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${qi(owner)}.${iname} ON ${T} (${refs(i.columns)})`, 'Create index');
  }
  // 6. Comments.
  if (plan.tableComment && String(plan.tableComment.to || '') !== String(plan.tableComment.from || '')) {
    add(`COMMENT ON TABLE ${T} IS ${sqlText(plan.tableComment.to)}`, 'Table comment');
  }
  for (const c of cols) {
    if (c.drop || !String(c.name || '').trim()) continue;
    const before = c.orig ? String(c.orig.comment || '') : '';
    const after = String(c.comment || '');
    if (after !== before) add(`COMMENT ON COLUMN ${T}.${newRef(c)} IS ${sqlText(after)}`, `Comment on ${String(c.name).trim()}`);
  }
  return out;

  function newRef(c) {
    const n = String(c.name).trim();
    return c.orig && n === c.orig.name ? qi(n) : ddlIdent(n).sql;
  }
}

function buildTruncate(owner, table) {
  return `TRUNCATE TABLE ${qname(owner, table)}`;
}
function buildDropTable(owner, table, { cascade = false, purge = false } = {}) {
  return `DROP TABLE ${qname(owner, table)}${cascade ? ' CASCADE CONSTRAINTS' : ''}${purge ? ' PURGE' : ''}`;
}

module.exports = { qi, qname, lit, kindOf, valueExpr, buildChanges, buildWhere, buildPageQuery, buildCreateTable, buildAlterTable, ddlIdent, normType, buildTruncate, buildDropTable };
