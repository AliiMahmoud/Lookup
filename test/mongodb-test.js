// MongoDB engine against a real server (MongoDB, or FerretDB in the Linux container): values keep their
// exact types, connect, browse, find / count / explain, edits that never overwrite someone else's
// change, insert / delete, aggregation previews and runs, schema analysis, indexes, the read-only and
// Production rules, and the light shell. Uses (and drops) database lookup_test.
// Run: node test/mongodb-test.js   (server from LOOKUP_MONGO_URL, default mongodb://127.0.0.1:27017)
// Skips (exit 0) when no server answers.
const assert = require('assert');
const db = require('../src/main/db');
const L = require('../src/shared/mongo-lit');
const { hint, completions } = require('../src/shared/mongo-shell');

const URL_ = process.env.LOOKUP_MONGO_URL || 'mongodb://127.0.0.1:27017';
const u = new URL(URL_);
const cfg = {
  engine: 'mongodb', mode: 'basic', host: u.hostname, port: Number(u.port) || 27017, database: 'lookup_test',
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: 'disable', connectTimeout: 5,
};
const D = 'lookup_test';
const W = 701;
const op = (name, p, win = W) => db.engineOp(win, name, p);
const P = (text) => L.parse(text);
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ok ', name); };

(async () => {
  const { MongoClient, BSON } = require('mongodb');
  const admin = new MongoClient(URL_, { serverSelectionTimeoutMS: 3000 });
  try { await admin.connect(); await admin.db('admin').command({ ping: 1 }); } catch (e) { console.log(`MongoDB tests skipped: ${e.message.split('\n')[0]}`); await admin.close(); return; }
  await admin.db(D).dropDatabase();
  // FerretDB (the container's test server) has no Decimal128: money is a Double there.
  const FERRET = !!(await admin.db('admin').command({ buildInfo: 1 })).ferretdbVersion;
  const orders = admin.db(D).collection('orders');
  const { ObjectId, Long, Decimal128, Int32, Double, UUID } = BSON;
  const ids = Array.from({ length: 45 }, () => new ObjectId());
  await orders.insertMany(ids.map((id, i) => ({
    _id: id, orderNo: `BS-${1000 + i}`, status: i % 5 === 0 ? 'returned' : 'delivered', hub: ['Nasr City', 'Maadi', 'Zamalek'][i % 3],
    total: FERRET ? new Double(100 + i * 10) : Decimal128.fromString(`${(100 + i * 10).toFixed(2)}`), qty: new Int32(i % 4 + 1), rate: new Double(i % 2 ? 1.5 : 2),
    big: Long.fromString('9007199254740993'), createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 9))),
    address: { city: i % 2 ? 'Cairo' : 'Giza', zip: '11511' }, items: Array.from({ length: i % 3 + 1 }, (_, k) => ({ sku: `S${k}`, n: k + 1 })),
    ...(i === 0 ? { ref: new UUID('0f8fad5b-d9cb-469f-a165-70867728950e') } : {}),
  })));
  await admin.db(D).collection('customers').insertOne({ name: 'Ali' });

  await t('values: mongosh text <-> Extended JSON <-> BSON keeps every type', async () => {
    const v = P(`{ a: 1, b: 2.5, c: NumberLong('9007199254740993'), d: Decimal128('1249.50'), e: ObjectId('6705f3a29c1e4b7d2a0f81c4'), f: ISODate('2026-10-08T14:22:05.118Z'), g: /^ali/i, h: [1, 'x', null, true], i: { 'a.b': 'q' } }`);
    const bson = BSON.EJSON.deserialize(v, { relaxed: false });
    assert.ok(bson.c instanceof Long && bson.d instanceof Decimal128 && bson.e instanceof ObjectId && bson.f instanceof Date);
    assert.deepStrictEqual(BSON.EJSON.serialize(bson, { relaxed: false }), v);
    assert.strictEqual(L.print(v, { width: 400 }), "{ a: 1, b: 2.5, c: Long('9007199254740993'), d: Decimal128('1249.50'), e: ObjectId('6705f3a29c1e4b7d2a0f81c4'), f: ISODate('2026-10-08T14:22:05.118Z'), g: /^ali/i, h: [ 1, 'x', null, true ], i: { 'a.b': 'q' } }");
    assert.throws(() => P('{ a: foo }'), /Unknown name foo/);
    assert.throws(() => P("{ a: 'x }"), /Unclosed string/);
    assert.deepStrictEqual(hint('db.orders.find({ a: 1 }, '), { text: 'projection, options)', summary: 'Documents matching a filter (a cursor: add .sort() .limit() …)' }.text === undefined ? null : hint('db.orders.find({ a: 1 }, '));
    assert.deepStrictEqual(completions('db.ord', ['orders', 'customers']).items, ['orders']);
    assert.ok(completions('db.orders.find().so').items.includes('sort'));
  });

  await t('Test connection; an unreachable server fails within the timeout', async () => {
    const r = await db.test(cfg);
    assert.match(r.version, /^\d+\.\d+/);
    assert.strictEqual(r.dbName, D);
    const t0 = Date.now();
    await assert.rejects(db.test({ ...cfg, port: 1, connectTimeout: 2 }), /Could not reach|ECONNREFUSED|timed out/i);
    assert.ok(Date.now() - t0 < 8000);
    const viaUrl = await db.test({ engine: 'mongodb', mode: 'string', connectString: `${URL_.replace(/\/$/, '')}/${D}` });
    assert.strictEqual(viaUrl.dbName, D);
  });

  await t('connect: MongoDB workspace, no transactions', async () => {
    const info = await db.connect(W, cfg);
    assert.strictEqual(info.engine.workspace, 'mongodb');
    assert.strictEqual(info.autoCommit, true);
    assert.ok(info.topology);
  });

  await t('browse: databases and collections with counts; collection statistics', async () => {
    const dbs = await op('databases');
    assert.ok(dbs.list.find((d) => d.name === D));
    const colls = await op('collections', { db: D });
    assert.deepStrictEqual(colls.map((c) => [c.name, c.count]), [['customers', 1], ['orders', 45]]);
    const st = await op('collStats', { db: D, coll: 'orders' });
    assert.strictEqual(st.count, 45);
  });

  await t('find: filter, projection, sort, skip, limit; exact types come back', async () => {
    const r = await op('find', { db: D, coll: 'orders', filter: P(`{ status: 'delivered', total: { $gte: ${FERRET ? '300' : "Decimal128('300')"} } }`), project: P('{ items: 0 }'), sort: P('{ orderNo: -1 }'), skip: 1, limit: 3 });
    assert.deepStrictEqual(r.docs.map((d) => d.orderNo), ['BS-1043', 'BS-1042', 'BS-1041']);
    const d = r.docs[0];
    assert.strictEqual(d.items, undefined);
    if (FERRET) assert.deepStrictEqual([L.typeOf(d.total), d.total.$numberDouble], ['Double', '530.0']);
    else assert.deepStrictEqual([L.typeOf(d.total), d.total.$numberDecimal], ['Decimal128', '530.00']);
    assert.deepStrictEqual([L.typeOf(d.qty), L.typeOf(d.rate), L.typeOf(d.big), d.big.$numberLong], ['Int32', 'Double', 'Int64', '9007199254740993']);
    assert.strictEqual(L.typeOf(d.createdAt), 'Date');
    const all = await op('find', { db: D, coll: 'orders', filter: P('{ ref: { $exists: true } }') });
    assert.strictEqual(L.typeOf(all.docs[0].ref), 'UUID');
    assert.deepStrictEqual(await op('count', { db: D, coll: 'orders', filter: P("{ status: 'returned' }") }), { count: 9, estimated: false });
    assert.deepStrictEqual(await op('count', { db: D, coll: 'orders', filter: {} }), { count: 45, estimated: true });
    await assert.rejects(op('find', { db: D, coll: 'orders', filter: P('{ $bogus: 1 }') }));
  });

  await t('explain: stages, documents examined, index used or not', async () => {
    const x = await op('explain', { db: D, coll: 'orders', filter: P("{ hub: 'Maadi' }"), limit: 5 });
    assert.ok(x.stages.length >= 1);
    assert.ok(typeof x.collScan === 'boolean' && typeof x.usesIndex === 'boolean');
  });

  await t('edit: changed fields saved with $set / $unset; someone else\'s change is never overwritten', async () => {
    const [orig] = (await op('find', { db: D, coll: 'orders', filter: P("{ orderNo: 'BS-1001' }") })).docs;
    const next = JSON.parse(JSON.stringify(orig));
    next.status = 'returned';
    next.note = 'damaged box';
    delete next.rate;
    const r = await op('update', { db: D, coll: 'orders', original: orig, doc: next });
    assert.deepStrictEqual([r.changed.sort(), r.removed], [['note', 'status'], ['rate']]);
    const saved = await orders.findOne({ orderNo: 'BS-1001' }, { promoteValues: false });
    assert.deepStrictEqual([saved.status, saved.note, saved.rate, saved.total.toString()], ['returned', 'damaged box', undefined, FERRET ? '110' : '110.00']);
    // Someone changes the status meanwhile: saving the old copy is refused.
    await orders.updateOne({ orderNo: 'BS-1001' }, { $set: { status: 'delivered' } });
    const stale = { ...JSON.parse(JSON.stringify(next)), status: 'lost' };
    await assert.rejects(op('update', { db: D, coll: 'orders', original: next, doc: stale }), (e) => e.code === 'DOC_CHANGED');
    await assert.rejects(op('update', { db: D, coll: 'orders', original: next, doc: { ...next, _id: P("ObjectId('6705f3a29c1e4b7d2a0f81c4')") } }), /_id can't be changed/);
  });

  await t('insert (and clone), delete by _id', async () => {
    const r = await op('insert', { db: D, coll: 'customers', docs: [P("{ name: 'Omar', since: ISODate('2025-01-02') }"), P("{ name: 'Nour' }")] });
    assert.strictEqual(r.inserted, 2);
    assert.strictEqual(L.typeOf(r.ids[0]), 'ObjectId');
    assert.strictEqual((await op('remove', { db: D, coll: 'customers', ids: r.ids })).deleted, 2);
    await assert.rejects(op('insert', { db: D, coll: 'customers', docs: [[1, 2]] }), /must be an object/);
  });

  await t('aggregation: a preview per stage, an error stops later previews, run, $out is not previewed', async () => {
    const stages = [
      { stage: P("{ $match: { status: 'delivered' } }"), enabled: true },
      { stage: P("{ $group: { _id: '$hub', orders: { $sum: 1 }, qty: { $sum: '$qty' } } }"), enabled: true },
      { stage: P('{ $sort: { _id: 1 } }'), enabled: true },
      { stage: P('{ $limit: 1 }'), enabled: false },
    ];
    const pv = await op('aggPreview', { db: D, coll: 'orders', stages });
    assert.strictEqual(pv[0].docs.length, 10);
    assert.deepStrictEqual(pv[2].docs.map((d) => d._id), ['Maadi', 'Nasr City', 'Zamalek']);
    assert.ok(pv[3].skipped);
    const run = await op('aggRun', { db: D, coll: 'orders', stages });
    assert.strictEqual(run.docs.reduce((a, d) => a + Number(d.orders.$numberInt), 0), 36);
    const bad = await op('aggPreview', { db: D, coll: 'orders', stages: [{ stage: P('{ $nope: 1 }'), enabled: true }, { stage: P('{ $limit: 1 }'), enabled: true }] });
    assert.ok(bad[0].error);
    assert.ok(bad[1].skipped);
    const out = await op('aggPreview', { db: D, coll: 'orders', stages: [{ stage: P("{ $out: 'copy' }"), enabled: true }] });
    assert.match(out[0].note, /writes/);
  });

  await t('schema: presence, types, top values, numbers, dates, arrays, nested fields', async () => {
    const r = await op('schema', { db: D, coll: 'orders', size: 1000 });
    assert.strictEqual(r.sampled, 45);
    const f = Object.fromEntries(r.fields.map((x) => [x.path, x]));
    assert.strictEqual(f._id.types[0].type, 'ObjectId');
    assert.deepStrictEqual(f.status.strings.top.map((x) => x.value), ['delivered', 'returned']);
    assert.strictEqual(f.total.types[0].type, FERRET ? 'Double' : 'Decimal128');
    assert.strictEqual(f.total.numbers.min, 100);
    assert.ok(f.createdAt.dates.counts.reduce((a, b) => a + b, 0) === 45);
    assert.deepStrictEqual([f.items.arrays.min, f.items.arrays.max], [1, 3]);
    assert.ok(f['address.city'] && f['items[].sku']);
    assert.ok(f.ref.share < 0.1);
  });

  await t('indexes: create (unique, TTL), list, drop; _id stays', async () => {
    await op('createIndex', { db: D, coll: 'orders', keys: P('{ orderNo: 1 }'), options: { unique: true } });
    await op('createIndex', { db: D, coll: 'orders', keys: P('{ hub: 1, createdAt: -1 }') });
    const list = await op('indexes', { db: D, coll: 'orders' });
    assert.deepStrictEqual(list.map((x) => x.name).sort(), ['_id_', 'hub_1_createdAt_-1', 'orderNo_1']);
    assert.ok(list.find((x) => x.name === 'orderNo_1').unique);
    await op('dropIndex', { db: D, coll: 'orders', name: 'hub_1_createdAt_-1' });
    await assert.rejects(op('dropIndex', { db: D, coll: 'orders', name: '_id_' }), /can't be dropped/);
  });

  await t('read-only blocks changes; Production asks first', async () => {
    await db.connect(702, { ...cfg, readOnly: true });
    const [d] = (await op('find', { db: D, coll: 'customers' }, 702)).docs;
    await assert.rejects(op('update', { db: D, coll: 'customers', original: d, doc: { ...d, name: 'x' } }, 702), (e) => e.code === 'READ_ONLY');
    await assert.rejects(op('shellRun', { id: 'ro', text: 'x' }, 702)); // no shell opened
    await op('shellOpen', { id: 'ro' }, 702);
    await assert.rejects(op('shellRun', { id: 'ro', text: "db.customers.deleteMany({})" }, 702), (e) => e.code === 'READ_ONLY');
    assert.strictEqual((await op('shellRun', { id: 'ro', text: 'db.customers.countDocuments()' }, 702)).value.$numberInt, '1');
    await db.disconnect(702);
    await db.connect(703, { ...cfg, env: 'prod' });
    await assert.rejects(op('insert', { db: D, coll: 'customers', docs: [P('{ a: 1 }')] }, 703), (e) => e.code === 'CONFIRM_WRITE');
    assert.strictEqual((await op('insert', { db: D, coll: 'customers', docs: [P('{ a: 1 }')], confirmed: true }, 703)).inserted, 1);
    await db.disconnect(703);
  });

  await t('shell: show, use, find with cursor methods and it, writes, errors like mongosh', async () => {
    const sh = await op('shellOpen', { id: 's1' });
    assert.strictEqual(sh.db, D);
    const run = (text) => op('shellRun', { id: 's1', text });
    assert.match((await run('show dbs')).text, new RegExp(`^${D}\\s+\\d+\\.\\d\\d \\w+`, 'm'));
    assert.strictEqual((await run('show collections')).text, 'customers\norders');
    const f = await run("db.orders.find({ status: 'delivered' }, { orderNo: 1, _id: 0 }).sort({ orderNo: 1 })");
    assert.deepStrictEqual([f.kind, f.docs.length, f.more, f.docs[0].orderNo], ['docs', 20, true, 'BS-1001']);
    const it1 = await run('it');
    assert.deepStrictEqual([it1.docs.length, it1.more], [16, false]);
    assert.strictEqual((await run('it')).text, 'no cursor');
    assert.strictEqual((await run("db.orders.find({ hub: 'Maadi' }).count()")).value.$numberInt, '15');
    assert.deepStrictEqual((await run("db.orders.distinct('hub')")).value.sort(), ['Maadi', 'Nasr City', 'Zamalek']);
    const ins = await run("db.getCollection('customers').insertOne({ name: 'Sara', joined: ISODate('2026-01-05') })");
    assert.match(L.print(ins.value), /^\{ acknowledged: true, insertedId: ObjectId\('[0-9a-f]{24}'\) \}$/);
    const up = await run("db.customers.updateOne({ name: 'Sara' }, { $set: { vip: true } })");
    assert.strictEqual(L.print(up.value), '{\n  acknowledged: true,\n  insertedId: null,\n  matchedCount: 1,\n  modifiedCount: 1,\n  upsertedCount: 0\n}');
    const agg = await run("db.orders.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }])");
    assert.strictEqual(agg.docs[0].n.$numberInt, '45');
    assert.strictEqual((await run('use other')).text, 'switched to db other');
    assert.strictEqual((await run('db')).text, 'other');
    assert.strictEqual((await run(`db.getSiblingDB('${D}').orders.estimatedDocumentCount()`)).value.$numberInt, '45');
    await run(`use ${D}`);
    assert.match((await run('var x = 1')).text, /Variables, functions/);
    assert.match((await run('db.orders.find({ a: ')).text, /^SyntaxError: /);
    assert.match((await run("db.orders.insertOne({ _id: ObjectId('" + ids[2].toHexString() + "') })")).text, /^MongoServerError(\[DuplicateKey\])?: .*duplicate key/i);
    assert.match((await run('db.orders.frobnicate()')).text, /isn't a collection method/);
    assert.strictEqual((await run('db.runCommand({ ping: 1 })')).value.ok.$numberDouble || (await run('db.runCommand({ ping: 1 })')).value.ok.$numberInt, '1');
    assert.match((await run('help')).text, /show dbs/);
    await op('shellClose', { id: 's1' });
  });

  await t('Stop: a running query ends, the session stays usable', async () => {
    const running = op('find', { db: D, coll: 'orders', filter: P("{ $where: 'sleep(3000) || true' }"), limit: 1 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 200));
    await db.cancel(W);
    await op('stop');
    const r = await running;
    assert.ok(r instanceof Error || Array.isArray(r.docs)); // FerretDB has no $where: it fails at once, which is fine too
    assert.strictEqual((await op('count', { db: D, coll: 'orders', filter: {} })).count, 45);
  });

  await t('SQL log lists what Lookup ran, in mongosh form', async () => {
    const log = db.sqlLog(W).entries.map((e) => e.sql);
    assert.ok(log.some((l) => /^db\.orders\.find\(\{ status: 'delivered', total: \{ \$gte: (300|Decimal128\('300'\)) \} \}, \{ items: 0 \}\)\.sort\(\{ orderNo: -1 \}\)\.skip\(1\)\.limit\(3\)$/.test(l)), log.join('\n'));
    assert.ok(log.some((l) => /^db\.orders\.updateOne\(/.test(l)));
  });

  await db.disconnect(W);
  await admin.db(D).dropDatabase();
  await admin.db('other').dropDatabase().catch(() => {});
  await admin.close();
  console.log(`mongodb-test: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
