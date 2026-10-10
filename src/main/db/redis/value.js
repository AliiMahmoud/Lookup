// Reading a key's value for its tab, one page at a time: strings (cut at 512 KB), hashes and sets
// with HSCAN / SSCAN (a filter is a MATCH pattern), lists by index, sorted sets by rank or filtered,
// streams newest first, RedisJSON documents.
const { Cmd } = require('./connect');
const { out, inp } = require('./values');

const STRING_MAX = 512 * 1024;
const PAGE = 100;
const SCAN_MAX_CALLS = 50; // per page, so a sparse filter on a huge hash can't hang the tab

const hasGlob = (p) => /[*?[\\]/.test(p);
const matchOf = (filter) => { const f = String(filter || '').trim(); return !f ? null : hasGlob(f) ? f : `*${f.replace(/[*?[\]\\]/g, '\\$&')}*`; };

async function scanPage(s, cmd, k, { cursor = '0', filter, count = PAGE }) {
  const match = matchOf(filter);
  const items = [];
  let cur = String(cursor);
  let calls = 0;
  do {
    const args = [cmd, k, cur, 'COUNT', Math.max(count, 100)];
    if (match) args.push('MATCH', match);
    const [next, flat] = await s.conn.execute(new Cmd(args));
    cur = String(next);
    items.push(...flat);
    calls++;
  } while (cur !== '0' && items.length < count * (cmd === 'SSCAN' ? 1 : 2) && calls < SCAN_MAX_CALLS);
  return { flat: items, cursor: cur, done: cur === '0' };
}

/** Stream ids: the one just before an id (for paging newest first without "(" ranges on old servers). */
function idBefore(id) {
  const [ms, seq] = String(id).split('-').map((x) => BigInt(x));
  if (seq > 0n) return `${ms}-${seq - 1n}`;
  if (ms > 0n) return `${ms - 1n}-18446744073709551615`;
  return null;
}

const LOADERS = {
  async string(s, k) {
    const len = await s.conn.execute(new Cmd(['STRLEN', k]));
    const v = len > STRING_MAX
      ? await s.conn.execute(new Cmd(['GETRANGE', k, 0, STRING_MAX - 1]))
      : await s.conn.execute(new Cmd(['GET', k]));
    return { value: out(v), total: len, truncated: len > STRING_MAX, command: len > STRING_MAX ? 'GETRANGE' : 'GET' };
  },

  async hash(s, k, p) {
    const r = await scanPage(s, 'HSCAN', k, p);
    const items = [];
    for (let i = 0; i < r.flat.length; i += 2) items.push({ field: out(r.flat[i]), value: out(r.flat[i + 1]) });
    return { items, cursor: r.cursor, done: r.done, total: await s.conn.execute(new Cmd(['HLEN', k])), command: 'HSCAN' };
  },

  async set(s, k, p) {
    const r = await scanPage(s, 'SSCAN', k, p);
    return { items: r.flat.map((m) => ({ member: out(m) })), cursor: r.cursor, done: r.done, total: await s.conn.execute(new Cmd(['SCARD', k])), command: 'SSCAN' };
  },

  async list(s, k, { start = 0, count = PAGE }) {
    const from = Math.max(0, Number(start) || 0);
    const v = await s.conn.execute(new Cmd(['LRANGE', k, from, from + count - 1]));
    const total = await s.conn.execute(new Cmd(['LLEN', k]));
    return { items: v.map((x, i) => ({ index: from + i, value: out(x) })), start: from, total, command: 'LRANGE' };
  },

  async zset(s, k, { start = 0, count = PAGE, order = 'desc', filter, cursor }) {
    const total = await s.conn.execute(new Cmd(['ZCARD', k]));
    if (String(filter || '').trim()) {
      const r = await scanPage(s, 'ZSCAN', k, { cursor, filter, count });
      const items = [];
      for (let i = 0; i < r.flat.length; i += 2) items.push({ member: out(r.flat[i]), score: String(r.flat[i + 1]) });
      items.sort((a, b) => (order === 'desc' ? Number(b.score) - Number(a.score) : Number(a.score) - Number(b.score)));
      return { items, cursor: r.cursor, done: r.done, total, filtered: true, command: 'ZSCAN' };
    }
    const from = Math.max(0, Number(start) || 0);
    const to = from + count - 1;
    let flat;
    if (order === 'desc') flat = await s.conn.execute(new Cmd(['ZREVRANGE', k, from, to, 'WITHSCORES']));
    else flat = await s.conn.execute(new Cmd(['ZRANGE', k, from, to, 'WITHSCORES']));
    const items = [];
    for (let i = 0; i < flat.length; i += 2) items.push({ rank: from + i / 2, member: out(flat[i]), score: String(flat[i + 1]) });
    return { items, start: from, total, command: order === 'desc' ? 'ZREVRANGE' : 'ZRANGE' };
  },

  async stream(s, k, { end = '+', count = PAGE }) {
    const raw = await s.conn.execute(new Cmd(['XREVRANGE', k, end, '-', 'COUNT', count + 1]));
    const more = raw.length > count;
    const entries = raw.slice(0, count).map(([id, fields]) => {
      const f = [];
      for (let i = 0; i < fields.length; i += 2) f.push([out(fields[i]), out(fields[i + 1])]);
      return { id: String(id), fields: f };
    });
    const last = entries[entries.length - 1];
    const total = await s.conn.execute(new Cmd(['XLEN', k]));
    let groups = [];
    try {
      const g = await s.conn.execute(new Cmd(['XINFO', 'GROUPS', k]));
      groups = g.map((row) => { const o = {}; for (let i = 0; i < row.length; i += 2) o[row[i]] = out(row[i + 1]); return o; });
    } catch { /* not allowed for this user */ }
    return { entries, total, next: more && last ? idBefore(last.id) : null, groups, command: 'XREVRANGE' };
  },

  async json(s, k) {
    const v = await s.conn.execute(new Cmd(['JSON.GET', k]));
    return { value: out(v), command: 'JSON.GET' };
  },
};

/** One page of a key's value; p carries paging (cursor / start / end), filter and order. */
async function load(s, _ctx, { key, type, ...p }) {
  const fn = LOADERS[type];
  if (!fn) throw new Error(`Lookup can't show ${type} keys yet. Use the Workbench or the Shell to read this key.`);
  const t0 = Date.now();
  const r = await fn(s, inp(key), p);
  r.ms = Date.now() - t0;
  return r;
}

module.exports = { load, idBefore, STRING_MAX };
