// SQLite: runs one database file on a worker thread (not a process), so a slow query never blocks
// the app, and Stop can end it at once. Uses node:sqlite, built into Electron (no extra dependency).
// Messages in: { id, op, ... }; out: { id, ok, result } or { id, ok: false, error: { message, code } }.
const { parentPort } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');

let db = null;
const cursors = new Map(); // export streams: id -> { it, columns }

function columnsOf(stmt) {
  return stmt.columns().map((c) => ({ name: c.name, type: c.type || null, table: c.table || null }));
}

function prepare(sql) {
  const stmt = db.prepare(sql);
  stmt.setReturnArrays(true);
  stmt.setReadBigInts(true); // 64-bit integers stay exact (sent as BigInt)
  return stmt;
}

const ops = {
  open({ file, readOnly, create }) {
    if (!create && file !== ':memory:' && !require('fs').existsSync(file)) {
      throw Object.assign(new Error(`File not found: ${file}`), { code: 'LOOKUP_NO_FILE' });
    }
    db = new DatabaseSync(file, { readOnly: !!readOnly, timeout: 5000, enableForeignKeyConstraints: true });
    return { version: db.prepare('select sqlite_version()').get()['sqlite_version()'] };
  },
  /** App-issued SQL: all rows, or the change count. */
  query({ sql, params }) {
    const stmt = prepare(sql);
    const columns = columnsOf(stmt);
    if (columns.length) return { columns, rows: stmt.all(...(params || [])) };
    const r = stmt.run(...(params || []));
    return { changes: Number(r.changes) };
  },
  /** The user's statement: rows up to maxRows (+1 to know there are more), or the change count. */
  run({ sql, maxRows }) {
    const stmt = prepare(sql);
    const columns = columnsOf(stmt);
    if (!columns.length) {
      const r = stmt.run();
      return { columns: null, changes: Number(r.changes) };
    }
    const rows = [];
    for (const row of stmt.iterate()) {
      rows.push(row);
      if (maxRows && rows.length > maxRows) break;
    }
    const truncated = !!maxRows && rows.length > maxRows;
    if (truncated) rows.length = maxRows;
    return { columns, rows, truncated };
  },
  streamOpen({ cursor, sql, params }) {
    const stmt = prepare(sql);
    const columns = columnsOf(stmt);
    if (!columns.length) throw new Error('This statement does not return rows');
    cursors.set(cursor, { it: stmt.iterate(...(params || [])) });
    return { columns };
  },
  streamNext({ cursor, n }) {
    const c = cursors.get(cursor);
    const rows = [];
    if (!c) return { rows };
    while (rows.length < n) {
      const x = c.it.next();
      if (x.done) { cursors.delete(cursor); break; }
      rows.push(x.value);
    }
    return { rows };
  },
  streamClose({ cursor }) {
    const c = cursors.get(cursor);
    if (c && c.it.return) c.it.return();
    cursors.delete(cursor);
    return {};
  },
  close() {
    if (db && db.isOpen !== false) db.close();
    db = null;
    return {};
  },
};

parentPort.on('message', (msg) => {
  try {
    const result = ops[msg.op](msg);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: { message: e.message, code: e.code, errcode: e.errcode } });
  }
});

