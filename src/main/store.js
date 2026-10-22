// Saved connections and query history, kept in the app's userData folder.
// Passwords are encrypted with the OS keychain (Windows DPAPI) via safeStorage.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const file = (name) => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}

function encrypt(pw) {
  if (!pw) return { pw: '' };
  if (safeStorage.isEncryptionAvailable()) return { pwEnc: safeStorage.encryptString(pw).toString('base64') };
  // No OS keychain available: never write the password in plain text; the app will ask for it.
  return { pw: '' };
}
function decrypt(c) {
  if (c.pwEnc) {
    try { return safeStorage.decryptString(Buffer.from(c.pwEnc, 'base64')); } catch { return ''; }
  }
  return c.pw || '';
}

const connections = {
  list() {
    // Never send passwords to the renderer.
    return readJson('connections.json', []).map(({ pw, pwEnc, ...rest }) => ({ ...rest, hasPassword: !!(pw || pwEnc) }));
  },
  get(id) {
    const c = readJson('connections.json', []).find((x) => x.id === id);
    if (!c) return null;
    const { pw, pwEnc, ...rest } = c;
    return { ...rest, password: decrypt(c) };
  },
  save(conn) {
    const all = readJson('connections.json', []);
    const id = conn.id || crypto.randomUUID();
    const idx = all.findIndex((x) => x.id === id);
    const prev = idx >= 0 ? all[idx] : {};
    const { password, keepPassword, hasPassword, ...fields } = conn;
    let secret;
    if (keepPassword && idx >= 0) secret = prev.pwEnc ? { pwEnc: prev.pwEnc } : { pw: prev.pw || '' };
    else secret = conn.savePassword === false ? { pw: '' } : encrypt(password || '');
    const rec = { ...fields, id, ...secret, updatedAt: Date.now() };
    if (idx >= 0) all[idx] = rec; else all.push(rec);
    writeJson('connections.json', all);
    return id;
  },
  remove(id) {
    writeJson('connections.json', readJson('connections.json', []).filter((x) => x.id !== id));
  },
  /** Puts the saved connections in the given order; any id not in the list keeps its place at the end. */
  reorder(ids) {
    const all = readJson('connections.json', []);
    const pos = new Map((Array.isArray(ids) ? ids : []).map((id, i) => [id, i]));
    const rank = (c) => (pos.has(c.id) ? pos.get(c.id) : Infinity);
    writeJson('connections.json', all.map((c, i) => [c, i]).sort((a, b) => (rank(a[0]) - rank(b[0])) || (a[1] - b[1])).map(([c]) => c));
  },
};

const history = {
  list(connId) {
    return readJson('history.json', []).filter((h) => !connId || h.connId === connId).slice(0, 200);
  },
  add(connId, sql) {
    const all = readJson('history.json', []);
    if (all[0] && all[0].sql === sql && all[0].connId === connId) return;
    all.unshift({ connId, sql, at: Date.now() });
    writeJson('history.json', all.slice(0, 1000));
  },
};

// The Persisted Queries tab of each connection: its text and how it looked (cursor, scroll, zoom, row
// limit, editor height), and whether it was open. Kept until the connection is deleted.
const persisted = {
  get(connId) {
    return readJson('persisted-queries.json', {})[connId] || null;
  },
  set(connId, state) {
    if (!connId) return;
    const all = readJson('persisted-queries.json', {});
    all[connId] = { ...state, updatedAt: Date.now() };
    writeJson('persisted-queries.json', all);
  },
  remove(connId) {
    const all = readJson('persisted-queries.json', {});
    if (!(connId in all)) return;
    delete all[connId];
    writeJson('persisted-queries.json', all);
  },
};

module.exports = { connections, history, persisted };
