// Lost connections: broken-connection errors, the idle health check, and notifying the window.
const { sessions } = require('./sessions');
const { net } = require('./settings');

const STOP_GRACE_MS = 4000;

     // Stop: how long sending the break itself may take
const PING_TIMEOUT_MS = 15000;

const LOST_RE = /^(NJS-500|NJS-501|NJS-503|NJS-521|DPI-1080|DPI-1010|ORA-03113|ORA-03114|ORA-03135|ORA-02396|ORA-01012|ORA-00028|ORA-12537|ORA-12547|ORA-12570|ORA-12571)\b/;

const isLostError = (e) => !!e && (LOST_RE.test(String(e.message || '')) || LOST_RE.test(String(e.code || '')));

let onLost = () => {};

/** main.js registers a callback that tells the workspace its connection is gone. */
function setOnLost(fn) { onLost = fn; }

function markLost(winId, s, message) {
  if (s.lost) return;
  s.lost = message || 'The connection to the database was lost';
  if (s.abortRun) s.abortRun(new Error(s.lost));
  const conn = s.conn;
  Promise.resolve().then(() => conn.close()).catch(() => { /* the socket is already gone */ });
  try { onLost(winId, s.lost); } catch { /* window closed */ }
}

// Any call that fails with a broken-connection error marks the session as lost.
function watchConnection(winId, conn, getSession) {
  for (const op of ['execute', 'rawExecute', 'commit', 'rollback']) {
    const fn = conn[op];
    conn[op] = async (...args) => {
      try { return await fn(...args); } catch (e) {
        const s = getSession();
        if (s && isLostError(e)) markLost(winId, s, `Connection lost: ${String(e.message).split('\n')[0]}`);
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
      .catch((e) => { if (sessions.get(winId) === s) markLost(winId, s, isLostError(e) ? `Connection lost: ${String(e.message).split('\n')[0]}` : e.message); })
      .finally(() => { s.pinging = false; });
  }
}

startHealthCheck();

module.exports = { STOP_GRACE_MS, isLostError, markLost, watchConnection, withTimeout, startHealthCheck, setOnLost };
