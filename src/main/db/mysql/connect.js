// MySQL / MariaDB connections: options (host / URL, SSL, timeouts, keep-alive), and a small wrapper
// that gives the shared code the same calls an Oracle connection has (execute, commit, rollback,
// ping, close). mysql2 is pure JavaScript and is loaded on first use.
const { net, connectTimeoutSec } = require('../common/net');

const DEFAULT_PORT = 3306;
let mysql = null;
const driver = () => (mysql || (mysql = require('mysql2')));

const SERVER_STATUS_IN_TRANS = 1;
// Small integers and floats come as the server's text too, like every other engine (exact, no float noise).
const NUMERIC_AS_TEXT = new Set(['TINY', 'SHORT', 'LONG', 'INT24', 'YEAR', 'FLOAT', 'DOUBLE']);

/** mysql2 options. Values arrive as text (dates, big numbers, decimals, JSON), so nothing is rounded or shifted. */
function connOptions(cfg, ssl) {
  const o = {
    user: cfg.user,
    password: cfg.password,
    connectTimeout: connectTimeoutSec(cfg) * 1000,
    enableKeepAlive: net.keepAliveSec > 0,
    keepAliveInitialDelay: net.keepAliveSec * 1000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
    rowsAsArray: true,
    multipleStatements: false,
    charset: 'utf8mb4',
    connectAttributes: { program_name: 'Lookup' },
    typeCast: (field, next) => (NUMERIC_AS_TEXT.has(field.type) ? field.string() : next()),
  };
  if (cfg.mode === 'string') {
    o.uri = String(cfg.connectString || '').trim();
    if (!cfg.user) delete o.user;
    if (!cfg.password) delete o.password;
  } else {
    o.host = cfg.host || 'localhost';
    o.port = Number(cfg.port) || DEFAULT_PORT;
    if (cfg.database) o.database = cfg.database;
  }
  if (ssl === 'require') o.ssl = { rejectUnauthorized: false };
  else if (ssl === 'verify') o.ssl = { rejectUnauthorized: true };
  return o;
}

/** Wraps a mysql2 connection. mysql2 runs one command at a time, in the order they were sent. */
class MyConn {
  constructor(raw, cfg) {
    this.raw = raw;
    this.cfg = cfg;
    this.inTx = false;
    this.warnings = 0;
    raw.on('error', (e) => { this.broken = e; });
  }

  get threadId() { return this.raw.threadId; }

  /** Notes the transaction state from an OK packet (rows results don't carry it). */
  track(header) {
    if (header && typeof header.serverStatus === 'number') this.inTx = !!(header.serverStatus & SERVER_STATUS_IN_TRANS);
    if (header && typeof header.warningStatus === 'number') this.warnings = header.warningStatus;
  }

  query(sql, params) {
    if (this.broken) return Promise.reject(this.broken);
    return new Promise((resolve, reject) => {
      this.raw.query({ sql, values: params || [], rowsAsArray: true }, (err, rows, fields) => {
        if (err) { reject(err); return; }
        if (!Array.isArray(rows)) this.track(rows);
        resolve({ rows, fields });
      });
    });
  }

  /** App-issued SQL (logged). */
  async execute(sql, params) {
    const { rows, fields } = await this.query(sql, params);
    if (Array.isArray(rows)) return { rows, fields };
    return { rowsAffected: rows.affectedRows, header: rows };
  }

  commit() { return this.query('COMMIT').then(() => { this.inTx = false; }); }

  rollback() { return this.query('ROLLBACK').then(() => { this.inTx = false; }); }

  ping() {
    if (this.broken) return Promise.reject(this.broken);
    return new Promise((resolve, reject) => this.raw.ping((e) => (e ? reject(e) : resolve())));
  }

  close() {
    return new Promise((resolve) => {
      this.raw.end(() => resolve());
      setTimeout(() => { try { this.raw.destroy(); } catch { /* gone */ } resolve(); }, 2000).unref?.();
    });
  }

  /** Stop: KILL QUERY from a second, short-lived connection with the same login (as MySQL Workbench does). */
  async cancelRunning() {
    const id = this.raw.threadId;
    if (!id) return;
    const other = await open(this.cfg);
    try { await other.query(`KILL QUERY ${Number(id)}`); } finally { await other.close(); }
  }
}

function connectRaw(cfg, ssl) {
  return new Promise((resolve, reject) => {
    const raw = driver().createConnection(connOptions(cfg, ssl));
    raw.once('error', reject);
    raw.connect((err) => {
      if (err) { try { raw.destroy(); } catch { /* ignore */ } reject(err); return; }
      raw.removeListener('error', reject);
      resolve(raw);
    });
  });
}

const NO_SSL = /does not support secure connection|HANDSHAKE_NO_SSL_SUPPORT/i;

/** Opens one connection. SSL 'prefer' (the default) tries SSL first and falls back to plain. */
async function open(cfg) {
  const mode = cfg.ssl || 'prefer';
  let raw;
  if (mode === 'prefer' && cfg.mode !== 'string') {
    try {
      raw = await connectRaw(cfg, 'require');
    } catch (e) {
      if (!NO_SSL.test(`${e.code} ${e.message}`)) throw e;
      raw = await connectRaw(cfg, 'disable');
    }
  } else {
    raw = await connectRaw(cfg, mode);
  }
  return new MyConn(raw, cfg);
}

/** Same server login = same host, port and user (databases are schemas here, browsed in one session). */
function targetKey(cfg) {
  if (cfg.mode === 'string') return `${String(cfg.connectString || '').replace(/\s+/g, '').replace(/:[^:@/]*@/, '@')}|${cfg.user || ''}`;
  return `${String(cfg.host || 'localhost').toLowerCase()}:${cfg.port || DEFAULT_PORT}|${cfg.user || ''}`;
}

const cfgForDatabase = (base, db) => ({ ...base, database: db.name });

module.exports = { open, targetKey, cfgForDatabase, connOptions, DEFAULT_PORT };
