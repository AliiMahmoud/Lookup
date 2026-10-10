// Indexes (with usage), validation rules, creating / dropping / renaming collections and databases,
// and the Overview (server status). Changes follow the read-only and Production rules.
const { Op } = require('./connect');
const { toWire, fromWire, text } = require('./values');
const { guard } = require('./guard');

async function indexes(s, _ctx, { db, coll }) {
  const c = s.conn.client.db(db).collection(coll);
  const list = await s.conn.execute(new Op(`db.${coll}.getIndexes()`, () => c.listIndexes().toArray()));
  let usage = new Map();
  try {
    const st = await s.conn.execute(new Op(`db.${coll}.aggregate([{ $indexStats: {} }])`, () => c.aggregate([{ $indexStats: {} }]).toArray()));
    usage = new Map(st.map((x) => [x.name, { ops: Number(x.accesses && x.accesses.ops), since: x.accesses && x.accesses.since ? new Date(x.accesses.since).getTime() : null }]));
  } catch { /* not allowed, or not supported */ }
  let sizes = {};
  try {
    const st = await c.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    sizes = (st[0] && st[0].storageStats && st[0].storageStats.indexSizes) || {};
  } catch {
    try { sizes = (await s.conn.client.db(db).command({ collStats: coll })).indexSizes || {}; } catch { sizes = {}; }
  }
  return list.map((ix) => ({
    name: ix.name,
    key: toWire(ix.key),
    unique: !!ix.unique,
    sparse: !!ix.sparse,
    hidden: !!ix.hidden,
    ttl: ix.expireAfterSeconds !== undefined ? Number(ix.expireAfterSeconds) : null,
    partial: ix.partialFilterExpression ? toWire(ix.partialFilterExpression) : null,
    kinds: Object.values(ix.key).map(String).filter((v) => !/^-?1$/.test(v)), // text, 2dsphere, hashed …
    size: sizes[ix.name] !== undefined ? Number(sizes[ix.name]) : null,
    usage: usage.get(ix.name) || null,
  }));
}

/** { keys: { field: 1 }, options: { name, unique, sparse, expireAfterSeconds, partialFilterExpression, hidden } }. */
async function createIndex(s, _ctx, { db, coll, keys, options = {}, confirmed }) {
  if (!keys || !Object.keys(keys).length) throw new Error('Add at least one field to index');
  const opts = {};
  if (options.name) opts.name = String(options.name);
  if (options.unique) opts.unique = true;
  if (options.sparse) opts.sparse = true;
  if (options.hidden) opts.hidden = true;
  if (options.expireAfterSeconds !== undefined && options.expireAfterSeconds !== null && options.expireAfterSeconds !== '') opts.expireAfterSeconds = Number(options.expireAfterSeconds);
  if (options.partialFilterExpression && Object.keys(options.partialFilterExpression).length) opts.partialFilterExpression = fromWire(options.partialFilterExpression);
  guard(s, 'Creating an index', confirmed);
  const name = await s.conn.execute(new Op(`db.${coll}.createIndex(${text(keys)}${Object.keys(opts).length ? ', ' + text(toWire(opts)) : ''})`,
    (c) => c.db(db).collection(coll).createIndex(fromWire(keys), opts)));
  return { name };
}

async function dropIndex(s, _ctx, { db, coll, name, confirmed }) {
  if (name === '_id_') throw new Error('The _id index can\'t be dropped');
  guard(s, `Dropping index ${name}`, confirmed);
  await s.conn.execute(new Op(`db.${coll}.dropIndex('${name}')`, (c) => c.db(db).collection(coll).dropIndex(name)));
  return { dropped: name };
}

async function validation(s, _ctx, { db, coll }) {
  const [ci] = await s.conn.execute(new Op(`db.getCollectionInfos({ name: '${coll}' })`, (c) => c.db(db).listCollections({ name: coll }).toArray()));
  const o = (ci && ci.options) || {};
  return { validator: o.validator ? toWire(o.validator) : null, level: o.validationLevel || 'strict', action: o.validationAction || 'error' };
}

async function setValidation(s, _ctx, { db, coll, validator, level = 'strict', action = 'error', confirmed }) {
  guard(s, 'Changing the validation rules', confirmed);
  const cmd = { collMod: coll, validator: validator ? fromWire(validator) : {}, validationLevel: level, validationAction: action };
  await s.conn.execute(new Op(`db.runCommand({ collMod: '${coll}', validator: ${text(validator)}, validationLevel: '${level}', validationAction: '${action}' })`,
    (c) => c.db(db).command(cmd)));
  return { ok: true };
}

async function createCollection(s, _ctx, { db, name, options = {}, confirmed }) {
  if (!String(name || '').trim()) throw new Error('Enter a collection name');
  const opts = {};
  if (options.capped) { opts.capped = true; opts.size = Number(options.size) || 1048576; }
  if (options.timeField) opts.timeseries = { timeField: options.timeField, ...(options.metaField ? { metaField: options.metaField } : {}) };
  guard(s, `Creating collection ${name}`, confirmed);
  await s.conn.execute(new Op(`use ${db}; db.createCollection('${name}'${Object.keys(opts).length ? ', ' + JSON.stringify(opts) : ''})`, (c) => c.db(db).createCollection(name, opts)));
  return { created: name };
}

async function dropCollection(s, _ctx, { db, coll, confirmed }) {
  guard(s, `Dropping collection ${coll}`, confirmed);
  await s.conn.execute(new Op(`db.${coll}.drop()`, (c) => c.db(db).collection(coll).drop()));
  return { dropped: coll };
}

async function renameCollection(s, _ctx, { db, coll, to, confirmed }) {
  if (!String(to || '').trim()) throw new Error('Enter the new name');
  guard(s, `Renaming collection ${coll}`, confirmed);
  await s.conn.execute(new Op(`db.${coll}.renameCollection('${to}')`, (c) => c.db(db).collection(coll).rename(to)));
  return { renamed: to };
}

async function dropDatabase(s, _ctx, { db, confirmed }) {
  guard(s, `Dropping database ${db}`, confirmed);
  await s.conn.execute(new Op(`use ${db}; db.dropDatabase()`, (c) => c.db(db).dropDatabase()));
  return { dropped: db };
}

/** Server figures for the Overview: what the server shares with this user. */
async function overview(s) {
  const admin = s.conn.client.db('admin');
  const tryCmd = (cmd, label) => s.conn.execute(new Op(label, () => admin.command(cmd))).catch(() => null);
  const [st, hello, rs, build] = await Promise.all([
    tryCmd({ serverStatus: 1 }, 'db.serverStatus()'),
    tryCmd({ hello: 1 }, 'db.hello()'),
    tryCmd({ replSetGetStatus: 1 }, 'rs.status()'),
    tryCmd({ buildInfo: 1 }, 'db.version()'),
  ]);
  const n = (v) => (v === undefined || v === null ? null : Number(v));
  const oc = (st && st.opcounters) || {};
  return {
    version: build ? build.version : st ? st.version : null,
    product: build && build.ferretdbVersion ? `FerretDB ${build.ferretdbVersion}` : 'MongoDB',
    host: st ? st.host : null,
    uptimeSec: st ? n(st.uptime) : null,
    connections: st && st.connections ? { current: n(st.connections.current), available: n(st.connections.available) } : null,
    opcounters: { insert: n(oc.insert), query: n(oc.query), update: n(oc.update), delete: n(oc.delete), getmore: n(oc.getmore), command: n(oc.command) },
    residentMB: st && st.mem ? n(st.mem.resident) : null,
    network: st && st.network ? { bytesIn: n(st.network.bytesIn), bytesOut: n(st.network.bytesOut) } : null,
    cacheBytes: st && st.wiredTiger && st.wiredTiger.cache ? n(st.wiredTiger.cache['bytes currently in the cache']) : null,
    cacheMax: st && st.wiredTiger && st.wiredTiger.cache ? n(st.wiredTiger.cache['maximum bytes configured']) : null,
    topology: hello ? (hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replica set' : 'standalone') : null,
    setName: hello ? hello.setName || null : null,
    primary: hello ? hello.primary || null : null,
    me: hello ? hello.me || null : null,
    members: rs && Array.isArray(rs.members) ? rs.members.map((m) => ({ name: m.name, state: m.stateStr, health: n(m.health), lagSec: m.optimeDate && rs.members.find((x) => x.stateStr === 'PRIMARY') ? Math.round((new Date(rs.members.find((x) => x.stateStr === 'PRIMARY').optimeDate) - new Date(m.optimeDate)) / 1000) : null })) : null,
    at: Date.now(),
  };
}

module.exports = { indexes, createIndex, dropIndex, validation, setValidation, createCollection, dropCollection, renameCollection, dropDatabase, overview };
