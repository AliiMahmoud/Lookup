// Query tabs: editor, autocomplete source, Beautify, run / Stop, results and messages, history, and saving tabs per connection.
(function () {
  const { h, icon, toast, modal, confirmBox, fmtNum, fmtMs, debounce } = window.U;
  const api = window.api;
  const Lookup = window.Lookup;
  const { S } = Lookup;

  // ---------- Stop ----------
  // One cancel request to the server, like SQL Developer / DBeaver. If the server hasn't stopped the
  // query after 10 s, offer to keep waiting or to close the session (the server then ends the query).
  const STOP_WAIT_MS = 10000;
  function stopQuery(tab) {
    if (tab.stopping) return;
    tab.stopping = true;
    const { stopBtn, resBody } = tab.parts;
    stopBtn.disabled = true;
    stopBtn.lastChild.textContent = 'Stopping…';
    const waiting = () => {
      resBody.innerHTML = '';
      resBody.append(h('div', { class: 'grid-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Cancelling… waiting for the database to stop the query')));
      clearTimeout(tab.stopTimer);
      tab.stopTimer = setTimeout(stuck, STOP_WAIT_MS);
    };
    const stuck = () => {
      if (!tab.stopping) return;
      resBody.innerHTML = '';
      resBody.append(h('div', { class: 'stop-stuck' },
        h('div', { class: 'stop-stuck-title' }, 'The database hasn\u2019t stopped the query yet'),
        h('div', { class: 'muted' }, 'It is busy and will stop when it next checks for the cancel request. You can keep waiting, or close this session: the database then ends the query and rolls back uncommitted changes. Reconnect (Ctrl+R) opens a new session.'),
        h('div', { class: 'stop-stuck-actions' },
          h('button', { class: 'btn sm', onclick: waiting }, 'Keep waiting'),
          h('button', { class: 'btn sm danger', onclick: () => api.closeStuckSession().catch((e) => toast(e.message, 'err')) }, 'Close session'))));
    };
    waiting();
    api.cancel().catch(() => {});
  }
  // ---------- Query tab ----------
  let queryNo = 0;
  async function completions({ word, table }) {
    const out = [];
    if (table) {
      const parts = table.toUpperCase().split('.');
      const schemaHit = parts.length === 1 && S.schemas.some((s) => s.name === parts[0]);
      if (schemaHit) {
        try {
          (await Lookup.getObjects(parts[0])).forEach((o) => out.push({ label: o.name, kind: o.type === 'VIEW' ? 'view' : o.type === 'TABLE' ? 'table' : 'object', detail: o.type.toLowerCase() }));
        } catch { /* ignore */ }
        return out;
      }
      const owner = parts.length > 1 ? parts[0] : S.schema;
      const tname = parts[parts.length - 1];
      let cols = S.colCache.get(owner + '.' + tname);
      if (!cols) {
        try {
          cols = (await api.columns(owner, tname)).map((c) => ({ name: c.name, type: c.fullType }));
          S.colCache.set(owner + '.' + tname, cols);
        } catch { cols = []; }
      }
      cols.forEach((c) => out.push({ label: c.name, kind: 'column', detail: (c.type || '').toLowerCase() }));
      return out;
    }
    S.objects.forEach((o) => out.push({ label: o.name, kind: o.type === 'VIEW' ? 'view' : o.type === 'TABLE' ? 'table' : 'object', detail: o.type.toLowerCase() }));
    for (const cols of S.colCache.values()) cols.forEach((c) => out.push({ label: c.name, kind: 'column', detail: (c.type || '').toLowerCase() }));
    window.SqlEditor.KEYWORDS.forEach((k) => out.push({ label: k, kind: 'keyword' }));
    window.SqlEditor.FUNCS.forEach((k) => out.push({ label: k, kind: 'function' }));
    S.schemas.forEach((s) => out.push({ label: s.name, kind: 'schema' }));
    const seen = new Set();
    return out.filter((x) => { const k = x.label + x.kind; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  function openQueryTab({ title, text = '', run = false } = {}) {
    queryNo++;
    const tab = { kind: 'query', title: title || `Query ${queryNo}`, defaultTitle: `Query ${queryNo}`, icon: 'code', results: [], resIndex: 0 };
    const runBtn = h('button', { class: 'btn sm primary', title: 'Run current statement (Ctrl+Enter)', onclick: () => runQuery(tab, 'current') }, icon('play'), 'Run');
    const runAllBtn = h('button', { class: 'btn sm', title: 'Run all (Ctrl+Shift+Enter)', onclick: () => runQuery(tab, 'all') }, icon('playAll'), 'Run all');
    const stopBtn = h('button', { class: 'btn sm hidden', title: 'Stop: ask the database to cancel the query', onclick: () => stopQuery(tab) }, icon('stop'), h('span', null, 'Stop'));
    const explainBtn = h('button', { class: 'btn sm ghost', title: 'Explain plan for current statement', onclick: () => runQuery(tab, 'explain') }, 'Explain');
    const formatBtn = h('button', { class: 'btn sm ghost', title: 'Beautify SQL (Ctrl+B) — formats the selection, or the whole editor', onclick: () => beautify(tab) }, icon('format'), 'Beautify');
    const maxRows = h('select', { class: 'input xs', title: 'Row limit' },
      [100, 500, 1000, 5000].map((n) => h('option', { value: n }, `Limit ${n}`)), h('option', { value: '0' }, 'No limit'));
    maxRows.value = '500';
    const toolbar = h('div', { class: 'toolbar' }, runBtn, runAllBtn, stopBtn, explainBtn, h('div', { class: 'tb-sep' }), formatBtn, h('div', { class: 'spacer' }),
      maxRows,
      h('button', { class: 'tool', title: 'Query history', onclick: () => showHistory(tab) }, icon('history')),
      h('button', { class: 'tool', title: 'Open .sql file', onclick: async () => { const f = await api.openSql(); if (f) { tab.editor.value = f.text; tab.title = f.name; Lookup.renderTabs(); saveQueryTabs(); } } }, icon('open')),
      h('button', { class: 'tool', title: 'Save as .sql (Ctrl+Shift+S)', onclick: () => saveSqlFile(tab) }, icon('save')));
    tab.editor = new window.SqlEditor({
      value: text,
      onChange: debounce(() => saveQueryTabs(), 500),
      onRun: () => runQuery(tab, 'current'),
      onRunAll: () => runQuery(tab, 'all'),
      onSave: () => Lookup.commitShortcut(),
      onSaveFile: () => saveSqlFile(tab),
      onFormat: () => beautify(tab),
      dialect: () => Lookup.dialect(), // how statements are split (Oracle / PostgreSQL / MySQL)
      completions,
    });
    const edHost = h('div', { class: 'ed-host' }, tab.editor.el);
    const split = h('div', { class: 'hsplit' });
    const resTabs = h('div', { class: 'res-tabs' });
    const resBody = h('div', { class: 'res-body' }, h('div', { class: 'empty-small center' }, 'Run a query to see results here'));
    const resFoot = h('div', { class: 'pager' });
    const results = h('div', { class: 'results' }, resTabs, resBody, resFoot);
    // Results stay hidden until the first run, and can be closed with the × on their tab bar.
    tab.el = h('div', { class: 'tabview query no-results' }, toolbar, edHost, split, results);
    tab.parts = { resTabs, resBody, resFoot, runBtn, runAllBtn, stopBtn, explainBtn, maxRows, edHost };

    split.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const y0 = e.clientY;
      const h0 = edHost.getBoundingClientRect().height;
      const move = (ev) => { edHost.style.flexBasis = Math.max(80, Math.min(h0 + ev.clientY - y0, tab.el.clientHeight - 140)) + 'px'; };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); tab.grid && tab.grid.paint(); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });

    tab.onShow = () => { tab.editor.focus(); if (tab.grid) tab.grid.paint(); };
    tab.destroy = () => tab.grid && tab.grid.destroy();
    Lookup.addTab(tab);
    saveQueryTabs();
    if (run) runQuery(tab, 'all');
    return tab;
  }
  async function beautify(tab) {
    const ta = tab.editor.ta;
    let a = ta.selectionStart;
    let b = ta.selectionEnd;
    const whole = a === b;
    if (whole) { a = 0; b = ta.value.length; }
    const src = ta.value.slice(a, b);
    if (!src.trim()) return;
    try {
      const r = await api.formatSql(src, S.current && S.current.engine);
      if (r.text !== src) {
        ta.focus();
        ta.setSelectionRange(a, b);
        tab.editor.insert(r.text); // one undo step (Ctrl+Z restores the original)
        if (!whole) ta.setSelectionRange(a, a + r.text.length);
        else ta.setSelectionRange(0, 0);
        tab.editor.sync();
      }
      // Statements that can't be parsed (and PL/SQL blocks) are simply left as written, without a message.
    } catch { /* leave the text as it is */ }
  }
  async function saveSqlFile(tab) {
    try {
      const p = await api.saveSql({ name: tab.title.replace(/\.sql$/i, ''), text: tab.editor.value });
      if (p) toast('Saved ' + p, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function runQuery(tab, mode) {
    const ed = tab.editor;
    let stmts;
    const selText = ed.selection();
    if (mode === 'all') {
      stmts = window.SqlSplit.split(ed.value, Lookup.dialect()).map((s) => ({ ...s, base: 0 }));
    } else if (selText) {
      const base = ed.ta.selectionStart;
      stmts = window.SqlSplit.split(selText, Lookup.dialect()).map((s) => ({ ...s, base }));
    } else {
      const st = ed.currentStatement();
      stmts = st ? [{ ...st, base: 0 }] : [];
    }
    if (!stmts.length) { toast('Nothing to run', 'info'); return; }
    if (mode === 'explain') {
      const st = stmts[0];
      // Oracle: EXPLAIN PLAN FOR + DBMS_XPLAN; PostgreSQL / MySQL: EXPLAIN returns the plan as rows.
      const [first, ...rest] = Lookup.profile().explain || ['EXPLAIN {sql}'];
      stmts = [
        { ...st, text: Lookup.fill(first, { sql: st.text }), explainOf: st },
        ...rest.map((text) => ({ text, base: 0, start: st.start })),
      ];
    }
    if (S.current && S.current.env === 'prod' && stmts.some((s) => /^\s*(delete|update|insert|merge|drop|truncate|alter)\b/i.test(s.text))) {
      if (!(await confirmBox('Production database', 'This will modify data or schema on a production connection. Continue?', 'Run', true))) return;
    }
    const { runBtn, runAllBtn, stopBtn, resBody, maxRows } = tab.parts;
    tab.el.classList.remove('no-results'); // every run brings the results panel back
    runBtn.disabled = runAllBtn.disabled = true;
    stopBtn.classList.remove('hidden');
    resBody.innerHTML = '';
    resBody.append(h('div', { class: 'grid-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, stmts.length > 1 ? `Running ${stmts.length} statements…` : 'Running…')));
    const t0 = Date.now();
    let results;
    try {
      results = await api.run(stmts.map((s) => s.text), { maxRows: Number(maxRows.value) });
    } catch (e) {
      results = [{ kind: 'error', message: e.message, sql: '' }];
    } finally {
      clearTimeout(tab.stopTimer);
      const stopped = tab.stopping;
      tab.stopping = false;
      runBtn.disabled = runAllBtn.disabled = false;
      stopBtn.disabled = false;
      stopBtn.lastChild.textContent = 'Stop';
      stopBtn.classList.add('hidden');
      // The server confirmed the cancel (the engine marks it): show it as a plain message, not an error.
      results = results.map((r) => (r.kind === 'error' && (r.cancelled || (stopped && r.lost))
        ? { ...r, kind: 'cancelled', message: r.lost ? r.message : 'Query cancelled' } : r));
    }
    if (mode === 'explain') results = results.filter((r) => !(r.kind === 'exec' && /^EXPLAIN/i.test(r.sql)));
    const total = Date.now() - t0;
    if (S.current) api.addHistory(S.current.id, stmts.map((s) => s.text + (s.plsql && Lookup.dialect() === 'oracle' ? '\n/' : ';')).join('\n')).catch(() => {});
    // PostgreSQL / MySQL report whether a transaction is open; for Oracle it is worked out from the statements.
    const reported = [...results].reverse().find((r) => typeof r.txOpen === 'boolean');
    const txNow = reported ? reported.txOpen
      : S.txPending || results.some((r) => r.kind === 'exec' && /^\s*(insert|update|delete|merge|begin|declare|call)\b/i.test(r.sql));
    if (!S.autoCommit && txNow !== S.txPending) {
      S.txPending = txNow;
      Lookup.renderTitlebar();
      Lookup.renderStatus();
    }
    if (results.some((r) => r.kind === 'exec' && /^\s*(create|drop|alter|rename|truncate)\b/i.test(r.sql))) {
      S.objCache.delete(S.schema);
      S.colCache.clear();
      Lookup.loadObjects(true);
    }
    const err = results.find((r) => r.kind === 'error');
    if (err) {
      const st = stmts[results.indexOf(err)];
      if (st && typeof err.offset === 'number' && mode !== 'explain') {
        const pos = st.base + st.start + err.offset;
        ed.ta.focus();
        ed.ta.setSelectionRange(pos, pos);
      }
    }
    tab.results = results;
    tab.totalMs = total;
    const firstRows = results.findIndex((r) => r.kind === 'rows');
    tab.resIndex = err ? -1 : firstRows >= 0 ? firstRows : -1;
    paintResults(tab);
  }
  // Hides the results panel and frees the rows it held; the editor takes the full height.
  function closeResults(tab) {
    if (tab.grid) { tab.grid.destroy(); tab.grid = null; }
    tab.results = [];
    tab.parts.resTabs.innerHTML = '';
    tab.parts.resBody.innerHTML = '';
    tab.parts.resFoot.innerHTML = '';
    tab.el.classList.add('no-results');
    tab.editor.focus();
    Lookup.trimSoon();
  }
  function paintResults(tab) {
    const { resTabs, resBody, resFoot } = tab.parts;
    resTabs.innerHTML = '';
    tab.results.forEach((r, i) => {
      if (r.kind !== 'rows') return;
      resTabs.append(h('button', { class: 'res-tab' + (tab.resIndex === i ? ' on' : ''), onclick: () => { tab.resIndex = i; paintResults(tab); } },
        `Result ${tab.results.slice(0, i + 1).filter((x) => x.kind === 'rows').length}`, h('span', { class: 'count' }, fmtNum(r.rows.length) + (r.truncated ? '+' : ''))));
    });
    const hasErr = tab.results.some((r) => r.kind === 'error');
    const hasOut = tab.results.some((r) => r.output && r.output.length);
    resTabs.append(h('button', { class: 'res-tab' + (tab.resIndex === -1 ? ' on' : '') + (hasErr ? ' err' : ''), onclick: () => { tab.resIndex = -1; paintResults(tab); } },
      'Messages', hasOut ? h('span', { class: 'count' }, 'output') : null));
    resTabs.append(h('div', { class: 'spacer' }),
      h('button', { class: 'res-close', title: 'Close results (they come back when you run a query)', onclick: () => closeResults(tab) }, icon('x')));
    if (tab.grid) { tab.grid.destroy(); tab.grid = null; }
    resBody.innerHTML = '';
    resFoot.innerHTML = '';
    if (tab.resIndex >= 0) {
      const r = tab.results[tab.resIndex];
      tab.grid = new window.DataGrid({ columns: r.columns, rows: r.rows, editable: false });
      resBody.append(tab.grid.el);
      resFoot.append(
        h('span', { class: 'pager-info' }, `${fmtNum(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ' (limit reached)' : ''}`),
        h('span', { class: 'muted' }, fmtMs(r.ms)),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm ghost', title: 'Export results (Ctrl+E)', onclick: () => Lookup.exportResult(tab, r) }, icon('download'), 'Export'));
    } else {
      const box = h('div', { class: 'messages scroll' });
      tab.results.forEach((r) => {
        const snippet = (r.sql || '').replace(/\s+/g, ' ').slice(0, 140);
        if (r.kind === 'cancelled') {
          box.append(h('div', { class: 'msg' }, h('div', { class: 'msg-head' }, icon('stop'), h('span', null, r.message), h('span', { class: 'muted' }, fmtMs(r.ms || 0))),
            snippet ? h('div', { class: 'msg-sql mono muted' }, snippet) : null));
        } else if (r.kind === 'error') {
          box.append(h('div', { class: 'msg err' }, h('div', { class: 'msg-head' }, icon('x'), h('span', null, 'Error'), h('span', { class: 'muted' }, fmtMs(r.ms || 0))),
            h('pre', { class: 'err-text' }, r.message), snippet ? h('div', { class: 'msg-sql mono muted' }, snippet) : null));
        } else {
          const what = r.kind === 'rows' ? `${fmtNum(r.rows.length)} row(s) fetched` : r.rowsAffected !== undefined ? `${fmtNum(r.rowsAffected)} row(s) affected` : 'Statement executed';
          box.append(h('div', { class: 'msg ok' }, h('div', { class: 'msg-head' }, icon('check'), h('span', null, what), h('span', { class: 'muted' }, fmtMs(r.ms || 0))),
            h('div', { class: 'msg-sql mono muted' }, snippet),
            r.output && r.output.length ? h('pre', { class: 'dbms-out' }, r.output.join('\n')) : null));
        }
      });
      if (!tab.results.length) box.append(h('div', { class: 'empty-small' }, 'No messages'));
      resBody.append(box);
      resFoot.append(h('span', { class: 'pager-info' }, `${tab.results.length} statement(s) · ${fmtMs(tab.totalMs || 0)} total`));
    }
  }
  async function showHistory(tab) {
    const list = await api.history(S.current && S.current.id).catch(() => []);
    const search = h('input', { class: 'input', placeholder: 'Search history' });
    const box = h('div', { class: 'history-list' });
    let m;
    const paint = () => {
      const q = search.value.toLowerCase();
      box.innerHTML = '';
      const items = list.filter((x) => !q || x.sql.toLowerCase().includes(q));
      if (!items.length) box.append(h('div', { class: 'empty-small' }, 'No history yet'));
      items.forEach((x) => box.append(h('div', {
        class: 'history-item',
        onclick: () => { tab.editor.value = (tab.editor.value.trim() ? tab.editor.value.replace(/\s*$/, '\n\n') : '') + x.sql; saveQueryTabs(); m.close(); tab.editor.focus(); },
      }, h('pre', { class: 'mono', html: window.SqlEditor.highlight(x.sql.length > 600 ? x.sql.slice(0, 600) + '…' : x.sql) }), h('div', { class: 'muted' }, new Date(x.at).toLocaleString()))));
    };
    search.addEventListener('input', paint);
    paint();
    m = modal({ title: 'Query history', wide: true, body: h('div', null, search, box) });
  }
  // ---------- Persist query tabs per connection ----------
  function saveQueryTabs() {
    if (!S.current) return;
    const tabs = S.tabs.filter((t) => t.kind === 'query').map((t) => ({ title: t.title, text: t.editor.value, zoom: t.editor.zoom !== 100 ? t.editor.zoom : undefined }));
    try { localStorage.setItem('lookup.queries.' + S.current.id, JSON.stringify(tabs)); } catch { /* storage full */ }
  }
  function restoreQueryTabs() {
    queryNo = 0;
    let tabs = [];
    try { tabs = JSON.parse(localStorage.getItem('lookup.queries.' + S.current.id) || '[]'); } catch { tabs = []; }
    tabs.forEach((t) => { const tab = openQueryTab({ title: t.title, text: t.text }); if (t.zoom && tab && tab.editor) tab.editor.setZoom(t.zoom); });
    const nums = tabs.map((t) => Number((t.title.match(/^Query (\d+)$/) || [])[1] || 0));
    queryNo = Math.max(0, ...nums);
  }

  Object.assign(Lookup, { openQueryTab, saveQueryTabs, restoreQueryTabs });
})();
