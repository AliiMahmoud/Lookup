// Redis engine (own protocol client in resp.js: no driver, no client software). Connecting, lost
// connections and the SQL log work like the other engines; everything else is Redis-specific and
// reached through `ops` (db.engineOp in db/index.js): key browser, key tabs, Workbench, Shell, Overview.
const { open, targetKey } = require('./connect');
const keys = require('./keys');
const { load } = require('./value');
const edit = require('./edit');
const cli = require('./cli');
const { overview } = require('./overview');
const { parseInfo } = require('./overview');
const { Cmd } = require('./connect');

const LOST = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EPIPE|Connection (lost|closed)/i;

const isLostError = (e) => !!e && !e.redis && (LOST.test(String(e.code || '')) || LOST.test(String(e.message || '')));

const isCancelError = (e) => !!e && /^UNBLOCKED|Stopped/.test(String(e.message || ''));

async function describe(conn) {
  const info = parseInfo(await conn.execute(new Cmd(['INFO', 'server'])));
  const sv = info.server || {};
  const product = sv.server_name === 'valkey' ? 'Valkey' : sv.dragonfly_version ? 'Dragonfly' : null;
  const version = sv.valkey_version || sv.dragonfly_version || sv.redis_version || '';
  const cluster = conn.cluster ? { masters: conn.nodes.length } : null;
  return { version, schema: `db${conn.db}`, dbName: `db${conn.db}`, ...(product ? { product } : {}), mode: sv.redis_mode || null, cluster };
}

async function prepareSession() { return {}; }

/** Stop for Workbench commands; Shell tabs use Ctrl+C (shellStop). */
const cancel = (s) => cli.stop(s);

const ops = {
  keyspace: keys.keyspace,
  selectDb: keys.selectDb,
  scan: keys.scan,
  keyInfo: keys.keyInfo,
  load,
  apply: edit.apply,
  setTtl: edit.setTtl,
  rename: edit.rename,
  remove: edit.remove,
  create: edit.create,
  command: cli.command,
  stop: cli.stop,
  shellOpen: cli.shellOpen,
  shellRun: cli.shellRun,
  shellStop: cli.shellStop,
  shellClose: cli.shellClose,
  overview,
};

module.exports = {
  id: 'redis',
  profile: require('./profile'),
  dialect: require('./dialect'),
  // connecting
  open, describe, prepareSession, targetKey,
  cfgForDatabase: (cfg, db) => ({ ...cfg, database: Number(db.index) || 0 }),
  isLostError, isCancelError, cancel,
  ops,
};
