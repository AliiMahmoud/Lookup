// Checks shared by the New table and Structure screens for engines with their own DDL generator (PostgreSQL, MySQL /
// MariaDB, SQLite): names given, nothing listed twice, types present. Engine-neutral: `same(a, b)` says whether two
// names are the same column on that engine (case-insensitive in MySQL and SQLite, exact in PostgreSQL).

const trim = (v) => String(v === null || v === undefined ? '' : v).trim();

/** A default as typed: '' for none (empty or NULL). */
const normDefault = (d) => { const v = trim(d); return v.toUpperCase() === 'NULL' ? '' : v; };

/** Type text compared loosely: case, spaces around ( , ) and doubled spaces don't count as changes. */
const normType = (t) => trim(t).toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');

/** spec = { owner, name, columns: [{ name, type, nullable, default }], primaryKey: [names] } → { name, cols, pk } or throws. */
function checkCreate(spec, same) {
  const errors = [];
  const name = trim(spec.name);
  if (!name) errors.push('Give the table a name.');
  const cols = (spec.columns || []).filter((c) => trim(c.name) || trim(c.type)).map((c) => ({ ...c, name: trim(c.name), type: trim(c.type) }));
  if (!cols.length) errors.push('Add at least one column.');
  cols.forEach((c, i) => {
    if (!c.name) { errors.push(`Column ${i + 1} has a type but no name.`); return; }
    if (!c.type) errors.push(`Column ${c.name} needs a data type.`);
    if (cols.slice(0, i).some((x) => x.name && same(x.name, c.name))) errors.push(`Column ${c.name} is listed twice.`);
  });
  const pk = (spec.primaryKey || []).map(trim).filter(Boolean);
  pk.forEach((n) => { if (!cols.some((c) => same(c.name, n))) errors.push(`Primary key column ${n} is not in the column list.`); });
  // A column whose type already says PRIMARY KEY counts as the key.
  const inline = cols.filter((c) => /\bPRIMARY\s+KEY\b/i.test(c.type));
  if (inline.length > 1) errors.push('Only one column can have PRIMARY KEY in its data type; use the Primary field for a multi-column key.');
  if (inline.length && pk.some((n) => !same(n, inline[0].name))) errors.push(`${inline[0].name} has PRIMARY KEY in its type; put the other key columns there too, or use only the Primary field.`);
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));
  const keyCols = inline.length ? [inline[0].name] : pk.map((n) => cols.find((c) => same(c.name, n)).name);
  return { name, cols, pk: keyCols, inlinePk: !!inline.length };
}

/**
 * plan = { owner, table, columns: [{ orig, name, type, nullable, default, comment, drop }], dropConstraints, addConstraints,
 *          dropIndexes, addIndexes, tableComment } (see oracle/sqlgen.js buildAlterTable). Throws with every problem at once.
 */
function checkAlter(plan, same) {
  const errors = [];
  const cols = plan.columns || [];
  const live = cols.filter((c) => !c.drop && (c.orig || trim(c.name) || trim(c.type)));
  live.forEach((c, i) => {
    const n = trim(c.name);
    if (!n) { errors.push('A column has no name.'); return; }
    if (!trim(c.type)) errors.push(c.orig ? `Column ${n} needs a data type.` : `New column ${n} needs a data type.`);
    if (live.slice(0, i).some((x) => trim(x.name) && same(trim(x.name), n))) errors.push(`Column ${n} is listed twice.`);
  });
  if (!live.length) errors.push('A table needs at least one column.');
  for (const k of plan.addConstraints || []) {
    if (k.kind === 'CHECK' ? !trim(k.check) : !(k.columns || []).length) errors.push(`${k.kind} constraint needs ${k.kind === 'CHECK' ? 'a condition' : 'at least one column'}.`);
    if (k.kind === 'FOREIGN KEY' && !trim(k.refTable)) errors.push('Foreign key needs a referenced table.');
  }
  for (const i of plan.addIndexes || []) if (!(i.columns || []).length) errors.push('An index needs at least one column.');
  if ((plan.toggleConstraints || []).length) errors.push('Constraints can\'t be disabled on this database; drop them instead.');
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));
}

/** What changed on an existing column: { rename, type, nullable, default, comment } (booleans). */
function columnChanges(c) {
  if (!c.orig || c.drop) return {};
  return {
    rename: trim(c.name) !== c.orig.name,
    type: !c.orig.identity && normType(c.type) !== normType(c.orig.type),
    nullable: !!c.nullable !== !!c.orig.nullable,
    default: !c.orig.identity && normDefault(c.default) !== normDefault(c.orig.default),
    comment: trim(c.comment) !== trim(c.orig.comment),
  };
}

/** Automatic names: <table>_<cols>_<suffix>, shortened to `max` characters. */
function autoName(table, cols, suffix, max = 63) {
  const base = [table, ...(cols || [])].join('_').replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_');
  return `${base.slice(0, max - suffix.length - 1)}_${suffix}`;
}

module.exports = { trim, normDefault, normType, checkCreate, checkAlter, columnChanges, autoName };
