// Sidebar: schema picker, object tree and filter, object context menu (truncate / delete table), Open anything (Ctrl+P), resizing.
(function () {
  const { h, icon, toast, modal, contextMenu, debounce } = window.U;
  const api = window.api;
  const $ = (sel, root = document) => root.querySelector(sel);
  const Lookup = window.Lookup;
  const { TYPE_ICON, S, qident } = Lookup;

  // ---------- Sidebar ----------
  function renderSidebarShell() {
    const sb = $('#sidebar');
    sb.innerHTML = '';
    const schemaSel = h('select', { class: 'input sm', id: 'schema-select', onchange: async (e) => { S.schema = e.target.value; await loadObjects(); } });
    // Small × on the right clears the filter (also Esc); hidden while the box is empty.
    const clearBtn = h('button', { class: 'sb-search-clear', title: 'Clear (Esc)', tabindex: '-1',
      onmousedown: (e) => e.preventDefault(), // keep focus in the box
      onclick: () => { filter.value = ''; S.filter = ''; clearBtn.classList.add('hidden'); paintTree(); filter.focus(); } }, icon('x'));
    const filter = h('input', {
      class: 'input sm', placeholder: 'Filter objects', id: 'obj-filter',
      oninput: (e) => { clearBtn.classList.toggle('hidden', !e.target.value); applyFilter(e); },
      onkeydown: (e) => { if (e.key === 'Escape' && filter.value) { e.preventDefault(); e.stopPropagation(); clearBtn.click(); } },
    });
    const applyFilter = debounce((e) => { S.filter = e.target.value; paintTree(); }, 60);
    filter.value = S.filter;
    clearBtn.classList.toggle('hidden', !S.filter);
    sb.append(
      h('div', { class: 'sb-top' },
        h('div', { class: 'sb-row' }, icon('db'), schemaSel,
          h('button', { class: 'icon-btn', title: 'Refresh objects', onclick: () => loadObjects(true) }, icon('refresh')),
          Lookup.feature('createTable') ? h('button', { class: 'icon-btn', title: 'New table', onclick: () => Lookup.openCreateTable() }, icon('plus')) : null),
        h('div', { class: 'sb-search' }, icon('search'), filter, clearBtn)),
      h('div', { class: 'tree', id: 'tree' }));
  }
  function paintSchemaSelect() {
    const sel = $('#schema-select');
    if (!sel) return;
    sel.innerHTML = '';
    const user = S.schemas.filter((s) => !s.system);
    const sys = S.schemas.filter((s) => s.system);
    const add = (parent, s) => parent.append(h('option', { value: s.name }, s.name));
    user.forEach((s) => add(sel, s));
    if (sys.length) {
      const g = h('optgroup', { label: Lookup.profile().systemSchemasLabel || 'System' });
      sys.forEach((s) => add(g, s));
      sel.append(g);
    }
    if (!S.schemas.some((s) => s.name === S.schema)) sel.prepend(h('option', { value: S.schema }, S.schema));
    sel.value = S.schema;
  }
  async function getObjects(owner, force) {
    if (!force && S.objCache.has(owner)) return S.objCache.get(owner);
    const objs = await api.objects(owner);
    S.objCache.set(owner, objs);
    return objs;
  }
  async function loadObjects(force) {
    const tree = $('#tree');
    tree.innerHTML = '';
    tree.append(h('div', { class: 'tree-loading' }, h('div', { class: 'spinner sm' }), 'Loading objects…'));
    try {
      S.objects = await getObjects(S.schema, force);
      if (force) [...S.colCache.keys()].forEach((k) => { if (k.startsWith(S.schema + '.')) S.colCache.delete(k); });
      paintTree();
    } catch (e) {
      tree.innerHTML = '';
      tree.append(h('div', { class: 'tree-error' }, e.message));
    }
  }
  // The object list only puts the rows in view into the page (plus some above and below), so a schema with
  // thousands of tables costs the same memory as a small one (measured: 3,200 rows took about 40 MB as plain rows).
  const ITEM_H = 23; // .tree-item height
  const OVERSCAN = 25;
  function itemEl(o) {
    const activeTab = S.tabs.find((t) => t.id === S.active);
    const isActive = activeTab && activeTab.owner === S.schema && activeTab.name === o.name;
    return h('div', {
      class: 'tree-item' + (o.invalid ? ' invalid' : '') + (isActive ? ' active' : ''),
      title: o.invalid ? `${o.name} (INVALID)` : o.name,
      onclick: () => openObject(S.schema, o),
      oncontextmenu: (e) => objectMenu(e, S.schema, o),
    }, icon(TYPE_ICON[o.type] || 'table'), h('span', { class: 'tree-name' }, o.name));
  }
  const spacer = (rows) => (rows > 0 ? h('div', { class: 'tree-spacer', style: { height: rows * ITEM_H + 'px' } }) : null);
  /** Fills each open section with the rows that are in view. */
  function paintVisible() {
    const tree = $('#tree');
    if (!tree || !tree.boxes) return;
    const tTop = tree.getBoundingClientRect().top;
    const top = tree.scrollTop;
    const bottom = top + tree.clientHeight;
    for (const box of tree.boxes) {
      const n = box.items.length;
      const y = box.getBoundingClientRect().top - tTop + top + 1; // 1px: .tree-items top padding
      const first = Math.max(0, Math.min(n, Math.floor((top - y) / ITEM_H) - OVERSCAN));
      const last = Math.max(first, Math.min(n, Math.ceil((bottom - y) / ITEM_H) + OVERSCAN));
      if (box.first === first && box.last === last) continue;
      box.first = first;
      box.last = last;
      box.replaceChildren(...[spacer(first), ...box.items.slice(first, last).map(itemEl), spacer(n - last)].filter(Boolean));
    }
  }
  function paintTree() {
    const tree = $('#tree');
    if (!tree) return;
    tree.innerHTML = '';
    tree.boxes = [];
    if (!tree.watched) { // once per tree element: repaint the rows in view on scroll and when the sidebar changes size
      tree.watched = true;
      let raf = 0;
      const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintVisible(); }); };
      tree.addEventListener('scroll', later, { passive: true });
      new ResizeObserver(later).observe(tree);
    }
    const q = S.filter.trim().toUpperCase();
    let shown = 0;
    for (const [type, label] of Lookup.profile().sections) {
      const items = S.objects.filter((o) => o.type === type && (!q || o.name.toUpperCase().includes(q)));
      if (!items.length) continue;
      shown += items.length;
      const open = q ? true : !S.collapsed.has(type);
      const sec = h('div', { class: 'tree-sec' + (open ? ' open' : '') },
        h('div', {
          class: 'tree-head',
          onclick: () => { if (S.collapsed.has(type)) S.collapsed.delete(type); else S.collapsed.add(type); paintTree(); },
        }, icon('chevron', 'chev'), h('span', null, label),
        type === 'TABLE' && Lookup.feature('createTable') ? h('button', { class: 'tree-add', title: 'New table', onclick: (e) => { e.stopPropagation(); Lookup.openCreateTable(); } }, icon('plus')) : null,
        h('span', { class: 'count' }, items.length)));
      if (open) {
        const box = h('div', { class: 'tree-items' });
        box.items = items;
        box.append(spacer(items.length));
        tree.boxes.push(box);
        sec.append(box);
      }
      tree.append(sec);
    }
    if (!shown) tree.append(h('div', { class: 'empty-small' }, q ? 'No objects match' : 'This schema has no objects you can see'));
    paintVisible();
  }
  function objectMenu(e, owner, o) {
    e.preventDefault();
    const tabular = ['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'DICTIONARY'].includes(o.type);
    const fq = `${owner}.${o.name}`;
    contextMenu(e.clientX, e.clientY, [
      tabular ? { label: 'Open data', icon: 'table', onClick: () => openObject(owner, o, 'data') } : null,
      tabular ? { label: 'Structure', icon: 'columns', onClick: () => openObject(owner, o, 'structure') } : null,
      { label: 'Show DDL', icon: 'code', onClick: () => tabular ? openObject(owner, o, 'ddl') : Lookup.openDdlTab(owner, o) },
      tabular ? { label: 'Export data…', icon: 'download', onClick: () => Lookup.exportObject(owner, o) } : null,
      '-',
      tabular ? { label: 'New query: SELECT *', icon: 'play', onClick: () => Lookup.openQueryTab({ text: Lookup.fill(Lookup.profile().selectTop, { qname: `${qident(owner)}.${qident(o.name)}` }), run: true }) } : null,
      o.type === 'SEQUENCE' && Lookup.profile().nextval ? { label: 'New query: NEXTVAL', icon: 'play', onClick: () => Lookup.openQueryTab({ text: Lookup.fill(Lookup.profile().nextval, { qname: `${qident(owner)}.${qident(o.name)}` }) }) } : null,
      { label: 'Copy name', icon: 'copy', onClick: () => api.copy(o.name) },
      { label: 'Copy qualified name', onClick: () => api.copy(fq) },
      o.type === 'TABLE' && (Lookup.feature('truncate') || Lookup.feature('dropTable')) ? '-' : null,
      o.type === 'TABLE' && Lookup.feature('truncate') ? { label: 'Truncate table…', icon: 'eraser', danger: true, onClick: () => truncateTableUI(owner, o.name) } : null,
      o.type === 'TABLE' && Lookup.feature('dropTable') ? { label: 'Delete table…', icon: 'trash', danger: true, onClick: () => dropTableUI(owner, o.name) } : null,
    ].filter(Boolean));
  }
  // Asks before a destructive action. On Production the table name must be typed.
  function confirmDestructive({ title, text, okLabel, owner, name, extra = [] }) {
    return new Promise((resolve) => {
      const prod = S.current && S.current.env === 'prod';
      const typed = h('input', { class: 'input mono', placeholder: name, spellcheck: 'false' });
      const okBtn = () => document.querySelector('.modal-back:last-child .modal-foot .btn.danger');
      const sync = () => { const b = okBtn(); if (b) b.disabled = prod && typed.value.trim() !== name; };
      typed.addEventListener('input', sync);
      const opts = {};
      const checks = extra.map((x) => {
        const cb = h('input', { type: 'checkbox', onchange: (e) => { opts[x.key] = e.target.checked; } });
        return h('label', { class: 'check' }, cb, h('span', null, x.label));
      });
      let done = false;
      modal({
        title,
        body: h('div', { class: 'se-form' },
          h('p', { class: 'danger-note' }, text),
          h('p', { class: 'mono strong' }, `${owner}.${name}`),
          S.txPending && !S.autoCommit ? h('p', { class: 'muted' }, (Lookup.profile().design || {}).commitsOpenTx ? Lookup.profile().design.openTxNote : 'This also commits your open transaction (Oracle commits before and after DDL).') : null,
          ...checks,
          prod ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Production connection: type the table name to confirm'), typed) : null),
        actions: [
          { label: 'Cancel', onClick: () => { done = true; resolve(null); } },
          { label: okLabel, kind: 'danger', onClick: () => { if (prod && typed.value.trim() !== name) return false; done = true; resolve(opts); return true; } },
        ],
        onClose: () => { if (!done) resolve(null); },
      });
      setTimeout(sync, 0);
    });
  }
  // What this engine's truncate / drop do and offer (profile.design); Oracle's when the engine says nothing.
  const tableDesign = () => ({
    truncateNote: 'Removes every row from the table immediately. This cannot be rolled back.',
    dropOptions: [
      { key: 'cascade', label: 'Also drop foreign keys in other tables that reference it (CASCADE CONSTRAINTS)' },
      { key: 'purge', label: 'Skip the recycle bin (PURGE) — cannot be restored with FLASHBACK' },
    ],
    ...(Lookup.profile().design || {}),
  });
  async function truncateTableUI(owner, name) {
    const ok = await confirmDestructive({
      title: 'Truncate table', okLabel: 'Truncate', owner, name,
      text: tableDesign().truncateNote,
    });
    if (!ok) return;
    try {
      await api.truncateTable(owner, name);
      S.txPending = false;
      Lookup.renderTitlebar(); Lookup.renderStatus();
      toast(`Truncated ${name}`, 'ok');
      const t = S.tabs.find((x) => x.kind === 'table' && x.owner === owner && x.name === name);
      if (t) { t.offset = 0; if (t.view === 'data') t.reload(true); else { if (t.grid) { t.grid.destroy(); t.grid = null; } t.data = null; } }
    } catch (e) {
      modal({ title: 'Could not truncate', body: h('pre', { class: 'err-text' }, e.message + (/ORA-02266/.test(e.message) ? '\n\nOther tables have enabled foreign keys pointing at this one. Disable them, or delete rows instead.' : '')), actions: [{ label: 'OK', kind: 'primary' }] });
    }
  }
  async function dropTableUI(owner, name) {
    const opts = await confirmDestructive({
      title: 'Delete table', okLabel: 'Delete table', owner, name,
      text: 'Drops the table with all its data, indexes, constraints and triggers.',
      extra: tableDesign().dropOptions,
    });
    if (!opts) return;
    try {
      await api.dropTable(owner, name, opts);
      S.txPending = false;
      Lookup.renderTitlebar(); Lookup.renderStatus();
      for (const t of S.tabs.filter((x) => x.owner === owner && x.name === name)) await Lookup.closeTab(t.id, true);
      S.colCache.delete(owner + '.' + name);
      S.objCache.delete(owner);
      if (S.schema === owner) await loadObjects(true);
      toast(`Deleted table ${name}`, 'ok');
    } catch (e) {
      modal({ title: 'Could not delete table', body: h('pre', { class: 'err-text' }, e.message + (/ORA-02449/.test(e.message) ? '\n\nOther tables reference it with foreign keys. Tick “CASCADE CONSTRAINTS” to drop those keys too.' : '')), actions: [{ label: 'OK', kind: 'primary' }] });
    }
  }
  function openObject(owner, o, view) {
    if (['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'DICTIONARY'].includes(o.type)) Lookup.openTableTab(owner, o.name, o.type, view);
    else Lookup.openDdlTab(owner, o);
  }
  // ---------- Open anything (Ctrl+P) ----------
  function openAnything() {
    if (!S.current) return;
    const input = h('input', { class: 'input big', placeholder: `Jump to a table, view or program in ${S.schema}` });
    const list = h('div', { class: 'qs-list' });
    let idx = 0;
    let items = [];
    let m;
    const paint = () => {
      const q = input.value.trim().toUpperCase();
      const score = (n) => (n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3);
      const up = (n) => n.toUpperCase();
      items = S.objects.filter((o) => !q || up(o.name).includes(q) || fuzzy(up(o.name), q)).sort((a, b) => score(up(a.name)) - score(up(b.name)) || a.name.length - b.name.length).slice(0, 50);
      idx = Math.min(idx, Math.max(0, items.length - 1));
      list.innerHTML = '';
      items.forEach((o, i) => list.append(h('div', {
        class: 'qs-item' + (i === idx ? ' sel' : ''),
        onmousedown: (e) => { e.preventDefault(); m.close(); openObject(S.schema, o); },
      }, icon(TYPE_ICON[o.type] || 'table'), h('span', { class: 'mono' }, o.name), h('span', { class: 'muted' }, o.type.toLowerCase()))));
      const s = list.children[idx];
      if (s) s.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { idx = 0; paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); paint(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); paint(); }
      if (e.key === 'Enter' && items[idx]) { e.preventDefault(); m.close(); openObject(S.schema, items[idx]); }
    });
    paint();
    m = modal({ title: 'Open anything', body: h('div', { class: 'qs' }, input, list) });
  }
  function fuzzy(name, q) {
    let i = 0;
    for (const ch of name) if (ch === q[i]) i++;
    return i === q.length;
  }
  function initSidebarResize() {
    const rz = $('#sb-resizer');
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = $('#sidebar').getBoundingClientRect().width;
      document.body.classList.add('resizing');
      const move = (ev) => {
        const w = Math.max(180, Math.min(520, w0 + ev.clientX - x0));
        document.documentElement.style.setProperty('--sidebar-w', w + 'px');
      };
      const up = () => {
        document.body.classList.remove('resizing');
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        try { localStorage.setItem('lookup.sidebarW', getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')); } catch { /* ignore */ }
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    try {
      const w = localStorage.getItem('lookup.sidebarW');
      if (w) document.documentElement.style.setProperty('--sidebar-w', w);
    } catch { /* ignore */ }
  }

  Object.assign(Lookup, { renderSidebarShell, paintSchemaSelect, getObjects, loadObjects, openAnything, initSidebarResize });
})();
