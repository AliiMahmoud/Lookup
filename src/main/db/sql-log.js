// SQL log: records the statements Lookup runs by itself (not the user's own queries).
const { sessions } = require('./sessions');

const LOG_MAX = 3000;

function newLog() { return { seq: 0, entries: [] }; }

function plainBinds(b) {
  if (!b || typeof b !== 'object') return null;
  const conv = (v) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return '<binary>';
    if (typeof v === 'object') return 'val' in v ? conv(v.val) : '<out>';
    return v;
  };
  if (Array.isArray(b)) return b.length ? b.map(conv) : null;
  const keys = Object.keys(b);
  return keys.length ? Object.fromEntries(keys.map((k) => [k, conv(b[k])])) : null;
}

/** Records every execute() on this connection; conn.rawExecute skips the log (used for user queries). */
function trackConnection(conn, log) {
  const raw = conn.execute.bind(conn);
  conn.rawExecute = raw;
  conn.execute = async (...args) => {
    const t0 = Date.now();
    const entry = { id: ++log.seq, at: t0, sql: String(args[0]).trim(), binds: plainBinds(args[1]) };
    const push = () => { log.entries.push(entry); if (log.entries.length > LOG_MAX) log.entries.shift(); };
    try {
      const r = await raw(...args);
      entry.ms = Date.now() - t0;
      if (r && Array.isArray(r.rows)) entry.rows = r.rows.length;
      else if (r && typeof r.rowsAffected === 'number') entry.affected = r.rowsAffected;
      push();
      return r;
    } catch (e) {
      entry.ms = Date.now() - t0;
      entry.error = String(e.message).split('\n')[0];
      push();
      throw e;
    }
  };
  // COMMIT / ROLLBACK are driver calls, not statements: log them too.
  for (const op of ['commit', 'rollback']) {
    const fn = conn[op].bind(conn);
    conn[op] = async () => {
      const t0 = Date.now();
      const entry = { id: ++log.seq, at: t0, sql: op.toUpperCase() };
      try { await fn(); entry.ms = Date.now() - t0; } catch (e) { entry.ms = Date.now() - t0; entry.error = String(e.message).split('\n')[0]; throw e; } finally {
        log.entries.push(entry);
        if (log.entries.length > LOG_MAX) log.entries.shift();
      }
    };
  }
  return conn;
}

function sqlLog(winId, sinceId = 0) {
  const s = sessions.get(winId);
  if (!s) return { entries: [], last: 0 };
  return { entries: s.log.entries.filter((e) => e.id > sinceId), last: s.log.seq };
}

function clearSqlLog(winId) {
  const s = sessions.get(winId);
  if (s) s.log.entries = [];
}

module.exports = { newLog, trackConnection, sqlLog, clearSqlLog };
