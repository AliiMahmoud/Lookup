// MongoDB collection tabs: Documents (filter / project / sort / limit, List, JSON and Table views,
// edit, insert, clone, delete, export), Aggregations (stages with a preview each, text mode, run,
// explain, saved pipelines, copy as code), Schema (field analysis of a sample), Indexes (with usage,
// create / drop, explain of the current query) and Validation (rules, level, action).
(function () {
  const { h, icon, toast, modal, confirmBox, contextMenu, fmtNum, fmtBytes, fmtMs, debounce } = window.U;
  const api = window.api;
  const Lookup = window.Lookup;
  const { S } = Lookup;
  const L = window.MongoLit;
  const rop = (...a) => Lookup.rop(...a);
  const fail = (e) => Lookup.opFail(e);
  const hl = (t) => Lookup.mongoHighlight(t);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } },
  };
  const nsKey = (t, what) => `lookup.mongo.${what}.${S.current && S.current.id}.${t.db}.${t.coll}`;

  /** Parses mongosh text; on a mistake shows where and returns undefined. */
  function parseOr(text, what, { empty = {} } = {}) {
    try { return L.parse(text, { empty }); } catch (e) {
      toast(`${what}: ${e.message}${e.pos !== undefined ? ` (at ${e.pos + 1})` : ''}`, 'err', 5000);
      return undefined;
    }
  }
  const printDoc = (d) => L.print(d, { width: 80 });

  // ---------- Tab ----------
  const SECTIONS = [['docs', 'Documents'], ['agg', 'Aggregations'], ['schema', 'Schema'], ['indexes', 'Indexes'], ['validation', 'Validation']];

  function openMongoCollection(db, coll, section = 'docs') {
    const existing = S.tabs.find((t) => t.kind === 'mcoll' && t.db === db && t.coll === coll);
    if (existing) { Lookup.activate(existing.id); existing.show(section); return existing; }
    const tab = { kind: 'mcoll', db, coll, title: `${db}.${coll}`, name: `${db}.${coll}`, icon: 'folder', el: h('div', { class: 'tabview m-collview' }), sections: {}, editing: 0 };
    tab.grid = { changeCount: () => tab.editing };
    tab.onShow = () => Lookup.mongoPaintActive();
    tab.onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); if (tab.save) tab.save(); return true; }
      return false;
    };
    const pills = h('div', { class: 'm-pills' });
    const subtabs = h('div', { class: 'm-subtabs' });
    const body = h('div', { class: 'm-sectionbox' });
    tab.el.append(
      h('div', { class: 'm-collhead' }, icon('folder'), h('span', { class: 'm-ns' }, h('span', { class: 'muted' }, `${db}.`), coll),
        h('button', { class: 'icon-btn', title: 'Copy the name', onclick: () => { api.copy(coll); toast('Copied', 'ok', 1200); } }, icon('copy')),
        h('div', { class: 'spacer' }), pills,
        h('button', { class: 'icon-btn', title: 'Reload statistics', onclick: () => loadStats(tab, pills) }, icon('refresh'))),
      subtabs, body);
    tab.show = (id) => {
      tab.section = id;
      subtabs.innerHTML = '';
      for (const [sid, label] of SECTIONS) subtabs.append(h('button', { type: 'button', class: 'm-subtab' + (sid === id ? ' on' : ''), onclick: () => tab.show(sid) }, label));
      for (const el of Object.values(tab.sections)) el.classList.add('hidden');
      if (!tab.sections[id]) { tab.sections[id] = h('div', { class: 'm-section' }); body.append(tab.sections[id]); BUILD[id](tab, tab.sections[id]); }
      tab.sections[id].classList.remove('hidden');
      if (tab.onSection) tab.onSection(id);
    };
    Lookup.addTab(tab);
    loadStats(tab, pills);
    tab.show(section);
    return tab;
  }

  async function loadStats(tab, pills) {
    try {
      const st = await rop('collStats', { db: tab.db, coll: tab.coll });
      tab.stats = st;
      pills.innerHTML = '';
      const pill = (t) => h('span', { class: 'r-pill static' }, t);
      if (st.count !== null) pills.append(pill(`${Lookup.fmtCount(st.count)} document${st.count === 1 ? '' : 's'}`));
      if (st.size !== null && st.size !== undefined) pills.append(pill(`${fmtBytes(st.size)}${st.avgObjSize ? ` · avg ${fmtBytes(Math.round(st.avgObjSize))}` : ''}`));
      if (st.indexes !== null && st.indexes !== undefined) pills.append(pill(`${st.indexes} index${st.indexes === 1 ? '' : 'es'}${st.indexSize ? ` · ${fmtBytes(st.indexSize)}` : ''}`));
    } catch { /* statistics are optional */ }
  }

  // ---------- Explain (shared by Documents, Aggregations, Indexes) ----------
  function explainView(x) {
    const box = h('div', { class: 'm-explain' });
    const flow = h('div', { class: 'm-xflow' });
    x.stages.forEach((st, i) => {
      if (i) flow.append(h('span', { class: 'm-xarrow' }, '→'));
      const facts = [st.index ? st.index : null, st.keysExamined !== null ? `${fmtNum(st.keysExamined)} keys` : null, st.docsExamined !== null ? `${fmtNum(st.docsExamined)} docs examined` : null, st.nReturned !== null ? `${fmtNum(st.nReturned)} returned` : null,
        st.sortPattern ? `sort ${L.print(st.sortPattern)}` : null].filter(Boolean).join(' · ');
      flow.append(h('div', { class: 'm-xnode' + (st.stage === 'COLLSCAN' ? ' bad' : /IXSCAN|IDHACK/.test(st.stage) ? ' good' : '') }, h('b', null, st.stage), facts ? h('div', null, facts) : null));
    });
    const tips = [];
    if (x.collScan) tips.push(h('span', null, h('b', { class: 'err-text-inline' }, 'No index used. '), 'Every document was read; an index on the filter fields would help.'));
    else if (x.usesIndex) tips.push(h('span', null, h('b', { class: 'ok-text' }, 'Uses an index. ')));
    if (x.inMemorySort) tips.push(h('span', null, 'Sorted in memory: an index that matches the sort would avoid it.'));
    box.append(flow,
      h('div', { class: 'm-xsum muted' }, [x.nReturned !== null ? `${fmtNum(x.nReturned)} returned` : null, x.docsExamined !== null ? `${fmtNum(x.docsExamined)} documents examined` : null,
        x.keysExamined !== null ? `${fmtNum(x.keysExamined)} keys examined` : null, x.ms !== null ? `${x.ms} ms` : null].filter(Boolean).join(' · ')),
      tips.length ? h('div', { class: 'm-xtips' }, tips) : null,
      h('details', { class: 'm-xraw' }, h('summary', null, 'Full plan'), h('pre', { class: 'm-code' }, hl(L.print(x.raw, { width: 100 })))));
    return box;
  }

  // ---------- Documents ----------
  function buildDocs(tab, el) {
    const q = { filter: '', project: '', sort: '', limit: 20, page: 0 };
    let view = store.get('lookup.mongo.view', 'list');
    let docs = [];
    let total = null;
    let lastMs = null;
    const fieldInput = (k, ph, cls = '') => {
      const i = h('input', { class: 'input sm mono m-qin ' + cls, placeholder: ph, spellcheck: 'false', oninput: (e) => { q[k] = e.target.value; check(i, k); } });
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); find(true); } });
      return i;
    };
    // Shows a red edge while the text isn't a valid value.
    const check = (i, k) => { try { L.parse(q[k]); i.classList.remove('bad'); i.title = ''; } catch (e) { i.classList.add('bad'); i.title = e.message; } };
    const fIn = fieldInput('filter', "{ status: 'paid', total: { $gte: 100 } }", 'grow');
    const pIn = fieldInput('project', '{ items: 0 }', 'grow');
    const sIn = fieldInput('sort', '{ createdAt: -1 }');
    const lIn = h('input', { class: 'input sm m-qin m-limit', type: 'number', min: '1', max: '1000', value: '20', onchange: (e) => { q.limit = Math.max(1, Math.min(1000, Number(e.target.value) || 20)); } });
    const qbar = h('div', { class: 'm-qbar' },
      h('div', { class: 'm-qrow' }, h('span', { class: 'm-qlabel' }, 'Filter'), fIn,
        h('button', { class: 'btn sm primary', title: 'Find (Enter)', onclick: () => find(true) }, icon('play'), 'Find'),
        h('button', { class: 'btn sm', onclick: () => { Object.assign(q, { filter: '', project: '', sort: '', page: 0 }); fIn.value = pIn.value = sIn.value = ''; [fIn, pIn, sIn].forEach((i) => i.classList.remove('bad')); find(true); } }, 'Reset'),
        h('button', { class: 'btn sm ghost', title: 'How the server runs this query', onclick: () => explain() }, 'Explain'),
        h('button', { class: 'icon-btn', title: 'Query history', onclick: (e) => historyMenu(e) }, icon('history'))),
      h('div', { class: 'm-qrow' }, h('span', { class: 'm-qlabel' }, 'Project'), pIn, h('span', { class: 'm-qlabel' }, 'Sort'), sIn, h('span', { class: 'm-qlabel short' }, 'Limit'), lIn));
    const range = h('span', { class: 'muted m-range' });
    const prev = h('button', { class: 'icon-btn', title: 'Previous page', onclick: () => { if (q.page > 0) { q.page--; find(false); } } }, icon('chevron', 'flip'));
    const next = h('button', { class: 'icon-btn', title: 'Next page', onclick: () => { q.page++; find(false); } }, icon('chevron'));
    const seg = h('div', { class: 'seg sm' }, [['list', 'List'], ['json', 'JSON'], ['table', 'Table']].map(([v, l]) => h('button', {
      type: 'button', class: v === view ? 'on' : '', onclick: (e) => { view = v; store.set('lookup.mongo.view', v); e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); paint(); },
    }, l)));
    const toolbar = h('div', { class: 'r-toolbar' },
      h('button', { class: 'btn sm', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom + 4, [{ label: 'Insert document…', icon: 'plus', onClick: () => insertDialog() }, { label: 'Insert many (paste an array)…', icon: 'playAll', onClick: () => insertDialog(true) }]); } }, icon('plus'), 'Add data ▾'),
      h('button', { class: 'btn sm ghost', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom + 4, [{ label: 'Export as JSON (array)', onClick: () => exportDocs('json') }, { label: 'Export as CSV', onClick: () => exportDocs('csv') }]); } }, icon('download'), 'Export'),
      h('div', { class: 'spacer' }), range, prev, next, seg);
    const list = h('div', { class: 'm-docs' });
    const foot = h('div', { class: 'r-foot' }, h('div', { class: 'r-foot-left muted' }), h('div', { class: 'spacer' }), h('div', { class: 'r-foot-right muted' }));
    el.append(qbar, toolbar, list, foot);

    function queryParts() {
      const filter = parseOr(q.filter, 'Filter'); if (filter === undefined) return null;
      const project = parseOr(q.project, 'Project'); if (project === undefined) return null;
      const sort = parseOr(q.sort, 'Sort'); if (sort === undefined) return null;
      return { filter, project, sort };
    }
    tab.query = () => queryParts();
    async function find(fresh) {
      const parts = queryParts();
      if (!parts) return;
      if (tab.editing && !(await confirmBox('Unsaved document', 'A document you are editing has not been saved. Drop the change?', 'Drop change', true))) return;
      tab.editing = 0;
      Lookup.paintTabState();
      if (fresh) q.page = 0;
      list.classList.add('loading');
      try {
        const r = await rop('find', { db: tab.db, coll: tab.coll, ...parts, skip: q.page * q.limit, limit: q.limit });
        docs = r.docs;
        lastMs = r.ms;
        if (fresh) {
          total = null;
          remember();
          rop('count', { db: tab.db, coll: tab.coll, filter: parts.filter }).then((c) => { total = c; paintRange(); }).catch(() => { total = null; paintRange(); });
        }
      } catch (e) { fail(e); docs = []; } finally { list.classList.remove('loading'); }
      paint();
    }
    tab.find = find;
    function paintRange() {
      const from = docs.length ? q.page * q.limit + 1 : 0;
      const to = q.page * q.limit + docs.length;
      range.textContent = `${fmtNum(from)} – ${fmtNum(to)}${total ? ` of ${total.estimated ? '~' : ''}${fmtNum(total.count)}` : ''}`;
      prev.disabled = q.page === 0;
      next.disabled = docs.length < q.limit || (total && !total.estimated && to >= total.count);
      foot.firstChild.textContent = total && total.estimated ? 'The total is the collection\'s estimate (no filter)' : '';
      foot.lastChild.textContent = lastMs !== null ? `find · ${fmtMs(lastMs)}` : '';
    }
    function paint() {
      paintRange();
      list.innerHTML = '';
      list.className = 'm-docs' + (view === 'table' ? ' table' : '');
      if (!docs.length) { list.append(h('div', { class: 'r-gone' }, q.filter ? 'No documents match the filter' : 'This collection has no documents')); return; }
      if (view === 'json') {
        const text = '[\n' + docs.map((d) => printDoc(d).replace(/^/gm, '  ')).join(',\n') + '\n]';
        list.append(h('div', { class: 'm-jsonbar' }, h('button', { class: 'btn sm ghost', onclick: () => { api.copy(text); toast('Copied', 'ok', 1200); } }, icon('copy'), 'Copy all')), h('pre', { class: 'm-code m-json' }, hl(text)));
        return;
      }
      if (view === 'table') { list.append(table()); return; }
      docs.forEach((d, i) => list.append(card(d, i)));
    }
    // List view: a card per document; Edit turns it into an editor.
    function card(d, i) {
      const c = h('div', { class: 'm-doc' });
      const acts = h('div', { class: 'm-doc-acts' },
        h('button', { class: 'icon-btn xs', title: 'Edit', onclick: () => edit(c, d, i) }, icon('edit')),
        h('button', { class: 'icon-btn xs', title: 'Copy as text', onclick: () => { api.copy(printDoc(d)); toast('Copied', 'ok', 1200); } }, icon('copy')),
        h('button', { class: 'icon-btn xs', title: 'Clone (insert a copy with a new _id)', onclick: () => clone(d) }, icon('plus')),
        h('button', { class: 'icon-btn xs danger-hover', title: 'Delete', onclick: () => del(d) }, icon('trash')));
      c.append(acts, Lookup.mongoTree(d));
      c.addEventListener('dblclick', (e) => { if (!e.target.closest('.mt-container')) edit(c, d, i); });
      return c;
    }
    function edit(c, d, i) {
      if (c.classList.contains('editing')) return;
      c.classList.add('editing');
      tab.editing++;
      Lookup.paintTabState();
      c.innerHTML = '';
      const ta = h('textarea', { class: 'm-editor', spellcheck: 'false' });
      ta.value = printDoc(d);
      ta.rows = Math.min(30, ta.value.split('\n').length + 1);
      const status = h('span', { class: 'm-edit-status' });
      const updateBtn = h('button', { class: 'btn sm primary', onclick: () => save() }, 'Update');
      let parsed = d;
      const diff = () => {
        try { parsed = L.parse(ta.value); if (L.typeOf(parsed) === 'Object') parsed = L.keepTypes(parsed, d); } catch (e) { parsed = null; status.textContent = `${e.message}${e.pos !== undefined ? ` (at ${e.pos + 1})` : ''}`; status.className = 'm-edit-status err-text-inline'; updateBtn.disabled = true; return; }
        if (L.typeOf(parsed) !== 'Object') { status.textContent = 'A document must be { … }'; status.className = 'm-edit-status err-text-inline'; updateBtn.disabled = true; return; }
        const changed = [...new Set([...Object.keys(parsed), ...Object.keys(d)])].filter((k) => !L.equal(parsed[k], d[k]));
        status.className = 'm-edit-status';
        status.textContent = changed.length ? `${changed.length} field${changed.length === 1 ? '' : 's'} changed: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ' …' : ''}` : 'No changes yet';
        updateBtn.disabled = !changed.length;
      };
      ta.addEventListener('input', debounce(diff, 150));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
      });
      const cancel = () => { tab.editing = Math.max(0, tab.editing - 1); Lookup.paintTabState(); c.replaceWith(card(d, i)); tab.save = null; };
      const save = async () => {
        diff();
        if (!parsed || updateBtn.disabled) return;
        try {
          const changes = [...new Set([...Object.keys(parsed), ...Object.keys(d)])].filter((k) => !L.equal(parsed[k], d[k]));
          await rop('update', { db: tab.db, coll: tab.coll, original: d, doc: parsed }, { describe: `db.${tab.coll}.updateOne({ _id: ${L.scalarText(d._id) || L.print(d._id)} }, … ${changes.join(', ')})` });
          tab.editing = Math.max(0, tab.editing - 1);
          Lookup.paintTabState();
          // Show the saved document with the changed fields marked.
          const was = {};
          for (const k of changes) was[k] = d[k];
          docs[i] = parsed;
          const fresh = card(parsed, i);
          fresh.classList.add('saved');
          fresh.lastChild.replaceWith(Lookup.mongoTree(parsed, { changed: was }));
          c.replaceWith(fresh);
          tab.save = null;
          toast('Document updated', 'ok', 1500);
        } catch (e) { fail(e); }
      };
      tab.save = save;
      c.append(ta, h('div', { class: 'm-docbar' }, status, h('div', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: cancel }, 'Cancel'), updateBtn));
      diff();
      ta.focus();
    }
    async function clone(d) {
      const copy = { ...d };
      delete copy._id;
      insertDialog(false, printDoc(copy));
    }
    async function del(d) {
      if (!(await confirmBox('Delete document', `Delete the document with _id ${L.cellText(d._id)}? This can't be undone.`, 'Delete', true))) return;
      try {
        await rop('remove', { db: tab.db, coll: tab.coll, ids: [d._id] }, { describe: `db.${tab.coll}.deleteOne({ _id: ${L.print(d._id)} })` });
        toast('Document deleted', 'ok', 1500);
        find(false);
      } catch (e) { fail(e); }
    }
    function insertDialog(many = false, text = null) {
      const ta = h('textarea', { class: 'input mono m-insert', spellcheck: 'false', rows: 14 });
      ta.value = text || (many ? "[\n  { name: 'first' },\n  { name: 'second' }\n]" : "{\n  \n}");
      const note = h('p', { class: 'muted small' }, 'mongosh values work: ObjectId(\'…\'), ISODate(\'…\'), Long(\'…\'), Decimal128(\'…\'). Without _id the server adds one.');
      modal({
        title: many ? `Insert documents into ${tab.coll}` : `Insert a document into ${tab.coll}`,
        wide: true,
        body: h('div', null, ta, note),
        actions: [{ label: 'Cancel' }, {
          label: 'Insert', kind: 'primary', onClick: async () => {
            const v = parseOr(ta.value, 'Document');
            if (v === undefined) return false;
            const list = Array.isArray(v) ? v : [v];
            try {
              const r = await rop('insert', { db: tab.db, coll: tab.coll, docs: list }, { describe: list.length === 1 ? `db.${tab.coll}.insertOne(${L.print(list[0], { width: 200 })})` : `db.${tab.coll}.insertMany([ … ${list.length} documents ])` });
              toast(`Inserted ${r.inserted} document${r.inserted === 1 ? '' : 's'}`, 'ok', 1800);
              find(true);
              Lookup.mongoLoadCollections(tab.db);
              return true;
            } catch (e) { fail(e); return false; }
          },
        }],
      });
      setTimeout(() => { ta.focus(); ta.setSelectionRange(text ? 0 : 4, text ? 0 : 4); }, 0);
    }
    // Table view: a column per top-level field (first 40 seen); double-click a value to change it.
    function table() {
      const cols = [];
      const types = new Map();
      for (const d of docs) for (const [k, v] of Object.entries(d)) { if (!cols.includes(k) && cols.length < 40) cols.push(k); if (!types.has(k)) types.set(k, L.typeOf(v)); }
      const tbl = h('table', { class: 'r-table m-table' },
        h('thead', null, h('tr', null, h('th', { class: 'r-n' }, '#'), cols.map((k) => h('th', null, k, h('small', null, types.get(k)))), h('th', { class: 'r-act' }))),
        h('tbody', null, docs.map((d, i) => h('tr', null, h('td', { class: 'r-n' }, String(q.page * q.limit + i + 1)),
          cols.map((k) => cellTd(d, i, k)),
          h('td', { class: 'r-act' }, h('button', { class: 'icon-btn xs', title: 'Edit the document', onclick: () => { view = 'list'; paint(); const c = list.children[i]; if (c) c.dispatchEvent(new MouseEvent('dblclick')); } }, icon('edit')),
            h('button', { class: 'icon-btn xs', title: 'Delete', onclick: () => del(d) }, icon('trash')))))));
      return h('div', { class: 'm-tablewrap' }, tbl);
    }
    function cellTd(d, i, k) {
      if (!(k in d)) return h('td', { class: 'muted' }, '');
      const v = d[k];
      const t = L.typeOf(v);
      const container = t === 'Object' || t === 'Array';
      const td = h('td', { class: `r-cell m-cell t-${t}`, title: container ? 'Click to see it' : L.scalarText(v) }, container ? h('span', { class: 'm-chip' }, L.cellText(v)) : L.cellText(v));
      if (container) td.addEventListener('click', () => modal({ title: `${k} · ${t}`, wide: true, body: h('pre', { class: 'm-code' }, hl(L.print(v))), actions: [{ label: 'Close' }] }));
      else if (k !== '_id') td.addEventListener('dblclick', () => editCell(td, d, i, k));
      return td;
    }
    function editCell(td, d, i, k) {
      const inp = h('input', { class: 'r-cell-input', spellcheck: 'false' });
      inp.value = L.scalarText(d[k]);
      td.textContent = '';
      td.append(inp);
      inp.focus();
      inp.select();
      let done = false;
      const finish = async (keep) => {
        if (done) return;
        done = true;
        if (!keep) { paint(); return; }
        let v;
        try { v = L.keepTypes(L.parse(inp.value), d[k]); } catch { v = inp.value; } // plain text is a string
        if (L.equal(v, d[k])) { paint(); return; }
        const next = { ...d, [k]: v };
        try {
          await rop('update', { db: tab.db, coll: tab.coll, original: d, doc: next }, { describe: `db.${tab.coll}.updateOne({ _id: … }, { $set: { ${k}: ${L.print(v)} } })` });
          docs[i] = next;
          toast('Saved', 'ok', 1200);
        } catch (e) { fail(e); }
        paint();
      };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
      inp.addEventListener('blur', () => finish(true));
    }
    async function explain() {
      const parts = queryParts();
      if (!parts) return;
      try {
        const x = await rop('explain', { db: tab.db, coll: tab.coll, ...parts, limit: q.limit, skip: q.page * q.limit });
        tab.lastExplain = x;
        modal({ title: 'Explain', wide: true, body: explainView(x), actions: [{ label: 'Close' }] });
      } catch (e) { fail(e); }
    }
    function remember() {
      if (!q.filter && !q.project && !q.sort) return;
      const key = nsKey(tab, 'history');
      const item = { filter: q.filter, project: q.project, sort: q.sort };
      const list0 = store.get(key, []).filter((x) => JSON.stringify(x) !== JSON.stringify(item));
      list0.unshift(item);
      store.set(key, list0.slice(0, 20));
    }
    function historyMenu(e) {
      const items = store.get(nsKey(tab, 'history'), []);
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left - 300, r.bottom + 4, items.length ? items.map((x) => ({
        label: [x.filter, x.project && `project ${x.project}`, x.sort && `sort ${x.sort}`].filter(Boolean).join(' · ').slice(0, 90) || '{}',
        onClick: () => { Object.assign(q, x); fIn.value = x.filter; pIn.value = x.project; sIn.value = x.sort; find(true); },
      })) : [{ label: 'No queries yet', disabled: true, onClick: () => {} }]);
    }
    async function exportDocs(format) {
      const parts = queryParts();
      if (!parts) return;
      try {
        const file = await api.exportPickFile(format, `${tab.db}.${tab.coll}`);
        if (!file) return;
        const r = await rop('exportDocs', { db: tab.db, coll: tab.coll, ...parts, format, file });
        toast(`Exported ${fmtNum(r.count)} documents`, 'ok', 2500);
        api.showInFolder(file).catch(() => {});
      } catch (e) { fail(e); }
    }
    tab.onReconnected = () => find(false);
    find(true);
  }

  // ---------- Aggregations ----------
  const STAGE_OPS = ['$match', '$group', '$project', '$sort', '$limit', '$skip', '$unwind', '$lookup', '$addFields', '$set', '$unset', '$count', '$facet', '$bucket', '$bucketAuto', '$sortByCount', '$replaceRoot', '$replaceWith', '$sample', '$graphLookup', '$geoNear', '$densify', '$fill', '$setWindowFields', '$unionWith', '$redact', '$out', '$merge'];
  const STAGE_TEMPLATES = {
    $match: '{\n  \n}', $group: "{\n  _id: '$field',\n  count: { $sum: 1 }\n}", $project: '{\n  field: 1\n}', $sort: '{ field: -1 }', $limit: '10', $skip: '10', $unwind: "'$field'",
    $lookup: "{\n  from: 'collection',\n  localField: 'field',\n  foreignField: '_id',\n  as: 'joined'\n}", $addFields: '{\n  newField: 1\n}', $set: '{\n  field: 1\n}', $unset: "'field'", $count: "'total'",
    $sortByCount: "'$field'", $replaceRoot: "{ newRoot: '$field' }", $sample: '{ size: 10 }', $out: "'collection'", $merge: "{ into: 'collection' }",
  };

  function buildAgg(tab, el) {
    const saved = store.get(nsKey(tab, 'pipeline'), null);
    let stages = saved && saved.length ? saved : [{ op: '$match', body: '{\n  \n}', enabled: true }];
    let mode = 'stages';
    let size = 10;
    let previews = [];
    const box = h('div', { class: 'm-agg' });
    const results = h('div', { class: 'm-aggres hidden' });
    const sizeSel = h('select', { class: 'input xs', title: 'Documents in each preview', onchange: (e) => { size = Number(e.target.value); refresh(); } }, [5, 10, 20].map((n) => h('option', { value: n }, `Preview ${n} documents`)));
    sizeSel.value = '10';
    const seg = h('div', { class: 'seg sm' }, [['stages', 'Stages'], ['text', 'Text']].map(([m, l]) => h('button', {
      type: 'button', class: m === mode ? 'on' : '', onclick: (e) => {
        if (m === mode) return;
        if (m === 'stages' && !fromText()) return;
        mode = m;
        e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
        paint();
      },
    }, l)));
    el.append(h('div', { class: 'r-toolbar' },
      h('button', { class: 'btn sm primary', onclick: () => run() }, icon('play'), 'Run'),
      h('button', { class: 'btn sm', onclick: () => explain() }, 'Explain'),
      h('div', { class: 'tb-sep' }), seg, h('div', { class: 'spacer' }), sizeSel,
      h('button', { class: 'btn sm ghost', title: 'Saved pipelines for this collection', onclick: (e) => savedMenu(e) }, icon('save'), 'Saved ▾'),
      h('button', { class: 'btn sm ghost', onclick: (e) => codeMenu(e) }, icon('code'), 'Copy as code')), box, results);
    let textArea = null;

    const pipelineText = () => `[\n${stages.filter((s) => s.enabled).map((s) => `  { ${s.op}: ${s.body.trim().replace(/\n/g, '\n  ')} }`).join(',\n')}\n]`;
    function fromText() {
      if (!textArea) return true;
      const v = parseOr(textArea.value, 'Pipeline', { empty: [] });
      if (v === undefined) return false;
      if (!Array.isArray(v) || v.some((st) => L.typeOf(st) !== 'Object' || Object.keys(st).length !== 1)) { toast('The pipeline must be [ { $stage: … }, … ]', 'err'); return false; }
      stages = v.map((st) => { const op = Object.keys(st)[0]; return { op, body: L.print(st[op], { width: 70 }), enabled: true }; });
      return true;
    }
    function compiled() {
      return stages.map((s) => {
        try { return { stage: { [s.op]: L.parse(s.body, { empty: {} }) }, enabled: s.enabled }; } catch (e) { return { error: `${e.message}${e.pos !== undefined ? ` (at ${e.pos + 1})` : ''}`, enabled: s.enabled }; }
      });
    }
    const persist = () => store.set(nsKey(tab, 'pipeline'), stages);
    let seq = 0;
    async function refresh() {
      persist();
      const my = ++seq;
      const comp = compiled();
      const firstBad = comp.findIndex((c) => c.enabled && c.error);
      const usable = comp.map((c, i) => (firstBad >= 0 && i >= firstBad ? { stage: { $limit: 0 }, enabled: false } : c.error ? { stage: { $limit: 0 }, enabled: false } : c));
      let r = [];
      try { r = await rop('aggPreview', { db: tab.db, coll: tab.coll, stages: usable, size }); } catch (e) { r = usable.map(() => ({ error: e.message })); }
      if (my !== seq) return;
      previews = comp.map((c, i) => (c.error ? { error: c.error } : firstBad >= 0 && i > firstBad ? { skipped: true, note: 'Fix the stage above first' } : r[i]));
      paintPreviews();
    }
    const refreshSoon = debounce(refresh, 600);
    function paint() {
      box.innerHTML = '';
      textArea = null;
      if (mode === 'text') {
        textArea = h('textarea', { class: 'm-editor m-pipetext', spellcheck: 'false' });
        textArea.value = pipelineText();
        box.append(textArea, h('p', { class: 'muted small' }, 'The whole pipeline as an array. Switch back to Stages to see previews.'));
        return;
      }
      stages.forEach((s, i) => box.append(stageCard(s, i)));
      box.append(h('div', { class: 'm-addstage' }, h('button', { class: 'btn sm ghost', onclick: () => addStage(stages.length) }, icon('plus'), 'Add stage'),
        h('span', { class: 'muted' }, STAGE_OPS.slice(0, 8).join('  '))));
      paintPreviews();
    }
    function addStage(at, op = '$match') {
      stages.splice(at, 0, { op, body: STAGE_TEMPLATES[op] || '{}', enabled: true });
      paint();
      refreshSoon();
      const ta = box.querySelectorAll('.m-stage textarea')[at];
      if (ta) ta.focus();
    }
    function stageCard(s, i) {
      const opIn = h('input', { class: 'm-stage-op', value: s.op, spellcheck: 'false', list: 'm-stage-ops', oninput: (e) => { s.op = e.target.value.trim(); refreshSoon(); } });
      opIn.addEventListener('change', () => { if (STAGE_TEMPLATES[s.op] && /^\s*\{\s*\}\s*$|^\s*\{\s*\n\s*\n\s*\}\s*$/.test(s.body)) { s.body = STAGE_TEMPLATES[s.op]; paint(); } });
      const ta = h('textarea', { class: 'm-stage-body', spellcheck: 'false', rows: Math.max(2, Math.min(14, s.body.split('\n').length)), oninput: (e) => { s.body = e.target.value; refreshSoon(); } });
      ta.value = s.body;
      ta.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); } });
      const toggle = h('label', { class: 'm-switch', title: s.enabled ? 'Turn this stage off' : 'Turn this stage on' }, h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => { s.enabled = e.target.checked; paint(); refreshSoon(); } }), h('span'));
      const menu = h('button', { class: 'icon-btn xs', title: 'More', onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        contextMenu(r.left, r.bottom + 4, [
          { label: 'Add stage after', icon: 'plus', onClick: () => addStage(i + 1) },
          { label: 'Move up', disabled: i === 0, onClick: () => { [stages[i - 1], stages[i]] = [stages[i], stages[i - 1]]; paint(); refreshSoon(); } },
          { label: 'Move down', disabled: i === stages.length - 1, onClick: () => { [stages[i + 1], stages[i]] = [stages[i], stages[i + 1]]; paint(); refreshSoon(); } },
          '-',
          { label: 'Delete stage', icon: 'trash', danger: true, onClick: () => { stages.splice(i, 1); if (!stages.length) stages.push({ op: '$match', body: '{\n  \n}', enabled: true }); paint(); refreshSoon(); } },
        ]);
      } }, icon('dots'));
      return h('div', { class: 'm-stage' + (s.enabled ? '' : ' off') },
        h('div', { class: 'm-stage-l' }, h('div', { class: 'm-stage-h' }, h('span', { class: 'm-stage-n' }, String(i + 1)), opIn, h('div', { class: 'spacer' }), toggle, menu), ta),
        h('div', { class: 'm-stage-r', 'data-i': i }));
    }
    function paintPreviews() {
      box.querySelectorAll('.m-stage-r').forEach((el2) => {
        const i = Number(el2.dataset.i);
        const p = previews[i];
        const s = stages[i];
        el2.innerHTML = '';
        if (!s.enabled) { el2.append(h('div', { class: 'm-prev-h muted' }, 'Stage turned off')); return; }
        if (!p) { el2.append(h('div', { class: 'm-prev-h muted' }, 'Preview…')); return; }
        if (p.error) { el2.append(h('div', { class: 'm-prev-h err-text-inline' }, p.error)); return; }
        if (p.skipped) { el2.append(h('div', { class: 'm-prev-h muted' }, p.note || 'No preview')); return; }
        el2.append(h('div', { class: 'm-prev-h muted' }, `Output after ${s.op} · ${p.docs.length < size ? `${p.docs.length} document${p.docs.length === 1 ? '' : 's'}` : `first ${size} documents`} · ${p.ms} ms`),
          h('div', { class: 'm-prev' }, p.docs.length ? p.docs.slice(0, 6).map((d) => h('pre', { class: 'm-mini' }, hl(L.print(d, { width: 36 })))) : h('div', { class: 'muted small' }, 'No documents come out of this stage')));
      });
    }
    function current() {
      if (mode === 'text' && !fromText()) return null;
      const comp = compiled();
      const bad = comp.find((c) => c.enabled && c.error);
      if (bad) { toast(`A stage has a mistake: ${bad.error}`, 'err', 5000); return null; }
      return comp;
    }
    async function run() {
      const comp = current();
      if (!comp) return;
      results.classList.remove('hidden');
      results.innerHTML = '';
      results.append(h('div', { class: 'grid-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Running…')));
      try {
        const r = await rop('aggRun', { db: tab.db, coll: tab.coll, stages: comp }, { describe: pipelineText() });
        results.innerHTML = '';
        results.append(h('div', { class: 'm-aggres-h' }, h('b', null, r.wrote ? 'Pipeline ran (it writes to a collection)' : `${fmtNum(r.docs.length)}${r.more ? '+' : ''} document${r.docs.length === 1 ? '' : 's'}`),
          h('span', { class: 'muted' }, ` · ${fmtMs(r.ms)}${r.more ? ' · showing the first 500' : ''}`), h('div', { class: 'spacer' }),
          h('button', { class: 'btn sm ghost', onclick: () => { api.copy('[\n' + r.docs.map((d) => printDoc(d)).join(',\n') + '\n]'); toast('Copied', 'ok', 1200); } }, icon('copy'), 'Copy'),
          h('button', { class: 'icon-btn', title: 'Close results', onclick: () => results.classList.add('hidden') }, icon('x'))),
        h('div', { class: 'm-aggres-list' }, r.docs.slice(0, 200).map((d) => h('div', { class: 'm-doc' }, Lookup.mongoTree(d)))));
        if (r.wrote) Lookup.mongoLoadCollections(tab.db);
      } catch (e) { results.innerHTML = ''; results.append(h('div', { class: 'err-text m-pad' }, e.message)); if (e.notSent) results.classList.add('hidden'); }
    }
    async function explain() {
      const comp = current();
      if (!comp) return;
      try { modal({ title: 'Explain pipeline', wide: true, body: explainView(await rop('aggExplain', { db: tab.db, coll: tab.coll, stages: comp })), actions: [{ label: 'Close' }] }); } catch (e) { fail(e); }
    }
    function savedMenu(e) {
      const key = `lookup.mongo.saved.${S.current && S.current.id}.${tab.db}.${tab.coll}`;
      const list = store.get(key, []);
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left - 120, r.bottom + 4, [
        { label: 'Save this pipeline…', icon: 'save', onClick: async () => {
          if (mode === 'text' && !fromText()) return;
          const name = await Lookup.askText('Save pipeline', 'Name', `Pipeline ${list.length + 1}`, { ok: 'Save', mono: false });
          if (!name) return;
          store.set(key, [{ name, stages }, ...list.filter((x) => x.name !== name)].slice(0, 30));
          toast('Pipeline saved', 'ok', 1500);
        } },
        ...(list.length ? ['-'] : []),
        ...list.map((x) => ({ label: x.name, onClick: () => { stages = JSON.parse(JSON.stringify(x.stages)); mode = 'stages'; paint(); refresh(); } })),
      ]);
    }
    function codeMenu(e) {
      if (mode === 'text' && !fromText()) return;
      const pipe = pipelineText();
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left - 60, r.bottom + 4, [
        { label: 'mongosh', onClick: () => { api.copy(`db.getCollection('${tab.coll}').aggregate(${pipe})`); toast('Copied', 'ok', 1200); } },
        { label: 'Node.js driver', onClick: () => { api.copy(`const docs = await client.db('${tab.db}').collection('${tab.coll}').aggregate(${pipe}).toArray();`); toast('Copied', 'ok', 1200); } },
        { label: 'Python (PyMongo)', onClick: () => { api.copy(`docs = list(client['${tab.db}']['${tab.coll}'].aggregate(${pipe}))`); toast('Copied (adjust ObjectId / ISODate for Python)', 'ok', 2500); } },
      ]);
    }
    if (!document.getElementById('m-stage-ops')) document.body.append(h('datalist', { id: 'm-stage-ops' }, STAGE_OPS.map((o) => h('option', { value: o }))));
    tab.onReconnected = tab.onReconnected || (() => refresh());
    paint();
    refresh();
  }

  // ---------- Schema ----------
  const TYPE_COLORS = { ObjectId: 'var(--mv-oid)', String: 'var(--mv-str)', Int32: 'var(--mv-num)', Int64: 'var(--mv-num)', Double: '#d18b3a', Decimal128: '#b25500', Date: 'var(--mv-date)', Boolean: 'var(--mv-kw)', Object: '#7b4fd0', Array: '#17868c', Null: 'var(--faint)', UUID: 'var(--mv-bin)', Binary: 'var(--mv-bin)' };
  function buildSchema(tab, el) {
    let sizeVal = 1000;
    let useFilter = false;
    const body = h('div', { class: 'm-schema' }, h('div', { class: 'r-gone' }, icon('columns'), h('div', null, 'Analyze a sample of documents to see each field\'s types and values.')));
    const sizeSel = h('select', { class: 'input xs', onchange: (e) => { sizeVal = Number(e.target.value); } }, [100, 1000, 5000].map((n) => h('option', { value: n }, `Sample of ${fmtNum(n)}`)));
    sizeSel.value = '1000';
    const info = h('span', { class: 'muted small-note' });
    el.append(h('div', { class: 'r-toolbar' },
      h('button', { class: 'btn sm primary', onclick: () => analyze() }, 'Analyze'), sizeSel,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { useFilter = e.target.checked; } }), h('span', null, 'Use the Documents filter')),
      info, h('div', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', title: 'A $jsonSchema validator from this analysis', onclick: () => exportJsonSchema() }, icon('download'), 'Copy as JSON Schema')), body);
    async function analyze() {
      let filter = {};
      if (useFilter && tab.query) { const parts = tab.query(); if (!parts) return; filter = parts.filter; }
      body.innerHTML = '';
      body.append(h('div', { class: 'grid-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Sampling documents…')));
      try {
        const r = await rop('schema', { db: tab.db, coll: tab.coll, size: sizeVal, filter });
        tab.schema = r;
        info.textContent = `${fmtNum(r.sampled)} document${r.sampled === 1 ? '' : 's'} analyzed${Object.keys(filter).length ? ' · filtered' : ''}`;
        paint(r);
      } catch (e) { body.innerHTML = ''; body.append(h('div', { class: 'err-text m-pad' }, e.message)); }
    }
    function bars(counts, labelL, labelR) {
      const max = Math.max(...counts, 1);
      return h('div', null, h('div', { class: 'm-bars' }, counts.map((c) => h('i', { style: { height: Math.max(2, (c / max) * 100) + '%' }, title: String(c) }))), h('div', { class: 'm-legend' }, h('span', null, labelL), h('span', null, labelR)));
    }
    const dateText = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '?');
    function paint(r) {
      body.innerHTML = '';
      if (!r.fields.length) { body.append(h('div', { class: 'r-gone' }, 'No documents to analyze')); return; }
      for (const f of r.fields) {
        const depth = (f.path.match(/\./g) || []).length;
        const total = f.types.reduce((a, t) => a + t.n, 0);
        const missing = r.sampled - f.present;
        const typeBar = h('div', { class: 'm-typebar' }, f.types.map((t) => h('div', { style: { flex: String(t.n), background: TYPE_COLORS[t.type] || '#888' }, title: `${t.type} ${Math.round((t.n / total) * 100)}%` }, t.type)),
          !f.path.includes('[]') && missing > 0 ? h('div', { class: 'missing', style: { flex: String(missing) }, title: `missing ${Math.round((missing / r.sampled) * 100)}%` }, 'missing') : null);
        const legend = f.types.map((t) => `${t.type} ${Math.round((t.n / total) * 100)}%`).join(' · ') + (f.types.length > 1 ? ' — mixed types' : '');
        let right = null;
        if (f.strings && f.strings.distinct === f.present && f.present > 10) right = h('div', { class: 'm-legend' }, `Every value is different (${fmtNum(f.strings.distinct)} values), e.g. ${f.strings.top.slice(0, 2).map((v) => v.value).join(', ')}`);
        else if (f.strings && f.strings.top.length) {
          const top = f.strings.top[0].n;
          right = h('div', { class: 'm-vals' }, f.strings.top.slice(0, 6).map((v) => h('div', { class: 'm-val' }, h('span', { class: 'mono' }, v.value === '' ? '(empty)' : v.value), h('span', { class: 'muted' }, ` ${Math.round((v.n / f.present) * 100)}%`), h('div', { class: 'hbar' }, h('i', { style: { width: (v.n / top) * 100 + '%' } })))),
            h('div', { class: 'm-legend' }, `${fmtNum(f.strings.distinct)}${f.strings.capped ? '+' : ''} distinct value${f.strings.distinct === 1 ? '' : 's'}`));
        } else if (f.numbers) right = bars(f.numbers.counts, `min ${fmtNum(f.numbers.min)}`, `median ${fmtNum(f.numbers.median)} · max ${fmtNum(f.numbers.max)}`);
        else if (f.dates) right = bars(f.dates.counts, dateText(f.dates.min), dateText(f.dates.max));
        else if (f.booleans) { const tt = f.booleans.true + f.booleans.false; right = h('div', { class: 'm-vals' }, h('div', { class: 'm-val' }, `true ${Math.round((f.booleans.true / tt) * 100)}% · false ${Math.round((f.booleans.false / tt) * 100)}%`), h('div', { class: 'hbar' }, h('i', { style: { width: (f.booleans.true / tt) * 100 + '%' } }))); } else if (f.arrays) right = h('div', { class: 'm-legend' }, `${f.arrays.min}–${f.arrays.max} elements (avg ${f.arrays.avg.toFixed(1)}) · ${f.arrays.elementTypes.map((t) => t.type).join(', ') || 'empty'}`);
        else if (f.objectIds) right = h('div', { class: 'm-legend' }, `created ${dateText(f.objectIds.min)} → ${dateText(f.objectIds.max)}`);
        body.append(h('div', { class: 'm-field' },
          h('div', { style: { paddingLeft: depth * 14 + 'px' } }, h('div', { class: 'm-fname' }, f.path.split('.').pop()), h('div', { class: 'm-fsub' }, `${depth ? f.path + ' · ' : ''}in ${Math.round(f.share * 100)}%`)),
          h('div', null, typeBar, h('div', { class: 'm-legend' }, legend)), h('div', null, right)));
      }
    }
    function exportJsonSchema() {
      if (!tab.schema) { toast('Analyze first', 'info'); return; }
      const B = { ObjectId: 'objectId', String: 'string', Int32: 'int', Int64: 'long', Double: 'double', Decimal128: 'decimal', Date: 'date', Boolean: 'bool', Object: 'object', Array: 'array', Null: 'null', UUID: 'binData', Binary: 'binData', Regex: 'regex', Timestamp: 'timestamp' };
      const top = tab.schema.fields.filter((f) => !/[.[]/.test(f.path));
      const schema = { $jsonSchema: { bsonType: 'object', required: top.filter((f) => f.share === 1).map((f) => f.path), properties: Object.fromEntries(top.map((f) => [f.path, { bsonType: f.types.length === 1 ? (B[f.types[0].type] || 'object') : f.types.map((t) => B[t.type] || 'object') }])) } };
      const text = L.print(L.parse(JSON.stringify(schema)), { width: 80 });
      api.copy(text);
      tab.generatedValidator = text;
      toast('Copied. The Validation section can use it too.', 'ok', 2500);
    }
  }

  // ---------- Indexes ----------
  function buildIndexes(tab, el) {
    const list = h('div', { class: 'm-tablewrap' });
    const xbox = h('div', { class: 'm-xpanel' });
    el.append(h('div', { class: 'r-toolbar' },
      h('button', { class: 'btn sm primary', onclick: () => createDialog() }, icon('plus'), 'Create index'),
      h('button', { class: 'btn sm ghost', onclick: () => load() }, icon('refresh'), 'Reload'),
      h('div', { class: 'spacer' }), h('span', { class: 'muted small-note' }, 'Usage counts since the server started')), list, xbox);
    async function load() {
      list.innerHTML = '';
      try {
        const ixs = await rop('indexes', { db: tab.db, coll: tab.coll });
        list.append(h('table', { class: 'r-table m-ixtable' },
          h('thead', null, h('tr', null, ['Name', 'Keys', 'Properties', 'Size', 'Usage', ''].map((x) => h('th', null, x)))),
          h('tbody', null, ixs.map((ix) => h('tr', null,
            h('td', { class: 'mono' }, ix.name),
            h('td', { class: 'mono' }, hl(L.print(ix.key, { width: 200 }).replace(/^\{ | \}$/g, ''))),
            h('td', null, [ix.name === '_id_' || ix.unique ? 'UNIQUE' : null, ix.sparse ? 'SPARSE' : null, ix.ttl !== null ? `TTL ${ix.ttl} s` : null, ix.partial ? 'PARTIAL' : null, ix.hidden ? 'HIDDEN' : null, Object.keys(L.parse(L.print(ix.key))).length > 1 ? 'COMPOUND' : null, ...ix.kinds.map((k) => String(k).toUpperCase())].filter(Boolean).map((p) => h('span', { class: 'm-chip' }, p))),
            h('td', { class: 'num' }, ix.size !== null ? fmtBytes(ix.size) : '—'),
            h('td', { class: 'muted' }, ix.usage ? (ix.usage.ops ? `${fmtNum(ix.usage.ops)} uses` : 'never used') : '—'),
            h('td', { class: 'r-act' }, ix.name === '_id_' ? null : h('button', { class: 'icon-btn xs danger-hover', title: 'Drop index', onclick: () => drop(ix.name) }, icon('trash'))))))));
      } catch (e) { list.append(h('div', { class: 'err-text m-pad' }, e.message)); }
      paintExplain();
    }
    function paintExplain() {
      xbox.innerHTML = '';
      xbox.append(h('div', { class: 'm-xhead' }, h('b', null, 'Explain the Documents query'), h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: async () => {
          const parts = tab.query ? tab.query() : { filter: {}, project: {}, sort: {} };
          if (!parts) return;
          try { tab.lastExplain = await rop('explain', { db: tab.db, coll: tab.coll, ...parts, limit: 20 }); paintExplain(); } catch (e) { fail(e); }
        } }, 'Explain')));
      if (tab.lastExplain) xbox.append(explainView(tab.lastExplain));
      else xbox.append(h('p', { class: 'muted small' }, 'Shows whether the filter and sort from the Documents section use an index.'));
    }
    async function drop(name) {
      if (!(await confirmBox('Drop index', `Drop index ${name}? Queries that use it get slower.`, 'Drop', true))) return;
      try { await rop('dropIndex', { db: tab.db, coll: tab.coll, name }, { describe: `db.${tab.coll}.dropIndex('${name}')` }); toast('Index dropped', 'ok', 1500); load(); } catch (e) { fail(e); }
    }
    function createDialog() {
      const rows = [{ field: '', type: '1' }];
      const opt = { name: '', unique: false, sparse: false, hidden: false, ttl: '', partial: '' };
      const rowsBox = h('div', { class: 'm-ixrows' });
      const paintRows = () => {
        rowsBox.innerHTML = '';
        rows.forEach((r, i) => {
          const f = h('input', { class: 'input mono', placeholder: 'field name', value: r.field, spellcheck: 'false', oninput: (e) => { r.field = e.target.value; } });
          const t = h('select', { class: 'input', onchange: (e) => { r.type = e.target.value; } }, [['1', '1 (ascending)'], ['-1', '-1 (descending)'], ['text', 'text'], ['2dsphere', '2dsphere'], ['hashed', 'hashed']].map(([v, l]) => h('option', { value: v }, l)));
          t.value = r.type;
          rowsBox.append(h('div', { class: 'm-ixrow' }, f, t, h('button', { class: 'icon-btn', title: 'Remove', disabled: rows.length === 1, onclick: () => { rows.splice(i, 1); paintRows(); } }, icon('x'))));
        });
        rowsBox.append(h('button', { class: 'btn sm ghost', onclick: () => { rows.push({ field: '', type: '1' }); paintRows(); } }, icon('plus'), 'Add field'));
      };
      paintRows();
      const chk = (k, l) => h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { opt[k] = e.target.checked; } }), h('span', null, l));
      const txt = (k, ph, attrs = {}) => h('input', { class: 'input mono', placeholder: ph, spellcheck: 'false', ...attrs, oninput: (e) => { opt[k] = e.target.value; } });
      modal({
        title: `Create index on ${tab.coll}`,
        wide: true,
        body: h('div', { class: 'm-ixdialog' },
          h('div', { class: 'field-label' }, 'Fields'), rowsBox,
          h('div', { class: 'checks-row' }, chk('unique', 'Unique'), chk('sparse', 'Sparse (skip documents without the field)'), chk('hidden', 'Hidden (not used by queries yet)')),
          h('div', { class: 'grid2' },
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Expire documents after (seconds, TTL)'), txt('ttl', 'only for a date field', { type: 'number' })),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name (optional)'), txt('name', 'made from the fields'))),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Partial filter (optional)'), txt('partial', "{ status: 'active' }"))),
        actions: [{ label: 'Cancel' }, {
          label: 'Create', kind: 'primary', onClick: async () => {
            const keys = {};
            for (const r of rows) if (r.field.trim()) keys[r.field.trim()] = /^-?1$/.test(r.type) ? L.jsNumber(Number(r.type)) : r.type;
            if (!Object.keys(keys).length) { toast('Enter at least one field', 'err'); return false; }
            const partial = opt.partial.trim() ? parseOr(opt.partial, 'Partial filter') : null;
            if (partial === undefined) return false;
            try {
              await rop('createIndex', { db: tab.db, coll: tab.coll, keys, options: { name: opt.name || undefined, unique: opt.unique, sparse: opt.sparse, hidden: opt.hidden, expireAfterSeconds: opt.ttl === '' ? undefined : Number(opt.ttl), partialFilterExpression: partial || undefined } }, { describe: `db.${tab.coll}.createIndex(${L.print(keys)})` });
              toast('Index created', 'ok', 1500);
              load();
              return true;
            } catch (e) { fail(e); return false; }
          },
        }],
      });
    }
    load();
  }

  // ---------- Validation ----------
  function buildValidation(tab, el) {
    const ta = h('textarea', { class: 'm-editor m-validator', spellcheck: 'false', placeholder: "{\n  $jsonSchema: {\n    bsonType: 'object',\n    required: ['name'],\n    properties: { name: { bsonType: 'string' } }\n  }\n}" });
    const level = h('select', { class: 'input xs' }, [['off', 'Off'], ['strict', 'Strict (every insert and update)'], ['moderate', 'Moderate (only documents that already pass)']].map(([v, l]) => h('option', { value: v }, l)));
    const action = h('select', { class: 'input xs' }, [['error', 'Reject invalid documents'], ['warn', 'Allow, but log a warning']].map(([v, l]) => h('option', { value: v }, l)));
    el.append(h('div', { class: 'r-toolbar' },
      h('span', { class: 'm-qlabel' }, 'Level'), level, h('span', { class: 'm-qlabel' }, 'Action'), action, h('div', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', title: 'From the Schema section\'s analysis', onclick: () => { if (!tab.generatedValidator) { toast('In Schema: Analyze, then Copy as JSON Schema', 'info', 3500); return; } ta.value = tab.generatedValidator; } }, 'Use the Schema analysis'),
      h('button', { class: 'btn sm', onclick: () => load() }, 'Reload'),
      h('button', { class: 'btn sm primary', onclick: () => save() }, 'Save')),
    ta, h('p', { class: 'muted small m-pad' }, 'Rules MongoDB checks when documents are inserted or updated. Leave empty for no rules.'));
    async function load() {
      try {
        const v = await rop('validation', { db: tab.db, coll: tab.coll });
        ta.value = v.validator ? L.print(v.validator, { width: 80 }) : '';
        level.value = v.level;
        action.value = v.action;
      } catch (e) { fail(e); }
    }
    async function save() {
      const v = ta.value.trim() ? parseOr(ta.value, 'Rules') : null;
      if (v === undefined) return;
      try {
        await rop('setValidation', { db: tab.db, coll: tab.coll, validator: v, level: level.value, action: action.value }, { describe: `db.runCommand({ collMod: '${tab.coll}', validator: …, validationLevel: '${level.value}', validationAction: '${action.value}' })` });
        toast('Validation rules saved', 'ok', 1500);
      } catch (e) { fail(e); }
    }
    load();
  }

  const BUILD = { docs: buildDocs, agg: buildAgg, schema: buildSchema, indexes: buildIndexes, validation: buildValidation };

  /** Title bar Aggregation button: the open collection's Aggregations. */
  function openMongoAggregation() {
    const t = S.tabs.find((x) => x.id === S.active && x.kind === 'mcoll') || [...S.tabs].reverse().find((x) => x.kind === 'mcoll');
    if (!t) { toast('Open a collection first (pick one in the sidebar)', 'info', 2500); return; }
    Lookup.activate(t.id);
    t.show('agg');
  }

  Object.assign(Lookup, { openMongoCollection, openMongoAggregation, mongoExplainView: explainView });
})();
