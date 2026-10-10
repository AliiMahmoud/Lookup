// MySQL / MariaDB DDL for the New table and Structure screens, truncate and drop. Names are back-quoted exactly as typed.
// MySQL commits each DDL statement on its own, so a Structure change runs step by step (ddl-run.js reports what ran).
// A changed column is restated in full (CHANGE COLUMN old new <type> NULL|NOT NULL DEFAULT … AUTO_INCREMENT COMMENT …),
// because MySQL drops whatever the new definition leaves out.
const { qi, qname } = require('./sqlgen');
const { trim, normDefault, checkCreate, checkAlter, columnChanges, autoName } = require('../common/table-plan');

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const text = (v) => "'" + String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
const refTable = (owner, t) => { const p = trim(t).replace(/`/g, '').split('.'); return p.length > 1 ? qname(p[0], p[1]) : qname(owner, p[0]); };

function colDef(c, { name = c.name, pk = false, identity = false } = {}) {
  let line = `${qi(trim(name))} ${trim(c.type)}`;
  if (c.nullable === false || pk) { if (!/\bNOT\s+NULL\b/i.test(c.type)) line += ' NOT NULL'; } else if (!/\bNULL\b/i.test(c.type)) line += ' NULL';
  const def = normDefault(c.default);
  if (def && !identity) line += ` DEFAULT ${def}`;
  if (identity && !/AUTO_INCREMENT/i.test(c.type)) line += ' AUTO_INCREMENT';
  if (trim(c.comment)) line += ` COMMENT ${text(c.comment)}`;
  return line;
}

/** spec → { sql, table } */
function buildCreateTable(spec) {
  const { name, cols, pk, inlinePk } = checkCreate(spec, same);
  const lines = cols.map((c) => {
    const isPk = pk.some((n) => same(n, c.name));
    let line = `  ${colDef({ ...c, comment: '' }, { pk: isPk })}`;
    if (pk.length === 1 && isPk && !inlinePk) line += ' PRIMARY KEY';
    return line;
  });
  if (pk.length > 1) lines.push(`  PRIMARY KEY (${pk.map(qi).join(', ')})`);
  return { sql: `CREATE TABLE ${qname(spec.owner, name)} (\n${lines.join(',\n')}\n)`, table: name };
}

/** plan + the table's current structure (constraint types) → [{ sql, label }]. */
function buildAlterTable(plan, current) {
  checkAlter(plan, same);
  const T = qname(plan.owner, plan.table);
  const out = [];
  const add = (sql, label) => out.push({ sql, label });
  const cols = plan.columns || [];
  const kindOf = new Map(((current && current.constraints) || []).map((k) => [k.name, k.type]));
  const now = (n) => { const c = cols.find((x) => x.orig && same(x.orig.name, n) && !x.drop); return qi(c ? trim(c.name) : trim(n)); };

  // Constraints first: a foreign key may need the index that is dropped next.
  for (const name of plan.dropConstraints || []) {
    const k = kindOf.get(name);
    if (k === 'PRIMARY KEY') add(`ALTER TABLE ${T} DROP PRIMARY KEY`, 'Drop primary key');
    else if (k === 'FOREIGN KEY') add(`ALTER TABLE ${T} DROP FOREIGN KEY ${qi(name)}`, `Drop foreign key ${name}`);
    else if (k === 'UNIQUE') add(`ALTER TABLE ${T} DROP INDEX ${qi(name)}`, `Drop unique ${name}`);
    else add(`ALTER TABLE ${T} DROP CONSTRAINT ${qi(name)}`, `Drop constraint ${name}`);
  }
  for (const name of plan.dropIndexes || []) add(`DROP INDEX ${qi(name)} ON ${T}`, `Drop index ${name}`);
  for (const c of cols) if (c.orig && c.drop) add(`ALTER TABLE ${T} DROP COLUMN ${qi(c.orig.name)}`, `Drop column ${c.orig.name}`);
  for (const c of cols) {
    const ch = columnChanges(c);
    if (!(ch.rename || ch.type || ch.nullable || ch.default || ch.comment)) continue;
    const def = colDef({ ...c, type: c.orig.identity ? c.orig.type : c.type }, { name: c.name, identity: !!c.orig.identity });
    add(`ALTER TABLE ${T} CHANGE COLUMN ${qi(c.orig.name)} ${def}`, ch.rename ? `Rename ${c.orig.name} to ${trim(c.name)}` : `Change ${trim(c.name)}`);
  }
  for (const c of cols) if (!c.orig && !c.drop && trim(c.name)) add(`ALTER TABLE ${T} ADD COLUMN ${colDef(c)}`, `Add column ${trim(c.name)}`);
  const suffix = { UNIQUE: 'uk', 'FOREIGN KEY': 'fk', CHECK: 'chk' };
  for (const k of plan.addConstraints || []) {
    if (k.kind === 'PRIMARY KEY') { add(`ALTER TABLE ${T} ADD PRIMARY KEY (${k.columns.map(now).join(', ')})`, 'Add primary key'); continue; }
    const cname = qi(trim(k.name) || autoName(plan.table, k.kind === 'CHECK' ? [] : k.columns, suffix[k.kind], 64));
    let body;
    if (k.kind === 'CHECK') body = `CHECK (${trim(k.check)})`;
    else if (k.kind === 'FOREIGN KEY') {
      body = `FOREIGN KEY (${k.columns.map(now).join(', ')}) REFERENCES ${refTable(plan.owner, k.refTable)}${(k.refColumns || []).length ? ` (${k.refColumns.map(qi).join(', ')})` : ''}`;
      if (k.onDelete === 'CASCADE') body += ' ON DELETE CASCADE';
      else if (k.onDelete === 'SET NULL') body += ' ON DELETE SET NULL';
    } else body = `UNIQUE (${k.columns.map(now).join(', ')})`;
    add(`ALTER TABLE ${T} ADD CONSTRAINT ${cname} ${body}`, `Add ${k.kind.toLowerCase()}`);
  }
  for (const i of plan.addIndexes || []) {
    const iname = qi(trim(i.name) || autoName(plan.table, i.columns, 'idx', 64));
    add(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${iname} ON ${T} (${i.columns.map(now).join(', ')})`, 'Create index');
  }
  if (plan.tableComment && trim(plan.tableComment.to) !== trim(plan.tableComment.from)) add(`ALTER TABLE ${T} COMMENT = ${text(plan.tableComment.to)}`, 'Table comment');
  return out;
}

const buildTruncate = (owner, table) => `TRUNCATE TABLE ${qname(owner, table)}`;
const buildDropTable = (owner, table) => `DROP TABLE ${qname(owner, table)}`;

module.exports = { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable };
