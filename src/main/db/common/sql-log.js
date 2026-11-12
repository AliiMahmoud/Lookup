// SQL log: records every statement run on a connection: Lookup's own (through conn.execute) and the user's
// query-tab statements (logged by common/query.js, since engines run those through raw driver calls).
const { sessions } = require('./sessions');

const LOG_MAX = 3000;

function newLog() { return { seq: 0, entries: [] }; }

/** Starts an entry; the returned function adds it once the statement finished. It is numbered then, so the panel
 *  (which asks for entries after the last number it saw) never misses one that took longer than another. */
function startEntry(log, sql, extra) {
  const entry = { at: Date.now(), sql: String(sql).trim(), ...extra };
  return (result) => {
    Object.assign(entry, result, { id: ++log.seq, ms: Date.now() - entry.at });
    log.entries.push(entry);
    if (log.entries.length > LOG_MAX) log.entries.shift();
  };
}

const firstLine = (e) => String(e && e.message).split('\n')[0];

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

/** Records every execute() on this connection; conn.rawExecute skips the log. */
function trackConnection(conn, log) {
  const raw = conn.execute.bind(conn);
  conn.rawExecute = raw;
  conn.execute = async (...args) => {
    const done = startEntry(log, args[0], { binds: plainBinds(args[1]) });
    try {
      const r = await raw(...args);
      if (r && Array.isArray(r.rows)) done({ rows: r.rows.length });
      else if (r && typeof r.rowsAffected === 'number') done({ affected: r.rowsAffected });
      else done({});
      return r;
    } catch (e) {
      done({ error: firstLine(e) });
      throw e;
    }
  };
  // COMMIT / ROLLBACK are driver calls, not statements: log them too.
  for (const op of ['commit', 'rollback']) {
    const fn = conn[op].bind(conn);
    conn[op] = async () => {
      const done = startEntry(log, op.toUpperCase());
      try { await fn(); done({}); } catch (e) { done({ error: firstLine(e) }); throw e; }
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

module.exports = { newLog, startEntry, trackConnection, sqlLog, clearSqlLog };
