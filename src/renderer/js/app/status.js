// Title bar state for the window shell, the status bar, transactions (commit / rollback / auto-commit), and lost connections + Reconnect.
(function () {
  const { h, icon, toast, confirmBox, contextMenu } = window.U;
  const api = window.api;
  const $ = (sel, root = document) => root.querySelector(sel);
  const Lookup = window.Lookup;
  const { ENVS, EMBEDDED, S } = Lookup;

  // ---------- Title bar ----------
  // Tells the window's connection tab what this workspace is showing.
  function pushState() {
    if (!api.wsState) return;
    const c = S.current;
    api.wsState(c && S.info ? {
      connected: true,
      connecting: false,
      connId: c.id,
      title: c.name || c.user,
      env: c.env || 'none',
      schema: S.schema,
      schemaWord: Lookup.profile().schemaWord || 'Schema',
      detail: c.mode === 'string' && Lookup.engineId() === 'oracle' ? `${c.user}@custom connect string` : Lookup.target(c),
      engine: Lookup.engineId(),
      engineLabel: Lookup.profile().label,
      badge: Lookup.engineOf(c).badge,
      initials: Lookup.initials(c),
      badgeColor: Lookup.engineOf(c).color,
      databasesWord: Lookup.profile().databasesWord || null,
      dbName: S.info.dbName || null,
      autoCommit: S.autoCommit,
      txPending: S.txPending && !S.autoCommit,
    } : S.connecting
      ? { connected: false, connecting: true, connId: S.connecting, title: 'Connecting…', env: 'none', schema: null, txPending: false }
      : { connected: false, connecting: false, connId: null, title: 'New connection', env: 'none', schema: null, txPending: false });
  }
  function renderTitlebar() {
    pushState();
    if (EMBEDDED) return;
    const tb = $('#titlebar');
    tb.innerHTML = '';
    tb.className = 'titlebar ' + (S.platform === 'darwin' ? 'mac' : 'win');
    tb.append(h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), h('span', { class: 'brand-name' }, 'Lookup')));
    if (!S.current) { tb.append(h('div', { class: 'tb-spacer' })); return; }
    const env = ENVS[S.current.env || 'none'];
    tb.append(
      h('button', { class: 'conn-pill no-drag', title: 'Switch connection', onclick: () => Lookup.leaveWorkspace() },
        h('span', { class: 'dot', style: { background: env.color } }),
        h('span', { class: 'conn-pill-name' }, S.current.name || S.current.user),
        S.current.env && S.current.env !== 'none' ? h('span', { class: 'env-tag', style: { '--c': env.color } }, env.label) : null,
        h('span', { class: 'conn-pill-meta' }, S.info.schema)),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-actions no-drag' },
        h('button', { class: 'tb-btn', title: 'New query (Ctrl+E)', onclick: () => Lookup.openQueryTab() }, icon('code'), h('span', null, 'SQL')),
        h('button', { class: 'tb-btn', title: 'Open anything (Ctrl+P)', onclick: () => Lookup.openAnything() }, icon('search')),
        h('div', { class: 'tb-sep' }),
        h('button', {
          class: 'tb-btn toggle' + (S.autoCommit ? ' on' : ''), title: 'Auto-commit',
          onclick: async () => { S.autoCommit = await api.setAutoCommit(!S.autoCommit); renderTitlebar(); renderStatus(); },
        }, h('span', { class: 'switch' }), h('span', null, 'Auto-commit')),
        h('button', { class: 'tb-btn' + (S.txPending ? ' attn' : ''), title: 'Commit transaction', disabled: S.autoCommit, onclick: () => txAction('commit') }, icon('check'), h('span', null, 'Commit')),
        h('button', { class: 'tb-btn', title: 'Roll back transaction', disabled: S.autoCommit, onclick: () => txAction('rollback') }, icon('undo'), h('span', null, 'Rollback')),
        h('div', { class: 'tb-sep' }),
        h('button', { class: 'tb-btn', title: 'Disconnect', onclick: () => Lookup.leaveWorkspace() }, icon('plug'))));
  }
  async function txAction(kind) {
    try {
      await api[kind]();
      S.txPending = false;
      toast(kind === 'commit' ? 'Transaction committed' : 'Transaction rolled back', 'ok');
      renderTitlebar();
      renderStatus();
    } catch (e) { toast(e.message, 'err', 6000); }
  }
  // Ctrl+S: commit the session's open transaction.
  function commitShortcut() {
    if (!S.current) return;
    if (S.autoCommit) { toast('Auto-commit is on, so every statement is already committed', 'info', 2500); return; }
    txAction('commit');
  }
  async function toggleAutoCommit() {
    try {
      if (!S.autoCommit && S.txPending && !(await confirmBox('Turn on auto-commit?', 'Your open transaction will be committed first.', 'Commit and turn on'))) return;
      if (!S.autoCommit && S.txPending) await txAction('commit');
      S.autoCommit = await api.setAutoCommit(!S.autoCommit);
      toast(S.autoCommit ? 'Auto-commit on' : 'Auto-commit off — Ctrl+S commits', 'info', 2200);
      renderTitlebar();
      renderStatus();
    } catch (e) { toast(e.message, 'err'); }
  }
  function txMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.top - 4 - 3 * 30, [
      { label: 'Commit', icon: 'check', hint: 'Ctrl+S', disabled: S.autoCommit, onClick: () => txAction('commit') },
      { label: 'Rollback', icon: 'undo', disabled: S.autoCommit, onClick: () => txAction('rollback') },
      '-',
      { label: S.autoCommit ? 'Turn auto-commit off' : 'Turn auto-commit on', onClick: () => toggleAutoCommit() },
    ]);
  }
  function renderStatus() {
    const sb = $('#statusbar');
    sb.innerHTML = '';
    if (!S.current) {
      sb.append(h('span', null, `${S.connections.length} saved connection${S.connections.length === 1 ? '' : 's'}`), h('span', { class: 'sb-spacer' }), h('span', { class: 'muted' }, 'Oracle · PostgreSQL · MySQL · SQLite · ClickHouse · Redis · MongoDB — no client software needed'));
      return;
    }
    const where = Lookup.isMongo && Lookup.isMongo() ? Lookup.mongoWhere()
      : Lookup.isRedis && Lookup.isRedis() ? Lookup.redisWhere()
      : S.current.mode === 'string' && Lookup.engineId() === 'oracle' ? `${S.current.user}@custom` : Lookup.target(S.current);
    sb.append(...[
      S.lost
        ? h('span', { class: 'sb-item sb-lost', title: S.lost }, h('span', { class: 'live lost' }), 'Connection lost',
          h('button', { class: 'sb-btn sb-reconnect', title: 'Reconnect (Ctrl+R)', onclick: reconnect }, 'Reconnect'))
        : h('span', { class: 'sb-item' }, h('span', { class: 'live' }), 'Connected'),
      h('span', { class: 'sb-item' }, where),
      h('span', { class: 'sb-item muted' }, `${Lookup.profile().label} ${S.info.version || ''}`),
      ...(Lookup.isRedis && Lookup.isRedis() ? Lookup.redisStatusItems() : []),
      ...(Lookup.isMongo && Lookup.isMongo() ? Lookup.mongoStatusItems() : []),
      h('span', { class: 'sb-spacer' }),
      S.txPending && !S.autoCommit ? h('button', { class: 'sb-item sb-btn warn', title: 'Commit or roll back', onclick: txMenu }, 'Uncommitted transaction · Ctrl+S to commit') : null].filter(Boolean));
  }
  // ---------- Lost connection ----------
  function connectionLost(message) {
    if (!S.current) return;
    S.lost = message || 'The connection to the database was lost';
    const hadTx = S.txPending && !S.autoCommit;
    S.txPending = false;
    renderTitlebar();
    renderStatus();
    toast(S.lost + (hadTx ? ' — uncommitted changes were rolled back by the database.' : ''), 'err', 6000);
  }
  let reconnecting = false;
  async function reconnect() {
    if (reconnecting) return;
    // On a live connection a reconnect replaces the session, so open changes would be rolled back.
    if (!S.lost && S.txPending && !S.autoCommit
      && !(await confirmBox('Reconnect', 'You have uncommitted changes in this session. Reconnecting will roll them back.', 'Reconnect', true))) return;
    reconnecting = true;
    const btn = document.querySelector('.sb-reconnect');
    if (btn) { btn.disabled = true; btn.textContent = 'Reconnecting…'; }
    try {
      S.info = await api.reconnect();
      S.lost = null;
      S.txPending = false;
      renderTitlebar();
      S.colCache && S.colCache.clear();
      if (Lookup.isRedis && Lookup.isRedis()) await Lookup.redisReconnected();
      if (Lookup.isMongo && Lookup.isMongo()) await Lookup.mongoReconnected();
      renderStatus();
      toast('Reconnected', 'ok', 2000);
    } catch (e) {
      toast(e.message, 'err', 6000);
      renderStatus();
    } finally {
      reconnecting = false;
    }
  }

  Object.assign(Lookup, { pushState, renderTitlebar, txAction, commitShortcut, toggleAutoCommit, renderStatus, connectionLost, reconnect });
})();
