// SQLite engine on real database files: create / open / read-only, browse, structure, DDL, table data,
// queries, transactions, Stop, export and Beautify. Run: node test/sqlite-test.js
process.removeAllListeners('warning'); // Node 22 calls node:sqlite experimental; Electron's Node does not
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/main/db');
const { split } = require('../src/shared/sqlsplit');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-sqlite-'));
const file = path.join(dir, 'shop.db');
const other = path.join(dir, 'other.db');
const W = 301;
const cfg = { engine: 'sqlite', file, autoCommit: false };

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ok ', name); };

const FIXTURE = `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  city TEXT DEFAULT 'Cairo',
  created_at DATETIME NOT NULL
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CONSTRAINT amount_ok CHECK (amount >= 0),
  placed_on DATE,
  photo BLOB,
  big INTEGER,
  "Mixed Case" TEXT
);
CREATE INDEX orders_placed_on_idx ON orders (placed_on DESC, customer_id);
CREATE TABLE audit_log (at TEXT DEFAULT CURRENT_TIMESTAMP, message TEXT);
CREATE TABLE tags (order_id INTEGER, tag TEXT, PRIMARY KEY (order_id, tag)) WITHOUT ROWID;
CREATE VIEW big_orders AS SELECT o.id, c.name, o.amount FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.amount > 1000;
CREATE TRIGGER customers_audit AFTER UPDATE ON customers BEGIN
  INSERT INTO audit_log (message) VALUES ('update ' || NEW.id);
END;
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 200)
INSERT INTO customers (name, email, city, created_at)
SELECT 'Customer ' || n, 'c' || n || '@example.com', CASE n % 3 WHEN 0 THEN 'Cairo' WHEN 1 THEN 'Giza' ELSE 'Alexandria' END,
       datetime('2026-01-01 10:00:00', '+' || n || ' hours') FROM g;
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 1000)
INSERT INTO orders (customer_id, amount, placed_on, photo, big, "Mixed Case")
SELECT 1 + n % 200, round(n * 1.37, 2), date('2026-01-01', '+' || (n % 90) || ' days'), x'DEADBEEF', 9007199254740993 + n, 'v' || n FROM g;
INSERT INTO audit_log (message) VALUES ('first'), ('second');
`;

(async () => {
  await t('a new file can be created; a missing file is not created by accident', async () => {
    await db.createDatabaseFile('sqlite', file);
    assert.ok(fs.existsSync(file));
    await assert.rejects(db.test({ engine: 'sqlite', file: path.join(dir, 'nope.db') }), /File not found/);
    assert.ok(!fs.existsSync(path.join(dir, 'nope.db')));
  });

  await t('connect: version, schema main, file name; a script with a trigger body runs statement by statement', async () => {
    const info = await db.connect(W, { ...cfg, autoCommit: true });
    assert.strictEqual(info.engine.id, 'sqlite');
    assert.match(info.version, /^3\.\d+/);
    assert.strictEqual(info.schema, 'main');
    assert.strictEqual(info.dbName, 'shop.db');
    const stmts = split(FIXTURE, 'sqlite').map((s) => s.text);
    assert.strictEqual(stmts.length, 10);
    const r = await db.run(W, stmts);
    assert.ok(r.every((x) => x.kind === 'exec'), JSON.stringify(r.find((x) => x.kind === 'error')));
    await db.setAutoCommit(W, false);
  });

  await t('schemas include attached files; objects list tables, views, indexes, triggers', async () => {
    await db.run(W, [`ATTACH '${other.replace(/'/g, "''")}' AS other`, 'CREATE TABLE other.notes (id INTEGER PRIMARY KEY, body TEXT)']);
    const schemas = await db.schemas(W);
    assert.deepStrictEqual(schemas.map((x) => x.name), ['main', 'temp', 'other']);
    assert.ok(schemas.find((x) => x.name === 'temp').system);
    const objs = await db.objects(W, 'main');
    const by = (type) => objs.filter((o) => o.type === type).map((o) => o.name).sort();
    assert.deepStrictEqual(by('TABLE'), ['audit_log', 'customers', 'orders', 'tags']);
    assert.deepStrictEqual(by('VIEW'), ['big_orders']);
    assert.deepStrictEqual(by('INDEX'), ['orders_placed_on_idx']); // automatic indexes are left out
    assert.deepStrictEqual(by('TRIGGER'), ['customers_audit']);
    assert.deepStrictEqual((await db.objects(W, 'other')).map((o) => o.name), ['notes']);
    await db.commit(W);
  });

  await t('columns and structure: rowid key, autoincrement, foreign key, unique, check, indexes', async () => {
    const st = await db.structure(W, 'main', 'customers');
    const id = st.columns.find((c) => c.name === 'id');
    assert.ok(id.pk && id.identity === 'AUTOINCREMENT' && !id.nullable);
    assert.strictEqual(st.columns.find((c) => c.name === 'city').default, "'Cairo'");
    assert.deepStrictEqual(st.constraints.map((k) => k.type), ['PRIMARY KEY', 'UNIQUE']);
    const so = await db.structure(W, 'main', 'orders');
    assert.strictEqual(so.columns.find((c) => c.name === 'id').identity, 'ROWID');
    assert.strictEqual(so.columns.find((c) => c.name === 'amount').kind, 'number');
    assert.strictEqual(so.columns.find((c) => c.name === 'photo').kind, 'binary');
    assert.strictEqual(so.columns.find((c) => c.name === 'placed_on').kind, 'date');
    const fk = so.constraints.find((k) => k.type === 'FOREIGN KEY');
    assert.strictEqual(fk.detail, '→ customers (id) on delete cascade');
    const ck = so.constraints.find((k) => k.type === 'CHECK');
    assert.deepStrictEqual([ck.name, ck.detail], ['amount_ok', 'amount >= 0']);
    assert.strictEqual(so.indexes.find((i) => i.name === 'orders_placed_on_idx').columns, 'placed_on DESC, customer_id');
    const tg = await db.structure(W, 'main', 'tags');
    assert.deepStrictEqual(tg.columns.filter((c) => c.pk).map((c) => c.name), ['order_id', 'tag']);
  });

  await t('DDL as written, with the table\'s indexes and triggers', async () => {
    const d = await db.ddl(W, 'main', 'orders', 'TABLE');
    assert.match(d, /^CREATE TABLE orders \(/);
    assert.match(d, /-- Indexes\nCREATE INDEX orders_placed_on_idx/);
    assert.match(await db.ddl(W, 'main', 'customers', 'TABLE'), /-- Triggers\nCREATE TRIGGER customers_audit/);
    assert.match(await db.ddl(W, 'main', 'big_orders', 'VIEW'), /^CREATE VIEW big_orders AS/);
    assert.match(await db.ddl(W, 'main', 'customers_audit', 'TRIGGER'), /END;$/);
  });

  await t('table data: pages in key order, count, filters, sort, exact big integers, blobs', async () => {
    const d = await db.tableData(W, { owner: 'main', name: 'orders', type: 'TABLE', limit: 50 });
    assert.strictEqual(d.total, 1000);
    assert.strictEqual(d.rows.length, 50);
    const col = (n) => d.columns.findIndex((c) => c.name === n);
    assert.strictEqual(d.rows[0][col('id')], '1');
    assert.strictEqual(d.rows[0][col('amount')], '1.37');
    assert.strictEqual(d.rows[0][col('big')], '9007199254740994');
    assert.deepStrictEqual(d.rows[0][col('photo')], { $bin: 'DEADBEEF', len: 4 });
    const p2 = await db.tableData(W, { owner: 'main', name: 'orders', type: 'TABLE', offset: 50, limit: 50, withCount: false });
    assert.strictEqual(p2.rows[0][col('id')], '51');
    const f = await db.tableData(W, { owner: 'main', name: 'customers', type: 'TABLE', limit: 500,
      filters: [{ col: 'city', op: '=', value: 'Giza' }, { col: 'name', op: 'CONTAINS', value: 'customer 1' }, { col: 'id', op: '>=', value: '100' }],
      sort: { col: 'id', dir: 'desc' } });
    assert.ok(f.total > 0 && f.rows.every((r) => r[3] === 'Giza' && Number(r[0]) >= 100));
    assert.ok(Number(f.rows[0][0]) > Number(f.rows[1][0]));
    const inn = await db.tableData(W, { owner: 'main', name: 'customers', type: 'TABLE', filters: [{ col: 'id', op: 'IN', value: '3, 5,7' }] });
    assert.deepStrictEqual(inn.rows.map((r) => r[0]), ['3', '5', '7']);
    const bin = await db.tableData(W, { owner: 'main', name: 'orders', type: 'TABLE', filters: [{ col: 'photo', op: '=', value: '0xDEADBEEF' }] });
    assert.strictEqual(bin.total, 1000);
    const v = await db.tableData(W, { owner: 'main', name: 'big_orders', type: 'VIEW', sort: { col: 'amount', dir: 'desc' }, limit: 1 });
    assert.strictEqual(v.rows[0][2], '1370');
  });

  await t('queries: row limit, no limit, errors, explain', async () => {
    let r = await db.run(W, ['select * from orders order by id'], { maxRows: 100 });
    assert.strictEqual(r[0].rows.length, 100);
    assert.strictEqual(r[0].truncated, true);
    r = await db.run(W, ['select * from orders'], { maxRows: 0 });
    assert.strictEqual(r[0].rows.length, 1000);
    r = await db.run(W, ['select 1', 'select nosuch from orders', 'select 2']);
    assert.strictEqual(r.length, 2);
    assert.match(r[1].message, /no such column: nosuch/);
    r = await db.run(W, ['EXPLAIN QUERY PLAN select * from orders where id = 1']);
    assert.match(r[0].rows[0][3], /SEARCH orders USING INTEGER PRIMARY KEY/);
  });

  await t('manual commit: reads open no transaction; changes do; a failed statement keeps it', async () => {
    let r = await db.run(W, ['select count(*) from customers']);
    assert.strictEqual(r[0].txOpen, false);
    r = await db.run(W, ["update customers set city = 'Luxor' where id = 1"]);
    assert.strictEqual(r[0].rowsAffected, 1);
    assert.strictEqual(r[0].txOpen, true);
    r = await db.run(W, ['insert into orders (customer_id, amount) values (1, -5)']);
    assert.match(r[0].message, /CHECK constraint failed: amount_ok/);
    assert.strictEqual(r[0].txOpen, true);
    await db.commit(W);
    r = await db.run(W, ['select city from customers where id = 1', 'select message from audit_log order by rowid desc limit 1']);
    assert.strictEqual(r[0].rows[0][0], 'Luxor');
    assert.strictEqual(r[1].rows[0][0], 'update 1');
    assert.strictEqual(r[1].txOpen, false);
    await db.run(W, ["update customers set city = 'Aswan' where id = 2"]);
    await db.rollback(W);
    r = await db.run(W, ['select city from customers where id = 2']);
    assert.strictEqual(r[0].rows[0][0], 'Alexandria');
  });

  await t('grid edits by primary key: integer key, composite key (WITHOUT ROWID), no key read-only, conflicts, open transaction kept', async () => {
    await db.run(W, ['CREATE TABLE edit_me (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n REAL, d TEXT, b BLOB)', "INSERT INTO edit_me (id, name, n, d) VALUES (1, 'row 1', 1.5, '2026-01-02'), (2, 'row 2', 3, NULL), (3, 'row 3', 4.5, NULL), (4, 'row 4', 6, NULL)"]);
    await db.commit(W);
    const d = await db.tableData(W, { owner: 'main', name: 'edit_me', type: 'TABLE' });
    assert.strictEqual(d.editable, true);
    assert.strictEqual(d.rowids[0], JSON.stringify(['1']));
    const noKey = await db.tableData(W, { owner: 'main', name: 'audit_log', type: 'TABLE' });
    assert.strictEqual(noKey.editable, false);
    assert.match(noKey.readOnlyReason, /no primary key/);
    const rid = (id) => JSON.stringify([String(id)]);
    const changes = { updates: [{ rowid: rid(1), values: { name: "O'Brien", n: '9.99', d: null } }], inserts: [{ values: { id: '5', name: 'new row' } }], deletes: [{ rowid: rid(4) }] };
    const preview = await db.previewChanges(W, { owner: 'main', name: 'edit_me', changes });
    assert.match(preview, /^UPDATE "main"\."edit_me" SET "name" = 'O''Brien', "n" = 9\.99, "d" = NULL WHERE "id" = 1;$/m);
    assert.deepStrictEqual(await db.applyChanges(W, { owner: 'main', name: 'edit_me', changes }), { count: 3 });
    let r = await db.run(W, ['select id, name, n, d from edit_me order by id']);
    assert.deepStrictEqual(r[0].rows, [['1', "O'Brien", '9.99', null], ['2', 'row 2', '3', null], ['3', 'row 3', '4.5', null], ['5', 'new row', null, null]]);
    assert.strictEqual(r[0].txOpen, false); // committed
    // Composite key on a WITHOUT ROWID table.
    await db.run(W, ["INSERT INTO tags VALUES (1, 'a'), (1, 'b')"]);
    await db.commit(W);
    const tg = await db.tableData(W, { owner: 'main', name: 'tags', type: 'TABLE' });
    assert.strictEqual(tg.editable, true);
    await db.applyChanges(W, { owner: 'main', name: 'tags', changes: { updates: [{ rowid: JSON.stringify(['1', 'b']), values: { tag: 'c' } }] } });
    r = await db.run(W, ['select tag from tags where order_id = 1 order by tag']);
    assert.deepStrictEqual(r[0].rows.map((x) => x[0]), ['a', 'c']);
    // A row that is gone: nothing of the batch is saved.
    await assert.rejects(db.applyChanges(W, { owner: 'main', name: 'edit_me', changes: { updates: [{ rowid: rid(2), values: { name: 'two' } }, { rowid: rid(4), values: { name: 'four' } }] } }), /not found[\s\S]*Nothing was saved/);
    // Inside the user's open transaction: a failed batch undoes only itself; a good one commits everything.
    r = await db.run(W, ["update edit_me set name = 'from query tab' where id = 3"]);
    assert.strictEqual(r[0].txOpen, true);
    await assert.rejects(db.applyChanges(W, { owner: 'main', name: 'edit_me', changes: { updates: [{ rowid: rid(2), values: { name: 'two' } }, { rowid: rid(4), values: { name: 'four' } }] } }), /not found/);
    r = await db.run(W, ['select name from edit_me where id in (2, 3) order by id']);
    assert.deepStrictEqual(r[0].rows.map((x) => x[0]), ['row 2', 'from query tab']);
    await db.applyChanges(W, { owner: 'main', name: 'edit_me', changes: { updates: [{ rowid: rid(2), values: { name: 'two' } }] } });
    assert.strictEqual(db.inTransaction ? (await db.run(W, ['select 1']))[0].txOpen : false, false);
    // Seen from another connection: both were committed.
    await db.connect(W + 2, { ...cfg, autoCommit: true });
    r = await db.run(W + 2, ['select name from edit_me where id in (2, 3) order by id']);
    assert.deepStrictEqual(r[0].rows.map((x) => x[0]), ['two', 'from query tab']);
    await db.disconnect(W + 2);
    // A file opened read-only can't be edited from the grid.
    await db.connect(W + 3, { ...cfg, readOnly: true, autoCommit: true });
    const ro = await db.tableData(W + 3, { owner: 'main', name: 'edit_me', type: 'TABLE' });
    assert.strictEqual(ro.editable, false);
    assert.match(ro.readOnlyReason, /read-only/);
    await db.disconnect(W + 3);
    await db.run(W, ['DROP TABLE edit_me', 'DELETE FROM tags']);
    await db.commit(W);
  });

  await t('table design: create, direct changes, rebuild keeping rows / indexes / triggers / keys, refusals, truncate, drop', async () => {
    const planOf = async (table) => {
      const st = await db.structure(W, 'main', table);
      return {
        owner: 'main', table,
        columns: st.columns.map((c) => ({ orig: { name: c.name, type: c.fullType, nullable: c.nullable, default: c.default, comment: '', identity: c.identity }, name: c.name, type: c.fullType, nullable: c.nullable, default: c.identity ? '' : (c.default || ''), comment: '', drop: false })),
        dropConstraints: [], addConstraints: [], dropIndexes: [], addIndexes: [], tableComment: { from: '', to: '' }, st,
      };
    };
    const spec = { owner: 'main', name: 'design_me', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'code', type: 'TEXT', nullable: false }, { name: 'qty', type: 'INTEGER', default: '0' }, { name: 'customer_id', type: 'INTEGER' }], primaryKey: ['id'] };
    assert.strictEqual(await db.createTableSql(W, spec), 'CREATE TABLE "main"."design_me" (\n  "id" INTEGER PRIMARY KEY,\n  "code" TEXT NOT NULL,\n  "qty" INTEGER DEFAULT 0,\n  "customer_id" INTEGER\n)');
    await db.createTable(W, spec);
    await db.run(W, ["INSERT INTO design_me (code, qty, customer_id) VALUES ('A', 1, 1), ('B', 2, 2)", 'CREATE INDEX design_code ON design_me (code)', "CREATE TRIGGER design_trg AFTER UPDATE ON design_me BEGIN UPDATE design_me SET qty = qty WHERE 0; END"]);
    await db.commit(W);
    // Direct: rename, add column, new index (no rebuild).
    let plan = await planOf('design_me');
    plan.columns.find((c) => c.name === 'qty').name = 'quantity';
    plan.columns.push({ orig: null, name: 'note', type: 'TEXT', nullable: true, default: "'n/a'", comment: '', drop: false });
    plan.addIndexes = [{ name: '', unique: false, columns: ['quantity'] }];
    assert.deepStrictEqual((await db.alterTableSql(W, plan)).map((x) => x.sql), [
      'ALTER TABLE "main"."design_me" RENAME COLUMN "qty" TO "quantity"',
      'ALTER TABLE "main"."design_me" ADD COLUMN "note" TEXT DEFAULT \'n/a\'',
      'CREATE INDEX "main"."design_me_quantity_idx" ON "design_me" ("quantity")',
    ]);
    assert.strictEqual((await db.alterTable(W, plan)).ok, true);
    // Rebuild: type, NOT NULL and default changed, a check and a foreign key added; rows, index, trigger kept.
    plan = await planOf('design_me');
    Object.assign(plan.columns.find((c) => c.name === 'quantity'), { type: 'REAL', nullable: false, default: '1' });
    plan.addConstraints = [{ kind: 'CHECK', name: 'qty_positive', check: 'quantity >= 0' }, { kind: 'FOREIGN KEY', name: '', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'SET NULL' }];
    const steps = await db.alterTableSql(W, plan);
    assert.deepStrictEqual(steps.map((x) => x.label), ['Rebuild design_me']);
    assert.match(steps[0].sql, /"quantity" REAL NOT NULL DEFAULT 1,[\s\S]*FOREIGN KEY \("customer_id"\) REFERENCES "customers" \("id"\) ON DELETE SET NULL,\n  CONSTRAINT "qty_positive" CHECK \(quantity >= 0\)/);
    let r = await db.alterTable(W, plan);
    assert.strictEqual(r.ok, true, r.error);
    let res = await db.run(W, ['select id, code, quantity, note from design_me order by id', "select type, name from sqlite_master where tbl_name = 'design_me' order by name"]);
    assert.deepStrictEqual(res[0].rows, [['1', 'A', '1', 'n/a'], ['2', 'B', '2', 'n/a']]);
    assert.deepStrictEqual(res[1].rows, [['index', 'design_code'], ['table', 'design_me'], ['index', 'design_me_quantity_idx'], ['trigger', 'design_trg']]);
    const st = await db.structure(W, 'main', 'design_me');
    assert.deepStrictEqual(st.constraints.map((c) => c.type).sort(), ['CHECK', 'FOREIGN KEY', 'PRIMARY KEY']);
    assert.strictEqual(st.columns.find((c) => c.name === 'id').identity, 'ROWID'); // still the rowid
    // A rebuild that fails leaves everything as it was.
    plan = await planOf('design_me');
    plan.addConstraints = [{ kind: 'CHECK', name: 'never', check: 'quantity < 0' }];
    r = await db.alterTable(W, plan);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.rolledBack, true);
    assert.match(r.error, /CHECK constraint failed/);
    assert.strictEqual((await db.run(W, ['select count(*) from design_me']))[0].rows[0][0], '2');
    assert.strictEqual((await db.structure(W, 'main', 'design_me')).constraints.length, 3);
    // Refusals with a reason: a dropped column still used by an index; COLLATE can't survive a rebuild; no comments.
    plan = await planOf('design_me');
    plan.columns.find((c) => c.name === 'code').drop = true;
    plan.addConstraints = [{ kind: 'UNIQUE', name: '', columns: ['note'] }];
    await assert.rejects(db.alterTableSql(W, plan), /Index design_code uses a column being dropped/);
    await db.run(W, ['CREATE TABLE collated (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE)']);
    await db.commit(W);
    plan = await planOf('collated');
    plan.columns.find((c) => c.name === 'name').nullable = false;
    await assert.rejects(db.alterTableSql(W, plan), /uses COLLATE/);
    plan = await planOf('design_me');
    plan.tableComment.to = 'x';
    await assert.rejects(db.alterTableSql(W, plan), /no comments/);
    await db.truncateTable(W, 'main', 'design_me');
    assert.strictEqual((await db.run(W, ['select count(*) from design_me']))[0].rows[0][0], '0');
    await db.dropTable(W, 'main', 'design_me');
    await db.dropTable(W, 'main', 'collated');
    assert.ok(!(await db.objects(W, 'main')).some((o) => /design|collated/.test(o.name)));
  });

  await t('Stop ends a long query at once; the open transaction is rolled back; the file stays usable', async () => {
    await db.run(W, ["update customers set city = 'Siwa' where id = 3"]);
    const running = db.run(W, ['WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g LIMIT 50000000) SELECT count(*) FROM g']);
    await new Promise((res) => setTimeout(res, 300));
    const t0 = Date.now();
    await db.cancel(W);
    const r = await running;
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    assert.strictEqual(r[0].cancelled, true);
    assert.strictEqual(r[0].txOpen, false);
    const again = await db.run(W, ['select city from customers where id = 3']);
    assert.strictEqual(again[0].rows[0][0], 'Cairo');
  });

  await t('a change stopped in the middle of one long step is never committed (auto-commit on)', async () => {
    await db.setAutoCommit(W, true);
    const running = db.run(W, ["update customers set city = (WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g LIMIT 30000000) SELECT 'Stopped ' || count(*) FROM g) where id = 4"]);
    await new Promise((res) => setTimeout(res, 300));
    await db.cancel(W);
    const r = await running;
    assert.strictEqual(r[0].cancelled, true);
    // The left-behind statement finishes in the background; its savepoint is rolled back with its connection.
    await new Promise((res) => setTimeout(res, 12000));
    const after = await db.run(W, ['select city from customers where id = 4', "update customers set city = 'Dahab' where id = 5", 'select city from customers where id = 5']);
    assert.strictEqual(after[0].rows[0][0], 'Giza');
    assert.strictEqual(after[2].rows[0][0], 'Dahab', 'the file is not left locked');
    await db.setAutoCommit(W, false);
  });

  await t('export a table (filtered, CSV and SQL) and a query on a separate connection', async () => {
    const csv = path.join(dir, 'o.csv');
    let res = await db.exportData(W, { jobId: 'a', format: 'csv', filePath: csv, source: 'table', owner: 'main', name: 'orders', type: 'TABLE',
      filters: [{ col: 'id', op: '<=', value: '3' }], sort: { col: 'id', dir: 'asc' }, columns: ['id', 'amount', 'photo'], options: {} }, () => {});
    assert.strictEqual(res.rows, 3);
    assert.strictEqual(fs.readFileSync(csv, 'utf8'), '﻿id,amount,photo\r\n1,1.37,DEADBEEF\r\n2,2.74,DEADBEEF\r\n3,4.11,DEADBEEF\r\n');
    const sql = path.join(dir, 'c.sql');
    res = await db.exportData(W, { jobId: 'b', format: 'sql', filePath: sql, source: 'table', owner: 'main', name: 'orders', type: 'TABLE',
      filters: [{ col: 'id', op: '<=', value: '2' }], options: { target: 'orders_copy', includeDdl: true } }, () => {});
    const text = fs.readFileSync(sql, 'utf8');
    assert.match(text, /CREATE TABLE orders/);
    assert.match(text, /INSERT INTO orders_copy \("id", "customer_id", "amount", "placed_on", "photo", "big", "Mixed Case"\) VALUES \(1, 2, 1\.37, '2026-01-02', X'DEADBEEF', 9007199254740994, 'v1'\);/);
    const json = path.join(dir, 'q.json');
    await db.exportData(W, { jobId: 'c', format: 'json', filePath: json, source: 'query', sql: 'select id, amount, photo from orders order by id limit 2', options: {} }, () => {});
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(json, 'utf8')), [{ id: 1, amount: 1.37, photo: 'DEADBEEF' }, { id: 2, amount: 2.74, photo: 'DEADBEEF' }]);
    // The INSERT file loads back into SQLite.
    const body = text.replace(/^--.*\n/, '').replace(/CREATE TABLE orders[\s\S]*?\);\n/, 'CREATE TABLE orders_copy (id INTEGER, customer_id INTEGER, amount NUMERIC, placed_on DATE, photo BLOB, big INTEGER, "Mixed Case" TEXT);\n').replace(/-- Indexes\n.*\n/, '');
    const r = await db.run(W, split(body, 'sqlite').map((s) => s.text).concat(['select count(*), max(big) from orders_copy']));
    assert.deepStrictEqual(r[r.length - 1].rows[0], ['2', '9007199254740995']);
    await db.rollback(W);
  });

  await t('cancel an export of a slow query', async () => {
    const f = path.join(dir, 'slow.csv');
    const p = db.exportData(W, { jobId: 'slow', format: 'csv', filePath: f, source: 'query', sql: 'WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g LIMIT 50000000) SELECT count(*) FROM g', options: {} }, () => {});
    await new Promise((r) => setTimeout(r, 300));
    await db.cancelExport('slow');
    const res = await p;
    assert.ok(res.cancelled);
    assert.ok(!fs.existsSync(f));
  });

  await t('read-only mode refuses changes', async () => {
    await db.connect(W + 1, { ...cfg, readOnly: true, autoCommit: true });
    const r = await db.run(W + 1, ["update customers set city = 'x' where id = 1"]);
    assert.match(r[0].message, /readonly/i);
    await db.disconnect(W + 1);
  });

  await t('Beautify uses the SQLite dialect and keeps trigger bodies', async () => {
    const { formatScript } = require('../src/main/format');
    const r = formatScript('select [a b], x from t where y = 1;\ncreate trigger tr after insert on t begin select 1; end;', db.dialectOf(W));
    assert.ok(r.text.startsWith('SELECT\n  [a b],\n  x\nFROM\n  t\nWHERE\n  y = 1;'), r.text);
    assert.ok(r.text.includes('begin select 1; end'));
  });

  await db.disconnect(W);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} SQLite tests passed`);
  process.exit(0); // a statement left behind by Stop may still be finishing on its thread
})().catch((e) => { console.error(e); process.exit(1); });
