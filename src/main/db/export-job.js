// Export jobs: stream a table or query to a file on a separate connection, with progress and Cancel.
const { qi, qname, buildWhere } = require('../sqlgen');
const { ora } = require('./driver');
const { sessions, get } = require('./sessions');
const { trackConnection } = require('./sql-log');
const { connectOptions } = require('./settings');
const { ser } = require('./values');
const { tableColumns } = require('./metadata');
const { ddlOn } = require('./ddl');

const { createWriter } = require('../export');

const jobs = new Map();

 // jobId -> { cancelled, conn }

function serFull(v, meta) {
  if (Buffer.isBuffer(v)) return { $bin: v.toString('hex').toUpperCase(), len: v.length };
  return ser(v, meta);
}

function removePartial(filePath) {
  try { require('fs').unlinkSync(filePath); } catch { /* nothing to remove */ }
}

/**
 * job = { jobId, format, filePath, options,
 *         source: 'rows'  -> columns: [{name,type}], rows
 *         source: 'table' -> owner, name, type, filters, sort, columns: [names] (optional subset)
 *         source: 'query' -> sql, columns: [indexes] (optional subset) }
 */
async function exportData(winId, job, onProgress) {
  const s = job.source === 'rows' && !(job.options && job.options.includeDdl) ? sessions.get(winId) : get(winId);
  const state = { cancelled: false, conn: null };
  jobs.set(job.jobId, state);
  const opts = { ...(job.options || {}) };
  let writer = null;
  let count = 0;
  let last = 0;
  const progress = (force) => {
    const now = Date.now();
    if (force || now - last > 200) { last = now; onProgress(count); }
  };
  try {
    if (job.source === 'rows') {
      if (opts.includeDdl && job.owner && job.name) opts.ddl = await ddlOn(s.conn, job.owner, job.name, job.type || 'TABLE', { indexes: true, comments: true, triggers: false });
      writer = createWriter(job.format, job.filePath, job.columns, opts);
      for (let i = 0; i < job.rows.length; i += 1000) {
        if (state.cancelled) break;
        await writer.rows(job.rows.slice(i, i + 1000));
        count = Math.min(i + 1000, job.rows.length);
        progress();
      }
    } else {
      // A separate connection keeps the main session free while a long export runs.
      state.conn = trackConnection(await ora().getConnection(connectOptions(s.cfg)), s.log);
      let sql;
      let binds = {};
      let pick = null;
      if (job.source === 'table') {
        const cols = await tableColumns(s, job.owner, job.name);
        const chosen = job.columns && job.columns.length ? cols.filter((c) => job.columns.includes(c.name)) : cols;
        const w = buildWhere(cols, job.filters || []);
        binds = w.binds;
        let order = '';
        if (job.sort && cols.some((c) => c.name === job.sort.col)) order = ` ORDER BY ${qi(job.sort.col)} ${job.sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
        sql = `SELECT ${chosen.map((c) => 't.' + qi(c.name)).join(', ')} FROM ${qname(job.owner, job.name)} t${w.where}${order}`;
        if (opts.includeDdl) opts.ddl = await ddlOn(state.conn, job.owner, job.name, job.type || 'TABLE', { indexes: true, comments: true, triggers: false });
      } else {
        sql = job.sql;
        if (job.columns && job.columns.length) pick = job.columns;
      }
      const r = await state.conn.execute(sql, binds, { resultSet: true, fetchArraySize: 1000 });
      if (!r.resultSet) throw new Error('This statement does not return rows');
      let columns = r.metaData.map((m) => ({ name: m.name, type: m.dbTypeName }));
      if (pick) columns = pick.map((i) => columns[i]);
      writer = createWriter(job.format, job.filePath, columns, opts);
      try {
        for (;;) {
          if (state.cancelled) break;
          const rows = await r.resultSet.getRows(1000);
          if (!rows.length) break;
          let out = rows.map((row) => row.map((v, i) => serFull(v, r.metaData[i])));
          if (pick) out = out.map((row) => pick.map((i) => row[i]));
          await writer.rows(out);
          count += rows.length;
          progress();
        }
      } finally {
        await r.resultSet.close().catch(() => {});
      }
    }
    await writer.close();
    writer = null;
    if (state.cancelled) { removePartial(job.filePath); return { cancelled: true, rows: count }; }
    progress(true);
    return { rows: count, filePath: job.filePath, skipped: 0 };
  } catch (e) {
    if (writer) await writer.close().catch(() => {});
    removePartial(job.filePath);
    if (state.cancelled) return { cancelled: true, rows: count };
    throw e;
  } finally {
    jobs.delete(job.jobId);
    if (state.conn) await state.conn.close().catch(() => {});
  }
}

async function cancelExport(jobId) {
  const st = jobs.get(jobId);
  if (!st) return;
  st.cancelled = true;
  if (st.conn) await st.conn.breakExecution().catch(() => {});
}

module.exports = { exportData, cancelExport };
