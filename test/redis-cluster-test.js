// Redis Cluster against a real 3-master cluster: key slots, routing by key, pipelines split per node,
// MOVED after a stale slot map, scanning every master, Workbench routing (key / picked node / all
// masters), the Shell following redirects exactly like redis-cli -c, Overview per node. Flushes the cluster.
// Run: node test/redis-cluster-test.js   (cluster from LOOKUP_REDIS_CLUSTER_URL, default redis://lookup:lookup@127.0.0.1:7000)
// Skips (exit 0) when no cluster answers.
const assert = require('assert');
const { spawnSync } = require('child_process');
const db = require('../src/main/db');
const { open, Pipe, Cmd } = require('../src/main/db/redis/connect');
const { slotOf, crc16 } = require('../src/main/db/redis/cluster');
const { formatTTY } = require('../src/shared/redis-cli');

const u = new URL(process.env.LOOKUP_REDIS_CLUSTER_URL || 'redis://lookup:lookup@127.0.0.1:7000');
const cfg = { engine: 'redis', host: u.hostname, port: Number(u.port) || 7000, database: 0, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: 'disable' };
const W = 601;
const op = (name, p) => db.engineOp(W, name, p);
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ok ', name); };

(async () => {
  let admin;
  try { admin = await open(cfg); } catch (e) { console.log(`Redis Cluster tests skipped: ${e.message}`); return; }
  if (!admin.cluster) { console.log('Redis Cluster tests skipped: the server is not a cluster'); await admin.close(); return; }
  await Promise.all(admin.masterIds().map((id) => admin.execute(new Cmd(['FLUSHALL'], id))));

  await t('key slots: CRC16, hash tags', async () => {
    assert.strictEqual(crc16(Buffer.from('123456789')), 0x31c3);
    assert.strictEqual(slotOf('foo'), 12182);
    assert.strictEqual(slotOf('hello'), 866);
    assert.strictEqual(slotOf('{user1000}.following'), slotOf('{user1000}.followers'));
    assert.strictEqual(slotOf('{}x'), crc16(Buffer.from('{}x')) % 16384); // empty tag: the whole key
  });

  await t('pipelines over many slots are split per node and come back in order', async () => {
    const cmds = Array.from({ length: 600 }, (_, i) => ['SET', `k:${i}`, String(i)]);
    const r = await admin.execute(new Pipe(cmds));
    assert.ok(r.every((x) => x === 'OK'));
    const back = await admin.execute(new Pipe(Array.from({ length: 600 }, (_, i) => ['GET', `k:${i}`])));
    assert.deepStrictEqual(back, Array.from({ length: 600 }, (_, i) => String(i)));
    await admin.execute(new Cmd(['HSET', 'user:{42}:profile', 'name', 'Ali', 'plan', 'pro']));
    await admin.execute(new Cmd(['SET', 'foo', 'bar']));
    await admin.execute(new Cmd(['SET', 'hello', 'world']));
    await admin.execute(new Cmd(['RPUSH', 'queue', 'a', 'b', 'c']));
  });

  await t('connect detects the cluster: masters, database 0 only, key count over all masters', async () => {
    const info = await db.connect(W, cfg);
    assert.deepStrictEqual(info.cluster, { masters: 3 });
    const ks = await op('keyspace');
    assert.strictEqual(ks.cluster.masters, 3);
    assert.strictEqual(ks.dbSize, 604);
    assert.strictEqual(ks.count, 1);
    await assert.rejects(op('selectDb', { index: 1 }), /only database 0/);
  });

  await t('scan walks every master in turn', async () => {
    let cursor = '0'; const seen = new Set(); let steps = 0;
    do { const r = await op('scan', { cursor, match: 'k:*' }); r.keys.forEach((k) => seen.add(k.key)); cursor = r.cursor; steps++; } while (cursor !== '0');
    assert.strictEqual(seen.size, 600);
    assert.ok(steps >= 2);
    const one = await op('scan', { match: 'foo' });
    assert.deepStrictEqual(one.keys.map((k) => [k.key, k.type]), [['foo', 'string']]);
  });

  await t('key tabs read and change keys on whichever node holds them', async () => {
    assert.strictEqual((await op('load', { key: 'foo', type: 'string' })).value, 'bar'); // 7002
    assert.strictEqual((await op('load', { key: 'hello', type: 'string' })).value, 'world'); // 7000
    assert.strictEqual((await op('keyInfo', { key: 'queue' })).length, 3);
    await op('apply', { key: 'user:{42}:profile', commands: [['HSET', 'user:{42}:profile', 'plan', 'business'], ['HDEL', 'user:{42}:profile', 'name']] });
    assert.deepStrictEqual(await admin.execute(new Cmd(['HGETALL', 'user:{42}:profile'])), ['plan', 'business']);
    assert.strictEqual((await op('remove', { keys: ['k:1', 'k:2', 'k:3'] })).removed, 3); // three slots
    await op('create', { key: 'new:z', type: 'zset', member: 'm', score: '2', ttl: 60 });
    assert.strictEqual(await admin.execute(new Cmd(['ZSCORE', 'new:z', 'm'])), '2');
  });

  await t('a stale slot map is fixed by MOVED (and the command still answers)', async () => {
    const s = require('../src/main/db/common/sessions').sessions.get(W);
    s.conn.slots.fill('127.0.0.1:7000');
    assert.strictEqual((await op('load', { key: 'foo', type: 'string' })).value, 'bar');
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(s.conn.slots[slotOf('foo')], '127.0.0.1:7002');
  });

  await t('Workbench: keys go to their node; keyless to the picked node or every master', async () => {
    const g = await op('command', { args: ['GET', 'foo'] });
    assert.deepStrictEqual([g.reply.s, g.node], ['bar', '127.0.0.1:7002']);
    const enc = await op('command', { args: ['OBJECT', 'ENCODING', 'foo'] });
    assert.deepStrictEqual([enc.reply.s, enc.node], ['embstr', '127.0.0.1:7002']);
    const ev = await op('command', { args: ['EVAL', "return redis.call('GET', KEYS[1])", '1', 'foo'] });
    assert.strictEqual(ev.reply.s, 'bar');
    const all = await op('command', { args: ['DBSIZE'], node: 'all' });
    assert.strictEqual(all.replies.length, 3);
    assert.strictEqual(all.replies.reduce((a, x) => a + Number(x.reply.v), 0), 602);
    const one = await op('command', { args: ['DBSIZE'], node: '127.0.0.1:7001' });
    assert.strictEqual(one.node, '127.0.0.1:7001');
  });

  await t('Shell follows redirects exactly like redis-cli -c', async () => {
    const sh = await op('shellOpen', { id: 'c1' });
    assert.deepStrictEqual([sh.port, sh.cluster], [7000, true]);
    const r = await op('shellRun', { id: 'c1', args: ['get', 'foo'] });
    const mine = [...r.redirects, formatTTY(r.reply)].join('\n');
    assert.strictEqual(r.port, 7002);
    const real = spawnSync('redis-cli', ['-c', '-h', cfg.host, '-p', '7000', '--user', cfg.user, '--pass', cfg.password, '--no-auth-warning', '--no-raw'], { input: 'get foo\n', encoding: 'utf8' });
    if (!real.error) assert.strictEqual(mine, real.stdout.trim());
    else assert.strictEqual(mine, '-> Redirected to slot [12182] located at 127.0.0.1:7002\n"bar"');
    const back = await op('shellRun', { id: 'c1', args: ['get', 'hello'] });
    assert.deepStrictEqual([back.redirects, back.port], [['-> Redirected to slot [866] located at 127.0.0.1:7000'], 7000]);
    const same = await op('shellRun', { id: 'c1', args: ['get', 'hello'] });
    assert.deepStrictEqual(same.redirects, []);
    await op('shellClose', { id: 'c1' });
  });

  await t('Overview: totals over the masters and one row per node', async () => {
    const o = await op('overview');
    assert.strictEqual(o.mode, 'cluster');
    assert.strictEqual(o.nodes.length, 3);
    assert.strictEqual(o.nodes.reduce((a, n) => a + n.slots, 0), 16384);
    assert.strictEqual(o.keyspace[0].keys, 602);
    assert.ok(o.usedMemory > o.nodes[0].usedMemory);
  });

  await db.disconnect(W);
  await Promise.all(admin.masterIds().map((id) => admin.execute(new Cmd(['FLUSHALL'], id))));
  await admin.close();
  console.log(`redis-cluster-test: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
