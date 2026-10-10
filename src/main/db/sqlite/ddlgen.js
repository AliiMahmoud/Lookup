// SQLite DDL for the New table and Structure screens, truncate and drop. Names are double-quoted exactly as typed.
//
// SQLite's ALTER TABLE can rename, add and drop columns; anything else (a column's type, NOT NULL or default, adding or
// dropping a constraint) needs the table rebuilt, the way SQLite's documentation describes: create the new table, copy
// the rows, drop the old one, rename the new one, then create its indexes and triggers again. Everything runs in one
// transaction (ddl-run.js), so a failure leaves the table as it was. Tables using things a rebuild can't carry over
// (COLLATE, generated columns, ON CONFLICT, DEFERRABLE) are refused with a message instead of being changed.
const { qi, qname } = require('./sqlgen');
const { trim, normDefault, normType, checkCreate, checkAlter, columnChanges } = require('../common/table-plan');
const { structure, tableSql } = require('./metadata');

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const isIntegerPk = (type) => /^INTEGER$/i.test(trim(type));

function colDef(c, { inlinePk = '' } = {}) {
  let line = `${qi(trim(c.name))} ${trim(c.type)}`.trim();
  if (inlinePk) line += ` ${inlinePk}`;
  if (c.nullable === false && !inlinePk && !/\bNOT\s+NULL\b/i.test(c.type)) line += ' NOT NULL';
  const def = normDefault(c.default);
  if (def) line += ` DEFAULT ${def}`;
  return line;
}

/** spec → { sql, table } */
function buildCreateTable(spec) {
  const { name, cols, pk, inlinePk } = checkCreate(spec, same);
  const lines = cols.map((c) => {
    const isPk = pk.some((n) => same(n, c.name));
    return `  ${colDef(c, { inlinePk: pk.length === 1 && isPk && !inlinePk ? 'PRIMARY KEY' : '' })}`;
  });
  if (pk.length > 1) lines.push(`  PRIMARY KEY (${pk.map(qi).join(', ')})`);
  return { sql: `CREATE TABLE ${qname(spec.owner, name)} (\n${lines.join(',\n')}\n)`, table: name };
}

// A default ADD COLUMN accepts: a constant (not CURRENT_TIME…, not an expression in parentheses).
const constantDefault = (d) => { const v = normDefault(d); return !v || !/^\(|^current_(time|date|timestamp)$/i.test(v); };

/** The table as SQLite has it: columns, keys, unique sets, foreign keys, checks, options (WITHOUT ROWID, STRICT). */
async function readTable(s, owner, table) {
  const st = await structure(s, owner, table);
  const create = await tableSql(s, owner, table);
  const fk = await s.conn.execute(`SELECT id, "table", "from", "to", on_update, on_delete, "match" FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq`, [table, owner]);
  const fks = new Map();
  for (const [id, t, from, to, onUpdate, onDelete, match] of fk.rows) {
    if (!fks.has(id)) fks.set(id, { name: `foreign key ${Number(id) + 1}`, table: t, from: [], to: [], onUpdate, onDelete, match });
    fks.get(id).from.push(from);
    if (to !== null) fks.get(id).to.push(to);
  }
  const close = create.lastIndexOf(')');
  const options = close >= 0 ? create.slice(close + 1).replace(/;\s*$/, '').trim() : '';
  return { st, create, fks: [...fks.values()], options };
}

/**
 * plan → steps. Async: whether a rebuild is needed, and what it keeps, depends on the table as it is now.
 * Each step is { sql, label } or { sql (preview), label, run(s) }.
 */
async function buildAlterTable(s, plan) {
  checkAlter(plan, same);
  if (plan.tableComment && trim(plan.tableComment.to) !== trim(plan.tableComment.from)) throw new Error('SQLite tables have no comments.');
  const cols = plan.columns || [];
  if (cols.some((c) => !c.drop && trim(c.comment) !== trim(c.orig ? c.orig.comment : ''))) throw new Error('SQLite columns have no comments.');
  const owner = plan.owner;
  const T = qname(owner, plan.table);
  const out = [];
  const add = (sql, label, run) => out.push(run ? { sql, label, run } : { sql, label });
  const cur = await readTable(s, owner, plan.table);
  const renamed = (n) => { const c = cols.find((x) => x.orig && same(x.orig.name, n)); return c && !c.drop ? trim(c.name) : n; };
  const dropped = new Set(cols.filter((c) => c.orig && c.drop).map((c) => c.orig.name.toLowerCase()));

  const changed = cols.some((c) => { const ch = columnChanges(c); return ch.type || ch.nullable || ch.default; });
  const newCols = cols.filter((c) => !c.orig && !c.drop && trim(c.name));
  const rebuild = changed || (plan.dropConstraints || []).length || (plan.addConstraints || []).length
    || newCols.some((c) => !constantDefault(c.default) || (c.nullable === false && !normDefault(c.default)));

  // 1. Indexes being dropped, then renames (SQLite rewrites indexes, triggers and views that use the column).
  for (const name of plan.dropIndexes || []) add(`DROP INDEX ${qname(owner, name)}`, `Drop index ${name}`);
  for (const c of cols) if (columnChanges(c).rename) add(`ALTER TABLE ${T} RENAME COLUMN ${qi(c.orig.name)} TO ${qi(trim(c.name))}`, `Rename ${c.orig.name} to ${trim(c.name)}`);

  if (!rebuild) {
    for (const c of cols) if (c.orig && c.drop) add(`ALTER TABLE ${T} DROP COLUMN ${qi(c.orig.name)}`, `Drop column ${c.orig.name}`);
    for (const c of newCols) add(`ALTER TABLE ${T} ADD COLUMN ${colDef(c)}`, `Add column ${trim(c.name)}`);
  } else {
    const word = (/\b(COLLATE|GENERATED|ON\s+CONFLICT|DEFERRABLE)\b/i.exec(cur.create) || [])[1] || (/\bAS\s*\(/i.test(cur.create) ? 'generated columns' : null);
    if (word) throw new Error(`This change needs the table rebuilt, and it uses ${word.toUpperCase()}, which a rebuild can't keep. Change it with SQL in a query tab.`);
    if (/^temp$/i.test(owner)) throw new Error('Temporary tables can\'t be rebuilt; change them with SQL.');
    const droppedCons = new Set(plan.dropConstraints || []);
    // Columns of the new table, in order: kept ones (changed as asked), then added ones.
    const kept = cols.filter((c) => c.orig && !c.drop);
    const pkCons = cur.st.constraints.find((k) => k.type === 'PRIMARY KEY');
    let pk = pkCons && !droppedCons.has(pkCons.name) ? pkCons.columns.split(', ').map(renamed) : [];
    const addPk = (plan.addConstraints || []).find((k) => k.kind === 'PRIMARY KEY');
    if (addPk) { if (pk.length) throw new Error('The table already has a primary key; drop it first.'); pk = addPk.columns.map(renamed); }
    const uniques = cur.st.constraints.filter((k) => k.type === 'UNIQUE' && !droppedCons.has(k.name)).map((k) => k.columns.split(', ').map(renamed))
      .concat((plan.addConstraints || []).filter((k) => k.kind === 'UNIQUE').map((k) => k.columns.map(renamed)));
    const fks = cur.fks.filter((f) => !droppedCons.has(f.name)).map((f) => ({ ...f, from: f.from.map(renamed) }))
      .concat((plan.addConstraints || []).filter((k) => k.kind === 'FOREIGN KEY').map((k) => ({
        table: trim(k.refTable).split('.').pop().replace(/"/g, ''), from: k.columns.map(renamed), to: k.refColumns || [], onDelete: k.onDelete || 'NO ACTION', onUpdate: 'NO ACTION', match: 'NONE',
      })));
    const checks = cur.st.constraints.filter((k) => k.type === 'CHECK' && !droppedCons.has(k.name)).map((k) => ({ name: k.generated ? '' : k.name, expr: k.detail }))
      .concat((plan.addConstraints || []).filter((k) => k.kind === 'CHECK').map((k) => ({ name: trim(k.name), expr: trim(k.check) })));
    // Nothing kept may still use a dropped column.
    const uses = (list) => list.some((n) => dropped.has(String(n).toLowerCase()));
    const problems = [];
    if (uses(pk)) problems.push('The primary key uses a column being dropped; drop the primary key too.');
    uniques.forEach((u) => { if (uses(u)) problems.push(`A unique constraint (${u.join(', ')}) uses a column being dropped; drop it too.`); });
    fks.forEach((f) => { if (uses(f.from)) problems.push(`A foreign key (${f.from.join(', ')}) uses a column being dropped; drop it too.`); });
    checks.forEach((k) => { for (const d of dropped) if (new RegExp(`(^|[^\\w"])"?${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?([^\\w"]|$)`, 'i').test(k.expr)) problems.push(`The check ${k.name || k.expr} uses column ${d}; drop it too.`); });
    for (const i of cur.st.indexes) {
      if (i.constraint || (plan.dropIndexes || []).includes(i.name)) continue;
      if (uses(i.columns.split(', ').map((x) => x.replace(/ DESC$/, '')))) problems.push(`Index ${i.name} uses a column being dropped; drop the index too.`);
    }
    if (problems.length) throw new Error([...new Set(problems)].join('\n'));

    const pkLower = pk.map((n) => n.toLowerCase());
    const autoinc = /\bAUTOINCREMENT\b/i.test(cur.create);
    const all = [...kept, ...newCols];
    const lines = all.map((c) => {
      const single = pk.length === 1 && pkLower[0] === trim(c.name).toLowerCase();
      const type = c.orig && c.orig.identity ? c.orig.type : c.type;
      const inline = single && isIntegerPk(type) ? `PRIMARY KEY${autoinc ? ' AUTOINCREMENT' : ''}` : '';
      return `  ${colDef({ ...c, type, default: c.orig && c.orig.identity ? '' : c.default }, { inlinePk: inline })}`;
    });
    const inlined = pk.length === 1 && lines.some((l) => /PRIMARY KEY/.test(l));
    if (pk.length && !inlined) lines.push(`  PRIMARY KEY (${pk.map(qi).join(', ')})`);
    uniques.forEach((u) => lines.push(`  UNIQUE (${u.map(qi).join(', ')})`));
    fks.forEach((f) => {
      let line = `  FOREIGN KEY (${f.from.map(qi).join(', ')}) REFERENCES ${qi(f.table)}${f.to.length ? ` (${f.to.map(qi).join(', ')})` : ''}`;
      if (f.onUpdate && f.onUpdate !== 'NO ACTION') line += ` ON UPDATE ${f.onUpdate}`;
      if (f.onDelete && f.onDelete !== 'NO ACTION') line += ` ON DELETE ${f.onDelete}`;
      lines.push(line);
    });
    checks.forEach((k) => lines.push(`  ${k.name ? `CONSTRAINT ${qi(k.name)} ` : ''}CHECK (${k.expr})`));
    const tmp = `lookup_new_${plan.table}`;
    const createNew = `CREATE TABLE ${qname(owner, tmp)} (\n${lines.join(',\n')}\n)${cur.options ? ' ' + cur.options : ''}`;
    const keptNames = kept.map((c) => qi(trim(c.name))).join(', ');
    const copy = `INSERT INTO ${qname(owner, tmp)} (${keptNames}) SELECT ${keptNames} FROM ${T}`;
    const others = cur.st.indexes.filter((i) => !i.constraint && !(plan.dropIndexes || []).includes(i.name)).length;
    const preview = [createNew, copy, `DROP TABLE ${T}`, `ALTER TABLE ${qname(owner, tmp)} RENAME TO ${qi(plan.table)}`,
      `-- then the table's own indexes (${others}) and triggers are created again as they are, and foreign keys are checked`].join(';\n');
    add(preview, `Rebuild ${plan.table}`, async (sx) => {
      // Read indexes and triggers now: earlier steps (renames, dropped indexes) changed them.
      const objs = await sx.conn.execute(`SELECT type, sql FROM ${qi(owner)}.sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`, [plan.table]);
      await sx.conn.execute(createNew);
      await sx.conn.execute(copy);
      await sx.conn.execute(`DROP TABLE ${T}`);
      // Views and other tables' references to the old table must not be rewritten: they should point at the new one.
      await sx.conn.execute('PRAGMA legacy_alter_table = ON');
      try { await sx.conn.execute(`ALTER TABLE ${qname(owner, tmp)} RENAME TO ${qi(plan.table)}`); } finally { await sx.conn.execute('PRAGMA legacy_alter_table = OFF'); }
      for (const [, sql] of objs.rows) await sx.conn.execute(owner === 'main' ? sql : withSchema(sql, owner));
      const bad = await sx.conn.execute(`SELECT count(*) FROM pragma_foreign_key_check(?, ?)`, [plan.table, owner]);
      if (Number(bad.rows[0][0])) throw new Error(`${bad.rows[0][0]} row(s) would break this table's foreign keys. Nothing was changed.`);
    });
  }
  for (const i of plan.addIndexes || []) {
    const iname = trim(i.name) || `${plan.table}_${i.columns.join('_')}_idx`.replace(/[^A-Za-z0-9_]+/g, '_');
    add(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${qname(owner, iname)} ON ${qi(plan.table)} (${i.columns.map((n) => qi(renamed(n))).join(', ')})`, 'Create index');
  }
  return out;
}

/** Index / trigger SQL as stored (no schema) → created in an attached schema. */
function withSchema(sql, owner) {
  return sql
    .replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?)/i, `$1${qi(owner)}.`)
    .replace(/^(\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?)/i, `$1${qi(owner)}.`);
}

const buildTruncate = (owner, table) => `DELETE FROM ${qname(owner, table)}`;
const buildDropTable = (owner, table) => `DROP TABLE ${qname(owner, table)}`;

module.exports = { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable, normType };
