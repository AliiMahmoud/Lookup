// Import / export of saved connections in Oracle SQL Developer's format, so connections move both
// ways between the two tools. Import reads SQL Developer's XML export (<References>) and its newer
// JSON export (same fields); export writes the XML. SQL Developer's own passwords can't be read (they
// are encrypted with a key tied to its installation). Lookup can include passwords when exporting,
// locked with a password chosen for the file (LookupPassword field); SQL Developer ignores them.
(function () {
  const { h, icon, toast, modal } = window.U;
  const api = window.api;
  const Lookup = window.Lookup;
  const { S, ENVS } = Lookup;

  // ---------- reading ----------
  /** Parses a SQL Developer export (XML or JSON) into [{ name, info }] where info maps field -> value. */
  function readSqlDevFile(text) {
    const t = String(text || '').replace(/^﻿/, '').trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      const json = JSON.parse(t);
      const list = Array.isArray(json) ? json : json.connections || [];
      return list.map((c) => ({ name: c.name || (c.info && c.info.ConnName) || '', info: c.info || c }));
    }
    const doc = new DOMParser().parseFromString(t, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This file is not valid XML.');
    const refs = [...doc.getElementsByTagNameNS('*', 'Reference')];
    if (!refs.length) throw new Error('No connections found. Expected an Oracle SQL Developer connections export (<References> … <Reference>).');
    return refs.map((ref) => {
      const info = {};
      for (const a of ref.getElementsByTagNameNS('*', 'StringRefAddr')) {
        const c = a.getElementsByTagNameNS('*', 'Contents')[0];
        info[a.getAttribute('addrType')] = c ? c.textContent : '';
      }
      return { name: ref.getAttribute('name') || info.ConnName || '', info };
    });
  }

  const isTrue = (v) => /^(true|yes|1)$/i.test(String(v || ''));
  const ROLES = { SYSDBA: 'SYSDBA', SYSOPER: 'SYSOPER', SYSBACKUP: 'SYSBACKUP' };

  /** One SQL Developer connection -> a Lookup connection, or { skip: reason }. */
  function toLookup({ name, info }) {
    const type = info.RaptorConnectionType || info.type;
    // PostgreSQL / MySQL connections written by Lookup (LookupEngine), and SQL Developer's own MySQL ones.
    const engine = info.LookupEngine || (/^mysql$/i.test(type || '') ? 'mysql' : null);
    if (engine === 'sqlite') {
      if (!info.LookupFile) return { name, skip: 'no database file' };
      return { engine, name: name || info.ConnName || '', env: ENVS[info.LookupEnv] ? info.LookupEnv : 'none', file: info.LookupFile, readOnly: isTrue(info.LookupReadOnly), autoCommit: false, savePassword: false, mode: 'basic' };
    }
    if (engine === 'postgres' || engine === 'mysql' || engine === 'clickhouse' || engine === 'redis' || engine === 'mongodb') {
      if (!info.hostname && !info.LookupUrl) return { name, skip: 'no host' };
      const c = {
        engine, name: name || info.ConnName || '', env: ENVS[info.LookupEnv] ? info.LookupEnv : 'none', user: info.user || '', autoCommit: false,
        ssl: info.LookupSsl || (engine === 'redis' || engine === 'clickhouse' ? 'disable' : 'prefer'), database: info.LookupDatabase || info.database || '',
      };
      if (engine === 'redis') { c.autoCommit = true; c.database = Number(c.database) || 0; c.readOnly = isTrue(info.LookupReadOnly); }
      if (engine === 'mongodb') {
        c.autoCommit = true;
        c.readOnly = isTrue(info.LookupReadOnly);
        // MongoDB's own settings travel as one JSON field.
        try { Object.assign(c, JSON.parse(info.LookupMongo || '{}')); } catch { /* ignore a broken field */ }
      }
      if (info.LookupPassword) c.sealedPassword = info.LookupPassword;
      if (info.LookupUrl) return { ...c, mode: 'string', connectString: info.LookupUrl };
      return { ...c, mode: 'basic', host: info.hostname, port: Number(info.port) || Lookup.ENGINES[engine].port };
    }
    if (type && !/^oracle$/i.test(type)) return { name, skip: `${type} connection (Lookup supports Oracle, PostgreSQL and MySQL)` };
    if (isTrue(info.OS_AUTHENTICATION)) return { name, skip: 'uses OS authentication' };
    if (isTrue(info.KERBEROS_AUTHENTICATION)) return { name, skip: 'uses Kerberos' };
    const base = {
      name: name || info.ConnName || '',
      env: ENVS[info.LookupEnv] ? info.LookupEnv : 'none',
      user: info.user || '',
      role: ROLES[String(info.role || '').toUpperCase()] || 'DEFAULT',
      autoCommit: false,
    };
    if (info.LookupPassword) base.sealedPassword = info.LookupPassword;
    if (info.hostname) {
      const sid = !info.serviceName && info.sid;
      return { ...base, mode: 'basic', host: info.hostname, port: Number(info.port) || 1521, serviceType: sid ? 'sid' : 'service', service: sid || info.serviceName || '' };
    }
    if (info.customUrl) {
      const cs = String(info.customUrl).replace(/^jdbc:oracle:thin:@/i, '').replace(/^\/\//, '').trim();
      if (cs) return { ...base, mode: 'string', connectString: cs };
    }
    if (info.tnsalias || info.TNSAlias) return { name, skip: `TNS alias "${info.tnsalias || info.TNSAlias}" (needs tnsnames.ora; recreate it with a connect string)` };
    return { name, skip: 'no host or connect string' };
  }

  // Same rule as the main process: one login on one database.
  function loginKey(c) {
    if (c.engine === 'sqlite') return `sqlite|${c.file}`;
    if (c.engine && c.engine !== 'oracle') {
      return `${c.engine}|${c.mode === 'string' ? c.connectString : `${String(c.host || '').toLowerCase()}:${c.port}/${c.database || ''}`}|${c.user || ''}`;
    }
    const target = c.mode === 'string'
      ? String(c.connectString || '').replace(/\s+/g, '').toLowerCase()
      : `${String(c.host || 'localhost').toLowerCase()}:${c.port || 1521}/${String(c.service || '').toLowerCase()}/${c.serviceType || 'service'}`;
    return `${target}|${String(c.user || '').toUpperCase()}|${c.role || 'DEFAULT'}`;
  }
  const describe = (c) => {
    if (c.engine && c.engine !== 'oracle') return `${Lookup.ENGINES[c.engine].label} · ${c.mode === 'string' && !Lookup.ENGINES[c.engine].file ? c.connectString : Lookup.target(c)}`;
    return c.mode === 'string' ? `${c.user} · ${c.connectString}` : `${c.user}@${c.host}:${c.port}/${c.service}${c.serviceType === 'sid' ? ' (SID)' : ''}`;
  };

  // ---------- writing ----------
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  function toSqlDevXml(conns, sealed = {}) {
    const ref = (c) => {
      const f = c.engine && c.engine !== 'oracle' ? otherFields(c, sealed) : [
        ['ConnName', c.name || c.user],
        ['RaptorConnectionType', 'Oracle'], ['subtype', 'oraJDBC'], ['oraDriverType', 'thin'], ['driver', 'oracle.jdbc.OracleDriver'],
        ['user', c.user || ''],
        ...(c.mode === 'string'
          ? [['customUrl', 'jdbc:oracle:thin:@' + (/^\s*\(/.test(c.connectString || '') ? c.connectString : '//' + (c.connectString || ''))]]
          : [['hostname', c.host || 'localhost'], ['port', String(c.port || 1521)], [c.serviceType === 'sid' ? 'sid' : 'serviceName', c.service || '']]),
        ...(c.role && c.role !== 'DEFAULT' ? [['role', c.role.toLowerCase()]] : []),
        ['SavePassword', 'false'], ['OS_AUTHENTICATION', 'false'], ['KERBEROS_AUTHENTICATION', 'false'],
        ...(c.env && c.env !== 'none' ? [['LookupEnv', c.env]] : []), // Lookup's colour tag; SQL Developer ignores it
        ...(sealed[c.id] ? [['LookupPassword', sealed[c.id]]] : []), // locked with the file password; Lookup only
      ];
      return `   <Reference name="${esc(c.name || c.user)}" className="oracle.jdeveloper.db.adapter.DatabaseProvider" xmlns="">\n`
        + '      <Factory className="oracle.jdeveloper.db.adapter.DatabaseProviderFactory1212"/>\n      <RefAddresses>\n'
        + f.map(([k, v]) => `         <StringRefAddr addrType="${esc(k)}">\n            <Contents>${esc(v)}</Contents>\n         </StringRefAddr>\n`).join('')
        + '      </RefAddresses>\n   </Reference>\n';
    };
    return `<?xml version = '1.0' encoding = 'UTF-8'?>\n<References xmlns="http://xmlns.oracle.com/adf/jndi">\n${conns.map(ref).join('')}</References>\n`;
  }

  // PostgreSQL / MySQL: SQL Developer can't open these; the Lookup* fields carry them to another Lookup.
  function otherFields(c, sealed) {
    if (c.engine === 'sqlite') {
      return [['ConnName', c.name || 'SQLite'], ['RaptorConnectionType', 'SQLite'], ['LookupEngine', 'sqlite'], ['LookupFile', c.file || ''],
        ...(c.readOnly ? [['LookupReadOnly', 'true']] : []),
      ...(c.engine === 'mongodb' ? [['LookupMongo', JSON.stringify({ srv: !!c.srv, authMechanism: c.authMechanism || 'DEFAULT', authSource: c.authSource || '', replicaSet: c.replicaSet || '', readPreference: c.readPreference || 'primary', tlsCAFile: c.tlsCAFile || '', tlsCertificateKeyFile: c.tlsCertificateKeyFile || '' })]] : []), ...(c.env && c.env !== 'none' ? [['LookupEnv', c.env]] : [])];
    }
    return [
      ['ConnName', c.name || c.user],
      ['RaptorConnectionType', Lookup.ENGINES[c.engine].label],
      ['LookupEngine', c.engine],
      ['user', c.user || ''],
      ...(c.mode === 'string' ? [['LookupUrl', c.connectString || '']] : [['hostname', c.host || 'localhost'], ['port', String(c.port || Lookup.ENGINES[c.engine].port)]]),
      ...(c.database ? [['LookupDatabase', String(c.database)]] : []),
      ...(c.ssl ? [['LookupSsl', c.ssl]] : []),
      ...(c.readOnly ? [['LookupReadOnly', 'true']] : []),
      ['SavePassword', 'false'],
      ...(c.env && c.env !== 'none' ? [['LookupEnv', c.env]] : []),
      ...(sealed[c.id] ? [['LookupPassword', sealed[c.id]]] : []),
    ];
  }

  // ---------- UI ----------
  async function importConnections() {
    let file;
    try { file = await api.openConnectionsFile(); } catch (e) { toast(e.message, 'err'); return; }
    if (!file) return;
    let found;
    try { found = readSqlDevFile(file.text).map(toLookup); } catch (e) { toast(`Could not read ${file.name}: ${e.message}`, 'err', 6000); return; }
    if (!found.length) { toast(`No connections in ${file.name}`, 'info'); return; }
    const saved = new Set((S.connections || []).map(loginKey));
    const rows = found.map((c) => {
      const dup = !c.skip && saved.has(loginKey(c));
      const box = h('input', { type: 'checkbox', checked: !c.skip && !dup, disabled: !!c.skip });
      return { c, box, dup, el: h('label', { class: 'imp-row' + (c.skip ? ' skipped' : '') }, box,
        h('div', { class: 'imp-text' },
          h('div', { class: 'imp-name' }, c.name || '(unnamed)', c.env && c.env !== 'none' ? h('span', { class: 'env-tag', style: { '--c': ENVS[c.env].color } }, ENVS[c.env].label) : null),
          h('div', { class: 'imp-sub' }, c.skip ? `Skipped: ${c.skip}` : describe(c))),
        dup ? h('span', { class: 'imp-tag' }, 'already saved') : null) };
    });
    const importable = rows.filter((r) => !r.c.skip);
    // Passwords in the file (exported by Lookup) are locked with the file's password.
    const hasSealed = importable.some((r) => r.c.sealedPassword);
    const filePw = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'off' });
    const withPw = h('input', { type: 'checkbox', checked: true, onchange: () => { filePw.disabled = !withPw.checked; update(); } });
    const pwStatus = h('div', { class: 'cx-status' });
    filePw.addEventListener('input', () => { pwStatus.textContent = ''; update(); });
    const btnLabel = () => { const n = rows.filter((r) => r.box.checked).length; return n ? `Import ${n} connection${n === 1 ? '' : 's'}` : 'Import'; };
    let m;
    const update = () => {
      const b = m && [...m.box.querySelectorAll('.modal-foot .btn')].pop();
      if (b) { b.textContent = btnLabel(); b.disabled = !rows.some((r) => r.box.checked) || (hasSealed && withPw.checked && !filePw.value); }
    };
    rows.forEach((r) => r.box.addEventListener('change', update));
    m = modal({
      title: `Import connections from ${file.name}`,
      wide: true,
      body: h('div', null,
        h('p', { class: 'muted imp-note' }, [
          `${importable.filter((r) => !r.dup).length} new`,
          rows.some((r) => r.dup) ? `${rows.filter((r) => r.dup).length} already saved` : null,
          found.length > importable.length ? `${found.length - importable.length} skipped` : null,
          hasSealed ? `${importable.filter((r) => r.c.sealedPassword).length} with passwords` : null,
        ].filter(Boolean).join(', ') + (hasSealed ? '.' : ". Passwords aren't in SQL Developer files; you'll be asked once when you connect.")),
        h('div', { class: 'imp-list' }, rows.map((r) => r.el)),
        hasSealed ? h('div', { class: 'cx-box' },
          h('label', { class: 'check' }, withPw, h('span', null, 'Import passwords')),
          h('div', { class: 'cx-label' }, 'Enter the password used to secure the file'),
          filePw, pwStatus) : null),
      actions: [{ label: 'Cancel' }, {
        label: btnLabel(), kind: 'primary',
        onClick: async () => {
          const pick = rows.filter((r) => r.box.checked);
          if (!pick.length) return false;
          let passwords = {};
          if (hasSealed && withPw.checked) {
            const sealed = {};
            pick.forEach((r, i) => { if (r.c.sealedPassword) sealed[i] = r.c.sealedPassword; });
            try { passwords = await api.openPasswords(sealed, filePw.value); } catch (e) { pwStatus.textContent = e.message; filePw.focus(); filePw.select(); return false; }
          }
          let n = 0;
          for (const [i, { c }] of pick.entries()) {
            const conn = { ...c };
            delete conn.sealedPassword; // the locked copy is not stored
            try { await api.saveConnection({ ...conn, password: passwords[i] || '', savePassword: true }); n++; } catch (e) { toast(`${c.name}: ${e.message}`, 'err'); }
          }
          S.connections = await api.listConnections();
          Lookup.renderWelcome();
          toast(`Imported ${n} connection${n === 1 ? '' : 's'}`, 'ok');
          return true;
        },
      }],
    });
    update();
  }

  /** Export dialog: optionally include passwords, locked with a password chosen for the file. */
  function exportConnections() {
    const conns = S.connections || [];
    if (!conns.length) { toast('No saved connections to export', 'info'); return; }
    const anyPw = conns.some((c) => c.hasPassword);
    const include = h('input', { type: 'checkbox', checked: anyPw, disabled: !anyPw });
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'new-password' });
    const eye = h('button', { class: 'pw-eye', type: 'button', title: 'Show password', onclick: () => { pw.type = pw.type === 'password' ? 'text' : 'password'; eye.replaceChildren(icon(pw.type === 'password' ? 'eye' : 'eyeOff')); pw.focus(); } }, icon('eye'));
    const pwRow = h('div', { class: 'cx-pw' },
      h('div', { class: 'cx-label' }, 'Enter the password used to secure the file'),
      h('div', { class: 'pw-wrap' }, pw, eye));
    const status = h('div', { class: 'cx-status' });
    let m;
    const saveBtn = () => [...m.box.querySelectorAll('.modal-foot .btn')].pop();
    const update = () => {
      pwRow.classList.toggle('off', !include.checked);
      pw.disabled = !include.checked;
      if (m) saveBtn().disabled = include.checked && !pw.value;
    };
    include.addEventListener('change', () => { update(); if (include.checked) pw.focus(); });
    pw.addEventListener('input', update);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter' && pw.value) { e.preventDefault(); saveBtn().click(); } });
    m = modal({
      title: `Export ${conns.length} connection${conns.length === 1 ? '' : 's'}`,
      body: h('div', { class: 'cx-body' },
        h('label', { class: 'check' }, include, h('span', null, anyPw ? 'Include passwords' : 'Include passwords (no saved passwords)')),
        pwRow,
        h('p', { class: 'muted cx-note' }, 'Saved as Oracle SQL Developer XML. Passwords are encrypted with this password; Lookup asks for it on import. SQL Developer imports the connections without passwords.'
          + (conns.some((c) => c.engine && c.engine !== 'oracle') ? ' PostgreSQL, MySQL, SQLite, ClickHouse, Redis and MongoDB connections are included for Lookup; SQL Developer can\'t open them.' : '')),
        status),
      actions: [{ label: 'Cancel' }, {
        label: 'Save…', kind: 'primary',
        onClick: async () => {
          try {
            const sealed = include.checked ? await api.sealPasswords(pw.value) : {};
            const file = await api.saveConnectionsFile(toSqlDevXml(conns, sealed));
            if (!file) return false; // file dialog cancelled: keep this open
            const n = Object.keys(sealed).length;
            toast(`Exported ${conns.length} connection${conns.length === 1 ? '' : 's'}${include.checked ? ` with ${n} password${n === 1 ? '' : 's'}` : ' without passwords'}`, 'ok', 4000);
            return true;
          } catch (e) { status.textContent = e.message; return false; }
        },
      }],
    });
    m.box.classList.add('cx-dialog');
    update();
    setTimeout(() => (include.checked ? pw.focus() : null), 0);
  }

  Object.assign(Lookup, { importConnections, exportConnections, readSqlDevFile, toLookup, toSqlDevXml });
})();
