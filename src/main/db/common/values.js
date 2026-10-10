// Turning fetched values into what the UI and exports show: dates as local 'YYYY-MM-DD HH:MM:SS[.fff]'
// text, binaries as { $bin: HEX, len }, other objects as JSON. Engine-neutral.

const pad = (n, w = 2) => String(n).padStart(w, '0');

function fmtDate(d, ms) {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return ms ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

/** withMs: show milliseconds (timestamp columns). full: keep the whole binary (exports), else the first 256 bytes. */
function ser(v, withMs, full) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : fmtDate(v, withMs);
  if (Buffer.isBuffer(v)) return { $bin: (full ? v : v.subarray(0, 256)).toString('hex').toUpperCase(), len: v.length };
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return v;
}

module.exports = { fmtDate, ser };
