// The MongoDB sidebar: databases, their collections (views and time-series marked) with document
// counts from the collection metadata (fast), and collection statistics for the tab header.
const { Op } = require('./connect');

const SYSTEM_DBS = new Set(['admin', 'config', 'local']);

async function databases(s) {
  let list = [];
  let note = null;
  try {
    const r = await s.conn.execute(new Op('db.adminCommand({ listDatabases: 1, authorizedDatabases: true })',
      (c) => c.db('admin').command({ listDatabases: 1, authorizedDatabases: true })));
    list = r.databases.map((d) => ({ name: d.name, size: Number(d.sizeOnDisk) || 0, empty: !!d.empty, system: SYSTEM_DBS.has(d.name) }));
  } catch (e) { note = `Databases can't be listed for this user (${e.message.split('\n')[0]}). Showing the connection's database.`; }
  if (s.conn.dbName && !list.some((d) => d.name === s.conn.dbName)) list.push({ name: s.conn.dbName, size: 0, empty: true, system: false });
  list.sort((a, b) => (a.system - b.system) || a.name.localeCompare(b.name));
  return { list, current: s.conn.dbName, note };
}

/** Runs async jobs a few at a time (counts for many collections without flooding the server). */
async function limited(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function collections(s, _ctx, { db }) {
  const infos = await s.conn.execute(new Op(`use ${db}; db.getCollectionInfos()`,
    (c) => c.db(db).listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray()));
  const counts = await limited(infos, 6, async (ci) => {
    if (ci.type === 'view') return null;
    try { return await s.conn.client.db(db).collection(ci.name).estimatedDocumentCount({ maxTimeMS: 5000 }); } catch { return null; }
  });
  return infos.map((ci, i) => ({
    name: ci.name,
    type: ci.type === 'view' ? 'view' : ci.options && ci.options.timeseries ? 'timeseries' : 'collection',
    count: counts[i],
    viewOn: ci.options && ci.options.viewOn ? ci.options.viewOn : null,
    system: ci.name.startsWith('system.'),
  })).sort((a, b) => (a.system - b.system) || a.name.localeCompare(b.name));
}

/** Count, sizes and indexes of a collection; parts the server won't give are left out. */
async function collStats(s, _ctx, { db, coll }) {
  const c = s.conn.client.db(db);
  let st = null;
  try {
    const [r] = await s.conn.execute(new Op(`db.${coll}.aggregate([{ $collStats: { storageStats: {} } }])`,
      () => c.collection(coll).aggregate([{ $collStats: { storageStats: {} } }]).toArray()));
    st = r && r.storageStats;
  } catch { /* older servers, views, FerretDB */ }
  if (!st) {
    try { st = await s.conn.execute(new Op(`db.runCommand({ collStats: '${coll}' })`, () => c.command({ collStats: coll }))); } catch { st = null; }
  }
  const num = (v) => (v === undefined || v === null ? null : Number(v));
  return st ? {
    count: num(st.count), size: num(st.size), avgObjSize: num(st.avgObjSize), storageSize: num(st.storageSize),
    indexes: num(st.nindexes), indexSize: num(st.totalIndexSize), capped: !!st.capped,
  } : { count: null };
}

module.exports = { databases, collections, collStats, SYSTEM_DBS };
