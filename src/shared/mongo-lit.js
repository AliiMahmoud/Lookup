/* global self -- this file runs in the browser (self) and in Node (module) */
// MongoDB values as people type and read them in mongosh: { status: 'paid', _id: ObjectId('…') },
// ISODate('…'), Long('…'), Decimal128('…'), /regex/i, unquoted keys, single quotes, trailing commas.
// parse() turns such text into canonical Extended JSON (plain JSON that keeps every BSON type, so it
// crosses from the window to the main process unchanged); print() turns canonical Extended JSON back
// into mongosh-style text. Used by the filter bar, the document editor, aggregation stages, the Shell
// and the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MongoLit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const INT32_MIN = -2147483648;
  const INT32_MAX = 2147483647;

  class LitError extends Error {
    constructor(message, pos) { super(message); this.pos = pos; }
  }

  // ---------- Numbers and dates as canonical Extended JSON ----------
  function jsNumber(n) {
    if (Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX && !Object.is(n, -0)) return { $numberInt: String(n) };
    if (Number.isNaN(n)) return { $numberDouble: 'NaN' };
    if (n === Infinity) return { $numberDouble: 'Infinity' };
    if (n === -Infinity) return { $numberDouble: '-Infinity' };
    return { $numberDouble: String(n) };
  }
  function dateValue(ms) {
    if (!Number.isFinite(ms)) throw new Error('Invalid date');
    return { $date: { $numberLong: String(Math.trunc(ms)) } };
  }
  const HEX24 = /^[0-9a-fA-F]{24}$/;
  const UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

  // Base64 without Buffer (the window has no Buffer).
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function hexToB64(hex) {
    const bytes = hex.match(/../g).map((x) => parseInt(x, 16));
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function b64ToHex(b64) {
    const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, '');
    let hex = '';
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
      hex += ((n >> 16) & 255).toString(16).padStart(2, '0');
      if (clean[i + 2] !== undefined) hex += ((n >> 8) & 255).toString(16).padStart(2, '0');
      if (clean[i + 3] !== undefined) hex += (n & 255).toString(16).padStart(2, '0');
    }
    return hex;
  }

  // Constructors mongosh knows, with or without "new".
  const CTORS = {
    ObjectId: (a) => {
      if (!a.length) return { $oid: newObjectIdHex() };
      const s = str(a[0], 'ObjectId');
      if (!HEX24.test(s)) throw new Error('ObjectId needs 24 hex characters');
      return { $oid: s.toLowerCase() };
    },
    ISODate: (a) => (a.length ? dateValue(parseDate(a[0])) : dateValue(Date.now())),
    Date: (a) => (a.length ? dateValue(parseDate(a[0])) : dateValue(Date.now())),
    NumberLong: (a) => ({ $numberLong: intText(a[0], 'NumberLong') }),
    Long: (a) => ({ $numberLong: intText(a[0], 'Long') }),
    NumberInt: (a) => int32(a[0]),
    Int32: (a) => int32(a[0]),
    NumberDecimal: (a) => ({ $numberDecimal: decText(a[0]) }),
    Decimal128: (a) => ({ $numberDecimal: decText(a[0]) }),
    Double: (a) => ({ $numberDouble: String(Number(numOrStr(a[0]))) }),
    UUID: (a) => {
      const s = a.length ? str(a[0], 'UUID') : randomUuid();
      if (!UUID_RE.test(s)) throw new Error('UUID needs 32 hex characters');
      return { $binary: { base64: hexToB64(s.replace(/-/g, '')), subType: '04' } };
    },
    BinData: (a) => ({ $binary: { base64: str(a[1], 'BinData'), subType: Number(numOrStr(a[0])).toString(16).padStart(2, '0') } }),
    HexData: (a) => ({ $binary: { base64: hexToB64(str(a[1], 'HexData')), subType: Number(numOrStr(a[0])).toString(16).padStart(2, '0') } }),
    Timestamp: (a) => {
      if (a[0] && typeof a[0] === 'object' && 't' in a[0]) return { $timestamp: { t: Number(numOrStr(a[0].t)), i: Number(numOrStr(a[0].i || { $numberInt: '0' })) } };
      return { $timestamp: { t: Number(numOrStr(a[0])), i: Number(numOrStr(a[1] || { $numberInt: '0' })) } };
    },
    MinKey: () => ({ $minKey: 1 }),
    MaxKey: () => ({ $maxKey: 1 }),
    Code: (a) => ({ $code: str(a[0], 'Code') }),
    RegExp: (a) => ({ $regularExpression: { pattern: str(a[0], 'RegExp'), options: a[1] ? sortFlags(str(a[1], 'RegExp')) : '' } }),
    DBRef: (a) => ({ $ref: str(a[0], 'DBRef'), $id: a[1] }),
  };
  CTORS['Binary.createFromBase64'] = (a) => ({ $binary: { base64: str(a[0], 'Binary'), subType: Number(numOrStr(a[1] || { $numberInt: '0' })).toString(16).padStart(2, '0') } });
  CTORS['Binary.createFromHexString'] = (a) => ({ $binary: { base64: hexToB64(str(a[0], 'Binary')), subType: Number(numOrStr(a[1] || { $numberInt: '0' })).toString(16).padStart(2, '0') } });

  function str(v, fn) {
    if (typeof v !== 'string') throw new Error(`${fn}() needs a string`);
    return v;
  }
  function numOrStr(v) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.$numberInt ?? v.$numberDouble ?? v.$numberLong ?? v.$numberDecimal ?? NaN;
    return NaN;
  }
  function intText(v, fn) {
    const s = String(v && v.raw ? v.raw : numOrStr(v)).trim();
    if (!/^-?\d+$/.test(s)) throw new Error(`${fn}() needs a whole number`);
    return s.replace(/^(-?)0+(?=\d)/, '$1');
  }
  function int32(v) {
    const n = Number(numOrStr(v));
    if (!Number.isInteger(n) || n < INT32_MIN || n > INT32_MAX) throw new Error('Int32 needs a whole number between -2147483648 and 2147483647');
    return { $numberInt: String(n) };
  }
  function decText(v) {
    const s = String(v && v.raw ? v.raw : numOrStr(v)).trim();
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^[-+]?(Infinity|Inf|NaN)$/i.test(s)) throw new Error('Decimal128 needs a number');
    return s;
  }
  function parseDate(v) {
    if (typeof v === 'string') {
      // ISODate('2026-10-08') is midnight UTC, like mongosh.
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00Z' : v;
      const ms = Date.parse(iso);
      if (Number.isNaN(ms)) throw new Error(`Not a date: ${v}`);
      return ms;
    }
    const n = Number(numOrStr(v));
    if (!Number.isFinite(n)) throw new Error('Date needs a string or milliseconds');
    return n;
  }
  const sortFlags = (f) => [...new Set(String(f))].sort().join('');
  let oidCounter = Math.floor(Math.random() * 0xffffff);
  const oidRandom = Array.from({ length: 5 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
  function newObjectIdHex() {
    const t = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    oidCounter = (oidCounter + 1) % 0xffffff;
    return t + oidRandom + oidCounter.toString(16).padStart(6, '0');
  }
  function randomUuid() {
    const h = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
    h[6] = (h[6] & 0x0f) | 0x40; h[8] = (h[8] & 0x3f) | 0x80;
    const x = h.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  // ---------- Parser ----------
  class Parser {
    constructor(text, pos = 0) { this.s = String(text); this.i = pos; }

    fail(msg, at = this.i) { throw new LitError(msg, at); }

    ws() {
      for (;;) {
        const c = this.s[this.i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { this.i++; continue; }
        if (c === '/' && this.s[this.i + 1] === '/') { while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++; continue; }
        if (c === '/' && this.s[this.i + 1] === '*') { const e = this.s.indexOf('*/', this.i + 2); this.i = e < 0 ? this.s.length : e + 2; continue; }
        return;
      }
    }

    peek() { this.ws(); return this.s[this.i]; }

    eat(ch) {
      if (this.peek() !== ch) this.fail(`Expected ${ch}`);
      this.i++;
    }

    ident() {
      this.ws();
      const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i));
      if (!m) return null;
      this.i += m[0].length;
      return m[0];
    }

    value() {
      const c = this.peek();
      if (c === undefined) this.fail('Unexpected end');
      if (c === '{') return this.object();
      if (c === '[') return this.array();
      if (c === '"' || c === "'" || c === '`') return this.string();
      if (c === '/') return this.regex();
      if (c === '-' || c === '+' || c === '.' || /\d/.test(c)) return this.number();
      const start = this.i;
      let name = this.ident();
      if (name === null) this.fail(`Unexpected ${c}`);
      if (name === 'true') return true;
      if (name === 'false') return false;
      if (name === 'null') return null;
      if (name === 'undefined') return { $undefined: true };
      if (name === 'NaN') return { $numberDouble: 'NaN' };
      if (name === 'Infinity') return { $numberDouble: 'Infinity' };
      if (name === 'new') { name = this.ident(); if (!name) this.fail('Expected a type after new'); }
      while (this.peek() === '.') { this.i++; const more = this.ident(); if (!more) this.fail('Expected a name'); name += '.' + more; }
      if (name === 'Date.now' && this.peek() === '(') { this.eat('('); this.eat(')'); return jsNumber(Date.now()); }
      const fn = CTORS[name];
      if (!fn) this.fail(`Unknown name ${name}. Values are literals: strings, numbers, { … }, [ … ], ObjectId('…'), ISODate('…') …`, start);
      if (this.peek() !== '(') this.fail(`Expected ( after ${name}`);
      const args = this.args();
      try { return fn(args); } catch (e) { this.fail(e.message, start); }
    }

    args() {
      this.eat('(');
      const out = [];
      if (this.peek() === ')') { this.i++; return out; }
      for (;;) {
        out.push(this.value());
        const c = this.peek();
        if (c === ',') { this.i++; if (this.peek() === ')') { this.i++; return out; } continue; }
        if (c === ')') { this.i++; return out; }
        this.fail('Expected , or )');
      }
    }

    object() {
      this.eat('{');
      const out = {};
      for (;;) {
        const c = this.peek();
        if (c === '}') { this.i++; return out; }
        let key;
        if (c === '"' || c === "'" || c === '`') key = this.string();
        else if (c !== undefined && /\d/.test(c)) { const m = /^\d+/.exec(this.s.slice(this.i)); key = m[0]; this.i += key.length; }
        else { key = this.ident(); if (key === null) this.fail('Expected a field name'); }
        this.eat(':');
        out[key] = this.value();
        const d = this.peek();
        if (d === ',') { this.i++; continue; }
        if (d === '}') { this.i++; return out; }
        this.fail('Expected , or }');
      }
    }

    array() {
      this.eat('[');
      const out = [];
      for (;;) {
        if (this.peek() === ']') { this.i++; return out; }
        out.push(this.value());
        const d = this.peek();
        if (d === ',') { this.i++; continue; }
        if (d === ']') { this.i++; return out; }
        this.fail('Expected , or ]');
      }
    }

    string() {
      const q = this.s[this.i];
      const start = this.i;
      this.i++;
      let out = '';
      for (;;) {
        const c = this.s[this.i];
        if (c === undefined) this.fail('Unclosed string', start);
        this.i++;
        if (c === q) return out;
        if (c === '\\') {
          const e = this.s[this.i++];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === '0') out += '\0';
          else if (e === 'u') {
            if (this.s[this.i] === '{') { const end = this.s.indexOf('}', this.i); out += String.fromCodePoint(parseInt(this.s.slice(this.i + 1, end), 16)); this.i = end + 1; } else { out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16)); this.i += 4; }
          } else if (e === 'x') { out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16)); this.i += 2; } else if (e === '\n') { /* line continuation */ } else out += e;
        } else out += c;
      }
    }

    number() {
      const m = /^[-+]?(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|Infinity)/.exec(this.s.slice(this.i));
      if (!m) this.fail('Expected a number');
      this.i += m[0].length;
      // The typed digits are kept (not enumerable) so NumberLong(9007199254740993) stays exact.
      return Object.defineProperty(jsNumber(Number(m[0])), 'raw', { value: m[0], enumerable: false });
    }

    regex() {
      const start = this.i;
      this.i++;
      let pattern = '';
      let inClass = false;
      for (;;) {
        const c = this.s[this.i];
        if (c === undefined || c === '\n') this.fail('Unclosed regular expression', start);
        this.i++;
        if (c === '\\') { pattern += c + this.s[this.i++]; continue; }
        if (c === '[') inClass = true;
        if (c === ']') inClass = false;
        if (c === '/' && !inClass) break;
        pattern += c;
      }
      const m = /^[a-z]*/.exec(this.s.slice(this.i));
      this.i += m[0].length;
      return { $regularExpression: { pattern, options: sortFlags(m[0]) } };
    }
  }

  /** Text -> canonical Extended JSON; throws LitError (with .pos) on mistakes. Empty text = {}. */
  function parse(text, { empty = {} } = {}) {
    const p = new Parser(text);
    if (p.peek() === undefined) return empty;
    const v = p.value();
    if (p.peek() !== undefined) p.fail('Unexpected text after the value');
    return v;
  }

  // ---------- Types ----------
  function typeOf(v) {
    if (v === null) return 'Null';
    if (typeof v === 'string') return 'String';
    if (typeof v === 'boolean') return 'Boolean';
    if (typeof v === 'number') return Number.isInteger(v) ? 'Int32' : 'Double';
    if (Array.isArray(v)) return 'Array';
    if ('$oid' in v) return 'ObjectId';
    if ('$date' in v) return 'Date';
    if ('$numberInt' in v) return 'Int32';
    if ('$numberLong' in v) return 'Int64';
    if ('$numberDouble' in v) return 'Double';
    if ('$numberDecimal' in v) return 'Decimal128';
    if ('$binary' in v) return v.$binary.subType === '04' ? 'UUID' : 'Binary';
    if ('$regularExpression' in v) return 'Regex';
    if ('$timestamp' in v) return 'Timestamp';
    if ('$minKey' in v) return 'MinKey';
    if ('$maxKey' in v) return 'MaxKey';
    if ('$undefined' in v) return 'Undefined';
    if ('$code' in v) return 'Code';
    if ('$symbol' in v) return 'Symbol';
    if ('$ref' in v && '$id' in v) return 'DBRef';
    return 'Object';
  }
  const isContainer = (v) => { const t = typeOf(v); return t === 'Object' || t === 'Array'; };

  /** Milliseconds of a $date (canonical { $numberLong } or relaxed ISO string). */
  function dateMs(v) {
    const d = v.$date;
    if (d && typeof d === 'object') return Number(d.$numberLong);
    if (typeof d === 'string') return Date.parse(d);
    return Number(d);
  }
  const isoOf = (v) => { const ms = dateMs(v); return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : String(ms); };

  function uuidOf(v) {
    const x = b64ToHex(v.$binary.base64);
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  function numberText(s) {
    if (s === 'NaN' || s === 'Infinity' || s === '-Infinity') return s;
    const n = Number(s);
    return Object.is(n, -0) ? '-0' : String(n);
  }

  // ---------- Printing (mongosh style) ----------
  const quote = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + "'";
  const keyText = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k));

  /** One value as a short mongosh literal, no line breaks (for scalars; containers are printed by print()). */
  function scalarText(v) {
    switch (typeOf(v)) {
      case 'Null': return 'null';
      case 'String': return quote(v);
      case 'Boolean': return String(v);
      case 'ObjectId': return `ObjectId('${v.$oid}')`;
      case 'Date': return `ISODate('${isoOf(v)}')`;
      case 'Int32': return typeof v === 'number' ? String(v) : String(Number(v.$numberInt));
      case 'Int64': return `Long('${v.$numberLong}')`;
      case 'Double': return typeof v === 'number' ? String(v) : numberText(v.$numberDouble);
      case 'Decimal128': return `Decimal128('${v.$numberDecimal}')`;
      case 'UUID': return `UUID('${uuidOf(v)}')`;
      case 'Binary': return `Binary.createFromBase64('${v.$binary.base64}', ${parseInt(v.$binary.subType, 16)})`;
      case 'Regex': return `/${v.$regularExpression.pattern}/${v.$regularExpression.options}`;
      case 'Timestamp': return `Timestamp({ t: ${v.$timestamp.t}, i: ${v.$timestamp.i} })`;
      case 'MinKey': return 'MinKey()';
      case 'MaxKey': return 'MaxKey()';
      case 'Undefined': return 'undefined';
      case 'Code': return `Code(${quote(v.$code)})`;
      case 'Symbol': return quote(v.$symbol);
      case 'DBRef': return `DBRef(${quote(v.$ref)}, ${print(v.$id)})`;
      default: return null;
    }
  }

  /**
   * mongosh-style text: small objects / arrays on one line ({ a: 1, b: 'x' }), larger ones one field per
   * line with two-space indents, like mongosh's output. width: the line length to stay under.
   */
  function print(v, { width = 72, indent = 0 } = {}) {
    const s = scalarText(v);
    if (s !== null) return s;
    const t = typeOf(v);
    const entries = t === 'Array' ? v.map((x) => [null, x]) : Object.entries(v);
    if (!entries.length) return t === 'Array' ? '[]' : '{}';
    const flat = (x) => { const sc = scalarText(x); if (sc !== null) return sc; const inner = typeOf(x) === 'Array' ? x.map(flat) : Object.entries(x).map(([k, y]) => `${keyText(k)}: ${flat(y)}`); return typeOf(x) === 'Array' ? (inner.length ? `[ ${inner.join(', ')} ]` : '[]') : (inner.length ? `{ ${inner.join(', ')} }` : '{}'); };
    const one = flat(v);
    if (one.length + indent <= width && !one.includes('\n')) return one;
    const pad = ' '.repeat(indent + 2);
    const lines = entries.map(([k, x]) => `${pad}${k === null ? '' : keyText(k) + ': '}${print(x, { width, indent: indent + 2 })}`);
    return `${t === 'Array' ? '[' : '{'}\n${lines.join(',\n')}\n${' '.repeat(indent)}${t === 'Array' ? ']' : '}'}`;
  }

  /** Short text for a table cell: scalars as values, containers summarized. */
  function cellText(v) {
    const t = typeOf(v);
    if (t === 'Object') { const n = Object.keys(v).length; return `{ ${n} field${n === 1 ? '' : 's'} }`; }
    if (t === 'Array') return `[ ${v.length} item${v.length === 1 ? '' : 's'} ]`;
    if (t === 'String') return v;
    if (t === 'Date') return isoOf(v);
    if (t === 'ObjectId') return v.$oid;
    if (t === 'Int64') return v.$numberLong;
    if (t === 'Decimal128') return v.$numberDecimal;
    return scalarText(v);
  }

  /** Deep equality of two canonical Extended JSON values. */
  function equal(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => k === kb[i] && equal(a[k], b[k]));
  }

  /**
   * After editing printed text: numbers whose value didn't change keep their original type (a Double
   * 605 prints as 605 and would read back as Int32; Long('5') typed as 5, etc.). Walks objects and
   * arrays in parallel; anything else that changed is kept as typed.
   */
  function keepTypes(edited, original) {
    const NUM = /^(Int32|Int64|Double|Decimal128)$/;
    const te = typeOf(edited); const to = original === undefined ? null : typeOf(original);
    if (to && NUM.test(te) && NUM.test(to) && te !== to && numValue(edited) === numValue(original)) return original;
    if (te === 'Object' && to === 'Object') { const out = {}; for (const [k, v] of Object.entries(edited)) out[k] = keepTypes(v, original[k]); return out; }
    if (te === 'Array' && to === 'Array') return edited.map((v, i) => keepTypes(v, original[i]));
    return edited;
  }
  function numValue(v) {
    if (typeof v === 'number') return String(v);
    const s = v.$numberInt ?? v.$numberLong ?? v.$numberDouble ?? v.$numberDecimal;
    const n = Number(s);
    return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? String(n) : String(s);
  }

  return { keepTypes, parse, print, scalarText, cellText, typeOf, isContainer, equal, dateMs, isoOf, uuidOf, Parser, LitError, jsNumber, newObjectIdHex, quote, keyText };
});
