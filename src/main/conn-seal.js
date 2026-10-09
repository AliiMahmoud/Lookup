// Passwords in exported connection files, locked with a password the user chooses when exporting
// (AES-256-GCM, key from scrypt). Only Lookup can read them back; other tools ignore the field.
// Format of one sealed value: "lk1:<salt>:<iv>:<tag>:<ciphertext>" (base64 parts).
const crypto = require('crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const keyFor = (password, salt) => crypto.scryptSync(String(password), salt, 32, SCRYPT);

/** Seals each { id: plaintext } with one key per file (one salt), so exporting stays quick. */
function seal(passwords, filePassword) {
  if (!filePassword) throw new Error('Enter a password to secure the file.');
  const salt = crypto.randomBytes(16);
  const key = keyFor(filePassword, salt);
  const out = {};
  for (const [id, plain] of Object.entries(passwords)) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    out[id] = ['lk1', salt, iv, c.getAuthTag(), ct].map((x) => (typeof x === 'string' ? x : x.toString('base64'))).join(':');
  }
  return out;
}

/** Opens sealed values ({ key: "lk1:…" }); a wrong file password throws. */
function open(sealed, filePassword) {
  const keys = new Map();
  const out = {};
  for (const [k, v] of Object.entries(sealed)) {
    const [tagV, salt, iv, tag, ct] = String(v).split(':');
    if (tagV !== 'lk1' || !ct) throw new Error('This file has passwords in a format Lookup does not know.');
    if (!keys.has(salt)) keys.set(salt, keyFor(filePassword, Buffer.from(salt, 'base64')));
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', keys.get(salt), Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      out[k] = Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    } catch {
      throw new Error('Wrong password for this file.');
    }
  }
  return out;
}

module.exports = { seal, open };
