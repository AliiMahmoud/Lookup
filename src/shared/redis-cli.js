/* global self -- this file runs in the browser (self) and in Node (module) */
// redis-cli behaviour shared by the Shell, the Workbench and the tests: splitting a typed line into
// arguments (same quoting rules as redis-cli) and printing replies exactly as redis-cli does in a
// terminal: OK, "text", (integer) 1, (nil), (error) …, (empty array), numbered nested lists.
//
// Replies come from the main process as { t, … }: status / error / int / double / bignum / verbatim
// { v }, bulk { s } (UTF-8 text) or { b } (base64 for binary), nil, bool { v }, array / set / push { v: [] },
// map { v: [[k, v] …] }, and more { n } when Lookup cut a very long reply short.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RedisCli = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8', { fatal: true });

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toB64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function fromB64(s) {
    const clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
    const out = [];
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
      out.push((n >> 16) & 255);
      if (clean[i + 2] !== undefined) out.push((n >> 8) & 255);
      if (clean[i + 3] !== undefined) out.push(n & 255);
    }
    return Uint8Array.from(out);
  }

  /** Bytes -> plain string when it is valid UTF-8, else { b64 }. */
  function fromBytes(bytes) {
    try { return dec.decode(Uint8Array.from(bytes)); } catch { return { b64: toB64(bytes) }; }
  }

  /**
   * Splits a typed line the way redis-cli does: spaces separate arguments; "double quotes" allow
   * \n \r \t \b \a \\ \" and \xHH; 'single quotes' allow only \'. A closing quote must be followed by a
   * space or the end. Returns { args } (strings, or { b64 } for bytes that aren't UTF-8) or { error }.
   */
  function parseLine(line) {
    const s = String(line);
    const args = [];
    let i = 0;
    const hex = (c) => /[0-9a-fA-F]/.test(c || '');
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) return { args };
      const bytes = [];
      const push = (str) => { for (const b of enc.encode(str)) bytes.push(b); };
      let inq = false;
      let insq = false;
      let done = false;
      while (!done) {
        const c = s[i];
        if (inq) {
          if (c === undefined) return { error: 'Invalid argument(s): unbalanced quotes' };
          if (c === '\\' && s[i + 1] === 'x' && hex(s[i + 2]) && hex(s[i + 3])) {
            bytes.push(parseInt(s.slice(i + 2, i + 4), 16));
            i += 3;
          } else if (c === '\\' && s[i + 1] !== undefined) {
            i++;
            const e = s[i];
            push(e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === 'b' ? '\b' : e === 'a' ? '\x07' : e);
          } else if (c === '"') {
            if (s[i + 1] !== undefined && !/\s/.test(s[i + 1])) return { error: 'Invalid argument(s): a closing quote must be followed by a space' };
            done = true;
          } else push(c);
        } else if (insq) {
          if (c === undefined) return { error: 'Invalid argument(s): unbalanced quotes' };
          if (c === '\\' && s[i + 1] === "'") { i++; push("'"); } else if (c === "'") {
            if (s[i + 1] !== undefined && !/\s/.test(s[i + 1])) return { error: 'Invalid argument(s): a closing quote must be followed by a space' };
            done = true;
          } else push(c);
        } else if (c === undefined || /\s/.test(c)) {
          done = true;
        } else if (c === '"') inq = true;
        else if (c === "'") insq = true;
        else push(c);
        if (i < s.length) i++;
      }
      args.push(fromBytes(bytes));
    }
  }

  /** One argument as redis-cli would need it typed: plain when safe, else "quoted". */
  function quoteArg(a) {
    if (a && typeof a === 'object') return repr(fromB64(a.b64));
    const str = String(a);
    if (str !== '' && !/[\s"'\\\x00-\x1f\x7f]/.test(str)) return str;
    return repr(enc.encode(str));
  }

  /** redis-cli's quoted form of bytes: printable ASCII as is, \n \r \t \a \b, everything else \xHH. */
  function repr(bytes) {
    let out = '"';
    for (const b of bytes) {
      if (b === 0x5c) out += '\\\\';
      else if (b === 0x22) out += '\\"';
      else if (b === 0x0a) out += '\\n';
      else if (b === 0x0d) out += '\\r';
      else if (b === 0x09) out += '\\t';
      else if (b === 0x07) out += '\\a';
      else if (b === 0x08) out += '\\b';
      else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
      else out += '\\x' + b.toString(16).padStart(2, '0');
    }
    return out + '"';
  }

  const bulkBytes = (r) => (r.b !== undefined ? fromB64(r.b) : enc.encode(r.s));
  /** A bulk reply as readable text (UTF-8 kept, binary shown with \xHH). */
  const bulkText = (r) => (r.b !== undefined ? repr(fromB64(r.b)).slice(1, -1) : r.s);

  /** A reply printed exactly like redis-cli in a terminal (no trailing newline). */
  function formatTTY(r) {
    return tty(r, '').replace(/\n$/, '');
  }

  function tty(r, prefix) {
    switch (r.t) {
      case 'status': return r.v + '\n';
      case 'error': return `(error) ${r.v}\n`;
      case 'int': return `(integer) ${r.v}\n`;
      case 'double': return `(double) ${r.v}\n`;
      case 'bignum': return `(big number) ${r.v}\n`;
      case 'bool': return (r.v ? '(true)' : '(false)') + '\n';
      case 'nil': return '(nil)\n';
      case 'bulk': return repr(bulkBytes(r)) + '\n';
      case 'verbatim': return repr(enc.encode(r.v)) + '\n';
      case 'more': return `(… ${r.n.toLocaleString('en-US')} more not shown)\n`;
      case 'array': case 'set': case 'push': case 'map': {
        const items = r.t === 'map' ? r.v.flat() : r.v;
        if (!items.length) return r.t === 'map' ? '(empty hash)\n' : '(empty array)\n';
        const count = r.t === 'map' ? r.v.length : items.length;
        const idxlen = String(count).length;
        const sub = prefix + ' '.repeat(idxlen + 2);
        const sep = r.t === 'set' ? '~' : r.t === 'map' ? '#' : ')';
        let out = '';
        for (let i = 0; i < items.length; i++) {
          if (items[i].t === 'more') { out += (i === 0 ? '' : prefix) + tty(items[i], sub); continue; }
          const human = (r.t === 'map' ? Math.floor(i / 2) : i) + 1;
          out += `${i === 0 ? '' : prefix}${String(human).padStart(idxlen)}${sep} `;
          out += tty(items[i], sub);
          if (r.t === 'map') {
            i++;
            out = out.replace(/\n$/, '') + ' => ' + tty(items[i], sub);
          }
        }
        return out;
      }
      default: return '\n';
    }
  }

  /** redis-cli --raw style: values only, one per line, text as UTF-8. */
  function formatRaw(r) {
    switch (r.t) {
      case 'status': case 'int': case 'double': case 'bignum': case 'verbatim': return String(r.v);
      case 'error': return `(error) ${r.v}`;
      case 'bool': return r.v ? '1' : '0';
      case 'nil': return '';
      case 'bulk': return r.b !== undefined ? bulkText(r) : r.s;
      case 'more': return `(… ${r.n.toLocaleString('en-US')} more not shown)`;
      case 'array': case 'set': case 'push': return r.v.map(formatRaw).join('\n');
      case 'map': return r.v.map(([k, v]) => formatRaw(k) + '\n' + formatRaw(v)).join('\n');
      default: return '';
    }
  }

  return { parseLine, quoteArg, repr, formatTTY, formatRaw, bulkText, toB64, fromB64, fromBytes };
});
