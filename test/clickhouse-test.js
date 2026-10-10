// ClickHouse engine against a real server: connect, browse, structure, DDL, table data, queries,
// Stop, export and Beautify. Recreates database lookup_test (fixtures/clickhouse-test.sql).
// Run: node test/clickhouse-test.js   (server from LOOKUP_CH_URL, default http://lookup:lookup@127.0.0.1:8123)
// Skips (exit 0) when no server answers.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/main/db');
const { split } = require('../src/shared/sqlsplit');

const u = new URL(process.env.LOOKUP_CH_URL || 'http://lookup:lookup@127.0.0.1:8123');
const cfg = {
  engine: 'clickhouse', host: u.hostname, port: Number(u.port) || 8123, database: 'lookup_test',
  user: decodeURIComponent(u.username) || 'default', password: decodeURIComponent(u.password), ssl: u.protocol === 'https:' ? 'require' : 'disable',
};
const S = 'lookup_test';
const W = 401;

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ok ', name); };

(async () => {
  const { createClient } = require('@clickhouse/client');
  const admin = createClient({ url: `${u.protocol}//${u.host}`, username: cfg.user, password: cfg.password });
  const ping = await admin.ping();
  if (!ping.success) { console.log(`ClickHouse tests skipped: ${ping.error.message}`); await admin.close(); return; }
  for (const st of split(fs.readFileSync(path.join(__dirname, 'fixtures/clickhouse-test.sql'), 'utf8'), 'clickhouse')) await admin.command({ query: st.text });
  const one = async (sql) => (await (await admin.query({ query: sql, format: 'JSONEachRow' })).json())[0];

  await t('Test connection reports version and database; a wrong password fails clearly', async () => {
    const r = await db.test(cfg);
    assert.match(r.version, /^\d+\.\d+/);
    assert.strictEqual(r.schema, S);
    await assert.rejects(db.test({ ...cfg, password: 'nope' }), /password is incorrect|Authentication failed/i);
  });

  await t('connect: always auto-commit (no transactions)', async () => {
    const info = await db.connect(W, { ...cfg, autoCommit: false });
    assert.strictEqual(info.engine.id, 'clickhouse');
    assert.strictEqual(info.autoCommit, true);
    assert.strictEqual(await db.setAutoCommit(W, false), true);
  });

  await t('databases as schemas; tables, views, materialized views, dictionaries', async () => {
    const schemas = await db.schemas(W);
    assert.ok(schemas.find((x) => x.name === S && !x.system));
    assert.ok(schemas.find((x) => x.name === 'system' && x.system));
    const objs = await db.objects(W, S);
    const by = (type) => objs.filter((o) => o.type === type).map((o) => o.name).sort();
    assert.deepStrictEqual(by('TABLE'), ['daily', 'events', 'users']);
    assert.deepStrictEqual(by('VIEW'), ['big_events']);
    assert.deepStrictEqual(by('MATERIALIZED VIEW'), ['daily_mv']);
    assert.deepStrictEqual(by('DICTIONARY'), ['user_names']);
  });

  await t('columns and structure: keys, partition, check constraint, skipping index, comment', async () => {
    const c = Object.fromEntries((await db.columns(W, S, 'events')).map((x) => [x.name, x]));
    assert.strictEqual(c.amount.fullType, 'Decimal(12, 2)');
    assert.strictEqual(c.amount.kind, 'number');
    assert.strictEqual(c.day.kind, 'date');
    assert.strictEqual(c.at.kind, 'timestamp');
    assert.strictEqual(c.note.nullable, true);
    assert.strictEqual(c.kind.nullable, false);
    assert.strictEqual(c['Mixed Case'].default, "'x'");
    const st = await db.structure(W, S, 'events');
    assert.deepStrictEqual(st.constraints.map((k) => `${k.type}: ${k.columns || k.detail}`), [
      'PRIMARY KEY: user_id, id', 'PARTITION BY: toYYYYMM(day)', 'CHECK: amount >= 0']);
    assert.deepStrictEqual(st.columns.filter((x) => x.pk).map((x) => x.name), ['id', 'user_id']);
    assert.strictEqual(st.indexes[0].name, 'kind_idx');
    assert.match(st.comment, /^Things users did — Engine: MergeTree/);
  });

  await t('DDL from SHOW CREATE, for tables, views and dictionaries', async () => {
    assert.match(await db.ddl(W, S, 'events', 'TABLE'), /^CREATE TABLE lookup_test\.events\n\(/);
    assert.match(await db.ddl(W, S, 'big_events', 'VIEW'), /^CREATE VIEW lookup_test\.big_events/);
    assert.match(await db.ddl(W, S, 'daily_mv', 'MATERIALIZED VIEW'), /^CREATE MATERIALIZED VIEW lookup_test\.daily_mv TO lookup_test\.daily/);
    assert.match(await db.ddl(W, S, 'user_names', 'DICTIONARY'), /^CREATE DICTIONARY lookup_test\.user_names/);
  });

  await t('table data: pages, count, typed filters, sort, values as text', async () => {
    const d = await db.tableData(W, { owner: S, name: 'events', type: 'TABLE', limit: 50, sort: { col: 'id', dir: 'asc' } });
    assert.strictEqual(d.total, 1000);
    assert.strictEqual(d.rows.length, 50);
    const col = (n) => d.columns.findIndex((x) => x.name === n);
    assert.strictEqual(d.rows[0][col('id')], '1');
    assert.strictEqual(d.rows[0][col('amount')], '1.37');
    assert.strictEqual(d.rows[0][col('at')], '2026-01-01 08:30:00.123');
    assert.strictEqual(d.rows[0][col('tags')], '["t0","x"]');
    assert.strictEqual(d.rows[0][col('props')], '{"n":"1"}');
    assert.strictEqual(d.rows[0][col('note')], null);
    const p2 = await db.tableData(W, { owner: S, name: 'events', type: 'TABLE', offset: 50, limit: 50, sort: { col: 'id', dir: 'asc' }, withCount: false });
    assert.strictEqual(p2.rows[0][col('id')], '51');
    const f = await db.tableData(W, { owner: S, name: 'events', type: 'TABLE', limit: 500,
      filters: [{ col: 'kind', op: '=', value: 'buy' }, { col: 'user_id', op: '<=', value: '10' }, { col: 'day', op: '>=', value: '2026-01-05' }, { col: 'note', op: 'CONTAINS', value: 'OK' }] });
    assert.ok(f.total > 0 && f.rows.every((r) => r[col('kind')] === 'buy' && Number(r[col('user_id')]) <= 10 && r[col('day')] >= '2026-01-05'));
    const inn = await db.tableData(W, { owner: S, name: 'users', type: 'TABLE', filters: [{ col: 'id', op: 'IN', value: '3, 5,7' }], sort: { col: 'id', dir: 'asc' } });
    assert.deepStrictEqual(inn.rows.map((r) => r[0]), ['3', '5', '7']);
    const nul = await db.tableData(W, { owner: S, name: 'events', type: 'TABLE', filters: [{ col: 'note', op: 'IS NULL' }] });
    assert.strictEqual(nul.total, 100);
    const raw = await db.tableData(W, { owner: S, name: 'events', type: 'TABLE', filters: [{ op: 'RAW', value: "has(tags, 't3')" }] });
    assert.strictEqual(raw.total, 200);
    const v = await db.tableData(W, { owner: S, name: 'big_events', type: 'VIEW', sort: { col: 'amount', dir: 'desc' }, limit: 1 });
    assert.strictEqual(v.rows[0][2], '1370.00');
  });

  await t('queries: row limit stops the stream, no limit, errors, commands, explain', async () => {
    let r = await db.run(W, ['select number from system.numbers'], { maxRows: 100 }); // endless: the limit ends it
    assert.strictEqual(r[0].rows.length, 100);
    assert.strictEqual(r[0].truncated, true);
    r = await db.run(W, ['select * from events'], { maxRows: 0 });
    assert.strictEqual(r[0].rows.length, 1000);
    r = await db.run(W, ['select 1', 'select nosuch from events', 'select 2']);
    assert.strictEqual(r.length, 2);
    assert.match(r[1].message, /nosuch/);
    r = await db.run(W, ['create table t_tmp (a UInt8) engine = Memory', 'insert into t_tmp values (1), (2), (3)', 'select sum(a) from t_tmp', 'drop table t_tmp']);
    assert.deepStrictEqual(r.map((x) => x.kind), ['exec', 'exec', 'rows', 'exec']);
    assert.strictEqual(r[1].rowsAffected, 3);
    assert.strictEqual(r[2].rows[0][0], '6');
    assert.ok(r.every((x) => x.txOpen === undefined));
    r = await db.run(W, ['explain select * from events where user_id = 1']);
    assert.strictEqual(r[0].kind, 'rows');
    assert.ok(r[0].rows.length > 0);
  });

  await t('Stop aborts a long query and kills it on the server', async () => {
    const running = db.run(W, ['select count() from numbers(100000000000) where sipHash64(number) % 7 = 0']);
    await new Promise((res) => setTimeout(res, 500));
    const t0 = Date.now();
    await db.cancel(W);
    const r = await running;
    assert.ok(Date.now() - t0 < 3000);
    assert.strictEqual(r[0].cancelled, true, JSON.stringify(r[0]));
    await new Promise((res) => setTimeout(res, 1500));
    const left = await one(`select count() n from system.processes where query like '%sipHash64(number) % 7%' and query not like '%system.processes%'`);
    assert.strictEqual(Number(left.n), 0, 'the server stopped the query');
    assert.strictEqual((await db.run(W, ['select 42']))[0].rows[0][0], '42');
  });

  await t('export a table (filtered, CSV and SQL) and a query; cancel a slow export', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-ch-'));
    const csv = path.join(dir, 'e.csv');
    let res = await db.exportData(W, { jobId: 'a', format: 'csv', filePath: csv, source: 'table', owner: S, name: 'events', type: 'TABLE',
      filters: [{ col: 'id', op: '<=', value: '3' }], sort: { col: 'id', dir: 'asc' }, columns: ['id', 'amount', 'kind'], options: {} }, () => {});
    assert.strictEqual(res.rows, 3);
    assert.strictEqual(fs.readFileSync(csv, 'utf8'), '\ufeffid,kind,amount\r\n1,view,1.37\r\n2,click,2.74\r\n3,buy,4.11\r\n');
    const sql = path.join(dir, 'u.sql');
    res = await db.exportData(W, { jobId: 'b', format: 'sql', filePath: sql, source: 'table', owner: S, name: 'users', type: 'TABLE',
      filters: [{ col: 'id', op: '<=', value: '2' }], sort: { col: 'id', dir: 'asc' }, options: { target: 'lookup_test.users_copy', includeDdl: true } }, () => {});
    const text = fs.readFileSync(sql, 'utf8');
    assert.match(text, /CREATE TABLE lookup_test\.users/);
    assert.match(text, /INSERT INTO lookup_test\.users_copy \(`id`, `name`, `city`\) VALUES \(1, 'User 1', 'Cairo'\);/);
    assert.ok(!/COMMIT/.test(text));
    await admin.command({ query: 'CREATE TABLE lookup_test.users_copy AS lookup_test.users' });
    for (const st of split(text.replace(/CREATE TABLE[\s\S]*?;\n/, ''), 'clickhouse')) await admin.command({ query: st.text });
    assert.strictEqual(Number((await one('select count() n from lookup_test.users_copy')).n), 2);
    const big = path.join(dir, 'big.csv');
    res = await db.exportData(W, { jobId: 'c', format: 'csv', filePath: big, source: 'query', sql: 'select number, toString(number) from numbers(300000)', options: {} }, () => {});
    assert.strictEqual(res.rows, 300000);
    const slow = path.join(dir, 'slow.csv');
    const p = db.exportData(W, { jobId: 'slow', format: 'csv', filePath: slow, source: 'query', sql: 'select count() from numbers(100000000000) where sipHash64(number) % 7 = 0', options: {} }, () => {});
    await new Promise((r) => setTimeout(r, 500));
    await db.cancelExport('slow');
    assert.ok((await p).cancelled);
    assert.ok(!fs.existsSync(slow));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t('Beautify uses the ClickHouse dialect', async () => {
    const { formatScript } = require('../src/main/format');
    const r = formatScript('select `a b`, arrayJoin(tags) from t where x = 1 settings max_threads = 2', db.dialectOf(W));
    assert.ok(r.text.startsWith('select\n  `a b`,\n  arrayJoin(tags)\nfrom\n  t\nwhere\n  x = 1'), r.text); // case kept: names are case-sensitive
  });

  await t('table design: create (engine, order by, partition, Nullable), alter step by step, truncate, drop', async () => {
    const spec = {
      owner: S, name: 'Design_Me', engine: 'MergeTree', partitionBy: 'toYYYYMM(created)',
      columns: [
        { name: 'id', type: 'UInt64', nullable: true, default: '' }, // a key column is never Nullable
        { name: 'created', type: 'DateTime', nullable: false, default: 'now()' },
        { name: 'city', type: 'LowCardinality(String)', nullable: true, default: "'Cairo'" },
        { name: 'qty', type: 'Int32', nullable: false, default: '' },
      ],
      primaryKey: ['id', 'created'],
    };
    assert.strictEqual(await db.createTableSql(W, spec), "CREATE TABLE `lookup_test`.`Design_Me` (\n  `id` UInt64,\n  `created` DateTime DEFAULT now(),\n  `city` LowCardinality(Nullable(String)) DEFAULT 'Cairo',\n  `qty` Int32\n)\nENGINE = MergeTree\nPARTITION BY toYYYYMM(created)\nORDER BY (`id`, `created`)");
    await assert.rejects(db.createTableSql(W, { ...spec, engine: 'Log' }), /Log engine has no sort key/);
    await assert.rejects(db.createTableSql(W, { ...spec, columns: [...spec.columns, { name: 'tags', type: 'Array(String)', nullable: true }] }), /Array\(String\) can't be Nullable/);
    await db.createTable(W, spec);
    await admin.command({ query: "INSERT INTO lookup_test.Design_Me (id, qty) VALUES (1, 5), (2, 7)" });

    const planOf = async () => {
      const st = await db.structure(W, S, 'Design_Me');
      return {
        st, owner: S, table: 'Design_Me',
        columns: st.columns.map((c) => ({ orig: { name: c.name, type: c.fullType, nullable: c.nullable, default: c.default, comment: c.comments || '', identity: null }, name: c.name, type: c.fullType, nullable: c.nullable, default: c.default || '', comment: c.comments || '', drop: false })),
        dropConstraints: [], addConstraints: [], dropIndexes: [], addIndexes: [], toggleConstraints: [], tableComment: { from: st.tableComment, to: st.tableComment },
      };
    };
    let plan = await planOf();
    assert.deepStrictEqual(plan.st.constraints.map((k) => k.type), ['PRIMARY KEY', 'PARTITION BY']);
    assert.strictEqual(plan.st.tableComment, '');
    const col = (n) => plan.columns.find((c) => c.name === n);
    Object.assign(col('qty'), { name: 'quantity', type: 'Int64', nullable: true, comment: 'how many' });
    Object.assign(col('city'), { nullable: false, type: 'LowCardinality(String)', default: '' });
    plan.columns.push({ orig: null, name: 'note', type: 'String', nullable: false, default: "''", comment: 'free text', drop: false });
    plan.addConstraints.push({ kind: 'CHECK', name: '', check: 'quantity >= 0' });
    plan.addIndexes.push({ name: '', columns: ['quantity'], type: 'minmax', granularity: 2 });
    plan.tableComment.to = 'design test';
    const steps = await db.alterTableSql(W, plan);
    assert.deepStrictEqual(steps.map((x) => x.sql), [
      'ALTER TABLE `lookup_test`.`Design_Me` MODIFY COLUMN `city` LowCardinality(String)',
      'ALTER TABLE `lookup_test`.`Design_Me` MODIFY COLUMN `city` REMOVE DEFAULT',
      'ALTER TABLE `lookup_test`.`Design_Me` RENAME COLUMN `qty` TO `quantity`',
      'ALTER TABLE `lookup_test`.`Design_Me` MODIFY COLUMN `quantity` Nullable(Int64)',
      "ALTER TABLE `lookup_test`.`Design_Me` COMMENT COLUMN `quantity` 'how many'",
      "ALTER TABLE `lookup_test`.`Design_Me` ADD COLUMN `note` String DEFAULT '' COMMENT 'free text'",
      'ALTER TABLE `lookup_test`.`Design_Me` ADD CONSTRAINT `Design_Me_chk` CHECK quantity >= 0',
      'ALTER TABLE `lookup_test`.`Design_Me` ADD INDEX `Design_Me_quantity_idx` `quantity` TYPE minmax GRANULARITY 2',
      'ALTER TABLE `lookup_test`.`Design_Me` MATERIALIZE INDEX `Design_Me_quantity_idx`',
      "ALTER TABLE `lookup_test`.`Design_Me` MODIFY COMMENT 'design test'",
    ]);
    let r = await db.alterTable(W, plan);
    assert.ok(r.ok, r.error);
    let st = await db.structure(W, S, 'Design_Me');
    const c2 = Object.fromEntries(st.columns.map((c) => [c.name, c]));
    assert.strictEqual(c2.city.fullType, 'LowCardinality(String)');
    assert.strictEqual(c2.city.default, null);
    assert.strictEqual(c2.quantity.fullType, 'Nullable(Int64)');
    assert.strictEqual(c2.quantity.comments, 'how many');
    assert.deepStrictEqual(st.columns.map((c) => c.name), ['id', 'created', 'city', 'quantity', 'note']);
    assert.ok(st.constraints.find((k) => k.name === 'Design_Me_chk' && k.type === 'CHECK'));
    assert.ok(st.indexes.find((i) => i.name === 'Design_Me_quantity_idx' && /minmax · granularity 2/.test(i.type)));
    assert.strictEqual(st.tableComment, 'design test');
    const sums = await one('SELECT toString(sum(quantity)) AS s, any(city) AS c FROM lookup_test.Design_Me');
    assert.deepStrictEqual(sums, { s: '12', c: 'Cairo' });

    // A key row can't be dropped; a failing step stops and reports what ran (no transactions).
    plan = await planOf();
    await assert.rejects(db.alterTableSql(W, { ...plan, dropConstraints: ['PRIMARY KEY'] }), /part of its engine settings/);
    plan.dropConstraints.push('Design_Me_chk');
    plan.dropIndexes.push('Design_Me_quantity_idx');
    plan.columns.find((c) => c.name === 'id').drop = true; // a key column: the server refuses
    r = await db.alterTable(W, plan);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.done.map((x) => x.label), ['Drop constraint Design_Me_chk', 'Drop index Design_Me_quantity_idx']);
    assert.strictEqual(r.failed.label, 'Drop column id');
    assert.ok(!r.rolledBack);
    st = await db.structure(W, S, 'Design_Me');
    assert.ok(!st.constraints.find((k) => k.name === 'Design_Me_chk'));
    assert.strictEqual(st.indexes.length, 0);

    await db.truncateTable(W, S, 'Design_Me');
    assert.deepStrictEqual(await one('SELECT toString(count()) AS n FROM lookup_test.Design_Me'), { n: '0' });
    await db.dropTable(W, S, 'Design_Me');
    assert.ok(!(await db.objects(W, S)).some((o) => o.name === 'Design_Me'));
    await db.createTable(W, { owner: S, name: 'log_t', engine: 'Log', columns: [{ name: 'x', type: 'String', nullable: true }], primaryKey: [] });
    assert.match((await db.ddl(W, S, 'log_t', 'TABLE')), /`x` Nullable\(String\)\n\)\nENGINE = Log/);
    await db.dropTable(W, S, 'log_t');
  });

  await t('an unreachable server is reported as lost; Reconnect opens again', async () => {
    const lost = [];
    db.setOnLost((id, msg) => lost.push(msg));
    await db.connect(W + 1, { ...cfg, port: 1 }).catch((e) => lost.push('connect: ' + e.code));
    assert.match(lost[0], /^connect: ECONNREFUSED/);
    const info = await db.reconnect(W);
    assert.strictEqual(info.engine.id, 'clickhouse');
  });

  await db.disconnect(W);
  await admin.command({ query: 'DROP DATABASE lookup_test' });
  await admin.close();
  console.log(`\n${passed} ClickHouse tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
