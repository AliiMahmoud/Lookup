// Table tabs: the Data view (paging, filters, sorting, editing), grid edits preview & commit, and the rows-per-page picker.
(function () {
  const { h, icon, toast, modal, confirmBox, contextMenu, closeMenu, fmtNum, fmtMs, cellText } = window.U;
  const api = window.api;
  const Lookup = window.Lookup;
  const { TYPE_ICON, S } = Lookup;

  // ---------- Table tab ----------
  function openTableTab(owner, name, type, view = 'data') {
    const existing = S.tabs.find((t) => t.kind === 'table' && t.owner === owner && t.name === name);
    if (existing) { Lookup.activate(existing.id); if (view !== existing.view) existing.setView(view); return; }
    const tab = {
      kind: 'table', owner, name, type, title: name, tooltip: `${owner}.${name}`, icon: TYPE_ICON[type] || 'table',
      view, offset: 0, limit: 300, filters: [], sort: null, grid: null, data: null, showDetails: false, selected: null,
    };
    const segBtns = {};
    const seg = h('div', { class: 'seg' }, ['data', 'structure', 'ddl'].map((v) => {
      segBtns[v] = h('button', { onclick: () => tab.setView(v) }, v === 'data' ? 'Data' : v === 'structure' ? 'Structure' : 'DDL');
      return segBtns[v];
    }));
    const changesBox = h('div', { class: 'changes hidden' },
      h('span', { class: 'changes-count' }),
      h('button', { class: 'btn sm', onclick: () => previewChanges(tab) }, 'Preview SQL'),
      h('button', { class: 'btn sm', onclick: () => { tab.grid.discard(); } }, 'Discard'),
      h('button', { class: 'btn sm primary', title: 'Commit changes (Ctrl+S)', onclick: () => commitChanges(tab) }, 'Commit'));
    const dataTools = h('div', { class: 'tools' },
      h('button', { class: 'tool', title: 'Filter (Ctrl+F)', onclick: () => tab.toggleFilter() }, icon('filter'), h('span', { class: 'filter-n' })),
      h('button', { class: 'tool', title: 'Refresh (F5)', onclick: () => tab.reload() }, icon('refresh')),
      type === 'TABLE' && Lookup.feature('editRows') ? h('button', { class: 'tool', title: 'Add row', onclick: () => tab.grid && tab.grid.addRow() }, icon('plus')) : null,
      type === 'TABLE' && Lookup.feature('editRows') ? h('button', { class: 'tool', title: 'Delete selected rows (Del)', onclick: () => tab.grid && tab.grid.deleteRows(tab.grid.selectedVisualRows()) }, icon('trash')) : null,
      h('button', { class: 'tool', title: 'Export… (Ctrl+E)', onclick: () => Lookup.exportTable(tab) }, icon('download')),
      h('button', { class: 'tool', title: 'Row details', onclick: () => { tab.showDetails = !tab.showDetails; tab.paintDetails(); } }, icon('panel')));
    const toolbar = h('div', { class: 'toolbar' }, seg, dataTools, h('div', { class: 'spacer' }), changesBox);
    const filterBox = h('div', { class: 'filters hidden' });
    const gridHost = h('div', { class: 'grid-host' });
    const details = h('div', { class: 'details hidden' });
    const body = h('div', { class: 'tbl-body' }, gridHost, details);
    const pagerInfo = h('span', { class: 'pager-info' });
    const pageSize = pageSizeControl(tab.limit, (n) => { tab.limit = n; tab.offset = 0; tab.reload(); });
    const prev = h('button', { class: 'tool', title: 'Previous page', onclick: () => tab.page(-1) }, icon('chevron', 'flip'));
    const next = h('button', { class: 'tool', title: 'Next page', onclick: () => tab.page(1) }, icon('chevron'));
    const timing = h('span', { class: 'muted' });
    const footer = h('div', { class: 'pager' }, prev, next, pagerInfo, pageSize, h('div', { class: 'spacer' }), timing,
      h('button', { class: 'tool', title: 'Copy the SQL used for this page', onclick: () => tab.data && api.copy(tab.data.sql) }, icon('copy')));
    // Engines without grid editing yet: say so once, above the rows.
    const readOnlyNote = type === 'TABLE' && !Lookup.feature('editRows')
      ? h('div', { class: 'ro-note' }, h('strong', null, 'Read-only: '), Lookup.profile().readOnlyNote || `editing ${Lookup.profile().label} rows here comes in a later version. Use a query tab (Ctrl+T) to change data.`)
      : null;
    const dataView = h('div', { class: 'view-data' }, ...[readOnlyNote, filterBox, body, footer].filter(Boolean));
    const structView = h('div', { class: 'view-structure hidden scroll' });
    const ddlView = h('div', { class: 'view-ddl hidden' });
    tab.el = h('div', { class: 'tabview' }, toolbar, dataView, structView, ddlView);

    tab.setView = (v) => {
      tab.view = v;
      Object.entries(segBtns).forEach(([k, b]) => b.classList.toggle('on', k === v));
      dataTools.classList.toggle('hidden', v !== 'data');
      dataView.classList.toggle('hidden', v !== 'data');
      structView.classList.toggle('hidden', v !== 'structure');
      ddlView.classList.toggle('hidden', v !== 'ddl');
      changesBox.classList.toggle('hidden', v !== 'data' || !(tab.grid && tab.grid.changeCount()));
      if (v === 'data' && !tab.data) tab.reload();
      if (v === 'structure' && !tab.structLoaded) Lookup.loadStructure(tab, structView);
      if (v === 'ddl' && !tab.ddlLoaded) Lookup.loadDdl(tab, ddlView);
    };

    tab.page = async (dir) => {
      if (!tab.data) return;
      const n = tab.offset + dir * tab.limit;
      if (n < 0 || (dir > 0 && tab.data.rows.length < tab.limit)) return;
      if (!(await tab.confirmLeave())) return;
      tab.offset = n;
      tab.reload(true);
    };

    tab.confirmLeave = async () => {
      if (!tab.grid || !tab.grid.changeCount()) return true;
      return confirmBox('Discard changes?', `You have ${tab.grid.changeCount()} uncommitted edit(s) on this page.`, 'Discard', true);
    };

    tab.onChanges = (n) => {
      changesBox.classList.toggle('hidden', !n);
      changesBox.querySelector('.changes-count').textContent = `${n} change${n === 1 ? '' : 's'}`;
      Lookup.paintTabState();
    };

    tab.reload = async (skipConfirm) => {
      if (!skipConfirm && !(await tab.confirmLeave())) return;
      gridHost.classList.add('loading');
      if (!gridHost.firstChild) gridHost.append(h('div', { class: 'grid-loading' }, h('div', { class: 'spinner' })));
      try {
        const d = await api.tableData({ owner, name, type, offset: tab.offset, limit: tab.limit, filters: tab.filters, sort: tab.sort, withCount: true });
        tab.data = d;
        if (tab.grid) tab.grid.destroy();
        gridHost.innerHTML = '';
        tab.grid = new window.DataGrid({
          columns: d.columns, rows: d.rows, rowids: d.rowids, editable: d.editable, sort: tab.sort, startIndex: tab.offset,
          onSort: async (col) => {
            if (!(await tab.confirmLeave())) return;
            tab.sort = tab.sort && tab.sort.col === col ? (tab.sort.dir === 'asc' ? { col, dir: 'desc' } : null) : { col, dir: 'asc' };
            tab.offset = 0;
            tab.reload(true);
          },
          onChange: (n) => tab.onChanges(n),
          onSelect: (idx) => { tab.selected = idx; tab.paintDetails(); },
          onFilterValue: (col, v) => {
            tab.filters = [v === null ? { col, op: 'IS NULL', value: '' } : { col, op: '=', value: cellText(v) }];
            tab.offset = 0;
            tab.paintFilters(true);
            tab.reload();
          },
        });
        gridHost.append(tab.grid.el);
        tab.onChanges(0);
        const from = d.rows.length ? tab.offset + 1 : 0;
        const to = tab.offset + d.rows.length;
        pagerInfo.textContent = `${fmtNum(from)}–${fmtNum(to)} of ${d.total === null ? '?' : fmtNum(d.total)} rows`;
        prev.disabled = tab.offset === 0;
        next.disabled = d.rows.length < tab.limit || (d.total !== null && to >= d.total);
        timing.textContent = fmtMs(d.ms) + (d.editable ? '' : ' · read-only');
        tab.selected = null;
        tab.paintDetails();
        Lookup.cacheColumns(owner, name, d.columns);
      } catch (e) {
        gridHost.innerHTML = '';
        gridHost.append(h('div', { class: 'grid-error' }, h('div', { class: 'err-title' }, 'Query failed'), h('pre', { class: 'err-text' }, e.message)));
      } finally {
        gridHost.classList.remove('loading');
      }
    };

    tab.paintDetails = () => {
      details.classList.toggle('hidden', !tab.showDetails);
      if (!tab.showDetails) return;
      details.innerHTML = '';
      details.append(h('div', { class: 'details-head' }, 'Row details'));
      const g = tab.grid;
      if (!g || tab.selected === null || tab.selected === undefined) {
        details.append(h('div', { class: 'empty-small' }, 'Select a row'));
        return;
      }
      const idx = tab.selected;
      g.columns.forEach((col, c) => {
        const v = g.value(idx, c);
        const isBin = v && typeof v === 'object';
        const ta = h('textarea', {
          class: 'input detail-val' + (v === null ? ' is-null' : ''), rows: 1, spellcheck: 'false',
          placeholder: v === null ? 'NULL' : '', readOnly: !g.editable || isBin || g.deleted.has(idx),
          onchange: (e) => g.setValue(idx, c, e.target.value === '' && v === null ? null : e.target.value),
        });
        ta.value = v === null ? '' : cellText(v);
        details.append(h('div', { class: 'detail-row' },
          h('div', { class: 'detail-label' }, h('span', null, col.name), h('span', { class: 'muted' }, (col.fullType || col.type || '').toLowerCase())), ta));
        requestAnimationFrame(() => { ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
      });
    };

    const OPS = ['=', '<>', '<', '>', '<=', '>=', 'CONTAINS', 'LIKE', 'NOT LIKE', 'IN', 'IS NULL', 'IS NOT NULL'];
    tab.paintFilters = (show) => {
      if (show) filterBox.classList.remove('hidden');
      filterBox.innerHTML = '';
      const rows = tab.filters.length ? tab.filters : [{ col: tab.data && tab.data.columns[0] ? tab.data.columns[0].name : '', op: '=', value: '' }];
      tab.draft = rows.map((f) => ({ ...f }));
      const cols = tab.data ? tab.data.columns.map((c) => c.name) : [];
      const apply = () => {
        tab.filters = tab.draft.filter((f) => f.op === 'RAW' ? String(f.value).trim() : f.col && (f.op.includes('NULL') || String(f.value).length));
        tab.offset = 0;
        tab.reload();
        updateFilterCount();
      };
      tab.draft.forEach((f, i) => {
        const colSel = h('select', { class: 'input xs', onchange: (e) => { if (e.target.value === '__raw') { f.op = 'RAW'; } else { f.col = e.target.value; if (f.op === 'RAW') f.op = '='; } tab.paintFiltersDraft(); } },
          h('option', { value: '__raw' }, 'SQL WHERE…'), cols.map((c) => h('option', { value: c }, c)));
        colSel.value = f.op === 'RAW' ? '__raw' : f.col;
        const opSel = h('select', { class: 'input xs', onchange: (e) => { f.op = e.target.value; tab.paintFiltersDraft(); } }, OPS.map((o) => h('option', { value: o }, o.toLowerCase())));
        opSel.value = f.op;
        const val = h('input', {
          class: 'input xs grow mono', placeholder: f.op === 'RAW' ? "e.g. STATUS = 'ACTIVE' AND CREATED > SYSDATE - 7" : f.op === 'IN' ? 'a, b, c' : 'value',
          oninput: (e) => { f.value = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') tab.toggleFilter(false); },
        });
        val.value = f.value ?? '';
        const noVal = f.op === 'IS NULL' || f.op === 'IS NOT NULL';
        filterBox.append(h('div', { class: 'filter-row' },
          h('span', { class: 'muted filter-and' }, i === 0 ? 'where' : 'and'),
          colSel, f.op === 'RAW' ? null : opSel, noVal ? null : val,
          h('button', { class: 'icon-btn', title: 'Remove', onclick: () => { tab.draft.splice(i, 1); if (!tab.draft.length) { tab.filters = []; apply(); tab.paintFilters(); } else tab.paintFiltersDraft(); } }, icon('x'))));
      });
      filterBox.append(h('div', { class: 'filter-actions' },
        h('button', { class: 'btn sm ghost', onclick: () => { tab.draft.push({ col: cols[0], op: '=', value: '' }); tab.paintFiltersDraft(); } }, icon('plus'), 'Condition'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm ghost', onclick: () => { tab.filters = []; tab.offset = 0; tab.reload(); tab.paintFilters(); updateFilterCount(); } }, 'Clear'),
        h('button', { class: 'btn sm primary', onclick: apply }, 'Apply')));
      const first = filterBox.querySelector('input');
      if (show && first) setTimeout(() => first.focus(), 0);
    };
    tab.paintFiltersDraft = () => {
      const saved = tab.filters;
      tab.filters = tab.draft;
      tab.paintFilters();
      tab.filters = saved;
    };
    const updateFilterCount = () => {
      const n = tab.filters.length;
      const badge = dataTools.querySelector('.filter-n');
      badge.textContent = n ? String(n) : '';
      badge.parentNode.classList.toggle('on', !!n);
    };
    tab.toggleFilter = (force) => {
      const show = force !== undefined ? force : filterBox.classList.contains('hidden');
      if (show) tab.paintFilters(true); else filterBox.classList.add('hidden');
    };

    tab.onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (tab.view === 'structure' && mod && e.key.toLowerCase() === 's' && tab.structEditor) {
        e.preventDefault();
        if (tab.structEditor.count()) Lookup.applyStructure(tab);
        return true;
      }
      if (tab.view !== 'data') return false;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (tab.grid && tab.grid.changeCount()) commitChanges(tab); else Lookup.commitShortcut(); return true; }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); tab.toggleFilter(true); return true; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
      if (mod && !typing && tab.grid && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        const redo = e.key.toLowerCase() === 'y' || e.shiftKey;
        const label = redo ? tab.grid.redo() : tab.grid.undo();
        if (label) toast(`${redo ? 'Redo' : 'Undo'}: ${label}`, 'info', 1800);
        tab.grid.el.focus({ preventScroll: true });
        return true;
      }
      if (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r')) { e.preventDefault(); tab.reload(); return true; }
      return false;
    };
    tab.onShow = () => { if (tab.grid) tab.grid.paint(); };
    tab.isDirty = () => !!(tab.structEditor && tab.structEditor.count());
    tab.destroy = () => tab.grid && tab.grid.destroy();

    Lookup.addTab(tab);
    tab.setView(view);
  }
  async function previewChanges(tab) {
    try {
      const sql = await api.previewChanges({ owner: tab.owner, name: tab.name, changes: tab.grid.getChanges() });
      modal({
        title: 'Pending changes',
        wide: true,
        body: h('pre', { class: 'ddl-code boxed', html: window.SqlEditor.highlight(sql) }),
        actions: [
          { label: 'Copy SQL', onClick: () => { api.copy(sql); toast('Copied', 'ok'); return false; } },
          { label: 'Close' },
          { label: 'Commit', kind: 'primary', onClick: () => commitChanges(tab) },
        ],
      });
    } catch (e) { toast(e.message, 'err', 6000); }
  }
  async function commitChanges(tab) {
    if (S.current && S.current.env === 'prod' && !(await confirmBox('Production database', `Commit ${tab.grid.changeCount()} change(s) to ${tab.owner}.${tab.name} on a production connection?`, 'Commit', true))) return;
    if (S.txPending && !S.autoCommit && !(await confirmBox('Open transaction', 'Committing these edits will also commit the uncommitted statements you ran in query tabs.', 'Commit all', true))) return;
    try {
      const r = await api.applyChanges({ owner: tab.owner, name: tab.name, changes: tab.grid.getChanges() });
      S.txPending = false;
      Lookup.renderTitlebar();
      Lookup.renderStatus();
      toast(`Committed ${r.count} statement${r.count === 1 ? '' : 's'}`, 'ok');
      tab.reload(true);
    } catch (e) {
      modal({ title: 'Commit failed — nothing was saved', wide: true, body: h('pre', { class: 'err-text' }, e.message), actions: [{ label: 'OK', kind: 'primary' }] });
    }
  }
  // ---------- Page size picker (table pager) ----------
  // Click: pick 100 / 300 / 500 / 1000 from a list. Double-click: type any number (Enter applies, Esc cancels).
  const PAGE_SIZE_MAX = 100000;
  function pageSizeControl(value, onPick) {
    let cur = value;
    let clickTimer = null;
    const label = h('span', null);
    const btn = h('button', { class: 'input xs page-size', title: 'Rows per page — double-click to type a number' }, label, h('span', { class: 'caret' }, '▾'));
    const wrap = h('span', { class: 'page-size-wrap' }, btn);
    const paint = () => { label.textContent = fmtNum(cur) + ' rows'; };
    const pick = (n) => { n = Math.max(1, Math.min(PAGE_SIZE_MAX, Math.round(n))); if (n !== cur) { cur = n; paint(); onPick(n); } else paint(); };
    paint();
    btn.addEventListener('click', () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        const r = btn.getBoundingClientRect();
        const opts = [100, 300, 500, 1000];
        contextMenu(r.left, r.top - (opts.length + 2) * 30, [
          ...opts.map((n) => ({ label: fmtNum(n) + ' rows', icon: n === cur ? 'check' : null, onClick: () => pick(n) })),
          '-',
          { label: 'Custom…', hint: 'double-click', onClick: () => edit() },
        ]);
      }, 230);
    });
    btn.addEventListener('dblclick', (e) => { e.preventDefault(); clearTimeout(clickTimer); edit(); });
    function edit() {
      closeMenu();
      const input = h('input', { class: 'input xs page-size-input', type: 'number', min: '1', max: String(PAGE_SIZE_MAX), step: '1', value: String(cur), title: `Rows per page (1–${fmtNum(PAGE_SIZE_MAX)}), Enter to apply` });
      let done = false;
      const finish = (apply) => {
        if (done) return;
        done = true;
        const n = Number(input.value);
        input.replaceWith(btn);
        if (apply && Number.isFinite(n) && n >= 1) pick(n);
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      btn.replaceWith(input);
      input.focus();
      input.select();
    }
    return wrap;
  }

  Object.assign(Lookup, { openTableTab });
})();
