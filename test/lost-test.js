// Lost connections: connect timeout, Stop when the server never answers, broken-connection errors, reconnect.
// Run: node test/lost-test.js
const assert = require('assert');
const net = require('net');
const oracledb = require('oracledb');
const db = require('../src/main/db');
const oracle = require('../src/main/db/oracle');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ok ', name); };

// A fake Oracle connection: 'HANG' never returns and Stop is never acknowledged (dead network).
function fakeConn(behaviour = {}) {
  return {
    oracleServerVersionString: '23.5.0.0.0',
    closed: false,
    async execute(sql) {
      if (/SYS_CONTEXT/.test(sql)) return { rows: [['HR', 'FREE']] };
      if (/HANG/.test(sql)) return new Promise(() => {});
      if (/BROKEN/.test(sql)) { const e = new Error('NJS-500: connection to the Oracle Database was broken'); e.code = 'NJS-500'; throw e; }
      return { rows: [], rowsAffected: 0 };
    },
    breakExecution: () => (behaviour.breakHangs ? new Promise(() => {}) : Promise.resolve()),
    ping: async () => {},
    commit: async () => {}, rollback: async () => {},
    async close() { this.closed = true; },
  };
}

const keepAlive = setInterval(() => {}, 1000); // the module's timers are unref'd; keep the test process running
(async () => {
  await t('connect options: 60 s connect timeout and keep-alive by default', () => {
    const o = oracle.connectOptions({ user: 'u', password: 'p', host: 'h', service: 's' });
    assert.deepStrictEqual([o.connectTimeout, o.transportConnectTimeout], [60, 60]);
    assert.match(o.connectString, /^\(DESCRIPTION=\(EXPIRE_TIME=1\)/);
  });

  await t('settings in seconds: connect timeout, keep-alive (in the descriptor), Easy Connect rounds to minutes, 0 = off', () => {
    db.configure({ connectTimeoutSec: 15, keepAliveSec: 20 });
    let o = oracle.connectOptions({ user: 'u', password: 'p', host: 'h', service: 's' });
    assert.strictEqual(o.connectTimeout, 15);
    assert.match(o.connectString, /EXPIRE_TIME=0\.3333/);
    o = oracle.connectOptions({ user: 'u', password: 'p', mode: 'string', connectString: 'h:1521/s' });
    assert.strictEqual(o.expireTime, 1);
    db.configure({ keepAliveSec: 0 });
    o = oracle.connectOptions({ user: 'u', password: 'p', host: 'h', service: 's' });
    assert.ok(!/EXPIRE_TIME/.test(o.connectString) && o.expireTime === undefined);
    assert.deepStrictEqual(db.configure({ connectTimeoutSec: 0, healthCheckSec: -5 }), { connectTimeoutSec: 1, keepAliveSec: 0, healthCheckSec: 0 });
    db.configure({ connectTimeoutSec: 60, keepAliveSec: 60, healthCheckSec: 30 });
  });

  await t('the keep-alive in seconds reaches the socket', async () => {
    db.configure({ keepAliveSec: 20 });
    const seen = [];
    const orig = net.Socket.prototype.setKeepAlive;
    net.Socket.prototype.setKeepAlive = function (on, ms) { seen.push([on, ms]); return orig.call(this, on, ms); };
    const server = net.createServer(() => {}).listen(0);
    await new Promise((r) => server.once('listening', r));
    await db.test({ user: 'u', password: 'p', host: '127.0.0.1', port: server.address().port, service: 'X', connectTimeout: 1 }).catch(() => {});
    server.close();
    net.Socket.prototype.setKeepAlive = orig;
    db.configure({ keepAliveSec: 60 });
    assert.ok(seen.some(([on, ms]) => on && Math.abs(ms - 20000) < 50), JSON.stringify(seen));
  });

  await t('a server that never answers fails at the connect timeout instead of hanging', async () => {
    const server = net.createServer(() => { /* accept, never reply */ }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const t0 = Date.now();
    const err = await db.test({ user: 'u', password: 'p', host: '127.0.0.1', port: server.address().port, service: 'X', connectTimeout: 2 }).then(() => null, (e) => e);
    server.close();
    assert.ok(err, 'should fail');
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
    console.log('       ->', err.message.split('\n')[0]);
  });

  const lost = [];
  db.setOnLost((winId, msg) => lost.push([winId, msg]));
  const real = oracledb.getConnection;

  await t('Stop sends one cancel request and never closes the session by itself', async () => {
    const conn = fakeConn();
    let breaks = 0;
    conn.breakExecution = async () => { breaks++; };
    oracledb.getConnection = async () => conn;
    await db.connect(1, { user: 'u', password: 'p', host: 'h', service: 's' });
    let done = false;
    const running = db.run(1, ['SELECT HANG FROM dual']).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    await db.cancel(1);
    await db.cancel(1); // a second click doesn't send another break
    await new Promise((r) => setTimeout(r, 5000)); // longer than the old 4 s rule
    assert.strictEqual(breaks, 1);
    assert.strictEqual(done, false, 'still waiting for the server');
    assert.strictEqual(lost.length, 0, 'not marked lost');
    assert.strictEqual(conn.closed, false, 'session kept');
    // "Close session": the server ends the session; the run finishes at once.
    await db.closeStuckSession(1);
    const res = await running;
    assert.strictEqual(res[0].kind, 'error');
    assert.strictEqual(res[0].lost, true);
    assert.match(res[0].message, /did not stop/);
    assert.ok(conn.closed);
    assert.strictEqual(lost.length, 1);
    await assert.rejects(db.run(1, ['select 1 from dual']), /Reconnect/);
  });

  await t('the server confirming the cancel (ORA-01013) ends the query normally', async () => {
    const conn = fakeConn();
    let fail;
    conn.execute = async (sql) => (/SYS_CONTEXT/.test(sql) ? { rows: [['HR', 'FREE']] } : /SLOW/.test(sql) ? new Promise((_, rej) => { fail = rej; }) : { rows: [] });
    conn.breakExecution = async () => { setTimeout(() => fail(Object.assign(new Error('ORA-01013: user requested cancel of current operation'), { code: 'ORA-01013' })), 30); };
    oracledb.getConnection = async () => conn;
    await db.connect(4, { user: 'u', password: 'p', host: 'h', service: 's' });
    const running = db.run(4, ['SELECT SLOW FROM dual']);
    await new Promise((r) => setTimeout(r, 30));
    await db.cancel(4);
    const res = await running;
    assert.match(res[0].message, /ORA-01013/);
    assert.ok(!res[0].lost);
    assert.strictEqual(lost.length, 1, 'connection not marked lost');
    const again = await db.run(4, ['select 1 from dual']);
    assert.strictEqual(again[0].kind, 'exec', 'session still usable');
  });

  await t('reconnect opens a fresh session with the same login', async () => {
    oracledb.getConnection = async () => fakeConn();
    oracledb.getConnection = async () => fakeConn();
    const info = await db.reconnect(1);
    assert.strictEqual(info.schema, 'HR');
    const res = await db.run(1, ['select 1 from dual']);
    assert.strictEqual(res[0].kind, 'exec');
  });

  await t('a broken-connection error (NJS-500) marks the session lost', async () => {
    const res = await db.run(1, ['select BROKEN from dual']);
    assert.strictEqual(res[0].kind, 'error');
    assert.strictEqual(lost.length, 2);
    assert.match(lost[1][1], /^Connection lost: NJS-500/);
  });

  await t('Stop on a healthy connection still just breaks the query', async () => {
    oracledb.getConnection = async () => fakeConn();
    await db.connect(2, { user: 'u', password: 'p', host: 'h', service: 's' });
    await db.cancel(2);
    assert.strictEqual(lost.length, 2);
  });

  await t('Cancel stops a slow connect at once; a connection arriving later is closed', async () => {
    const late = fakeConn();
    let arrive;
    oracledb.getConnection = () => new Promise((r) => { arrive = () => r(late); });
    const p = db.connect(3, { user: 'u', password: 'p', host: 'h', service: 's' });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    assert.strictEqual(db.cancelConnect(3), true);
    await assert.rejects(p, /Connection cancelled/);
    assert.ok(Date.now() - t0 < 100);
    arrive();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(late.closed, 'late connection closed');
    await assert.rejects(db.run(3, ['select 1 from dual']), /Not connected/);
    assert.strictEqual(db.cancelConnect(3), false);
  });

  oracledb.getConnection = real;
  console.log(`\n${passed} lost-connection tests passed`);
  clearInterval(keepAlive);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
