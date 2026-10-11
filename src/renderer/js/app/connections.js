// Welcome screen: saved connections list, the connection form, and connecting (password prompt, Cancel).
(function () {
  const { h, icon, toast, modal, confirmBox, contextMenu } = window.U;
  const api = window.api;
  const $ = (sel, root = document) => root.querySelector(sel);
  const Lookup = window.Lookup;
  const { ENVS, S } = Lookup;

  // ---------- Welcome / connection manager ----------
  function blankConn(engine = 'oracle') {
    const base = { id: null, name: '', env: 'none', mode: 'basic', host: 'localhost', user: '', password: '', savePassword: true, autoCommit: false, connectString: '' };
    if (engine === 'oracle') return { ...base, engine, port: 1521, serviceType: 'service', service: 'FREEPDB1', role: 'DEFAULT' };
    if (engine === 'sqlite') return { id: null, name: '', env: 'none', engine, file: '', readOnly: false, autoCommit: false, savePassword: false };
    if (engine === 'clickhouse') return { ...base, engine, port: 8123, database: 'default', user: 'default', ssl: 'disable', autoCommit: true };
    if (engine === 'mongodb') return { ...base, engine, port: 27017, database: '', srv: false, ssl: 'disable', authMechanism: 'DEFAULT', authSource: '', replicaSet: '', readPreference: 'primary', readOnly: false, autoCommit: true };
    if (engine === 'redis') return { ...base, engine, port: 6379, database: 0, ssl: 'disable', readOnly: false, autoCommit: true };
    return { ...base, engine, port: Lookup.ENGINES[engine].port, database: engine === 'postgres' ? 'postgres' : '', ssl: 'prefer' };
  }
  async function showWelcome() {
    S.connections = await api.listConnections();
    // The saved panel width lives in settings.json, so every tab and window gets the same one.
    try { const pw = await api.welcomeWidth(); if (pw) document.documentElement.style.setProperty('--welcome-w', pw + 'px'); } catch { /* keep the current width */ }
    $('#workspace').classList.add('hidden');
    const w = $('#welcome');
    w.classList.remove('hidden');
    Lookup.renderTitlebar();
    Lookup.renderStatus();
    renderWelcome();
  }
  function renderWelcome() {
    const w = $('#welcome');
    w.innerHTML = '';
    const search = h('input', { class: 'input', placeholder: 'Search connections', oninput: () => paintList() });
    const list = h('div', { class: 'conn-list' });
    // Drag a connection onto another to move it above or below (the half of the row under the pointer decides).
    let dragId = null;
    const clearDrop = () => list.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    const dropAfter = (e) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
    const moveConn = async (id, targetId, after) => {
      const from = S.connections.findIndex((x) => x.id === id);
      if (from < 0 || id === targetId) return;
      const [moved] = S.connections.splice(from, 1);
      const to = S.connections.findIndex((x) => x.id === targetId);
      S.connections.splice(to < 0 ? S.connections.length : to + (after ? 1 : 0), 0, moved);
      paintList();
      try { await api.reorderConnections(S.connections.map((x) => x.id)); } catch (e) { toast(e.message, 'err'); }
    };
    const paintList = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      const items = S.connections.filter((c) => !q || `${c.name} ${c.user} ${c.host} ${c.service || ''} ${c.database || ''} ${Lookup.engineOf(c).label}`.toLowerCase().includes(q));
      if (!items.length) list.append(h('div', { class: 'empty-small' }, S.connections.length ? 'No matches' : 'No saved connections yet'));
      items.forEach((c) => {
        const env = ENVS[c.env || 'none'];
        list.append(h('div', {
          class: 'conn-item' + (S.selectedConn && S.selectedConn.id === c.id ? ' sel' : ''),
          ondblclick: () => connectTo(c.id),
          draggable: 'true',
          ondragstart: (e) => { dragId = c.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.name || ''); e.currentTarget.classList.add('dragging'); },
          ondragend: (e) => { dragId = null; e.currentTarget.classList.remove('dragging'); clearDrop(); },
          ondragover: (e) => {
            if (!dragId || dragId === c.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const after = dropAfter(e);
            if (e.currentTarget.classList.contains(after ? 'drop-after' : 'drop-before')) return;
            clearDrop();
            e.currentTarget.classList.add(after ? 'drop-after' : 'drop-before');
          },
          ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop-before', 'drop-after'); },
          ondrop: (e) => { if (!dragId || dragId === c.id) return; e.preventDefault(); const id = dragId; dragId = null; moveConn(id, c.id, dropAfter(e)); },
          oncontextmenu: (e) => {
            e.preventDefault();
            contextMenu(e.clientX, e.clientY, [
              { label: 'Connect', icon: 'plug', onClick: () => connectTo(c.id) },
              { label: 'Connect in a new tab', icon: 'window', onClick: () => (api.openConnection ? api.openConnection(c.id) : api.newWindow()) },
              { label: 'Edit', icon: 'edit', onClick: () => { S.selectedConn = { ...c, keepPassword: true, password: '' }; renderWelcome(); } },
              { label: 'Duplicate', icon: 'copy', onClick: () => { S.selectedConn = { ...c, id: null, name: c.name + ' copy', password: '', keepPassword: false }; renderWelcome(); } },
              '-',
              { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteConn(c) },
            ]);
          },
        },
        h('span', { class: 'conn-badge engine', style: { '--c': Lookup.engineOf(c).color }, title: Lookup.engineOf(c).label }, Lookup.initials(c)),
        h('div', { class: 'conn-item-text' },
          h('div', { class: 'conn-item-name' }, c.name || '(unnamed)', c.env && c.env !== 'none' ? h('span', { class: 'env-tag', style: { '--c': env.color } }, env.label) : null),
          h('div', { class: 'conn-item-sub' }, Lookup.target(c)))));
      });
    };
    paintList();
    const left = h('div', { class: 'welcome-left' },
      h('div', { class: 'welcome-head' },
        h('div', null, h('h1', null, 'Connections'), h('p', { class: 'muted' }, 'Double-click to connect')),
        h('div', { class: 'welcome-actions' },
          h('button', { class: 'tool', title: 'Import connections from an Oracle SQL Developer export (.xml or .json)', onclick: () => Lookup.importConnections() }, icon('open')),
          h('button', { class: 'tool', title: 'Export connections for Oracle SQL Developer (.xml), optionally with passwords', disabled: !S.connections.length, onclick: () => Lookup.exportConnections() }, icon('download')),
          h('button', { class: 'btn primary sm', onclick: () => { S.selectedConn = { choosing: true }; renderWelcome(); } }, icon('plus'), 'New'))),
      search, list);
    // Drag the edge of the connections panel to change its width (remembered between runs).
    const rz = h('div', { class: 'sb-resizer', onmousedown: (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = left.getBoundingClientRect().width;
      document.body.classList.add('resizing');
      const move = (ev) => {
        const nw = Math.max(260, Math.min(720, innerWidth - 360, w0 + ev.clientX - x0));
        document.documentElement.style.setProperty('--welcome-w', nw + 'px');
      };
      const up = () => {
        document.body.classList.remove('resizing');
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        const saved = getComputedStyle(document.documentElement).getPropertyValue('--welcome-w');
        try { localStorage.setItem('lookup.welcomeW', saved); } catch { /* ignore */ }
        api.welcomeWidth(parseFloat(saved)).catch(() => {});
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    } });
    w.append(left, rz, S.selectedConn
      ? h('div', { class: 'welcome-right' }, S.selectedConn.choosing ? chooseEngine() : connForm(S.selectedConn))
      : h('div', { class: 'welcome-right welcome-empty' }, homeIntro()));
  }
  // New connection, step 1: which database (Oracle / PostgreSQL / MySQL). Double-click or Continue.
  function chooseEngine() {
    let picked = S.lastEngine || 'oracle';
    const cards = Object.values(Lookup.ENGINES).map((e) => h('button', {
      type: 'button', class: 'choose-card' + (e.id === picked ? ' on' : ''), style: { '--c': e.color }, 'data-engine': e.id,
      onclick: (ev) => { picked = e.id; ev.currentTarget.focus(); box.querySelectorAll('.choose-card').forEach((x) => x.classList.toggle('on', x === ev.currentTarget)); },
      ondblclick: () => go(e.id),
    }, h('span', { class: 'choose-logo' }, e.badge), h('span', { class: 'choose-name' }, e.label), h('span', { class: 'choose-blurb' }, e.blurb)));
    const go = (id) => { S.lastEngine = id; S.selectedConn = blankConn(id); renderWelcome(); };
    const box = h('div', { class: 'choose' },
      h('h2', null, 'New connection'),
      h('p', { class: 'muted choose-sub' }, 'Choose the database you want to connect to'),
      h('div', { class: 'choose-cards' }, cards),
      h('div', { class: 'choose-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => { S.selectedConn = null; renderWelcome(); } }, 'Cancel'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => go(picked) }, 'Continue')));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); S.selectedConn = null; renderWelcome(); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const all = [...box.querySelectorAll('.choose-card')];
        const i = all.findIndex((x) => x.classList.contains('on'));
        const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
        e.preventDefault();
        next.click();
      }
    });
    setTimeout(() => { const on = box.querySelector('.choose-card.on'); if (on) on.focus(); }, 0);
    return box;
  }
  // Right side before a connection is picked: the logo and the main shortcuts.
  function homeIntro() {
    const mod = S.platform === 'darwin' ? '⌘' : 'Ctrl';
    const row = (keys, label) => h('div', null, keys.map((k) => h('kbd', null, k)), h('span', null, label));
    return h('div', { class: 'empty-state home-intro' },
      h('div', { class: 'empty-mark' }),
      h('h2', null, 'Lookup'),
      h('p', { class: 'muted' }, S.connections.length ? 'Double-click a connection to connect, right-click to edit it' : 'Click New to add your first connection'),
      h('div', { class: 'shortcuts' },
        row(['Double-click'], 'Connect'),
        row(['Right-click'], 'Edit connection'),
        row([mod, 'N'], 'Open a connection'),
        row([mod, 'T'], 'New query'),
        row([mod, 'P'], 'Open anything'),
        row([mod, 'Enter'], 'Run statement'),
        row([mod, 'S'], 'Commit'),
        row([mod, 'B'], 'Beautify SQL'),
        row([mod, 'R'], 'Reconnect')));
  }
  async function deleteConn(c) {
    if (!(await confirmBox('Delete connection', `Delete "${c.name || c.user}"? This only removes it from Lookup.`, 'Delete', true))) return;
    await api.deleteConnection(c.id);
    S.connections = await api.listConnections();
    if (S.selectedConn && S.selectedConn.id === c.id) S.selectedConn = null;
    renderWelcome();
    Lookup.renderStatus();
  }
  function field(label, control, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
  }
  function connForm(c) {
    const engine = Lookup.engineOf(c);
    const f = { ...blankConn(engine.id), ...c, engine: engine.id };
    for (const k of ['mode', 'serviceType', 'role', 'ssl']) if (!f[k] && blankConn(engine.id)[k]) f[k] = blankConn(engine.id)[k];
    if (f.savePassword === undefined) f.savePassword = true;
    const oracle = engine.id === 'oracle';
    const fileBased = !!engine.file; // SQLite: a file instead of host and login
    const redis = engine.id === 'redis';
    const mongo = engine.id === 'mongodb';
    const noTx = engine.id === 'clickhouse' || redis || mongo; // no transactions: auto-commit is always on
    const inp = (key, attrs = {}) => {
      const el = h('input', { class: 'input', ...attrs, oninput: (e) => { f[key] = attrs.type === 'number' ? Number(e.target.value) : e.target.value; } });
      el.value = f[key] ?? '';
      return el;
    };
    const sel = (key, options, onchange) => {
      const el = h('select', { class: 'input', onchange: (e) => { f[key] = e.target.value; onchange && onchange(); } },
        options.map(([v, l]) => h('option', { value: v }, l)));
      el.value = f[key];
      return el;
    };
    const chk = (key, label) => {
      const el = h('input', { type: 'checkbox', onchange: (e) => { f[key] = e.target.checked; } });
      el.checked = !!f[key];
      return h('label', { class: 'check' }, el, h('span', null, label));
    };

    // Type: switching keeps name, tag, host and login; the port follows the engine if it was the default.
    const switchEngine = (id) => {
      if (id === engine.id) return;
      const next = { ...blankConn(id), ...f, engine: id, mode: f.mode === 'string' ? 'basic' : f.mode };
      if (!f.port || Number(f.port) === engine.port) next.port = Lookup.ENGINES[id].port;
      for (const k of ['serviceType', 'service', 'role', 'database', 'ssl', 'file', 'readOnly', 'srv', 'authMechanism', 'authSource', 'replicaSet', 'readPreference']) if (!(k in blankConn(id))) delete next[k]; else if (next[k] === undefined || k === 'ssl') next[k] = blankConn(id)[k];
      next.connectString = '';
      S.selectedConn = { ...next, keepPassword: f.keepPassword, hasPassword: c.hasPassword };
      S.lastEngine = id;
      renderWelcome();
    };
    const typeRow = h('div', { class: 'type-row' }, Object.values(Lookup.ENGINES).map((e) => h('button', {
      type: 'button', class: 'type-chip' + (e.id === engine.id ? ' on' : ''), style: { '--c': e.color }, onclick: () => switchEngine(e.id),
    }, h('span', { class: 'type-dot' }, e.badge), e.label)));

    const envRow = h('div', { class: 'env-row' }, Object.entries(ENVS).map(([k, v]) => h('button', {
      type: 'button',
      class: 'env-chip' + (f.env === k ? ' on' : ''),
      style: { '--c': v.color },
      onclick: (e) => { f.env = k; envRow.querySelectorAll('.env-chip').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); },
    }, h('span', { class: 'dot', style: { background: v.color } }), v.label)));

    const sslOptions = engine.id === 'clickhouse'
      ? [['disable', 'Off (HTTP)'], ['require', 'HTTPS'], ['verify', 'HTTPS and verify certificate']]
      : redis ? [['disable', 'Off'], ['require', 'TLS'], ['verify', 'TLS and verify certificate']]
      : [['prefer', 'Prefer (SSL if the server has it)'], ['require', 'Require'], ['verify', 'Require and verify certificate'], ['disable', 'Off']];
    // ClickHouse: HTTPS uses port 8443 unless another port was typed.
    const sslChanged = () => {
      if (engine.id !== 'clickhouse') return;
      const tls = f.ssl !== 'disable';
      if (tls && Number(f.port) === 8123) f.port = 8443;
      if (!tls && Number(f.port) === 8443) f.port = 8123;
      const portInput = form.querySelector('input[type=number]');
      if (portInput) portInput.value = f.port;
    };
    const fileInput = fileBased ? inp('file', { placeholder: '/path/to/database.db', spellcheck: 'false' }) : null;
    const fileBox = fileBased ? h('div', null,
      field('Database file', h('div', { class: 'file-row' }, fileInput,
        h('button', { type: 'button', class: 'btn', onclick: async () => {
          try { const p = await api.pickSqliteFile(f.file); if (p) { f.file = p; fileInput.value = p; if (!f.name) { f.name = p.split(/[\\/]/).pop(); form.querySelector('input').value = f.name; } } } catch (e) { toast(e.message, 'err'); }
        } }, 'Open file…'),
        h('button', { type: 'button', class: 'btn', onclick: async () => {
          try { const p = await api.newSqliteFile(); if (p) { f.file = p; fileInput.value = p; toast('Created ' + p, 'ok'); } } catch (e) { toast(e.message, 'err'); }
        } }, 'New file…')),
      'Lookup opens the file directly; nothing to install.'),
      h('div', { class: 'checks-row' }, chk('readOnly', 'Open read-only (no changes can be saved)'))) : null;
    let mongoBox = null;
    let userPaint = null;
    const basic = oracle
      ? h('div', { class: 'grid2' },
        field('Host', inp('host', { placeholder: 'db.example.com' })),
        field('Port', inp('port', { type: 'number', placeholder: '1521' })),
        field('Connect by', sel('serviceType', [['service', 'Service name'], ['sid', 'SID']])),
        field('Service / SID', inp('service', { placeholder: 'ORCLPDB1' })))
      : h('div', { class: 'grid2' },
        field('Host', inp('host', { placeholder: 'db.example.com' })),
        field('Port', inp('port', { type: 'number', placeholder: String(engine.port) })),
        field(engine.id === 'clickhouse' ? 'Connection' : redis ? 'TLS' : 'SSL', sel('ssl', sslOptions, sslChanged)),
        field('Database', redis ? inp('database', { type: 'number', min: '0', placeholder: '0' })
          : inp('database', { placeholder: engine.id === 'postgres' ? 'postgres' : engine.id === 'clickhouse' ? 'default' : 'optional' })));
    // MongoDB: hosts (a list for a replica set), SRV, login type, TLS, replica set, read preference.
    if (mongo) {
      const urlPrev = h('div', { class: 'form-urlprev', title: 'The connection string Lookup builds (the password is never put in it)' });
      const paintUrl = () => {
        const hosts = String(f.host || 'localhost').split(/[\s,]+/).filter(Boolean).map((x) => (f.srv || /:\d+$/.test(x) ? x : `${x}:${f.port || 27017}`));
        const q = [f.authSource ? `authSource=${f.authSource}` : '', f.replicaSet ? `replicaSet=${f.replicaSet}` : '', f.readPreference && f.readPreference !== 'primary' ? `readPreference=${f.readPreference}` : '',
          f.ssl !== 'disable' ? 'tls=true' : '', f.authMechanism && !['DEFAULT', 'NONE'].includes(f.authMechanism) ? `authMechanism=${f.authMechanism}` : ''].filter(Boolean).join('&');
        urlPrev.textContent = `${f.srv ? 'mongodb+srv' : 'mongodb'}://${f.user && f.authMechanism !== 'NONE' ? encodeURIComponent(f.user) + '@' : ''}${hosts.join(',')}/${f.database || ''}${q ? '?' + q : ''}`;
      };
      const watch = (el) => { el.addEventListener('input', paintUrl); el.addEventListener('change', paintUrl); return el; };
      const srvSel = h('select', { class: 'input', onchange: (e) => { f.srv = e.target.value === 'srv'; if (f.srv && f.ssl === 'disable') { f.ssl = 'verify'; tlsSel.value = 'verify'; } paintUrl(); } },
        h('option', { value: 'std' }, 'Standard (host:port list)'), h('option', { value: 'srv' }, 'SRV record (mongodb+srv)'));
      srvSel.value = f.srv ? 'srv' : 'std';
      const tlsSel = watch(sel('ssl', [['disable', 'Off'], ['verify', 'On'], ['require', 'On, allow invalid certificates']]));
      const authSel = watch(sel('authMechanism', [['DEFAULT', 'Username / password'], ['SCRAM-SHA-256', 'SCRAM-SHA-256'], ['SCRAM-SHA-1', 'SCRAM-SHA-1'], ['PLAIN', 'LDAP (PLAIN)'], ['MONGODB-X509', 'X.509 certificate'], ['MONGODB-AWS', 'AWS IAM'], ['NONE', 'None']], () => { x509Row.classList.toggle('hidden', f.authMechanism !== 'MONGODB-X509'); }));
      const x509Row = h('div', { class: 'grid2' + (f.authMechanism === 'MONGODB-X509' ? '' : ' hidden') },
        field('Client certificate and key (PEM file)', inp('tlsCertificateKeyFile', { placeholder: '/path/to/client.pem', spellcheck: 'false' })),
        field('CA file (optional)', inp('tlsCAFile', { placeholder: '/path/to/ca.pem', spellcheck: 'false' })));
      mongoBox = h('div', { class: 'm-form' },
        h('div', { class: 'grid2' },
          field('Hosts', watch(inp('host', { placeholder: 'db1.example.com, db2.example.com:27018', spellcheck: 'false' })), 'One host, or several (a replica set) separated by commas.'),
          h('div', { class: 'grid2 tight' }, field('Port', watch(inp('port', { type: 'number', placeholder: '27017' }))), field('Connection', srvSel))),
        h('div', { class: 'grid2' },
          field('Default database', watch(inp('database', { placeholder: 'test', spellcheck: 'false' }))),
          field('Read preference', watch(sel('readPreference', [['primary', 'Primary'], ['primaryPreferred', 'Primary preferred'], ['secondary', 'Secondary'], ['secondaryPreferred', 'Secondary preferred'], ['nearest', 'Nearest']])))),
        h('div', { class: 'grid2' },
          field('Authentication', authSel),
          field('Auth database', watch(inp('authSource', { placeholder: 'admin', spellcheck: 'false' })))),
        x509Row,
        h('div', { class: 'grid2' }, field('TLS', tlsSel), field('Replica set', watch(inp('replicaSet', { placeholder: 'optional (found from the hosts)', spellcheck: 'false' })))),
        urlPrev);
      paintUrl();
      userPaint = paintUrl;
    }
    const str = oracle
      ? h('div', null, field('Connect string', inp('connectString', { placeholder: 'host:1521/service  or  (DESCRIPTION=…)' }), 'EZConnect or a full TNS descriptor.'))
      : h('div', null, field('URL', inp('connectString', { placeholder: engine.id === 'postgres' ? 'postgres://user@host:5432/database?sslmode=require' : engine.id === 'clickhouse' ? 'https://host:8443' : redis ? 'redis://user@host:6379/0  or  rediss:// for TLS' : mongo ? 'mongodb+srv://cluster0.example.mongodb.net/mydb  or  mongodb://host:27017/mydb' : 'mysql://user@host:3306/database' }),
        'User and password typed below are used instead of the ones in the URL.'));
    const modeBox = h('div');
    const paintMode = () => { modeBox.innerHTML = ''; modeBox.append(fileBased ? fileBox : f.mode === 'string' ? str : mongo ? mongoBox : basic); };
    paintMode();

    const pw = inp('password', { type: 'password', placeholder: c.keepPassword && c.hasPassword ? '•••••••• (saved)' : '' });
    pw.addEventListener('input', () => { f.keepPassword = false; });
    // Eye button: show / hide the password (loads the saved one on first click).
    const eye = h('button', { class: 'pw-eye', type: 'button', title: 'Show password' }, icon('eye'));
    eye.addEventListener('click', async () => {
      if (pw.type === 'password') {
        if (!pw.value && f.keepPassword && c.hasPassword && c.id) {
          try { pw.value = await api.revealPassword(c.id); } catch (e) { toast(e.message, 'err'); return; }
        }
        pw.type = 'text'; eye.title = 'Hide password'; eye.replaceChildren(icon('eyeOff'));
      } else {
        pw.type = 'password'; eye.title = 'Show password'; eye.replaceChildren(icon('eye'));
      }
      pw.focus();
    });
    const pwBox = h('div', { class: 'pw-wrap' }, pw, eye);

    const status = h('div', { class: 'form-status' });
    const collect = () => {
      if (fileBased) {
        const { id, name, env, file, readOnly, autoCommit } = f;
        return { id, name, env, engine: engine.id, file: String(file || '').trim(), readOnly: !!readOnly, autoCommit: !!autoCommit, savePassword: false, mode: 'basic' };
      }
      const out = { ...f, port: Number(f.port) || engine.port };
      if (oracle) { delete out.database; delete out.ssl; } else { delete out.service; delete out.serviceType; delete out.role; }
      if (noTx) out.autoCommit = true;
      if (redis) { out.database = Math.max(0, Math.floor(Number(f.database) || 0)); out.readOnly = !!f.readOnly; }
      else if (mongo) { out.readOnly = !!f.readOnly; out.srv = !!f.srv; out.host = String(f.host || '').trim(); }
      else delete out.readOnly;
      return out;
    };
    // While testing: every field and button is disabled and the form is dimmed (the status line stays readable).
    const busy = (b) => {
      form.classList.toggle('busy', b);
      form.querySelectorAll('button, input, select').forEach((x) => { x.disabled = b; });
    };

    const doTest = async () => {
      status.className = 'form-status';
      status.textContent = 'Testing…';
      busy(true);
      // Loader over the form side (right of the connections list) until the test answers; the list stays usable.
      const overlay = h('div', { class: 'connecting in-panel' }, h('div', { class: 'spinner' }), h('div', null, `Testing ${f.name ? `"${f.name}"` : 'the connection'}…`));
      const listPanel = $('#welcome .welcome-left');
      if (listPanel) overlay.style.left = listPanel.getBoundingClientRect().width + 'px';
      $('#welcome').append(overlay);
      try {
        const r = await api.testConnection(collect());
        status.className = 'form-status ok';
        const where = mongo ? `${r.topology}${r.atlas ? ' (Atlas)' : ''} · database ${r.dbName}` : redis ? r.dbName : oracle ? `schema ${r.schema}` : engine.id === 'postgres' ? `database ${r.dbName} · schema ${r.schema}` : fileBased ? r.dbName : r.dbName ? `database ${r.dbName}` : 'no default database';
        status.textContent = `Connected · ${r.product || engine.label} ${r.version} · ${where}`;
      } catch (e) {
        status.className = 'form-status err';
        status.textContent = e.message;
      } finally { overlay.remove(); busy(false); }
    };
    const doSave = async () => {
      const cfg = collect();
      if (fileBased && !cfg.file) { status.className = 'form-status err'; status.textContent = 'Choose a database file (Open file… or New file…).'; throw new Error('No file'); }
      if (!cfg.name) cfg.name = fileBased ? cfg.file.split(/[\\/]/).pop() : cfg.mode === 'string' ? cfg.user || engine.label : `${cfg.user || (redis ? 'default' : '')}@${cfg.host}`;
      const id = await api.saveConnection(cfg);
      S.connections = await api.listConnections();
      S.selectedConn = { ...S.connections.find((x) => x.id === id), keepPassword: true, password: '' };
      renderWelcome();
      Lookup.renderStatus();
      toast('Connection saved', 'ok');
      return id;
    };
    const doConnect = async () => {
      let id;
      try { id = await doSave(); } catch { return; }
      connectTo(id);
    };

    const form = h('form', { class: 'conn-form', onsubmit: (e) => { e.preventDefault(); doConnect(); } },
      h('div', { class: 'form-head' },
        h('h2', null, c.id ? 'Edit connection' : 'New connection'),
        h('div', { class: 'spacer' }),
        fileBased ? null : h('div', { class: 'seg' },
          ['basic', 'string'].map((m) => h('button', {
            type: 'button', class: f.mode === m ? 'on' : '',
            onclick: (e) => { f.mode = m; e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); paintMode(); },
          }, m === 'basic' ? (oracle ? 'Basic' : 'Fields') : (oracle ? 'Connect string' : 'URL')))),
        h('button', { type: 'button', class: 'icon-btn form-close', title: 'Close (back to the start screen)', onclick: () => { S.selectedConn = null; renderWelcome(); } }, icon('x'))),
      c.id ? null : field('Type', typeRow), // a saved connection keeps its database type
      field('Name', inp('name', { placeholder: 'e.g. Billing — staging' })),
      field('Tag', envRow),
      modeBox,
      fileBased ? null : h('div', { class: 'grid2' },
        field('User', inp('user', { placeholder: oracle ? 'HR' : engine.id === 'postgres' ? 'postgres' : engine.id === 'clickhouse' || redis ? 'default' : mongo ? 'optional' : 'root', autocomplete: 'off' })),
        field('Password', pwBox)),
      oracle
        ? h('div', { class: 'grid2' },
          field('Role', sel('role', [['DEFAULT', 'Default'], ['SYSDBA', 'SYSDBA'], ['SYSOPER', 'SYSOPER'], ['SYSBACKUP', 'SYSBACKUP']])),
          h('div', { class: 'field checks' }, chk('savePassword', 'Save password (encrypted)'), chk('autoCommit', 'Auto-commit by default')))
        : h('div', { class: 'checks-row' },
          fileBased ? null : chk('savePassword', 'Save password (encrypted)'),
          redis ? chk('readOnly', 'Read-only (block write commands)')
            : mongo ? chk('readOnly', 'Read-only (block changes)')
            : noTx ? h('span', { class: 'muted' }, 'ClickHouse has no transactions: every statement is applied at once.') : chk('autoCommit', 'Auto-commit by default')),
      status,
      h('div', { class: 'form-actions' },
        c.id ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: () => deleteConn(c) }, icon('trash'), 'Delete') : null,
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn', onclick: doTest }, 'Test'),
        h('button', { type: 'button', class: 'btn', onclick: () => doSave().catch(() => {}) }, 'Save'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Connect')));
    if (userPaint) form.addEventListener('input', () => userPaint()); // MongoDB: keep the connection string preview current
    return form;
  }
  // ---------- Connect / workspace ----------
  function askPassword(c) {
    return new Promise((resolve) => {
      const input = h('input', { class: 'input', type: 'password', placeholder: 'Password' });
      let done = false;
      const ok = () => { done = true; resolve(input.value); };
      const m = modal({
        title: `Password for ${c.user}`,
        body: h('div', null, h('p', { class: 'muted' }, c.name || ''), input),
        actions: [{ label: 'Cancel' }, { label: 'Connect', kind: 'primary', onClick: ok }],
        onClose: () => { if (!done) resolve(null); },
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { ok(); m.close(); } });
    });
  }
  async function connectTo(id) {
    let c = S.connections.find((x) => x.id === id);
    if (!c) { S.connections = await api.listConnections(); c = S.connections.find((x) => x.id === id); }
    if (!c) { toast('That connection no longer exists', 'err'); return; }
    // Already open in another tab? Switch there instead of opening a second session.
    if (api.focusExisting) {
      try { if (await api.focusExisting(id)) return; } catch { /* fall through and connect */ }
    }
    S.connecting = id;
    Lookup.pushState();
    let password;
    const optional = Lookup.engineOf(c).passwordOptional && !c.user; // Redis: many servers have no password
    if (c && !c.hasPassword && !Lookup.engineOf(c).file && !optional) {
      password = await askPassword(c);
      if (password === null) { S.connecting = null; Lookup.pushState(); return; }
    }
    let cancelled = false;
    const cancelBtn = h('button', { class: 'btn', onclick: () => { cancelled = true; cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling…'; api.cancelConnect().catch(() => {}); } }, 'Cancel');
    const overlay = h('div', { class: 'connecting' }, h('div', { class: 'spinner' }), h('div', null, `Connecting to ${c ? c.name : ''}…`), cancelBtn);
    document.body.append(overlay);
    const onEsc = (e) => { if (e.key === 'Escape' && !cancelled) { e.preventDefault(); cancelBtn.click(); } };
    document.addEventListener('keydown', onEsc, true);
    try {
      try {
        S.info = await api.connect(id, password);
      } catch (e) {
        // No password saved and the server asks for one: ask, then try again.
        if (!optional || cancelled || !/NOAUTH|Authentication required|WRONGPASS|Wrong username or password/i.test(e.message)) throw e;
        overlay.classList.add('hidden');
        password = await askPassword({ ...c, user: c.user || 'default' });
        if (password === null) throw Object.assign(new Error('Connection cancelled'), { cancelled: true });
        overlay.classList.remove('hidden');
        S.info = await api.connect(id, password);
      }
      S.connecting = null;
      S.current = c;
      S.autoCommit = S.info.autoCommit;
      S.txPending = false;
      S.schema = S.info.schema;
      S.collapsed = new Set(Lookup.profile().collapsed || []);
      S.objCache.clear();
      S.colCache.clear();
      overlay.remove();
      await Lookup.enterWorkspace();
    } catch (e) {
      S.connecting = null;
      Lookup.pushState();
      overlay.remove();
      if (cancelled || /Connection cancelled/.test(e.message)) { showWelcome(); return; } // back to the connection form, no error
      modal({ title: 'Could not connect', body: h('pre', { class: 'err-text' }, e.message), actions: [{ label: 'OK', kind: 'primary' }] });
    } finally {
      document.removeEventListener('keydown', onEsc, true);
    }
  }

  try {
    const w = localStorage.getItem('lookup.welcomeW');
    if (w) document.documentElement.style.setProperty('--welcome-w', w);
  } catch { /* ignore */ }

  Object.assign(Lookup, { showWelcome, connectTo, renderWelcome });
})();
