// MySQL / MariaDB engine against a real server: connect, browse, DDL, table data, queries,
// transactions, Stop, export and lost connections. Recreates database lookup_test (fixtures/mysql-test.sql).
// Run: node test/mysql-test.js   (server from LOOKUP_MYSQL_URL, default mysql://lookup:lookup@127.0.0.1:3306)
// Skips (exit 0) when no server answers.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/main/db');
const { split } = require('../src/shared/sqlsplit');

const URL_ = process.env.LOOKUP_MYSQL_URL || 'mysql://lookup:lookup@127.0.0.1:3306';
const u = new URL(URL_);
const cfg = {
  engine: 'mysql', host: u.hostname, port: Number(u.port) || 3306, database: 'lookup_test',
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: 'prefer', autoCommit: false,
};
const S = 'lookup_test';
const W = 201;

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ok ', name); };

(async () => {
  const mysql = require('mysql2/promise');
  let admin;
  try {
    admin = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, multipleStatements: true });
  } catch (e) { console.log(`MySQL tests skipped: ${e.message}`); return; }
  // The fixture uses DELIMITER (a client command), so it is split the way the query editor splits it.
  for (const st of split(fs.readFileSync(path.join(__dirname, 'fixtures/mysql-test.sql'), 'utf8'), 'mysql')) await admin.query(st.text);
  const one = async (sql, params) => (await admin.query(sql, params))[0][0];

  await t('Test connection reports product, version and database', async () => {
    const r = await db.test(cfg);
    assert.match(r.version, /^\d+\.\d+/);
    assert.ok(['MySQL', 'MariaDB'].includes(r.product));
    assert.strictEqual(r.schema, S);
  });

  await t('connect: engine profile named after the server; wrong password fails clearly', async () => {
    const info = await db.connect(W, cfg);
    assert.strictEqual(info.engine.id, 'mysql');
    assert.ok(['MySQL', 'MariaDB'].includes(info.engine.label));
    assert.strictEqual(info.schema, S);
    await assert.rejects(db.test({ ...cfg, password: 'nope' }), /Access denied/);
    // Without a default database the first user database is shown.
    const noDb = await db.test({ ...cfg, database: '' });
    assert.ok(noDb.schema && !['mysql', 'sys', 'information_schema', 'performance_schema'].includes(noDb.schema));
  });

  await t('schemas are the databases; objects list every kind', async () => {
    const schemas = await db.schemas(W);
    assert.ok(schemas.find((x) => x.name === S && !x.system));
    assert.ok(schemas.find((x) => x.name === 'mysql' && x.system));
    const objs = await db.objects(W, S);
    const by = (type) => objs.filter((o) => o.type === type).map((o) => o.name).sort();
    assert.deepStrictEqual(by('TABLE'), ['audit_log', 'customers', 'orders']);
    assert.deepStrictEqual(by('VIEW'), ['big_orders']);
    assert.deepStrictEqual(by('PROCEDURE'), ['touch_log']);
    assert.deepStrictEqual(by('FUNCTION'), ['add_tax']);
    assert.deepStrictEqual(by('TRIGGER'), ['customers_audit']);
  });

  await t('columns and structure: types, keys, auto-increment, constraints, indexes, comments', async () => {
    const c = Object.fromEntries((await db.columns(W, S, 'orders')).map((x) => [x.name, x]));
    assert.strictEqual(c.amount.fullType, 'decimal(12,2)');
    assert.strictEqual(c.amount.kind, 'number');
    assert.strictEqual(c.placed_on.kind, 'date');
    assert.strictEqual(c.placed_at.kind, 'timestamp');
    assert.strictEqual(c.photo.kind, 'binary');
    assert.match(c.big.fullType, /^bigint(\(20\))? unsigned$/); // MySQL 8 dropped the display width
    assert.strictEqual(c.status.fullType, "enum('new','paid','sent')");
    const st = await db.structure(W, S, 'customers');
    assert.ok(st.columns.find((x) => x.name === 'id' && x.pk && x.identity === 'AUTO_INCREMENT'));
    assert.strictEqual(st.comment, 'People who buy things');
    assert.strictEqual(st.columns.find((x) => x.name === 'email').comments, 'Login e-mail');
    assert.deepStrictEqual(st.constraints.map((k) => k.type), ['PRIMARY KEY', 'UNIQUE']);
    const so = await db.structure(W, S, 'orders');
    const fk = so.constraints.find((k) => k.type === 'FOREIGN KEY');
    assert.strictEqual(fk.detail, '→ lookup_test.customers (id) on delete cascade');
    assert.strictEqual(fk.columns, 'customer_id');
    assert.ok(so.constraints.find((k) => k.name === 'orders_amount_chk' && /amount/.test(k.detail)));
    assert.match(so.indexes.find((i) => i.name === 'orders_placed_on_idx').columns, /^placed_on( DESC)?, status$/); // DESC indexes: MySQL 8, MariaDB 10.8+
    assert.ok(so.indexes.find((i) => i.name === 'PRIMARY' && i.unique && i.constraint));
  });

  await t('DDL from SHOW CREATE, procedural objects between DELIMITER lines', async () => {
    const ddl = await db.ddl(W, S, 'orders', 'TABLE');
    assert.match(ddl, /^CREATE TABLE `orders` \(/);
    assert.match(ddl, /CONSTRAINT `orders_customer_fk` FOREIGN KEY/);
    assert.ok(ddl.endsWith(';'));
    assert.match(await db.ddl(W, S, 'big_orders', 'VIEW'), /VIEW `big_orders` AS select/i);
    const proc = await db.ddl(W, S, 'touch_log', 'PROCEDURE');
    assert.match(proc, /^DELIMITER \$\$\nCREATE DEFINER=.*PROCEDURE `touch_log`/);
    assert.ok(proc.endsWith('END$$\nDELIMITER ;'));
    assert.match(await db.ddl(W, S, 'add_tax', 'FUNCTION'), /FUNCTION `add_tax`/);
    assert.match(await db.ddl(W, S, 'customers_audit', 'TRIGGER'), /TRIGGER `?customers_audit`? AFTER UPDATE/);
    // The DDL text runs as a script in the editor (DELIMITER is handled by the splitter).
    const parts = split(proc, 'mysql');
    assert.strictEqual(parts.length, 1);
    assert.ok(parts[0].plsql);
  });

  await t('table data: pages in key order, count, filters, sort, values as text', async () => {
    const d = await db.tableData(W, { owner: S, name: 'orders', type: 'TABLE', offset: 0, limit: 50 });
    assert.strictEqual(d.total, 1000);
    assert.strictEqual(d.rows.length, 50);
    assert.strictEqual(d.editable, true); // has a primary key
    assert.strictEqual(d.rowids[0], JSON.stringify(['1']));
    const col = (n) => d.columns.findIndex((c) => c.name === n);
    assert.strictEqual(d.rows[0][col('id')], '1');
    assert.strictEqual(d.columns[col('amount')].fullType, 'decimal(12,2)');
    assert.strictEqual(d.rows[0][col('amount')], '1.37');
    assert.strictEqual(d.rows[0][col('placed_on')], '2026-01-02');
    assert.strictEqual(d.rows[0][col('placed_at')], '2026-01-01 08:31:00.123');
    assert.match(d.rows[0][col('details')], /^\{"n": ?1, ?"gift": ?(false|0)\}$/);
    assert.deepStrictEqual(d.rows[0][col('photo')], { $bin: 'DEADBEEF', len: 4 });
    assert.strictEqual(d.rows[0][col('big')], '18446744073709551614');
    assert.strictEqual(d.rows[0][col('status')], 'paid');
    const p2 = await db.tableData(W, { owner: S, name: 'orders', type: 'TABLE', offset: 50, limit: 50, withCount: false });
    assert.strictEqual(p2.rows[0][col('id')], '51');
    const f = await db.tableData(W, { owner: S, name: 'customers', type: 'TABLE', limit: 500,
      filters: [{ col: 'city', op: '=', value: 'Giza' }, { col: 'name', op: 'CONTAINS', value: 'customer 1' }, { col: 'id', op: '>=', value: '100' }],
      sort: { col: 'id', dir: 'desc' } });
    assert.ok(f.total > 0 && f.rows.every((r) => r[3] === 'Giza' && Number(r[0]) >= 100));
    assert.ok(Number(f.rows[0][0]) > Number(f.rows[1][0]));
    const inn = await db.tableData(W, { owner: S, name: 'customers', type: 'TABLE', filters: [{ col: 'id', op: 'IN', value: '3, 5,7' }] });
    assert.deepStrictEqual(inn.rows.map((r) => r[0]), ['3', '5', '7']);
    const like = await db.tableData(W, { owner: S, name: 'orders', type: 'TABLE', filters: [{ col: 'amount', op: 'LIKE', value: '1.37' }] });
    assert.strictEqual(like.total, 1);
    const bin = await db.tableData(W, { owner: S, name: 'orders', type: 'TABLE', withCount: true, filters: [{ col: 'photo', op: '=', value: '0xDEADBEEF' }] });
    assert.strictEqual(bin.total, 1000);
    const v = await db.tableData(W, { owner: S, name: 'big_orders', type: 'VIEW', sort: { col: 'amount', dir: 'desc' }, limit: 5 });
    assert.strictEqual(v.rows[0][2], '1370.00');
  });

  await t('queries: row limit added to SELECT, no limit, errors point at the text, warnings', async () => {
    let r = await db.run(W, ['select * from orders order by id'], { maxRows: 100 });
    assert.strictEqual(r[0].kind, 'rows');
    assert.strictEqual(r[0].rows.length, 100);
    assert.strictEqual(r[0].truncated, true);
    assert.deepStrictEqual(r[0].columns.slice(0, 3).map((c) => [c.type, c.kind]), [['bigint', 'number'], ['int', 'number'], ['decimal', 'number']]);
    r = await db.run(W, ['select * from orders'], { maxRows: 0 });
    assert.strictEqual(r[0].rows.length, 1000);
    r = await db.run(W, ['show tables'], { maxRows: 2 });
    assert.strictEqual(r[0].rows.length, 2);
    assert.strictEqual(r[0].truncated, true);
    r = await db.run(W, ['select 1', 'selec nosuch from orders', 'select 2']);
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[1].kind, 'error');
    assert.match(r[1].message, /SQL syntax/);
    assert.strictEqual(r[1].offset, 0);
    r = await db.run(W, ["select cast('12abc' as unsigned)"]);
    assert.match(r[0].output[0], /^Warning 1292: Truncated incorrect/);
    r = await db.run(W, ["call touch_log('hello')"]);
    assert.strictEqual(r[0].kind, 'rows');
    assert.strictEqual(r[0].columns[0].name, 'entries');
    r = await db.run(W, ['explain select * from orders where id = 1']);
    assert.strictEqual(r[0].kind, 'rows');
    await db.rollback(W);
  });

  await t('manual commit: reads open no transaction; changes do; a failed statement keeps it open', async () => {
    let r = await db.run(W, ['select count(*) from customers']);
    assert.strictEqual(r[0].txOpen, false);
    r = await db.run(W, ["update customers set city = 'Luxor' where id = 1"]);
    assert.strictEqual(r[0].kind, 'exec');
    assert.strictEqual(r[0].rowsAffected, 1);
    assert.strictEqual(r[0].txOpen, true);
    assert.strictEqual((await one('select city from lookup_test.customers where id = 1')).city, 'Giza');
    r = await db.run(W, ['insert into orders (customer_id, amount, placed_on) values (1, -5, curdate())']);
    assert.strictEqual(r[0].kind, 'error');
    assert.match(r[0].message, /orders_amount_chk/);
    assert.strictEqual(r[0].txOpen, true);
    r = await db.run(W, ['select city from customers where id = 1']);
    assert.strictEqual(r[0].rows[0][0], 'Luxor');
    await db.commit(W);
    assert.strictEqual((await one('select city from lookup_test.customers where id = 1')).city, 'Luxor');
    r = await db.run(W, ["update customers set city = 'Aswan' where id = 2"]);
    await db.rollback(W);
    assert.strictEqual((await one('select city from lookup_test.customers where id = 2')).city, 'Alexandria');
    // DDL commits by itself in MySQL: the transaction is reported closed.
    r = await db.run(W, ["update customers set city = 'Dahab' where id = 4", 'create table t_tmp (a int)', 'drop table t_tmp']);
    assert.strictEqual(r[0].txOpen, true);
    assert.strictEqual(r[1].txOpen, false);
    assert.strictEqual((await one('select city from lookup_test.customers where id = 4')).city, 'Dahab');
  });

  await t('auto-commit on: every statement is committed straight away', async () => {
    await db.setAutoCommit(W, true);
    const r = await db.run(W, ["update customers set city = 'Siwa' where id = 3"]);
    assert.strictEqual(r[0].txOpen, false);
    assert.strictEqual((await one('select city from lookup_test.customers where id = 3')).city, 'Siwa');
    await db.setAutoCommit(W, false);
  });

  await t('grid edits by primary key: preview, apply in one transaction, same value saved again, conflicts, open transaction kept', async () => {
    await admin.query(`CREATE TABLE lookup_test.edit_me (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, n DECIMAL(8,2), d DATE, j JSON, flag TINYINT(1), at DATETIME) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE lookup_test.edit_two (region VARCHAR(5), code INT, label VARCHAR(20), PRIMARY KEY (region, code)) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO lookup_test.edit_me VALUES (1,'row 1',1.5,'2026-01-02','{"g":1}',0,'2026-01-01 10:00:00'),(2,'row 2',3,'2026-01-03',NULL,1,NULL),(3,'row 3',4.5,NULL,NULL,0,NULL),(4,'row 4',6,NULL,NULL,1,NULL),(5,'row 5',7.5,NULL,NULL,0,NULL)`);
    await admin.query(`INSERT INTO lookup_test.edit_two VALUES ('eg',1,'one'),('eg',2,'two')`);
    const d = await db.tableData(W, { owner: S, name: 'edit_me', type: 'TABLE' });
    assert.strictEqual(d.editable, true);
    const noKey = await db.tableData(W, { owner: S, name: 'audit_log', type: 'TABLE' });
    assert.strictEqual(noKey.editable, false);
    assert.match(noKey.readOnlyReason, /no primary key/);
    const rid = (id) => JSON.stringify([String(id)]);
    const changes = {
      updates: [{ rowid: rid(1), values: { name: "O'Brien", n: '9.99', d: '2026-03-04', j: '{"x": [1, 2]}', flag: '1', at: null } }],
      inserts: [{ values: { id: '6', name: 'new row', n: '1' } }],
      deletes: [{ rowid: rid(5) }],
    };
    const preview = await db.previewChanges(W, { owner: S, name: 'edit_me', changes });
    assert.match(preview, /^DELETE FROM `lookup_test`\.`edit_me` WHERE `id` = 5;$/m);
    assert.match(preview, /^UPDATE `lookup_test`\.`edit_me` SET `name` = 'O''Brien', `n` = 9\.99, `d` = '2026-03-04', `j` = '\{"x": \[1, 2\]\}', `flag` = 1, `at` = NULL WHERE `id` = 1;$/m);
    assert.deepStrictEqual(await db.applyChanges(W, { owner: S, name: 'edit_me', changes }), { count: 3 });
    const [[row1]] = await admin.query("SELECT name, CAST(n AS CHAR) n, CAST(d AS CHAR) d, JSON_EXTRACT(j, '$.x[1]') x, flag, at FROM lookup_test.edit_me WHERE id = 1");
    assert.deepStrictEqual({ ...row1, x: Number(row1.x) }, { name: "O'Brien", n: '9.99', d: '2026-03-04', x: 2, flag: 1, at: null });
    assert.deepStrictEqual((await admin.query('SELECT id FROM lookup_test.edit_me ORDER BY id'))[0].map((r) => r.id), [1, 2, 3, 4, 6]);
    // Saving a value that didn't change still counts as the row being there.
    assert.deepStrictEqual(await db.applyChanges(W, { owner: S, name: 'edit_me', changes: { updates: [{ rowid: rid(2), values: { name: 'row 2' } }] } }), { count: 1 });
    await db.applyChanges(W, { owner: S, name: 'edit_two', changes: { updates: [{ rowid: JSON.stringify(['eg', '2']), values: { label: 'deux' } }] } });
    assert.deepStrictEqual((await admin.query('SELECT label FROM lookup_test.edit_two ORDER BY region, code'))[0].map((r) => r.label), ['one', 'deux']);
    // Someone else deleted a row meanwhile: nothing of the batch is saved.
    await admin.query('DELETE FROM lookup_test.edit_me WHERE id = 4');
    await assert.rejects(db.applyChanges(W, { owner: S, name: 'edit_me', changes: { updates: [{ rowid: rid(3), values: { name: 'three' } }, { rowid: rid(4), values: { name: 'four' } }] } }), /not found[\s\S]*Nothing was saved/);
    assert.strictEqual((await admin.query('SELECT name FROM lookup_test.edit_me WHERE id = 3'))[0][0].name, 'row 3');
    // Inside the user's open transaction: a failed batch undoes only itself; a good one commits everything.
    let r = await db.run(W, ["update lookup_test.edit_me set name = 'from query tab' where id = 2"]);
    assert.strictEqual(r[0].txOpen, true);
    await assert.rejects(db.applyChanges(W, { owner: S, name: 'edit_me', changes: { updates: [{ rowid: rid(3), values: { name: 'three' } }, { rowid: rid(4), values: { name: 'gone' } }] } }), /not found/);
    r = await db.run(W, ['select name from lookup_test.edit_me where id in (2, 3) order by id']);
    assert.deepStrictEqual(r[0].rows.map((x) => x[0]), ['from query tab', 'row 3']);
    await db.applyChanges(W, { owner: S, name: 'edit_me', changes: { updates: [{ rowid: rid(3), values: { name: 'three' } }] } });
    assert.deepStrictEqual((await admin.query('SELECT name FROM lookup_test.edit_me WHERE id IN (2, 3) ORDER BY id'))[0].map((x) => x.name), ['from query tab', 'three']);
    await admin.query('DROP TABLE lookup_test.edit_me, lookup_test.edit_two');
  });

  await t('Stop kills the running query and the session stays usable', async () => {
    const running = db.run(W, ['select sleep(30)']);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await db.cancel(W);
    const r = await running;
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    // MySQL ends SLEEP() early with result 1 instead of an error; other statements fail with 1317.
    assert.ok(r[0].cancelled || (r[0].kind === 'rows' && String(r[0].rows[0][0]) === '1'), JSON.stringify(r[0]));
    const r2 = db.run(W, ['select count(*) from orders a, orders b, orders c']);
    await new Promise((res) => setTimeout(res, 300));
    await db.cancel(W);
    const x = await r2;
    assert.strictEqual(x[0].cancelled, true, JSON.stringify(x[0]));
    assert.strictEqual((await db.run(W, ['select 42']))[0].rows[0][0], '42');
  });

  await t('export a table (filtered, CSV and SQL) and a query on a separate connection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-my-'));
    const csv = path.join(dir, 'o.csv');
    let res = await db.exportData(W, { jobId: 'a', format: 'csv', filePath: csv, source: 'table', owner: S, name: 'orders', type: 'TABLE',
      filters: [{ col: 'id', op: '<=', value: '3' }], sort: { col: 'id', dir: 'asc' }, columns: ['id', 'amount', 'photo'], options: {} }, () => {});
    assert.strictEqual(res.rows, 3);
    assert.strictEqual(fs.readFileSync(csv, 'utf8'), '﻿id,amount,photo\r\n1,1.37,DEADBEEF\r\n2,2.74,DEADBEEF\r\n3,4.11,DEADBEEF\r\n');
    const sql = path.join(dir, 'c.sql');
    res = await db.exportData(W, { jobId: 'b', format: 'sql', filePath: sql, source: 'table', owner: S, name: 'audit_log', type: 'TABLE',
      options: { target: 'lookup_test.audit_copy', includeDdl: true } }, () => {});
    const sqlRows = res.rows;
    const text = fs.readFileSync(sql, 'utf8');
    assert.match(text, /CREATE TABLE `audit_log`/);
    assert.match(text, /INSERT INTO lookup_test\.audit_copy \(`at`, `message`\) VALUES \('20\d\d-[^']+', 'first'\);/);
    const big = path.join(dir, 'big.csv');
    res = await db.exportData(W, { jobId: 'big', format: 'csv', filePath: big, source: 'query', sql: 'select a.id, b.id from orders a, customers b', options: {} }, () => {});
    assert.strictEqual(res.rows, 200000);
    assert.strictEqual(fs.readFileSync(big, 'utf8').split('\r\n').length, 200002);
    const json = path.join(dir, 'q.json');
    await db.exportData(W, { jobId: 'c', format: 'json', filePath: json, source: 'query', sql: 'select id, amount, photo, status from orders order by id limit 2', options: {} }, () => {});
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(json, 'utf8')), [
      { id: 1, amount: 1.37, photo: 'DEADBEEF', status: 'paid' }, { id: 2, amount: 2.74, photo: 'DEADBEEF', status: 'sent' }]);
    // The SQL INSERT file loads back.
    await admin.query('CREATE TABLE lookup_test.audit_copy (at DATETIME, message TEXT)');
    for (const st of split(text.replace(/CREATE TABLE[\s\S]*?;\n/, ''), 'mysql')) await admin.query(st.text);
    assert.strictEqual(Number((await one('select count(*) n from lookup_test.audit_copy')).n), sqlRows);
  });

  await t('cancel an export of a slow query', async () => {
    const f = path.join(os.tmpdir(), `lookup-my-slow-${process.pid}.csv`);
    const p = db.exportData(W, { jobId: 'slow', format: 'csv', filePath: f, source: 'query', sql: 'select count(*) from orders a, orders b, orders c', options: {} }, () => {});
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    await db.cancelExport('slow');
    const res = await p;
    assert.ok(res.cancelled);
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(!fs.existsSync(f));
  });

  await t('Beautify uses the MySQL dialect and keeps procedure bodies', async () => {
    const { formatScript } = require('../src/main/format');
    const r = formatScript('select `a b`, x from t where y = \'a;b\';\nDELIMITER $$\ncreate procedure p() begin select 1; end$$\nDELIMITER ;', db.dialectOf(W));
    assert.ok(r.text.startsWith('SELECT\n  `a b`,\n  x\nFROM\n  t\nWHERE\n  y = \'a;b\';'), r.text);
    assert.ok(r.text.includes('create procedure p() begin select 1; end$$'));
  });

  await t('a killed session is reported as lost; Reconnect opens a new one', async () => {
    const lost = [];
    db.setOnLost((id, msg) => lost.push(msg));
    const id = (await db.run(W, ['select connection_id()']))[0].rows[0][0];
    await admin.query(`KILL ${Number(id)}`);
    const r = await db.run(W, ['select 1']);
    assert.strictEqual(r[0].kind, 'error');
    assert.strictEqual(r[0].lost, true, JSON.stringify(r[0]));
    assert.strictEqual(lost.length, 1);
    await db.reconnect(W);
    assert.strictEqual((await db.run(W, ['select 7']))[0].rows[0][0], '7');
  });

  await t('an idle session killed on the server is noticed by the health check', async () => {
    const lost = [];
    db.setOnLost((id, msg) => lost.push(msg));
    const id = (await db.run(W, ['select connection_id()']))[0].rows[0][0];
    db.configure({ healthCheckSec: 1 });
    await admin.query(`KILL ${Number(id)}`);
    await new Promise((r) => setTimeout(r, 2500));
    db.configure({ healthCheckSec: 30 });
    assert.strictEqual(lost.length, 1);
    await db.reconnect(W);
  });

  await db.disconnect(W);
  await admin.query('DROP DATABASE lookup_test');
  await admin.end();
  console.log(`\n${passed} MySQL tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
