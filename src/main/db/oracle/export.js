// Oracle parts of an export job: the table's SELECT, streaming rows from a result set, and Cancel.
const { qi, qname, buildWhere } = require('./sqlgen');
const { tableColumns } = require('./metadata');
const { ser } = require('./values');

async function tableExportQuery(s, job) {
  const cols = await tableColumns(s, job.owner, job.name);
  const chosen = job.columns && job.columns.length ? cols.filter((c) => job.columns.includes(c.name)) : cols;
  const w = buildWhere(cols, job.filters || []);
  let order = '';
  if (job.sort && cols.some((c) => c.name === job.sort.col)) order = ` ORDER BY ${qi(job.sort.col)} ${job.sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  return { sql: `SELECT ${chosen.map((c) => 't.' + qi(c.name)).join(', ')} FROM ${qname(job.owner, job.name)} t${w.where}${order}`, binds: w.binds };
}

/** Rows in batches: { columns, next(n) -> rows (whole binaries), close() }. */
async function streamQuery(conn, sql, binds = {}) {
  const r = await conn.execute(sql, binds, { resultSet: true, fetchArraySize: 1000 });
  if (!r.resultSet) throw new Error('This statement does not return rows');
  return {
    columns: r.metaData.map((m) => ({ name: m.name, type: m.dbTypeName })),
    next: async (n) => (await r.resultSet.getRows(n)).map((row) => row.map((v, i) => ser(v, r.metaData[i], true))),
    close: () => r.resultSet.close(),
  };
}

/** Cancel on an export's own connection. */
const cancelOn = (conn) => conn.breakExecution();

module.exports = { tableExportQuery, streamQuery, cancelOn };
