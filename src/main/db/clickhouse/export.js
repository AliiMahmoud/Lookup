// ClickHouse parts of an export job: the table's SELECT, streaming rows in batches, and Cancel.
const { qi, qname, buildWhere } = require('./sqlgen');
const { tableColumns } = require('./metadata');
const { columnsFrom, serializeRows } = require('./values');
const { newQueryId } = require('./connect');

async function tableExportQuery(s, job) {
  const cols = await tableColumns(s, job.owner, job.name);
  const chosen = job.columns && job.columns.length ? cols.filter((c) => job.columns.includes(c.name)) : cols;
  const w = buildWhere(cols, job.filters || []);
  let order = '';
  if (job.sort && cols.some((c) => c.name === job.sort.col)) order = ` ORDER BY ${qi(job.sort.col)} ${job.sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  return { sql: `SELECT ${chosen.map((c) => qi(c.name)).join(', ')} FROM ${qname(job.owner, job.name)}${w.where}${order}`, binds: w.params };
}

/** Rows in batches: { columns, next(n) -> rows, close() }, read from the HTTP stream as they arrive. */
async function streamQuery(conn, sql, params = {}) {
  const queryId = newQueryId();
  const rs = await conn.select(sql, Array.isArray(params) ? {} : params, { queryId });
  const it = rs.stream()[Symbol.asyncIterator]();
  let buf = [];
  let done = false;
  const fill = async (n) => {
    while (!done && buf.length < n) {
      const x = await it.next();
      if (x.done) { done = true; break; }
      for (const row of x.value) buf.push(row.json());
    }
  };
  await fill(2);
  const [names, types] = buf.splice(0, 2);
  if (!names) throw new Error('This statement does not return rows');
  const columns = columnsFrom(names, types || []);
  return {
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    next: async (n) => { await fill(n); return serializeRows(buf.splice(0, n)); },
    close: async () => { conn.finished(queryId); if (!done) rs.close(); },
  };
}

/** Cancel on an export's own connection. */
const cancelOn = (conn) => conn.cancelRunning();

module.exports = { tableExportQuery, streamQuery, cancelOn };
