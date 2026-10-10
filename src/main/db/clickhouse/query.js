// ClickHouse: running one statement of the user's SQL. Row results are streamed and the request is
// closed once the row limit is reached, so the server stops sending. Other statements run as commands.
const { newQueryId, RETURNS_ROWS } = require('./connect');
const { columnsFrom, serializeRows } = require('./values');

/** g() races each wait against Stop. maxRows 0 = no limit. */
async function runStatement(s, sql, { maxRows, g }) {
  const conn = s.conn;
  const queryId = newQueryId();
  if (!RETURNS_ROWS.test(sql)) {
    const r = await g(conn.command(sql, null, { queryId }));
    const written = r.summary ? Number(r.summary.written_rows) : 0;
    return { kind: 'exec', rowsAffected: /^\s*insert\b/i.test(sql) ? written : undefined };
  }
  const rs = await g(conn.select(sql, null, { queryId }));
  let names = null;
  let types = null;
  const rows = [];
  let truncated = false;
  try {
    const stream = rs.stream();
    outer: for await (const batch of stream) {
      for (const row of batch) {
        const v = row.json();
        if (!names) { names = v; continue; }
        if (!types) { types = v; continue; }
        if (maxRows && rows.length >= maxRows) { truncated = true; break outer; }
        rows.push(v);
      }
    }
    if (truncated) rs.close(); // ends the request: the server stops the query
  } finally {
    conn.finished(queryId);
  }
  const columns = columnsFrom(names || [], types || []);
  return { kind: 'rows', columns, rows: serializeRows(rows), truncated };
}

module.exports = { runStatement };
