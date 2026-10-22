// Copy as SQL INSERT (grid) and Export → Copy to clipboard (SQL INSERT), on every SQL engine:
// the generated text names every column, runs as written (split the way the editor splits it) and
// puts back exactly the rows it was made from.
// Run: node test/copy-sql-test.js [oracle|postgres|mysql|sqlite|clickhouse ...]
//   (SQLite needs node:sqlite: Node 22.5+, or ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron test/copy-sql-test.js)
// Servers from test/docker (docker compose -f test/docker/docker-compose.yml up -d). An engine whose
// server does not answer is skipped.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/main/db');
const { split } = require('../src/shared/sqlsplit');

const { ENGINES, NAMES } = require('./fixtures/copy-engines');

let W = 900;
let passed = 0;
const failures = [];

/** Runs statements; fails on the first error. */
async function exec(w, sqls) {
  const r = await db.run(w, sqls, { maxRows: 0 });
  const err = r.find((x) => x.kind === 'error');
  if (err) throw new Error(`${err.message}\n    in: ${err.sql.slice(0, 300)}`);
  return r;
}

/** Every INSERT names every column, once, in the table's order; one INSERT per row. */
function checkInserts(text, target, colNames, quote, nRows) {
  const inserts = text.split('\n').filter((l) => l.startsWith('INSERT INTO '));
  assert.strictEqual(inserts.length, nRows, `${inserts.length} INSERT statements for ${nRows} rows`);
  const head = `INSERT INTO ${target} (${colNames.map(quote).join(', ')}) VALUES (`;
  for (const l of inserts) assert.ok(l.startsWith(head), `INSERT does not list every column:\n    ${l.slice(0, 200)}\n    expected ${head}`);
}

async function runEngine(id) {
  const e = ENGINES[id];
  const w = ++W;
  let tmpDir = null;
  if (id === 'sqlite') {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-copy-'));
    e.cfg = { engine: 'sqlite', file: path.join(tmpDir, 'copy.db'), autoCommit: true };
    fs.writeFileSync(e.cfg.file, '');
  }
  try { await db.connect(w, e.cfg); } catch (err) { console.log(`${id}: skipped (${err.message.split('\n')[0]})`); return; }
  console.log(id);
  const t = async (name, fn) => {
    try { await fn(); passed++; console.log('  ok  ', name); } catch (err) { failures.push(`${id}: ${name}`); console.log('  FAIL', name, '\n   ', err.message); }
  };
  const dialect = db.dialectOf(w);
  const qtarget = `${quoteOwner(id, e.owner)}.${quoteOwner(id, e.dst)}`;
  const splitText = (text) => split(text, dialect.splitDialect).map((s) => s.text);
  const read = async (table) => (await db.tableData(w, { owner: e.owner, name: table, type: 'TABLE', offset: 0, limit: 500, sort: { col: id === 'oracle' ? 'ID' : 'id', dir: 'asc' } })).rows;
  try {
    if (e.setup) await exec(w, e.setup);
    if (e.drop) await exec(w, [e.drop(e.src), e.drop(e.dst)]);
    await exec(w, [e.create(e.src), e.create(e.dst), ...e.rows]);
    const src = await db.tableData(w, { owner: e.owner, name: e.src, type: 'TABLE', offset: 0, limit: 500, sort: { col: id === 'oracle' ? 'ID' : 'id', dir: 'asc' } });
    const columns = src.columns.map((c) => ({ name: c.name, type: c.type })); // what the grid and the export dialog pass
    const colNames = columns.map((c) => c.name);
    assert.strictEqual(src.rows.length, 3);
    assert.deepStrictEqual(src.rows.map((r) => r[colNames.findIndex((n) => /^name$/i.test(n))]), NAMES);

    /** Runs the generated text into the empty copy, with auto-commit on and off (Lookup's default),
     *  and compares the copy with the source. */
    const roundTrip = async (text) => {
      const stmts = splitText(text);
      // Run exactly as pasted into Lookup's editor (Oracle's SET DEFINE OFF line included).
      const runnable = stmts;
      for (const auto of id === 'clickhouse' ? [true] : [true, false]) {
        if (id !== 'clickhouse') await db.setAutoCommit(w, auto);
        await exec(w, [e.truncate(e.dst)]);
        if (!auto) await db.commit(w);
        try {
          await exec(w, runnable);
        } catch (err) { throw new Error(`auto-commit ${auto ? 'on' : 'off'}: ${err.message}`); }
        if (!auto) await db.commit(w);
        assert.deepStrictEqual(await read(e.dst), src.rows, `auto-commit ${auto ? 'on' : 'off'}`);
      }
      if (id !== 'clickhouse') await db.setAutoCommit(w, true);
    };

    await t('Copy as SQL INSERT: one INSERT per row, every column, runs and copies the rows exactly', async () => {
      const text = await db.sqlInserts(w, qtarget, columns, src.rows);
      checkInserts(text, qtarget, colNames, dialect.qi, 3);
      await roundTrip(text);
    });

    await t('Copy as SQL INSERT: one selected row', async () => {
      const text = await db.sqlInserts(w, qtarget, columns, [src.rows[1]]);
      checkInserts(text, qtarget, colNames, dialect.qi, 1);
      await exec(w, [e.truncate(e.dst)]);
      await exec(w, splitText(text));
      assert.deepStrictEqual(await read(e.dst), [src.rows[1]]);
    });

    const job = (extra) => ({ jobId: `t${w}${Math.random().toString(36).slice(2, 7)}`, format: 'sql', toClipboard: true,
      options: { target: qtarget, commitEvery: 2 }, engine: id, ...extra });
    const sources = {
      'loaded / selected rows': { source: 'rows', columns, rows: src.rows },
      'all rows of the table': { source: 'table', owner: e.owner, name: e.src, type: 'TABLE', filters: [], sort: { col: colNames[0], dir: 'asc' } },
      'all rows of a query': { source: 'query', sql: `SELECT * FROM ${quoteOwner(id, e.owner)}.${quoteOwner(id, e.src)} ORDER BY 1` },
    };
    for (const [label, src_] of Object.entries(sources)) {
      await t(`Export → Copy to clipboard, ${label}: every column, runs and copies the rows exactly`, async () => {
        const r = await db.exportToText(w, job(src_), () => {});
        assert.strictEqual(r.rows, 3);
        assert.ok(!fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('lookup-' + 't' + w)), 'temporary file left behind');
        checkInserts(r.text, qtarget, colNames, dialect.qi, 3);
        await roundTrip(r.text);
      });
    }

    await t('Export → Copy to clipboard: a column subset lists only those columns', async () => {
      const pick = [0, 1];
      const r = await db.exportToText(w, job({ source: 'rows', columns: pick.map((i) => columns[i]), rows: src.rows.map((row) => pick.map((i) => row[i])) }), () => {});
      checkInserts(r.text, qtarget, pick.map((i) => colNames[i]), dialect.qi, 3);
    });

    await t('Export → Copy to clipboard: Cancel returns cancelled and copies nothing', async () => {
      const j = job({ source: 'rows', columns, rows: Array.from({ length: 50000 }, () => src.rows[2]) });
      const p = db.exportToText(w, j, () => {});
      await db.cancelExport(j.jobId);
      const r = await p;
      assert.ok(r.cancelled && r.text === undefined);
    });
  } catch (err) {
    failures.push(`${id}: setup`);
    console.log('  FAIL setup\n   ', err.message);
  } finally {
    if (id !== 'sqlite' && e.setup) await db.run(w, [e.setup[0]]).catch(() => {});
    if (e.drop) await db.run(w, [e.drop(e.src), e.drop(e.dst)]).catch(() => {});
    await db.disconnect(w).catch(() => {});
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Names exactly as the renderer's Lookup.qident writes them (the grid's and the export's target). */
function quoteOwner(id, n) {
  if (id === 'mysql') return '`' + String(n).replace(/`/g, '``') + '`';
  if (id === 'clickhouse') return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : '`' + String(n).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
  if (id === 'sqlite') return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : '"' + String(n).replace(/"/g, '""') + '"';
  if (id === 'postgres') return /^[a-z_][a-z0-9_$]*$/.test(n) ? n : '"' + String(n).replace(/"/g, '""') + '"';
  return /^[A-Z][A-Z0-9_$#]*$/.test(n) ? n : '"' + String(n).replace(/"/g, '""') + '"';
}

(async () => {
  const pick = process.argv.slice(2);
  for (const id of pick.length ? pick : Object.keys(ENGINES)) await runEngine(id);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exitCode = 1; }
  await db.disconnectAll?.().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
