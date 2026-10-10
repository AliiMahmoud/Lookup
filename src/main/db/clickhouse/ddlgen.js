// ClickHouse DDL for the New table and Structure screens, truncate and drop. Names are back-quoted exactly as typed.
// ClickHouse has no transactions: a Structure change runs step by step and reports which steps ran (like MySQL).
// Differences the generator handles:
// - "Nullable" is part of the type: the Nullable switch wraps / unwraps the type (Nullable(T), LowCardinality(Nullable(T))).
// - The New table "Order by" columns are the sorting key (= primary key) of a MergeTree table; there are no UNIQUE or
//   foreign keys, only CHECK constraints, and indexes are data-skipping indexes with a TYPE and GRANULARITY.
// - A default may be written with its kind: DEFAULT (implied), MATERIALIZED, ALIAS or EPHEMERAL.
const { qi, qname, lit } = require('./sqlgen');
const { trim, normType, checkCreate, checkAlter } = require('../common/table-plan');

const same = (a, b) => a === b; // ClickHouse names are case-sensitive

/** Engines that take ORDER BY / PARTITION BY (the MergeTree family, Replicated… included). */
const isMergeTree = (engine) => /MergeTree\b/i.test(engine);
const COMPOSITE = /^(Array|Map|Tuple|Nested|JSON|Object|Variant|Dynamic)\b/i;

/** Type without Nullable: Nullable(T) → T, LowCardinality(Nullable(T)) → LowCardinality(T). */
function unwrap(type) {
  const t = trim(type);
  let m = /^Nullable\((.*)\)$/is.exec(t);
  if (m) return m[1].trim();
  m = /^LowCardinality\(\s*Nullable\((.*)\)\s*\)$/is.exec(t);
  if (m) return `LowCardinality(${m[1].trim()})`;
  return t;
}

/** The type to send for a column: the Nullable switch decides. */
function finalType(c) {
  const base = unwrap(c.type);
  if (!c.nullable) return base;
  if (COMPOSITE.test(base)) throw new Error(`Column ${trim(c.name)}: ${base} can't be Nullable in ClickHouse; set Nullable to NO.`);
  const lc = /^LowCardinality\((.*)\)$/is.exec(base);
  return lc ? `LowCardinality(Nullable(${lc[1].trim()}))` : `Nullable(${base})`;
}

/** DEFAULT clause: '' for none; MATERIALIZED / ALIAS / EPHEMERAL / DEFAULT kept as typed, plain text gets DEFAULT. */
function defaultClause(d) {
  const v = trim(d);
  if (!v || v.toUpperCase() === 'NULL') return '';
  return /^(DEFAULT|MATERIALIZED|ALIAS|EPHEMERAL)\b/i.test(v) ? v : `DEFAULT ${v}`;
}
const normDef = (d) => defaultClause(d).replace(/^DEFAULT\s+/i, '').replace(/\s+/g, ' ');

function colDef(c, { name = c.name, comment = true } = {}) {
  let line = `${qi(trim(name))} ${finalType(c)}`;
  const def = defaultClause(c.default);
  if (def) line += ` ${def}`;
  if (comment && trim(c.comment)) line += ` COMMENT ${lit(trim(c.comment))}`;
  return line;
}

/** spec = { owner, name, columns, primaryKey (sort key), engine, partitionBy } → { sql, table } */
function buildCreateTable(spec) {
  const { name, cols, pk } = checkCreate(spec, same);
  const engine = trim(spec.engine) || 'MergeTree';
  const errors = [];
  if (cols.some((c) => /\bPRIMARY\s+KEY\b/i.test(c.type))) errors.push('Put the key columns in the Order by field, not in the data type.');
  if (!isMergeTree(engine) && pk.length) errors.push(`The ${engine} engine has no sort key: clear the Order by field.`);
  if (!isMergeTree(engine) && trim(spec.partitionBy)) errors.push(`The ${engine} engine has no partitions: clear Partition by.`);
  const keyCols = pk.map((n) => cols.find((c) => same(c.name, n)));
  for (const c of keyCols) if (c.nullable) c.nullable = false; // key columns can't be Nullable (allow_nullable_key is off by default)
  if (errors.length) throw new Error(errors.join('\n'));
  const lines = cols.map((c) => `  ${colDef(c)}`);
  let sql = `CREATE TABLE ${qname(spec.owner, name)} (\n${lines.join(',\n')}\n)\nENGINE = ${engine}`;
  if (isMergeTree(engine)) {
    if (trim(spec.partitionBy)) sql += `\nPARTITION BY ${trim(spec.partitionBy)}`;
    sql += `\nORDER BY ${pk.length === 1 ? qi(pk[0]) : pk.length ? `(${pk.map(qi).join(', ')})` : 'tuple()'}`;
  }
  return { sql, table: name };
}

/** What changed on an existing column, with the type compared after the Nullable switch. */
function changes(c) {
  if (!c.orig || c.drop) return {};
  const type = normType(finalType(c)) !== normType(c.orig.type);
  return {
    rename: trim(c.name) !== c.orig.name,
    type,
    default: normDef(c.default) !== normDef(c.orig.default),
    comment: trim(c.comment) !== trim(c.orig.comment),
  };
}

/** plan + the table's current structure (constraint and index names) → [{ sql, label }]. */
function buildAlterTable(plan, current) {
  checkAlter(plan, same);
  const T = qname(plan.owner, plan.table);
  const out = [];
  const add = (sql, label) => out.push({ sql, label });
  const cols = plan.columns || [];
  const fixed = new Set(['PRIMARY KEY', 'ORDER BY', 'PARTITION BY', 'SAMPLE BY']);
  const kindOf = new Map(((current && current.constraints) || []).map((k) => [k.name, k.type]));
  const taken = new Set([...kindOf.keys(), ...((current && current.indexes) || []).map((i) => i.name)]);
  const now = (n) => { const c = cols.find((x) => x.orig && same(x.orig.name, n) && !x.drop); return qi(c ? trim(c.name) : trim(n)); };
  const fresh = (base) => { let n = base; for (let i = 2; taken.has(n); i++) n = `${base}${i}`; taken.add(n); return n; };

  for (const c of cols) if (!c.drop) finalType(c); // Nullable problems first, all at once with the plan checks above
  for (const name of plan.dropConstraints || []) {
    if (fixed.has(kindOf.get(name))) throw new Error(`The ${name} of a ClickHouse table is part of its engine settings; change it with SQL (ALTER TABLE … MODIFY ORDER BY) or recreate the table.`);
    add(`ALTER TABLE ${T} DROP CONSTRAINT ${qi(name)}`, `Drop constraint ${name}`);
  }
  for (const name of plan.dropIndexes || []) add(`ALTER TABLE ${T} DROP INDEX ${qi(name)}`, `Drop index ${name}`);
  for (const c of cols) if (c.orig && c.drop) add(`ALTER TABLE ${T} DROP COLUMN ${qi(c.orig.name)}`, `Drop column ${c.orig.name}`);
  for (const c of cols) {
    const ch = changes(c);
    if (ch.rename) add(`ALTER TABLE ${T} RENAME COLUMN ${qi(c.orig.name)} TO ${qi(trim(c.name))}`, `Rename ${c.orig.name} to ${trim(c.name)}`);
    const name = qi(trim(c.name));
    if (ch.type || (ch.default && defaultClause(c.default))) {
      const def = defaultClause(c.default);
      add(`ALTER TABLE ${T} MODIFY COLUMN ${name} ${finalType(c)}${def ? ` ${def}` : ''}`, `Change ${trim(c.name)}`);
    }
    if (ch.default && !defaultClause(c.default)) add(`ALTER TABLE ${T} MODIFY COLUMN ${name} REMOVE DEFAULT`, `Remove default of ${trim(c.name)}`);
    if (ch.comment) add(`ALTER TABLE ${T} COMMENT COLUMN ${name} ${lit(trim(c.comment))}`, `Comment on ${trim(c.name)}`);
  }
  for (const c of cols) if (!c.orig && !c.drop && trim(c.name)) add(`ALTER TABLE ${T} ADD COLUMN ${colDef(c)}`, `Add column ${trim(c.name)}`);
  for (const k of plan.addConstraints || []) {
    if (k.kind !== 'CHECK') throw new Error(`ClickHouse has no ${k.kind.toLowerCase()} constraints; only CHECK.`);
    const cname = trim(k.name) || fresh(`${plan.table}_chk`);
    add(`ALTER TABLE ${T} ADD CONSTRAINT ${qi(cname)} CHECK ${trim(k.check)}`, `Add check ${cname}`);
  }
  for (const i of plan.addIndexes || []) {
    const iname = trim(i.name) || fresh(`${plan.table}_${i.columns.join('_')}_idx`.replace(/[^A-Za-z0-9_]+/g, '_'));
    const expr = i.columns.length === 1 ? now(i.columns[0]) : `(${i.columns.map(now).join(', ')})`;
    const type = trim(i.type) || 'minmax';
    const gran = Math.max(1, Math.floor(Number(i.granularity) || 1));
    add(`ALTER TABLE ${T} ADD INDEX ${qi(iname)} ${expr} TYPE ${type} GRANULARITY ${gran}`, `Add index ${iname}`);
    add(`ALTER TABLE ${T} MATERIALIZE INDEX ${qi(iname)}`, `Build index ${iname} for existing rows`);
  }
  if (plan.tableComment && trim(plan.tableComment.to) !== trim(plan.tableComment.from)) add(`ALTER TABLE ${T} MODIFY COMMENT ${lit(trim(plan.tableComment.to))}`, 'Table comment');
  return out;
}

const buildTruncate = (owner, table) => `TRUNCATE TABLE ${qname(owner, table)}`;
const buildDropTable = (owner, table) => `DROP TABLE ${qname(owner, table)}`;

module.exports = { buildCreateTable, buildAlterTable, buildTruncate, buildDropTable, unwrap, finalType };
