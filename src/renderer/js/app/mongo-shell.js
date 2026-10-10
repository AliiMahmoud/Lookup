// MongoDB Shell tabs (Lookup's light, mongosh-style shell; the commands run in the main process, see
// db/mongodb/shell.js): "rs0 [primary] shop>" prompt, results printed like mongosh with colours,
// "Type "it" for more", grey argument hints, Tab completion (commands, collections, methods),
// ↑ / ↓ history, Ctrl+C stops a running command, Ctrl+L / cls clears.
(function () {
  const { h } = window.U;
  const Lookup = window.Lookup;
  const { S } = Lookup;
  const L = window.MongoLit;
  const MS = window.MongoShell;
  const rop = (...a) => Lookup.rop(...a);

  const histKey = () => `lookup.mongo.history.${S.current && S.current.id}`;
  const history = () => { try { return JSON.parse(localStorage.getItem(histKey()) || '[]'); } catch { return []; } };
  function remember(line) {
    const t = line.trim();
    if (!t) return;
    const list = history().filter((x) => x !== t);
    list.push(t);
    try { localStorage.setItem(histKey(), JSON.stringify(list.slice(-500))); } catch { /* full */ }
  }

  let shellNo = 0;
  function openMongoShell() {
    shellNo++;
    const tab = { kind: 'mshell', title: `Shell ${shellNo}`, name: `Shell ${shellNo}`, icon: 'terminal', el: h('div', { class: 'tabview r-shell' }), shellId: `ms${shellNo}-${Date.now().toString(36)}`, db: S.info.dbName, topo: { kind: 'standalone' }, busy: false };
    const term = h('div', { class: 'r-term m-term' });
    const prompt = h('span', { class: 'r-prompt' });
    const input = h('input', { class: 'r-term-input', spellcheck: 'false', autocomplete: 'off' });
    const ghost = h('span', { class: 'r-ghost' });
    const measure = h('span', { class: 'r-measure' });
    const line = h('div', { class: 'r-termline' }, prompt, h('span', { class: 'r-inputwrap' }, measure, input, ghost));
    term.append(line);
    let lines = 0;
    const print = (content, cls) => {
      const el = h('div', { class: 'r-tl' + (cls ? ' ' + cls : '') });
      if (typeof content === 'string') el.textContent = content; else el.append(content);
      term.insertBefore(el, line);
      lines += el.textContent.split('\n').length;
      while (lines > 5000 && term.firstChild !== line) { lines -= term.firstChild.textContent.split('\n').length; term.firstChild.remove(); }
      term.scrollTop = term.scrollHeight;
    };
    const promptText = () => {
      const t = tab.topo;
      const pre = t.kind === 'rs' ? `${t.setName} [${t.role}] ` : t.kind === 'mongos' ? '[mongos] ' : '';
      return `${pre}${tab.db}> `;
    };
    const paintPrompt = () => { prompt.textContent = promptText(); line.classList.toggle('hidden', tab.busy); paintGhost(); };
    function paintGhost() {
      measure.textContent = input.value;
      ghost.textContent = '';
      if (input.selectionStart !== input.value.length) return;
      const hint = MS.hint(input.value);
      if (hint) { ghost.textContent = hint.text; ghost.style.left = measure.offsetWidth + 'px'; }
    }
    // Tab completes commands, collection names and methods; again cycles through the matches.
    let completing = null;
    let collNames = [];
    const loadNames = () => rop('collections', { db: tab.db }).then((c) => { collNames = c.map((x) => x.name); }).catch(() => { collNames = []; });
    function complete() {
      if (!completing) {
        const c = MS.completions(input.value, collNames);
        if (!c.items.length) return;
        if (c.items.length > 1 && !completing) print(c.items.join('   '), 'muted');
        completing = { head: input.value.slice(0, c.from), items: c.items, i: -1 };
      }
      completing.i = (completing.i + 1) % completing.items.length;
      input.value = completing.head + completing.items[completing.i];
      paintGhost();
    }
    let histPos = -1;
    let histSaved = '';
    function histStep(dir) {
      const list = history();
      if (!list.length) return;
      if (histPos === -1) { histSaved = input.value; histPos = list.length; }
      histPos = Math.max(0, Math.min(list.length, histPos + dir));
      input.value = histPos === list.length ? histSaved : list[histPos];
      if (histPos === list.length) histPos = -1;
      paintGhost();
    }
    function show(r) {
      if (r.kind === 'none') return;
      if (r.kind === 'text') { print(r.text); return; }
      if (r.kind === 'error') { print(r.text, 'rr-err'); return; }
      if (r.kind === 'value') { print(r.value === null ? 'null' : Lookup.mongoHighlight(L.print(r.value, { width: 80 }))); return; }
      if (r.kind === 'docs') {
        print(Lookup.mongoHighlight(r.docs.length ? '[\n' + r.docs.map((d) => L.print(d, { width: 78, indent: 2 }).replace(/^/, '  ')).join(',\n') + '\n]' : '[]'));
        if (r.more) print('Type "it" for more');
      }
    }
    async function enter() {
      const text = input.value;
      input.value = '';
      completing = null;
      histPos = -1;
      print(promptText() + text, 'r-echo');
      const t = text.trim().replace(/;+$/, '');
      if (!t) { paintPrompt(); return; }
      remember(text);
      if (t === 'cls' || t === 'clear') { clear(); return; }
      if (t === 'exit' || t === 'quit' || t === 'exit()' || t === 'quit()') { Lookup.closeTab(tab.id, true); return; }
      tab.busy = true;
      paintPrompt();
      try {
        const r = await rop('shellRun', { id: tab.shellId, text }, { describe: text });
        if (r.db !== tab.db) { tab.db = r.db; loadNames(); }
        show(r);
      } catch (e) {
        if (e.notSent) print('(not sent)', 'rr-nil');
        else if (/This Shell is closed/.test(e.message)) { await open(); print('(the session was reopened; run the command again)', 'rr-nil'); } else print(`${e.code === 'READ_ONLY' || e.code === 'CONFIRM_WRITE' ? '' : 'Error: '}${e.message}`, 'rr-err');
      } finally {
        tab.busy = false;
        paintPrompt();
        input.focus();
      }
    }
    function clear() {
      while (term.firstChild !== line) term.firstChild.remove();
      lines = 0;
      paintPrompt();
    }
    async function ctrlC() {
      if (!tab.busy) { if (input.value) print(promptText() + input.value + '^C', 'r-echo'); input.value = ''; paintGhost(); return; }
      await rop('shellStop', { id: tab.shellId }).catch(() => {});
    }
    async function open() {
      try {
        const r = await rop('shellOpen', { id: tab.shellId, db: tab.db });
        tab.topo = r.topology;
        tab.db = r.db;
      } catch (e) { print(`Could not open the shell: ${e.message}`, 'rr-err'); }
      paintPrompt();
      loadNames();
    }
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') completing = null;
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); enter(); return; }
      if (e.key === 'Tab') { e.preventDefault(); complete(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); histStep(-1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); histStep(1); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'c' && !(input.selectionEnd > input.selectionStart)) { e.preventDefault(); e.stopPropagation(); ctrlC(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); e.stopPropagation(); clear(); }
    });
    input.addEventListener('input', paintGhost);
    input.addEventListener('keyup', paintGhost);
    tab.onKey = (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'c' && tab.busy && !String(window.getSelection())) { e.preventDefault(); ctrlC(); return true; }
      return false;
    };
    term.addEventListener('mouseup', () => { if (!String(window.getSelection())) input.focus(); });
    tab.el.append(term);
    tab.onShow = () => setTimeout(() => input.focus(), 0);
    tab.onReconnected = async () => { print('(reconnected)', 'rr-nil'); await open(); };
    tab.destroy = () => { Lookup.opCall('shellClose', { id: tab.shellId }).catch(() => {}); };
    Lookup.addTab(tab);
    print(`Shell on ${S.current.name || 'MongoDB'} — mongosh-style, one command at a time. help for help, it for more results, Ctrl+C stops a running command.`, 'r-banner');
    paintPrompt();
    input.focus();
    open();
    return tab;
  }

  // ---------- Overview ----------
  function openMongoOverview() {
    const existing = S.tabs.find((t) => t.kind === 'moverview');
    if (existing) { Lookup.activate(existing.id); return existing; }
    const { fmtNum, fmtBytes } = window.U;
    const tab = { kind: 'moverview', title: 'Overview', name: 'Overview', icon: 'gauge', el: h('div', { class: 'tabview r-overview' }), samples: [] };
    const body = h('div', { class: 'r-ov-body' }, h('div', { class: 'grid-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Reading server status…')));
    tab.el.append(body);
    let busy = false;
    const spark = (vals, cls) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 160 30');
      svg.setAttribute('class', 'r-spark ' + cls);
      const v = vals.filter((x) => x !== null && Number.isFinite(x));
      if (v.length > 1) {
        const min = Math.min(...v); const span = Math.max(...v) - min || 1;
        const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        pl.setAttribute('points', v.map((x, i) => `${(i / 59) * 160},${27 - ((x - min) / span) * 24}`).join(' '));
        svg.append(pl);
      }
      return svg;
    };
    const card = (title, value, sub, series, cls) => h('div', { class: 'r-card' }, h('div', { class: 'r-card-title' }, title), h('div', { class: 'r-card-value' }, value), h('div', { class: 'r-card-sub muted' }, sub), spark(series, cls));
    const kv = (rows) => h('table', { class: 'r-kv' }, h('tbody', null, rows.filter(Boolean).map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'mono' }, v)))));
    const opsOf = (o) => Object.values(o.opcounters || {}).reduce((a, b) => a + (b || 0), 0);
    async function tick() {
      if (busy || document.hidden || tab.el.classList.contains('hidden') || S.lost) return;
      busy = true;
      try {
        const o = await rop('overview');
        const prev = tab.samples[tab.samples.length - 1];
        o.opsPerSec = prev ? Math.max(0, Math.round((opsOf(o) - opsOf(prev)) / ((o.at - prev.at) / 1000))) : null;
        o.inPerSec = prev && o.network && prev.network ? Math.max(0, (o.network.bytesIn - prev.network.bytesIn) / ((o.at - prev.at) / 1000)) : null;
        o.outPerSec = prev && o.network && prev.network ? Math.max(0, (o.network.bytesOut - prev.network.bytesOut) / ((o.at - prev.at) / 1000)) : null;
        tab.samples.push(o);
        if (tab.samples.length > 60) tab.samples.shift();
        paint(o);
      } catch (e) { body.innerHTML = ''; body.append(h('div', { class: 'err-text' }, e.message)); } finally { busy = false; }
    }
    function paint(o) {
      const s = tab.samples;
      const up = o.uptimeSec;
      body.innerHTML = '';
      body.append(
        h('div', { class: 'r-cards' },
          card('Operations / sec', o.opsPerSec === null ? '…' : fmtNum(o.opsPerSec), 'queries, inserts, updates, deletes, commands · every 5 s', s.map((x) => x.opsPerSec), 'c1'),
          card('Connections', o.connections ? fmtNum(o.connections.current) : '—', o.connections ? `${fmtNum(o.connections.available)} more available` : 'not shared with this user', s.map((x) => (x.connections ? x.connections.current : null)), 'c3'),
          card('Memory (resident)', o.residentMB !== null ? `${fmtNum(o.residentMB)} MB` : '—', o.cacheBytes !== null && o.cacheMax ? `cache ${fmtBytes(o.cacheBytes)} of ${fmtBytes(o.cacheMax)}` : 'storage engine cache not reported', s.map((x) => x.residentMB), 'c2'),
          card('Network', o.inPerSec === null ? '…' : `${fmtBytes(Math.round(o.inPerSec))}/s in`, o.outPerSec === null ? '' : `${fmtBytes(Math.round(o.outPerSec))}/s out`, s.map((x) => x.inPerSec), 'c4')),
        h('div', { class: 'r-ov-cols' },
          h('div', null,
            h('h3', null, 'Operations since start'),
            kv(Object.entries(o.opcounters || {}).map(([k, v]) => [k, v === null ? '—' : fmtNum(v)])),
            o.members ? h('h3', null, `Replica set ${o.setName || ''}`) : null,
            o.members ? h('table', { class: 'r-kv' }, h('tbody', null, o.members.map((m) => h('tr', null, h('td', null, m.state), h('td', { class: 'mono' }, `${m.name}${m.health === 0 ? ' · down' : ''}${m.lagSec ? ` · ${m.lagSec} s behind` : ''}`))))) : null),
          h('div', null,
            h('h3', null, 'Server'),
            kv([
              ['Version', `${o.product} ${o.version || ''}`],
              ['Host', o.host || '—'],
              ['Uptime', up === null ? '—' : up > 86400 ? `${Math.floor(up / 86400)} days ${Math.floor((up % 86400) / 3600)} h` : `${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min`],
              ['Topology', o.topology ? `${o.topology}${o.setName ? ' ' + o.setName : ''}` : '—'],
              o.primary ? ['Primary', o.primary] : null,
              o.me ? ['Connected to', o.me] : null,
            ]))));
    }
    const timer = setInterval(tick, 5000);
    tab.onShow = () => tick();
    tab.destroy = () => clearInterval(timer);
    Lookup.addTab(tab);
    tick();
    return tab;
  }

  Object.assign(Lookup, { openMongoShell, openMongoOverview });
})();
