// Schema analysis of a sample of documents (like Compass's Schema tab, written here instead of using
// a library): for each field, how often it is present, its types, and a summary per type — top values
// for text, a histogram for numbers and dates, lengths and element types for arrays.
const { Op } = require('./connect');
const { toWire, fromWire, text, READ } = require('./values');
const { typeOf, dateMs } = require('../../../shared/mongo-lit');

const MAX_DEPTH = 4;
const MAX_FIELDS = 300;
const TOP = 10;
const DISTINCT_CAP = 2000;

function num(v) {
  if (typeof v === 'number') return v;
  const s = v.$numberInt ?? v.$numberDouble ?? v.$numberLong ?? v.$numberDecimal;
  return Number(s);
}

function histogram(values, bins = 10) {
  if (!values.length) return null;
  let min = Infinity; let max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const counts = new Array(bins).fill(0);
  const span = max - min;
  for (const v of values) counts[span ? Math.min(bins - 1, Math.floor(((v - min) / span) * bins)) : 0]++;
  return { min, max, counts };
}

function analyze(docs) {
  const fields = new Map(); // path -> stats
  const field = (path) => {
    if (!fields.has(path)) {
      if (fields.size >= MAX_FIELDS) return null;
      fields.set(path, { path, present: 0, types: {}, strings: new Map(), numbers: [], dates: [], lengths: [], elementTypes: {}, trues: 0, falses: 0, oidTimes: [] });
    }
    return fields.get(path);
  };
  const visit = (v, path, depth, inArray) => {
    const f = field(path);
    if (!f) return;
    if (!inArray) f.present++;
    const t = typeOf(v);
    f.types[t] = (f.types[t] || 0) + 1;
    if (t === 'String') { if (f.strings.has(v) || f.strings.size < DISTINCT_CAP) f.strings.set(v, (f.strings.get(v) || 0) + 1); } else if (/^(Int32|Int64|Double|Decimal128)$/.test(t)) { const n = num(v); if (Number.isFinite(n)) f.numbers.push(n); } else if (t === 'Date') f.dates.push(dateMs(v));
    else if (t === 'Boolean') { if (v) f.trues++; else f.falses++; } else if (t === 'ObjectId') f.oidTimes.push(parseInt(v.$oid.slice(0, 8), 16) * 1000);
    else if (t === 'Array') {
      f.lengths.push(v.length);
      for (const x of v) {
        const et = typeOf(x);
        f.elementTypes[et] = (f.elementTypes[et] || 0) + 1;
        if (et === 'Object' && depth < MAX_DEPTH) for (const [k, y] of Object.entries(x)) visit(y, `${path}[].${k}`, depth + 1, true);
      }
    } else if (t === 'Object' && depth < MAX_DEPTH) for (const [k, y] of Object.entries(v)) visit(y, `${path}.${k}`, depth + 1, false);
  };
  for (const d of docs) for (const [k, v] of Object.entries(d)) visit(v, k, 1, false);
  const total = docs.length;
  return [...fields.values()].map((f) => {
    const out = { path: f.path, present: f.present, share: total ? f.present / total : 0, types: Object.entries(f.types).sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, n })) };
    if (f.strings.size) {
      out.strings = { distinct: f.strings.size, capped: f.strings.size >= DISTINCT_CAP, top: [...f.strings].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([value, n]) => ({ value: value.length > 80 ? value.slice(0, 79) + '…' : value, n })) };
    }
    if (f.numbers.length) {
      const sorted = [...f.numbers].sort((a, b) => a - b);
      out.numbers = { ...histogram(f.numbers), median: sorted[Math.floor(sorted.length / 2)] };
    }
    if (f.dates.length) out.dates = histogram(f.dates.filter(Number.isFinite), 12);
    if (f.oidTimes.length) { const h = histogram(f.oidTimes, 12); out.objectIds = { min: h.min, max: h.max }; }
    if (f.trues || f.falses) out.booleans = { true: f.trues, false: f.falses };
    if (f.lengths.length) {
      const l = f.lengths;
      out.arrays = { min: Math.min(...l), max: Math.max(...l), avg: l.reduce((a, b) => a + b, 0) / l.length, elementTypes: Object.entries(f.elementTypes).sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, n })) };
    }
    return out;
  }).sort((a, b) => (a.path === '_id' ? -1 : b.path === '_id' ? 1 : 0)); // otherwise in document order, nested fields after their parent
}

/** { db, coll, size, filter } -> { sampled, fields }. Random sample ($sample) when the server has it. */
async function schema(s, _ctx, { db, coll, size = 1000, filter }) {
  const n = Math.max(10, Math.min(10000, Number(size) || 1000));
  const f = filter && Object.keys(filter).length ? fromWire(filter) : null;
  const t = s.conn.track();
  let docs;
  try {
    const pipeline = [...(f ? [{ $match: f }] : []), { $sample: { size: n } }];
    try {
      docs = await s.conn.execute(new Op(`db.${coll}.aggregate([${f ? `{ $match: ${text(filter)} }, ` : ''}{ $sample: { size: ${n} } }])`, (c) => c.db(db).collection(coll)
        .aggregate(pipeline, { ...READ, allowDiskUse: true, maxTimeMS: 30000, comment: t.comment, signal: t.signal }).toArray()));
    } catch (e) {
      if (!/sample|not.*(supported|implemented)/i.test(e.message)) throw e;
      docs = await s.conn.execute(new Op(`db.${coll}.find(${text(filter)}).limit(${n})`, (c) => c.db(db).collection(coll)
        .find(f || {}, { ...READ, limit: n, maxTimeMS: 30000, comment: t.comment, signal: t.signal }).toArray()));
    }
  } finally { t.done(); }
  return { sampled: docs.length, fields: analyze(docs.map(toWire)) };
}

module.exports = { schema, analyze };
