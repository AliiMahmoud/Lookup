// Title bar: one tab per open connection, plus actions for the active one.
(function () {
  const { h, icon } = window.U;
  const api = window.shellApi;
  const ENV = {
    local: ['Local', 'var(--env-local)'],
    dev: ['Dev', 'var(--env-dev)'],
    staging: ['Staging', 'var(--env-staging)'],
    prod: ['Production', 'var(--env-prod)'],
  };
  let data = { active: null, list: [] };
  let dragId = null;

  document.body.classList.add('platform-' + api.platform);
  if (api.platform === 'darwin') document.getElementById('shellbar').classList.add('mac');
  const add = document.getElementById('conn-add');
  add.append(icon('plus'));
  add.addEventListener('click', () => { const r = add.getBoundingClientRect(); api.connectMenu({ x: Math.round(r.right + 4), y: Math.round(r.top) }); });
  // Settings (gear) in the top-right corner of the title bar, always visible.
  const gear = document.getElementById('tb-settings');
  gear.append(icon('gear'));
  gear.addEventListener('click', () => { const r = gear.getBoundingClientRect(); api.settingsMenu({ x: Math.round(r.left), y: Math.round(r.bottom + 2), right: Math.round(r.right) }); });

  // Left rail: one tile per open connection (database icon in its tag colour + short name).
  function renderTabs() {
    const box = document.getElementById('conn-tabs');
    box.innerHTML = '';
    data.list.forEach((ws, i) => {
      const env = ENV[ws.env];
      const color = env ? env[1] : 'var(--accent)';
      const tip = ws.connected
        ? `${ws.title}${env ? ` (${env[0]})` : ''}\n${ws.detail || ''}${ws.schema ? `\nSchema ${ws.schema}` : ''}${ws.txPending ? '\nUncommitted transaction' : ''}${i < 9 ? `\nCtrl+Alt+${i + 1}` : ''}`
        : ws.connecting ? 'Connecting…' : 'Not connected — pick a saved connection';
      const tile = h('div', {
        class: 'rail-tile' + (ws.id === data.active ? ' active' : '') + (ws.connected ? '' : ' empty'),
        style: ws.connected ? { '--c': color } : null,
        title: tip,
        draggable: 'true',
        onmousedown: (e) => {
          if (e.button === 1) { e.preventDefault(); api.close(ws.id); }
          else if (e.button === 0 && ws.id !== data.active) api.activate(ws.id);
        },
        oncontextmenu: (e) => { e.preventDefault(); api.tileMenu(ws.id); },
        ondragstart: (e) => { dragId = ws.id; e.dataTransfer.effectAllowed = 'move'; },
        ondragover: (e) => {
          if (dragId === null || dragId === ws.id) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          e.currentTarget.classList.toggle('drop-after', after);
          e.currentTarget.classList.toggle('drop-before', !after);
        },
        ondragleave: (e) => e.currentTarget.classList.remove('drop-before', 'drop-after'),
        ondrop: (e) => {
          e.preventDefault();
          const after = e.currentTarget.classList.contains('drop-after');
          e.currentTarget.classList.remove('drop-before', 'drop-after');
          if (dragId === null || dragId === ws.id) return;
          const from = data.list.findIndex((x) => x.id === dragId);
          let to = i + (after ? 1 : 0);
          if (from < to) to--;
          api.move(dragId, to);
          dragId = null;
        },
        ondragend: () => { dragId = null; },
      },
      icon(ws.connected || ws.connecting ? 'db' : 'plug'),
      h('span', { class: 'rail-name' }, ws.connected ? ws.title : ws.connecting ? 'Connecting' : 'New'),
      ws.txPending ? h('span', { class: 'rail-tx' }) : null,
      h('button', {
        class: 'rail-x', title: 'Close (Ctrl+Shift+W)',
        onmousedown: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); api.close(ws.id); },
      }, icon('x')));
      box.append(tile);
    });
    const cur = box.querySelector('.rail-tile.active');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // Title bar: name of the connection being shown.
  function renderActive() {
    const box = document.getElementById('active-conn');
    box.innerHTML = '';
    const ws = data.list.find((x) => x.id === data.active);
    if (!ws || !ws.connected) return;
    const env = ENV[ws.env];
    box.append(...[
      h('span', { class: 'dot', style: { background: env ? env[1] : 'var(--env-none)' } }),
      h('span', { class: 'name' }, ws.title),
      env ? h('span', { class: 'env-tag', style: { '--c': env[1] } }, env[0]) : null,
      ws.schema ? h('span', { class: 'meta' }, ws.schema) : null].filter(Boolean));
  }

  function renderActions() {
    const box = document.getElementById('shell-actions');
    const left = document.getElementById('shell-left');
    box.innerHTML = '';
    left.innerHTML = '';
    const ws = data.list.find((x) => x.id === data.active);
    if (!ws || !ws.connected) return;
    const btn = (title, ic, label, action, extra = {}) => h('button', {
      class: 'tb-btn' + (extra.cls ? ' ' + extra.cls : ''), title, disabled: extra.disabled,
      onclick: () => api.action(action),
    }, ic ? (typeof ic === 'string' ? icon(ic) : ic) : null, label ? h('span', null, label) : null);
    const dbBtn = h('button', {
      class: 'tb-btn', title: 'Databases on this server — open another PDB',
      onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); api.pdbMenu({ x: Math.round(r.left), y: Math.round(r.bottom + 2) }); },
    }, icon('db'), h('span', { class: 'caret' }, '▾'));
    // Next to the connection name: other databases on the server, and a new query tab.
    left.append(
      dbBtn,
      btn('New query (Ctrl+T)', 'code', 'Query', 'newQuery'));
    box.append(
      btn('Open anything (Ctrl+P)', 'search', null, 'openAnything'),
      btn('SQL log — statements Lookup ran for you (Ctrl+Shift+L)', 'log', null, 'sqlLog'));
  }

  api.onWorkspaces((d) => {
    data = d;
    renderTabs();
    renderActive();
    renderActions();
  });
  api.ready();
})();
