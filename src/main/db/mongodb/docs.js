// The Documents view: find with filter / projection / sort / skip / limit, counting, explain, and
// changing documents. An edited document is saved as $set / $unset of the changed top-level fields,
// with the old values of those fields in the filter (as Compass does), so a change made by someone
// else in the meantime is not overwritten.
const { Op } = require('./connect');
const { toWire, fromWire, text, READ } = require('./values');
const { guard } = require('./guard');
const { equal } = require('../../../shared/mongo-lit');

const MAX_LIMIT = 1000;
const isEmpty = (o) => !o || (typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length);

function findText(coll, { filter, project, sort, skip, limit }) {
  let t = `db.${coll}.find(${text(filter)}${isEmpty(project) ? '' : ', ' + text(project)})`;
  if (!isEmpty(sort)) t += `.sort(${text(sort)})`;
  if (skip) t += `.skip(${skip})`;
  if (limit) t += `.limit(${limit})`;
  return t;
}

async function find(s, _ctx, p) {
  const { db, coll } = p;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(p.limit) || 20));
  const skip = Math.max(0, Number(p.skip) || 0);
  const t = s.conn.track();
  const t0 = Date.now();
  try {
    const docs = await s.conn.execute(new Op(findText(coll, { ...p, skip, limit }), (c) => c.db(db).collection(coll).find(fromWire(p.filter || {}), {
      ...READ, projection: isEmpty(p.project) ? undefined : fromWire(p.project), sort: isEmpty(p.sort) ? undefined : fromWire(p.sort),
      skip, limit, comment: t.comment, signal: t.signal,
    }).toArray()));
    return { docs: docs.map(toWire), skip, limit, ms: Date.now() - t0 };
  } finally { t.done(); }
}

/** Matching documents: exact with a filter (stops after 10 s), else the fast estimate. */
async function count(s, _ctx, { db, coll, filter }) {
  const c = s.conn.client.db(db).collection(coll);
  if (isEmpty(filter)) {
    return { count: await s.conn.execute(new Op(`db.${coll}.estimatedDocumentCount()`, () => c.estimatedDocumentCount({ maxTimeMS: 10000 }))), estimated: true };
  }
  const t = s.conn.track();
  try {
    const n = await s.conn.execute(new Op(`db.${coll}.countDocuments(${text(filter)})`, () => c.countDocuments(fromWire(filter), { maxTimeMS: 10000, comment: t.comment })));
    return { count: n, estimated: false };
  } finally { t.done(); }
}

/** The query plan summarized: the stages from the index scan up, documents and keys looked at, time. */
async function explain(s, _ctx, p) {
  const { db, coll } = p;
  const limit = Number(p.limit) || 0;
  const r = await s.conn.execute(new Op(`${findText(coll, p)}.explain('executionStats')`, (c) => c.db(db).collection(coll).find(fromWire(p.filter || {}), {
    projection: isEmpty(p.project) ? undefined : fromWire(p.project), sort: isEmpty(p.sort) ? undefined : fromWire(p.sort), limit: limit || undefined, skip: Number(p.skip) || undefined,
  }).explain('executionStats')));
  return summarizeExplain(r);
}

function summarizeExplain(r) {
  const qp = r.queryPlanner || (r.stages && r.stages[0] && r.stages[0].$cursor && r.stages[0].$cursor.queryPlanner) || {};
  const ex = r.executionStats || {};
  // Stages from the bottom (index / collection scan) to the top.
  const chain = [];
  const walk = (node) => {
    if (!node) return;
    if (node.inputStage) walk(node.inputStage);
    if (Array.isArray(node.inputStages)) node.inputStages.forEach(walk);
    if (node.queryPlan) walk(node.queryPlan);
    chain.push({
      stage: node.stage || node.nodeType || '?',
      index: node.indexName || null,
      keys: node.keyPattern ? toWire(node.keyPattern) : null,
      nReturned: node.nReturned !== undefined ? Number(node.nReturned) : null,
      keysExamined: node.keysExamined !== undefined ? Number(node.keysExamined) : null,
      docsExamined: node.docsExamined !== undefined ? Number(node.docsExamined) : null,
      sortPattern: node.sortPattern ? toWire(node.sortPattern) : null,
      memLimit: node.memLimit !== undefined ? Number(node.memLimit) : null,
      usedDisk: !!node.usedDisk,
    });
  };
  walk(ex.executionStages || qp.winningPlan);
  // FerretDB explains with its SQL backend's plan lines ("SCAN …", "SEARCH … USING INDEX …").
  if (!chain.length && Array.isArray(qp.Plan)) {
    for (const line of qp.Plan) {
      const ix = /USING (?:COVERING )?INDEX (\S+)/.exec(line);
      chain.push({ stage: ix ? 'IXSCAN' : /\bSCAN\b/.test(line) ? 'COLLSCAN' : String(line).replace(/^id=\d+ parent=\d+ notused=\d+ detail=/, ''), index: ix ? ix[1] : null, keys: null, nReturned: null, keysExamined: null, docsExamined: null, sortPattern: null, memLimit: null, usedDisk: false });
    }
  }
  const stages = chain.map((x) => x.stage);
  return {
    stages: chain,
    nReturned: ex.nReturned !== undefined ? Number(ex.nReturned) : null,
    keysExamined: ex.totalKeysExamined !== undefined ? Number(ex.totalKeysExamined) : null,
    docsExamined: ex.totalDocsExamined !== undefined ? Number(ex.totalDocsExamined) : null,
    ms: ex.executionTimeMillis !== undefined ? Number(ex.executionTimeMillis) : null,
    usesIndex: stages.some((x) => /IXSCAN|IDHACK|EXPRESS_IXSCAN|COUNT_SCAN|DISTINCT_SCAN/.test(x)),
    collScan: stages.includes('COLLSCAN'),
    inMemorySort: stages.includes('SORT'),
    raw: toWire(r),
  };
}

/** Saves an edited document: { db, coll, original, doc } (both Extended JSON). */
async function update(s, _ctx, { db, coll, original, doc, confirmed }) {
  if (!original || !doc || original._id === undefined) throw new Error('This document has no _id, so it can\'t be changed here');
  if (!equal(original._id, doc._id)) throw new Error('_id can\'t be changed. Insert a copy with a new _id and delete this one instead.');
  const set = {};
  const unset = {};
  for (const k of Object.keys(doc)) if (k !== '_id' && !equal(original[k], doc[k])) set[k] = doc[k];
  for (const k of Object.keys(original)) if (!(k in doc)) unset[k] = '';
  if (!Object.keys(set).length && !Object.keys(unset).length) return { modified: 0 };
  // Only if the changed fields still hold what was loaded.
  const filter = { _id: original._id };
  for (const k of [...Object.keys(set), ...Object.keys(unset)]) filter[k] = k in original ? original[k] : { $exists: false };
  const change = {};
  if (Object.keys(set).length) change.$set = set;
  if (Object.keys(unset).length) change.$unset = unset;
  guard(s, 'Updating this document', confirmed);
  const r = await s.conn.execute(new Op(`db.${coll}.updateOne(${text(filter)}, ${text(change)})`,
    (c) => c.db(db).collection(coll).updateOne(fromWire(filter), fromWire(change))));
  if (!r.matchedCount) {
    throw Object.assign(new Error('The document was changed or deleted since it was loaded, so your change was not saved. Reload it and try again.'), { code: 'DOC_CHANGED' });
  }
  return { modified: r.modifiedCount, changed: Object.keys(set), removed: Object.keys(unset) };
}

/** New documents (Insert document, Clone, import): { db, coll, docs }. */
async function insert(s, _ctx, { db, coll, docs, confirmed }) {
  const list = Array.isArray(docs) ? docs : [docs];
  if (!list.length) return { inserted: 0 };
  if (list.some((d) => !d || typeof d !== 'object' || Array.isArray(d))) throw new Error('Each document must be an object: { … }');
  guard(s, list.length === 1 ? 'Inserting a document' : `Inserting ${list.length} documents`, confirmed);
  const r = await s.conn.execute(new Op(list.length === 1 ? `db.${coll}.insertOne(${text(list[0])})` : `db.${coll}.insertMany([ … ${list.length} documents ])`,
    (c) => c.db(db).collection(coll).insertMany(list.map(fromWire), { ordered: true })));
  return { inserted: r.insertedCount, ids: Object.values(r.insertedIds).map(toWire) };
}

/** Deletes documents by _id: { db, coll, ids }. */
async function remove(s, _ctx, { db, coll, ids, confirmed }) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return { deleted: 0 };
  guard(s, list.length === 1 ? 'Deleting this document' : `Deleting ${list.length} documents`, confirmed);
  const filter = list.length === 1 ? { _id: list[0] } : { _id: { $in: list } };
  const r = await s.conn.execute(new Op(`db.${coll}.${list.length === 1 ? 'deleteOne' : 'deleteMany'}(${text(filter)})`,
    (c) => c.db(db).collection(coll).deleteMany(fromWire(filter))));
  return { deleted: r.deletedCount };
}

/** Writes every document the query matches to a file: a JSON array (Extended JSON, relaxed) or CSV. */
async function exportDocs(s, _ctx, p) {
  const fs = require('fs');
  const { mongo } = require('./connect');
  const { cellText } = require('../../../shared/mongo-lit');
  const EJSON = mongo().BSON.EJSON;
  const { db, coll, format, file } = p;
  const t = s.conn.track();
  const out = fs.createWriteStream(file, { encoding: 'utf8' });
  const write = (chunk) => new Promise((resolve, reject) => { if (out.write(chunk)) resolve(); else { out.once('drain', resolve); out.once('error', reject); } });
  let n = 0;
  try {
    const cursor = s.conn.client.db(db).collection(coll).find(fromWire(p.filter || {}), {
      ...READ, projection: isEmpty(p.project) ? undefined : fromWire(p.project), sort: isEmpty(p.sort) ? undefined : fromWire(p.sort), comment: t.comment, signal: t.signal, batchSize: 500,
    });
    if (format === 'csv') {
      // Columns: the top-level fields of the first 1,000 documents; objects and arrays as JSON text.
      const head = [];
      const cols = [];
      for await (const d of cursor) { head.push(d); for (const k of Object.keys(d)) if (!cols.includes(k)) cols.push(k); if (head.length >= 1000) break; }
      const q = (v) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
      const row = (d) => cols.map((k) => {
        if (!(k in d)) return '';
        const w = toWire(d[k]);
        const c = cellText(w);
        return q(/^[{[]/.test(c) ? EJSON.stringify(d[k], { relaxed: true }) : String(c));
      }).join(',') + '\r\n';
      await write('\ufeff' + cols.map(q).join(',') + '\r\n');
      for (const d of head) { await write(row(d)); n++; }
      if (head.length >= 1000) for await (const d of cursor) { await write(row(d)); n++; }
    } else {
      await write('[');
      for await (const d of cursor) { await write((n ? ',\n' : '\n') + EJSON.stringify(d, { relaxed: true })); n++; }
      await write('\n]\n');
    }
  } finally {
    t.done();
    await new Promise((resolve) => out.end(resolve));
  }
  return { count: n };
}

module.exports = { find, count, explain, update, insert, remove, exportDocs, summarizeExplain, findText, MAX_LIMIT };
