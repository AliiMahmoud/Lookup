// Redis connections (own protocol client in resp.js, no driver), wrapped so the shared code gets the
// same calls an Oracle connection has: execute (logged), commit / rollback (nothing to do), ping, close.
// Besides the main connection used by the key browser, a session opens extra connections on demand:
// one for the Workbench and one per Shell tab, so SELECT, MULTI, blocking commands and SUBSCRIBE there
// never disturb the key browser.
const { RespClient } = require('./resp');
const { quoteArg } = require('../../../shared/redis-cli');
const { isText } = require('./resp');
const { connectTimeoutSec, net } = require('../common/net');

const DEFAULT_PORT = 6379;

/** redis://[user[:password]@]host[:port][/db] or rediss:// (TLS). */
function parseUrl(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch { throw new Error('The URL is not valid. Example: redis://user@host:6379/0'); }
  if (!/^rediss?:$/.test(u.protocol)) throw new Error('A Redis URL starts with redis:// or rediss:// (TLS)');
  return {
    host: u.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1',
    port: Number(u.port) || DEFAULT_PORT,
    tls: u.protocol === 'rediss:',
    verify: u.protocol === 'rediss:',
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    database: Number(String(u.pathname || '').replace(/^\//, '')) || 0,
  };
}

/** Where and how to connect, from a saved connection (form fields or URL). */
function targetOf(cfg) {
  if (cfg.mode === 'string') {
    const t = parseUrl(cfg.connectString);
    return { ...t, user: cfg.user || t.user, password: cfg.password || t.password };
  }
  return {
    host: String(cfg.host || '127.0.0.1').trim(),
    port: Number(cfg.port) || DEFAULT_PORT,
    tls: cfg.ssl === 'require' || cfg.ssl === 'verify',
    verify: cfg.ssl === 'verify',
    user: String(cfg.user || '').trim(),
    password: cfg.password || '',
    database: Number(cfg.database) || 0,
  };
}

/** A command as it would be typed in redis-cli (for the SQL log); long values are shortened. */
function commandText(args) {
  return args.map((a) => {
    const v = Buffer.isBuffer(a) ? (isText(a) ? a.toString('utf8') : { b64: a.toString('base64') }) : String(a);
    const q = quoteArg(v);
    return q.length > 120 ? q.slice(0, 117) + '…' : q;
  }).join(' ');
}

/** One command for conn.execute (logged as typed in redis-cli). node: send it to that cluster node
 *  ("host:port") instead of the key's node; ignored on a standalone server. */
class Cmd {
  constructor(args, node) { this.args = args; this.node = node; }
  toString() { return commandText(this.args); }
}

/** Several commands sent in one round trip; logged as one line. */
class Pipe {
  constructor(cmds, label, node) { this.cmds = cmds; this.label = label; this.node = node; }
  toString() { return this.label || this.cmds.map(commandText).join('\n'); }
}

const withDeadline = (p, ms, msg) => {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(msg), { code: 'ETIMEDOUT' })), ms); })]).finally(() => clearTimeout(timer));
};

/** Opens a logged-in client on the target's database. */
async function openClient(t, cfg, name = 'lookup') {
  const timeoutMs = connectTimeoutSec(cfg) * 1000;
  const c = new RespClient();
  await c.connect({ host: t.host, port: t.port, tls: t.tls, rejectUnauthorized: t.verify, timeoutMs, keepAliveMs: net.keepAliveSec * 1000 });
  try {
    await withDeadline((async () => {
      if (t.password) await c.call(...(t.user ? ['AUTH', t.user, t.password] : ['AUTH', t.password]));
      else if (t.user && t.user !== 'default') await c.call('AUTH', t.user, ''); // users without a password (nopass)
      await c.call('CLIENT', 'SETNAME', name).catch(() => {}); // older servers or restricted users: not needed
      if (t.database) await c.call('SELECT', t.database);
    })(), timeoutMs, `${t.host}:${t.port} did not answer within ${Math.round(timeoutMs / 1000)} s`);
  } catch (e) {
    c.destroy();
    if (/^WRONGPASS|invalid username-password/i.test(e.message)) e.message = `Wrong username or password (${e.message})`;
    throw e;
  }
  return c;
}

class RedisConn {
  constructor(client, t, cfg) {
    this.client = client;
    this.t = t;
    this.cfg = cfg;
    this.db = t.database;
    this.readOnly = !!cfg.readOnly;
    this.extras = new Set(); // Workbench and Shell connections, closed with this one
    this.kinds = new Map(); // command name -> 'write' | 'read' (COMMAND INFO, cached)
    this.cluster = false;
  }

  /** App-issued commands (logged): a Cmd returns its reply as plain values, a Pipe one per command. */
  async execute(cmd) {
    if (cmd instanceof Pipe) return this.client.pipeline(cmd.cmds);
    return this.client.call(...cmd.args);
  }

  async commit() { /* Redis applies every command at once */ }

  async rollback() { /* nothing to roll back */ }

  async ping() { await this.client.call('PING'); }

  /** Standalone server: one "node". (ClusterConn lists its masters.) */
  masterIds() { return [`${this.t.host}:${this.t.port}`]; }

  /** Another connection with the same login (Workbench, Shell), on the given database. */
  async openExtra(name, database = this.db) {
    const c = await openClient({ ...this.t, database }, this.cfg, name);
    this.extras.add(c);
    c.once('close', () => this.extras.delete(c));
    return c;
  }

  async close() {
    for (const c of this.extras) c.destroy();
    this.extras.clear();
    await this.client.close();
  }
}

/** A standalone server, or a cluster (found out from INFO: redis_mode is "cluster"). */
async function open(cfg) {
  const t = targetOf(cfg);
  const client = await openClient(t, cfg);
  let mode = null;
  try { mode = (/redis_mode:(\w+)/.exec(String(await client.call('INFO', 'server'))) || [])[1]; } catch { /* INFO not allowed */ }
  if (mode === 'cluster') {
    const { ClusterConn } = require('./cluster');
    const conn = new ClusterConn(client, t, cfg);
    try { await conn.loadSlots(); } catch (e) { await conn.close(); throw e; }
    return conn;
  }
  return new RedisConn(client, t, cfg);
}

function targetKey(cfg) {
  const t = targetOf(cfg);
  return `${t.tls ? 'rediss' : 'redis'}://${t.host.toLowerCase()}:${t.port}/${t.database}|${t.user || 'default'}`;
}

module.exports = { open, openClient, targetOf, targetKey, parseUrl, Cmd, Pipe, RedisConn, commandText, DEFAULT_PORT };
