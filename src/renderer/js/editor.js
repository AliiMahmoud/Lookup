// Lightweight SQL editor: a textarea over a syntax-highlighted <pre>,
// with line numbers, indentation and autocomplete.
(function () {
  const { h } = window.U;

  const KEYWORDS = new Set(`
    ADD ALL ALTER AND ANY AS ASC BEGIN BETWEEN BODY BY CASCADE CASE CHECK COLUMN COMMENT COMMIT CONNECT CONSTRAINT CREATE
    CROSS CURRENT CURSOR DECLARE DEFAULT DELETE DESC DISTINCT DROP EACH ELSE ELSIF END EXCEPTION EXECUTE EXISTS EXIT FETCH FIRST FOR
    FOREIGN FROM FULL FUNCTION GRANT GROUP HAVING IF IMMEDIATE IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY LEFT LIKE LOOP
    MATERIALIZED MERGE MINUS NATURAL NEXT NOCOPY NOT NULL NULLS OF OFFSET ON ONLY OPEN OR ORDER OTHERS OUT OUTER OVER PACKAGE PARTITION
    PRIMARY PRIOR PROCEDURE PURGE RAISE RECORD REFERENCES RENAME REPLACE RETURN RETURNING REVOKE RIGHT ROLLBACK ROW ROWS ROWID ROWNUM
    SAVEPOINT SELECT SEQUENCE SET START SYNONYM TABLE THEN TO TRIGGER TRUNCATE TYPE UNION UNIQUE UPDATE USING VALUES VIEW WHEN
    WHERE WHILE WITH LEVEL PIVOT UNPIVOT MATCHED LATERAL APPLY ROWTYPE BULK COLLECT FORALL PRAGMA AUTONOMOUS_TRANSACTION
    VARCHAR2 NVARCHAR2 CHAR NCHAR NUMBER INTEGER INT FLOAT DATE TIMESTAMP CLOB NCLOB BLOB RAW LONG BOOLEAN PLS_INTEGER BINARY_INTEGER
    INTERVAL YEAR MONTH DAY ZONE LOCAL TIME TRUE FALSE DUAL`.trim().split(/\s+/));
  const FUNCS = new Set(`
    ABS AVG CAST CEIL COALESCE CONCAT COUNT DECODE DENSE_RANK EXTRACT FLOOR GREATEST INITCAP INSTR LAG LAST_DAY LEAD LEAST LENGTH
    LISTAGG LOWER LPAD LTRIM MAX MIN MOD MONTHS_BETWEEN NEXT_DAY NULLIF NVL NVL2 RANK REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR
    REGEXP_INSTR REPLACE ROUND ROW_NUMBER RPAD RTRIM SIGN SUBSTR SUM SYSDATE SYSTIMESTAMP SYS_CONTEXT TO_CHAR TO_DATE TO_NUMBER
    TO_TIMESTAMP TRANSLATE TRIM TRUNC UPPER USER XMLAGG JSON_VALUE JSON_QUERY JSON_TABLE JSON_OBJECT JSON_ARRAYAGG ADD_MONTHS
    CURRENT_DATE CURRENT_TIMESTAMP DBMS_OUTPUT PUT_LINE`.trim().split(/\s+/));

  const TOKEN = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|([qQ]'\[[\s\S]*?(?:\]'|$)|'(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?\b)|(:[A-Za-z_][\w$#]*)|([A-Za-z_][\w$#]*)/g;

  const esc = (s) => (/[&<>]/.test(s) ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : s);

  /** Highlighted HTML, one string per line; a token that spans lines (block comment, string) is closed and reopened on each. */
  function highlightLines(text) {
    let out = '';
    let last = 0;
    TOKEN.lastIndex = 0;
    let m;
    const span = (cls, raw) => (raw.includes('\n')
      ? raw.split('\n').map((part) => (part ? `<span class="${cls}">${esc(part)}</span>` : '')).join('\n')
      : `<span class="${cls}">${esc(raw)}</span>`);
    while ((m = TOKEN.exec(text))) {
      out += esc(text.slice(last, m.index));
      if (m[1]) out += span('t-com', m[0]);
      else if (m[2]) out += span('t-str', m[0]);
      else if (m[3]) out += span('t-id', m[0]);
      else if (m[4]) out += span('t-num', m[0]);
      else if (m[5]) out += span('t-bind', m[0]);
      else {
        const up = m[0].toUpperCase();
        if (KEYWORDS.has(up)) out += span('t-kw', m[0]);
        else if (FUNCS.has(up)) out += span('t-fn', m[0]);
        else out += esc(m[0]);
      }
      last = TOKEN.lastIndex;
    }
    return (out + esc(text.slice(last))).split('\n');
  }

  const highlight = (text) => highlightLines(text).join('\n') + '\n ';

  /** SQL on one line: whitespace runs become one space; strings and quoted names are kept as is; `-- x` becomes `/* x *\/`.
   *  backslash: \' escapes a quote inside strings (MySQL, ClickHouse). */
  function toOneLine(sql, backslash) {
    let out = '';
    let i = 0;
    const n = sql.length;
    const space = () => { if (out && !out.endsWith(' ')) out += ' '; };
    while (i < n) {
      const ch = sql[i];
      if (/\s/.test(ch)) { space(); i++; continue; }
      if (ch === '-' && sql[i + 1] === '-') {
        let j = sql.indexOf('\n', i);
        if (j < 0) j = n;
        const body = sql.slice(i + 2, j).trim().replace(/\*\//g, '* /');
        if (body) { space(); out += `/* ${body} */`; }
        i = j;
        continue;
      }
      let j = -1;
      if (ch === '/' && sql[i + 1] === '*') {
        j = sql.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        out += sql.slice(i, j).replace(/\s+/g, ' '); // comments aren't data: flatten them too
        i = j;
        continue;
      }
      if ((ch === 'q' || ch === 'Q') && sql[i + 1] === "'" && sql[i + 2] === '[') { j = sql.indexOf("]'", i + 3); j = j < 0 ? n : j + 2; }
      else if (ch === "'" || ch === '"' || ch === '`') {
        j = i + 1;
        while (j < n) {
          if (backslash && sql[j] === '\\') { j += 2; continue; }
          if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } j++; break; }
          j++;
        }
      }
      if (j > i) { out += sql.slice(i, j); i = j; continue; }
      out += ch;
      i++;
    }
    return out.trim();
  }

  /** Each statement of a script on its own line, with a blank line between statements. Comments between statements
   *  stay on their own lines; one at the end of a statement's line stays there. */
  function oneLinePerStatement(text, dialect) {
    const backslash = dialect === 'mysql' || dialect === 'clickhouse';
    const list = window.SqlSplit.split(text, dialect);
    if (!list.length) return text;
    const out = [];
    const gap = (g, between) => {
      const lines = g.split('\n');
      const first = lines.shift().trim(); // rest of the previous statement's line (e.g. `-- note` after `;`)
      if (first) { if (out.length) out[out.length - 1] += ' ' + first; else out.push(first); }
      if (between) out.push(''); // a blank line after each query
      for (const l of lines) if (l.trim()) out.push(l.trim());
    };
    let pos = 0;
    list.forEach((s, i) => {
      gap(text.slice(pos, s.start), i > 0);
      out.push(toOneLine(text.slice(s.start, s.end), backslash));
      pos = s.end;
    });
    gap(text.slice(pos), false);
    return out.join('\n');
  }

  // The highlight layer holds only the lines near the viewport, redrawn each time the view has scrolled this many lines.
  const HL_STEP = 20;

  class SqlEditor {
    constructor({ value = '', onChange, onRun, onRunAll, onSave, onSaveFile, onFormat, completions }) {
      this.onSaveFile = onSaveFile;
      this.onFormat = onFormat;
      this.onChange = onChange;
      this.onRun = onRun;
      this.onRunAll = onRunAll;
      this.onSave = onSave;
      this.completions = completions;
      this.opts = arguments[0] || {};
      this.gutter = h('div', { class: 'ed-gutter' });
      this.pre = h('pre', { class: 'ed-hl', 'aria-hidden': 'true' });
      this.ta = h('textarea', { class: 'ed-input', spellcheck: 'false', wrap: 'off', autocapitalize: 'off', autocomplete: 'off' });
      this.ta.value = value;
      this.pop = h('div', { class: 'ac hidden' });
      this.marks = h('div', { class: 'ed-marks', 'aria-hidden': 'true' }); // find matches, under the text
      this.code = h('div', { class: 'ed-code' }, this.marks, this.pre, this.ta, this.pop);
      this.el = h('div', { class: 'editor' }, this.gutter, this.code);
      this.buildFind();
      this.lines = 0;
      this.ac = null;
      this.viewH = 0; // editor height, kept by the observer below (0 until the editor is on screen)
      new ResizeObserver(() => { this.viewH = this.ta.clientHeight; this.sync(); }).observe(this.ta);

      this.ta.addEventListener('input', (e) => {
        this.render();
        this.onChange && this.onChange(this.ta.value);
        if (this.find) this.findSoon();
        if (this.inserting) return;
        if (e.inputType === 'insertText' && e.data && /[\w$#.]/.test(e.data)) this.suggest(false);
        else if (e.inputType && e.inputType.startsWith('delete') && this.ac) this.suggest(false);
        else this.hideAc();
      });
      this.ta.addEventListener('scroll', () => this.sync());
      this.ta.addEventListener('keydown', (e) => this.onKey(e));
      this.ta.addEventListener('blur', () => setTimeout(() => this.hideAc(), 120));
      this.render();
    }

    get value() { return this.ta.value; }
    set value(v) { this.ta.value = v; this.render(); }
    focus() { this.ta.focus(); }

    // ---------- Find (Ctrl+F) ----------
    buildFind() {
      const { icon } = window.U;
      this.findInput = h('input', { class: 'input xs ed-find-input', placeholder: 'Find', spellcheck: 'false', autocomplete: 'off' });
      this.findCount = h('span', { class: 'ed-find-count' });
      this.findCase = h('button', { class: 'icon-btn xs ed-find-case', title: 'Match case', onmousedown: (e) => e.preventDefault(),
        onclick: () => { this.findCase.classList.toggle('on'); this.runFind(true); } }, 'Aa');
      const btn = (title, ic, cls, fn) => h('button', { class: 'icon-btn xs', title, onmousedown: (e) => e.preventDefault(), onclick: fn }, icon(ic, cls));
      this.findBar = h('div', { class: 'ed-find hidden' }, icon('search'), this.findInput, this.findCount, this.findCase,
        btn('Previous match (Shift+Enter)', 'chevron', 'up', () => this.findStep(-1)),
        btn('Next match (Enter)', 'chevron', 'down', () => this.findStep(1)),
        btn('Close (Esc)', 'x', null, () => this.closeFind()));
      this.el.append(this.findBar);
      this.findSoon = window.U.debounce(() => this.runFind(false), 120);
      this.findInput.addEventListener('input', () => this.runFind(true));
      this.findInput.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === 'Enter' || e.key === 'F3' || (mod && e.key.toLowerCase() === 'g')) { e.preventDefault(); this.findStep(e.shiftKey ? -1 : 1); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeFind(); return; }
        if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); this.findInput.select(); }
      });
    }

    /** Opens the find bar, starting from the selected text (one line) if any. */
    openFind() {
      const sel = this.selection();
      if (sel && !sel.includes('\n')) this.findInput.value = sel;
      this.find = this.find || { list: [], cur: -1 };
      this.findBar.classList.remove('hidden');
      this.findInput.focus();
      this.findInput.select();
      this.runFind(true);
    }

    closeFind() {
      if (!this.find) return;
      this.find = null;
      this.findBar.classList.add('hidden');
      this.marks.innerHTML = '';
      this.ta.focus(); // the last match stays selected
    }

    /** Finds every match; `jump` selects the first one at or after the cursor (as you type in the box). */
    runFind(jump) {
      if (!this.find) return;
      const q = this.findInput.value;
      const v = this.ta.value;
      const list = [];
      if (q) {
        const hay = this.findCase.classList.contains('on') ? v : v.toLowerCase();
        const needle = this.findCase.classList.contains('on') ? q : q.toLowerCase();
        for (let i = hay.indexOf(needle); i >= 0 && list.length < 20000; i = hay.indexOf(needle, i + needle.length)) list.push(i);
      }
      const prev = this.find.list[this.find.cur];
      this.find.list = list;
      this.find.len = q.length;
      if (jump) {
        const from = Math.min(this.ta.selectionStart, this.ta.selectionEnd);
        const i = list.findIndex((p) => p >= from);
        this.find.cur = list.length ? (i < 0 ? 0 : i) : -1;
        if (this.find.cur >= 0) this.showMatch();
      } else {
        // Text edited: keep the current match where it was, without moving the cursor.
        const i = list.findIndex((p) => p >= (prev ?? 0));
        this.find.cur = list.length ? (i < 0 ? list.length - 1 : i) : -1;
      }
      this.findInput.classList.toggle('none', !!q && !list.length);
      this.paintFindCount();
      this.paintMarks();
    }

    findStep(dir) {
      if (!this.find) { this.openFind(); return; }
      const n = this.find.list.length;
      if (!n) return;
      this.find.cur = (this.find.cur + dir + n) % n;
      this.showMatch();
      this.paintFindCount();
      this.paintMarks();
    }

    paintFindCount() {
      const { list, cur } = this.find;
      this.findCount.textContent = !this.findInput.value ? '' : list.length ? `${cur + 1} of ${list.length}${list.length >= 20000 ? '+' : ''}` : 'No results';
    }

    /** Selects the current match and scrolls it into view (keeps the focus in the find box). */
    showMatch() {
      const a = this.find.list[this.find.cur];
      const b = a + this.find.len;
      this.ta.setSelectionRange(a, b);
      const m = this.metrics();
      const v = this.ta.value;
      const line = v.slice(0, a).split('\n').length - 1;
      const col = this.visualCol(v, a);
      const y = m.pt + line * m.lh;
      if (y < this.ta.scrollTop || y + m.lh > this.ta.scrollTop + this.ta.clientHeight) this.ta.scrollTop = y - this.ta.clientHeight / 2;
      const x = m.pl + col * m.charW;
      const w = this.find.len * m.charW;
      if (x < this.ta.scrollLeft || x + w > this.ta.scrollLeft + this.ta.clientWidth) this.ta.scrollLeft = Math.max(0, x - this.ta.clientWidth / 3);
      this.sync();
    }

    /** Column on screen of position pos (tabs count to the next tab stop). */
    visualCol(v, pos) {
      const ls = v.lastIndexOf('\n', pos - 1) + 1;
      let col = 0;
      for (let i = ls; i < pos; i++) col = v[i] === '\t' ? (Math.floor(col / 4) + 1) * 4 : col + 1;
      return col;
    }

    metrics() {
      const cs = getComputedStyle(this.ta);
      if (!this.charW) {
        // Not cs.font: with font-variant-ligatures set, Chromium reports that shorthand as '' (the probe would measure the UI font).
        const probe = h('span', { style: { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing,
          fontVariantLigatures: 'none', position: 'absolute', visibility: 'hidden', whiteSpace: 'pre' } }, 'M'.repeat(50));
        document.body.append(probe);
        this.charW = probe.getBoundingClientRect().width / 50;
        probe.remove();
      }
      return { charW: this.charW, lh: parseFloat(cs.lineHeight) || 20, pl: parseFloat(cs.paddingLeft) || 0, pt: parseFloat(cs.paddingTop) || 0 };
    }

    /** Draws the matches in view (behind the text). */
    paintMarks() {
      this.marks.innerHTML = '';
      if (!this.find || !this.find.list.length || !this.ta.clientHeight) return;
      const { list, cur, len } = this.find;
      const m = this.metrics();
      const v = this.ta.value;
      const t = this.ta.scrollTop;
      const firstLine = Math.floor(t / m.lh) - 2;
      const lastLine = Math.ceil((t + this.ta.clientHeight) / m.lh) + 2;
      // Line of each match, counted incrementally from the start of the text.
      let line = 0;
      let at = 0;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        for (let j = v.indexOf('\n', at); j >= 0 && j < p; j = v.indexOf('\n', j + 1)) { line++; at = j + 1; }
        if (line < firstLine) continue;
        if (line > lastLine) break;
        const x = m.pl + this.visualCol(v, p) * m.charW - this.ta.scrollLeft;
        const y = m.pt + line * m.lh - t;
        frag.append(h('div', { class: 'ed-mark' + (i === cur ? ' cur' : ''), style: { left: x + 'px', top: y + 'px', width: Math.max(2, len * m.charW) + 'px', height: m.lh + 'px' } }));
      }
      this.marks.append(frag);
    }

    // Editor-only zoom (Ctrl+= / Ctrl+- / Ctrl+0 while the editor has focus). Returns the percentage.
    get zoom() { return this._zoom || 100; }
    setZoom(pct, { flash = false } = {}) {
      pct = Math.max(50, Math.min(300, Math.round(pct / 10) * 10));
      this._zoom = pct;
      const f = pct / 100;
      this.el.style.setProperty('--ed-fs', (12.5 * f).toFixed(2) + 'px');
      this.el.style.setProperty('--ed-lh', Math.round(20 * f) + 'px');
      this.charW = null; // re-measure for the autocomplete popup
      this.render();
      if (flash) {
        if (!this.zoomBadge) { this.zoomBadge = h('div', { class: 'ed-zoom' }); this.el.append(this.zoomBadge); }
        this.zoomBadge.textContent = pct + '%';
        this.zoomBadge.classList.add('show');
        clearTimeout(this.zoomT);
        this.zoomT = setTimeout(() => this.zoomBadge.classList.remove('show'), 900);
      }
      return pct;
    }
    zoomStep(dir) {
      const steps = [50, 60, 70, 80, 90, 100, 110, 120, 130, 150, 170, 200, 240, 300];
      if (dir === 0) return this.setZoom(100, { flash: true });
      const cur = this.zoom;
      const next = dir > 0 ? steps.find((s) => s > cur) : [...steps].reverse().find((s) => s < cur);
      return this.setZoom(next || cur, { flash: true });
    }

    render() {
      const v = this.ta.value;
      if (v !== this.hlText) { this.hlText = v; this.hl = highlightLines(v); this.hlRange = null; }
      const n = this.hl.length;
      if (n !== this.lines) {
        this.lines = n;
        let s = '';
        for (let i = 1; i <= n; i++) s += `<div>${i}</div>`;
        this.gutter.innerHTML = s;
      }
      this.sync();
    }

    sync() {
      const { scrollTop: t, scrollLeft: l } = this.ta;
      // Only the lines around the viewport are in the highlight layer (a long script would be re-laid out on every key).
      const lh = Math.round(20 * this.zoom / 100);
      const first = Math.max(0, (Math.floor(t / lh / HL_STEP) - 1) * HL_STEP);
      const last = Math.min(this.hl.length, first + Math.ceil((this.viewH || 1200) / lh) + 3 * HL_STEP);
      if (!this.hlRange || this.hlRange[0] !== first || this.hlRange[1] !== last) {
        this.hlRange = [first, last];
        this.pre.innerHTML = this.hl.slice(first, last).join('\n') + '\n ';
      }
      this.pre.style.transform = `translate(${-l}px, ${first * lh - t}px)`;
      this.gutter.style.transform = `translateY(${-t}px)`;
      if (this.find) this.paintMarks();
    }

    selection() {
      const { selectionStart: a, selectionEnd: b, value } = this.ta;
      return a !== b ? value.slice(a, b) : '';
    }

    currentStatement() {
      return window.SqlSplit.statementAt(this.ta.value, this.ta.selectionStart, this.opts.dialect ? this.opts.dialect() : undefined);
    }

    insert(text) {
      // One undo step in this field's own history (see undo.js).
      this.inserting = true;
      try {
        if (!document.execCommand('insertText', false, text)) {
          this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
          this.ta.dispatchEvent(new Event('input'));
        }
      } finally {
        this.inserting = false;
      }
    }

    /** Ctrl+L: the statement at the cursor (or each statement in the selection) on a single line; one undo step. */
    oneLine() {
      const v = this.ta.value;
      let a = this.ta.selectionStart;
      let b = this.ta.selectionEnd;
      const whole = a === b;
      if (whole) {
        const st = this.currentStatement();
        if (!st) return;
        a = st.start; b = st.end;
      }
      const part = v.slice(a, b);
      const lead = part.match(/^\s*/)[0];
      const trail = part.slice(lead.length).match(/\s*$/)[0];
      const core = part.slice(lead.length, part.length - trail.length);
      if (!core) return;
      const flat = oneLinePerStatement(core, this.opts.dialect ? this.opts.dialect() : undefined);
      const gap = this.gapAfter(b - trail.length);
      const next = flat + gap.extra;
      if (next === core) return;
      const caret = this.ta.selectionStart;
      this.ta.setSelectionRange(a + lead.length, b - trail.length + gap.swallow);
      this.insert(next);
      if (whole) this.ta.setSelectionRange(Math.min(caret, a + lead.length + next.length), Math.min(caret, a + lead.length + next.length));
      else this.ta.setSelectionRange(a + lead.length, a + lead.length + next.length);
    }

    /** What to add after a query ending at `pos` so a blank line separates it from the text after it:
     *  { extra: text to put in place of `swallow` characters after pos }. Nothing when the next line is already
     *  empty or nothing follows. A comment on the query's last line (`select 1; -- note`) stays on that line. */
    gapAfter(pos) {
      const rest = this.ta.value.slice(pos);
      const none = { extra: '', swallow: 0 };
      if (!rest.trim()) return none;
      let sp = rest.match(/^[ \t\r]*/)[0].length;
      let keep = '';
      if (/^(--|\/\*)/.test(rest.slice(sp))) {
        const eol = rest.indexOf('\n');
        const line = rest.slice(0, eol < 0 ? rest.length : eol);
        if (eol < 0 || (line.trim().startsWith('/*') && !line.trim().endsWith('*/'))) return none;
        keep = line.replace(/\s+$/, '');
        sp = eol;
      }
      const r = rest.slice(sp);
      if (r[0] !== '\n') return { extra: keep + '\n\n', swallow: sp }; // next query on the same line
      const nextLine = r.slice(1).match(/^[^\n]*/)[0];
      return nextLine.trim() ? { extra: keep + '\n', swallow: sp } : none;
    }

    lineRange() {
      const v = this.ta.value;
      const a = v.lastIndexOf('\n', this.ta.selectionStart - 1) + 1;
      let b = v.indexOf('\n', Math.max(this.ta.selectionEnd - (this.ta.selectionEnd > this.ta.selectionStart && v[this.ta.selectionEnd - 1] === '\n' ? 1 : 0), this.ta.selectionStart));
      if (b < 0) b = v.length;
      return [a, b];
    }

    transformLines(fn) {
      const [a, b] = this.lineRange();
      const block = this.ta.value.slice(a, b);
      const next = fn(block.split('\n')).join('\n');
      this.ta.setSelectionRange(a, b);
      this.insert(next);
      this.ta.setSelectionRange(a, a + next.length);
    }

    onKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (this.ac) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = this.ac.items.length;
          this.ac.index = (this.ac.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
          this.paintAc();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.accept(); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.hideAc(); return; }
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); return; }
      if (e.key === 'F3' || (mod && !e.altKey && e.key.toLowerCase() === 'g')) { e.preventDefault(); this.findStep(e.shiftKey ? -1 : 1); return; }
      if (e.key === 'Escape' && this.find) { e.preventDefault(); e.stopPropagation(); this.closeFind(); return; }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) this.onRunAll && this.onRunAll();
        else this.onRun && this.onRun();
        return;
      }
      if (mod && e.key === ' ') { e.preventDefault(); this.suggest(true); return; }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') { e.preventDefault(); this.hideAc(); this.oneLine(); return; }
      if (mod && (e.key.toLowerCase() === 'b' || e.key.toLowerCase() === 'i' || (e.shiftKey && e.key.toLowerCase() === 'f'))) {
        e.preventDefault();
        this.onFormat && this.onFormat();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.shiftKey) this.onSaveFile && this.onSaveFile(); else this.onSave && this.onSave();
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        this.transformLines((lines) => {
          const all = lines.filter((l) => l.trim()).every((l) => /^\s*--/.test(l));
          return lines.map((l) => (all ? l.replace(/^(\s*)-- ?/, '$1') : l.trim() ? '-- ' + l : l));
        });
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const multi = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd).includes('\n');
        if (e.shiftKey) this.transformLines((ls) => ls.map((l) => l.replace(/^ {1,2}/, '')));
        else if (multi) this.transformLines((ls) => ls.map((l) => '  ' + l));
        else this.insert('  ');
        return;
      }
      if (e.key === 'Enter' && !mod) {
        e.preventDefault();
        const v = this.ta.value;
        const ls = v.lastIndexOf('\n', this.ta.selectionStart - 1) + 1;
        const indent = (v.slice(ls, this.ta.selectionStart).match(/^\s*/) || [''])[0];
        this.insert('\n' + indent);
      }
    }

    wordBefore() {
      const v = this.ta.value;
      const pos = this.ta.selectionStart;
      let a = pos;
      while (a > 0 && /[\w$#]/.test(v[a - 1])) a--;
      let qualifier = null;
      if (v[a - 1] === '.') {
        let q = a - 1;
        while (q > 0 && /[\w$#"]/.test(v[q - 1])) q--;
        qualifier = v.slice(q, a - 1).replace(/"/g, '');
      }
      return { word: v.slice(a, pos), start: a, end: pos, qualifier };
    }

    resolveAlias(alias) {
      const v = this.ta.value;
      const re = new RegExp(`\\b(?:from|join|update|into)\\s+((?:"?[\\w$#]+"?\\.)?"?[\\w$#]+"?)\\s+(?:as\\s+)?"?${alias.replace(/[$#]/g, '\\$&')}"?(?![\\w$#])`, 'i');
      const m = v.match(re);
      return (m ? m[1] : alias).replace(/"/g, '');
    }

    async suggest(force) {
      if (!this.completions) return;
      const ctx = this.wordBefore();
      if (!force && !ctx.qualifier && ctx.word.length < 2) { this.hideAc(); return; }
      const table = ctx.qualifier ? this.resolveAlias(ctx.qualifier) : null;
      const token = Symbol('ac');
      this.acToken = token;
      let items = await this.completions({ word: ctx.word, table });
      if (this.acToken !== token) return;
      const w = ctx.word.toUpperCase();
      const starts = items.filter((i) => i.label.toUpperCase().startsWith(w));
      const has = w ? items.filter((i) => !i.label.toUpperCase().startsWith(w) && i.label.toUpperCase().includes(w)) : [];
      items = starts.concat(has).slice(0, 60);
      if (!items.length || (items.length === 1 && items[0].label.toUpperCase() === w && !force)) { this.hideAc(); return; }
      this.ac = { items, index: 0, start: ctx.start, end: ctx.end };
      this.paintAc();
    }

    paintAc() {
      const { items, index } = this.ac;
      this.pop.innerHTML = '';
      items.forEach((it, i) => {
        const row = h('div', {
          class: 'ac-item' + (i === index ? ' sel' : ''),
          onmousedown: (e) => { e.preventDefault(); this.ac.index = i; this.accept(); },
        }, h('span', { class: 'ac-kind k-' + it.kind }, it.kind[0].toUpperCase()), h('span', { class: 'ac-label' }, it.label),
        it.detail ? h('span', { class: 'ac-detail' }, it.detail) : null);
        this.pop.append(row);
      });
      const coords = this.caret(this.ac.start);
      this.pop.style.left = Math.max(0, coords.x) + 'px';
      this.pop.style.top = coords.y + 'px';
      this.pop.classList.remove('hidden');
      const sel = this.pop.children[index];
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }

    caret(pos) {
      const before = this.ta.value.slice(0, pos).split('\n');
      const line = before.length - 1;
      const col = before[before.length - 1].length;
      const { charW, lh, pl, pt } = this.metrics();
      return { x: pl + col * charW - this.ta.scrollLeft, y: pt + (line + 1) * lh - this.ta.scrollTop + 2 };
    }

    accept() {
      if (!this.ac) return;
      const it = this.ac.items[this.ac.index];
      this.ta.setSelectionRange(this.ac.start, this.ta.selectionStart);
      this.hideAc();
      this.insert(it.insert || it.label);
    }

    hideAc() {
      this.ac = null;
      this.acToken = null;
      this.pop.classList.add('hidden');
    }
  }

  SqlEditor.KEYWORDS = KEYWORDS;
  SqlEditor.FUNCS = FUNCS;
  SqlEditor.highlight = highlight;
  window.SqlEditor = SqlEditor;
})();
