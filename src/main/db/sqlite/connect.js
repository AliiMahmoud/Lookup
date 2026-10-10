// SQLite connections: a database file opened on its own worker thread (see worker.js), wrapped so the
// shared code gets the same calls an Oracle connection has (execute, commit, rollback, ping, close).
const fs = require('fs');
const path = require('path');

const WORKER_SOURCE = path.join(__dirname, 'worker.js');
let source = null;

/** Started from the file's text, so it also works from inside the packaged app (asar). */
function startWorker() {
  const { Worker } = require('worker_threads');
  if (!source) source = fs.readFileSync(WORKER_SOURCE, 'utf8');
  return new Worker(source, { eval: true });
}

const stopped = () => Object.assign(new Error('Query cancelled'), { code: 'LOOKUP_STOPPED' });

const gone = () => Object.assign(new Error('The SQLite worker stopped'), { code: 'LOOKUP_WORKER_GONE' });

/**
 * One open file. Calls go to the current worker; each worker keeps its own list of calls waiting
 * for an answer, so a worker left behind by Stop can't disturb the next one.
 */
class SqliteConn {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = cfg.file === ':memory:' ? ':memory:' : path.resolve(String(cfg.file || ''));
    this.seq = 0;
    this.worker = null;
    this.inTx = false;
    this.version = null;
  }

  async start(create) {
    const w = startWorker();
    w.pending = new Map();
    const failAll = (err) => { for (const p of w.pending.values()) p.reject(err); w.pending.clear(); };
    w.on('message', (m) => {
      const p = w.pending.get(m.id);
      if (!p) return;
      w.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(Object.assign(new Error(m.error.message), { code: m.error.code, errcode: m.error.errcode }));
    });
    w.on('error', (e) => failAll(e));
    w.on('exit', () => failAll(w.stoppedByUser ? stopped() : gone()));
    w.failAll = failAll;
    this.worker = w;
    const r = await this.call('open', { file: this.file, readOnly: !!this.cfg.readOnly, create: !!create });
    this.version = r.version;
    this.inTx = false;
  }

  get busy() { return !!this.worker && this.worker.pending.size > 0; }

  call(op, args = {}) {
    const w = this.worker;
    if (!w) return Promise.reject(gone());
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      w.pending.set(id, { resolve, reject });
      w.postMessage({ id, op, ...args });
    });
  }

  /** App-issued SQL (logged): { rows, columns } or { rowsAffected }. */
  async execute(sql, params) {
    const r = await this.call('query', { sql, params: params || [] });
    return r.columns ? { rows: r.rows, columns: r.columns } : { rowsAffected: r.changes };
  }

  async commit() { if (this.inTx) { await this.call('query', { sql: 'COMMIT' }); this.inTx = false; } }

  async rollback() { if (this.inTx) { await this.call('query', { sql: 'ROLLBACK' }); this.inTx = false; } }

  ping() { return this.worker ? Promise.resolve() : Promise.reject(gone()); }

  async close() {
    const w = this.worker;
    if (!w) return;
    try { await Promise.race([this.call('close'), new Promise((r) => setTimeout(r, 1000))]); } catch { /* already gone */ }
    this.worker = null;
    w.stoppedByUser = true;
    w.terminate().catch(() => {}); // returns once SQLite gives control back (see cancelRunning)
  }

  /**
   * Stop. SQLite can't be interrupted from outside here, so the worker running the statement is told
   * to end and the file is opened again on a new worker straight away. Between rows the old worker
   * ends at once; inside one long step (a big aggregate) it ends as soon as SQLite returns, and its
   * open transaction / statement savepoint is rolled back when its connection closes, so nothing
   * from a stopped statement is ever committed.
   */
  async cancelRunning() {
    const w = this.worker;
    if (!w || !w.pending.size) return;
    w.stoppedByUser = true;
    this.worker = null;
    this.inTx = false; // rolled back with the old worker's connection
    w.failAll(stopped());
    w.terminate().catch(() => {});
    await this.start(false);
  }
}

async function open(cfg, { create = false } = {}) {
  if (!cfg.file) throw new Error('Choose a database file.');
  const conn = new SqliteConn(cfg);
  try {
    await conn.start(create);
  } catch (e) {
    await conn.close().catch(() => {});
    throw e;
  }
  return conn;
}

/** Same database = same file (paths compare case-insensitively on Windows and macOS). */
function targetKey(cfg) {
  if (cfg.file === ':memory:') return `memory|${cfg.id || ''}`;
  const p = path.resolve(String(cfg.file || ''));
  return process.platform === 'linux' ? p : p.toLowerCase();
}

module.exports = { open, targetKey };
