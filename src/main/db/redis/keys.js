// The key browser: SCAN in steps (never KEYS), with each key's type, time to live and memory read in
// one pipelined round trip; the databases list; switching database; details of one key.
const { Cmd, Pipe } = require('./connect');
const { out, inp, typeName } = require('./values');

const SCAN_COUNT = 1000; // keys the server looks at per SCAN call
const WANT = 300; // keys to find per "Scan more"
const MAX_LOOK = 20000; // keys looked at per "Scan more" at most (sparse matches on big databases)

const hasGlob = (p) => /[*?[\\]/.test(p);
const escapeGlob = (p) => p.replace(/[*?[\]\\]/g, '\\$&');

/** SCAN's TYPE option needs Redis 6; older servers are filtered after reading each key's type. */
async function scanStep(s, cursor, match, type, node) {
  const args = ['SCAN', cursor, 'MATCH', match, 'COUNT', SCAN_COUNT];
  if (type && s.scanType !== false) {
    try {
      return await s.conn.execute(new Cmd([...args, 'TYPE', type === 'json' ? 'ReJSON-RL' : type], node));
    } catch (e) {
      if (!/syntax|wrong number/i.test(e.message)) throw e;
      s.scanType = false;
    }
  }
  return s.conn.execute(new Cmd(args, node));
}

/** Cursor of a scan: on a cluster "<master number>:<that master's cursor>", masters one after another. */
function parseCursor(s, cursor) {
  if (!s.conn.cluster) return { i: 0, cur: String(cursor) };
  const m = /^(\d+):(\d+)$/.exec(String(cursor));
  return m ? { i: Number(m[1]), cur: m[2] } : { i: 0, cur: '0' };
}

/** Type, time to live (ms, -1 = no expiry) and memory of keys, in one round trip. */
async function describeKeys(s, keys) {
  if (!keys.length) return [];
  const cmds = [];
  for (const k of keys) cmds.push(['TYPE', k], ['PTTL', k], ['MEMORY', 'USAGE', k]);
  const r = await s.conn.execute(new Pipe(cmds, `TYPE / PTTL / MEMORY USAGE for ${keys.length} key${keys.length === 1 ? '' : 's'} (one round trip)`));
  return keys.map((k, i) => {
    const [type, ttl, size] = r.slice(3 * i, 3 * i + 3);
    return {
      key: out(k),
      type: typeName(type instanceof Error ? 'none' : type),
      ttl: typeof ttl === 'number' ? ttl : null,
      size: typeof size === 'number' ? size : null,
    };
  }).filter((k) => k.type !== 'none'); // deleted between SCAN and TYPE
}

/**
 * One "Scan more" step. match: a pattern (user:*), or plain text = keys containing it (and the exact
 * key first). Returns { keys, cursor, done, looked }.
 */
async function scan(s, _ctx, { cursor = '0', match = '', type = null } = {}) {
  const text = String(match || '').trim();
  const pattern = !text ? '*' : hasGlob(text) ? text : `*${escapeGlob(text)}*`;
  const found = [];
  const seen = new Set();
  // Plain text: the exact key is shown first, without waiting for the scan to reach it.
  if (cursor === '0' && text && !hasGlob(text)) {
    if (await s.conn.execute(new Cmd(['EXISTS', text]))) { found.push(Buffer.from(text)); seen.add(text); }
  }
  let looked = 0;
  const masters = s.conn.masterIds();
  let { i, cur } = parseCursor(s, cursor);
  let done = false;
  do {
    const [next, keys] = await scanStep(s, cur, pattern, type, s.conn.cluster ? masters[i] : undefined);
    cur = String(next);
    looked += SCAN_COUNT;
    for (const k of keys) {
      const id = Buffer.isBuffer(k) ? k.toString('base64') : k;
      if (!seen.has(id)) { seen.add(id); found.push(k); }
    }
    if (cur === '0') { i++; if (i >= masters.length || !s.conn.cluster) done = true; } // next master
  } while (!done && found.length < WANT && looked < MAX_LOOK);
  let keys = await describeKeys(s, found);
  if (type && s.scanType === false) keys = keys.filter((k) => k.type === type);
  const next = done ? '0' : s.conn.cluster ? `${i}:${cur}` : cur;
  return { keys, cursor: next, done, looked };
}

function parseKeyspace(text) {
  const dbs = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^db(\d+):(.*)$/.exec(line.trim());
    if (!m) continue;
    const f = Object.fromEntries(m[2].split(',').map((p) => p.split('=')));
    dbs.push({ index: Number(m[1]), keys: Number(f.keys) || 0, expires: Number(f.expires) || 0, avgTtl: Number(f.avg_ttl) || 0 });
  }
  return dbs;
}

/** Databases with keys, how many databases the server has, and the selected one. */
async function keyspace(s) {
  if (s.conn.cluster) return clusterKeyspace(s);
  const [info, conf, size] = await s.conn.execute(new Pipe([['INFO', 'keyspace'], ['CONFIG', 'GET', 'databases'], ['DBSIZE']], 'INFO keyspace · CONFIG GET databases · DBSIZE'));
  const dbs = info instanceof Error ? [] : parseKeyspace(info);
  const count = Array.isArray(conf) && conf.length >= 2 ? Number(conf[1]) || 16 : Math.max(16, ...dbs.map((d) => d.index + 1));
  return { current: s.conn.db, count, dbs, dbSize: typeof size === 'number' ? size : null };
}

/** Cluster: database 0 only; keys and expiries added up over the masters. */
async function clusterKeyspace(s) {
  const ids = s.conn.masterIds();
  const per = await Promise.all(ids.map((id) => s.conn.execute(new Pipe([['INFO', 'keyspace'], ['DBSIZE']], `INFO keyspace · DBSIZE on ${id}`, id))));
  let keys = 0; let expires = 0; let avg = 0;
  for (const [info, size] of per) {
    if (typeof size === 'number') keys += size;
    const d = info instanceof Error ? null : parseKeyspace(info).find((x) => x.index === 0);
    if (d) { expires += d.expires; avg = Math.max(avg, d.avgTtl); }
  }
  return { current: 0, count: 1, dbs: [{ index: 0, keys, expires, avgTtl: avg }], dbSize: keys, cluster: { masters: ids.length, nodes: s.conn.nodes } };
}

async function selectDb(s, _ctx, { index }) {
  const n = Number(index);
  if (s.conn.cluster && n !== 0) throw new Error('A Redis cluster has only database 0');
  if (!Number.isInteger(n) || n < 0) throw new Error('Pick a database number');
  await s.conn.execute(new Cmd(['SELECT', n]));
  s.conn.db = n;
  s.schema = `db${n}`;
  if (s.wb && !s.wb.closed) await s.wb.call('SELECT', n).catch(() => s.wb.destroy());
  return keyspace(s);
}

const LENGTH = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' };

/** Header of a key's tab: type, time to live, memory, encoding, number of items. */
async function keyInfo(s, _ctx, { key }) {
  const k = inp(key);
  const [type, ttl, size, enc] = await s.conn.execute(new Pipe([['TYPE', k], ['PTTL', k], ['MEMORY', 'USAGE', k], ['OBJECT', 'ENCODING', k]], 'TYPE / PTTL / MEMORY USAGE / OBJECT ENCODING'));
  const t = typeName(type instanceof Error ? 'none' : type);
  if (t === 'none') return { exists: false, key: out(k) };
  let length = null;
  if (LENGTH[t]) length = await s.conn.execute(new Cmd([LENGTH[t], k])).catch(() => null);
  return {
    exists: true, key: out(k), type: t,
    ttl: typeof ttl === 'number' ? ttl : null,
    size: typeof size === 'number' ? size : null,
    encoding: enc instanceof Error ? null : out(enc),
    length: typeof length === 'number' ? length : null,
  };
}

module.exports = { scan, keyspace, selectDb, keyInfo, parseKeyspace, describeKeys };
