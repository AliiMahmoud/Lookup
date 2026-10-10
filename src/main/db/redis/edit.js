// Changing keys from the key tabs: the window sends the commands it built (shown to the user first),
// and they run here inside MULTI / EXEC after checking that each one is an editing command on that
// key. Also time to live, rename, delete and new keys. Read-only and Production rules apply (guard.js).
const { Cmd, Pipe, commandText } = require('./connect');
const { inp, out, sameBytes } = require('./values');
const { guard } = require('./guard');

// Commands a key tab may send, all with the key as their first argument.
const EDITS = new Set(['SET', 'HSET', 'HDEL', 'LSET', 'LREM', 'RPUSH', 'LPUSH', 'SADD', 'SREM', 'ZADD', 'ZREM', 'XADD', 'XDEL', 'JSON.SET', 'PEXPIRE', 'PERSIST']);

async function apply(s, _ctx, { key, commands, confirmed }) {
  if (!Array.isArray(commands) || !commands.length) return { applied: 0 };
  const k = inp(key);
  const cmds = commands.map((c) => {
    const name = String(c[0] || '').toUpperCase();
    if (!EDITS.has(name)) throw new Error(`${name} can't be used to edit a key here`);
    if (!c[1] || !sameBytes(c[1], k)) throw new Error('Each change must be for the key in this tab');
    return [name, k, ...c.slice(2).map((a) => (typeof a === 'number' ? String(a) : inp(a)))];
  });
  await guard(s, cmds, confirmed);
  if (cmds.length === 1) {
    await s.conn.execute(new Cmd(cmds[0]));
    return { applied: 1 };
  }
  // All or nothing: MULTI … EXEC. A command the server refuses while queueing aborts the whole EXEC.
  const r = await s.conn.execute(new Pipe([['MULTI'], ...cmds, ['EXEC']], ['MULTI', ...cmds.map(commandText), 'EXEC'].join('\n')));
  const failed = r.slice(0, -1).find((x) => x instanceof Error);
  if (failed) throw failed;
  const exec = r[r.length - 1];
  if (exec instanceof Error) throw exec;
  const inner = Array.isArray(exec) ? exec.find((x) => x instanceof Error) : null;
  if (inner) throw inner;
  return { applied: cmds.length };
}

/** seconds > 0 sets a time to live; null / 0 removes the expiry. */
async function setTtl(s, _ctx, { key, seconds, confirmed }) {
  const k = inp(key);
  const n = Math.round(Number(seconds));
  const cmd = n > 0 ? ['EXPIRE', k, n] : ['PERSIST', k];
  await guard(s, [cmd], confirmed);
  await s.conn.execute(new Cmd(cmd));
  return { ttl: await s.conn.execute(new Cmd(['PTTL', k])) };
}

async function rename(s, _ctx, { key, to, confirmed }) {
  const cmd = ['RENAMENX', inp(key), inp(to)];
  if (!cmd[2].length) throw new Error('Enter the new name');
  await guard(s, [cmd], confirmed);
  const done = await s.conn.execute(new Cmd(cmd));
  if (!done) throw new Error(`A key named ${typeof to === 'string' ? to : 'like that'} already exists`);
  return { key: out(inp(to)) };
}

async function remove(s, _ctx, { keys, confirmed }) {
  const list = (keys || []).map(inp);
  if (!list.length) return { removed: 0 };
  await guard(s, [['DEL', ...list]], confirmed);
  if (s.conn.cluster && list.length > 1) {
    // Keys in different slots can't go in one command on a cluster: one UNLINK per key, per node.
    const r = await s.conn.execute(new Pipe(list.map((k) => ['UNLINK', k]), `UNLINK × ${list.length} keys (one per key)`));
    const err = r.find((x) => x instanceof Error);
    if (err) throw err;
    return { removed: r.reduce((a, b) => a + b, 0) };
  }
  let n;
  try { n = await s.conn.execute(new Cmd(['UNLINK', ...list])); } catch (e) {
    if (!/unknown command/i.test(e.message)) throw e;
    n = await s.conn.execute(new Cmd(['DEL', ...list])); // Redis before 4.0
  }
  return { removed: n };
}

/** A new key with a first value: { key, type, value | field+value | member(+score) | fields, ttl }. */
async function create(s, _ctx, p) {
  const k = inp(p.key);
  if (!k.length) throw new Error('Enter a key name');
  if (await s.conn.execute(new Cmd(['EXISTS', k]))) throw new Error('A key with this name already exists');
  const v = (x) => inp(x);
  let cmd;
  switch (p.type) {
    case 'string': cmd = ['SET', k, v(p.value), 'NX']; break;
    case 'hash': cmd = ['HSET', k, v(p.field), v(p.value)]; break;
    case 'list': cmd = ['RPUSH', k, v(p.value)]; break;
    case 'set': cmd = ['SADD', k, v(p.member)]; break;
    case 'zset': {
      if (!Number.isFinite(Number(p.score))) throw new Error('The score must be a number');
      cmd = ['ZADD', k, String(Number(p.score)), v(p.member)];
      break;
    }
    case 'stream': cmd = ['XADD', k, '*', v(p.field), v(p.value)]; break;
    case 'json': {
      try { JSON.parse(String(p.value)); } catch (e) { throw new Error(`The value is not valid JSON: ${e.message}`); }
      cmd = ['JSON.SET', k, '$', v(p.value), 'NX'];
      break;
    }
    default: throw new Error('Pick a key type');
  }
  const ttl = Math.round(Number(p.ttl)) || 0;
  const cmds = ttl > 0 ? [cmd, ['EXPIRE', k, ttl]] : [cmd];
  await guard(s, cmds, p.confirmed);
  if (cmds.length === 1) await s.conn.execute(new Cmd(cmd));
  else {
    const r = await s.conn.execute(new Pipe([['MULTI'], ...cmds, ['EXEC']], ['MULTI', ...cmds.map(commandText), 'EXEC'].join('\n')));
    const err = r.find((x) => x instanceof Error) || (Array.isArray(r[r.length - 1]) ? r[r.length - 1].find((x) => x instanceof Error) : null);
    if (err) throw err;
  }
  return { key: out(k) };
}

module.exports = { apply, setTtl, rename, remove, create, EDITS };
