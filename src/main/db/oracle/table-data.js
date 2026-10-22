// Oracle Table Data view: paged rows, and previewing / applying grid edits (by ROWID) in one transaction.
const { qname, buildChanges, buildPageQuery } = require('./sqlgen');
const { columnsFromMeta, serializeRows } = require('./values');
const { tableColumns, primaryKey } = require('./metadata');

async function tableData(s, { owner, name, type, offset = 0, limit = 300, filters = [], sort = null, withCount = true }) {
  const cols = await tableColumns(s, owner, name);
  const editable = type === 'TABLE';
  const { sql, binds, where, countBinds } = buildPageQuery({ owner, name, editable, cols, filters, sort, offset, limit });
  const t0 = Date.now();
  const r = await s.conn.execute(sql, binds);
  const ms = Date.now() - t0;
  let total = null;
  if (withCount) {
    try {
      const c = await s.conn.execute(`SELECT COUNT(*) FROM ${qname(owner, name)} t${where}`, countBinds);
      total = Number(c.rows[0][0]);
    } catch { total = null; }
  }
  const meta = columnsFromMeta(r.metaData);
  const rows = serializeRows(r.rows, r.metaData);
  let rowids = null;
  if (editable) {
    rowids = rows.map((x) => x[0]);
    meta.shift();
    rows.forEach((x) => x.shift());
  }
  // Prefer dictionary types (e.g. VARCHAR2(50)) for display.
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  meta.forEach((m) => { if (byName[m.name]) { m.fullType = byName[m.name].fullType; m.nullable = byName[m.name].nullable; } });
  // Rows are matched by ROWID; the key only tells Duplicate row which values to leave empty.
  const keyColumns = editable ? await primaryKey(s, owner, name) : [];
  return { columns: meta, rows, rowids, total, editable, keyColumns, ms, sql };
}

async function previewChanges(s, { owner, name, changes }) {
  const cols = await tableColumns(s, owner, name);
  return buildChanges(owner, name, cols, changes).map((x) => x.preview).join('\n');
}

async function applyChanges(s, { owner, name, changes }) {
  const cols = await tableColumns(s, owner, name);
  const stmts = buildChanges(owner, name, cols, changes);
  let done = 0;
  try {
    for (const st of stmts) {
      await s.conn.execute(st.sql, st.binds, { autoCommit: false });
      done++;
    }
    await s.conn.commit();
    return { count: stmts.length };
  } catch (e) {
    await s.conn.rollback().catch(() => {});
    const failed = stmts[done];
    const err = new Error(`${e.message}${failed ? `\n\nWhile running:\n${failed.preview}` : ''}`);
    throw err;
  }
}

module.exports = { tableData, previewChanges, applyChanges };
