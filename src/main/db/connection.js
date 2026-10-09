// Connecting, Test, Cancel, Stop, Reconnect, disconnecting, and transactions.
const { ora } = require('./driver');
const { sessions, get } = require('./sessions');
const { newLog, trackConnection } = require('./sql-log');
const { connectOptions } = require('./settings');
const { STOP_GRACE_MS, isLostError, markLost, watchConnection, withTimeout } = require('./health');

async function test(cfg) {
  const conn = await ora().getConnection(connectOptions(cfg));
  try {
    const r = await conn.execute(`SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA'), SYS_CONTEXT('USERENV','DB_NAME') FROM dual`);
    return { version: conn.oracleServerVersionString, schema: r.rows[0][0], dbName: r.rows[0][1] };
  } finally {
    await conn.close();
  }
}

// Connect attempts in progress, so Cancel can abandon them (winId -> reject function).
const pendingConnects = new Map();

async function connect(winId, cfg) {
  await disconnect(winId);
  // The driver can't abort a connect midway, so Cancel stops waiting for it, and a connection
  // that arrives after Cancel is closed straight away.
  let cancelled = false;
  const attempt = ora().getConnection(connectOptions(cfg));
  attempt.then((c) => { if (cancelled) c.close().catch(() => {}); }, () => {});
  const conn = await new Promise((resolve, reject) => {
    pendingConnects.set(winId, () => { cancelled = true; reject(Object.assign(new Error('Connection cancelled'), { cancelled: true })); });
    attempt.then(resolve, reject);
  }).finally(() => pendingConnects.delete(winId));
  if (cancelled) { conn.close().catch(() => {}); throw Object.assign(new Error('Connection cancelled'), { cancelled: true }); }
  conn.callTimeout = 0;
  const log = newLog();
  trackConnection(conn, log);
  let session = null;
  watchConnection(winId, conn, () => session);
  const r = await conn.execute(`SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA'), SYS_CONTEXT('USERENV','DB_NAME') FROM dual`);
  try {
    await conn.execute(`BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`);
  } catch { /* ignore */ }
  try {
    await conn.execute(`BEGIN
      DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);
      DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE);
      DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
      DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE);
    END;`);
  } catch { /* ignore */ }
  session = { conn, cfg, autoCommit: !!cfg.autoCommit, colCache: new Map(), schema: r.rows[0][0], busy: false, log };
  sessions.set(winId, session);
  return {
    version: conn.oracleServerVersionString,
    schema: session.schema,
    dbName: r.rows[0][1],
    autoCommit: session.autoCommit,
  };
}

async function disconnect(winId) {
  const s = sessions.get(winId);
  if (!s) return;
  sessions.delete(winId);
  try { await s.conn.close(); } catch { /* already closed */ }
}

/** Closes every open session; used on app quit. Uncommitted work is rolled back by Oracle. */
async function disconnectAll(timeoutMs = 3000) {
  const ids = [...sessions.keys()];
  if (!ids.length) return;
  await Promise.race([
    Promise.allSettled(ids.map((id) => disconnect(id))),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** Stop: sends the server one cancel request (a break) for the running call, like SQL Developer or
 *  DBeaver. The query then ends with ORA-01013 when the server notices. Nothing is retried and no
 *  session is closed or opened automatically, so the database isn't given extra work. */
async function cancel(winId) {
  const s = sessions.get(winId);
  if (!s) return;
  if (s.lost) { if (s.abortRun) s.abortRun(new Error(s.lost)); return; }
  if (!s.busy || s.breakSent) return; // one break per query
  s.breakSent = true;
  try {
    await withTimeout(s.conn.breakExecution(), STOP_GRACE_MS, 'The database did not accept the cancel request');
  } catch (e) {
    if (isLostError(e)) markLost(winId, s, `Connection lost: ${String(e.message).split('\n')[0]}`);
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
  get(winId).autoCommit = !!on;
  return !!on;
}

async function commit(winId) { await get(winId).conn.commit(); }

async function rollback(winId) { await get(winId).conn.rollback(); }

module.exports = { test, connect, disconnect, disconnectAll, cancel, setAutoCommit, commit, rollback, reconnect, cancelConnect, closeStuckSession };
