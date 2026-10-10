// Export jobs for every engine: stream a table or query to a file on a separate connection, with
// progress and Cancel. The engine builds the table query, streams rows and writes the DDL.
const { engine: engineById } = require('../engines');
const { sessions, get } = require('./sessions');
const { trackConnection } = require('./sql-log');

const { createWriter } = require('../../export');

const jobs = new Map(); // jobId -> { cancelled, conn, engine }

function removePartial(filePath) {
  try { require('fs').unlinkSync(filePath); } catch { /* nothing to remove */ }
}

/**
 * job = { jobId, format, filePath, options, engine (for 'rows' without a session),
 *         source: 'rows'  -> columns: [{name,type}], rows
 *         source: 'table' -> owner, name, type, filters, sort, columns: [names] (optional subset)
 *         source: 'query' -> sql, columns: [indexes] (optional subset) }
 */
async function exportData(winId, job, onProgress) {
  const s = job.source === 'rows' && !(job.options && job.options.includeDdl) ? sessions.get(winId) : get(winId);
  const engine = s ? s.engine : engineById(job.engine);
  const state = { cancelled: false, conn: null, engine };
  jobs.set(job.jobId, state);
  const opts = { ...(job.options || {}), dialect: engine.dialect };
  let writer = null;
  let count = 0;
  let last = 0;
  const progress = (force) => {
    const now = Date.now();
    if (force || now - last > 200) { last = now; onProgress(count); }
  };
  try {
    if (job.source === 'rows') {
      if (opts.includeDdl && job.owner && job.name) opts.ddl = await engine.ddlFor(s.conn, job.owner, job.name, job.type || 'TABLE', { indexes: true, comments: true, triggers: false });
      writer = createWriter(job.format, job.filePath, job.columns, opts);
      for (let i = 0; i < job.rows.length; i += 1000) {
        if (state.cancelled) break;
        await writer.rows(job.rows.slice(i, i + 1000));
        count = Math.min(i + 1000, job.rows.length);
        progress();
      }
    } else {
      // A separate connection keeps the main session free while a long export runs.
      state.conn = trackConnection(await engine.open(s.cfg), s.log);
      let sql;
      let binds;
      let pick = null;
      if (job.source === 'table') {
        ({ sql, binds } = await engine.tableExportQuery(s, job));
        if (opts.includeDdl) opts.ddl = await engine.ddlFor(state.conn, job.owner, job.name, job.type || 'TABLE', { indexes: true, comments: true, triggers: false });
      } else {
        sql = job.sql;
        if (job.columns && job.columns.length) pick = job.columns;
      }
      const stream = await engine.streamQuery(state.conn, sql, binds);
      let columns = stream.columns;
      if (pick) columns = pick.map((i) => columns[i]);
      writer = createWriter(job.format, job.filePath, columns, opts);
      try {
        for (;;) {
          if (state.cancelled) break;
          let rows = await stream.next(1000);
          if (!rows.length) break;
          count += rows.length;
          if (pick) rows = rows.map((row) => pick.map((i) => row[i]));
          await writer.rows(rows);
          progress();
        }
      } finally {
        await stream.close().catch(() => {});
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
  if (st.conn) await st.engine.cancelOn(st.conn).catch(() => {});
}

module.exports = { exportData, cancelExport };
