// Redis Workbench and Shell tabs.
// Workbench: type commands (several lines run one after another), replies shown formatted (or raw),
// command list with arguments as you type, history, Stop for blocking commands.
// Shell: behaves like redis-cli in a terminal — host:port[db]> prompt, replies printed exactly as
// redis-cli prints them, grey argument hints, Tab completion, ↑/↓ history, HELP, CLEAR, repeat count
// ("3 INCR n"), SUBSCRIBE / PSUBSCRIBE / MONITOR streaming until Ctrl+C. Each Shell tab has its own
// connection, so SELECT, MULTI and subscriptions stay in that tab.
(function () {
  const { h, icon, toast, fmtMs } = window.U;
  const Lookup = window.Lookup;
  const { S } = Lookup;
  const Cli = window.RedisCli;
  const Cmds = window.RedisCommands;
  const rop = (...a) => Lookup.rop(...a);

  // ---------- History (per connection, shared by the Workbench and Shells) ----------
  const HIST_MAX = 500;
  const histKey = () => `lookup.redis.history.${S.current && S.current.id}`;
  function history() { try { return JSON.parse(localStorage.getItem(histKey()) || '[]'); } catch { return []; } }
  function remember(line) {
    const t = line.trim();
    if (!t) return;
    const list = history().filter((x) => x !== t);
    list.push(t);
    try { localStorage.setItem(histKey(), JSON.stringify(list.slice(-HIST_MAX))); } catch { /* storage full */ }
  }

  /** "3 INCR n" -> repeat 3; redis-cli treats a leading number as a repeat count. */
  function parseCommand(line) {
    const p = Cli.parseLine(line);
    if (p.error) return { error: p.error };
    let args = p.args;
    let repeat = 1;
    if (args.length > 1 && typeof args[0] === 'string' && /^\d+$/.test(args[0])) { repeat = Math.min(10000, Number(args[0])); args = args.slice(1); }
    return { args, repeat };
  }
  const nameOf = (args) => String(typeof args[0] === 'string' ? args[0] : '').toUpperCase();

  // Commands whose flat reply is field / value pairs (shown in two columns in the Workbench).
  function pairsReply(args) {
    const n = nameOf(args);
    const up = args.map((a) => (typeof a === 'string' ? a.toUpperCase() : ''));
    if (n === 'HGETALL') return true;
    if (n === 'CONFIG' && up[1] === 'GET') return true;
    if (n === 'HRANDFIELD' && up.includes('WITHVALUES')) return true;
    if (/^Z(REV)?RANGE|^ZRANDMEMBER|^ZDIFF$|^ZINTER$|^ZUNION$/.test(n) && up.includes('WITHSCORES')) return true;
    if (n === 'ZPOPMIN' || n === 'ZPOPMAX') return true;
    return false;
  }

  // ---------- Formatted replies (Workbench) ----------
  /** Text with control characters escaped; UTF-8 kept (unlike redis-cli, which escapes it). */
  const visible = (s) => String(s).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  function scalar(r) {
    switch (r.t) {
      case 'status': return h('span', { class: 'rr-status' }, r.v);
      case 'error': return h('span', { class: 'rr-err' }, `(error) ${r.v}`);
      case 'int': return h('span', { class: 'rr-int' }, `(integer) ${r.v}`);
      case 'double': return h('span', { class: 'rr-int' }, `(double) ${r.v}`);
      case 'bignum': return h('span', { class: 'rr-int' }, `(big number) ${r.v}`);
      case 'bool': return h('span', { class: 'rr-int' }, r.v ? '(true)' : '(false)');
      case 'nil': return h('span', { class: 'rr-nil' }, '(nil)');
      case 'more': return h('span', { class: 'rr-nil' }, `(… ${r.n.toLocaleString()} more not shown)`);
      case 'verbatim': return h('span', { class: 'rr-str' }, `"${visible(r.v)}"`);
      case 'bulk': {
        const text = r.b !== undefined ? Cli.bulkText(r) : visible(r.s);
        const cut = r.cut ? h('span', { class: 'rr-nil' }, ` (first ${Math.round((r.s || '').length / 1024)} KB of ${Math.round(r.cut / 1024)} KB)`) : null;
        return h('span', null, h('span', { class: 'rr-str' }, `"${text}"`), cut);
      }
      default: return null;
    }
  }
  function formatted(r, args) {
    // A JSON document in a string reply is shown pretty.
    if (r.t === 'bulk' && r.s !== undefined && !r.cut) {
      const j = Lookup.jsonView(r.s);
      if (j) return j;
    }
    if (!['array', 'set', 'push', 'map'].includes(r.t)) return h('div', { class: 'rr-line' }, scalar(r));
    const items = r.t === 'map' ? r.v.flat() : r.v;
    if (!items.length) return h('div', { class: 'rr-line rr-nil' }, '(empty array)');
    const flat = items.every((x) => !['array', 'set', 'push', 'map'].includes(x.t));
    if ((r.t === 'map' || (pairsReply(args) && items.length % 2 === 0)) && flat) {
      const grid = h('div', { class: 'rr-pairs' });
      for (let i = 0; i < items.length; i += 2) {
        if (items[i].t === 'more') { grid.append(h('span', { class: 'rr-idx' }), scalar(items[i]), h('span')); break; }
        grid.append(h('span', { class: 'rr-idx' }, `${i / 2 + 1})`), scalar(items[i]), items[i + 1] ? scalar(items[i + 1]) : h('span'));
      }
      return grid;
    }
    const list = h('div', { class: 'rr-list' });
    const w = String(items.length).length;
    items.forEach((x, i) => {
      if (x.t === 'more') { list.append(h('div', { class: 'rr-row' }, h('span', { class: 'rr-idx' }), scalar(x))); return; }
      list.append(h('div', { class: 'rr-row' }, h('span', { class: 'rr-idx' }, `${String(i + 1).padStart(w)})`), formatted(x, [])));
    });
    return list;
  }

  // ---------- Autocomplete (Workbench) ----------
  function suggestBox(input, onPick) {
    const box = h('div', { class: 'r-suggest hidden' });
    let items = [];
    let idx = 0;
    const word = () => {
      const pos = input.selectionStart;
      const before = input.value.slice(0, pos);
      const lineStart = before.lastIndexOf('\n') + 1;
      const line = before.slice(lineStart);
      const m = /^\s*(\d+\s+)?([A-Za-z_.-]*)$/.exec(line);
      return m ? { prefix: m[2], from: pos - m[2].length } : null;
    };
    const paint = () => {
      box.innerHTML = '';
      items.forEach((c, i) => box.append(h('div', {
        class: 'r-suggest-item' + (i === idx ? ' on' : ''),
        onmousedown: (e) => { e.preventDefault(); idx = i; accept(); },
      }, h('span', { class: 'r-suggest-name' }, c.name), h('span', { class: 'r-suggest-args' }, c.args), h('span', { class: 'r-suggest-sum' }, c.summary))));
      box.classList.toggle('hidden', !items.length);
    };
    const update = () => {
      const w = word();
      if (!w || !w.prefix) { items = []; paint(); return; }
      items = Cmds.complete(w.prefix).slice(0, 8).map((n) => Cmds.COMMANDS.get(n));
      if (items.length === 1 && items[0].name === w.prefix.toUpperCase()) items = [];
      idx = 0;
      paint();
    };
    const accept = () => {
      const w = word();
      const c = items[idx];
      if (!w || !c) return false;
      const name = /^[a-z]/.test(w.prefix) ? c.name.toLowerCase() : c.name;
      input.setRangeText(name + ' ', w.from, input.selectionStart, 'end');
      items = [];
      paint();
      onPick && onPick();
      return true;
    };
    const key = (e) => {
      if (!items.length) return false;
      if (e.key === 'ArrowDown') { idx = (idx + 1) % items.length; paint(); return true; }
      if (e.key === 'ArrowUp') { idx = (idx + items.length - 1) % items.length; paint(); return true; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey)) return accept();
      if (e.key === 'Escape') { items = []; paint(); return true; }
      return false;
    };
    return { el: box, update, key, close: () => { items = []; paint(); } };
  }

  // ---------- Workbench ----------
  const draftKey = () => `lookup.redis.workbench.${S.current && S.current.id}`;
  function openWorkbench() {
    const existing = S.tabs.find((t) => t.kind === 'rwb');
    if (existing) { Lookup.activate(existing.id); existing.input.focus(); return existing; }
    const tab = { kind: 'rwb', title: 'Workbench', name: 'Workbench', icon: 'code', el: h('div', { class: 'tabview r-wb' }), raw: false, running: false };
    const out = h('div', { class: 'r-out' });
    const input = h('textarea', { class: 'r-wb-input', rows: 1, spellcheck: 'false', placeholder: 'Type a Redis command, e.g. HGETALL user:1042:profile' });
    try { input.value = localStorage.getItem(draftKey()) || ''; } catch { /* none */ }
    const hint = h('div', { class: 'r-wb-hint' });
    const suggest = suggestBox(input, () => paintHint());
    const runBtn = h('button', { class: 'btn sm primary', title: 'Run the line at the cursor, or the selection (Ctrl+Enter)', onclick: () => run('line') }, icon('play'), 'Run');
    const runAllBtn = h('button', { class: 'btn sm', title: 'Run every line (Enter)', onclick: () => run('all') }, icon('playAll'), 'Run all');
    const stopBtn = h('button', { class: 'btn sm hidden', title: 'Stop: release a blocking command, or stop waiting', onclick: () => stop() }, icon('stop'), 'Stop');
    const seg = h('div', { class: 'seg sm' }, [['fmt', 'Formatted'], ['raw', 'Raw']].map(([id, label]) => h('button', {
      type: 'button', class: id === 'fmt' ? 'on' : '',
      onclick: (e) => { tab.raw = id === 'raw'; e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); repaintAll(); },
    }, label)));
    // Cluster: where commands without a key run (commands with a key always go to the key's node).
    const cluster = Lookup.R.cluster || (S.info && S.info.cluster);
    tab.node = 'auto';
    const nodeSel = cluster ? h('select', { class: 'input xs r-node-sel', title: 'Commands with a key go to the node holding it. Commands without a key (DBSIZE, INFO, KEYS…) run here.', onchange: (e) => { tab.node = e.target.value; } },
      h('option', { value: 'auto' }, 'No key: first master'),
      h('option', { value: 'all' }, 'No key: every master')) : null;
    if (nodeSel) for (const n of cluster.nodes || []) nodeSel.append(h('option', { value: n.id }, `No key: ${n.id}`));
    const note = h('span', { class: 'muted r-wb-note' });
    const paintNote = () => {
      const c = S.current || {};
      note.textContent = `${cluster ? 'cluster' : `db${Lookup.R.db}`}${c.readOnly ? ' · read-only: write commands are blocked' : c.env === 'prod' || c.env === 'production' ? ' · write commands ask first on Production' : ''}`;
    };
    paintNote();
    tab.onDbChanged = () => paintNote();
    const blocks = [];
    const MAX_BLOCKS = 300;
    function addBlock(line) {
      const b = { line, el: h('div', { class: 'r-block' }), body: h('div', { class: 'r-block-body' }), ms: h('span', { class: 'r-block-ms muted' }) };
      b.el.append(h('div', { class: 'r-block-head' }, h('span', { class: 'r-caret' }, '›'), h('span', { class: 'r-block-cmd' }, line), b.ms), b.body);
      b.body.append(h('div', { class: 'rr-nil' }, '…'));
      out.append(b.el);
      blocks.push(b);
      while (blocks.length > MAX_BLOCKS) blocks.shift().el.remove();
      out.scrollTop = out.scrollHeight;
      return b;
    }
    function paintBlock(b) {
      b.body.innerHTML = '';
      if (b.note) { b.body.append(h('div', { class: b.noteCls || 'rr-err' }, b.note)); return; }
      const show = (reply) => (tab.raw ? h('pre', { class: 'rr-raw' }, Cli.formatRaw(reply)) : formatted(reply, b.args));
      for (const res of b.results) {
        // Cluster, every master: one reply per node.
        if (res.replies) for (const x of res.replies) b.body.append(h('div', { class: 'rr-node' }, x.node), show(x.reply));
        else b.body.append(show(res.reply));
      }
      const nodes = [...new Set(b.results.map((x) => x.node).filter(Boolean))];
      b.ms.textContent = b.results.length ? `${nodes.length ? nodes.join(', ') + ' · ' : ''}${fmtMs(b.results.reduce((s, x) => s + x.ms, 0))}` : '';
    }
    function repaintAll() { for (const b of blocks) if (b.results || b.note) paintBlock(b); }

    async function run(which) {
      if (tab.running) return;
      let text = input.value;
      if (which === 'line') {
        const sel = input.value.slice(input.selectionStart, input.selectionEnd);
        if (sel.trim()) text = sel;
        else {
          const pos = input.selectionStart;
          const start = input.value.lastIndexOf('\n', pos - 1) + 1;
          const end = input.value.indexOf('\n', pos);
          text = input.value.slice(start, end < 0 ? undefined : end);
        }
      }
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
      if (!lines.length) return;
      if (which === 'all') { input.value = ''; autoGrow(); }
      lines.forEach(remember);
      histPos = -1;
      suggest.close();
      tab.running = true;
      tab.stopAsked = false;
      const ack = {}; // one yes covers the rest of this run (Production)
      runBtn.classList.add('hidden'); runAllBtn.classList.add('hidden'); stopBtn.classList.remove('hidden');
      try {
        for (const line of lines) {
          if (tab.stopAsked) break;
          const b = addBlock(line);
          const p = parseCommand(line);
          if (p.error) { b.note = p.error; paintBlock(b); continue; }
          const n = nameOf(p.args);
          if (n === 'CLEAR') { out.innerHTML = ''; blocks.length = 0; continue; }
          if (n === 'HELP') { b.note = helpText(p.args); b.noteCls = 'rr-help'; paintBlock(b); continue; }
          b.args = p.args;
          b.results = [];
          for (let i = 0; i < p.repeat && !tab.stopAsked; i++) {
            try {
              const r = ack.yes ? await Lookup.opCall('command', { args: p.args, node: tab.node, confirmed: true }) : await rop('command', { args: p.args, node: tab.node }, { describe: lines.length > 1 ? lines.join('\n') : line, ack });
              b.results.push(r);
            } catch (e) {
              b.note = e.notSent ? '(not sent)' : e.message;
              b.noteCls = e.notSent ? 'rr-nil' : 'rr-err';
              if (e.notSent) tab.stopAsked = true;
              break;
            }
          }
          paintBlock(b);
          out.scrollTop = out.scrollHeight;
        }
      } finally {
        tab.running = false;
        runBtn.classList.remove('hidden'); runAllBtn.classList.remove('hidden'); stopBtn.classList.add('hidden');
        input.focus();
        Lookup.redisLoadKeyspace && Lookup.redisLoadKeyspace(); // key counts may have changed
      }
    }
    async function stop() {
      tab.stopAsked = true;
      stopBtn.disabled = true;
      try { await rop('stop'); } catch (e) { toast(e.message, 'err'); } finally { stopBtn.disabled = false; }
    }

    // History with ↑ / ↓ when the cursor is on the first / last line.
    let histPos = -1;
    let histSaved = '';
    function histStep(dir) {
      const list = history();
      if (!list.length) return;
      if (histPos === -1) { histSaved = input.value; histPos = list.length; }
      histPos = Math.max(0, Math.min(list.length, histPos + dir));
      input.value = histPos === list.length ? histSaved : list[histPos];
      if (histPos === list.length) histPos = -1;
      autoGrow();
      input.selectionStart = input.selectionEnd = input.value.length;
    }
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(220, input.scrollHeight) + 'px';
    }
    function paintHint() {
      const pos = input.selectionStart;
      const start = input.value.lastIndexOf('\n', pos - 1) + 1;
      const end = input.value.indexOf('\n', pos);
      const line = input.value.slice(start, end < 0 ? undefined : end);
      const p = Cli.parseLine(line);
      const c = !p.error && p.args.length ? Cmds.COMMANDS.get(nameOf(p.args.length > 1 && /^\d+$/.test(p.args[0]) ? p.args.slice(1) : p.args)) : null;
      hint.innerHTML = '';
      if (c) hint.append(h('span', { class: 'r-hint-name' }, c.name), ' ', h('span', null, c.args), h('span', { class: 'muted' }, ` — ${c.summary}`));
      else hint.append(h('span', { class: 'muted' }, 'Enter runs · Shift+Enter new line · Ctrl+Enter runs the line at the cursor · ↑ history · Tab completes'));
    }
    input.addEventListener('keydown', (e) => {
      if (suggest.key(e)) { e.preventDefault(); e.stopPropagation(); return; }
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Enter' && mod) { e.preventDefault(); e.stopPropagation(); run('line'); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); run('all'); return; }
      if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); out.innerHTML = ''; blocks.length = 0; return; }
      if (e.key === 'ArrowUp' && !input.value.slice(0, input.selectionStart).includes('\n')) { e.preventDefault(); histStep(-1); return; }
      if (e.key === 'ArrowDown' && !input.value.slice(input.selectionEnd).includes('\n') && histPos !== -1) { e.preventDefault(); histStep(1); }
    });
    input.addEventListener('input', () => { autoGrow(); suggest.update(); paintHint(); try { localStorage.setItem(draftKey(), input.value); } catch { /* full */ } });
    input.addEventListener('click', paintHint);
    input.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow')) paintHint(); });
    input.addEventListener('blur', () => setTimeout(() => suggest.close(), 150));

    tab.el.append(
      h('div', { class: 'r-toolbar' }, runBtn, runAllBtn, stopBtn, h('div', { class: 'tb-sep' }), seg, nodeSel, h('div', { class: 'spacer' }), note,
        h('button', { class: 'icon-btn', title: 'History', onclick: (e) => historyMenu(e, (line) => { input.value = line; autoGrow(); input.focus(); paintHint(); }) }, icon('history')),
        h('button', { class: 'icon-btn', title: 'Clear results (Ctrl+L)', onclick: () => { out.innerHTML = ''; blocks.length = 0; } }, icon('eraser'))),
      out,
      h('div', { class: 'r-wb-inputbar' }, suggest.el, h('div', { class: 'r-wb-inputrow' }, h('span', { class: 'r-caret' }, '›'), input), hint));
    tab.input = input;
    tab.onShow = () => setTimeout(() => input.focus(), 0);
    Lookup.addTab(tab);
    autoGrow();
    paintHint();
    input.focus();
    return tab;
  }
  function historyMenu(e, pick) {
    const list = history().slice(-25).reverse();
    const r = e.currentTarget.getBoundingClientRect();
    window.U.contextMenu(r.left - 260, r.bottom + 4, list.length
      ? list.map((l) => ({ label: l.length > 70 ? l.slice(0, 69) + '…' : l, onClick: () => pick(l) }))
      : [{ label: 'No commands yet', disabled: true, onClick: () => {} }]);
  }

  /** HELP, HELP <command>, HELP @<group> — like redis-cli. */
  function helpText(args) {
    const topic = args[1] ? String(typeof args[1] === 'string' ? args[1] : '').toUpperCase() : '';
    if (!topic) {
      return 'To get help about Redis commands type:\n      "help @<group>" to get a list of commands in <group>\n      "help <command>" for help on <command>\n      "help <tab>" to get a list of possible help topics\n      "quit" to exit\n\nGroups: @string @hash @list @set @sorted-set @stream @generic @bitmap @hyperloglog @geo @pubsub @transactions @scripting @connection @server @json';
    }
    const show = (c) => `\n  ${c.name} ${c.args}\n  summary: ${c.summary}\n  group: ${c.group}\n`;
    if (topic.startsWith('@')) {
      const g = topic.slice(1).toLowerCase();
      const list = [...Cmds.COMMANDS.values()].filter((c) => c.group === g);
      return list.length ? list.map(show).join('') : `No commands in group ${g}`;
    }
    const c = Cmds.COMMANDS.get(topic);
    return c ? show(c) : `No help for ${topic} in Lookup. The server's COMMAND DOCS ${topic} may describe it.`;
  }

  // ---------- Shell ----------
  let shellNo = 0;
  function openRedisShell() {
    shellNo++;
    const tab = {
      kind: 'rshell', title: `Shell ${shellNo}`, name: `Shell ${shellNo}`, icon: 'terminal', el: h('div', { class: 'tabview r-shell' }),
      shellId: `sh${shellNo}-${Date.now().toString(36)}`, db: Lookup.R.db, tx: false, host: '', port: 0,
      connected: false, busy: false, streaming: false,
    };
    const term = h('div', { class: 'r-term' });
    const prompt = h('span', { class: 'r-prompt' });
    const input = h('input', { class: 'r-term-input', spellcheck: 'false', autocomplete: 'off' });
    const ghost = h('span', { class: 'r-ghost' });
    const measure = h('span', { class: 'r-measure' });
    const line = h('div', { class: 'r-termline' }, prompt, h('span', { class: 'r-inputwrap' }, measure, input, ghost));
    term.append(line);
    const MAX_LINES = 5000;
    let lines = 0;
    const print = (text, cls) => {
      const el = h('div', { class: 'r-tl' + (cls ? ' ' + cls : '') }, text);
      term.insertBefore(el, line);
      lines += String(text).split('\n').length;
      while (lines > MAX_LINES && term.firstChild !== line) { lines -= term.firstChild.textContent.split('\n').length; term.firstChild.remove(); }
      term.scrollTop = term.scrollHeight;
    };
    const promptText = () => (tab.connected ? `${tab.host}:${tab.port}${tab.db ? `[${tab.db}]` : ''}${tab.tx ? '(TX)' : ''}> ` : 'not connected> ');
    const paintPrompt = () => {
      prompt.textContent = promptText();
      line.classList.toggle('hidden', tab.busy || tab.streaming);
      paintGhost();
    };
    // Grey hint after the typed text, like redis-cli: the arguments not typed yet.
    function paintGhost() {
      const v = input.value;
      measure.textContent = v;
      ghost.textContent = '';
      if (input.selectionStart !== v.length) return;
      const p = Cli.parseLine(v);
      if (p.error || !p.args.length) return;
      let args = p.args;
      if (args.length > 1 && /^\d+$/.test(args[0])) args = args.slice(1);
      if (!Cmds.COMMANDS.has(nameOf(args))) return;
      const endsWithSpace = /\s$/.test(v);
      const hint = Cmds.hintFor(args, endsWithSpace);
      if (hint) { ghost.textContent = (endsWithSpace ? '' : ' ') + hint; ghost.style.left = measure.offsetWidth + 'px'; }
    }
    // Tab cycles through matching command names (redis-cli does the same).
    let completing = null;
    function complete() {
      const v = input.value;
      if (!completing) {
        const m = /^(\s*(?:\d+\s+)?)(\S*)$/.exec(v);
        if (!m) return;
        const matches = Cmds.complete(m[2]);
        if (!matches.length) return;
        completing = { head: m[1], typed: m[2], matches, i: -1 };
      }
      completing.i = (completing.i + 1) % completing.matches.length;
      const name = completing.matches[completing.i];
      input.value = completing.head + (/^[a-z]/.test(completing.typed) ? name.toLowerCase() : name);
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

    async function open(db) {
      try {
        const r = await rop('shellOpen', { id: tab.shellId, db });
        Object.assign(tab, { host: r.host, port: r.port, db: r.db, connected: true, tx: false });
      } catch (e) {
        tab.connected = false;
        print(`Could not connect: ${e.message}`, 'rr-err');
      }
      paintPrompt();
    }

    async function enter() {
      const text = input.value;
      input.value = '';
      completing = null;
      histPos = -1;
      print(promptText() + text, 'r-echo');
      if (!text.trim()) { paintPrompt(); return; }
      remember(text);
      const p = parseCommand(text);
      if (p.error) { print('Invalid argument(s)'); paintPrompt(); return; }
      const n = nameOf(p.args);
      if (n === 'CLEAR') { clear(); return; }
      if (n === 'QUIT' || n === 'EXIT') { Lookup.closeTab(tab.id, true); return; }
      if (n === 'HELP') { print(helpText(p.args)); paintPrompt(); return; }
      if (n === 'CONNECT') { print('(error) Open another saved connection to reach a different server'); paintPrompt(); return; }
      tab.busy = true;
      paintPrompt();
      try {
        for (let i = 0; i < p.repeat; i++) {
          const ticket = (tab.ticket = (tab.ticket || 0) + 1);
          let r;
          try {
            r = await rop('shellRun', { id: tab.shellId, args: p.args }, { describe: text });
          } catch (e) {
            if (ticket !== tab.ticket) break; // Ctrl+C replaced the connection meanwhile
            if (e.notSent) print('(not sent)', 'rr-nil');
            else print(`(error) ${e.message}`, 'rr-err');
            break;
          }
          if (ticket !== tab.ticket) break;
          if (r.reconnected) tab.connected = true;
          for (const line of r.redirects || []) print(line); // cluster: redis-cli -c prints where it went
          if (r.host) Object.assign(tab, { host: r.host, port: r.port });
          tab.db = r.db;
          tab.tx = r.tx;
          tab.connected = true;
          if (r.streaming) {
            tab.streaming = true;
            print('Reading messages... (press Ctrl-C to quit)');
            break;
          }
          print(Cli.formatTTY(r.reply), r.reply.t === 'error' ? 'rr-err' : null);
        }
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
      if (!tab.streaming && !tab.busy) { if (input.value) print(promptText() + input.value + '^C', 'r-echo'); input.value = ''; paintGhost(); return; }
      tab.ticket = (tab.ticket || 0) + 1; // a reply still on its way is dropped
      try {
        const r = await rop('shellStop', { id: tab.shellId });
        Object.assign(tab, { db: r.db, tx: false, streaming: false, busy: false, connected: true }, r.host ? { host: r.host, port: r.port } : {});
      } catch (e) { print(`(error) ${e.message}`, 'rr-err'); tab.streaming = false; tab.busy = false; }
      paintPrompt();
      input.focus();
    }
    tab.onPush = (msg) => {
      if (msg.kind === 'shell-push') {
        for (const r of msg.replies) print(Cli.formatTTY(r));
        if (msg.dropped) print(`(… ${msg.dropped.toLocaleString()} messages not shown: too many at once)`, 'rr-nil');
      } else if (msg.kind === 'shell-closed') {
        print('Error: Server closed the connection', 'rr-err');
        Object.assign(tab, { connected: false, streaming: false, tx: false });
        paintPrompt();
      }
    };
    tab.onReconnected = async () => { print('(reconnected)', 'rr-nil'); await open(tab.db); };

    input.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key !== 'Tab') completing = null;
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); enter(); return; }
      if (e.key === 'Tab') { e.preventDefault(); complete(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); histStep(-1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); histStep(1); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'c' && !(input.selectionEnd > input.selectionStart)) { e.preventDefault(); e.stopPropagation(); ctrlC(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); e.stopPropagation(); clear(); return; }
      if (mod && ['s', 'r', 'p', 'e'].includes(e.key.toLowerCase())) return; // app shortcuts
    });
    input.addEventListener('input', paintGhost);
    input.addEventListener('keyup', paintGhost);
    // Ctrl+C anywhere in the tab while messages stream (the input line is hidden then).
    tab.onKey = (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'c' && (tab.streaming || tab.busy) && !String(window.getSelection())) { e.preventDefault(); ctrlC(); return true; }
      return false;
    };
    term.addEventListener('mouseup', () => { if (!String(window.getSelection())) input.focus(); });
    tab.el.append(term);
    tab.onShow = () => setTimeout(() => input.focus(), 0);
    tab.destroy = () => { Lookup.opCall('shellClose', { id: tab.shellId }).catch(() => {}); };
    Lookup.addTab(tab);
    print(`Shell on ${S.current.name || 'Redis'} — replies as redis-cli prints them. HELP for help, CLEAR to clear, Ctrl+C stops SUBSCRIBE / MONITOR.`, 'r-banner');
    paintPrompt();
    input.focus();
    open(Lookup.R.db);
    return tab;
  }

  function saveRedisTabs() { /* the Workbench draft and the history are saved as they change */ }

  Object.assign(Lookup, { openWorkbench, openRedisShell, saveRedisTabs, redisHelpText: helpText });
})();
