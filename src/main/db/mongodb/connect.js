// MongoDB connections with the official driver (pure JavaScript, loaded on first use), wrapped so the
// shared code gets the same calls an Oracle connection has: execute (logged), commit / rollback
// (nothing to do: every change applies at once), ping, close. Stop: every query Lookup runs carries a
// comment and an abort signal; Stop aborts it and asks the server to kill it (killOp, when allowed).
const { connectTimeoutSec, net } = require('../common/net');

const DEFAULT_PORT = 27017;
let driver = null;
const mongo = () => (driver || (driver = require('mongodb')));

/** host[:port] list from the form ("a:27017, b, c:27018"). */
const hostsOf = (cfg) => String(cfg.host || 'localhost').split(/[\s,]+/).filter(Boolean)
  .map((h) => (/:\d+$/.test(h) || cfg.srv ? h : `${h}:${Number(cfg.port) || DEFAULT_PORT}`));

/** The connection string Lookup uses (no password in it: that goes in the options). */
function urlOf(cfg) {
  if (cfg.mode === 'string') return String(cfg.connectString || '').trim();
  const hosts = hostsOf(cfg);
  const q = new URLSearchParams();
  if (cfg.authSource) q.set('authSource', cfg.authSource);
  if (cfg.replicaSet) q.set('replicaSet', cfg.replicaSet);
  if (cfg.readPreference && cfg.readPreference !== 'primary') q.set('readPreference', cfg.readPreference);
  // One host without a replica set name: talk to that server even if it is a replica set member (as Compass).
  if (!cfg.srv && hosts.length === 1 && !cfg.replicaSet) q.set('directConnection', 'true');
  const qs = q.toString();
  return `${cfg.srv ? 'mongodb+srv' : 'mongodb'}://${hosts.join(',')}/${encodeURIComponent(cfg.database || '')}${qs ? '?' + qs : ''}`;
}

/** Driver options from the form: login, TLS, timeouts, a small pool (memory). */
function optionsOf(cfg) {
  const timeout = connectTimeoutSec(cfg) * 1000;
  const o = {
    appName: 'Lookup',
    serverSelectionTimeoutMS: timeout,
    connectTimeoutMS: timeout,
    maxPoolSize: 5,
    minPoolSize: 0,
    maxIdleTimeMS: 5 * 60 * 1000,
    monitorCommands: false,
  };
  if (net.keepAliveSec === 0) o.heartbeatFrequencyMS = 60000;
  const mech = cfg.authMechanism || 'DEFAULT';
  if (mech === 'MONGODB-X509') {
    o.authMechanism = 'MONGODB-X509';
    if (cfg.tlsCertificateKeyFile) o.tlsCertificateKeyFile = cfg.tlsCertificateKeyFile;
  } else if (mech === 'MONGODB-AWS') {
    o.authMechanism = 'MONGODB-AWS';
  } else if (mech !== 'NONE' && (cfg.user || cfg.password)) {
    o.auth = { username: cfg.user || '', password: cfg.password || '' };
    if (mech !== 'DEFAULT') o.authMechanism = mech;
  }
  if (cfg.mode !== 'string') {
    if (cfg.ssl === 'require' || cfg.ssl === 'verify') o.tls = true;
    if (cfg.ssl === 'require') o.tlsAllowInvalidCertificates = true;
    if (cfg.ssl === 'disable' && !cfg.srv) o.tls = false;
    if (cfg.tlsCAFile) o.tlsCAFile = cfg.tlsCAFile;
  }
  return o;
}

let seq = 0;

class MongoConn {
  constructor(client, cfg) {
    this.client = client;
    this.cfg = cfg;
    this.dbName = cfg.mode === 'string' ? (mongoDbFromUrl(cfg.connectString) || 'test') : (cfg.database || 'test');
    this.readOnly = !!cfg.readOnly;
    this.running = new Map(); // comment -> AbortController
  }

  /** A tag and an abort signal for one query, so Stop can find and end it. */
  track() {
    const comment = `lookup-${process.pid}-${++seq}`;
    const ctl = new AbortController();
    this.running.set(comment, ctl);
    return { comment, signal: ctl.signal, done: () => this.running.delete(comment) };
  }

  /** App-issued operations (logged in the SQL log as mongosh text): an Op with its run function. */
  async execute(op) {
    return op.run(this.client);
  }

  async commit() { /* every change applies at once */ }

  async rollback() { /* nothing to roll back */ }

  async ping() { await this.client.db('admin').command({ ping: 1 }); }

  /** Stop: abort the running queries and ask the server to kill them (needs the killop privilege). */
  async cancelRunning() {
    const tags = [...this.running.keys()];
    for (const t of tags) this.running.get(t).abort();
    if (!tags.length) return;
    try {
      const admin = this.client.db('admin');
      const ops = await admin.aggregate([{ $currentOp: { allUsers: true } }, { $match: { 'command.comment': { $in: tags } } }, { $project: { opid: 1 } }]).toArray();
      for (const o of ops) await admin.command({ killOp: 1, op: o.opid }).catch(() => {});
    } catch { /* not allowed, or the server has no $currentOp: the aborted query ends on the client side */ }
  }

  close() { return this.client.close(true); }
}

/** One app-issued operation: shown as `text` in the SQL log, run with the client. */
class Op {
  constructor(text, run) { this.text = text; this.run = run; }
  toString() { return this.text; }
}

function mongoDbFromUrl(url) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]+)/.exec(String(url || '').trim());
  return m ? decodeURIComponent(m[1]) : null;
}

async function open(cfg) {
  const { MongoClient } = mongo();
  const url = urlOf(cfg);
  if (!/^mongodb(\+srv)?:\/\//.test(url)) throw new Error('A MongoDB URL starts with mongodb:// or mongodb+srv://');
  const client = new MongoClient(url, optionsOf(cfg));
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 }); // a wrong login fails here, not later
  } catch (e) {
    await client.close(true).catch(() => {});
    if (/Authentication failed|auth.*fail/i.test(e.message)) e.message = `Wrong username or password (${e.message})`;
    if (/Server selection timed out/i.test(e.message)) e.message = `Could not reach ${cfg.mode === 'string' ? 'the server' : hostsOf(cfg).join(', ')} (${e.message.split('\n')[0]})`;
    throw e;
  }
  return new MongoConn(client, cfg);
}

function targetKey(cfg) {
  const where = cfg.mode === 'string' ? String(cfg.connectString || '').replace(/\/\/[^@/]*@/, '//') : `${cfg.srv ? 'srv:' : ''}${hostsOf(cfg).join(',').toLowerCase()}`;
  return `${where}/${cfg.database || ''}|${cfg.user || ''}`;
}

module.exports = { open, targetKey, urlOf, optionsOf, hostsOf, Op, MongoConn, mongo, DEFAULT_PORT };
