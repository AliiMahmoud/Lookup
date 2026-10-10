// Oracle connect descriptor and driver options (service / SID, role, timeouts, keep-alive in seconds).
const { ora } = require('./driver');
const { net, connectTimeoutSec } = require('../common/net');

function connectString(cfg) {
  if (cfg.mode === 'string') return cfg.connectString;
  const host = cfg.host || 'localhost';
  const port = cfg.port || 1521;
  // A full descriptor avoids Easy Connect parsing edge cases (e.g. very short service names).
  const target = cfg.serviceType === 'sid' ? `(SID=${cfg.service})` : `(SERVICE_NAME=${cfg.service || ''})`;
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=${target}))`;
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
  const t = connectTimeoutSec(cfg);
  opts.connectTimeout = t;
  opts.transportConnectTimeout = t;
  // TCP keep-alive probes, so a dead server or network is noticed. Easy Connect strings can't carry
  // seconds, so they get the nearest whole minute.
  if (net.keepAliveSec && opts.connectString === cs) opts.expireTime = Math.max(1, Math.round(net.keepAliveSec / 60));
  return opts;
}

/** Opens one driver connection (the workspace session, Test, or an export's own connection). */
function open(cfg) {
  return ora().getConnection(connectOptions(cfg));
}

/** Same database login = same target + user + role (used to avoid a second session to it). */
function targetKey(cfg) {
  const target = cfg.mode === 'string'
    ? String(cfg.connectString || '').replace(/\s+/g, '').toLowerCase()
    : `${String(cfg.host || 'localhost').toLowerCase()}:${cfg.port || 1521}/${String(cfg.service || '').toLowerCase()}/${cfg.serviceType || 'service'}`;
  return `${target}|${String(cfg.user || '').toUpperCase()}|${cfg.role || 'DEFAULT'}`;
}

/** The same login pointed at another PDB (from the databases menu). */
function cfgForDatabase(base, pdb) {
  if (base.mode !== 'string') return { ...base, serviceType: 'service', service: pdb.service };
  const cs = String(base.connectString || '');
  let next = null;
  if (/SERVICE_NAME\s*=/i.test(cs)) next = cs.replace(/(SERVICE_NAME\s*=\s*)[^)\s]+/i, `$1${pdb.service}`);
  else if (/^[^()]+\/[^/]+$/.test(cs.trim())) next = cs.trim().replace(/\/[^/]+$/, `/${pdb.service}`);
  if (!next) throw new Error('Cannot derive a connect string for this PDB from the current one.');
  return { ...base, connectString: next };
}

module.exports = { connectString, connectOptions, open, targetKey, cfgForDatabase };
