// MongoDB workspace: the sidebar (databases and their collections with document counts, filter,
// menus: new / rename / drop), the status bar, and the value views shared by the MongoDB tabs:
// mongosh text with colours, and documents as an expandable field tree.
(function () {
  const { h, icon, toast, modal, contextMenu, fmtBytes, debounce } = window.U;
  const api = window.api;
  const $ = (sel, root = document) => root.querySelector(sel);
  const Lookup = window.Lookup;
  const { S } = Lookup;
  const L = window.MongoLit;

  const isMongo = () => !!S.info && Lookup.profile().workspace === 'mongodb';
  const M = { dbs: [], colls: new Map(), open: new Set(), filter: '', note: null };
  const rop = (...a) => Lookup.rop(...a);
  const fail = (e) => Lookup.opFail(e);

  /** 1.24 M, 312 K, 4,102 */
  function fmtCount(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 2) + ' B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + ' M';
    if (n >= 1e5) return Math.round(n / 1e3) + ' K';
    return Number(n).toLocaleString();
  }

  // ---------- Coloured mongosh text ----------
  const TOKEN = /(ObjectId|ISODate|Long|Decimal128|UUID|Timestamp|Binary\.createFromBase64|MinKey|MaxKey|Code|DBRef)\('[^']*'(?:,\s*\d+)?\)|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\/(?:[^/\\\n]|\\.)+\/[a-z]*(?=[,\s\]}]|$)|\b-?\d+(?:\.\d+)?(?:e[-+]?\d+)?\b|\b(?:true|false|null|undefined)\b|\$[A-Za-z]+|[A-Za-z_$][\w$]*(?=\s*:)/g;
  function classOf(tok) {
    if (/^(ObjectId|DBRef)/.test(tok)) return 'mv-oid';
    if (/^ISODate|^Timestamp/.test(tok)) return 'mv-date';
    if (/^(Long|Decimal128)/.test(tok)) return 'mv-num';
    if (/^(UUID|Binary|MinKey|MaxKey|Code)/.test(tok)) return 'mv-bin';
    if (/^['"]/.test(tok)) return 'mv-str';
    if (/^\//.test(tok)) return 'mv-re';
    if (/^-?\d/.test(tok)) return 'mv-num';
    if (/^(true|false|null|undefined)$/.test(tok)) return 'mv-kw';
    if (/^\$/.test(tok)) return 'mv-op';
    return 'mv-key';
  }
  /** mongosh text -> a fragment with coloured spans. */
  function highlight(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const s = String(text);
    for (const m of s.matchAll(TOKEN)) {
      if (m.index > last) frag.append(s.slice(last, m.index));
      frag.append(h('span', { class: classOf(m[0]) }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.append(s.slice(last));
    return frag;
  }

  // ---------- Documents as a field tree ----------
  /**
   * A document as rows of "field: value", objects and arrays collapsed to "Object · 4 fields" with a
   * chevron (open: expanded one level). changed: { field: oldValue } marks edited top-level fields.
   */
  function docTree(doc, { open = new Set(), changed = null, path = '' } = {}) {
    const box = h('div', { class: 'mt' });
    const row = (k, v, p, depth) => {
      const t = L.typeOf(v);
      const container = t === 'Object' || t === 'Array';
      const isOpen = open.has(p);
      const keyEl = h('span', { class: 'mt-key' }, `${k}:`);
      const line = h('div', { class: 'mt-row' + (changed && depth === 0 && Object.prototype.hasOwnProperty.call(changed, k) ? ' changed' : ''), style: { paddingLeft: depth * 18 + 'px' } });
      if (container) {
        const n = t === 'Array' ? v.length : Object.keys(v).length;
        line.append(h('span', { class: 'mt-chev' + (isOpen ? ' open' : '') }, icon('chevron')), keyEl,
          h('span', { class: 'mt-type' }, `${t} · ${n} ${t === 'Array' ? (n === 1 ? 'element' : 'elements') : n === 1 ? 'field' : 'fields'}`));
        line.classList.add('mt-container');
        line.addEventListener('click', () => { if (open.has(p)) open.delete(p); else open.add(p); const fresh = docTree(doc, { open, changed, path }); box.replaceWith(fresh); });
      } else {
        line.append(h('span', { class: 'mt-sp' }), keyEl, h('span', { class: 'mt-val' }, highlight(L.scalarText(v))));
        if (changed && depth === 0 && Object.prototype.hasOwnProperty.call(changed, k)) {
          line.append(h('span', { class: 'mt-type' }, `${t} · was ${changed[k] === undefined ? 'missing' : L.cellText(changed[k])}`));
        }
      }
      box.append(line);
      if (container && isOpen) {
        const entries = t === 'Array' ? v.map((x, i) => [String(i), x]) : Object.entries(v);
        for (const [ck, cv] of entries.slice(0, 500)) row(ck, cv, `${p}.${ck}`, depth + 1);
        if (entries.length > 500) box.append(h('div', { class: 'mt-row muted', style: { paddingLeft: (depth + 1) * 18 + 'px' } }, `… ${entries.length - 500} more`));
      }
    };
    for (const [k, v] of Object.entries(doc)) row(k, v, `${path}${k}`, 0);
    if (changed) for (const k of Object.keys(changed)) if (!(k in doc)) box.append(h('div', { class: 'mt-row removed' }, h('span', { class: 'mt-sp' }), h('span', { class: 'mt-key' }, `${k}:`), h('span', { class: 'mt-type' }, 'removed')));
    return box;
  }

  // ---------- Entering ----------
  let emptyHtml = null;
  function setEmptyState() {
    const box = $('#empty-state');
    if (emptyHtml === null) emptyHtml = box.innerHTML;
    const mod = S.platform === 'darwin' ? '⌘' : 'Ctrl';
    box.innerHTML = '';
    box.append(h('div', { class: 'empty-mark' }), h('h2', null, 'Pick a collection from the sidebar'), h('p', { class: 'muted' }, 'or type commands in the Shell'),
      h('div', { class: 'shortcuts' }, ...[[[mod, 'T'], 'Shell'], [[mod, 'P'], 'Find a collection'], [[mod, 'Enter'], 'Find (in the filter bar)'], [[mod, 'S'], 'Save the document being edited']]
        .map(([keys, label]) => h('div', null, keys.map((k) => h('kbd', null, k)), h('span', null, label)))));
  }

  async function enterMongo() {
    setEmptyState();
    Object.assign(M, { dbs: [], colls: new Map(), open: new Set([S.info.dbName]), filter: '' });
    renderSidebar();
    Lookup.renderTabs();
    await loadDatabases();
  }

  async function loadDatabases() {
    try {
      const r = await rop('databases');
      M.dbs = r.list;
      M.note = r.note;
    } catch (e) { fail(e); }
    await Promise.all([...M.open].map((d) => loadCollections(d, false)));
    paintTree();
  }

  async function loadCollections(db, paint = true) {
    try { M.colls.set(db, await rop('collections', { db })); } catch (e) { M.colls.set(db, { error: e.message }); }
    if (paint) paintTree();
  }

  // ---------- Sidebar ----------
  function renderSidebar() {
    const sb = $('#sidebar');
    sb.innerHTML = '';
    const filter = h('input', {
      class: 'input sm', id: 'm-filter', placeholder: 'Filter databases and collections', spellcheck: 'false',
      oninput: debounce(() => { M.filter = filter.value.trim().toLowerCase(); paintTree(); }, 120),
      onkeydown: (e) => { if (e.key === 'Escape' && filter.value) { e.preventDefault(); e.stopPropagation(); filter.value = ''; M.filter = ''; paintTree(); } },
    });
    const top = S.info.topology ? `${S.info.topology[0].toUpperCase()}${S.info.topology.slice(1)}${S.info.atlas ? ' · Atlas' : ''}` : 'MongoDB';
    sb.append(
      h('div', { class: 'sb-top' },
        h('div', { class: 'sb-row m-top' }, icon('db'), h('span', { class: 'm-topo', title: `${Lookup.profile().label} ${S.info.version}` }, top),
          h('button', { class: 'icon-btn', title: 'Reload databases and collections', onclick: () => { M.colls.clear(); loadDatabases(); } }, icon('refresh')),
          h('button', { class: 'icon-btn', title: 'New collection (or database)', onclick: () => newCollection() }, icon('plus'))),
        h('div', { class: 'sb-search' }, icon('search'), filter)),
      h('div', { class: 'tree m-tree', id: 'tree' }),
      h('div', { class: 'r-scanbar m-foot', id: 'm-foot' }));
  }

  function paintTree() {
    const tree = $('#tree');
    if (!tree) return;
    tree.innerHTML = '';
    const q = M.filter;
    const active = S.tabs.find((t) => t.id === S.active);
    for (const d of M.dbs) {
      const colls = M.colls.get(d.name);
      const list = Array.isArray(colls) ? colls : [];
      const hits = q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list;
      if (q && !d.name.toLowerCase().includes(q) && !hits.length) continue;
      const open = M.open.has(d.name) || (q && hits.length);
      tree.append(h('div', {
        class: 'r-row r-folder m-db' + (open ? ' open' : ''), title: `${d.name}${d.size ? ' · ' + fmtBytes(d.size) + ' on disk' : ''}`,
        onclick: () => { if (M.open.has(d.name)) M.open.delete(d.name); else { M.open.add(d.name); if (!M.colls.has(d.name)) loadCollections(d.name); } paintTree(); },
        oncontextmenu: (e) => dbMenu(e, d),
      }, icon('chevron', 'chev'), icon('db'), h('span', { class: 'r-folder-name' }, d.name), h('span', { class: 'r-count' }, Array.isArray(colls) ? String(colls.length) : d.size ? fmtBytes(d.size) : '')));
      if (!open) continue;
      if (!colls) { tree.append(h('div', { class: 'tree-loading m-sub' }, h('div', { class: 'spinner sm' }), 'Loading…')); continue; }
      if (colls.error) { tree.append(h('div', { class: 'tree-error' }, colls.error)); continue; }
      if (!list.length) tree.append(h('div', { class: 'empty-small m-sub' }, 'No collections'));
      for (const c of (q && !d.name.toLowerCase().includes(q) ? hits : list)) {
        const on = active && active.kind === 'mcoll' && active.db === d.name && active.coll === c.name;
        tree.append(h('div', {
          class: 'r-row r-key m-coll' + (on ? ' active' : ''), title: `${d.name}.${c.name}${c.viewOn ? ` · view on ${c.viewOn}` : ''}`,
          onclick: () => Lookup.openMongoCollection(d.name, c.name),
          oncontextmenu: (e) => collMenu(e, d.name, c),
        }, icon(c.type === 'view' ? 'view' : c.type === 'timeseries' ? 'clock' : 'folder'), h('span', { class: 'r-key-name' }, c.name),
        c.type === 'view' ? h('span', { class: 'm-tag' }, 'VIEW') : c.type === 'timeseries' ? h('span', { class: 'm-tag' }, 'TS') : null,
        h('span', { class: 'r-size' }, c.type === 'view' ? '' : fmtCount(c.count))));
      }
    }
    if (!M.dbs.length) tree.append(h('div', { class: 'empty-small' }, 'No databases'));
    const foot = $('#m-foot');
    if (foot) { foot.innerHTML = ''; foot.append(h('span', { class: 'muted' }, M.note || `${M.dbs.length} database${M.dbs.length === 1 ? '' : 's'} · ${Lookup.profile().label} ${S.info.version}`)); }
  }
  function paintTreeActive() {
    const active = S.tabs.find((t) => t.id === S.active);
    document.querySelectorAll('#tree .m-coll').forEach((el) => el.classList.toggle('active', !!active && active.kind === 'mcoll' && el.title.split(' · ')[0] === `${active.db}.${active.coll}`));
  }

  /** Asks for a name; for drops the user types the exact name (any tag). */
  function typeToConfirm(title, text, name, ok) {
    return new Promise((resolve) => {
      const input = h('input', { class: 'input mono', placeholder: name, spellcheck: 'false' });
      let done = false;
      modal({
        title,
        body: h('div', null, h('p', { class: 'muted' }, text), h('p', null, 'Type ', h('b', { class: 'mono' }, name), ' to confirm.'), input),
        actions: [{ label: 'Cancel' }, { label: ok, kind: 'danger', onClick: () => { if (input.value !== name) { toast('The name doesn\'t match', 'err'); return false; } done = true; resolve(true); return true; } }],
        onClose: () => { if (!done) resolve(false); },
      });
    });
  }

  function dbMenu(e, d) {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'New collection…', icon: 'plus', onClick: () => newCollection(d.name) },
      { label: 'Refresh', icon: 'refresh', onClick: () => loadCollections(d.name) },
      { label: 'Copy name', icon: 'copy', onClick: () => api.copy(d.name) },
      '-',
      { label: 'Drop database…', icon: 'trash', danger: true, disabled: d.system, onClick: async () => {
        if (!(await typeToConfirm('Drop database', `Every collection in ${d.name} will be deleted. This can't be undone.`, d.name, 'Drop database'))) return;
        try {
          await rop('dropDatabase', { db: d.name }, { describe: `use ${d.name}; db.dropDatabase()` });
          for (const t of [...S.tabs]) if (t.db === d.name) await Lookup.closeTab(t.id, true);
          toast(`Dropped ${d.name}`, 'ok');
          M.colls.delete(d.name);
          loadDatabases();
        } catch (err) { fail(err); }
      } },
    ]);
  }
  function collMenu(e, db, c) {
    e.preventDefault();
    const open = (section) => Lookup.openMongoCollection(db, c.name, section);
    contextMenu(e.clientX, e.clientY, [
      { label: 'Open documents', icon: 'table', onClick: () => open('docs') },
      { label: 'Aggregations', icon: 'playAll', onClick: () => open('agg') },
      { label: 'Schema', icon: 'columns', onClick: () => open('schema') },
      { label: 'Indexes', icon: 'key', disabled: c.type === 'view', onClick: () => open('indexes') },
      '-',
      { label: 'Copy name', icon: 'copy', onClick: () => api.copy(c.name) },
      { label: 'Copy as db.getCollection(…)', onClick: () => api.copy(`db.getCollection('${c.name}')`) },
      { label: 'Rename…', icon: 'edit', disabled: c.type === 'view', onClick: () => renameCollection(db, c.name) },
      '-',
      { label: c.type === 'view' ? 'Drop view…' : 'Drop collection…', icon: 'trash', danger: true, onClick: async () => {
        if (!(await typeToConfirm(c.type === 'view' ? 'Drop view' : 'Drop collection', `${db}.${c.name} and its documents and indexes will be deleted. This can't be undone.`, c.name, 'Drop'))) return;
        try {
          await rop('dropCollection', { db, coll: c.name }, { describe: `db.${c.name}.drop()` });
          for (const t of [...S.tabs]) if (t.db === db && t.coll === c.name) await Lookup.closeTab(t.id, true);
          toast(`Dropped ${c.name}`, 'ok');
          loadCollections(db);
        } catch (err) { fail(err); }
      } },
    ]);
  }
  async function renameCollection(db, coll) {
    const to = await Lookup.askText('Rename collection', 'New name', coll, { ok: 'Rename' });
    if (to === null || to === coll) return;
    try {
      await rop('renameCollection', { db, coll, to }, { describe: `db.${coll}.renameCollection('${to}')` });
      for (const t of [...S.tabs]) if (t.db === db && t.coll === coll) await Lookup.closeTab(t.id, true);
      loadCollections(db);
      toast('Collection renamed', 'ok', 1500);
    } catch (e) { fail(e); }
  }

  function newCollection(db) {
    const st = { db: db || [...M.open][0] || S.info.dbName || 'test', name: '', kind: 'collection', timeField: '', metaField: '', size: '' };
    const inp = (k, attrs = {}) => { const el = h('input', { class: 'input mono', spellcheck: 'false', ...attrs, oninput: (e) => { st[k] = e.target.value; } }); el.value = st[k]; return el; };
    const fld = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el, hint ? h('span', { class: 'field-hint' }, hint) : null);
    const extra = h('div');
    const paint = () => {
      extra.innerHTML = '';
      if (st.kind === 'timeseries') extra.append(h('div', { class: 'grid2' }, fld('Time field', inp('timeField', { placeholder: 'ts' })), fld('Meta field (optional)', inp('metaField', { placeholder: 'sensor' }))));
      if (st.kind === 'capped') extra.append(fld('Size (bytes)', inp('size', { type: 'number', placeholder: '1048576' })));
    };
    const kind = h('select', { class: 'input', onchange: (e) => { st.kind = e.target.value; paint(); } },
      h('option', { value: 'collection' }, 'Collection'), h('option', { value: 'timeseries' }, 'Time-series collection'), h('option', { value: 'capped' }, 'Capped collection'));
    paint();
    modal({
      title: 'New collection',
      body: h('div', null,
        h('div', { class: 'grid2' }, fld('Database', inp('db'), 'An existing one, or a new name: MongoDB creates it with the collection.'), fld('Collection', inp('name', { placeholder: 'orders' }))),
        fld('Kind', kind), extra),
      actions: [{ label: 'Cancel' }, {
        label: 'Create', kind: 'primary', onClick: async () => {
          if (!st.db.trim() || !st.name.trim()) { toast('Enter the database and collection names', 'err'); return false; }
          const options = st.kind === 'timeseries' ? { timeField: st.timeField, metaField: st.metaField } : st.kind === 'capped' ? { capped: true, size: Number(st.size) || 1048576 } : {};
          if (st.kind === 'timeseries' && !st.timeField) { toast('Enter the time field', 'err'); return false; }
          try {
            await rop('createCollection', { db: st.db.trim(), name: st.name.trim(), options }, { describe: `use ${st.db}; db.createCollection('${st.name}')` });
            M.open.add(st.db.trim());
            await loadDatabases();
            Lookup.openMongoCollection(st.db.trim(), st.name.trim());
            return true;
          } catch (e) { fail(e); return false; }
        },
      }],
    });
  }

  // ---------- Status bar ----------
  function mongoWhere() {
    const c = S.current;
    return `${Lookup.target(c)}`.replace(/ · read-only$/, '');
  }
  function mongoStatusItems() {
    return [
      S.info.topology ? h('span', { class: 'sb-item muted' }, `${S.info.topology}${S.info.atlas ? ' · Atlas' : ''}`) : null,
      S.current && S.current.readOnly ? h('span', { class: 'sb-item muted' }, 'Read-only') : null,
    ].filter(Boolean);
  }
  async function mongoReconnected() {
    for (const t of S.tabs) if (t.onReconnected) await t.onReconnected();
    loadDatabases();
  }

  // ---------- Shared shortcuts ----------
  Lookup.whenLoaded(() => {
    const wrap = (name, fn) => { const orig = Lookup[name]; Lookup[name] = (...a) => (isMongo() ? fn(...a) : orig(...a)); };
    wrap('openQueryTab', () => Lookup.openMongoShell());
    wrap('openAnything', () => { const f = $('#m-filter'); if (f) { f.focus(); f.select(); } });
    wrap('commitShortcut', () => { const t = S.tabs.find((x) => x.id === S.active); if (t && t.save) t.save(); });
    wrap('saveQueryTabs', () => {});
    const act = Lookup.activate;
    Lookup.activate = (id) => { act(id); if (isMongo()) paintTreeActive(); };
  });

  Object.assign(Lookup, {
    isMongo, enterMongo, M, mongoHighlight: highlight, mongoTree: docTree, fmtCount, mongoWhere, mongoStatusItems, mongoReconnected,
    mongoLoadCollections: loadCollections, mongoPaintActive: paintTreeActive, mongoTypeToConfirm: typeToConfirm,
  });
})();
