// SQLite: result columns and value conversion. Values cross from the worker thread as plain data:
// 64-bit integers as BigInt (kept exact), blobs as Uint8Array.
const { kindOf } = require('./sqlgen');
const { ser } = require('../common/values');

function columnsFrom(cols) {
  return (cols || []).map((c) => ({ name: c.name, type: c.type || '', kind: kindOf(c.type) }));
}

const toBuffer = (v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);

/** Converts values in place: integers and reals to text (exact), blobs to { $bin, len }. */
function serializeRows(rows, full) {
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) {
      const v = r[i];
      r[i] = typeof v === 'number' ? String(v) : ser(toBuffer(v), false, full);
    }
  }
  return rows;
}

module.exports = { columnsFrom, serializeRows };
