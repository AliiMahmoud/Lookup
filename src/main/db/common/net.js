// Network settings from the gear menu, in seconds, shared by every engine: connect timeout,
// keep-alive probes and the idle health check.

const net = { connectTimeoutSec: 60, keepAliveSec: 60, healthCheckSec: 30 };

const clampSec = (v, min, max, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt; };

function configure(next = {}) {
  if (next.connectTimeoutSec !== undefined) net.connectTimeoutSec = clampSec(next.connectTimeoutSec, 1, 3600, 60);
  if (next.keepAliveSec !== undefined) net.keepAliveSec = clampSec(next.keepAliveSec, 0, 7200, 60);
  if (next.healthCheckSec !== undefined) {
    net.healthCheckSec = clampSec(next.healthCheckSec, 0, 3600, 30);
    // Required here rather than at the top: health.js reads these settings, so a top-level require would be circular.
    require('./health').startHealthCheck();
  }
  return { ...net };
}

/** Connect timeout for one connection: its own setting, else the gear-menu value. */
function connectTimeoutSec(cfg) {
  return Math.round(Number(cfg && cfg.connectTimeout)) || net.connectTimeoutSec;
}

module.exports = { net, configure, connectTimeoutSec };
