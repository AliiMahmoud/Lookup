// Redis key tabs: header (type, name, time to live counting down, size, rename, delete) and an editor
// per type. Strings and JSON: Text / JSON / Hex views. Hashes, lists, sets and sorted sets: one table
// editor with staged changes (edit, add, delete) saved together in MULTI / EXEC (Ctrl+S). Streams:
// entries newest first, add and delete entries, consumer groups.
(function () {
  const { h, icon, toast, modal, confirmBox, contextMenu, fmtNum, fmtBytes, fmtMs, debounce } = window.U;
  const api = window.api;
  const Lookup = window.Lookup;
  const { S } = Lookup;
  const Cli = window.RedisCli;

  const textOf = (v) => Lookup.redisText(v);
  const keyId = (k) => Lookup.redisKeyId(k);
  const isBinary = (v) => Lookup.redisIsBinary(v);
  const rop = (...a) => Lookup.rop(...a);
  const fail = (e) => Lookup.opFail(e);
  const enc = new TextEncoder();
  const bytesOf = (v) => (isBinary(v) ? Cli.fromB64(v.b64) : enc.encode(String(v === null || v === undefined ? '' : v)));
  const cmdText = (cmds) => cmds.map((c) => c.map((a) => Cli.quoteArg(typeof a === 'number' ? String(a) : a)).join(' ')).join('\n');

  // ---------- Value views ----------
  /** Pretty JSON with colours, or null when the text isn't a JSON object / array. */
  function jsonView(text) {
    const s = String(text).trim();
    if (!/^[[{]/.test(s)) return null;
    let v;
    try { v = JSON.parse(s); } catch { return null; }
    const out = h('pre', { class: 'r-json' });
    const add = (cls, t) => out.append(cls ? h('span', { class: cls }, t) : document.createTextNode(t));
    const walk = (x, ind) => {
      const pad = '  '.repeat(ind);
      if (Array.isArray(x)) {
        if (!x.length) { add(null, '[]'); return; }
        const flat = x.every((y) => y === null || typeof y !== 'object') && JSON.stringify(x).length < 60;
        add(null, '[');
        x.forEach((y, i) => { add(null, flat ? (i ? ', ' : '') : '\n' + pad + '  '); walk(y, ind + 1); if (!flat && i < x.length - 1) add(null, ','); });
        add(null, flat ? ']' : '\n' + pad + ']');
      } else if (x && typeof x === 'object') {
        const keys = Object.keys(x);
        if (!keys.length) { add(null, '{}'); return; }
        add(null, '{');
        keys.forEach((k, i) => { add(null, '\n' + pad + '  '); add('j-key', JSON.stringify(k)); add(null, ': '); walk(x[k], ind + 1); if (i < keys.length - 1) add(null, ','); });
        add(null, '\n' + pad + '}');
      } else if (typeof x === 'string') add('j-str', JSON.stringify(x));
      else if (typeof x === 'number') add('j-num', String(x));
      else if (typeof x === 'boolean') add('j-bool', String(x));
      else add('j-null', 'null');
    };
    walk(v, 0);
    return out;
  }
  /** Classic hex dump: offset, 16 bytes, printable ASCII. */
  function hexDump(bytes, max = 64 * 1024) {
    const lines = [];
    const n = Math.min(bytes.length, max);
    for (let i = 0; i < n; i += 16) {
      const row = bytes.slice(i, Math.min(i + 16, n));
      const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
      const asc = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  |${asc}|`);
    }
    if (bytes.length > max) lines.push(`… ${fmtNum(bytes.length - max)} more bytes`);
    return lines.join('\n');
  }
  const isJsonText = (t) => { const s = String(t).trim(); if (!/^[[{]/.test(s)) return false; try { JSON.parse(s); return true; } catch { return false; } };
  /** One-line text for a table cell (binary shown with \xHH). */
  const cellText = (v) => (isBinary(v) ? Cli.bulkText({ b: v.b64 }) : String(v === null || v === undefined ? '' : v));

  /** Text / JSON / Hex segmented switch. */
  function viewSeg(current, onPick, { json = true, text = true } = {}) {
    const seg = h('div', { class: 'seg sm' });
    for (const [id, label, ok] of [['text', 'Text', text], ['json', 'JSON', json], ['hex', 'Hex', true]]) {
      seg.append(h('button', { type: 'button', class: id === current ? 'on' : '', disabled: !ok, onclick: () => onPick(id) }, label));
    }
    return seg;
  }

  // ---------- Tabs ----------
  function openRedisKey(k) {
    const existing = S.tabs.find((t) => t.kind === 'rkey' && keyId(t.key) === keyId(k.key));
    if (existing) { Lookup.activate(existing.id); return existing; }
    const tab = {
      kind: 'rkey', key: k.key, type: k.type, title: textOf(k.key), name: textOf(k.key), icon: 'key',
      tooltip: `${Lookup.REDIS_TYPES[k.type] || k.type} key`, el: h('div', { class: 'tabview r-keyview' }),
      changes: 0, timers: [],
    };
    tab.grid = { changeCount: () => tab.changes };
    tab.setChanges = (n) => { tab.changes = n; Lookup.paintTabState(); };
    tab.destroy = () => { tab.timers.forEach(clearInterval); };
    tab.onShow = () => Lookup.redisPaintActive();
    tab.onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); if (tab.save) tab.save(); return true; }
      return false;
    };
    tab.renamed = (moved) => { tab.key = moved.key; tab.title = tab.name = textOf(moved.key); Lookup.renderTabs(); load(tab); };
    Lookup.addTab(tab);
    load(tab);
    return tab;
  }

  async function load(tab) {
    tab.timers.forEach(clearInterval);
    tab.timers = [];
    tab.save = null;
    tab.setChanges(0);
    tab.el.innerHTML = '';
    tab.el.append(h('div', { class: 'grid-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Loading key…')));
    let info;
    try { info = await rop('keyInfo', { key: tab.key }); } catch (e) {
      tab.el.innerHTML = '';
      tab.el.append(h('div', { class: 'r-gone' }, h('div', { class: 'err-text' }, e.message), h('button', { class: 'btn sm', onclick: () => load(tab) }, 'Try again')));
      return;
    }
    tab.el.innerHTML = '';
    if (!info.exists) { showGone(tab, 'This key no longer exists. It may have expired or been deleted.'); Lookup.redisKeyGone(tab.key); return; }
    tab.info = info;
    tab.type = info.type;
    const body = h('div', { class: 'r-keybody' });
    tab.el.append(header(tab, info), body);
    const editor = EDITORS[info.type] || unsupported;
    try { await editor(tab, body, info); } catch (e) { body.innerHTML = ''; body.append(h('div', { class: 'r-gone' }, h('div', { class: 'err-text' }, e.message))); }
    Lookup.redisKeyChanged(tab.key, { ttl: info.ttl, size: info.size, type: info.type });
  }
  function showGone(tab, text) {
    tab.el.innerHTML = '';
    tab.setChanges(0);
    tab.el.append(h('div', { class: 'r-gone' }, icon('key'), h('div', null, text),
      h('div', { class: 'r-gone-actions' },
        h('button', { class: 'btn sm', onclick: () => load(tab) }, 'Check again'),
        h('button', { class: 'btn sm', onclick: () => Lookup.closeTab(tab.id, true) }, 'Close tab'))));
  }

  function header(tab, info) {
    const k = { key: tab.key, type: info.type, ttl: info.ttl, size: info.size };
    // Time to live counts down here; at zero the server has removed the key.
    const ttlPill = h('button', { class: 'r-pill', title: 'Set or remove the time to live', onclick: () => Lookup.redisTtlDialog({ ...k, ttl: liveTtl() }, (ttl) => { info.ttl = ttl; t0 = Date.now(); paintTtl(); }) });
    let t0 = Date.now();
    const liveTtl = () => (info.ttl > 0 ? Math.max(0, info.ttl - (Date.now() - t0)) : info.ttl);
    const paintTtl = () => {
      const ms = liveTtl();
      ttlPill.innerHTML = '';
      if (info.ttl === -1 || info.ttl === null) ttlPill.append(h('span', { class: 'muted' }, 'TTL'), ' No expiry');
      else if (ms <= 0) { ttlPill.append(h('span', { class: 'r-ttl-strong' }, 'Expired')); if (!tab.expired) { tab.expired = true; setTimeout(() => load(tab), 800); } }
      else ttlPill.append(h('span', { class: 'muted' }, 'Expires in'), ' ', h('span', { class: 'r-ttl-strong' }, Lookup.fmtTtl(ms, true)));
    };
    tab.expired = false;
    paintTtl();
    if (info.ttl > 0) tab.timers.push(setInterval(paintTtl, 1000));
    tab.liveTtl = liveTtl;
    const unit = { string: 'bytes', hash: 'fields', list: 'elements', set: 'members', zset: 'members', stream: 'entries' }[info.type];
    const size = [info.length !== null && unit ? `${fmtNum(info.length)} ${info.length === 1 ? unit.replace(/s$/, '') : unit}` : null, info.size !== null ? fmtBytes(info.size) : null].filter(Boolean).join(' · ');
    return h('div', { class: 'r-keyhead' },
      Lookup.typeBadge(info.type),
      h('span', { class: 'r-keyname', title: textOf(tab.key) }, textOf(tab.key)),
      h('button', { class: 'icon-btn', title: 'Copy key name', onclick: () => { api.copy(textOf(tab.key)); toast('Copied', 'ok', 1200); } }, icon('copy')),
      h('button', { class: 'icon-btn', title: 'Rename key', onclick: () => Lookup.redisRename(k) }, icon('edit')),
      h('div', { class: 'spacer' }),
      ttlPill,
      size ? h('span', { class: 'r-pill static', title: info.encoding ? `Stored as ${info.encoding}` : '' }, size) : null,
      h('button', {
        class: 'icon-btn', title: 'Reload', onclick: async () => {
          if (tab.changes && !(await confirmBox('Discard changes?', 'Reloading drops the changes you have not saved.', 'Reload', true))) return;
          load(tab);
        },
      }, icon('refresh')),
      h('button', { class: 'icon-btn danger-hover', title: 'Delete key', onclick: () => Lookup.redisDelete(k) }, icon('trash')));
  }

  /** Save / Discard area shown while there are unsaved changes. */
  function changesBar(tab, { onSave, onDiscard }) {
    const box = h('div', { class: 'r-changes hidden' });
    const paint = () => {
      box.innerHTML = '';
      box.classList.toggle('hidden', !tab.changes);
      if (!tab.changes) return;
      box.append(h('span', { class: 'r-changes-n' }, `${tab.changes} change${tab.changes === 1 ? '' : 's'}`),
        h('button', { class: 'btn sm', onclick: onDiscard }, 'Discard'),
        h('button', { class: 'btn sm primary', title: 'Save (Ctrl+S)', onclick: onSave }, 'Save'));
    };
    return { el: box, paint };
  }
  const footer = () => {
    const left = h('div', { class: 'r-foot-left' });
    const right = h('div', { class: 'r-foot-right muted' });
    return { el: h('div', { class: 'r-foot' }, left, h('div', { class: 'spacer' }), right), left, right };
  };

  // ---------- String / JSON ----------
  async function stringEditor(tab, body, info, { json = false } = {}) {
    const r = await rop('load', { key: tab.key, type: json ? 'json' : 'string' });
    const original = r.value;
    const binary = isBinary(original);
    const readOnly = binary || r.truncated;
    let view = binary ? 'hex' : json || isJsonText(original) ? 'json' : 'text';
    let draft = null; // text being edited (null = unchanged)
    const area = h('div', { class: 'r-string-area' });
    const foot = footer();
    const note = foot.left;
    const asJson = (t) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; } };
    const current = () => (draft !== null ? draft : binary ? null : String(original));
    const bar = changesBar(tab, {
      onDiscard: () => { draft = null; tab.setChanges(0); paint(); },
      onSave: () => save(),
    });
    const save = async () => {
      if (!tab.changes) return;
      let value = draft;
      // JSON is saved compact; plain text shown in the JSON view is saved as typed.
      if (json || (view === 'json' && isJsonText(original))) {
        try { value = JSON.stringify(JSON.parse(draft)); } catch (e) { toast(`Not valid JSON: ${e.message}`, 'err', 5000); return; }
      }
      const ttl = tab.liveTtl ? tab.liveTtl() : -1;
      const cmds = json ? [['JSON.SET', tab.key, '$', value]]
        : ttl > 0 ? [['SET', tab.key, value], ['PEXPIRE', tab.key, Math.max(1, Math.round(ttl))]] : [['SET', tab.key, value]];
      try {
        await rop('apply', { key: tab.key, commands: cmds }, { describe: cmdText(cmds) });
        toast('Saved', 'ok', 1500);
        load(tab);
      } catch (e) { fail(e); }
    };
    tab.save = save;
    const seg = () => viewSeg(view, (v) => {
      if (draft !== null && v === 'hex') { toast('Save or discard your changes first', 'info'); return; }
      view = v;
      if (draft !== null && v === 'json') { const p = asJson(draft); if (p !== null) draft = p; }
      paintToolbar();
      paint();
    }, { json: !binary, text: !binary && !json });
    const toolbar = h('div', { class: 'r-toolbar' });
    const paintToolbar = () => {
      toolbar.innerHTML = '';
      toolbar.append(...[seg(),
        h('div', { class: 'spacer' }),
        readOnly ? h('span', { class: 'muted small-note' }, binary ? 'Binary value: shown as hex. Change it in the Shell.' : `Showing the first ${fmtBytes(r.value.length || 0)} of ${fmtBytes(r.total)}. Too large to edit here.`) : null,
        bar.el].filter(Boolean));
      bar.paint();
    };
    const paint = () => {
      area.innerHTML = '';
      const text = current();
      if (view === 'hex') {
        area.append(h('pre', { class: 'r-hex' }, hexDump(bytesOf(original))));
        note.textContent = `${fmtBytes(bytesOf(original).length)}${binary ? ' · binary' : ''}`;
        return;
      }
      const shown = view === 'json' && draft === null ? (asJson(text) ?? text) : text;
      const ta = h('textarea', { class: 'r-textarea', spellcheck: 'false', readOnly });
      ta.value = shown;
      ta.addEventListener('input', () => {
        draft = ta.value;
        const base = view === 'json' ? (asJson(String(original)) ?? String(original)) : String(original);
        tab.setChanges(draft === base ? 0 : 1);
        if (!tab.changes) draft = null;
        bar.paint();
        paintNote(ta.value);
      });
      area.append(ta);
      paintNote(shown);
    };
    const paintNote = (t) => {
      if (view === 'json') {
        try { JSON.parse(t); note.textContent = `Valid JSON · ${fmtBytes(enc.encode(t).length)} · formatted for reading, saved compact`; note.className = 'r-foot-left'; } catch (e) { note.textContent = `Not valid JSON: ${e.message}`; note.className = 'r-foot-left err-text-inline'; }
      } else { note.textContent = `${fmtBytes(enc.encode(t).length)} · UTF-8`; note.className = 'r-foot-left'; }
    };
    foot.right.textContent = `${r.command} · ${fmtMs(r.ms)}`;
    body.append(toolbar, area, foot.el);
    paintToolbar();
    paint();
  }

  // ---------- Hash, list, set, sorted set: one table editor ----------
  /**
   * spec: { cols: [{ id, label, edit, num }], first: 'index' | 'rank' | 'row', paging: 'cursor' | 'index',
   *   filter, order, side (column shown in the side panel), unit, add (column ids for a new row), build(changes, added) -> commands }
   */
  async function tableEditor(tab, body, info, spec) {
    const st = { items: [], cursor: '0', done: false, start: 0, total: info.length, filter: '', order: 'desc', sel: null, edits: new Map(), deleted: new Set(), added: [], r: null };
    const toolbar = h('div', { class: 'r-toolbar' });
    const wrap = h('div', { class: 'r-tablewrap' });
    const tableBox = h('div', { class: 'r-tablebox' });
    const side = spec.side ? h('div', { class: 'r-side hidden' }) : null;
    wrap.append(tableBox, side || '');
    const foot = footer();
    const idOf = (item) => spec.idOf(item);
    const countChanges = () => { let n = st.deleted.size + st.added.length; for (const [id, e] of st.edits) if (!st.deleted.has(id) && Object.keys(e).length) n++; return n; };
    const changed = () => { tab.setChanges(countChanges()); bar.paint(); };
    const bar = changesBar(tab, { onDiscard: () => { st.edits.clear(); st.deleted.clear(); st.added = []; changed(); paintTable(); paintSide(); }, onSave: () => save() });

    async function fetchPage(reset) {
      const p = { key: tab.key, type: info.type, filter: st.filter, order: st.order };
      if (spec.paging === 'cursor' || (info.type === 'zset' && st.filter)) p.cursor = reset ? '0' : st.cursor;
      else p.start = st.start;
      tableBox.classList.add('loading');
      try {
        const r = await rop('load', p);
        st.r = r;
        if (r.cursor !== undefined) { st.items = reset ? r.items : st.items.concat(r.items); st.cursor = r.cursor; st.done = r.done; } else st.items = r.items;
        st.total = r.total;
        foot.right.textContent = `${r.command} · ${fmtMs(r.ms)}`;
      } catch (e) { fail(e); } finally { tableBox.classList.remove('loading'); }
      paintTable();
      paintFoot();
    }
    const confirmDrop = async () => !tab.changes || confirmBox('Unsaved changes', 'Moving to another page drops the changes you have not saved.', 'Drop changes', true);
    async function page(delta) {
      if (!(await confirmDrop())) return;
      st.edits.clear(); st.deleted.clear(); st.added = []; changed();
      st.start = Math.max(0, st.start + delta * 100);
      await fetchPage(true);
    }

    // Toolbar: filter, order (sorted sets), add, unsaved changes.
    const filterInput = spec.filter ? h('input', {
      class: 'input sm r-filter', placeholder: spec.filter, spellcheck: 'false',
      oninput: debounce(async () => {
        if (!(await confirmDrop())) return;
        st.edits.clear(); st.deleted.clear(); st.added = []; changed();
        st.filter = filterInput.value; st.start = 0; fetchPage(true);
      }, 350),
    }) : null;
    const orderSeg = spec.order ? h('div', { class: 'seg sm' }, [['desc', 'Highest first'], ['asc', 'Lowest first']].map(([o, l]) => h('button', {
      type: 'button', class: st.order === o ? 'on' : '',
      onclick: async (e) => {
        if (st.order === o || !(await confirmDrop())) return;
        st.order = o; st.start = 0; st.edits.clear(); st.deleted.clear(); st.added = []; changed();
        e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
        fetchPage(true);
      },
    }, l))) : null;
    const addRow = (where) => {
      const values = Object.fromEntries(spec.add.map((c) => [c, c === 'score' ? '0' : '']));
      st.added.unshift({ values, where });
      changed();
      paintTable();
      const first = tableBox.querySelector('tr.added input');
      if (first) first.focus();
    };
    toolbar.append(...[
      filterInput ? h('div', { class: 'r-search' }, icon('search'), filterInput) : null,
      orderSeg,
      h('button', {
        class: 'btn sm ghost', title: spec.addTitle,
        onclick: (e) => {
          if (info.type !== 'list') { addRow(); return; }
          const r = e.currentTarget.getBoundingClientRect();
          contextMenu(r.left, r.bottom + 4, [{ label: 'Add to the end (RPUSH)', onClick: () => addRow('end') }, { label: 'Add to the start (LPUSH)', onClick: () => addRow('start') }]);
        },
      }, icon('plus'), spec.addLabel),
      h('div', { class: 'spacer' }),
      bar.el].filter(Boolean));

    // Table
    function cell(item, id, col) {
      const e = st.edits.get(id) || {};
      const has = col.id in e;
      const v = has ? e[col.id] : item[col.id];
      const bin = isBinary(item[col.id]);
      const td = h('td', { 'data-col': col.id, class: 'r-cell' + (col.num ? ' num' : '') + (has ? ' edited' : '') + (bin ? ' bin' : ''), title: bin ? 'Binary value: change it in the Shell' : cellText(v).slice(0, 2000) }, cellText(v));
      if (col.edit && !bin && !st.deleted.has(id)) {
        td.addEventListener('dblclick', () => editCell(td, item, id, col));
      }
      return td;
    }
    function editCell(td, item, id, col) {
      if (td.querySelector('input')) return;
      const e = st.edits.get(id) || {};
      const inp = h('input', { class: 'r-cell-input' + (col.num ? ' num' : ''), spellcheck: 'false' });
      inp.value = col.id in e ? e[col.id] : String(item[col.id]);
      td.textContent = '';
      td.append(inp);
      inp.focus();
      inp.select();
      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        if (keep) {
          const next = { ...(st.edits.get(id) || {}) };
          if (col.num && !validScore(inp.value)) { toast('The score must be a number (or +inf / -inf)', 'err'); }
          else if (inp.value === String(item[col.id])) delete next[col.id];
          else next[col.id] = inp.value;
          if (Object.keys(next).length) st.edits.set(id, next); else st.edits.delete(id);
          changed();
        }
        paintTable();
        paintSide();
      };
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', () => finish(true));
    }
    function paintTable() {
      const scroll = tableBox.scrollTop;
      tableBox.innerHTML = '';
      const thead = h('tr', null, h('th', { class: 'r-n' }, spec.first === 'rank' ? '#' : spec.first === 'index' ? 'Index' : '#'),
        spec.cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)), h('th', { class: 'r-act' }));
      const tbody = h('tbody');
      // New rows (not saved yet) on top.
      st.added.forEach((a, i) => {
        tbody.append(h('tr', { class: 'added' }, h('td', { class: 'r-n' }, a.where === 'start' ? 'start' : 'new'),
          spec.cols.map((c) => {
            if (!spec.add.includes(c.id)) return h('td', { class: 'muted' }, '—');
            const inp = h('input', { class: 'r-cell-input' + (c.num ? ' num' : ''), spellcheck: 'false', placeholder: c.label, oninput: (e) => { a.values[c.id] = e.target.value; } });
            inp.value = a.values[c.id];
            inp.addEventListener('keydown', (e) => e.stopPropagation());
            return h('td', { class: 'r-cell' + (c.num ? ' num' : '') }, inp);
          }),
          h('td', { class: 'r-act' }, h('button', { class: 'icon-btn xs', title: 'Remove this new row', onclick: () => { st.added.splice(i, 1); changed(); paintTable(); } }, icon('x')))));
      });
      st.items.forEach((item, i) => {
        const id = idOf(item);
        const del = st.deleted.has(id);
        const n = spec.first === 'index' ? item.index : spec.first === 'rank' && item.rank !== undefined ? item.rank + 1 : i + 1;
        tbody.append(h('tr', {
          class: (del ? 'deleted' : '') + (st.sel === id ? ' sel' : ''),
          onclick: () => { st.sel = id; tbody.querySelectorAll('tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === id)); paintSide(); },
          'data-id': id,
        }, h('td', { class: 'r-n' }, String(n)), spec.cols.map((c) => cell(item, id, c)),
        h('td', { class: 'r-act' },
          spec.cols.some((c) => c.edit) && !del ? h('button', { class: 'icon-btn xs', title: 'Edit', onclick: (e) => { e.stopPropagation(); const td = e.currentTarget.closest('tr').querySelector(`td[data-col="${spec.editCol}"]:not(.bin)`); if (td) td.dispatchEvent(new MouseEvent('dblclick')); } }, icon('edit')) : null,
          h('button', {
            class: 'icon-btn xs', title: del ? 'Keep this row' : 'Delete (when you save)',
            onclick: (e) => { e.stopPropagation(); if (del) st.deleted.delete(id); else st.deleted.add(id); changed(); paintTable(); },
          }, icon(del ? 'undo' : 'trash')))));
      });
      if (!st.items.length && !st.added.length) tbody.append(h('tr', null, h('td', { class: 'r-empty', colspan: spec.cols.length + 2 }, st.filter ? (st.done ? 'Nothing matches the filter' : 'No matches yet — Load more looks further') : 'Empty')));
      tableBox.append(h('table', { class: 'r-table' }, h('thead', null, thead), tbody));
      tableBox.scrollTop = scroll;
    }
    function paintFoot() {
      foot.left.innerHTML = '';
      const unit = spec.unit;
      if (st.r && st.r.cursor !== undefined) {
        foot.left.append(...[h('span', null, st.filter ? `${fmtNum(st.items.length)} matching · ${fmtNum(st.total)} ${unit} in all` : `${fmtNum(st.items.length)} of ${fmtNum(st.total)} ${unit}`),
          st.done ? null : h('button', { class: 'btn sm', onclick: () => fetchPage(false) }, 'Load more')].filter(Boolean));
      } else {
        const from = st.items.length ? st.start + 1 : 0;
        const to = st.start + st.items.length;
        foot.left.append(
          h('button', { class: 'icon-btn', title: 'Previous 100', disabled: st.start === 0, onclick: () => page(-1) }, icon('chevron', 'flip')),
          h('button', { class: 'icon-btn', title: 'Next 100', disabled: to >= st.total, onclick: () => page(1) }, icon('chevron')),
          h('span', null, `${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(st.total)} ${unit}`));
      }
    }
    // Side panel: the selected row's value in full, as Text / JSON / Hex; Edit stages a change.
    let sideView = null;
    function paintSide() {
      if (!side) return;
      const item = st.items.find((x) => idOf(x) === st.sel);
      side.classList.toggle('hidden', !item);
      if (!item) return;
      const e = st.edits.get(st.sel) || {};
      const col = spec.side;
      const v = col in e ? e[col] : item[col];
      const bin = isBinary(v);
      const view = sideView && !(bin && sideView !== 'hex') ? sideView : bin ? 'hex' : isJsonText(v) ? 'json' : 'text';
      side.innerHTML = '';
      const title = info.type === 'hash' ? cellText(item.field) : info.type === 'list' ? `Index ${item.index}` : cellText(item.member);
      const content = h('div', { class: 'r-side-body' });
      if (view === 'hex') content.append(h('pre', { class: 'r-hex' }, hexDump(bytesOf(v))));
      else if (view === 'json') content.append(jsonView(v) || h('pre', { class: 'r-pre' }, String(v)));
      else content.append(h('pre', { class: 'r-pre' }, String(v)));
      const valid = !bin && isJsonText(v);
      side.append(
        h('div', { class: 'r-side-head' }, h('span', { class: 'r-side-title', title }, title), viewSeg(view, (x) => { sideView = x; paintSide(); }, { json: valid, text: !bin })),
        content,
        h('div', { class: 'r-side-foot' },
          h('span', { class: 'muted' }, `${valid ? 'Valid JSON · ' : ''}${fmtBytes(bytesOf(v).length)}`),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn sm', onclick: () => { api.copy(cellText(v)); toast('Copied', 'ok', 1200); } }, icon('copy'), 'Copy'),
          bin || st.deleted.has(st.sel) ? null : h('button', { class: 'btn sm', onclick: () => editLong(item, col, v) }, icon('edit'), 'Edit')));
    }
    function editLong(item, col, v) {
      const ta = h('textarea', { class: 'input mono r-edit-long', spellcheck: 'false', rows: 14 });
      ta.value = isJsonText(v) ? JSON.stringify(JSON.parse(v), null, 2) : String(v);
      const wasJson = isJsonText(v);
      modal({
        title: `Edit ${info.type === 'hash' ? cellText(item.field) : 'value'}`,
        wide: true,
        body: h('div', null, ta, wasJson ? h('p', { class: 'muted small' }, 'JSON is saved compact.') : null),
        actions: [{ label: 'Cancel' }, {
          label: 'Apply', kind: 'primary', onClick: () => {
            let next = ta.value;
            if (wasJson) { try { next = JSON.stringify(JSON.parse(next)); } catch (e) { toast(`Not valid JSON: ${e.message}`, 'err'); return false; } }
            const id = idOf(item);
            const ed = { ...(st.edits.get(id) || {}) };
            if (next === String(item[col])) delete ed[col]; else ed[col] = next;
            if (Object.keys(ed).length) st.edits.set(id, ed); else st.edits.delete(id);
            changed(); paintTable(); paintSide();
            return true;
          },
        }],
      });
    }
    async function save() {
      if (!tab.changes) return;
      for (const a of st.added) for (const c of spec.add) if (c === 'score' && !validScore(a.values.score)) { toast('Each score must be a number', 'err'); return; }
      const changes = st.items.map((item) => ({ item, edits: st.edits.get(idOf(item)) || {}, deleted: st.deleted.has(idOf(item)) }))
        .filter((c) => c.deleted || Object.keys(c.edits).length);
      let cmds;
      try { cmds = spec.build(tab.key, changes, st.added); } catch (e) { toast(e.message, 'err'); return; }
      if (!cmds.length) { tab.setChanges(0); return; }
      try {
        await rop('apply', { key: tab.key, commands: cmds }, { describe: cmdText(cmds) });
        toast(`Saved ${tab.changes} change${tab.changes === 1 ? '' : 's'}`, 'ok', 1500);
        load(tab);
      } catch (e) { fail(e); }
    }
    tab.save = save;
    body.append(toolbar, wrap, foot.el);
    bar.paint();
    await fetchPage(true);
  }
  const validScore = (s) => /^[-+]?inf$/i.test(String(s).trim()) || (String(s).trim() !== '' && Number.isFinite(Number(s)));
  const need = (v, what) => { if (v === undefined || v === null || String(v) === '') throw new Error(`Enter the ${what} for each new row`); return v; };

  const SPECS = {
    hash: {
      cols: [{ id: 'field', label: 'Field', edit: true }, { id: 'value', label: 'Value', edit: true }],
      editCol: 'value', idOf: (x) => keyId(x.field), first: 'row', paging: 'cursor', filter: 'Filter fields', side: 'value', unit: 'fields',
      add: ['field', 'value'], addLabel: 'Add field', addTitle: 'New field (saved with Save)',
      build: (K, changes, added) => {
        const out = [];
        for (const { item, edits, deleted } of changes) {
          if (deleted) { out.push(['HDEL', K, item.field]); continue; }
          const f = 'field' in edits ? edits.field : item.field;
          const v = 'value' in edits ? edits.value : item.value;
          if ('field' in edits && edits.field !== item.field) out.push(['HSET', K, f, v], ['HDEL', K, item.field]);
          else out.push(['HSET', K, f, v]);
        }
        for (const a of added) out.push(['HSET', K, need(a.values.field, 'field name'), a.values.value]);
        return out;
      },
    },
    list: {
      cols: [{ id: 'value', label: 'Element', edit: true }],
      editCol: 'value', idOf: (x) => 'i' + x.index, first: 'index', paging: 'index', filter: null, side: 'value', unit: 'elements',
      add: ['value'], addLabel: 'Add element', addTitle: 'Add to the end or the start (saved with Save)',
      build: (K, changes, added) => {
        const out = [];
        // Deleting by position: mark the elements, then remove the marks (positions stay right until then).
        const mark = `__lookup_removed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}__`;
        let marked = false;
        for (const { item, edits, deleted } of changes) {
          if (deleted) { out.push(['LSET', K, String(item.index), mark]); marked = true; } else out.push(['LSET', K, String(item.index), edits.value]);
        }
        if (marked) out.push(['LREM', K, '0', mark]);
        for (const a of [...added].reverse()) out.push([a.where === 'start' ? 'LPUSH' : 'RPUSH', K, a.values.value]);
        return out;
      },
    },
    set: {
      cols: [{ id: 'member', label: 'Member', edit: true }],
      editCol: 'member', idOf: (x) => keyId(x.member), first: 'row', paging: 'cursor', filter: 'Filter members', side: null, unit: 'members',
      add: ['member'], addLabel: 'Add member', addTitle: 'New member (saved with Save)',
      build: (K, changes, added) => {
        const out = [];
        for (const { item, edits, deleted } of changes) {
          out.push(['SREM', K, item.member]);
          if (!deleted) out.push(['SADD', K, edits.member]);
        }
        for (const a of added) out.push(['SADD', K, need(a.values.member, 'member')]);
        return out;
      },
    },
    zset: {
      cols: [{ id: 'member', label: 'Member', edit: true }, { id: 'score', label: 'Score', edit: true, num: true }],
      editCol: 'score', idOf: (x) => keyId(x.member), first: 'rank', paging: 'index', filter: 'Filter members', order: true, side: null, unit: 'members',
      add: ['member', 'score'], addLabel: 'Add member', addTitle: 'New member with a score (saved with Save)',
      build: (K, changes, added) => {
        const out = [];
        for (const { item, edits, deleted } of changes) {
          if (deleted) { out.push(['ZREM', K, item.member]); continue; }
          const score = 'score' in edits ? edits.score : item.score;
          if ('member' in edits && edits.member !== item.member) out.push(['ZREM', K, item.member], ['ZADD', K, String(score).trim(), edits.member]);
          else out.push(['ZADD', K, String(score).trim(), item.member]);
        }
        for (const a of added) out.push(['ZADD', K, String(a.values.score).trim(), need(a.values.member, 'member')]);
        return out;
      },
    },
  };

  // ---------- Stream ----------
  async function streamEditor(tab, body, info) {
    const st = { stack: [], end: '+', r: null };
    const tableBox = h('div', { class: 'r-tablebox' });
    const foot = footer();
    const toolbar = h('div', { class: 'r-toolbar' },
      h('button', { class: 'btn sm ghost', onclick: () => addEntry() }, icon('plus'), 'Add entry'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted', id: 'r-groups' }));
    tab.save = null;
    async function fetch() {
      tableBox.classList.add('loading');
      try { st.r = await rop('load', { key: tab.key, type: 'stream', end: st.end }); } catch (e) { fail(e); return; } finally { tableBox.classList.remove('loading'); }
      paint();
    }
    function paint() {
      const r = st.r;
      tableBox.innerHTML = '';
      // One column per field name seen on this page (in first-seen order), up to 12.
      const names = [];
      for (const e of r.entries) for (const [f] of e.fields) { const t = cellText(f); if (!names.includes(t) && names.length < 12) names.push(t); }
      const thead = h('tr', null, h('th', null, 'Entry ID'), h('th', null, 'Time'), names.map((n) => h('th', null, n)), h('th', { class: 'r-act' }));
      const tbody = h('tbody');
      for (const e of r.entries) {
        const vals = new Map(e.fields.map(([f, v]) => [cellText(f), v]));
        const ms = Number(e.id.split('-')[0]);
        tbody.append(h('tr', null,
          h('td', { class: 'mono' }, e.id),
          h('td', { class: 'muted', title: new Date(ms).toISOString() }, new Date(ms).toLocaleString()),
          names.map((n) => h('td', { class: 'r-cell', title: vals.has(n) ? cellText(vals.get(n)).slice(0, 2000) : '' }, vals.has(n) ? cellText(vals.get(n)) : '')),
          h('td', { class: 'r-act' }, h('button', { class: 'icon-btn xs', title: 'Delete entry', onclick: () => delEntry(e.id) }, icon('trash')))));
      }
      if (!r.entries.length) tbody.append(h('tr', null, h('td', { class: 'r-empty', colspan: names.length + 3 }, 'No entries')));
      tableBox.append(h('table', { class: 'r-table' }, h('thead', null, thead), tbody));
      foot.left.innerHTML = '';
      foot.left.append(
        h('button', { class: 'icon-btn', title: 'Newer entries', disabled: !st.stack.length, onclick: () => { st.end = st.stack.pop(); fetch(); } }, icon('chevron', 'flip')),
        h('button', { class: 'icon-btn', title: 'Older entries', disabled: !r.next, onclick: () => { st.stack.push(st.end); st.end = r.next; fetch(); } }, icon('chevron')),
        h('span', null, `${fmtNum(r.entries.length)} entries shown, newest first · ${fmtNum(r.total)} in all`));
      foot.right.textContent = `${r.command} · ${fmtMs(r.ms)}`;
      const g = toolbar.querySelector('#r-groups');
      g.textContent = r.groups.length ? `Consumer groups: ${r.groups.map((x) => `${x.name} (${x.pending || 0} pending)`).join(', ')}` : 'No consumer groups';
    }
    async function delEntry(id) {
      if (!(await confirmBox('Delete entry', `Delete entry ${id}?`, 'Delete', true))) return;
      const cmds = [['XDEL', tab.key, id]];
      try { await rop('apply', { key: tab.key, commands: cmds }, { describe: cmdText(cmds) }); await fetch(); } catch (e) { fail(e); }
    }
    function addEntry() {
      const ta = h('textarea', { class: 'input mono', rows: 6, spellcheck: 'false', placeholder: 'field value\nanother "value with spaces"' });
      const idIn = h('input', { class: 'input mono', placeholder: '*' });
      modal({
        title: 'Add stream entry',
        body: h('div', null,
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Entry ID'), idIn, h('span', { class: 'field-hint' }, '* lets the server choose (current time).')),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Fields: one "field value" pair per line'), ta)),
        actions: [{ label: 'Cancel' }, {
          label: 'Add', kind: 'primary', onClick: async () => {
            const args = [];
            for (const line of ta.value.split('\n')) {
              if (!line.trim()) continue;
              const p = Cli.parseLine(line);
              if (p.error || p.args.length !== 2) { toast(`Write each line as: field value (${line.trim()})`, 'err', 5000); return false; }
              args.push(...p.args);
            }
            if (!args.length) { toast('Add at least one field', 'err'); return false; }
            const cmds = [['XADD', tab.key, idIn.value.trim() || '*', ...args]];
            try { await rop('apply', { key: tab.key, commands: cmds }, { describe: cmdText(cmds) }); st.stack = []; st.end = '+'; await fetch(); return true; } catch (e) { fail(e); return false; }
          },
        }],
      });
    }
    body.append(toolbar, tableBox, foot.el);
    await fetch();
  }

  async function unsupported(tab, body, info) {
    body.append(h('div', { class: 'r-gone' }, icon('key'),
      h('div', null, `Lookup can't show ${info.type} keys yet.`),
      h('div', { class: 'muted' }, 'Read it in the Workbench or the Shell (module types have their own commands).')));
  }

  const EDITORS = {
    string: (tab, body, info) => stringEditor(tab, body, info),
    json: (tab, body, info) => stringEditor(tab, body, info, { json: true }),
    hash: (tab, body, info) => tableEditor(tab, body, info, SPECS.hash),
    list: (tab, body, info) => tableEditor(tab, body, info, SPECS.list),
    set: (tab, body, info) => tableEditor(tab, body, info, SPECS.set),
    zset: (tab, body, info) => tableEditor(tab, body, info, SPECS.zset),
    stream: streamEditor,
  };

  Object.assign(Lookup, { openRedisKey, jsonView, hexDump, redisSpecs: SPECS });
})();
