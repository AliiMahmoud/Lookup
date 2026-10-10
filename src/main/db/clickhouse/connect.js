// ClickHouse connections over HTTP(S) with the official client (pure JavaScript, loaded on first use),
// wrapped so the shared code gets the same calls an Oracle connection has. ClickHouse has no
// transactions: commit and rollback do nothing, and every statement is applied at once.
const { connectTimeoutSec, net } = require('../common/net');

const DEFAULT_PORT = 8123;
const DEFAULT_TLS_PORT = 8443;
let ch = null;
const driver = () => (ch || (ch = require('@clickhouse/client')));

/** Statements that return rows (everything else runs as a command: DDL, INSERT, ALTER …). */
const RETURNS_ROWS = /^\s*(\(\s*)*(select|with|show|describe|desc|explain|exists|check)\b/i;

// Values as the server's text where JSON would round them (64-bit integers, decimals).
const OUTPUT = { output_format_json_quote_64bit_integers: 1, output_format_json_quote_decimals: 1, output_format_decimal_trailing_zeros: 1 };

function urlOf(cfg) {
  if (cfg.mode === 'string') return String(cfg.connectString || '').trim();
  const tls = cfg.ssl === 'require' || cfg.ssl === 'verify';
  return `${tls ? 'https' : 'http'}://${cfg.host || 'localhost'}:${Number(cfg.port) || (tls ? DEFAULT_TLS_PORT : DEFAULT_PORT)}`;
}

let seq = 0;
const newQueryId = () => `lookup-${process.pid}-${Date.now().toString(36)}-${++seq}`;

class ChConn {
  constructor(client, cfg) {
    this.client = client;
    this.cfg = cfg;
    this.running = new Map(); // query_id -> AbortController (Stop)
  }

  /** Starts a row-returning query; rows come back as arrays (names and types first). */
  async select(sql, params, { queryId = newQueryId(), settings = {} } = {}) {
    const ctl = new AbortController();
    this.running.set(queryId, ctl);
    try {
      return await this.client.query({
        query: sql, query_params: params || {}, format: 'JSONCompactEachRowWithNamesAndTypes',
        query_id: queryId, abort_signal: ctl.signal, clickhouse_settings: { ...OUTPUT, ...settings },
      });
    } catch (e) {
      this.running.delete(queryId);
      throw e;
    }
  }

  finished(queryId) { this.running.delete(queryId); }

  async command(sql, params, { queryId = newQueryId() } = {}) {
    const ctl = new AbortController();
    this.running.set(queryId, ctl);
    try {
      return await this.client.command({ query: sql, query_params: params || {}, query_id: queryId, abort_signal: ctl.signal });
    } finally {
      this.running.delete(queryId);
    }
  }

  /** App-issued SQL (logged): all rows, or the number of rows written. */
  async execute(sql, params) {
    if (!RETURNS_ROWS.test(sql)) {
      const r = await this.command(sql, params);
      return { rowsAffected: r.summary ? Number(r.summary.written_rows) : undefined };
    }
    const queryId = newQueryId();
    const rs = await this.select(sql, params, { queryId });
    try {
      const all = await rs.json();
      return { names: all[0] || [], types: all[1] || [], rows: all.slice(2) };
    } finally {
      this.finished(queryId);
    }
  }

  async commit() { /* no transactions */ }

  async rollback() { /* no transactions */ }

  async ping() {
    const r = await this.client.ping();
    if (!r.success) throw r.error;
  }

  close() { return this.client.close(); }

  /** Stop: abort the HTTP request and ask the server to kill the query. */
  async cancelRunning() {
    const ids = [...this.running.keys()];
    for (const id of ids) this.running.get(id).abort();
    for (const id of ids) {
      await this.client.command({ query: 'KILL QUERY WHERE query_id = {id:String} ASYNC', query_params: { id } }).catch(() => {});
    }
  }
}

async function open(cfg) {
  const { createClient, ClickHouseLogLevel } = driver();
  const client = createClient({
    log: { level: ClickHouseLogLevel.OFF }, // errors are shown in the app, not printed to the console
    url: urlOf(cfg),
    username: cfg.user || 'default',
    password: cfg.password || '',
    database: cfg.database || 'default',
    application: 'Lookup',
    request_timeout: 24 * 3600 * 1000, // long queries are ended with Stop, not by a timer
    keep_alive: { enabled: net.keepAliveSec > 0 },
    tls: cfg.ssl === 'require' ? { rejectUnauthorized: false } : undefined,
    // Progress headers every 110 s keep long queries alive through proxies and load balancers.
    clickhouse_settings: { send_progress_in_http_headers: 1, http_headers_progress_interval_ms: '110000' },
  });
  // A request that doesn't connect in time counts as "can't connect".
  const timeout = connectTimeoutSec(cfg) * 1000;
  let timer;
  try {
    const r = await Promise.race([
      client.ping(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Could not reach ${urlOf(cfg)} within ${timeout / 1000} s`)), timeout); }),
    ]);
    if (r && !r.success) throw r.error;
    // ping does not check the login: run a tiny query.
    await client.command({ query: 'SELECT 1' });
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return new ChConn(client, cfg);
}

function targetKey(cfg) {
  return `${urlOf(cfg).toLowerCase()}/${cfg.database || 'default'}|${cfg.user || 'default'}`;
}

module.exports = { open, targetKey, newQueryId, RETURNS_ROWS, DEFAULT_PORT };
