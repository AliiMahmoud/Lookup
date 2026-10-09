// Welcome screen: saved connections list, the connection form, and connecting (password prompt, Cancel).
(function () {
  const { h, icon, toast, modal, confirmBox, contextMenu } = window.U;
  const api = window.api;
  const $ = (sel, root = document) => root.querySelector(sel);
  const Lookup = window.Lookup;
  const { ENVS, S } = Lookup;

  // ---------- Home: app info and actions on the left, saved connections on the right ----------
  function blankConn() {
    return { id: null, name: '', env: 'none', mode: 'basic', host: 'localhost', port: 1521, serviceType: 'service', service: 'FREEPDB1', user: '', password: '', savePassword: true, role: 'DEFAULT', autoCommit: false, connectString: '' };
  }
  let appVersion = '';
  let homeSel = null; // id of the highlighted connection
  async function showWelcome() {
    S.connections = await api.listConnections();
    if (!appVersion) { try { appVersion = await api.version(); } catch { /* unknown */ } }
    $('#workspace').classList.add('hidden');
    $('#welcome').classList.remove('hidden');
    Lookup.renderTitlebar();
    Lookup.renderStatus();
    renderWelcome();
  }

  // Short text under a connection's name: "host : service", or the connect string.
  const connTarget = (c) => (c.mode === 'string' ? (c.connectString || 'connect string') : `${c.host || 'localhost'} : ${c.service || ''}`);
  const initials = (c) => {
    const words = String(c.name || c.user || '?').replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/);
    const two = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
    return (two || '?').charAt(0).toUpperCase() + (two.charAt(1) || '').toLowerCase();
  };

  function renderWelcome() {
    const w = $('#welcome');
    w.innerHTML = '';
    const hasConns = S.connections.length > 0;
    const bigBtn = (ic, label, onClick, attrs = {}) => h('button', { class: 'home-btn', onclick: onClick, ...attrs }, icon(ic), h('span', null, label));
    const left = h('div', { class: 'home-left' },
      h('div', { class: 'home-brand' },
        h('div', { class: 'home-logo' }),
        h('h1', null, 'Lookup'),
        h('div', { class: 'muted' }, appVersion ? `Version ${appVersion}` : 'Oracle Database client')),
      h('div', { class: 'home-actions' },
        bigBtn('plug', 'Create Connection', () => editConnection(blankConn())),
        bigBtn('download', 'Import Connections', () => Lookup.importConnections(), { title: 'From an Oracle SQL Developer export (.xml or .json)' }),
        bigBtn('upload', 'Export Connections', () => Lookup.exportConnections(), { title: 'For Oracle SQL Developer (.xml, without passwords)', disabled: !hasConns })));

    const search = h('input', { class: 'home-search-input', placeholder: 'Search for connection…', spellcheck: 'false', oninput: () => paintList() });
    const list = h('div', { class: 'home-list' });
    let shown = [];
    const select = (id, scroll) => {
      homeSel = id;
      list.querySelectorAll('.home-conn').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
      if (scroll) { const el = list.querySelector('.home-conn.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); }
    };
    function paintList() {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      shown = S.connections.filter((c) => !q || `${c.name} ${c.user} ${c.host} ${c.service} ${c.connectString || ''} ${c.env}`.toLowerCase().includes(q));
      if (!shown.length) {
        list.append(hasConns
          ? h('div', { class: 'home-empty' }, 'No connections match')
          : h('div', { class: 'home-empty' },
            h('div', null, 'No connections yet'),
            h('div', { class: 'home-empty-actions' },
              h('button', { class: 'btn primary sm', onclick: () => editConnection(blankConn()) }, icon('plus'), 'Create connection'),
              h('button', { class: 'btn sm', onclick: () => Lookup.importConnections() }, icon('download'), 'Import'))));
        return;
      }
      if (!shown.some((c) => c.id === homeSel)) homeSel = shown[0].id;
      for (const c of shown) {
        const env = ENVS[c.env || 'none'] || ENVS.none;
        list.append(h('div', {
          class: 'home-conn' + (c.id === homeSel ? ' sel' : ''),
          'data-id': c.id,
          title: `${c.user}${c.role && c.role !== 'DEFAULT' ? ' as ' + c.role : ''} · double-click to connect`,
          onmousedown: () => select(c.id),
          ondblclick: () => connectTo(c.id),
          oncontextmenu: (e) => { e.preventDefault(); select(c.id); connMenu(e.clientX, e.clientY, c); },
        },
        h('span', { class: 'home-badge', style: { '--c': env.color } }, initials(c)),
        h('div', { class: 'home-conn-text' },
          h('div', { class: 'home-conn-name' }, h('span', null, c.name || '(unnamed)'),
            c.env && c.env !== 'none' ? h('span', { class: 'home-conn-env', style: { color: env.color } }, `(${env.label.toLowerCase()})`) : null),
          h('div', { class: 'home-conn-sub' }, connTarget(c)))));
      }
    }
    // Keyboard: ↑ ↓ to move, Enter to connect, typing goes to the search box.
    search.addEventListener('keydown', (e) => {
      const i = shown.findIndex((c) => c.id === homeSel);
      if (e.key === 'ArrowDown' && shown.length) { e.preventDefault(); select(shown[Math.min(shown.length - 1, i + 1)].id, true); }
      else if (e.key === 'ArrowUp' && shown.length) { e.preventDefault(); select(shown[Math.max(0, i - 1)].id, true); }
      else if (e.key === 'Enter' && homeSel && shown.length) { e.preventDefault(); connectTo(homeSel); }
      else if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; paintList(); }
    });
    const right = h('div', { class: 'home-right' },
      h('div', { class: 'home-top' },
        h('button', { class: 'tool home-add', title: 'Create connection', onclick: () => editConnection(blankConn()) }, icon('plus')),
        h('label', { class: 'home-search' }, icon('search'), search)),
      list);
    paintList();
    w.append(left, right);
    setTimeout(() => { if (!document.querySelector('.modal-back')) search.focus(); }, 0);
  }

  function connMenu(x, y, c) {
    contextMenu(x, y, [
      { label: 'Connect', icon: 'plug', onClick: () => connectTo(c.id) },
      { label: 'Connect in a new tab', icon: 'window', onClick: () => (api.openConnection ? api.openConnection(c.id) : api.newWindow()) },
      '-',
      { label: 'Edit…', icon: 'edit', onClick: () => editConnection({ ...c, keepPassword: true, password: '' }) },
      { label: 'Duplicate…', icon: 'copy', onClick: () => editConnection({ ...c, id: null, name: c.name + ' copy', password: '', keepPassword: false }) },
      '-',
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteConn(c) },
    ]);
  }

  /** The connection form in a dialog: Create Connection, +, or right-click → Edit / Duplicate. */
  function editConnection(c) {
    let m = null;
    const form = connForm(c, {
      onSaved: (id) => { homeSel = id; m.close(); },
      onConnect: (id) => { m.close(); connectTo(id); },
      onDeleted: () => m.close(),
    });
    m = modal({ title: c.id ? `Edit ${c.name || 'connection'}` : 'New connection', body: form, wide: true });
    m.box.classList.add('conn-dialog');
  }

  async function deleteConn(c) {
    if (!(await confirmBox('Delete connection', `Delete "${c.name || c.user}"? This only removes it from Lookup.`, 'Delete', true))) return false;
    await api.deleteConnection(c.id);
    S.connections = await api.listConnections();
    renderWelcome();
    Lookup.renderStatus();
    return true;
  }
  function field(label, control, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
  }
  function connForm(c, { onSaved, onConnect, onDeleted } = {}) {
    const f = { mode: 'basic', serviceType: 'service', role: 'DEFAULT', port: 1521, ...c };
    for (const k of ['mode', 'serviceType', 'role']) if (!f[k]) f[k] = blankConn()[k];
    if (f.savePassword === undefined) f.savePassword = true;
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

    const envRow = h('div', { class: 'env-row' }, Object.entries(ENVS).map(([k, v]) => h('button', {
      type: 'button',
      class: 'env-chip' + (f.env === k ? ' on' : ''),
      style: { '--c': v.color },
      onclick: (e) => { f.env = k; envRow.querySelectorAll('.env-chip').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); },
    }, h('span', { class: 'dot', style: { background: v.color } }), v.label)));

    const basic = h('div', { class: 'grid2' },
      field('Host', inp('host', { placeholder: 'db.example.com' })),
      field('Port', inp('port', { type: 'number', placeholder: '1521' })),
      field('Connect by', sel('serviceType', [['service', 'Service name'], ['sid', 'SID']])),
      field('Service / SID', inp('service', { placeholder: 'ORCLPDB1' })));
    const str = h('div', null, field('Connect string', inp('connectString', { placeholder: 'host:1521/service  or  (DESCRIPTION=…)' }), 'EZConnect or a full TNS descriptor.'));
    const modeBox = h('div');
    const paintMode = () => { modeBox.innerHTML = ''; modeBox.append(f.mode === 'string' ? str : basic); };
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
    const collect = () => ({ ...f, port: Number(f.port) || 1521 });
    const busy = (b) => form.querySelectorAll('button').forEach((x) => { x.disabled = b; });

    const doTest = async () => {
      status.className = 'form-status';
      status.textContent = 'Testing…';
      busy(true);
      try {
        const r = await api.testConnection(collect());
        status.className = 'form-status ok';
        status.textContent = `Connected · Oracle ${r.version} · schema ${r.schema}`;
      } catch (e) {
        status.className = 'form-status err';
        status.textContent = e.message;
      } finally { busy(false); }
    };
    const doSave = async () => {
      const cfg = collect();
      if (!cfg.name) cfg.name = cfg.mode === 'string' ? cfg.user : `${cfg.user}@${cfg.host}`;
      const id = await api.saveConnection(cfg);
      f.id = id; // later saves update this connection
      S.connections = await api.listConnections();
      if (onSaved) onSaved(id);
      renderWelcome();
      Lookup.renderStatus();
      toast('Connection saved', 'ok');
      return id;
    };
    const doConnect = async () => {
      const id = await doSave();
      if (onConnect) onConnect(id); else connectTo(id);
    };

    const form = h('form', { class: 'conn-form', onsubmit: (e) => { e.preventDefault(); doConnect(); } },
      h('div', { class: 'form-head' },
        h('div', { class: 'seg' },
          ['basic', 'string'].map((m) => h('button', {
            type: 'button', class: f.mode === m ? 'on' : '',
            onclick: (e) => { f.mode = m; e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); paintMode(); },
          }, m === 'basic' ? 'Basic' : 'Connect string')))),
      field('Name', inp('name', { placeholder: 'e.g. Billing — staging' })),
      field('Tag', envRow),
      modeBox,
      h('div', { class: 'grid2' },
        field('User', inp('user', { placeholder: 'HR', autocomplete: 'off' })),
        field('Password', pwBox)),
      h('div', { class: 'grid2' },
        field('Role', sel('role', [['DEFAULT', 'Default'], ['SYSDBA', 'SYSDBA'], ['SYSOPER', 'SYSOPER'], ['SYSBACKUP', 'SYSBACKUP']])),
        h('div', { class: 'field checks' }, chk('savePassword', 'Save password (encrypted)'), chk('autoCommit', 'Auto-commit by default'))),
      status,
      h('div', { class: 'form-actions' },
        c.id ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: async () => { if (await deleteConn(c) && onDeleted) onDeleted(); } }, icon('trash'), 'Delete') : null,
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn', onclick: doTest }, 'Test'),
        h('button', { type: 'button', class: 'btn', onclick: doSave }, 'Save'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Connect')));
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
    if (c && !c.hasPassword) {
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
      S.info = await api.connect(id, password);
      S.connecting = null;
      S.current = c;
      S.autoCommit = S.info.autoCommit;
      S.txPending = false;
      S.schema = S.info.schema;
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

  Object.assign(Lookup, { showWelcome, connectTo, renderWelcome });
})();
