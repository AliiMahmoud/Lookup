// PostgreSQL parts of an export job: the table's SELECT, streaming rows through a cursor, and Cancel.
const { qi, qname, buildWhere } = require('./sqlgen');
const { tableColumns } = require('./metadata');
const { columnsFromFields, serializeRows } = require('./values');
const { driver } = require('./driver');

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
  const { Cursor } = driver();
  const cur = conn.client.query(new Cursor(sql, params, { rowMode: 'array' }));
  let first = await cur.read(1000);
  const fields = (cur._result && cur._result.fields) || [];
  if (!fields.length) { await cur.close().catch(() => {}); throw new Error('This statement does not return rows'); }
  // The cursor holds the connection until it is closed, so rare types aren't looked up here (shown as text).
  const columns = await columnsFromFields({}, fields, () => Promise.reject(new Error('busy')));
  return {
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    next: async (n) => {
      const rows = first || (await cur.read(n));
      first = null;
      return serializeRows(rows, columns, true);
    },
    close: () => cur.close(),
  };
}

/** Cancel on an export's own connection. */
const cancelOn = (conn) => conn.cancelRunning();

module.exports = { tableExportQuery, streamQuery, cancelOn };
