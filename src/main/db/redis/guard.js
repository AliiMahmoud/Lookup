// Which commands change data, for read-only connections (blocked) and Production connections (asked
// first in the window). Known commands come from shared/redis-commands.js; others (modules, newer
// versions) are asked from the server once with COMMAND INFO and remembered for the session.
const { kindOf } = require('../../../shared/redis-commands');
const { Cmd } = require('./connect');

async function kind(s, args) {
  const k = kindOf(args.map((a) => (Buffer.isBuffer(a) ? a.toString('latin1') : String(a))));
  if (k) return k;
  const name = String(args[0] || '').toUpperCase();
  if (!name) return 'read';
  if (s.conn.kinds.has(name)) return s.conn.kinds.get(name);
  let found = 'read';
  try {
    const info = await s.conn.execute(new Cmd(['COMMAND', 'INFO', name]));
    const flags = info && info[0] && Array.isArray(info[0][2]) ? info[0][2].map(String) : [];
    if (flags.includes('write')) found = 'write';
    else if (flags.includes('admin') && !flags.includes('readonly')) found = 'admin';
  } catch { /* COMMAND not allowed for this user: treat as reading */ }
  s.conn.kinds.set(name, found);
  return found;
}

/** Throws when the commands may not run as they are: read-only connection, or Production without a yes. */
async function guard(s, list, confirmed) {
  const writes = [];
  for (const args of list) if ((await kind(s, args)) !== 'read') writes.push(String(args[0]).toUpperCase());
  if (!writes.length) return false;
  if (s.conn.readOnly) {
    throw Object.assign(new Error(`This connection is read-only, so ${writes[0]} was not sent. Turn off "Read-only" in the connection's settings to change data.`), { code: 'READ_ONLY' });
  }
  if ((s.cfg.env === 'prod' || s.cfg.env === 'production') && !confirmed) {
    throw Object.assign(new Error(`${[...new Set(writes)].join(', ')} will change data on a Production connection.`), { code: 'CONFIRM_WRITE' });
  }
  return true;
}

module.exports = { guard, kind };
