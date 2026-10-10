// Redis workspace: the key browser in the sidebar (database picker, pattern filter, type chips,
// folders split at ":", Scan more), new keys, key menus, the status-bar figures, and rop() — every
// Redis call goes through it so Production connections ask before changing data.
(function () {
  const { h, icon, toast, modal, confirmBox, contextMenu, fmtNum, fmtBytes, debounce } = window.U;
  const api = window.api;
  const $ = (sel, root = document) => root.querySelector(sel);
  const Lookup = window.Lookup;
  const { S } = Lookup;
  const Cli = window.RedisCli;

  const isRedis = () => !!S.info && Lookup.profile().workspace === 'redis';

  // Key types: label in the badge, CSS class for its colour, and the order of the type chips.
  const TYPES = {
    string: 'String', hash: 'Hash', list: 'List', set: 'Set', zset: 'ZSet', stream: 'Stream', json: 'JSON',
  };
  const typeBadge = (type) => h('span', { class: `rtype rt-${TYPES[type] ? type : 'other'}` }, (TYPES[type] || type || '?').toUpperCase());

  const R = {
    db: 0, dbCount: 16, dbs: [], dbSize: null, usedMemory: null,
    match: '', type: null, keys: [], byId: new Map(), cursor: '0', done: false, looked: 0, loading: false,
    open: new Set(), sep: ':',
  };

  // ---------- Keys as text ----------
  /** A key or value from the main process: a string, or { b64 } for bytes that aren't text. */
  const textOf = (v) => (v && typeof v === 'object' ? Cli.bulkText({ b: v.b64 }) : String(v === null || v === undefined ? '' : v));
  const keyId = (k) => (k && typeof k === 'object' ? 'b:' + k.b64 : 's:' + k);
  const isBinary = (v) => !!(v && typeof v === 'object');

  /** Time to live: "45s", "29m", "3h", "3d" (short) or "29m 14s", "3d 4h" (long); null = no expiry. */
  function fmtTtl(ms, long = false) {
    if (ms === null || ms === undefined || ms < 0) return null;
    let s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const hh = Math.floor(s / 3600); s -= hh * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const parts = [[d, 'd'], [hh, 'h'], [m, 'm'], [s, 's']].filter(([n]) => n > 0);
    if (!parts.length) return '0s';
    return parts.slice(0, long ? 2 : 1).map(([n, u]) => n + u).join(' ');
  }

  // ---------- Calls (engine-ops.js) ----------
  const { opCall: call, rop, opFail: fail, askText } = Lookup;
  // The Production question names the database too.
  Lookup.opWhere = () => (isRedis() ? ` · db${R.db}` : '');


  // ---------- Entering the workspace ----------
  let emptyStateHtml = null;
  function setEmptyState(redis) {
    const box = $('#empty-state');
    if (emptyStateHtml === null) emptyStateHtml = box.innerHTML;
    if (!redis) { box.innerHTML = emptyStateHtml; return; }
    const mod = S.platform === 'darwin' ? '⌘' : 'Ctrl';
    box.innerHTML = '';
    box.append(h('div', { class: 'empty-mark' }), h('h2', null, 'Pick a key from the sidebar'), h('p', { class: 'muted' }, 'or run commands in the Workbench or the Shell'),
      h('div', { class: 'shortcuts' },
        ...[[[mod, 'T'], 'Workbench'], [[mod, 'Shift', 'T'], 'Shell (redis-cli)'], [[mod, 'P'], 'Find a key'], [[mod, 'S'], 'Save changes to a key']]
          .map(([keys, label]) => h('div', null, keys.map((k) => h('kbd', null, k)), h('span', null, label)))));
  }

  async function enterRedis() {
    setEmptyState(true);
    Object.assign(R, { db: S.info.dbName ? Number(String(S.info.dbName).replace(/^db/, '')) || 0 : 0, match: '', type: null, open: new Set(), cluster: S.info.cluster || null });
    if (R.cluster) { S.schema = 'cluster'; Lookup.pushState(); } // title bar: "cluster" instead of db0
    renderSidebar();
    Lookup.renderTabs();
    await Promise.all([loadKeyspace(), refreshMemory()]);
    await scan(true);
  }

  async function loadKeyspace() {
    try {
      const ks = await rop('keyspace');
      Object.assign(R, { db: ks.current, dbCount: ks.count, dbs: ks.dbs, dbSize: ks.dbSize, cluster: ks.cluster || null });
    } catch (e) { fail(e); }
    paintDbSelect();
    Lookup.renderStatus();
  }

  async function refreshMemory() {
    try {
      const o = await rop('overview');
      R.usedMemory = o.usedMemory;
      Lookup.renderStatus();
      return o;
    } catch { return null; }
  }

  // ---------- Sidebar ----------
  function renderSidebar() {
    const sb = $('#sidebar');
    sb.innerHTML = '';
    const dbSel = h('select', { class: 'input sm', id: 'r-db', title: 'Database', onchange: (e) => switchDb(Number(e.target.value)) });
    const filter = h('input', {
      class: 'input sm', id: 'r-filter', placeholder: 'Filter keys: user:* or text', spellcheck: 'false',
      oninput: debounce(() => { R.match = filter.value; clearBtn.classList.toggle('hidden', !filter.value); scan(true); }, 300),
      onkeydown: (e) => {
        if (e.key === 'Escape' && filter.value) { e.preventDefault(); e.stopPropagation(); clearBtn.click(); }
        if (e.key === 'Enter') { e.preventDefault(); R.match = filter.value; scan(true); }
      },
    });
    const clearBtn = h('button', { class: 'sb-search-clear hidden', title: 'Clear (Esc)', tabindex: '-1', onmousedown: (e) => e.preventDefault(),
      onclick: () => { filter.value = ''; R.match = ''; clearBtn.classList.add('hidden'); scan(true); filter.focus(); } }, icon('x'));
    const chips = h('div', { class: 'r-chips', id: 'r-chips' },
      [[null, 'All'], ...Object.entries(TYPES)].map(([t, label]) => h('button', {
        type: 'button', class: 'r-chip' + (R.type === t ? ' on' : '') + (t ? ` rt-${t}` : ''), 'data-type': t || '',
        onclick: () => { R.type = t; paintChips(); scan(true); },
      }, t ? h('span', { class: 'r-chip-dot' }) : null, label)));
    sb.append(
      h('div', { class: 'sb-top' },
        h('div', { class: 'sb-row' }, icon('db'), dbSel,
          h('button', { class: 'icon-btn', title: 'Reload keys', onclick: () => { loadKeyspace(); scan(true); } }, icon('refresh')),
          h('button', { class: 'icon-btn', title: 'New key', onclick: () => newKeyDialog() }, icon('plus'))),
        h('div', { class: 'sb-search' }, icon('search'), filter, clearBtn),
        chips),
      h('div', { class: 'tree r-tree', id: 'tree' }),
      h('div', { class: 'r-scanbar', id: 'r-scanbar' }));
    paintDbSelect();
  }
  function paintChips() {
    document.querySelectorAll('#r-chips .r-chip').forEach((b) => b.classList.toggle('on', (b.dataset.type || null) === R.type));
  }
  function paintDbSelect() {
    const sel = $('#r-db');
    if (!sel) return;
    sel.innerHTML = '';
    // A cluster has database 0 only: the picker just says so.
    sel.disabled = !!R.cluster;
    sel.title = R.cluster ? 'A Redis cluster has only database 0; keys are spread over its masters' : 'Database';
    if (R.cluster) {
      sel.append(h('option', { value: 0 }, `Cluster · ${R.cluster.masters} masters${R.dbSize !== null ? ` · ${fmtNum(R.dbSize)} keys` : ''}`));
      return;
    }
    const counts = new Map(R.dbs.map((d) => [d.index, d.keys]));
    const n = Math.max(R.dbCount, R.db + 1);
    for (let i = 0; i < n; i++) {
      const keys = i === R.db && R.dbSize !== null ? R.dbSize : counts.get(i);
      sel.append(h('option', { value: i }, keys ? `db${i} · ${fmtNum(keys)} key${keys === 1 ? '' : 's'}` : `db${i}`));
    }
    sel.value = String(R.db);
  }

  async function switchDb(index) {
    const keyTabs = S.tabs.filter((t) => t.kind === 'rkey');
    const dirty = keyTabs.filter((t) => t.grid && t.grid.changeCount());
    if (dirty.length && !(await confirmBox('Unsaved changes', `${dirty.length} key tab${dirty.length > 1 ? 's have' : ' has'} unsaved changes. Switch database and discard them?`, 'Switch', true))) { paintDbSelect(); return; }
    try {
      const ks = await rop('selectDb', { index });
      Object.assign(R, { db: ks.current, dbCount: ks.count, dbs: ks.dbs, dbSize: ks.dbSize });
      S.schema = `db${R.db}`;
      for (const t of keyTabs) await Lookup.closeTab(t.id, true);
      for (const t of S.tabs) if (t.onDbChanged) t.onDbChanged(R.db);
      Lookup.pushState();
      Lookup.renderStatus();
      paintDbSelect();
      await scan(true);
    } catch (e) { fail(e); paintDbSelect(); }
  }

  // ---------- Scanning ----------
  let scanSeq = 0;
  // Scanning. Browsing (no filter): one step per "Scan more". Filtering: the server is searched step after
  // step until 300 matches are found or every key was looked at, so a key is found wherever it sits.
  // "Scan all": steps until the whole database is loaded (Stop ends it).
  const FILTER_WANT = 300;
  async function scan(reset, { all = false } = {}) {
    const seq = ++scanSeq;
    if (reset) Object.assign(R, { keys: [], byId: new Map(), cursor: '0', done: false, looked: 0 });
    R.loading = true;
    R.all = all;
    if (reset) paintTree();
    paintScanbar();
    const filtering = !!(R.match || R.type);
    const startCount = R.keys.length;
    try {
      do {
        const r = await rop('scan', { cursor: R.cursor, match: R.match, type: R.type });
        if (seq !== scanSeq) return; // a newer filter was typed, or Stop was pressed
        for (const k of r.keys) {
          const id = keyId(k.key);
          if (R.byId.has(id)) Object.assign(R.byId.get(id), k);
          else { R.byId.set(id, k); R.keys.push(k); }
        }
        Object.assign(R, { cursor: r.cursor, done: r.done, looked: R.looked + r.looked });
        if (!R.done && (all || filtering)) { paintTree(); paintScanbar(); } // progress while it keeps going
      } while (!R.done && (all || (filtering && R.keys.length - startCount < FILTER_WANT)));
    } catch (e) {
      if (seq === scanSeq) { fail(e); R.done = true; }
    } finally {
      if (seq === scanSeq) { R.loading = false; R.all = false; paintTree(); paintScanbar(); }
    }
  }
  /** Ends a running Scan all / search where it is (what was found stays; Scan more goes on from there). */
  function stopScan() {
    scanSeq++;
    R.loading = false;
    R.all = false;
    paintTree();
    paintScanbar();
  }
  /** Scan all, asking first when the database is big (every key is kept in the list). */
  async function scanAll() {
    const left = R.dbSize === null ? null : Math.max(0, R.dbSize - R.looked);
    if (left !== null && left > 200000 && !(await confirmBox('Load every key?', `About ${fmtNum(left)} more keys will be read and listed. On a busy server this adds load; you can press Stop at any time.`, 'Scan all'))) return;
    scan(false, { all: true });
  }
  function paintScanbar() {
    const bar = $('#r-scanbar');
    if (!bar) return;
    bar.innerHTML = '';
    const total = R.dbSize;
    const looked = R.done ? total : Math.min(R.looked, total === null ? R.looked : total);
    const filtering = !!(R.match || R.type);
    const of = total === null ? '' : ` of ${fmtNum(total)}`;
    const text = R.loading && !R.keys.length ? (filtering ? `Searching… ${fmtNum(looked)}${of} keys looked at` : 'Scanning…')
      : R.done ? `${fmtNum(R.keys.length)} key${R.keys.length === 1 ? '' : 's'}${filtering ? ' found' : ''} · scanned all ${total === null ? '' : fmtNum(total)}`
        : filtering ? `${fmtNum(R.keys.length)} found · ${fmtNum(looked)}${of} searched`
          : `${fmtNum(R.keys.length)}${of} keys loaded`;
    const busy = R.loading;
    bar.append(...[h('span', { class: 'muted' }, text),
      R.done ? null : h('div', { class: 'r-scan-btns' },
        busy
          ? h('button', { class: 'btn sm', title: 'Stop scanning (what was found stays)', onclick: stopScan }, 'Stop')
          : h('button', { class: 'btn sm', title: filtering ? 'Find more matches' : 'Read the next keys', onclick: () => scan(false) }, 'Scan more'),
        busy ? null : h('button', { class: 'btn sm', title: filtering ? 'Search every key in this database' : 'Load every key in this database', onclick: scanAll }, 'Scan all'))].filter(Boolean));
  }

  // ---------- Tree ----------
  /** Keys grouped into folders at ":" (user:1042:profile -> user / 1042 / profile). */
  function buildTree() {
    const root = { name: '', path: '', folders: new Map(), keys: [], count: 0 };
    for (const k of R.keys) {
      const text = textOf(k.key);
      const parts = text.split(R.sep);
      let node = root;
      node.count++;
      for (let i = 0; i < parts.length - 1; i++) {
        const name = parts[i];
        if (!node.folders.has(name)) node.folders.set(name, { name, path: parts.slice(0, i + 1).join(R.sep), folders: new Map(), keys: [], count: 0 });
        node = node.folders.get(name);
        node.count++;
      }
      node.keys.push(k);
    }
    return root;
  }
  const MAX_ROWS = 3000;
  function paintTree() {
    const tree = $('#tree');
    if (!tree) return;
    const scrollTop = tree.scrollTop;
    tree.innerHTML = '';
    if (!R.keys.length) {
      tree.append(R.loading
        ? h('div', { class: 'tree-loading' }, h('div', { class: 'spinner sm' }), 'Scanning keys…')
        : h('div', { class: 'empty-small' }, R.match || R.type ? (R.done ? 'No keys match' : 'No matches found so far — Scan all searches every key') : 'This database has no keys'));
      return;
    }
    const filtering = !!(R.match || R.type);
    const active = S.tabs.find((t) => t.id === S.active);
    const activeId = active && active.kind === 'rkey' ? keyId(active.key) : null;
    let rows = 0;
    const walk = (node, depth) => {
      const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const f of folders) {
        if (rows++ > MAX_ROWS) return;
        // A folder holding a single key is shown as that key (no needless nesting).
        const open = filtering || R.open.has(f.path);
        tree.append(h('div', {
          class: 'r-row r-folder' + (open ? ' open' : ''), style: { paddingLeft: 6 + depth * 14 + 'px' },
          title: `${f.path}${R.sep}* · ${fmtNum(f.count)} key${f.count === 1 ? '' : 's'} loaded`,
          onclick: () => { if (R.open.has(f.path)) R.open.delete(f.path); else R.open.add(f.path); paintTree(); },
          oncontextmenu: (e) => folderMenu(e, f),
        }, icon('chevron', 'chev'), h('span', { class: 'r-folder-name' }, f.name),
        h('button', {
          class: 'icon-btn r-folder-del', title: `Delete all keys matching: ${folderPattern(f)}`,
          onclick: (e) => { e.stopPropagation(); deleteMatching(folderPattern(f), f.path + R.sep); },
        }, icon('trash')),
        h('span', { class: 'r-count' }, fmtNum(f.count))));
        if (open) walk(f, depth + 1);
      }
      const keys = [...node.keys].sort((a, b) => textOf(a.key).localeCompare(textOf(b.key), undefined, { numeric: true }));
      for (const k of keys) {
        if (rows++ > MAX_ROWS) return;
        const ttl = fmtTtl(k.ttl);
        const id = keyId(k.key);
        tree.append(h('div', {
          class: 'r-row r-key' + (id === activeId ? ' active' : ''), style: { paddingLeft: 6 + depth * 14 + 'px' }, 'data-id': id,
          title: `${textOf(k.key)}\n${TYPES[k.type] || k.type}${k.size !== null ? ' · ' + fmtBytes(k.size) : ''}${ttl ? ' · expires in ' + fmtTtl(k.ttl, true) : ''}`,
          onclick: () => Lookup.openRedisKey(k),
          oncontextmenu: (e) => keyMenu(e, k),
        }, typeBadge(k.type), h('span', { class: 'r-key-name' }, textOf(k.key)),
        ttl ? h('span', { class: 'r-ttl' }, ttl) : null,
        k.size !== null ? h('span', { class: 'r-size' }, fmtBytes(k.size)) : null));
      }
    };
    walk(buildTree(), 0);
    if (rows > MAX_ROWS) tree.append(h('div', { class: 'empty-small' }, 'More keys loaded than shown — refine the filter'));
    tree.scrollTop = scrollTop;
  }
  /** Marks the open key in the tree without rebuilding it. */
  function paintTreeActive() {
    const active = S.tabs.find((t) => t.id === S.active);
    const id = active && active.kind === 'rkey' ? keyId(active.key) : null;
    document.querySelectorAll('#tree .r-key').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  }

  /** The SCAN pattern for every key in a folder: its path (glob characters escaped) + separator + "*". */
  const escapeGlob = (t) => t.replace(/[*?[\]\\]/g, '\\$&');
  const folderPattern = (f) => escapeGlob(f.path + R.sep) + '*';
  function folderMenu(e, f) {
    e.preventDefault();
    const pattern = folderPattern(f);
    contextMenu(e.clientX, e.clientY, [
      { label: `Filter to ${pattern}`, icon: 'filter', onClick: () => { const box = $('#r-filter'); box.value = pattern; R.match = pattern; box.dispatchEvent(new Event('input')); } },
      { label: 'Copy pattern', icon: 'copy', onClick: () => api.copy(pattern) },
      '-',
      { label: `Delete all keys matching: ${pattern}`, icon: 'trash', danger: true, onClick: () => deleteMatching(pattern, f.path + R.sep) },
      '-',
      { label: R.open.size ? 'Collapse all folders' : 'Expand loaded folders', onClick: () => { if (R.open.size) R.open.clear(); else for (const k of R.keys) { const p = textOf(k.key).split(R.sep); for (let i = 1; i < p.length; i++) R.open.add(p.slice(0, i).join(R.sep)); } paintTree(); } },
    ]);
  }
  function keyMenu(e, k) {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Open', icon: 'key', onClick: () => Lookup.openRedisKey(k) },
      { label: 'Copy name', icon: 'copy', onClick: () => api.copy(textOf(k.key)) },
      { label: 'Copy as command', icon: 'code', onClick: () => api.copy(`${READ_CMD[k.type] || 'TYPE'} ${Cli.quoteArg(isBinary(k.key) ? { b64: k.key.b64 } : k.key)}`) },
      '-',
      { label: 'Rename…', icon: 'edit', onClick: () => renameKey(k) },
      { label: 'Set time to live…', icon: 'clock', onClick: () => ttlDialog(k) },
      '-',
      { label: 'Delete key', icon: 'trash', danger: true, onClick: () => deleteKey(k) },
    ]);
  }
  const READ_CMD = { string: 'GET', hash: 'HGETALL', list: 'LRANGE', set: 'SMEMBERS', zset: 'ZRANGE', stream: 'XRANGE', json: 'JSON.GET' };

  // ---------- Key changes shared with the key tabs ----------
  /** Updates the key in the sidebar list (and repaints) after a change in a tab. */
  function keyChanged(key, patch) {
    const k = R.byId.get(keyId(key));
    if (k) Object.assign(k, patch);
    paintTree();
  }
  function keyGone(key) {
    const id = keyId(key);
    const k = R.byId.get(id);
    if (k) { R.byId.delete(id); R.keys.splice(R.keys.indexOf(k), 1); }
    if (R.dbSize) R.dbSize--;
    paintTree();
    paintScanbar();
    Lookup.renderStatus();
  }
  function keyAdded(k) {
    const id = keyId(k.key);
    if (!R.byId.has(id)) { R.byId.set(id, k); R.keys.push(k); if (R.dbSize !== null) R.dbSize++; }
    paintTree();
    paintScanbar();
    Lookup.renderStatus();
  }

  async function renameKey(k, after) {
    const to = await askText('Rename key', 'New name', textOf(k.key), { ok: 'Rename', hint: 'Renaming never replaces an existing key.' });
    if (to === null || to === textOf(k.key)) return null;
    try {
      const r = await rop('rename', { key: k.key, to }, { describe: `RENAMENX ${Cli.quoteArg(k.key)} ${Cli.quoteArg(to)}` });
      keyGone(k.key);
      const moved = { ...k, key: r.key };
      keyAdded(moved);
      if (after) after(moved);
      else for (const t of S.tabs) if (t.kind === 'rkey' && keyId(t.key) === keyId(k.key) && t.renamed) t.renamed(moved);
      toast('Key renamed', 'ok', 2000);
      return moved;
    } catch (e) { fail(e); return null; }
  }

  /**
   * Deletes every key matching a pattern: counts them in Redis first (the folder only shows the keys loaded so far),
   * asks with the exact number (on Production the pattern must be typed), then deletes in steps with progress and Stop.
   */
  async function deleteMatching(pattern, prefix = null) {
    const where = R.cluster ? 'this cluster' : `db${R.db}`;
    // 1. Count.
    let stop = false;
    const progress = h('p', { class: 'muted' }, 'Counting the keys in Redis…');
    const counting = modal({ title: 'Delete keys', body: h('div', null, h('p', null, 'Keys matching ', h('code', null, pattern), ` in ${where}`), progress), actions: [{ label: 'Cancel', onClick: () => { stop = true; } }], onClose: () => { stop = true; } });
    let count = 0;
    try {
      let cursor = '0';
      for (;;) {
        const r = await Lookup.opCall('countMatching', { pattern, cursor });
        if (stop) return;
        count += r.count;
        cursor = r.cursor;
        progress.textContent = `Counting… ${fmtNum(count)} found so far`;
        if (r.done) break;
      }
    } catch (e) { counting.close(); fail(e); return; }
    counting.close();
    if (!count) { toast(`No keys match ${pattern}`, 'info', 3000); return; }
    // 2. Ask (type the pattern on Production).
    const prod = S.current && (S.current.env === 'prod' || S.current.env === 'production');
    const typed = h('input', { class: 'input mono', spellcheck: 'false', placeholder: pattern });
    const ok = await new Promise((resolve) => {
      let answered = false;
      const m = modal({
        title: `Delete ${fmtNum(count)} key${count === 1 ? '' : 's'}?`,
        body: h('div', { class: 'r-confirm' },
          h('p', null, 'Every key matching ', h('code', null, pattern), ` in ${where} will be deleted. This can't be undone.`),
          h('pre', { class: 'r-confirm-cmds' }, `SCAN … MATCH ${pattern}\nUNLINK <the ${fmtNum(count)} keys found>`),
          prod ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'This is a Production connection. Type the pattern to confirm'), typed) : null),
        actions: [
          { label: 'Cancel', onClick: () => { answered = true; resolve(false); } },
          { label: `Delete ${fmtNum(count)} key${count === 1 ? '' : 's'}`, kind: 'danger', onClick: () => {
            if (prod && typed.value !== pattern) { typed.classList.add('invalid'); typed.focus(); return false; }
            answered = true; resolve(true);
          } },
        ],
        onClose: () => { if (!answered) resolve(false); },
      });
      if (!prod) setTimeout(() => m.box.querySelector('.btn.danger').focus(), 0);
    });
    if (!ok) return;
    // 3. Delete in steps.
    stop = false;
    let finished = false;
    let deleted = 0;
    const bar = h('div', { class: 'r-delbar' }, h('div', { class: 'r-delbar-fill' }));
    const line = h('p', { class: 'muted' }, 'Deleting…');
    const running = modal({ title: `Deleting keys matching ${pattern}`, body: h('div', null, bar, line), actions: [{ label: 'Stop', onClick: () => { stop = true; return false; } }], onClose: () => { if (!finished) stop = true; } });
    let error = null;
    try {
      let cursor = '0';
      for (;;) {
        const r = await Lookup.opCall('deleteMatching', { pattern, cursor, confirmed: true }); // asked above
        deleted += r.deleted;
        cursor = r.cursor;
        bar.firstChild.style.width = Math.min(100, Math.round((deleted / count) * 100)) + '%';
        line.textContent = `${fmtNum(deleted)} of about ${fmtNum(count)} deleted`;
        if (r.done || stop) break;
      }
    } catch (e) { error = e; }
    finished = true;
    running.close();
    // 4. The sidebar and open tabs follow.
    // Open tabs of keys under the folder are closed (their keys are gone).
    if (prefix !== null) for (const t of [...S.tabs]) if (t.kind === 'rkey' && textOf(t.key).startsWith(prefix)) await Lookup.closeTab(t.id, true);
    await loadKeyspace();
    scan(true);
    if (error) fail(error);
    else toast(stop ? `Stopped: ${fmtNum(deleted)} key${deleted === 1 ? '' : 's'} deleted` : `${fmtNum(deleted)} key${deleted === 1 ? '' : 's'} deleted`, stop ? 'info' : 'ok', 4000);
  }

  async function deleteKey(k) {
    if (!(await confirmBox('Delete key', `Delete ${textOf(k.key)}? This can't be undone.`, 'Delete', true))) return false;
    try {
      await rop('remove', { keys: [k.key] }, { describe: `UNLINK ${Cli.quoteArg(k.key)}` });
      keyGone(k.key);
      for (const t of [...S.tabs]) if (t.kind === 'rkey' && keyId(t.key) === keyId(k.key)) await Lookup.closeTab(t.id, true);
      toast('Key deleted', 'ok', 2000);
      return true;
    } catch (e) { fail(e); return false; }
  }

  /** Time to live dialog: seconds, quick choices, or no expiry. Returns the new TTL in ms, or undefined. */
  function ttlDialog(k, after) {
    const input = h('input', { class: 'input', type: 'number', min: '1', placeholder: 'seconds' });
    if (k.ttl > 0) input.value = Math.ceil(k.ttl / 1000);
    const quick = [['1 min', 60], ['1 hour', 3600], ['1 day', 86400], ['7 days', 604800]];
    const apply = async (seconds) => {
      try {
        const r = await rop('setTtl', { key: k.key, seconds }, { describe: `${seconds ? `EXPIRE ${Cli.quoteArg(k.key)} ${seconds}` : `PERSIST ${Cli.quoteArg(k.key)}`}` });
        keyChanged(k.key, { ttl: r.ttl });
        if (after) after(r.ttl);
        toast(seconds ? `Expires in ${fmtTtl(r.ttl, true)}` : 'Expiry removed', 'ok', 2000);
        return true;
      } catch (e) { fail(e); return false; }
    };
    const m = modal({
      title: 'Time to live',
      body: h('div', { class: 'r-ttl-dialog' },
        h('p', { class: 'muted' }, k.ttl > 0 ? `${textOf(k.key)} expires in ${fmtTtl(k.ttl, true)}.` : `${textOf(k.key)} has no expiry.`),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Expire after (seconds)'), input),
        h('div', { class: 'r-quick' }, quick.map(([label, s]) => h('button', { type: 'button', class: 'btn sm', onclick: () => { input.value = s; } }, label)))),
      actions: [
        k.ttl > 0 ? { label: 'Remove expiry', onClick: () => apply(null) } : null,
        { label: 'Cancel' },
        { label: 'Set', kind: 'primary', onClick: async () => { const s = Math.round(Number(input.value)); if (!(s > 0)) { toast('Enter a number of seconds', 'err'); return false; } return apply(s); } },
      ].filter(Boolean),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.box.querySelector('.modal-foot .primary').click(); } });
  }

  // ---------- New key ----------
  function newKeyDialog(prefill = {}) {
    const st = { type: prefill.type || 'string', key: prefill.key || (R.match && !/[*?[]/.test(R.match) ? R.match : ''), ttl: '', value: '', field: '', member: '', score: '0' };
    const typeSel = h('select', { class: 'input', onchange: (e) => { st.type = e.target.value; paintFields(); } },
      Object.entries(TYPES).map(([t, l]) => h('option', { value: t }, l)));
    typeSel.value = st.type;
    const inp = (k, attrs = {}) => { const el = h(attrs.textarea ? 'textarea' : 'input', { class: 'input mono', spellcheck: 'false', ...attrs, oninput: (e) => { st[k] = e.target.value; } }); el.value = st[k]; return el; };
    const fieldsBox = h('div', { class: 'r-new-fields' });
    const fld = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el, hint ? h('span', { class: 'field-hint' }, hint) : null);
    const paintFields = () => {
      fieldsBox.innerHTML = '';
      const t = st.type;
      if (t === 'string') fieldsBox.append(fld('Value', inp('value', { textarea: true, rows: 5 })));
      if (t === 'json') fieldsBox.append(fld('JSON value', inp('value', { textarea: true, rows: 5, placeholder: '{"name": "Ali"}' }), 'Needs the RedisJSON module on the server.'));
      if (t === 'hash' || t === 'stream') fieldsBox.append(h('div', { class: 'grid2' }, fld('Field', inp('field')), fld('Value', inp('value'))));
      if (t === 'list') fieldsBox.append(fld('First element', inp('value')));
      if (t === 'set') fieldsBox.append(fld('First member', inp('member')));
      if (t === 'zset') fieldsBox.append(h('div', { class: 'grid2' }, fld('Member', inp('member')), fld('Score', inp('score', { type: 'number', step: 'any' }))));
      if (t !== 'string' && t !== 'json') fieldsBox.append(h('p', { class: 'muted small' }, 'Add more after the key is created.'));
    };
    paintFields();
    modal({
      title: `New key in db${R.db}`,
      wide: true,
      body: h('div', { class: 'r-new' },
        h('div', { class: 'grid2' }, fld('Type', typeSel), fld('Time to live (seconds)', inp('ttl', { type: 'number', min: '0', placeholder: 'No expiry' }))),
        fld('Key name', inp('key', { placeholder: 'user:1043:profile' })),
        fieldsBox),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create', kind: 'primary', onClick: async () => {
            if (!st.key) { toast('Enter a key name', 'err'); return false; }
            try {
              await rop('create', { ...st });
              const info = await rop('keyInfo', { key: st.key });
              const k = { key: info.key, type: info.type, ttl: info.ttl, size: info.size };
              keyAdded(k);
              Lookup.openRedisKey(k);
              return true;
            } catch (e) { fail(e); return false; }
          },
        },
      ],
    });
  }

  // ---------- Status bar, title bar ----------
  function redisWhere() {
    const c = S.current;
    const host = c.mode === 'string' ? 'URL' : `${c.host || 'localhost'}:${c.port || 6379}`;
    return `${c.user || 'default'}@${host} · ${R.cluster || (S.info && S.info.cluster) ? 'cluster' : `db${R.db}`}`;
  }
  function redisStatusItems() {
    const cl = R.cluster || (S.info && S.info.cluster);
    return [
      cl ? h('span', { class: 'sb-item muted' }, `Cluster · ${cl.masters} masters`) : null,
      R.usedMemory !== null ? h('span', { class: 'sb-item muted' }, `${fmtBytes(R.usedMemory)} used`) : null,
      R.dbSize !== null ? h('span', { class: 'sb-item muted' }, `${fmtNum(R.dbSize)} key${R.dbSize === 1 ? '' : 's'}${cl ? '' : ` in db${R.db}`}`) : null,
      S.current && S.current.readOnly ? h('span', { class: 'sb-item muted' }, 'Read-only') : null,
    ].filter(Boolean);
  }

  // ---------- Hooks into the shared workspace code ----------
  // Shell messages (SUBSCRIBE / MONITOR) and dropped Shell connections, routed to their tab.
  api.onPush((msg) => {
    const t = S.tabs.find((x) => x.kind === 'rshell' && x.shellId === msg.id);
    if (t && t.onPush) t.onPush(msg);
  });
  const wrap = (name, redisFn) => {
    const orig = Lookup[name];
    Lookup[name] = (...a) => (isRedis() ? redisFn(...a) : orig(...a));
  };
  // Installed when this file loads (on the first Redis connection; the shared files are loaded by then).
  Lookup.whenLoaded(() => {
    wrap('openQueryTab', () => Lookup.openWorkbench());
    wrap('openAnything', () => { const f = $('#r-filter'); if (f) { f.focus(); f.select(); } });
    wrap('commitShortcut', () => { const t = S.tabs.find((x) => x.id === S.active); if (t && t.save) t.save(); });
    wrap('saveQueryTabs', () => Lookup.saveRedisTabs && Lookup.saveRedisTabs());
    const origActivate = Lookup.activate;
    Lookup.activate = (id) => { origActivate(id); if (isRedis()) paintTreeActive(); };
    const origEnter = Lookup.enterWorkspace;
    Lookup.enterWorkspace = (...a) => { if (!isRedis()) setEmptyState(false); return origEnter(...a); };
  });

  /** After Reconnect: back to the picked database, and new connections for the Shell tabs. */
  async function redisReconnected() {
    const want = R.db;
    try { if ((await rop('keyspace')).current !== want) await rop('selectDb', { index: want }); } catch (e) { fail(e); }
    S.schema = R.cluster ? 'cluster' : `db${R.db}`;
    Lookup.pushState();
    for (const t of S.tabs) if (t.onReconnected) await t.onReconnected();
    scan(true);
  }

  Object.assign(Lookup, {
    isRedis, enterRedis, redisWhere, redisStatusItems, redisReconnected, R,
    redisText: textOf, redisKeyId: keyId, redisIsBinary: isBinary, fmtTtl, typeBadge, REDIS_TYPES: TYPES,
    redisKeyChanged: keyChanged, redisKeyGone: keyGone, redisKeyAdded: keyAdded,
    redisRename: renameKey, redisDelete: deleteKey, redisDeleteMatching: deleteMatching, redisTtlDialog: ttlDialog, redisNewKey: newKeyDialog,
    redisPaintActive: paintTreeActive, redisLoadKeyspace: loadKeyspace, redisRefreshMemory: refreshMemory, redisScan: scan,
  });
})();
