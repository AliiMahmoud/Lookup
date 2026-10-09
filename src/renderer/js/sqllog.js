// Bottom panel listing the SQL Lookup ran by itself on this connection
// (opening tables, counts, metadata, grid edits, structure changes, commits).
(function () {
  const { h, icon, toast } = window.U;
  const store = {
    get(k, d) { try { const v = localStorage.getItem('lookup.sqllog.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('lookup.sqllog.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function stamp(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }
  function literal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return "'" + String(v).replace(/'/g, "''") + "'";
  }
  // Show bind values inline (outside strings, quoted names and comments), like the statement that ran.
  const TOK = /('(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/)|:([A-Za-z][\w$#]*|\d+)/g;
  function inline(sql, binds) {
    if (!binds) return sql;
    let pos = 0;
    return sql.replace(TOK, (m, skip, name) => {
      if (skip) return m;
      if (Array.isArray(binds)) { const v = binds[pos++]; return v === undefined ? m : literal(v); }
      const key = Object.keys(binds).find((k) => k.toLowerCase() === name.toLowerCase());
      return key === undefined ? m : literal(binds[key]);
    });
  }
  function entryText(e) {
    const meta = [stamp(e.at), `${e.ms ?? 0} ms`];
    if (e.rows !== undefined) meta.push(`${e.rows} row${e.rows === 1 ? '' : 's'}`);
    if (e.affected !== undefined) meta.push(`${e.affected} affected`);
    let sql = inline(e.sql, e.binds).replace(/;\s*$/, '');
    if (!/^(BEGIN|DECLARE)\b/i.test(sql) && !/END;\s*$/i.test(sql)) sql += ';';
    return `-- ${meta.join(' · ')}${e.error ? `\n-- ERROR ${e.error}` : ''}\n${sql}\n`;
  }

  function create(host, api) {
    let open = false;
    let last = 0;
    let timer = null;
    let entries = [];
    let highlight = store.get('highlight', true);
    let filter = '';

    const pre = h('div', { class: 'sl-body' });
    const countEl = h('span', { class: 'count' }, '0');
    const hl = h('input', { type: 'checkbox', onchange: (e) => { highlight = e.target.checked; store.set('highlight', highlight); paint(true); } });
    hl.checked = highlight;
    const search = h('input', { class: 'input xs sl-search', placeholder: 'Filter', oninput: (e) => { filter = e.target.value.toLowerCase(); paint(true); } });
    const handle = h('div', { class: 'sl-resize', title: 'Drag to resize' });
    const el = h('div', { class: 'sqllog hidden' },
      handle,
      h('div', { class: 'sl-head' },
        icon('log'), h('span', { class: 'sl-title' }, 'SQL log'), countEl,
        h('span', { class: 'muted sl-sub' }, 'statements Lookup ran for you · your own queries are not listed'),
        h('div', { class: 'spacer' }),
        search,
        h('label', { class: 'check sm' }, hl, h('span', null, 'Syntax highlighting')),
        h('button', { class: 'tool', title: 'Copy all', onclick: () => { api.copy(visible().map(entryText).join('\n')); toast('Copied', 'ok'); } }, icon('copy')),
        h('button', { class: 'tool', title: 'Clear', onclick: async () => { await api.sqlLogClear(); entries = []; paint(true); } }, icon('trash')),
        h('button', { class: 'tool', title: 'Close (Ctrl+Shift+L)', onclick: () => toggle(false) }, icon('x'))),
      pre);
    host.append(el);
    el.style.height = store.get('height', 240) + 'px';

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const y0 = e.clientY;
      const h0 = el.getBoundingClientRect().height;
      // Leave room above for the tab bar, toolbar, a small editor and at least ~170px of results (about 4 rows).
      const maxH = Math.max(100, host.getBoundingClientRect().height - 370);
      const move = (ev) => { el.style.height = Math.max(100, Math.min(maxH, h0 - (ev.clientY - y0))) + 'px'; };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); store.set('height', parseInt(el.style.height, 10)); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });

    const visible = () => (filter ? entries.filter((e) => (e.sql + ' ' + (e.error || '')).toLowerCase().includes(filter)) : entries);

    let rendered = 0;
    function paint(full) {
      const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      const list = visible();
      countEl.textContent = String(entries.length);
      if (full) { pre.innerHTML = ''; rendered = Math.max(0, list.length - 1500); }
      const empty = pre.querySelector('.empty-small');
      if (empty) empty.remove();
      for (let i = rendered; i < list.length; i++) {
        const e = list[i];
        const text = entryText(e);
        const block = h('pre', { class: 'sl-entry' + (e.error ? ' err' : '') });
        if (highlight) block.innerHTML = window.SqlEditor.highlight(text).replace(/\n $/, '');
        else block.textContent = text;
        pre.append(block);
      }
      rendered = list.length;
      while (pre.childElementCount > 1500) pre.firstChild.remove();
      if (!list.length) pre.append(h('div', { class: 'empty-small' }, filter ? 'No matching statements' : 'Nothing yet. Open a table or its structure to see the SQL Lookup runs.'));
      if (full || atBottom) pre.scrollTop = pre.scrollHeight;
    }

    async function poll() {
      try {
        const r = await api.sqlLog(last);
        if (r.last < last) { entries = []; last = 0; paint(true); return; } // reconnected: new log
        last = r.last;
        if (!r.entries.length) return;
        entries = entries.concat(r.entries);
        if (entries.length > 3000) { entries = entries.slice(-3000); paint(true); } else paint(!!filter);
      } catch { /* not connected */ }
    }

    function toggle(force) {
      open = force === undefined ? !open : force;
      el.classList.toggle('hidden', !open);
      store.set('open', open);
      clearInterval(timer);
      if (open) {
        poll().then(() => paint(true));
        timer = setInterval(poll, 700);
      }
    }

    function reset() {
      entries = [];
      last = 0;
      pre.innerHTML = '';
      if (open) poll().then(() => paint(true));
    }

    if (store.get('open', false)) toggle(true);
    return { toggle, reset, get open() { return open; } };
  }

  window.SqlLog = { create, inline };
})();
