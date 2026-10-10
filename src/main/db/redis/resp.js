// A small Redis protocol (RESP2 / RESP3) client over TCP or TLS. Replies keep their exact type, so the
// Shell can print them the way redis-cli does (OK vs "OK", (integer), (nil), (error) …), and pushed
// messages (SUBSCRIBE, MONITOR) are passed to a listener. No dependency; pipelining comes for free.
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

/**
 * Reply types: { t: 'status', v } · { t: 'error', v } · { t: 'int', v: string } · { t: 'bulk', v: Buffer }
 * { t: 'nil' } · { t: 'array', v: [...] } · { t: 'map', v: [[k, v] …] } · { t: 'set', v: [...] }
 * { t: 'double', v } · { t: 'bool', v } · { t: 'verbatim', v } · { t: 'bignum', v } · { t: 'push', v: [...] }
 */
class Parser {
  constructor() { this.buf = Buffer.alloc(0); }

  feed(chunk) { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; }

  /** Next complete reply, or undefined when more bytes are needed. */
  next() {
    const r = this.parse(0);
    if (!r) return undefined;
    this.buf = this.buf.subarray(r.end);
    return r.value;
  }

  line(pos) {
    const e = this.buf.indexOf('\r\n', pos);
    return e < 0 ? null : { text: this.buf.toString('utf8', pos + 1, e), end: e + 2 };
  }

  parse(pos) {
    if (pos >= this.buf.length) return null;
    const type = String.fromCharCode(this.buf[pos]);
    const l = this.line(pos);
    if (!l) return null;
    const agg = (t, n, pairs) => {
      if (n < 0) return { value: { t: 'nil' }, end: l.end };
      const items = [];
      let p = l.end;
      for (let i = 0; i < n * (pairs ? 2 : 1); i++) {
        const r = this.parse(p);
        if (!r) return null;
        items.push(r.value);
        p = r.end;
      }
      const v = pairs ? Array.from({ length: n }, (_, i) => [items[2 * i], items[2 * i + 1]]) : items;
      return { value: { t, v }, end: p };
    };
    switch (type) {
      case '+': return { value: { t: 'status', v: l.text }, end: l.end };
      case '-': return { value: { t: 'error', v: l.text }, end: l.end };
      case ':': return { value: { t: 'int', v: l.text }, end: l.end };
      case '_': return { value: { t: 'nil' }, end: l.end };
      case ',': return { value: { t: 'double', v: l.text }, end: l.end };
      case '#': return { value: { t: 'bool', v: l.text === 't' }, end: l.end };
      case '(': return { value: { t: 'bignum', v: l.text }, end: l.end };
      case '$': case '=': case '!': {
        const n = Number(l.text);
        if (n < 0) return { value: { t: 'nil' }, end: l.end };
        if (this.buf.length < l.end + n + 2) return null;
        const data = this.buf.subarray(l.end, l.end + n);
        const t = type === '$' ? 'bulk' : type === '=' ? 'verbatim' : 'error';
        const v = type === '$' ? Buffer.from(data) : type === '=' ? data.toString('utf8').slice(4) : data.toString('utf8');
        return { value: { t, v }, end: l.end + n + 2 };
      }
      case '*': return agg('array', Number(l.text));
      case '~': return agg('set', Number(l.text));
      case '>': return agg('push', Number(l.text));
      case '%': return agg('map', Number(l.text), true);
      case '|': { // attributes: read and drop, then the real reply follows
        const a = agg('map', Number(l.text), true);
        return a ? this.parse(a.end) : null;
      }
      default: throw new Error(`Unexpected reply from the server (byte ${type.charCodeAt(0)})`);
    }
  }
}

/** Encodes one command (strings, numbers or Buffers) as a RESP array of bulk strings. */
function encode(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

class RespClient extends EventEmitter {
  constructor() {
    super();
    this.queue = []; // { resolve, reject } in send order
    this.parser = new Parser();
    this.closed = false;
    this.pushMode = false; // SUBSCRIBE / MONITOR: replies arrive without a request
  }

  connect({ host = '127.0.0.1', port = 6379, tls: useTls = false, rejectUnauthorized = true, timeoutMs = 60000, keepAliveMs = 60000, servername }) {
    return new Promise((resolve, reject) => {
      const onError = (e) => { cleanup(); reject(e); };
      const timer = setTimeout(() => { this.sock.destroy(); onError(Object.assign(new Error(`Could not connect to ${host}:${port} within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.sock.removeListener('error', onError); };
      const ready = () => {
        cleanup();
        if (keepAliveMs) this.sock.setKeepAlive(true, keepAliveMs);
        this.sock.setNoDelay(true);
        resolve(this);
      };
      this.sock = useTls
        ? tls.connect({ host, port, rejectUnauthorized, servername: servername || (net.isIP(host) ? undefined : host) }, ready)
        : net.connect({ host, port }, ready);
      this.sock.once('error', onError);
      this.sock.on('data', (chunk) => this.onData(chunk));
      this.sock.on('error', (e) => { this.lastError = e; });
      this.sock.on('close', () => this.onClose());
    });
  }

  onData(chunk) {
    this.parser.feed(chunk);
    for (;;) {
      let reply;
      try { reply = this.parser.next(); } catch (e) { this.sock.destroy(e); return; }
      if (reply === undefined) return;
      // Pushed messages: RESP3 pushes, and every reply while subscribed / monitoring.
      if (reply.t === 'push' || (this.pushMode && !this.queue.length)) { this.emit('push', reply); continue; }
      const waiter = this.queue.shift();
      if (waiter) waiter.resolve(reply);
    }
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    const err = Object.assign(new Error(this.lastError ? `Connection lost: ${this.lastError.message}` : 'Connection closed by the server'), { code: 'ECONNRESET' });
    for (const w of this.queue.splice(0)) w.reject(err);
    this.emit('close', err);
  }

  /** Sends one command; resolves with the typed reply (errors are replies too, not rejections). */
  send(args) {
    if (this.closed) return Promise.reject(Object.assign(new Error('Connection closed'), { code: 'ECONNRESET' }));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.sock.write(encode(args));
    });
  }

  /** Sends a command whose replies all arrive as pushes (SUBSCRIBE, MONITOR): sets push mode first. */
  sendStreaming(args) {
    if (this.closed) throw Object.assign(new Error('Connection closed'), { code: 'ECONNRESET' });
    this.pushMode = true;
    this.sock.write(encode(args));
  }

  /** Sends one command and returns plain JavaScript (strings, numbers, arrays); a Redis error throws. */
  async call(...args) {
    const r = await this.send(args);
    return plain(r);
  }

  /** Several commands in one round trip; returns each reply as plain values (errors as Error objects). */
  async pipeline(commands) {
    const replies = await Promise.all(commands.map((c) => this.send(c)));
    return replies.map((r) => { try { return plain(r); } catch (e) { return e; } });
  }

  close() {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.sock.once('close', () => resolve());
      this.sock.end();
      setTimeout(() => { this.sock.destroy(); resolve(); }, 1000).unref?.();
    });
  }

  destroy() { if (this.sock) this.sock.destroy(); }
}

/** Typed reply -> plain value; bulk strings become UTF-8 text (binaries stay Buffers). */
function plain(r, binary = false) {
  switch (r.t) {
    case 'error': throw Object.assign(new Error(r.v), { code: r.v.split(' ')[0], redis: true });
    case 'status': case 'verbatim': case 'bignum': return r.v;
    case 'int': return Number(r.v);
    case 'double': return Number(r.v);
    case 'bool': return r.v;
    case 'nil': return null;
    case 'bulk': return binary || !isText(r.v) ? r.v : r.v.toString('utf8');
    case 'array': case 'set': case 'push': return r.v.map((x) => plain(x, binary));
    case 'map': return r.v.map(([k, v]) => [plain(k, binary), plain(v, binary)]);
    default: return null;
  }
}

/** True when the bytes are valid UTF-8 text without control characters (other than tabs / newlines). */
function isText(buf) {
  if (!buf.length) return true;
  const s = buf.toString('utf8');
  if (s.includes('�') && !buf.includes(Buffer.from('�'))) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s);
}

module.exports = { RespClient, Parser, encode, plain, isText };
