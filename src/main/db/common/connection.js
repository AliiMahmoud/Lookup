// Connecting, Test, Cancel, Stop, Reconnect, disconnecting and transactions, for every engine.
// The engine opens the driver connection and says what the server is (engine.open / describe).
const { engineFor } = require('../engines');
const { sessions, get } = require('./sessions');
const { newLog, trackConnection } = require('./sql-log');
const { STOP_GRACE_MS, lostMessage, markLost, watchConnection, withTimeout } = require('./health');

async function test(cfg) {
  const engine = engineFor(cfg);
  const conn = await engine.open(cfg);
  try {
    return await engine.describe(conn);
  } finally {
    await conn.close();
  }
}

// Connect attempts in progress, so Cancel can abandon them (winId -> reject function).
const pendingConnects = new Map();

async function connect(winId, cfg) {
  await disconnect(winId);
  const engine = engineFor(cfg);
  // Drivers can't abort a connect midway, so Cancel stops waiting for it, and a connection
  // that arrives after Cancel is closed straight away.
  let cancelled = false;
  const attempt = engine.open(cfg);
  attempt.then((c) => { if (cancelled) c.close().catch(() => {}); }, () => {});
  const conn = await new Promise((resolve, reject) => {
    pendingConnects.set(winId, () => { cancelled = true; reject(Object.assign(new Error('Connection cancelled'), { cancelled: true })); });
    attempt.then(resolve, reject);
  }).finally(() => pendingConnects.delete(winId));
  if (cancelled) { conn.close().catch(() => {}); throw Object.assign(new Error('Connection cancelled'), { cancelled: true }); }
  const log = newLog();
  trackConnection(conn, log);
  let session = null;
  watchConnection(winId, conn, () => session, engine.isLostError);
  const info = await engine.describe(conn);
  const extra = (await engine.prepareSession(conn, info)) || {};
  // Engines without transactions (ClickHouse) always apply each statement at once.
  const autoCommit = engine.profile.features.transactions === false ? true : !!cfg.autoCommit;
  session = { engine, conn, cfg, autoCommit, colCache: new Map(), schema: info.schema, busy: false, log, ...extra };
  sessions.set(winId, session);
  // MySQL also serves MariaDB: the server says which product it is.
  const { product, ...shown } = info;
  return { ...shown, autoCommit: session.autoCommit, engine: product ? { ...engine.profile, label: product } : engine.profile };
}

async function disconnect(winId) {
  const s = sessions.get(winId);
  if (!s) return;
  sessions.delete(winId);
  try { await s.conn.close(); } catch { /* already closed */ }
}

/** Closes every open session; used on app quit. Uncommitted work is rolled back by the server. */
async function disconnectAll(timeoutMs = 3000) {
  const ids = [...sessions.keys()];
  if (!ids.length) return;
  await Promise.race([
    Promise.allSettled(ids.map((id) => disconnect(id))),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** Stop: sends the server one cancel request for the running call, like SQL Developer or DBeaver.
 *  The query then ends with the engine's "cancelled" error when the server notices. Nothing is
 *  retried and no session is closed or opened automatically, so the database isn't given extra work. */
async function cancel(winId) {
  const s = sessions.get(winId);
  if (!s) return;
  if (s.lost) { if (s.abortRun) s.abortRun(new Error(s.lost)); return; }
  if (!s.busy || s.breakSent) return; // one cancel request per query
  s.breakSent = true;
  try {
    await withTimeout(s.engine.cancel(s), STOP_GRACE_MS, 'The database did not accept the cancel request');
  } catch (e) {
    if (s.engine.isLostError(e)) markLost(winId, s, lostMessage(e));
  }
}

/** "Close session" after a Stop the server doesn't answer: closing the connection makes the server
 *  end the session (its query stops and open changes roll back). Reconnect opens a new one. */
async function closeStuckSession(winId) {
  const s = sessions.get(winId);
  if (!s) return;
  markLost(winId, s, 'Session closed because the query did not stop');
}

/** Cancel button on "Connecting to …": stop waiting for the connect in progress. */
function cancelConnect(winId) {
  const abort = pendingConnects.get(winId);
  if (abort) abort();
  return !!abort;
}

/** Opens a fresh session with the same login after the connection was lost. */
async function reconnect(winId) {
  const s = sessions.get(winId);
  if (!s) throw new Error('Not connected');
  return connect(winId, s.cfg);
}

async function setAutoCommit(winId, on) {
  const s = get(winId);
  s.autoCommit = s.engine.profile.features.transactions === false ? true : !!on;
  return s.autoCommit;
}

async function commit(winId) { await get(winId).conn.commit(); }

async function rollback(winId) { await get(winId).conn.rollback(); }

module.exports = { test, connect, disconnect, disconnectAll, cancel, setAutoCommit, commit, rollback, reconnect, cancelConnect, closeStuckSession };
