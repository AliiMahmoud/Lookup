// Redis values between the main process and the window: text stays a string, bytes that aren't text
// travel as { b64 }. Replies for the Shell and Workbench keep their type (see shared/redis-cli.js) and
// are cut short when very long, so a KEYS * on a big database can't exhaust memory.
const { isText } = require('./resp');

/** Reply value -> string, or { b64 } for binary. */
function out(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return isText(v) ? v.toString('utf8') : { b64: v.toString('base64') };
  return String(v);
}

/** String or { b64 } from the window -> bytes to send. */
function inp(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v && typeof v === 'object' && typeof v.b64 === 'string') return Buffer.from(v.b64, 'base64');
  return Buffer.from(String(v === null || v === undefined ? '' : v), 'utf8');
}

const sameBytes = (a, b) => Buffer.compare(inp(a), inp(b)) === 0;

const MAX_ITEMS = 20000; // reply elements sent to the window per command
const MAX_BULK = 1 << 20; // bytes of one value shown in the Shell / Workbench
const MAX_TOTAL = 16 << 20; // bytes of one reply

/** Typed reply (resp.js) -> what the window prints, within the limits above. */
function wire(r, budget = { items: MAX_ITEMS, bytes: MAX_TOTAL }) {
  switch (r.t) {
    case 'bulk': {
      const cut = r.v.length > MAX_BULK || r.v.length > budget.bytes;
      const buf = cut ? r.v.subarray(0, Math.max(0, Math.min(MAX_BULK, budget.bytes))) : r.v;
      budget.bytes -= buf.length;
      const o = isText(buf) ? { t: 'bulk', s: buf.toString('utf8') } : { t: 'bulk', b: buf.toString('base64') };
      if (cut) o.cut = r.v.length;
      return o;
    }
    case 'array': case 'set': case 'push': case 'map': {
      const v = [];
      for (let i = 0; i < r.v.length; i++) {
        if (budget.items <= 0 || budget.bytes <= 0) { v.push({ t: 'more', n: r.v.length - i }); break; }
        budget.items--;
        v.push(r.t === 'map' ? [wire(r.v[i][0], budget), wire(r.v[i][1], budget)] : wire(r.v[i], budget));
      }
      return { t: r.t, v };
    }
    case 'error': case 'status': case 'int': case 'double': case 'bignum': case 'verbatim': return { t: r.t, v: r.v };
    case 'bool': return { t: 'bool', v: r.v };
    default: return { t: 'nil' };
  }
}

/** Key types as the UI names them (RedisJSON reports "ReJSON-RL"). */
const typeName = (t) => (t === 'ReJSON-RL' ? 'json' : String(t || 'none'));

module.exports = { out, inp, sameBytes, wire, typeName, MAX_ITEMS };
