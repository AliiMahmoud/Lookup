// Converting fetched values (dates, LOBs, binaries) and column metadata for the UI.
const { kindOf } = require('../sqlgen');

const pad = (n, w = 2) => String(n).padStart(w, '0');

function fmtDate(d, ms) {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return ms ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

function ser(v, meta) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return fmtDate(v, meta && /TIMESTAMP/.test(meta.dbTypeName || ''));
  if (Buffer.isBuffer(v)) return { $bin: v.subarray(0, 256).toString('hex').toUpperCase(), len: v.length };
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return v;
}

function columnsFromMeta(metaData) {
  return (metaData || []).map((m) => ({
    name: m.name,
    type: m.dbTypeName,
    nullable: m.nullable,
    precision: m.precision,
    scale: m.scale,
    kind: kindOf(m.dbTypeName),
  }));
}

// Converts values in place: large results are not copied a second time.
function serializeRows(rows, metaData) {
  for (const r of rows) for (let i = 0; i < r.length; i++) r[i] = ser(r[i], metaData[i]);
  return rows;
}

module.exports = { ser, columnsFromMeta, serializeRows };
