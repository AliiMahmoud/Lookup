// The Overview tab: server figures from INFO (refreshed by the window every few seconds), databases,
// modules and the slow log. Parts the user isn't allowed to read are simply left out.
const { Pipe } = require('./connect');
const { parseKeyspace } = require('./keys');

/** INFO text -> { section: { field: value } } (section names lower case). */
function parseInfo(text) {
  const out = {};
  let sec = 'default';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { sec = line.slice(1).trim().toLowerCase(); out[sec] = out[sec] || {}; continue; }
    const i = line.indexOf(':');
    if (i < 0) continue;
    (out[sec] = out[sec] || {})[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

async function nodeOverview(s, node) {
  const on = node ? ` on ${node}` : '';
  const [info, slow, modules] = await s.conn.execute(new Pipe([['INFO', 'everything'], ['SLOWLOG', 'GET', 10], ['MODULE', 'LIST']], `INFO everything · SLOWLOG GET 10 · MODULE LIST${on}`, node));
  // INFO everything needs Redis 7; older servers answer INFO all.
  const text = info instanceof Error ? await s.conn.execute(new Pipe([['INFO', 'all']], `INFO all${on}`, node)).then((r) => (r[0] instanceof Error ? '' : r[0])) : info;
  const i = parseInfo(text);
  const sv = i.server || {}; const cl = i.clients || {}; const mem = i.memory || {}; const st = i.stats || {};
  const per = i.persistence || {}; const rep = i.replication || {};
  const hits = num(st.keyspace_hits); const misses = num(st.keyspace_misses);
  return {
    product: sv.server_name === 'valkey' ? 'Valkey' : 'Redis',
    version: sv.valkey_version || sv.redis_version || null,
    mode: sv.redis_mode || null,
    uptimeSec: num(sv.uptime_in_seconds),
    opsPerSec: num(st.instantaneous_ops_per_sec),
    totalCommands: num(st.total_commands_processed),
    netInKbps: num(st.instantaneous_input_kbps),
    netOutKbps: num(st.instantaneous_output_kbps),
    usedMemory: num(mem.used_memory),
    peakMemory: num(mem.used_memory_peak),
    maxMemory: num(mem.maxmemory),
    systemMemory: num(mem.total_system_memory),
    policy: mem.maxmemory_policy || null,
    fragmentation: num(mem.mem_fragmentation_ratio),
    clients: num(cl.connected_clients),
    blocked: num(cl.blocked_clients),
    rejected: num(st.rejected_connections),
    hits, misses,
    hitRate: hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null,
    expiredKeys: num(st.expired_keys),
    evictedKeys: num(st.evicted_keys),
    keyspace: parseKeyspace(Object.entries(i.keyspace || {}).map(([k, v]) => `${k}:${v}`).join('\n')),
    rdb: { lastSave: num(per.rdb_last_save_time), changes: num(per.rdb_changes_since_last_save), saving: per.rdb_bgsave_in_progress === '1' },
    aof: per.aof_enabled === '1',
    role: rep.role || null,
    replicas: num(rep.connected_slaves),
    masterHost: rep.master_host ? `${rep.master_host}:${rep.master_port}` : null,
    masterLink: rep.master_link_status || null,
    modules: Array.isArray(modules) ? modules.map((m) => {
      const o = {};
      for (let k = 0; k < m.length; k += 2) o[m[k]] = m[k + 1];
      return { name: String(o.name), ver: o.ver !== undefined ? String(o.ver) : null };
    }) : [],
    slowlog: Array.isArray(slow) ? slow.map((e) => ({
      id: e[0], at: Number(e[1]) * 1000, us: Number(e[2]),
      command: (Array.isArray(e[3]) ? e[3] : []).map((a) => (Buffer.isBuffer(a) ? '<binary>' : String(a))).join(' ').slice(0, 300),
      client: e[4] ? String(e[4]) : null,
    })) : null,
    at: Date.now(),
  };
}

/** Standalone: the server's figures. Cluster: each master's figures, added up, plus a row per node. */
async function overview(s) {
  if (!s.conn.cluster) return nodeOverview(s);
  const masters = s.conn.nodes;
  const per = await Promise.all(masters.map((n) => nodeOverview(s, n.id).catch((e) => ({ error: e.message }))));
  const ok = per.filter((o) => !o.error);
  const base = ok[0] || {};
  const sum = (k) => (ok.some((o) => o[k] !== null && o[k] !== undefined) ? ok.reduce((a, o) => a + (o[k] || 0), 0) : null);
  const hits = sum('hits'); const misses = sum('misses');
  const keys = ok.reduce((a, o) => a + ((o.keyspace.find((d) => d.index === 0) || {}).keys || 0), 0);
  const expires = ok.reduce((a, o) => a + ((o.keyspace.find((d) => d.index === 0) || {}).expires || 0), 0);
  return {
    ...base,
    mode: 'cluster',
    uptimeSec: ok.length ? Math.min(...ok.map((o) => o.uptimeSec || 0)) : null,
    opsPerSec: sum('opsPerSec'), totalCommands: sum('totalCommands'), netInKbps: sum('netInKbps'), netOutKbps: sum('netOutKbps'),
    usedMemory: sum('usedMemory'), peakMemory: sum('peakMemory'), maxMemory: ok.every((o) => o.maxMemory) ? sum('maxMemory') : 0, systemMemory: null,
    clients: sum('clients'), blocked: sum('blocked'), rejected: sum('rejected'), hits, misses,
    hitRate: hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null,
    expiredKeys: sum('expiredKeys'), evictedKeys: sum('evictedKeys'),
    keyspace: [{ index: 0, keys, expires, avgTtl: 0 }],
    replicas: masters.reduce((a, n) => a + n.replicas.length, 0),
    slowlog: ok.some((o) => Array.isArray(o.slowlog))
      ? per.flatMap((o, i) => (o.error ? [] : (o.slowlog || []).map((e) => ({ ...e, node: masters[i].id })))).sort((a, b) => b.at - a.at).slice(0, 10)
      : null,
    nodes: masters.map((n, i) => {
      const o = per[i];
      const slots = n.ranges.reduce((a, [f, t]) => a + t - f + 1, 0);
      return o.error ? { id: n.id, error: o.error, slots, ranges: n.ranges, replicas: n.replicas }
        : { id: n.id, role: o.role, slots, ranges: n.ranges, replicas: n.replicas, usedMemory: o.usedMemory, opsPerSec: o.opsPerSec, clients: o.clients, keys: (o.keyspace.find((d) => d.index === 0) || {}).keys || 0, version: o.version };
    }),
  };
}

module.exports = { overview, nodeOverview, parseInfo };
