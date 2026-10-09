// Lightweight SQL editor: a textarea over a syntax-highlighted <pre>,
// with line numbers, current-statement marker, indentation and autocomplete.
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

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function highlight(text) {
    let out = '';
    let last = 0;
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(text))) {
      out += esc(text.slice(last, m.index));
      const s = esc(m[0]);
      if (m[1]) out += `<span class="t-com">${s}</span>`;
      else if (m[2]) out += `<span class="t-str">${s}</span>`;
      else if (m[3]) out += `<span class="t-id">${s}</span>`;
      else if (m[4]) out += `<span class="t-num">${s}</span>`;
      else if (m[5]) out += `<span class="t-bind">${s}</span>`;
      else {
        const up = m[0].toUpperCase();
        if (KEYWORDS.has(up)) out += `<span class="t-kw">${s}</span>`;
        else if (FUNCS.has(up)) out += `<span class="t-fn">${s}</span>`;
        else out += s;
      }
      last = TOKEN.lastIndex;
    }
    return out + esc(text.slice(last)) + '\n ';
  }

  class SqlEditor {
    constructor({ value = '', onChange, onRun, onRunAll, onSave, onSaveFile, onFormat, completions }) {
      this.onSaveFile = onSaveFile;
      this.onFormat = onFormat;
      this.onChange = onChange;
      this.onRun = onRun;
      this.onRunAll = onRunAll;
      this.onSave = onSave;
      this.completions = completions;
      this.gutter = h('div', { class: 'ed-gutter' });
      this.pre = h('pre', { class: 'ed-hl', 'aria-hidden': 'true' });
      this.ta = h('textarea', { class: 'ed-input', spellcheck: 'false', wrap: 'off', autocapitalize: 'off', autocomplete: 'off' });
      this.ta.value = value;
      this.pop = h('div', { class: 'ac hidden' });
      this.code = h('div', { class: 'ed-code' }, this.pre, this.ta, this.pop);
      this.el = h('div', { class: 'editor' }, this.gutter, this.code);
      this.lines = 0;
      this.ac = null;

      this.ta.addEventListener('input', (e) => {
        this.render();
        this.onChange && this.onChange(this.ta.value);
        if (this.inserting) return;
        if (e.inputType === 'insertText' && e.data && /[\w$#.]/.test(e.data)) this.suggest(false);
        else if (e.inputType && e.inputType.startsWith('delete') && this.ac) this.suggest(false);
        else this.hideAc();
      });
      this.ta.addEventListener('scroll', () => this.sync());
      this.ta.addEventListener('keydown', (e) => this.onKey(e));
      this.ta.addEventListener('blur', () => setTimeout(() => this.hideAc(), 120));
      const mark = window.U.debounce(() => this.markStatement(), 80);
      this.ta.addEventListener('keyup', mark);
      this.ta.addEventListener('mouseup', mark);
      this.ta.addEventListener('focus', mark);
      this.render();
    }

    get value() { return this.ta.value; }
    set value(v) { this.ta.value = v; this.render(); }
    focus() { this.ta.focus(); }

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
      this.pre.innerHTML = highlight(this.ta.value);
      const n = this.ta.value.split('\n').length;
      if (n !== this.lines) {
        this.lines = n;
        let s = '';
        for (let i = 1; i <= n; i++) s += `<div>${i}</div>`;
        this.gutter.innerHTML = s;
        this.markStatement();
      }
      this.sync();
    }

    sync() {
      const { scrollTop: t, scrollLeft: l } = this.ta;
      this.pre.style.transform = `translate(${-l}px, ${-t}px)`;
      this.gutter.style.transform = `translateY(${-t}px)`;
    }

    selection() {
      const { selectionStart: a, selectionEnd: b, value } = this.ta;
      return a !== b ? value.slice(a, b) : '';
    }

    currentStatement() {
      return window.SqlSplit.statementAt(this.ta.value, this.ta.selectionStart);
    }

    markStatement() {
      const kids = this.gutter.children;
      for (const k of kids) k.classList.remove('cur');
      if (this.selection()) return;
      const st = this.currentStatement();
      if (!st) return;
      const v = this.ta.value;
      const a = v.slice(0, st.start).split('\n').length - 1;
      const b = v.slice(0, Math.max(st.start, st.end - 1)).split('\n').length - 1;
      for (let i = a; i <= b && i < kids.length; i++) kids[i].classList.add('cur');
    }

    insert(text) {
      // execCommand keeps the native undo stack intact.
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
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) this.onRunAll && this.onRunAll();
        else this.onRun && this.onRun();
        return;
      }
      if (mod && e.key === ' ') { e.preventDefault(); this.suggest(true); return; }
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
      const cs = getComputedStyle(this.ta);
      if (!this.charW) {
        const probe = h('span', { style: { font: cs.font, position: 'absolute', visibility: 'hidden', whiteSpace: 'pre' } }, 'M'.repeat(50));
        document.body.append(probe);
        this.charW = probe.getBoundingClientRect().width / 50;
        probe.remove();
      }
      const lh = parseFloat(cs.lineHeight) || 20;
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pt = parseFloat(cs.paddingTop) || 0;
      return { x: pl + col * this.charW - this.ta.scrollLeft, y: pt + (line + 1) * lh - this.ta.scrollTop + 2 };
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
