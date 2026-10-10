// PostgreSQL connections: options (host / URL, SSL, timeouts, keep-alive), and a small wrapper that
// gives the shared code the same calls an Oracle connection has (execute, commit, rollback, ping, close).
const nodeNet = require('net');
const { driver, types } = require('./driver');
const { net, connectTimeoutSec } = require('../common/net');

const DEFAULT_PORT = 5432;

/** pg Client options for a saved connection. ssl: 'disable' | 'prefer' (default) | 'require' | 'verify'. */
function clientOptions(cfg, ssl) {
  const o = {
    user: cfg.user,
    password: cfg.password,
    application_name: 'Lookup',
    connectionTimeoutMillis: connectTimeoutSec(cfg) * 1000,
    keepAlive: net.keepAliveSec > 0,
    keepAliveInitialDelayMillis: net.keepAliveSec * 1000,
    types,
  };
  if (cfg.mode === 'string') {
    o.connectionString = String(cfg.connectString || '').trim();
    // A user / password typed in the form wins over the URL's.
    if (!cfg.user) delete o.user;
    if (!cfg.password) delete o.password;
  } else {
    o.host = cfg.host || 'localhost';
    o.port = Number(cfg.port) || DEFAULT_PORT;
    o.database = cfg.database || 'postgres';
  }
  if (ssl === 'require') o.ssl = { rejectUnauthorized: false };
  else if (ssl === 'verify') o.ssl = { rejectUnauthorized: true };
  else if (o.connectionString === undefined || !/[?&]sslmode=/.test(o.connectionString)) o.ssl = false;
  return o;
}

const NO_SSL = /does not support SSL/i;

/**
 * Wraps a connected pg Client. Calls are queued one at a time (lock), so the savepoints that
 * protect an open transaction never interleave with another call on the same session.
 */
class PgConn {
  constructor(client, target) {
    this.client = client;
    this.target = target; // { host, port } for cancel requests
    this.notices = [];
    this.queue = Promise.resolve();
    // A connection dropping while idle is reported as an 'error' event; keep it for the next call.
    client.on('error', (e) => { this.broken = e; });
    client.on('notice', (m) => { if (this.notices.length < 5000) this.notices.push(m.message); });
  }

  get serverVersion() { return this.client.serverVersion || ''; }

  /** Runs fn with the session to itself (other calls wait). */
  lock(fn) {
    const run = this.queue.then(() => fn());
    this.queue = run.catch(() => {});
    return run;
  }

  inTransaction() { const st = this.client.getTransactionStatus(); return st === 'T' || st === 'E'; }

  async query(sql, params) {
    if (this.broken) throw this.broken;
    return this.client.query({ text: sql, values: params || [], rowMode: 'array' });
  }

  /** App-issued SQL (logged). Inside an open transaction a savepoint keeps a failed call from
   *  aborting the user's transaction. */
  execute(sql, params) {
    return this.lock(async () => {
      const guard = this.client.getTransactionStatus() === 'T';
      if (guard) await this.query('SAVEPOINT lookup_app');
      try {
        const r = await this.query(sql, params);
        if (guard) await this.query('RELEASE SAVEPOINT lookup_app');
        return result(r);
      } catch (e) {
        if (guard) await this.query('ROLLBACK TO SAVEPOINT lookup_app').catch(() => {});
        throw e;
      }
    });
  }

  commit() { return this.lock(() => (this.inTransaction() ? this.query('COMMIT') : null)); }

  rollback() { return this.lock(() => (this.inTransaction() ? this.query('ROLLBACK') : null)); }

  /** Health check: an empty statement is answered even inside a failed transaction. */
  ping() { return this.lock(() => this.query('')); }

  async close() {
    await this.client.end();
  }

  /** Stop: a cancel request on a new socket (no login needed), as psql does. */
  cancelRunning() {
    const { processID: pid, secretKey: key } = this.client;
    if (!pid || !this.target.host) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = nodeNet.connect(this.target.port, this.target.host, () => {
        const b = Buffer.alloc(16);
        b.writeInt32BE(16, 0);
        b.writeInt32BE(80877102, 4);
        b.writeInt32BE(pid, 8);
        b.writeInt32BE(key, 12);
        sock.end(b);
      });
      sock.setTimeout(4000, () => sock.destroy(new Error('The database did not accept the cancel request')));
      sock.on('error', reject);
      sock.on('close', () => resolve());
    });
  }
}

/** pg result -> what the shared code expects: rows only for row-returning statements. */
function result(r) {
  const returnsRows = r.fields && r.fields.length > 0;
  return { rows: returnsRows ? r.rows : undefined, fields: r.fields, rowsAffected: returnsRows ? undefined : r.rowCount ?? undefined, command: r.command };
}

async function connectClient(cfg, ssl) {
  const { pg } = driver();
  const client = new pg.Client(clientOptions(cfg, ssl));
  try {
    await client.connect();
    return client;
  } catch (e) {
    client.end().catch(() => {});
    // node-postgres' wording when the server wants a password and none was given.
    if (/password must be a string/i.test(e.message)) throw new Error('The server asks for a password. Enter it in the connection form.');
    throw e;
  }
}

/** Opens one connection. SSL 'prefer' (the default) tries SSL first and falls back to plain, like psql. */
async function open(cfg) {
  const mode = cfg.ssl || 'prefer';
  let client;
  if (mode === 'prefer' && cfg.mode !== 'string') {
    try {
      client = await connectClient(cfg, 'require');
    } catch (e) {
      if (!NO_SSL.test(e.message)) throw e;
      client = await connectClient(cfg, 'disable');
    }
  } else {
    client = await connectClient(cfg, mode);
  }
  return new PgConn(client, { host: client.host, port: client.port });
}

/** Same database login = same host, port, database and user. */
function targetKey(cfg) {
  if (cfg.mode === 'string') return `${String(cfg.connectString || '').replace(/\s+/g, '').replace(/:[^:@/]*@/, '@')}|${cfg.user || ''}`;
  return `${String(cfg.host || 'localhost').toLowerCase()}:${cfg.port || DEFAULT_PORT}/${cfg.database || 'postgres'}|${cfg.user || ''}`;
}

/** The same login on another database of the server (databases menu). */
function cfgForDatabase(base, db) {
  if (base.mode !== 'string') return { ...base, database: db.name };
  const url = new URL(String(base.connectString || '').trim());
  url.pathname = '/' + encodeURIComponent(db.name);
  return { ...base, connectString: url.toString() };
}

module.exports = { open, targetKey, cfgForDatabase, clientOptions, DEFAULT_PORT };
