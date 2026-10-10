// Lost connections for every engine: marking a session lost, the idle health check, and notifying
// the window. Which errors mean "connection broken" is up to each engine (engine.isLostError).
const { sessions } = require('./sessions');
const { net } = require('./net');

const STOP_GRACE_MS = 4000; // Stop: how long sending the cancel request itself may take
const PING_TIMEOUT_MS = 15000;

let onLost = () => {};

/** main.js registers a callback that tells the workspace its connection is gone. */
function setOnLost(fn) { onLost = fn; }

const lostMessage = (e) => `Connection lost: ${String(e.message).split('\n')[0]}`;

function markLost(winId, s, message) {
  if (s.lost) return;
  s.lost = message || 'The connection to the database was lost';
  if (s.abortRun) s.abortRun(new Error(s.lost));
  const conn = s.conn;
  Promise.resolve().then(() => conn.close()).catch(() => { /* the socket is already gone */ });
  try { onLost(winId, s.lost); } catch { /* window closed */ }
}

// Any call that fails with a broken-connection error marks the session as lost.
function watchConnection(winId, conn, getSession, isLostError) {
  for (const op of ['execute', 'rawExecute', 'commit', 'rollback']) {
    const fn = conn[op];
    if (typeof fn !== 'function') continue;
    conn[op] = async (...args) => {
      try { return await fn(...args); } catch (e) {
        const s = getSession();
        if (s && isLostError(e)) markLost(winId, s, lostMessage(e));
        throw e;
      }
    };
  }
}

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms).unref?.())]);

// Idle sessions are pinged every healthCheckSec; one that doesn't answer is reported as lost.
let healthTimer = null;

function startHealthCheck() {
  clearInterval(healthTimer);
  healthTimer = null;
  if (net.healthCheckSec > 0) healthTimer = setInterval(healthCheck, net.healthCheckSec * 1000);
  if (healthTimer && healthTimer.unref) healthTimer.unref();
}

function healthCheck() {
  for (const [winId, s] of sessions) {
    if (s.busy || s.lost || s.pinging || typeof s.conn.ping !== 'function') continue;
    s.pinging = true;
    withTimeout(s.conn.ping(), PING_TIMEOUT_MS, 'The database is not responding')
      .catch((e) => { if (sessions.get(winId) === s) markLost(winId, s, s.engine.isLostError(e) ? lostMessage(e) : e.message); })
      .finally(() => { s.pinging = false; });
  }
}

startHealthCheck();

module.exports = { STOP_GRACE_MS, lostMessage, markLost, watchConnection, withTimeout, startHealthCheck, setOnLost };
