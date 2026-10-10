// Redis engine against a real server: protocol client, connect, key browser, key values, edits,
// read-only and Production rules, Workbench (Stop), Shell (SELECT, MULTI, SUBSCRIBE, MONITOR, Ctrl+C),
// replies printed exactly like redis-cli, Overview and lost connections. Uses database 9 (flushed).
// Run: node test/redis-test.js   (server from LOOKUP_REDIS_URL, default redis://lookup:lookup@127.0.0.1:6379)
// Skips (exit 0) when no server answers.
const assert = require('assert');
const { spawnSync } = require('child_process');
const db = require('../src/main/db');
const { RespClient, Parser } = require('../src/main/db/redis/resp');
const { parseLine, formatTTY, quoteArg } = require('../src/shared/redis-cli');
const { hintFor, kindOf } = require('../src/shared/redis-commands');

const u = new URL(process.env.LOOKUP_REDIS_URL || 'redis://lookup:lookup@127.0.0.1:6379');
const DB = 9;
const cfg = {
  engine: 'redis', host: u.hostname, port: Number(u.port) || 6379, database: DB,
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: u.protocol === 'rediss:' ? 'require' : 'disable',
};
const W = 501;
const op = (name, p, win = W) => db.engineOp(win, name, p);

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ok ', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the real redis-cli prints for a command (when installed), to compare our formatting with. */
function redisCli(args) {
  const r = spawnSync('redis-cli', ['-h', cfg.host, '-p', String(cfg.port), '--user', cfg.user, '--pass', cfg.password, '--no-auth-warning', '--no-raw', '-n', String(DB), ...args], { encoding: 'utf8' });
  if (r.error) return null;
  return r.stdout.replace(/\n$/, '');
}

(async () => {
  const admin = new RespClient();
  try {
    await admin.connect({ host: cfg.host, port: cfg.port, timeoutMs: 3000 });
    if (cfg.password) await admin.call('AUTH', cfg.user, cfg.password);
  } catch (e) { console.log(`Redis tests skipped: ${e.message}`); admin.destroy(); return; }
  await admin.call('SELECT', DB);
  await admin.call('FLUSHDB');

  await t('protocol: replies split at any byte, RESP3 types, errors are replies', async () => {
    const p = new Parser();
    const wire = Buffer.from('+OK\r\n:42\r\n$5\r\nhello\r\n$-1\r\n*2\r\n$1\r\na\r\n*1\r\n:1\r\n-ERR bad\r\n%1\r\n+k\r\n,1.5\r\n~1\r\n#t\r\n_\r\n>2\r\n+message\r\n$2\r\nhi\r\n');
    const got = [];
    for (const b of wire) { p.feed(Buffer.from([b])); let r; while ((r = p.next()) !== undefined) got.push(r); }
    assert.deepStrictEqual(got.map((r) => r.t), ['status', 'int', 'bulk', 'nil', 'array', 'error', 'map', 'set', 'nil', 'push']);
    assert.strictEqual(got[2].v.toString(), 'hello');
    assert.strictEqual(got[6].v[0][1].v, '1.5');
  });

  await t('redis-cli line splitting, hints and write detection', async () => {
    assert.deepStrictEqual(parseLine(`SET "a b" 'it\\'s' "\\x41\\n" x`).args, ['SET', 'a b', "it's", 'A\n', 'x']);
    assert.deepStrictEqual(parseLine('GET "\\xff"').args[1], { b64: '/w==' });
    assert.ok(parseLine('GET "abc"x').error);
    assert.ok(parseLine('GET "abc').error);
    assert.strictEqual(quoteArg('a b'), '"a b"');
    assert.strictEqual(hintFor(['HSET', 'k'], true), 'field value [field value ...]');
    assert.strictEqual(hintFor(['ZADD'], true), 'key [NX|XX] [GT|LT] [CH] [INCR] score member [score member ...]');
    assert.strictEqual(kindOf(['config', 'set', 'x', 'y']), 'admin');
    assert.strictEqual(kindOf(['get', 'x']), 'read');
    assert.strictEqual(kindOf(['JSON.SET']), 'write');
  });

  await t('Test connection: version and database; wrong password and bad URL fail clearly', async () => {
    const r = await db.test(cfg);
    assert.match(r.version, /^\d+\.\d+/);
    assert.strictEqual(r.schema, `db${DB}`);
    await assert.rejects(db.test({ ...cfg, password: 'nope' }), /Wrong username or password/);
    const url = await db.test({ engine: 'redis', mode: 'string', connectString: `redis://${cfg.user}@${cfg.host}:${cfg.port}/3`, password: cfg.password });
    assert.strictEqual(url.schema, 'db3');
    await assert.rejects(db.test({ engine: 'redis', mode: 'string', connectString: 'http://x' }), /redis:\/\//);
  });

  await t('connect: Redis profile, no transactions, target key per database', async () => {
    const info = await db.connect(W, cfg);
    assert.strictEqual(info.engine.id, 'redis');
    assert.strictEqual(info.engine.workspace, 'redis');
    assert.strictEqual(info.autoCommit, true);
    assert.notStrictEqual(db.targetKey(cfg), db.targetKey({ ...cfg, database: 2 }));
  });

  // Seed data.
  await admin.call('MSET', 'user:1:name', 'Ali', 'user:2:name', 'Omar', 'counter', '7', 'جملة', 'نص عربي');
  await admin.call('SET', 'session:abc', JSON.stringify({ user: 1, roles: ['admin'] }), 'EX', 3600);
  await admin.call('SET', Buffer.from([0xff, 0x00, 0x01]), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  await admin.call('HSET', 'user:1:profile', 'name', 'Ali', 'email', 'ali@example.com', 'plan', 'pro');
  await admin.call('RPUSH', 'queue', ...Array.from({ length: 250 }, (_, i) => `job-${i}`));
  await admin.call('SADD', 'tags', 'red', 'green', 'blue');
  await admin.call('ZADD', 'board', 100, 'alice', 250.5, 'bob', 50, 'carol');
  await admin.call('XADD', 'events', '1-1', 'type', 'login');
  await admin.call('XADD', 'events', '1-2', 'type', 'click');
  await admin.call('XADD', 'events', '2-0', 'type', 'logout');
  for (let i = 0; i < 1500; i += 100) await admin.call('MSET', ...Array.from({ length: 100 }, (_, j) => [`bulk:${i + j}`, 'x']).flat());

  await t('databases: keyspace with key counts; switching database in place', async () => {
    const ks = await op('keyspace');
    assert.strictEqual(ks.current, DB);
    assert.ok(ks.count >= 16);
    assert.ok(ks.dbs.find((d) => d.index === DB).keys >= 1500);
    await admin.call('SELECT', 8);
    await admin.call('SET', 'only-in-8', '1');
    await admin.call('SELECT', DB);
    const r = await op('selectDb', { index: 8 });
    assert.strictEqual(r.current, 8);
    assert.deepStrictEqual((await op('scan', { match: 'only-in-8' })).keys.map((k) => k.key), ['only-in-8']);
    await op('selectDb', { index: DB });
    await admin.call('SELECT', 8); await admin.call('DEL', 'only-in-8'); await admin.call('SELECT', DB);
  });

  await t('scan: patterns, plain text = contains (exact key first), type filter, steps until done', async () => {
    const users = await op('scan', { match: 'user:*' });
    assert.deepStrictEqual(users.keys.map((k) => k.key).sort(), ['user:1:name', 'user:1:profile', 'user:2:name']);
    assert.ok(users.done);
    const prof = users.keys.find((k) => k.key === 'user:1:profile');
    assert.strictEqual(prof.type, 'hash');
    assert.strictEqual(prof.ttl, -1);
    assert.ok(prof.size > 0);
    const sess = (await op('scan', { match: 'session' })).keys[0];
    assert.strictEqual(sess.key, 'session:abc');
    assert.ok(sess.ttl > 3500 * 1000);
    const exact = await op('scan', { match: 'counter' });
    assert.strictEqual(exact.keys[0].key, 'counter');
    assert.deepStrictEqual((await op('scan', { type: 'zset' })).keys.map((k) => k.key), ['board']);
    assert.deepStrictEqual((await op('scan', { type: 'stream' })).keys.map((k) => k.key), ['events']);
    // Browsing many keys arrives in steps (a filter reads 5,000 keys per round trip, so bulk:* comes at once).
    let cursor = '0'; let all = 0; let steps = 0;
    do { const r = await op('scan', { cursor }); all += r.keys.filter((k) => /^bulk:/.test(k.key)).length; cursor = r.cursor; steps++; } while (cursor !== '0');
    assert.strictEqual(all, 1500);
    assert.ok(steps > 1);
    cursor = '0'; all = 0;
    do { const r = await op('scan', { cursor, match: 'bulk:*' }); all += r.keys.length; cursor = r.cursor; } while (cursor !== '0');
    assert.strictEqual(all, 1500);
    const bin = (await op('scan', { match: '*' })).keys;
    assert.ok(bin.find((k) => k.key && k.key.b64 === Buffer.from([0xff, 0, 1]).toString('base64')));
    assert.ok(bin.find((k) => k.key === 'جملة'));
  });

  await t('search reaches every key: 80,000 keys, plain text in any case, searched step by step until found', async () => {
    for (let i = 0; i < 80000; i += 2000) await admin.call('MSET', ...Array.from({ length: 2000 }, (_, j) => [`big:${i + j}:item`, 'x']).flat());
    await admin.call('SET', 'deep:Customer:Needle-42', 'here');
    // What the window does: keep asking while nothing is found and the database isn't fully searched.
    const search = async (match) => {
      let cursor = '0'; const found = []; let calls = 0;
      do { const r = await op('scan', { cursor, match }); found.push(...r.keys.map((k) => k.key)); cursor = r.cursor; calls++; if (r.done) break; } while (!found.length);
      return { found, calls };
    };
    assert.deepStrictEqual((await search('needle-42')).found, ['deep:Customer:Needle-42']); // lower case finds it
    assert.deepStrictEqual((await search('CUSTOMER:NEEDLE')).found, ['deep:Customer:Needle-42']);
    assert.deepStrictEqual((await search('deep:*')).found, ['deep:Customer:Needle-42']); // patterns stay as typed
    assert.deepStrictEqual((await search('deep:customer*')).found, []); // …and case-sensitive, like Redis
    const none = await search('no-such-key-anywhere');
    assert.deepStrictEqual(none.found, []);
    for (let i = 0; i < 80000; i += 5000) await admin.call('DEL', ...Array.from({ length: 5000 }, (_, j) => `big:${i + j}:item`));
    await admin.call('DEL', 'deep:Customer:Needle-42');
  });

  await t('key info and values: string (JSON, Arabic, binary), hash, list pages, set, zset order, stream pages', async () => {
    const info = await op('keyInfo', { key: 'user:1:profile' });
    assert.deepStrictEqual([info.type, info.length, info.ttl], ['hash', 3, -1]);
    assert.ok(info.encoding);
    assert.strictEqual((await op('keyInfo', { key: 'missing' })).exists, false);
    assert.deepStrictEqual(JSON.parse((await op('load', { key: 'session:abc', type: 'string' })).value), { user: 1, roles: ['admin'] });
    assert.strictEqual((await op('load', { key: 'جملة', type: 'string' })).value, 'نص عربي');
    const b = await op('load', { key: { b64: Buffer.from([0xff, 0, 1]).toString('base64') }, type: 'string' });
    assert.deepStrictEqual(b.value, { b64: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64') });
    const h = await op('load', { key: 'user:1:profile', type: 'hash' });
    assert.strictEqual(h.total, 3);
    assert.deepStrictEqual(Object.fromEntries(h.items.map((x) => [x.field, x.value])), { name: 'Ali', email: 'ali@example.com', plan: 'pro' });
    assert.deepStrictEqual((await op('load', { key: 'user:1:profile', type: 'hash', filter: 'em' })).items.map((x) => x.field), ['email']);
    const l = await op('load', { key: 'queue', type: 'list', start: 100 });
    assert.strictEqual(l.total, 250);
    assert.deepStrictEqual([l.items[0].index, l.items[0].value, l.items.length], [100, 'job-100', 100]);
    assert.strictEqual((await op('load', { key: 'tags', type: 'set' })).items.length, 3);
    const zd = await op('load', { key: 'board', type: 'zset' });
    assert.deepStrictEqual(zd.items.map((x) => [x.member, x.score]), [['bob', '250.5'], ['alice', '100'], ['carol', '50']]);
    assert.deepStrictEqual((await op('load', { key: 'board', type: 'zset', order: 'asc' })).items[0].member, 'carol');
    assert.deepStrictEqual((await op('load', { key: 'board', type: 'zset', filter: 'al' })).items.map((x) => x.member), ['alice']);
    const s1 = await op('load', { key: 'events', type: 'stream', count: 2 });
    assert.deepStrictEqual(s1.entries.map((e) => e.id), ['2-0', '1-2']);
    assert.strictEqual(s1.next, '1-1');
    const s2 = await op('load', { key: 'events', type: 'stream', count: 2, end: s1.next });
    assert.deepStrictEqual(s2.entries.map((e) => [e.id, e.fields[0][1]]), [['1-1', 'login']]);
    assert.strictEqual(s2.next, null);
  });

  await t('edits run together in MULTI / EXEC and only for the tab\'s key', async () => {
    await op('apply', { key: 'user:1:profile', commands: [['HSET', 'user:1:profile', 'plan', 'business'], ['HSET', 'user:1:profile', 'city', 'Cairo'], ['HDEL', 'user:1:profile', 'email']] });
    assert.deepStrictEqual(await admin.call('HGETALL', 'user:1:profile'), ['name', 'Ali', 'plan', 'business', 'city', 'Cairo']);
    await assert.rejects(op('apply', { key: 'user:1:profile', commands: [['HSET', 'other', 'a', 'b']] }), /key in this tab/);
    await assert.rejects(op('apply', { key: 'user:1:profile', commands: [['FLUSHDB']] }), /can't be used/);
    // A list element removed by index (LSET to a marker, then LREM), as the list tab does.
    await op('apply', { key: 'queue', commands: [['LSET', 'queue', 0, '__lookup_rm__'], ['LREM', 'queue', 1, '__lookup_rm__']] });
    assert.strictEqual(await admin.call('LINDEX', 'queue', 0), 'job-1');
    await op('apply', { key: 'board', commands: [['ZADD', 'board', '300', 'alice']] });
    assert.strictEqual(await admin.call('ZSCORE', 'board', 'alice'), '300');
  });

  await t('time to live, rename (never overwrites), delete, new keys of every type', async () => {
    const r = await op('setTtl', { key: 'counter', seconds: 120 });
    assert.ok(r.ttl > 100000 && r.ttl <= 120000);
    assert.strictEqual((await op('setTtl', { key: 'counter', seconds: null })).ttl, -1);
    await op('rename', { key: 'counter', to: 'counter2' });
    await assert.rejects(op('rename', { key: 'counter2', to: 'user:2:name' }), /already exists/);
    assert.strictEqual(await admin.call('GET', 'counter2'), '7');
    assert.strictEqual((await op('remove', { keys: ['counter2', 'user:2:name'] })).removed, 2);
    await op('create', { key: 'new:s', type: 'string', value: 'v', ttl: 60 });
    await op('create', { key: 'new:h', type: 'hash', field: 'f', value: 'v' });
    await op('create', { key: 'new:l', type: 'list', value: 'v' });
    await op('create', { key: 'new:set', type: 'set', member: 'm' });
    await op('create', { key: 'new:z', type: 'zset', member: 'm', score: '1.5' });
    await op('create', { key: 'new:x', type: 'stream', field: 'f', value: 'v' });
    assert.ok((await admin.call('TTL', 'new:s')) > 50);
    assert.deepStrictEqual(await Promise.all(['new:h', 'new:l', 'new:set', 'new:z', 'new:x'].map((k) => admin.call('TYPE', k))), ['hash', 'list', 'set', 'zset', 'stream']);
    await assert.rejects(op('create', { key: 'new:s', type: 'string', value: 'x' }), /already exists/);
    await assert.rejects(op('create', { key: 'new:z2', type: 'zset', member: 'm', score: 'abc' }), /must be a number/);
  });

  await t('read-only connection blocks writes (also unknown ones the server flags); Production asks first', async () => {
    await db.connect(502, { ...cfg, readOnly: true });
    await assert.rejects(db.engineOp(502, 'command', { args: ['SET', 'a', 'b'] }), (e) => e.code === 'READ_ONLY');
    await assert.rejects(db.engineOp(502, 'command', { args: ['CONFIG', 'SET', 'maxmemory', '1'] }), (e) => e.code === 'READ_ONLY');
    await assert.rejects(db.engineOp(502, 'apply', { key: 'tags', commands: [['SADD', 'tags', 'x']] }), (e) => e.code === 'READ_ONLY');
    assert.strictEqual((await db.engineOp(502, 'command', { args: ['GET', 'user:1:name'] })).reply.s, 'Ali');
    // A command missing from Lookup's list: the server's COMMAND INFO says it writes.
    await assert.rejects(db.engineOp(502, 'command', { args: ['GEORADIUS', 'geo', '0', '0', '1', 'km'] }), (e) => e.code === 'READ_ONLY');
    await db.disconnect(502);
    await db.connect(503, { ...cfg, env: 'prod' });
    await assert.rejects(db.engineOp(503, 'command', { args: ['DEL', 'tags'] }), (e) => e.code === 'CONFIRM_WRITE');
    assert.strictEqual((await db.engineOp(503, 'command', { args: ['EXISTS', 'tags'] })).reply.v, '1');
    assert.strictEqual((await db.engineOp(503, 'command', { args: ['SET', 'p', '1'], confirmed: true })).reply.v, 'OK');
    await db.disconnect(503);
  });

  await t('delete by pattern: counted first, deleted in steps, only matching keys; read-only blocks, Production asks', async () => {
    for (let i = 0; i < 6000; i += 1000) await admin.call('MSET', ...Array.from({ length: 1000 }, (_, j) => [`gone:${i + j}`, 'x']).flat());
    await admin.call('SET', 'gone', 'not under the folder'); await admin.call('SET', 'gonex:1', 'other folder'); await admin.call('SET', 'a*b:1', 'glob');
    const walk = async (name, params) => { let cursor = '0'; let n = 0; let steps = 0; for (;;) { const r = await op(name, { ...params, cursor }); n += r.count ?? r.deleted; cursor = r.cursor; steps++; if (r.done) return { n, steps }; } };
    assert.strictEqual((await walk('countMatching', { pattern: 'gone:*' })).n, 6000);
    await assert.rejects(op('deleteMatching', { pattern: '*' }), /not every key/);
    await assert.rejects(op('countMatching', { pattern: '' }), /not every key/);
    await db.connect(504, { ...cfg, readOnly: true });
    await assert.rejects(db.engineOp(504, 'deleteMatching', { pattern: 'gone:*' }), (e) => e.code === 'READ_ONLY');
    await db.disconnect(504);
    await db.connect(505, { ...cfg, env: 'prod' });
    await assert.rejects(db.engineOp(505, 'deleteMatching', { pattern: 'gone:*' }), (e) => e.code === 'CONFIRM_WRITE');
    await db.disconnect(505);
    assert.strictEqual(Number(await admin.call('EXISTS', 'gone:1')), 1); // nothing was deleted by the refused calls
    assert.strictEqual((await walk('deleteMatching', { pattern: 'gone:*' })).n, 6000);
    assert.strictEqual((await walk('countMatching', { pattern: 'gone:*' })).n, 0);
    assert.deepStrictEqual(await Promise.all(['gone', 'gonex:1', 'a*b:1'].map(async (k) => Number(await admin.call('EXISTS', k)))), [1, 1, 1]);
    // A folder name with glob characters is escaped by the window: a\*b:* matches only that folder.
    assert.strictEqual((await walk('deleteMatching', { pattern: 'a\\*b:*' })).n, 1);
    await admin.call('DEL', 'gone', 'gonex:1');
  });

  await t('Workbench replies print exactly like redis-cli', async () => {
    await admin.call('RPUSH', 'nest', ...Array.from({ length: 12 }, (_, i) => `n${i}`));
    const cmds = [
      ['GET', 'user:1:name'], ['GET', 'nothing'], ['SET', 'x', 'y'], ['INCR', 'num'], ['HGETALL', 'user:1:profile'],
      ['LRANGE', 'nest', '0', '-1'], ['XRANGE', 'events', '-', '+'], ['LRANGE', 'empty', '0', '-1'], ['GET', 'جملة'],
      ['ZRANGE', 'board', '0', '-1', 'WITHSCORES'], ['HSET', 'user:1:profile'], ['SET', 'q', 'a"b\\c\n'], ['GET', 'q'],
    ];
    let compared = 0;
    for (const c of cmds) {
      const mine = formatTTY((await op('command', { args: c })).reply);
      if (c[0] === 'INCR' || c[0] === 'SET') continue; // would run twice with redis-cli
      const real = redisCli(c);
      if (real === null) continue;
      // redis-cli prints errors as "(error) …" in a terminal; captured output drops the prefix.
      assert.strictEqual(mine.replace(/^\(error\) /, ''), real.replace(/^\(error\) /, ''), `${c.join(' ')}\n--- Lookup ---\n${mine}\n--- redis-cli ---\n${real}`);
      compared++;
    }
    assert.strictEqual(formatTTY((await op('command', { args: ['GET', 'nothing'] })).reply), '(nil)');
    assert.strictEqual(formatTTY((await op('command', { args: ['SET', 'x', 'y'] })).reply), 'OK');
    assert.match(formatTTY((await op('command', { args: ['INCR', 'num'] })).reply), /^\(integer\) \d+$/);
    console.log(`       (${compared} replies compared with the real redis-cli)`);
    await assert.rejects(op('command', { args: ['SUBSCRIBE', 'c'] }), /Shell tab/);
    await assert.rejects(op('command', { args: ['SELECT', '1'] }), /key browser/);
  });

  await t('Workbench Stop releases a blocking command; the Workbench works again after', async () => {
    const running = op('command', { args: ['BLPOP', 'never', '0'] });
    await sleep(150);
    await db.cancel(W); // the toolbar Stop goes through the engine's cancel
    await op('stop');
    const r = await running;
    assert.strictEqual(r.reply.t, 'error');
    assert.match(r.reply.v, /UNBLOCKED|Stopped/);
    assert.strictEqual((await op('command', { args: ['PING'] })).reply.v, 'PONG');
  });

  await t('Shell: own database (SELECT), MULTI / EXEC, SUBSCRIBE messages, Ctrl+C, MONITOR', async () => {
    const pushes = [];
    db.setOnPush((win, msg) => { if (win === W) pushes.push(msg); });
    const sh = await op('shellOpen', { id: 's1' });
    assert.deepStrictEqual([sh.host, sh.port, sh.db], [cfg.host, cfg.port, DB]);
    const sel = await op('shellRun', { id: 's1', args: ['SELECT', '2'] });
    assert.strictEqual(sel.db, 2);
    assert.strictEqual((await op('keyspace')).current, DB); // the key browser is not moved
    assert.strictEqual((await op('shellRun', { id: 's1', args: ['MULTI'] })).tx, true);
    assert.strictEqual((await op('shellRun', { id: 's1', args: ['INCR', 'shell-n'] })).reply.v, 'QUEUED');
    const ex = await op('shellRun', { id: 's1', args: ['EXEC'] });
    assert.strictEqual(ex.tx, false);
    assert.strictEqual(formatTTY(ex.reply), '1) (integer) 1');
    const sub = await op('shellRun', { id: 's1', args: ['SUBSCRIBE', 'news', 'alerts'] });
    assert.strictEqual(sub.streaming, true);
    await sleep(100);
    await admin.call('PUBLISH', 'news', 'hello');
    await sleep(200);
    const lines = pushes.filter((p) => p.kind === 'shell-push').flatMap((p) => p.replies).map(formatTTY);
    assert.deepStrictEqual(lines, [
      '1) "subscribe"\n2) "news"\n3) (integer) 1',
      '1) "subscribe"\n2) "alerts"\n3) (integer) 2',
      '1) "message"\n2) "news"\n3) "hello"']);
    const after = await op('shellStop', { id: 's1' });
    assert.strictEqual(after.db, 2); // Ctrl+C keeps the Shell's database
    assert.strictEqual((await op('shellRun', { id: 's1', args: ['GET', 'shell-n'] })).reply.s, '1');
    pushes.length = 0;
    await op('shellRun', { id: 's1', args: ['MONITOR'] });
    await sleep(100);
    await admin.call('GET', 'watched-key');
    await sleep(200);
    const mon = pushes.flatMap((p) => p.replies || []).map(formatTTY);
    assert.strictEqual(mon[0], 'OK');
    assert.ok(mon.some((l) => /"GET" "watched-key"/i.test(l)), mon.join('\n'));
    await op('shellStop', { id: 's1' });
    await op('shellRun', { id: 's1', args: ['FLUSHDB'] });
    await op('shellClose', { id: 's1' });
    await assert.rejects(op('shellRun', { id: 's1', args: ['PING'] }), /closed/);
  });

  await t('Shell reconnects on the next command after the server drops it (like redis-cli)', async () => {
    const pushes = [];
    db.setOnPush((win, msg) => pushes.push(msg));
    await op('shellOpen', { id: 's2' });
    const list = await admin.call('CLIENT', 'LIST');
    const id = /id=(\d+) .*name=lookup-shell/.exec(list)[1];
    await admin.call('CLIENT', 'KILL', 'ID', id);
    await sleep(150);
    assert.ok(pushes.find((p) => p.kind === 'shell-closed' && p.id === 's2'));
    const r = await op('shellRun', { id: 's2', args: ['PING'] });
    assert.deepStrictEqual([r.reply.v, r.reconnected], ['PONG', true]);
    await op('shellClose', { id: 's2' });
  });

  await t('Overview: version, memory, clients, hit rate, keyspace, slow log', async () => {
    const o = await op('overview');
    assert.match(o.version, /^\d+\./);
    assert.ok(o.usedMemory > 0);
    assert.ok(o.clients >= 2);
    assert.ok(o.keyspace.find((d) => d.index === DB));
    assert.ok(Array.isArray(o.slowlog));
    assert.strictEqual(o.role, 'master');
  });

  await t('SQL log lists what Lookup ran (SCAN, pipelined TYPE / PTTL, MULTI)', async () => {
    const log = db.sqlLog(W).entries.map((e) => e.sql);
    assert.ok(log.some((l) => /^SCAN \d+ MATCH \S+ COUNT (1000|5000)$/.test(l)), log.slice(0, 5).join('\n'));
    assert.ok(log.some((l) => /^TYPE \/ PTTL \/ MEMORY USAGE for \d+ keys/.test(l)));
    assert.ok(log.some((l) => /^MULTI\nHSET user:1:profile plan business/.test(l)));
  });

  await t('lost connection is reported; Reconnect brings the session back', async () => {
    const list = await admin.call('CLIENT', 'LIST');
    const id = /id=(\d+) [^\n]*name=lookup(?:\s|$)/m.exec(list)[1];
    await admin.call('CLIENT', 'KILL', 'ID', id);
    await sleep(100);
    await assert.rejects(op('keyspace'));
    await assert.rejects(op('keyspace'), /Reconnect/);
    await db.reconnect(W);
    assert.strictEqual((await op('keyspace')).current, DB);
  });

  await db.disconnect(W);
  await admin.call('FLUSHDB');
  await admin.close();
  console.log(`redis-test: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
