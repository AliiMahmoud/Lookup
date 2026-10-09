// Connect descriptor and options, and the network settings from the gear menu (seconds).
const { ora } = require('./driver');

function connectString(cfg) {
  if (cfg.mode === 'string') return cfg.connectString;
  const host = cfg.host || 'localhost';
  const port = cfg.port || 1521;
  // A full descriptor avoids Easy Connect parsing edge cases (e.g. very short service names).
  const target = cfg.serviceType === 'sid' ? `(SID=${cfg.service})` : `(SERVICE_NAME=${cfg.service || ''})`;
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=${target}))`;
}

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

// The driver's expireTime option only takes whole minutes, but EXPIRE_TIME inside a connect
// descriptor may be a fraction of a minute, so seconds are passed that way.
function withKeepAlive(connectStr, sec) {
  if (!sec || !/^\s*\(\s*DESCRIPTION\s*=/i.test(connectStr) || /EXPIRE_TIME/i.test(connectStr)) return connectStr;
  const min = Number((sec / 60).toFixed(4));
  return connectStr.replace(/^\s*\(\s*DESCRIPTION\s*=/i, `(DESCRIPTION=(EXPIRE_TIME=${min})`);
}

function connectOptions(cfg) {
  const cs = connectString(cfg);
  const opts = { user: cfg.user, password: cfg.password, connectString: withKeepAlive(cs, net.keepAliveSec) };
  if (cfg.role === 'SYSDBA') opts.privilege = ora().SYSDBA;
  else if (cfg.role === 'SYSOPER') opts.privilege = ora().SYSOPER;
  else if (cfg.role === 'SYSBACKUP') opts.privilege = ora().SYSBACKUP;
  // Give up connecting after the configured time (a connection may override it).
  const t = Math.round(Number(cfg.connectTimeout)) || net.connectTimeoutSec;
  opts.connectTimeout = t;
  opts.transportConnectTimeout = t;
  // TCP keep-alive probes, so a dead server or network is noticed. Easy Connect strings can't carry
  // seconds, so they get the nearest whole minute.
  if (net.keepAliveSec && opts.connectString === cs) opts.expireTime = Math.max(1, Math.round(net.keepAliveSec / 60));
  return opts;
}

module.exports = { net, connectOptions, connectString, configure };
