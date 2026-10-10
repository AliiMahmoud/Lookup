// Aggregations: a preview of each stage's output (a few documents, like Compass) and running the
// whole pipeline. A pipeline ending in $out or $merge writes data, so it is never previewed and
// running it follows the read-only and Production rules.
const { Op } = require('./connect');
const { toWire, fromWire, text, READ } = require('./values');
const { guard } = require('./guard');

const WRITES = /^\$(out|merge)$/;
const PREVIEW_MS = 10000;

const opOf = (stage) => Object.keys(stage || {})[0] || '';
const pipeText = (coll, stages) => `db.${coll}.aggregate([${stages.map(text).join(', ')}])`;

/** Output after each enabled stage: { db, coll, stages: [{ stage, enabled }], size } -> [{ docs | error | skipped }]. */
async function preview(s, _ctx, { db, coll, stages, size = 10 }) {
  const n = Math.max(1, Math.min(50, Number(size) || 10));
  const out = [];
  const prefix = [];
  for (const st of stages || []) {
    if (!st || !st.enabled) { out.push({ skipped: true }); continue; }
    const op = opOf(st.stage);
    if (WRITES.test(op)) { out.push({ skipped: true, note: `${op} writes to a collection, so it runs only with Run` }); continue; }
    prefix.push(st.stage);
    const t = s.conn.track();
    const t0 = Date.now();
    try {
      const docs = await s.conn.execute(new Op(pipeText(coll, [...prefix, { $limit: n }]), (c) => c.db(db).collection(coll)
        .aggregate([...prefix, { $limit: n }].map(fromWire), { ...READ, maxTimeMS: PREVIEW_MS, allowDiskUse: true, comment: t.comment, signal: t.signal }).toArray()));
      out.push({ docs: docs.map(toWire), ms: Date.now() - t0 });
    } catch (e) {
      out.push({ error: e.message.split('\n')[0] });
      // Later stages can't be previewed after a failing one.
      for (let k = out.length; k < stages.length; k++) out.push({ skipped: true, note: 'Fix the stage above first' });
      t.done();
      return out;
    } finally { t.done(); }
  }
  return out;
}

/** Runs the enabled stages: up to `limit` documents come back (a $out / $merge pipeline returns none). */
async function run(s, _ctx, { db, coll, stages, limit = 500, confirmed }) {
  const pipeline = (stages || []).filter((x) => x && x.enabled).map((x) => x.stage);
  const writes = pipeline.some((st) => WRITES.test(opOf(st)));
  if (writes) guard(s, `This pipeline (${pipeline.map(opOf).filter((o) => WRITES.test(o)).join(', ')})`, confirmed);
  const max = Math.max(1, Math.min(5000, Number(limit) || 500));
  const t = s.conn.track();
  const t0 = Date.now();
  try {
    const docs = await s.conn.execute(new Op(pipeText(coll, pipeline), async (c) => {
      const cur = c.db(db).collection(coll).aggregate(pipeline.map(fromWire), { ...READ, allowDiskUse: true, comment: t.comment, signal: t.signal });
      const rows = [];
      try { for await (const d of cur) { rows.push(d); if (rows.length > max) break; } } finally { await cur.close(); }
      return rows;
    }));
    return { docs: docs.slice(0, max).map(toWire), more: docs.length > max, ms: Date.now() - t0, wrote: writes };
  } finally { t.done(); }
}

/** The plan for the enabled stages. */
async function explain(s, _ctx, { db, coll, stages }) {
  const pipeline = (stages || []).filter((x) => x && x.enabled && !WRITES.test(opOf(x.stage))).map((x) => x.stage);
  const r = await s.conn.execute(new Op(`${pipeText(coll, pipeline)}.explain('executionStats')`,
    (c) => c.db(db).collection(coll).aggregate(pipeline.map(fromWire)).explain('executionStats')));
  return require('./docs').summarizeExplain(r);
}

module.exports = { preview, run, explain };
