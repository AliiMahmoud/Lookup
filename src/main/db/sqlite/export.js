// SQLite parts of an export job: the table's SELECT, streaming rows in batches from the worker, and Cancel.
const { qi, qname, buildWhere } = require('./sqlgen');
const { tableColumns } = require('./metadata');
const { columnsFrom, serializeRows } = require('./values');

async function tableExportQuery(s, job) {
  const cols = await tableColumns(s, job.owner, job.name);
  const chosen = job.columns && job.columns.length ? cols.filter((c) => job.columns.includes(c.name)) : cols;
  const w = buildWhere(cols, job.filters || []);
  let order = '';
  if (job.sort && cols.some((c) => c.name === job.sort.col)) order = ` ORDER BY ${qi(job.sort.col)} ${job.sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  return { sql: `SELECT ${chosen.map((c) => 't.' + qi(c.name)).join(', ')} FROM ${qname(job.owner, job.name)} t${w.where}${order}`, binds: w.params };
}

/** Rows in batches: { columns, next(n) -> rows (whole binaries), close() }. Runs on the export's own connection. */
async function streamQuery(conn, sql, params = []) {
  const cursor = 'x' + Date.now();
  const r = await conn.call('streamOpen', { cursor, sql, params });
  const columns = columnsFrom(r.columns);
  return {
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    next: async (n) => serializeRows((await conn.call('streamNext', { cursor, n })).rows, true),
    close: () => conn.call('streamClose', { cursor }),
  };
}

/** Cancel on an export's own connection: end its worker. */
const cancelOn = (conn) => conn.close();

module.exports = { tableExportQuery, streamQuery, cancelOn };
