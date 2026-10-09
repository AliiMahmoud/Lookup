// Workspace tabs: open, activate, close, rename (double-click), tab context menu.
(function () {
  const { h, icon, confirmBox, contextMenu } = window.U;
  const $ = (sel, root = document) => root.querySelector(sel);
  const Lookup = window.Lookup;
  const { S } = Lookup;

  // ---------- Tabs ----------
  let tabSeq = 0;
  function addTab(tab) {
    tab.id = ++tabSeq;
    S.tabs.push(tab);
    $('#tabviews').append(tab.el);
    S.active = tab.id;
    renderTabs();
    activate(tab.id);
    return tab;
  }
  function activate(id) {
    S.active = id;
    for (const t of S.tabs) t.el.classList.toggle('hidden', t.id !== id);
    paintTabState();
    paintTreeActive();
    const t = S.tabs.find((x) => x.id === id);
    if (t && t.onShow) t.onShow();
  }
  function paintTreeActive() {
    const t = S.tabs.find((x) => x.id === S.active);
    document.querySelectorAll('.tree-item').forEach((el) => {
      el.classList.toggle('active', !!t && t.owner === S.schema && el.title.split(' ')[0] === t.name);
    });
  }
  async function closeTab(id, force = false) {
    const t = S.tabs.find((x) => x.id === id);
    if (!t) return;
    if (t.grid && t.grid.changeCount() && !(await confirmBox('Discard changes?', `${t.name} has ${t.grid.changeCount()} uncommitted edit(s).`, 'Discard', true))) return;
    if (!force && t.isDirty && t.isDirty() && !(await confirmBox(t.kind === 'create' ? 'Discard new table?' : 'Discard structure changes?', t.kind === 'create' ? `${t.title} has not been created yet.` : `${t.name} has structure changes that were not applied.`, 'Discard', true))) return;
    t.destroy && t.destroy();
    t.el.remove();
    const i = S.tabs.indexOf(t);
    S.tabs.splice(i, 1);
    if (S.active === id) {
      const next = S.tabs[i] || S.tabs[i - 1];
      S.active = next ? next.id : null;
      renderTabs();
      if (next) activate(next.id);
    } else renderTabs();
    Lookup.saveQueryTabs();
  }
  // Updates active/dirty classes without rebuilding the tab bar (a rebuild between the
  // two clicks of a double-click would swallow the dblclick event).
  function paintTabState() {
    const bar = $('#tabbar');
    for (const el of bar.querySelectorAll('.tab')) {
      const t = S.tabs.find((x) => x.id === Number(el.dataset.id));
      if (!t) continue;
      el.classList.toggle('active', t.id === S.active);
      el.classList.toggle('dirty', !!((t.grid && t.grid.changeCount()) || (t.kind === 'table' && t.isDirty && t.isDirty())));
    }
    const cur = bar.querySelector('.tab.active');
    if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function renderTabs() {
    const bar = $('#tabbar');
    bar.innerHTML = '';
    S.tabs.forEach((t) => {
      const titleEl = h('span', { class: 'tab-title' }, t.title);
      bar.append(h('div', {
        class: 'tab',
        'data-id': t.id,
        title: t.tooltip ? `${t.tooltip}${t.title !== t.name ? ' — ' + t.title : ''}` : t.title,
        onmousedown: (e) => {
          if (e.target.closest('.tab-rename')) return;
          if (e.button === 1) { e.preventDefault(); closeTab(t.id); } else if (e.button === 0 && S.active !== t.id) activate(t.id);
        },
        ondblclick: (e) => { if (!e.target.closest('.tab-x')) startRename(t, titleEl); },
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Rename', icon: 'edit', hint: 'Double-click', onClick: () => startRename(t, titleEl) },
            t.title !== t.defaultTitle && t.defaultTitle ? { label: 'Reset name', onClick: () => setTabTitle(t, t.defaultTitle) } : null,
            '-',
            { label: 'Close', icon: 'x', hint: 'Ctrl+W', onClick: () => closeTab(t.id) },
            { label: 'Close other tabs', disabled: S.tabs.length < 2, onClick: () => closeTabs(S.tabs.filter((x) => x.id !== t.id)) },
            { label: 'Close tabs to the right', disabled: S.tabs.indexOf(t) === S.tabs.length - 1, onClick: () => closeTabs(S.tabs.slice(S.tabs.indexOf(t) + 1)) },
            { label: 'Close all tabs', onClick: () => closeTabs([...S.tabs]) },
          ].filter(Boolean));
        },
      }, icon(t.icon), titleEl,
      h('button', { class: 'tab-x', title: 'Close', onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, icon('x'))));
    });
    bar.append(h('button', { class: 'tab-new', title: 'New query (Ctrl+T)', onclick: () => Lookup.openQueryTab() }, icon('plus')));
    $('#empty-state').classList.toggle('hidden', S.tabs.length > 0);
    paintTabState();
  }
  function setTabTitle(t, title) {
    t.title = title;
    renderTabs();
    if (t.kind === 'query') Lookup.saveQueryTabs();
  }
  // Inline rename: Enter or clicking away saves, Esc cancels, empty restores the default.
  function startRename(t, titleEl) {
    if (!titleEl.isConnected || titleEl.parentNode.querySelector('.tab-rename')) return;
    if (!t.defaultTitle) t.defaultTitle = t.kind === 'query' ? t.title : t.name;
    const input = h('input', { class: 'tab-rename', spellcheck: 'false', maxlength: '80' });
    input.value = t.title;
    input.style.width = Math.max(60, titleEl.getBoundingClientRect().width + 16) + 'px';
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save) setTabTitle(t, v || t.defaultTitle);
      else renderTabs();
      const active = S.tabs.find((x) => x.id === S.active);
      if (active && active.kind === 'query') active.editor.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('input', () => { input.style.width = Math.max(60, Math.min(260, input.value.length * 7.4 + 22)) + 'px'; });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }
  async function closeTabs(list) {
    for (const t of list) await closeTab(t.id);
  }

  Object.assign(Lookup, { addTab, activate, closeTab, paintTabState, renderTabs });
})();
