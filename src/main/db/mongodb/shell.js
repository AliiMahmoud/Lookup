// Lookup's light MongoDB shell (a mongosh subset, see shared/mongo-shell.js): one command at a time,
// parsed here (no JavaScript is run): show / use / it, db.<collection>.<method>(…) with cursor methods
// (.sort() .limit() …), db.<method>(…). Values are mongosh literals (shared/mongo-lit.js). Results go
// back as Extended JSON and the window prints them the way mongosh does. Commands that change data
// follow the read-only and Production rules; Ctrl+C stops the running command.
const { toWire, fromWire, READ } = require('./values');
const { guard } = require('./guard');
const { Parser, LitError } = require('../../../shared/mongo-lit');
const { COLLECTION_METHODS, CURSOR_METHODS, DB_METHODS, HELP } = require('../../../shared/mongo-shell');

const BATCH = 20;
const NOT_JS = 'Lookup\'s shell runs one command at a time: show, use, it, db.<collection>.<method>(…) and db.<method>(…). Variables, functions, loops and other JavaScript aren\'t supported.';

// Commands that only read (db.runCommand / adminCommand); any other command counts as a change.
const READ_COMMANDS = new Set(['find', 'aggregate', 'count', 'distinct', 'listcollections', 'listdatabases', 'listindexes', 'dbstats', 'collstats',
  'serverstatus', 'hello', 'ismaster', 'buildinfo', 'ping', 'explain', 'connectionstatus', 'getparameter', 'hostinfo', 'replsetgetstatus',
  'replsetgetconfig', 'currentop', 'top', 'getcmdlineopts', 'getlog', 'usersinfo', 'rolesinfo', 'datasize', 'whatsmyuri', 'getmore', 'validate', 'listcommands', 'features']);

class ShellError extends Error {}

// ---------- Parsing ----------

/** A command as a chain: db . name . name ( args ) . name ( args ) … */
function parseChain(text) {
  const p = new Parser(text);
  const head = p.ident();
  if (head !== 'db') throw new ShellError(NOT_JS);
  const chain = [];
  for (;;) {
    const c = p.peek();
    if (c === undefined || c === ';') break;
    if (c === '.') { p.i++; const n = p.ident(); if (!n) throw new ShellError('Expected a name after .'); chain.push({ name: n }); continue; }
    if (c === '[') { p.i++; const q = p.peek(); if (q !== '"' && q !== "'") throw new ShellError('Use db[\'name\'] or db.getCollection(\'name\')'); chain.push({ name: p.string() }); p.eat(']'); continue; }
    if (c === '(') { const args = p.args(); if (!chain.length || chain[chain.length - 1].args) throw new ShellError(NOT_JS); chain[chain.length - 1].args = args; continue; }
    throw new ShellError(NOT_JS);
  }
  while (p.peek() === ';') p.i++;
  if (p.peek() !== undefined) throw new ShellError('One command at a time, please');
  return chain;
}

/** chain -> { db?: name, target: 'db' | 'coll', coll, method, args, cursor: [{ name, args }] } */
function plan(chain) {
  let i = 0;
  let db = null;
  if (chain[0] && chain[0].name === 'getSiblingDB' && chain[0].args) { db = str(chain[0].args[0], 'getSiblingDB'); i = 1; }
  const first = chain[i];
  if (!first) throw new ShellError('Add a collection and a method, e.g. db.orders.find()');
  // db.method(…)
  if (first.args && first.name !== 'getCollection') {
    if (!DB_METHODS.has(first.name)) throw new ShellError(`db.${first.name}() isn't supported. Type help to see what is.`);
    if (chain.length > i + 1) throw new ShellError(`Nothing can follow db.${first.name}()`);
    return { db, target: 'db', method: first.name, args: first.args };
  }
  let coll;
  if (first.name === 'getCollection') { if (!first.args) throw new ShellError('getCollection needs a name'); coll = str(first.args[0], 'getCollection'); } else coll = first.name;
  i++;
  // Collection names may contain dots: db.system.profile.find() -> collection "system.profile".
  while (chain[i] && !chain[i].args && chain[i + 1]) { coll += '.' + chain[i].name; i++; }
  const m = chain[i];
  if (!m) throw new ShellError(`Add a method, e.g. db.${coll}.find()`);
  if (!m.args) throw new ShellError(`db.${coll}.${m.name} needs () to run`);
  if (!COLLECTION_METHODS.has(m.name)) throw new ShellError(`${m.name}() isn't a collection method Lookup's shell knows. Type help to see what is.`);
  const cursor = chain.slice(i + 1).map((x) => {
    if (!x.args) throw new ShellError(`.${x.name} needs () to run`);
    if (!CURSOR_METHODS.has(x.name)) throw new ShellError(`.${x.name}() isn't a cursor method Lookup's shell knows`);
    return x;
  });
  if (cursor.length && m.name !== 'find' && m.name !== 'aggregate') throw new ShellError(`${m.name}() doesn't return a cursor`);
  return { db, target: 'coll', coll, method: m.name, args: m.args, cursor };
}

const str = (v, fn) => { if (typeof v !== 'string') throw new ShellError(`${fn}() needs a name in quotes`); return v; };
const num = (v) => { if (typeof v === 'number') return v; const s = v && (v.$numberInt ?? v.$numberDouble ?? v.$numberLong); const n = Number(s); if (!Number.isFinite(n)) throw new ShellError('Expected a number'); return n; };
const obj = (v) => (v === undefined ? undefined : fromWire(v));

// ---------- Running ----------

function sessionsOf(s) { return s.mshells || (s.mshells = new Map()); }

/** Prompt parts: replica set name and role, or mongos, plus the database. */
async function topology(s) {
  try {
    const h = await s.conn.client.db('admin').command({ hello: 1 });
    if (h.msg === 'isdbgrid') return { kind: 'mongos' };
    if (h.setName) return { kind: 'rs', setName: h.setName, role: h.isWritablePrimary ? 'primary' : h.secondary ? 'secondary' : 'other' };
  } catch { /* hello not allowed */ }
  return { kind: 'standalone' };
}

async function shellOpen(s, _ctx, { id, db }) {
  const sh = { db: db || s.conn.dbName, cursor: null };
  sessionsOf(s).set(id, sh);
  return { db: sh.db, topology: await topology(s) };
}

async function shellClose(s, _ctx, { id }) {
  const sh = sessionsOf(s).get(id);
  if (!sh) return;
  sessionsOf(s).delete(id);
  if (sh.cursor) sh.cursor.close().catch(() => {});
  if (sh.stop) sh.stop();
}

/** Ctrl+C: aborts the running command (and the server work, when allowed). */
async function shellStop(s, _ctx, { id }) {
  const sh = sessionsOf(s).get(id);
  if (sh && sh.stop) sh.stop();
  return { stopped: true };
}

function isWrite(p) {
  if (p.target === 'db') {
    if (p.method === 'runCommand' || p.method === 'adminCommand') {
      const cmd = p.args[0];
      if (!cmd || typeof cmd !== 'object') return false;
      const name = Object.keys(cmd)[0] || '';
      if (name.toLowerCase() === 'aggregate') return Array.isArray(cmd.pipeline) && cmd.pipeline.some((st) => /^\$(out|merge)$/.test(Object.keys(st)[0]));
      return !READ_COMMANDS.has(name.toLowerCase());
    }
    return DB_METHODS.get(p.method).write;
  }
  if (p.method === 'aggregate') return Array.isArray(p.args[0]) && p.args[0].some((st) => /^\$(out|merge)$/.test(Object.keys(st || {})[0]));
  return COLLECTION_METHODS.get(p.method).write;
}

/** Reads the next batch of a cursor: { kind: 'docs', docs, more }. */
async function batch(sh, cursor) {
  const docs = [];
  while (docs.length < BATCH && (await cursor.hasNext())) docs.push(toWire(await cursor.next()));
  const more = await cursor.hasNext();
  if (more) sh.cursor = cursor; else { sh.cursor = null; await cursor.close(); }
  return { kind: 'docs', docs, more };
}

const result = (value) => ({ kind: 'value', value: toWire(value) });

async function runDb(s, sh, d, p, opts) {
  const a = p.args;
  switch (p.method) {
    case 'getName': return { kind: 'text', text: d.databaseName };
    case 'getCollectionNames': return result((await d.listCollections({}, { nameOnly: true, ...opts }).toArray()).map((c) => c.name).sort());
    case 'getCollectionInfos': return result(await d.listCollections(obj(a[0]) || {}, opts).toArray());
    case 'stats': return result(await d.command({ dbStats: 1 }, opts));
    case 'runCommand': if (!a[0] || typeof a[0] !== 'object') throw new ShellError('runCommand needs a command: db.runCommand({ … })'); return result(await d.command(obj(a[0]), opts));
    case 'adminCommand': if (!a[0] || typeof a[0] !== 'object') throw new ShellError('adminCommand needs a command'); return result(await s.conn.client.db('admin').command(obj(a[0]), opts));
    case 'createCollection': await d.createCollection(str(a[0], 'createCollection'), obj(a[1]) || {}); return result({ ok: 1 });
    case 'createView': await d.createCollection(str(a[0], 'createView'), { viewOn: str(a[1], 'createView'), pipeline: obj(a[2]) || [] }); return result({ ok: 1 });
    case 'dropDatabase': return result(await d.command({ dropDatabase: 1 }, opts));
    case 'version': return { kind: 'text', text: (await d.admin().command({ buildInfo: 1 })).version };
    case 'serverStatus': return result(await s.conn.client.db('admin').command({ serverStatus: 1 }, opts));
    case 'hello': case 'isMaster': return result(await s.conn.client.db('admin').command({ hello: 1 }, opts));
    case 'currentOp': return result(await s.conn.client.db('admin').command({ currentOp: 1, ...(obj(a[0]) || {}) }, opts));
    case 'killOp': return result(await s.conn.client.db('admin').command({ killOp: 1, op: a[0] && typeof a[0] === 'object' ? obj(a[0]) : num(a[0]) }, opts));
    case 'getCollection': case 'getSiblingDB': throw new ShellError(`Add a method after ${p.method}(…)`);
    default: throw new ShellError(`db.${p.method}() isn't supported`);
  }
}

/** Applies cursor methods (.sort() .limit() …) and returns what the last one gives. */
async function runCursor(sh, cursor, list, isFind, countAll) {
  for (const x of list) {
    const a = x.args;
    switch (x.name) {
      case 'sort': cursor = cursor.sort(obj(a[0])); break;
      case 'limit': cursor = cursor.limit(num(a[0])); break;
      case 'skip': cursor = cursor.skip(num(a[0])); break;
      case 'project': case 'projection': cursor = cursor.project(obj(a[0])); break;
      case 'hint': cursor = cursor.hint(typeof a[0] === 'string' ? a[0] : obj(a[0])); break;
      case 'maxTimeMS': cursor = cursor.maxTimeMS(num(a[0])); break;
      case 'batchSize': cursor = cursor.batchSize(num(a[0])); break;
      case 'collation': cursor = cursor.collation(obj(a[0])); break;
      case 'comment': cursor = cursor.comment(String(a[0])); break;
      case 'pretty': break;
      case 'count': case 'size': {
        if (!isFind) throw new ShellError(`.${x.name}() works after find()`);
        return { kind: 'value', value: toWire(await countAll()) };
      }
      case 'itcount': { let n = 0; for await (const _d of cursor) n++; return result(n); } // eslint-disable-line no-unused-vars
      case 'toArray': { const docs = await cursor.toArray(); return { kind: 'value', value: docs.map(toWire) }; }
      case 'explain': return result(await cursor.explain(a[0] ? String(a[0]) : 'queryPlanner'));
      default: throw new ShellError(`.${x.name}() isn't supported`);
    }
  }
  return batch(sh, cursor);
}

async function runColl(s, sh, c, p, opts) {
  const a = p.args;
  const o = (i) => ({ ...(obj(a[i]) || {}), ...opts });
  switch (p.method) {
    case 'find': return runCursor(sh, c.find(obj(a[0]) || {}, { ...READ, projection: obj(a[1]), ...(obj(a[2]) || {}), ...opts }), p.cursor, true,
      () => c.countDocuments(obj(a[0]) || {}, { comment: opts.comment }));
    case 'aggregate': {
      if (!Array.isArray(a[0])) throw new ShellError('aggregate needs a pipeline: [ { $match: … }, … ]');
      return runCursor(sh, c.aggregate(obj(a[0]), { ...READ, ...(obj(a[1]) || {}), ...opts }), p.cursor, false);
    }
    case 'findOne': { const d = await c.findOne(obj(a[0]) || {}, { ...READ, projection: obj(a[1]), ...(obj(a[2]) || {}), ...opts }); return d ? result(d) : { kind: 'value', value: null }; }
    case 'countDocuments': return result(await c.countDocuments(obj(a[0]) || {}, o(1)));
    case 'count': return result(await c.countDocuments(obj(a[0]) || {}, o(1)));
    case 'estimatedDocumentCount': return result(await c.estimatedDocumentCount(o(0)));
    case 'distinct': return result(await c.distinct(str(a[0], 'distinct'), obj(a[1]) || {}, opts));
    case 'insertOne': { const r = await c.insertOne(obj(a[0]), o(1)); return result({ acknowledged: r.acknowledged, insertedId: r.insertedId }); }
    case 'insertMany': {
      if (!Array.isArray(a[0])) throw new ShellError('insertMany needs an array of documents');
      const r = await c.insertMany(obj(a[0]), o(1));
      return result({ acknowledged: r.acknowledged, insertedIds: Object.fromEntries(Object.entries(r.insertedIds).map(([k, v]) => [String(k), v])) });
    }
    case 'updateOne': case 'updateMany': case 'replaceOne': {
      const r = await c[p.method](obj(a[0]) || {}, obj(a[1]), o(2));
      return result({ acknowledged: r.acknowledged, insertedId: r.upsertedId === undefined ? null : r.upsertedId, matchedCount: r.matchedCount, modifiedCount: r.modifiedCount, upsertedCount: r.upsertedCount });
    }
    case 'deleteOne': case 'deleteMany': { const r = await c[p.method](obj(a[0]) || {}, opts); return result({ acknowledged: r.acknowledged, deletedCount: r.deletedCount }); }
    case 'findOneAndUpdate': case 'findOneAndReplace': { const r = await c[p.method](obj(a[0]) || {}, obj(a[1]), { ...READ, ...o(2), includeResultMetadata: false }); return { kind: 'value', value: r ? toWire(r) : null }; }
    case 'findOneAndDelete': { const r = await c.findOneAndDelete(obj(a[0]) || {}, { ...READ, ...o(1), includeResultMetadata: false }); return { kind: 'value', value: r ? toWire(r) : null }; }
    case 'bulkWrite': {
      if (!Array.isArray(a[0])) throw new ShellError('bulkWrite needs an array of operations');
      const r = await c.bulkWrite(obj(a[0]), o(1));
      return result({ acknowledged: true, insertedCount: r.insertedCount, matchedCount: r.matchedCount, modifiedCount: r.modifiedCount, deletedCount: r.deletedCount, upsertedCount: r.upsertedCount });
    }
    case 'createIndex': return { kind: 'value', value: await c.createIndex(obj(a[0]), o(1)) };
    case 'createIndexes': return result(await c.createIndexes(obj(a[0]), opts));
    case 'dropIndex': return result(await c.dropIndex(typeof a[0] === 'string' ? a[0] : obj(a[0]), opts));
    case 'dropIndexes': return result(await c.dropIndexes(opts));
    case 'getIndexes': case 'indexes': return result(await c.listIndexes(opts).toArray());
    case 'drop': return result(await c.drop(opts));
    case 'renameCollection': await c.rename(str(a[0], 'renameCollection'), opts); return result({ ok: 1 });
    case 'stats': return result(await s.conn.client.db(c.dbName).command({ collStats: c.collectionName }, opts));
    default: throw new ShellError(`${p.method}() isn't supported`);
  }
}

function showDbs(list) {
  const unit = (n) => { const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; let v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(2)} ${u[i]}`; };
  const w = Math.max(...list.map((d) => d.name.length)) + 3;
  return list.map((d) => d.name.padEnd(w) + unit(Number(d.sizeOnDisk) || 0)).join('\n');
}

/** Runs one typed line: { id, text, confirmed } -> { kind: 'text' | 'value' | 'docs' | 'none', db, … }. */
async function shellRun(s, _ctx, { id, text, confirmed }) {
  const sh = sessionsOf(s).get(id);
  if (!sh) throw new Error('This Shell is closed');
  const line = String(text || '').trim().replace(/;+\s*$/, '');
  const done = (r) => ({ ...r, db: sh.db });
  if (!line) return done({ kind: 'none' });
  let m;
  if (line === 'help' || line === 'help()') return done({ kind: 'text', text: HELP });
  if (line === 'db') return done({ kind: 'text', text: sh.db });
  if ((m = /^use\s+(\S+)$/.exec(line))) { sh.db = m[1]; sh.cursor = null; return done({ kind: 'text', text: `switched to db ${sh.db}` }); }
  if (/^(show\s+(dbs|databases))$/.test(line)) {
    const r = await s.conn.client.db('admin').command({ listDatabases: 1, authorizedDatabases: true });
    return done({ kind: 'text', text: showDbs(r.databases) });
  }
  if (/^show\s+(collections|tables)$/.test(line)) {
    const list = await s.conn.client.db(sh.db).listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray();
    const names = list.map((c) => [c.name, c.type === 'view' ? '[view]' : c.options && c.options.timeseries ? '[time-series]' : '']).sort((x, y) => x[0].localeCompare(y[0]));
    const w = Math.max(0, ...names.map((x) => x[0].length)) + 3;
    return done({ kind: 'text', text: names.map(([n, t]) => (t ? n.padEnd(w) + t : n)).join('\n') });
  }
  if (/^show\s/.test(line)) return done({ kind: 'error', text: 'Lookup\'s shell shows: show dbs, show collections' });
  if (line === 'it') {
    if (!sh.cursor) return done({ kind: 'error', text: 'no cursor' });
    return done(await batch(sh, sh.cursor));
  }
  let p;
  try { p = plan(parseChain(line)); } catch (e) {
    if (e instanceof ShellError) return done({ kind: 'error', text: e.message });
    if (e instanceof LitError || e.pos !== undefined) return done({ kind: 'error', text: `SyntaxError: ${e.message}${e.pos !== undefined ? ` (at ${e.pos + 1})` : ''}`, pos: e.pos });
    throw e;
  }
  if (isWrite(p)) guard(s, line.length > 80 ? line.slice(0, 79) + '…' : line, confirmed);
  const db = s.conn.client.db(p.db || sh.db);
  const t = s.conn.track();
  sh.stop = () => { const ctl = s.conn.running.get(t.comment); if (ctl) ctl.abort(); s.conn.cancelRunning().catch(() => {}); };
  const opts = { comment: t.comment, signal: t.signal };
  const t0 = Date.now();
  try {
    if (sh.cursor) { sh.cursor.close().catch(() => {}); sh.cursor = null; }
    const r = p.target === 'db' ? await runDb(s, sh, db, p, opts) : await runColl(s, sh, db.collection(p.coll), p, opts);
    return done({ ...r, ms: Date.now() - t0 });
  } catch (e) {
    if (e.name === 'AbortError' || /aborted/i.test(e.message)) return done({ kind: 'error', text: 'Stopped' });
    if (e.name && /^Mongo/.test(e.name)) return done({ kind: 'error', text: `${e.name}${e.codeName ? `[${e.codeName}]` : ''}: ${e.message}` });
    if (e instanceof ShellError) return done({ kind: 'error', text: e.message });
    throw e;
  } finally {
    t.done();
    sh.stop = null;
  }
}

module.exports = { shellOpen, shellRun, shellStop, shellClose, parseChain, plan, isWrite, topology };
