// Typed commands: the Workbench (one extra connection per session, on the browser's database) and
// Shell tabs (one connection each, like a redis-cli process: its own SELECT, MULTI, SUBSCRIBE, MONITOR).
// Replies keep their exact type so the window prints them the way redis-cli does.
// On a cluster the Workbench sends each command to its key's node (commands without a key: a node the
// user picks, or every master), and a Shell follows MOVED / ASK like redis-cli -c.
const { Cmd } = require('./connect');
const { inp, wire } = require('./values');
const { guard } = require('./guard');

const STREAMING = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR']);
const NOT_IN_WORKBENCH = {
  SELECT: 'The Workbench follows the database picked in the key browser. Use a Shell tab to SELECT another one.',
  QUIT: 'Use a Shell tab for QUIT.',
  RESET: 'Use a Shell tab for RESET.',
  HELLO: 'Use a Shell tab for HELLO.',
};

const argsOf = (args) => {
  if (!Array.isArray(args) || !args.length) throw new Error('Type a command');
  return args.map((a) => (typeof a === 'string' ? a : inp(a)));
};
const nameOf = (list) => String(Buffer.isBuffer(list[0]) ? list[0].toString('latin1') : list[0]).toUpperCase();

// ---------- Workbench ----------

async function workbenchClient(s) {
  if (s.wb && !s.wb.closed) return s.wb;
  s.wb = await s.conn.openExtra('lookup-workbench', s.conn.db);
  s.wbId = await s.wb.call('CLIENT', 'ID').catch(() => null);
  return s.wb;
}

/** The key a user's command works on (cluster routing), from the server's COMMAND INFO (cached):
 *  first-key position, a subcommand's own entry (OBJECT ENCODING), or COMMAND GETKEYS for commands
 *  whose keys move (EVAL, XREAD, ZUNION …). null = the command has no key. */
async function userKey(s, list) {
  const name = nameOf(list).toLowerCase();
  const specs = s.conn.keySpecs || (s.conn.keySpecs = new Map());
  const spec = async (n) => {
    if (specs.has(n)) return specs.get(n);
    let v = { first: 0, movable: false };
    try {
      const [row] = await s.conn.execute(new Cmd(['COMMAND', 'INFO', n]));
      if (row) v = { first: Number(row[3]) || 0, movable: (row[2] || []).map(String).includes('movablekeys') };
    } catch { /* not allowed: treat as keyless */ }
    specs.set(n, v);
    return v;
  };
  let sp = await spec(name);
  if (!sp.first && !sp.movable && list.length > 1 && typeof list[1] === 'string') {
    const sub = await spec(`${name}|${list[1].toLowerCase()}`);
    if (sub.first || sub.movable) sp = sub;
  }
  if (sp.movable) {
    try { const keys = await s.conn.execute(new Cmd(['COMMAND', 'GETKEYS', ...list])); return keys && keys.length ? keys[0] : null; } catch { return null; }
  }
  return sp.first > 0 && list.length > sp.first ? list[sp.first] : null;
}

/** Cluster Workbench: key's node, the picked node, or every master ({ replies: [{ node, reply }] }). */
async function clusterCommand(s, list, node) {
  const { NodePool } = require('./cluster');
  if (!s.wbPool) s.wbPool = new NodePool(s.conn, 'lookup-workbench');
  const pool = s.wbPool;
  const key = await userKey(s, list);
  const t0 = Date.now();
  if (key === null && node === 'all') {
    const replies = await Promise.all(s.conn.masterIds().map(async (id) => ({ node: id, reply: wire((await pool.send(id, list)).reply) })));
    return { replies, ms: Date.now() - t0 };
  }
  const id = key !== null ? s.conn.nodeOfKey(key) : node && node !== 'auto' && node !== 'all' ? node : s.conn.masterIds()[0];
  const r = await pool.send(id, list);
  return { reply: wire(r.reply), node: r.node, ms: Date.now() - t0 };
}

/** Runs one Workbench command: { args, node (cluster: for commands without a key), confirmed } -> { reply, ms }. */
async function command(s, _ctx, { args, node, confirmed }) {
  const list = argsOf(args);
  const name = nameOf(list);
  if (STREAMING.has(name)) throw new Error(`${name} keeps listening until stopped, so it runs in a Shell tab (Shell button in the title bar).`);
  if (NOT_IN_WORKBENCH[name]) throw new Error(NOT_IN_WORKBENCH[name]);
  await guard(s, [list], confirmed);
  if (s.conn.cluster) {
    s.wbBusy = true;
    s.wbStopped = false;
    try { return await clusterCommand(s, list, node); } catch (e) {
      if (s.wbStopped) return { reply: { t: 'error', v: 'Stopped. The server may still finish the command.' }, ms: 0, stopped: true };
      throw e;
    } finally { s.wbBusy = false; }
  }
  const c = await workbenchClient(s);
  s.wbBusy = true;
  s.wbStopped = false;
  const t0 = Date.now();
  try {
    const r = await c.send(list);
    return { reply: wire(r), ms: Date.now() - t0 };
  } catch (e) {
    if (s.wbStopped) return { reply: { t: 'error', v: 'Stopped. The server may still finish the command.' }, ms: Date.now() - t0, stopped: true };
    throw e;
  } finally {
    s.wbBusy = false;
  }
}

/** Stop in the Workbench: a blocking command (BLPOP …) is released with CLIENT UNBLOCK; anything
 *  else stops waiting and drops that connection (the next command opens a new one). */
async function stop(s) {
  if (s.conn.cluster) {
    if (!s.wbBusy || !s.wbPool) return { stopped: false };
    s.wbStopped = true;
    s.wbPool.destroy();
    s.wbPool = null;
    return { stopped: true };
  }
  if (!s.wbBusy || !s.wb) return { stopped: false };
  let released = 0;
  if (s.wbId !== null && s.wbId !== undefined) released = await s.conn.execute(new Cmd(['CLIENT', 'UNBLOCK', s.wbId, 'ERROR'])).catch(() => 0);
  if (!released) {
    s.wbStopped = true;
    s.wb.destroy();
    s.wb = null;
  }
  return { stopped: true };
}

// ---------- Shell ----------

const PUSH_BATCH_MS = 50;
const PUSH_MAX = 2000; // messages kept per batch; a flood beyond that is counted, not sent

function shellsOf(s) { return s.shells || (s.shells = new Map()); }

async function openShellClient(s, ctx, id, sh) {
  const c = await s.conn.openExtra('lookup-shell', sh.db, sh.node);
  sh.client = c;
  sh.tx = false;
  sh.streaming = false;
  sh.clientId = await c.call('CLIENT', 'ID').catch(() => null);
  c.on('push', (r) => {
    if (sh.pending.length < PUSH_MAX) sh.pending.push(wire(r, { items: 1000, bytes: 1 << 20 }));
    else sh.dropped++;
    if (!sh.timer) {
      sh.timer = setTimeout(() => {
        sh.timer = null;
        const replies = sh.pending.splice(0);
        const dropped = sh.dropped;
        sh.dropped = 0;
        ctx.emit({ kind: 'shell-push', id, replies, dropped });
      }, PUSH_BATCH_MS);
    }
  });
  c.once('close', (err) => {
    if (sh.client !== c || sh.closing) return;
    sh.client = null;
    ctx.emit({ kind: 'shell-closed', id, message: err ? err.message : 'Connection closed' });
  });
  return c;
}

/** A new Shell tab: its own connection on the browser's database. Returns where it is connected. */
async function shellOpen(s, ctx, { id, db }) {
  const shells = shellsOf(s);
  if (shells.has(id)) await shellClose(s, ctx, { id });
  // A cluster Shell starts on the first master and moves with redirects (redis-cli -c).
  const sh = { db: Number.isInteger(db) ? db : s.conn.db, pending: [], dropped: 0, timer: null, client: null, node: s.conn.cluster ? s.conn.masterIds()[0] : null };
  shells.set(id, sh);
  await openShellClient(s, ctx, id, sh);
  return { ...where(s, sh), db: sh.db, tls: s.conn.t.tls, cluster: !!s.conn.cluster };
}

/** host and port the prompt shows: the node a cluster Shell is on, else the server. */
function where(s, sh) {
  if (!sh.node) return { host: s.conn.t.host, port: s.conn.t.port };
  const i = sh.node.lastIndexOf(':');
  return { host: sh.node.slice(0, i), port: Number(sh.node.slice(i + 1)) };
}

/** Runs one Shell command: { id, args, confirmed } -> { reply, ms, db, tx } or { streaming: true }. */
async function shellRun(s, ctx, { id, args, confirmed }) {
  const sh = shellsOf(s).get(id);
  if (!sh) throw new Error('This Shell is closed');
  const list = argsOf(args);
  const name = nameOf(list);
  await guard(s, [list], confirmed);
  let reconnected = false;
  if (!sh.client || sh.client.closed) { await openShellClient(s, ctx, id, sh); reconnected = true; } // like redis-cli: reconnect on the next command
  if (STREAMING.has(name)) {
    sh.streaming = true;
    sh.client.sendStreaming(list);
    return { streaming: true, db: sh.db, tx: sh.tx, reconnected, ...where(s, sh) };
  }
  const t0 = Date.now();
  sh.busy = true;
  let r;
  const redirects = [];
  try {
    r = await sh.client.send(list);
    // Cluster: follow MOVED / ASK to the node holding the slot, printing what redis-cli -c prints.
    const { redirect } = require('./cluster');
    for (let hop = 0; s.conn.cluster && hop < 5; hop++) {
      const to = redirect(r);
      if (!to) break;
      redirects.push(`-> Redirected to slot [${to.slot}] located at ${to.addr}`);
      const old = sh.client;
      sh.client = null; // its close event is then ignored
      if (old) old.destroy();
      sh.node = to.addr;
      await openShellClient(s, ctx, id, sh);
      if (to.kind === 'ASK') await sh.client.send(['ASKING']);
      r = await sh.client.send(list);
    }
  } finally { sh.busy = false; }
  if (r.t !== 'error') {
    if (name === 'SELECT') sh.db = Number(String(list[1]));
    if (name === 'MULTI') sh.tx = true;
    if (name === 'RESET') { sh.db = 0; sh.tx = false; }
  }
  if (name === 'EXEC' || name === 'DISCARD') sh.tx = false;
  return { reply: wire(r), ms: Date.now() - t0, db: sh.db, tx: sh.tx, reconnected, redirects, ...where(s, sh) };
}

/** Ctrl+C: leaves SUBSCRIBE / MONITOR or a blocking command by replacing the connection. */
async function shellStop(s, ctx, { id }) {
  const sh = shellsOf(s).get(id);
  if (!sh) return { db: 0 };
  const old = sh.client;
  sh.client = null; // its close event is then ignored
  if (old) old.destroy();
  clearTimeout(sh.timer);
  sh.timer = null;
  sh.pending = [];
  await openShellClient(s, ctx, id, sh);
  return { db: sh.db, tx: false, ...where(s, sh) };
}

async function shellClose(s, _ctx, { id }) {
  const sh = shellsOf(s).get(id);
  if (!sh) return;
  shellsOf(s).delete(id);
  sh.closing = true;
  clearTimeout(sh.timer);
  if (sh.client) sh.client.destroy();
}

module.exports = { command, stop, shellOpen, shellRun, shellStop, shellClose, STREAMING };
