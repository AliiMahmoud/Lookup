// PostgreSQL DDL for the New table and Structure screens, truncate and drop. Names are written exactly as typed
// (plain lower-case names bare, anything else quoted). All steps of one change run in one transaction (ddl-run.js).
const { qi, qname } = require('./sqlgen');
const { trim, normDefault, checkCreate, checkAlter, columnChanges, autoName } = require('../common/table-plan');

const same = (a, b) => a === b;
const text = (v) => (trim(v) ? "'" + String(v).replace(/'/g, "''") + "'" : 'NULL');
/** "orders" or "other_schema.orders" (as typed in the foreign key dialog) → quoted name; default schema `owner`. */
const refTable = (owner, t) => { const p = trim(t).replace(/"/g, '').split('.'); return p.length > 1 ? qname(p[0], p[1]) : qname(owner, p[0]); };

function colDef(c, { pk = false } = {}) {
  let line = `${qi(c.name)} ${trim(c.type)}`;
  const def = normDefault(c.default);
  if (def) line += ` DEFAULT ${def}`;
  if (c.nullable === false && !pk && !/\bNOT\s+NULL\b/i.test(c.type)) line += ' NOT NULL';
  return line;
}

/** spec → { sql, table } */
function buildCreateTable(spec) {
  const { name, cols, pk, inlinePk } = checkCreate(spec, same);
  const lines = cols.map((c) => {
    const isPk = pk.some((n) => same(n, c.name));
    let line = `  ${colDef(c, { pk: isPk })}`;
    if (pk.length === 1 && isPk && !inlinePk) line += ' PRIMARY KEY';
    return line;
  });
  if (pk.length > 1) lines.push(`  CONSTRAINT ${qi(autoName(name, [], 'pkey'))} PRIMARY KEY (${pk.map(qi).join(', ')})`);
  return { sql: `CREATE TABLE ${qname(spec.owner, name)} (\n${lines.join(',\n')}\n)`, table: name };
}

/** plan → [{ sql, label }] in a safe order (drops first, then renames, changes, adds, constraints, indexes, comments). */
function buildAlterTable(plan) {
  checkAlter(plan, same);
  const T = qname(plan.owner, plan.table);
  const out = [];
  const add = (sql, label) => out.push({ sql, label });
  const cols = plan.columns || [];
  // A column is referred to by its new name once renames have run.
  const now = (n) => { const c = cols.find((x) => x.orig && x.orig.name === n && !x.drop); return qi(c ? trim(c.name) : trim(n)); };

  for (const name of plan.dropConstraints || []) add(`ALTER TABLE ${T} DROP CONSTRAINT ${qi(name)}`, `Drop constraint ${name}`);
  for (const name of plan.dropIndexes || []) add(`DROP INDEX ${qname(plan.owner, name)}`, `Drop index ${name}`);
  for (const c of cols) if (c.orig && c.drop) add(`ALTER TABLE ${T} DROP COLUMN ${qi(c.orig.name)}`, `Drop column ${c.orig.name}`);
  for (const c of cols) {
    const ch = columnChanges(c);
    if (ch.rename) add(`ALTER TABLE ${T} RENAME COLUMN ${qi(c.orig.name)} TO ${qi(trim(c.name))}`, `Rename ${c.orig.name} to ${trim(c.name)}`);
  }
  for (const c of cols) {
    const ch = columnChanges(c);
    const col = qi(trim(c.name));
    if (ch.type) add(`ALTER TABLE ${T} ALTER COLUMN ${col} TYPE ${trim(c.type)} USING ${col}::${trim(c.type)}`, `Change type of ${trim(c.name)}`);
    if (ch.default) add(normDefault(c.default) ? `ALTER TABLE ${T} ALTER COLUMN ${col} SET DEFAULT ${normDefault(c.default)}` : `ALTER TABLE ${T} ALTER COLUMN ${col} DROP DEFAULT`, `Default of ${trim(c.name)}`);
    if (ch.nullable) add(`ALTER TABLE ${T} ALTER COLUMN ${col} ${c.nullable ? 'DROP' : 'SET'} NOT NULL`, `${c.nullable ? 'Allow' : 'Forbid'} empty ${trim(c.name)}`);
  }
  for (const c of cols) if (!c.orig && !c.drop && trim(c.name)) add(`ALTER TABLE ${T} ADD COLUMN ${colDef(c)}`, `Add column ${trim(c.name)}`);
  const suffix = { 'PRIMARY KEY': 'pkey', UNIQUE: 'key', 'FOREIGN KEY': 'fkey', CHECK: 'check' };
  for (const k of plan.addConstraints || []) {
    const cname = qi(trim(k.name) || autoName(plan.table, k.kind === 'PRIMARY KEY' || k.kind === 'CHECK' ? [] : k.columns, suffix[k.kind]));
    let body;
    if (k.kind === 'CHECK') body = `CHECK (${trim(k.check)})`;
    else if (k.kind === 'FOREIGN KEY') {
      body = `FOREIGN KEY (${k.columns.map(now).join(', ')}) REFERENCES ${refTable(plan.owner, k.refTable)}${(k.refColumns || []).length ? ` (${k.refColumns.map(qi).join(', ')})` : ''}`;
      if (k.onDelete === 'CASCADE') body += ' ON DELETE CASCADE';
      else if (k.onDelete === 'SET NULL') body += ' ON DELETE SET NULL';
    } else body = `${k.kind} (${k.columns.map(now).join(', ')})`;
    add(`ALTER TABLE ${T} ADD CONSTRAINT ${cname} ${body}`, `Add ${k.kind.toLowerCase()}`);
  }
  for (const i of plan.addIndexes || []) {
    const iname = qi(trim(i.name) || autoName(plan.table, i.columns, 'idx'));
    add(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${iname} ON ${T} (${i.columns.map(now).join(', ')})`, 'Create index');
  }
  if (plan.tableComment && trim(plan.tableComment.to) !== trim(plan.tableComment.from)) add(`COMMENT ON TABLE ${T} IS ${text(plan.tableComment.to)}`, 'Table comment');
  for (const c of cols) {
    if (c.drop || !trim(c.name)) continue;
    if (c.orig ? columnChanges(c).comment : trim(c.comment)) add(`COMMENT ON COLUMN ${T}.${qi(trim(c.name))} IS ${text(c.comment)}`, `Comment on ${trim(c.name)}`);
  }
  return out;
}

const buildTruncate = (owner, table) => `TRUNCATE TABLE ${qname(owner, table)}`;
const buildDropTable = (owner, table, { cascade = false } = {}) => `DROP TABLE ${qname(owner, table)}${cascade ? ' CASCADE' : ''}`;

module.exports = { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable };
