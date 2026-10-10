// Grid edits by primary key, for engines without Oracle's ROWID (PostgreSQL, MySQL / MariaDB, SQLite). Engine-neutral:
// each engine passes how it quotes names, writes a parameter ($1 or ?) and shows a literal in the preview.
//
// A row's "rowid" in the grid is its key values as JSON (["42"] or ["2026", "A-7"]), so the grid works as it does for
// Oracle. Every UPDATE / DELETE must touch exactly one row, or nothing is saved (the row was changed or deleted by
// someone else, or its key was edited meanwhile). The edits run in one transaction; inside a transaction the user
// already has open (query tabs, auto-commit off), they run under a savepoint so a failure undoes only the edits.

/** The rowid of each row: its key values as JSON, or null when the key can't be matched (a binary only partly read). */
function keyRowids(columns, rows, keyCols) {
  if (!keyCols || !keyCols.length) return null;
  const idx = keyCols.map((k) => columns.findIndex((c) => c.name === k));
  if (idx.some((i) => i < 0)) return null;
  return rows.map((r) => {
    const key = idx.map((i) => r[i]);
    if (key.some((v) => v && typeof v === 'object' && v.$bin !== undefined && v.$bin.length / 2 < v.len)) return null;
    return JSON.stringify(key);
  });
}

/**
 * The statements for { updates, deletes, inserts }.
 * d = { qi(name), target (quoted table), param(n) → placeholder for the n-th value (1-based), literal(v, type),
 *       toParam(v, type) → the value sent to the driver }
 */
function buildKeyedChanges(d, columns, keyCols, changes) {
  const typeOf = Object.fromEntries(columns.map((c) => [c.name, c.type]));
  const check = (col) => { if (!(col in typeOf)) throw new Error(`Unknown column ${col}`); };
  const decode = (rowid) => {
    let key;
    try { key = JSON.parse(rowid); } catch { key = null; }
    if (!Array.isArray(key) || key.length !== keyCols.length) throw new Error('A changed row can\'t be matched by its primary key — reload the table and try again.');
    return key;
  };
  const where = (key, params, prev) => keyCols.map((k, i) => {
    const v = key[i];
    if (v === null) { prev.push(`${d.qi(k)} IS NULL`); return `${d.qi(k)} IS NULL`; }
    params.push(d.toParam(v, typeOf[k]));
    prev.push(`${d.qi(k)} = ${d.literal(v, typeOf[k])}`);
    return `${d.qi(k)} = ${d.param(params.length)}`;
  }).join(' AND ');
  const out = [];
  for (const del of changes.deletes || []) {
    const params = []; const prev = [];
    const w = where(decode(del.rowid), params, prev);
    out.push({ sql: `DELETE FROM ${d.target} WHERE ${w}`, params, one: true, preview: `DELETE FROM ${d.target} WHERE ${prev.join(' AND ')};` });
  }
  for (const u of changes.updates || []) {
    const cols = Object.keys(u.values || {});
    if (!cols.length) continue;
    const params = []; const sets = []; const prevSets = [];
    for (const col of cols) {
      check(col);
      const v = u.values[col];
      if (v === null) { sets.push(`${d.qi(col)} = NULL`); prevSets.push(`${d.qi(col)} = NULL`); continue; }
      params.push(d.toParam(v, typeOf[col]));
      sets.push(`${d.qi(col)} = ${d.param(params.length)}`);
      prevSets.push(`${d.qi(col)} = ${d.literal(v, typeOf[col])}`);
    }
    const prevWhere = [];
    const w = where(decode(u.rowid), params, prevWhere);
    out.push({ sql: `UPDATE ${d.target} SET ${sets.join(', ')} WHERE ${w}`, params, one: true, preview: `UPDATE ${d.target} SET ${prevSets.join(', ')} WHERE ${prevWhere.join(' AND ')};` });
  }
  for (const ins of changes.inserts || []) {
    const cols = Object.keys(ins.values || {}).filter((c) => ins.values[c] !== undefined);
    if (!cols.length) continue;
    cols.forEach(check);
    const params = cols.map((c) => d.toParam(ins.values[c], typeOf[c]));
    const list = cols.map(d.qi).join(', ');
    out.push({
      sql: `INSERT INTO ${d.target} (${list}) VALUES (${cols.map((_, i) => d.param(i + 1)).join(', ')})`,
      params,
      preview: `INSERT INTO ${d.target} (${list}) VALUES (${cols.map((c) => d.literal(ins.values[c], typeOf[c])).join(', ')});`,
    });
  }
  return out;
}

/**
 * Runs the statements as one unit and commits. tx = { inTx(), begin: 'BEGIN', afterBegin?(), affected(result),
 * control?(sql) for SAVEPOINT / RELEASE / ROLLBACK TO when the engine's execute adds savepoints of its own }.
 * The user was asked before committing an open transaction (it is committed with the edits).
 */
async function runKeyedChanges(s, stmts, tx) {
  if (!stmts.length) return { count: 0 };
  const control = tx.control || ((sql) => s.conn.execute(sql));
  const open = tx.inTx();
  if (open) await control('SAVEPOINT lookup_edits');
  else { await s.conn.execute(tx.begin); if (tx.afterBegin) tx.afterBegin(); }
  let done = 0;
  try {
    for (const st of stmts) {
      const r = await s.conn.execute(st.sql, st.params);
      const n = tx.affected(r);
      if (st.one && n !== 1) {
        throw new Error(n === 0
          ? 'The row was not found: someone else changed or deleted it (or its key) since it was loaded. Nothing was saved — reload the table and try again.'
          : `${n} rows matched instead of one. Nothing was saved.`);
      }
      done++;
    }
    if (open) await control('RELEASE SAVEPOINT lookup_edits');
    await s.conn.commit();
    return { count: stmts.length };
  } catch (e) {
    if (open) {
      await control('ROLLBACK TO SAVEPOINT lookup_edits').catch(() => {});
      await control('RELEASE SAVEPOINT lookup_edits').catch(() => {});
    } else {
      await s.conn.rollback().catch(() => {});
    }
    const failed = stmts[done];
    throw new Error(`${e.message}${failed ? `\n\nWhile running:\n${failed.preview}` : ''}`);
  }
}

module.exports = { keyRowids, buildKeyedChanges, runKeyedChanges };
