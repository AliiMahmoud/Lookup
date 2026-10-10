// Redis Cluster: one connection per node, opened when first needed. Each command goes to the node
// holding its key's slot (CRC16 of the key, or of its {hash tag}); MOVED refreshes the slot map and
// sends again, ASK sends ASKING first. Pipelines are split per node and put back in order. Nodes that
// announce an address Lookup can't reach (Docker, SSH tunnels) are tried at the host the user typed.
const { plain } = require('./resp');
const { RedisConn, Pipe, openClient } = require('./connect');

// CRC16-CCITT (XMODEM), as Redis Cluster uses for key slots.
const CRC = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  CRC[i] = c;
}
function crc16(buf) {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) & 0xffff) ^ CRC[((crc >> 8) ^ b) & 0xff];
  return crc;
}
/** The slot of a key: only the part inside the first non-empty {…} counts, if there is one. */
function slotOf(key) {
  const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
  const open = k.indexOf(0x7b); // {
  if (open >= 0) {
    const close = k.indexOf(0x7d, open + 1); // }
    if (close > open + 1) return crc16(k.subarray(open + 1, close)) % 16384;
  }
  return crc16(k) % 16384;
}

// Where the key is in the commands Lookup sends by itself (not the user's: see cli.js).
const KEY_AT_2 = new Set(['MEMORY', 'OBJECT', 'XINFO']);
const KEYLESS = new Set(['SCAN', 'INFO', 'CONFIG', 'DBSIZE', 'MULTI', 'EXEC', 'DISCARD', 'CLIENT', 'COMMAND', 'PING', 'SLOWLOG', 'MODULE', 'CLUSTER', 'ROLE', 'ASKING', 'SELECT', 'AUTH', 'HELLO', 'TIME', 'LASTSAVE']);
function keyOf(args) {
  const name = String(args[0] || '').toUpperCase();
  if (KEYLESS.has(name)) return null;
  const i = KEY_AT_2.has(name) ? 2 : 1;
  return args.length > i ? args[i] : null;
}

const redirect = (r) => (r && r.t === 'error' && /^(MOVED|ASK) /.test(r.v) ? (() => {
  const [kind, slot, addr] = r.v.split(' ');
  return { kind, slot: Number(slot), addr };
})() : null);

/** Connections to the nodes for one purpose (the key browser, or the Workbench). */
class NodePool {
  constructor(conn, name) {
    this.conn = conn;
    this.name = name;
    this.clients = new Map(); // node id -> RespClient (or a promise while it connects)
  }

  async get(id) {
    const have = this.clients.get(id);
    if (have && !have.closed) return have; // a client, or a promise while it connects
    const p = this.conn.connectNode(id, this.name).then((c) => {
      this.clients.set(id, c);
      c.once('close', () => { if (this.clients.get(id) === c) this.clients.delete(id); });
      return c;
    }, (e) => { this.clients.delete(id); throw e; });
    this.clients.set(id, p);
    return p;
  }

  /** Sends one command following redirects; resolves with { reply (typed), node }. */
  async send(id, args, hops = 0) {
    const c = await this.get(id);
    const r = await c.send(args);
    const to = redirect(r);
    if (!to || hops >= 5) return { reply: r, node: id };
    if (to.kind === 'MOVED') { this.conn.slots[to.slot] = to.addr; this.conn.loadSlots().catch(() => {}); return this.send(to.addr, args, hops + 1); }
    const target = await this.get(to.addr);
    const [, reply] = await Promise.all([target.send(['ASKING']), target.send(args)]);
    return { reply, node: to.addr };
  }

  destroy() {
    for (const c of this.clients.values()) if (!(c instanceof Promise)) c.destroy();
    this.clients.clear();
  }
}

class ClusterConn extends RedisConn {
  constructor(client, t, cfg) {
    super(client, t, cfg);
    this.cluster = true;
    this.db = 0; // a cluster has only database 0
    this.seed = `${t.host}:${t.port}`;
    this.slots = new Array(16384).fill(null); // slot -> node id "host:port"
    this.nodes = []; // masters: { id, ranges: [[from, to]], replicas: [id] }
    this.reach = new Map(); // node id -> { host, port } it was reached at
    this.reach.set(this.seed, { host: t.host, port: t.port });
    this.pool = new NodePool(this, 'lookup');
    this.pool.clients.set(this.seed, client);
  }

  /** Reads the slot map (CLUSTER SLOTS works on every version that has clusters). */
  async loadSlots() {
    const rows = await this.client.call('CLUSTER', 'SLOTS');
    const byId = new Map();
    const idOf = (n) => `${String(n[0]) || this.t.host}:${n[1]}`;
    this.slots.fill(null);
    for (const row of rows) {
      const [from, to, master, ...replicas] = row;
      const id = idOf(master);
      if (!byId.has(id)) byId.set(id, { id, ranges: [], replicas: replicas.map(idOf) });
      byId.get(id).ranges.push([Number(from), Number(to)]);
      for (let s = Number(from); s <= Number(to); s++) this.slots[s] = id;
    }
    this.nodes = [...byId.values()].sort((a, b) => a.ranges[0][0] - b.ranges[0][0]);
    return this.nodes;
  }

  masterIds() { return this.nodes.map((n) => n.id); }

  nodeOfKey(key) { return this.slots[slotOf(key)] || this.seed; }

  /** A logged-in connection to a node; an announced address that can't be reached is tried at the
   *  host the user typed, with the node's port. */
  async connectNode(id, name) {
    const i = id.lastIndexOf(':');
    const host = id.slice(0, i);
    const port = Number(id.slice(i + 1));
    const known = this.reach.get(id);
    const tries = known ? [known] : [{ host, port }, ...(host !== this.t.host ? [{ host: this.t.host, port }] : [])];
    let last;
    for (const a of tries) {
      try {
        const c = await openClient({ ...this.t, host: a.host, port: a.port, database: 0 }, this.cfg, name);
        this.reach.set(id, a);
        // Every node connection (key browser, Workbench, Shell) is closed with the session.
        this.extras.add(c);
        c.once('close', () => this.extras.delete(c));
        return c;
      } catch (e) { last = e; if (e.redis) throw e; } // a login error won't change at another address
    }
    throw last;
  }

  /** App-issued commands (logged): routed by key, or to cmd.node; pipelines split per node. */
  async execute(cmd) {
    if (cmd instanceof Pipe) return this.runPipe(cmd);
    const key = cmd.node ? null : keyOf(cmd.args);
    const id = cmd.node || (key !== null ? this.nodeOfKey(key) : this.seed);
    const { reply } = await this.pool.send(id, cmd.args);
    return plain(reply);
  }

  async runPipe(pipe) {
    const cmds = pipe.cmds;
    // MULTI … EXEC (one key) and pipes for one node go together; others are split per node.
    if (pipe.node || cmds.some((c) => String(c[0]).toUpperCase() === 'MULTI')) {
      const first = cmds.map(keyOf).find((k) => k !== null);
      let id = pipe.node || (first !== undefined && first !== null ? this.nodeOfKey(first) : this.seed);
      for (let attempt = 0; ; attempt++) {
        const c = await this.pool.get(id);
        const replies = await Promise.all(cmds.map((x) => c.send(x)));
        const moved = replies.map(redirect).find(Boolean);
        if (!moved || attempt >= 2 || pipe.node) return replies.map((r) => { try { return plain(r); } catch (e) { return e; } });
        await this.loadSlots();
        id = moved.addr;
      }
    }
    const groups = new Map();
    cmds.forEach((c, i) => {
      const k = keyOf(c);
      const id = k !== null ? this.nodeOfKey(k) : this.seed;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(i);
    });
    const out = new Array(cmds.length);
    await Promise.all([...groups].map(async ([id, idx]) => {
      const results = await Promise.all(idx.map((i) => this.pool.send(id, cmds[i])));
      results.forEach(({ reply }, j) => { try { out[idx[j]] = plain(reply); } catch (e) { out[idx[j]] = e; } });
    }));
    return out;
  }

  async ping() { await this.client.call('PING'); }

  /** Workbench / Shell connection to a node (the first master when none is given). */
  async openExtra(name, _database, node) {
    return this.connectNode(node || this.masterIds()[0] || this.seed, name);
  }

  async close() {
    for (const c of this.extras) c.destroy();
    this.extras.clear();
    this.pool.clients.clear();
    await this.client.close();
  }
}

module.exports = { ClusterConn, NodePool, slotOf, crc16, keyOf, redirect };
