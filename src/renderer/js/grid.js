// Virtualized data grid with selection, inline editing and pending-change tracking.
(function () {
  const { h, icon, cellText, contextMenu, modal, toast } = window.U;
  const ROW_H = 26;
  const OVERSCAN = 12;
  const STEP = 10; // rows are rebuilt each time the view has scrolled this many rows, not on every row

  function initialWidth(col, rows, i) {
    let n = Math.max(col.name.length + 3, 6);
    const sample = Math.min(rows.length, 60);
    for (let r = 0; r < sample; r++) {
      const t = cellText(rows[r][i]);
      if (t.length > n) n = t.length;
    }
    return Math.round(Math.min(Math.max(n * 7.4 + 18, 70), 380));
  }

  class DataGrid {
    /**
     * opts: { columns, rows, rowids, editable, sort, onSort(col), onChange(), onSelect(rowIndex),
     *         onFilterValue(col, value), startIndex, sqlTarget (table name for Copy as SQL INSERT),
     *         keyColumns (primary key: left empty in a duplicated row) }
     */
    constructor(opts) {
      this.o = opts;
      this.columns = opts.columns;
      this.rows = opts.rows;
      this.rowids = opts.rowids || null;
      this.editable = !!opts.editable && !!this.rowids;
      this.widths = this.columns.map((c, i) => initialWidth(c, this.rows, i));
      this.sel = { r: -1, c: -1 };      // focused cell
      this.anchor = { r: -1, c: -1 };   // where the range started
      this.rowMode = false;
      this.extra = new Set();           // rows picked with Ctrl/Cmd-click
      this.edits = new Map();     // rowIndex -> { colIndex: value }
      this.deleted = new Set();   // rowIndex
      this.inserted = [];         // arrays of values
      this.undoStack = [];        // snapshots of pending changes, for Ctrl+Z
      this.redoStack = [];
      this.localSort = null;
      this.order = this.rows.map((_, i) => i);

      this.colgroup = h('colgroup');
      this.thead = h('thead');
      this.tbody = h('tbody');
      this.table = h('table', { class: 'grid' }, this.colgroup, this.thead, this.tbody);
      this.el = h('div', { class: 'grid-wrap', tabindex: '0' }, this.table);
      this.el.addEventListener('scroll', () => this.paint());
      this.el.addEventListener('keydown', (e) => this.onKey(e));
      // One delegated listener per event: rows are re-rendered while scrolling.
      this.tbody.addEventListener('mousedown', (e) => this.onMouseDown(e));
      this.tbody.addEventListener('dblclick', (e) => { const p = this.hit(e.target); if (p && !p.gutter) this.edit(p.vi, p.c); });
      this.tbody.addEventListener('contextmenu', (e) => { const p = this.hit(e.target); if (p) this.menu(e, p.vi, p.gutter ? Math.max(0, this.sel.c) : p.c); });
      this.ro = new ResizeObserver(() => this.paint());
      this.ro.observe(this.el);
      this.renderHead();
      this.paint();
    }

    destroy() { this.ro.disconnect(); }

    get total() { return this.order.length + this.inserted.length; }

    rowAt(vi) {
      // vi = visual index -> { data, index (into rows or -1-insertIdx) }
      if (vi < this.order.length) { const i = this.order[vi]; return { data: this.rows[i], index: i }; }
      const k = vi - this.order.length;
      return { data: this.inserted[k], index: -1 - k };
    }

    value(index, c) {
      if (index < 0) return this.inserted[-1 - index][c];
      const e = this.edits.get(index);
      if (e && c in e) return e[c];
      return this.rows[index][c];
    }

    renderHead() {
      this.colgroup.innerHTML = '';
      this.colgroup.append(h('col', { style: { width: '48px' } }));
      this.widths.forEach((w) => this.colgroup.append(h('col', { style: { width: w + 'px' } })));
      const sort = this.o.sort || this.localSort;
      const tr = h('tr', null, h('th', { class: 'rn' }, ''));
      this.columns.forEach((col, i) => {
        const dir = sort && sort.col === col.name ? sort.dir : null;
        const th = h('th', {
          title: `${col.name}  ${col.fullType || col.type || ''}${col.nullable === false ? '  NOT NULL' : ''}`,
          class: col.kind === 'number' ? 'num' : '',
          onclick: (e) => { if (!e.target.classList.contains('rz')) this.sortBy(col.name); },
        },
        h('div', { class: 'th-in' },
          h('span', { class: 'th-name' }, col.name),
          h('span', { class: 'th-type' }, (col.fullType || col.type || '').toLowerCase()),
          dir ? h('span', { class: 'th-sort' }, dir === 'asc' ? '▲' : '▼') : null),
        h('span', { class: 'rz', onmousedown: (e) => this.startResize(e, i) }));
        tr.append(th);
      });
      this.thead.innerHTML = '';
      this.thead.append(tr);
      this.table.style.width = 48 + this.widths.reduce((a, b) => a + b, 0) + 'px';
    }

    startResize(e, i) {
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX;
      const w0 = this.widths[i];
      const move = (ev) => {
        this.widths[i] = Math.max(48, w0 + ev.clientX - x0);
        this.colgroup.children[i + 1].style.width = this.widths[i] + 'px';
        this.table.style.width = 48 + this.widths.reduce((a, b) => a + b, 0) + 'px';
      };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    }

    sortBy(name) {
      if (this.o.onSort) { this.o.onSort(name); return; }
      const ci = this.columns.findIndex((c) => c.name === name);
      const dir = this.localSort && this.localSort.col === name && this.localSort.dir === 'asc' ? 'desc' : 'asc';
      this.localSort = { col: name, dir };
      const isNum = this.columns[ci].kind === 'number';
      this.order.sort((a, b) => {
        const x = this.rows[a][ci];
        const y = this.rows[b][ci];
        if (x === null) return 1;
        if (y === null) return -1;
        const r = isNum ? Number(x) - Number(y) : String(x).localeCompare(String(y));
        return dir === 'asc' ? r : -r;
      });
      this.renderHead();
      this.paint();
    }

    paint() {
      const top = this.el.scrollTop;
      const vh = this.el.clientHeight || 600;
      const n = this.total;
      const first = Math.max(0, Math.floor((top / ROW_H - OVERSCAN) / STEP) * STEP);
      const last = Math.min(n, Math.ceil(((top + vh) / ROW_H + OVERSCAN) / STEP) * STEP);
      const old = this.painted;
      if (old && old[0] === first && old[1] === last && !this.dirty) return;
      this.painted = [first, last];
      const kids = this.tbody.children;
      // Scrolled a little: keep the rows still in range and only add / remove at the ends.
      if (old && !this.dirty && first < old[1] && last > old[0] && kids.length === old[1] - old[0] + 2) {
        const [topSpacer, bottomSpacer] = [kids[0], kids[kids.length - 1]];
        for (let vi = old[0]; vi < first; vi++) topSpacer.nextSibling.remove();
        for (let vi = old[1]; vi > last; vi--) bottomSpacer.previousSibling.remove();
        if (first < old[0]) {
          const frag = document.createDocumentFragment();
          for (let vi = first; vi < old[0]; vi++) frag.append(this.buildRow(vi));
          topSpacer.after(frag);
        }
        if (last > old[1]) {
          const frag = document.createDocumentFragment();
          for (let vi = old[1]; vi < last; vi++) frag.append(this.buildRow(vi));
          bottomSpacer.before(frag);
        }
        topSpacer.style.height = first * ROW_H + 'px';
        bottomSpacer.style.height = (n - last) * ROW_H + 'px';
        return;
      }
      this.dirty = false;
      const frag = document.createDocumentFragment();
      frag.append(h('tr', { class: 'spacer', style: { height: first * ROW_H + 'px' } }));
      for (let vi = first; vi < last; vi++) frag.append(this.buildRow(vi));
      frag.append(h('tr', { class: 'spacer', style: { height: (n - last) * ROW_H + 'px' } }));
      this.tbody.innerHTML = '';
      this.tbody.append(frag);
    }

    buildRow(vi) {
      const startNo = this.o.startIndex || 0;
      const { data, index } = this.rowAt(vi);
      const edits = index >= 0 ? this.edits.get(index) : null;
      const cls = ['r'];
      if (index < 0) cls.push('ins');
      if (this.deleted.has(index)) cls.push('del');
      if (this.isRowSelected(vi)) cls.push('sel');
      if (this.isFullRow(vi)) cls.push('full');
      const tr = h('tr', { class: cls.join(' '), 'data-vi': vi });
      tr.append(h('td', { class: 'rn' }, index < 0 ? '+' : startNo + vi + 1));
      for (let c = 0; c < this.columns.length; c++) {
        const v = edits && c in edits ? edits[c] : data[c];
        const tdc = [];
        if (v === null || v === undefined) tdc.push('null');
        if (this.columns[c].kind === 'number') tdc.push('num');
        if (edits && c in edits) tdc.push('edited');
        if (this.isCellSelected(vi, c)) tdc.push('in-sel');
        if (this.sel.r === vi && this.sel.c === c) tdc.push('cur');
        const t = cellText(v);
        tr.append(h('td', { class: tdc.join(' '), 'data-c': c }, t.length > 400 ? t.slice(0, 400) + '…' : t));
      }
      return tr;
    }

    refresh() { this.dirty = true; this.paint(); }

    // ---------- Selection model ----------
    // A rectangle from `anchor` to `sel` (the focused cell), plus rows toggled with Ctrl/Cmd.
    // `rowMode` means the rectangle spans every column (started from the row-number gutter).

    rangeRows() {
      if (this.sel.r < 0) return [1, 0];
      return [Math.min(this.anchor.r, this.sel.r), Math.max(this.anchor.r, this.sel.r)];
    }
    rangeCols() {
      if (this.rowMode) return [0, this.columns.length - 1];
      return [Math.min(this.anchor.c, this.sel.c), Math.max(this.anchor.c, this.sel.c)];
    }
    isFullRow(vi) {
      const [a, b] = this.rangeRows();
      return this.extra.has(vi) || (this.rowMode && vi >= a && vi <= b);
    }
    isRowSelected(vi) {
      const [a, b] = this.rangeRows();
      return this.extra.has(vi) || (vi >= a && vi <= b);
    }
    isCellSelected(vi, c) {
      if (this.extra.has(vi)) return true;
      const [a, b] = this.rangeRows();
      const [x, y] = this.rangeCols();
      return vi >= a && vi <= b && c >= x && c <= y && !(a === b && x === y);
    }

    /** Visual rows covered by the selection (range + Ctrl-toggled rows). */
    selectedVisualRows() {
      const s = new Set(this.extra);
      const [a, b] = this.rangeRows();
      for (let i = a; i <= b; i++) s.add(i);
      return [...s].filter((i) => i >= 0 && i < this.total).sort((x, y) => x - y);
    }

    /** Rows explicitly selected as rows: more than one row, a gutter selection, or Ctrl-picked rows. */
    get selRows() {
      const rows = this.selectedVisualRows();
      return new Set(rows.length > 1 || this.rowMode || this.extra.size ? rows : []);
    }

    setSelection(anchor, focus, { rowMode = false, keepExtra = false } = {}) {
      this.anchor = { ...anchor };
      this.sel = { ...focus };
      this.rowMode = rowMode;
      if (!keepExtra) this.extra.clear();
      this.updateSel();
      this.emitSelect();
    }

    clearSelection() {
      this.anchor = { r: -1, c: -1 };
      this.sel = { r: -1, c: -1 };
      this.rowMode = false;
      this.extra.clear();
      this.updateSel();
    }

    selectAll() {
      if (!this.total) return;
      this.setSelection({ r: 0, c: 0 }, { r: this.total - 1, c: this.columns.length - 1 }, { rowMode: true });
    }

    // Updates selection classes in place (re-rendering would break double-click).
    updateSel() {
      for (const tr of this.tbody.children) {
        if (!tr.dataset.vi) continue;
        const vi = Number(tr.dataset.vi);
        tr.classList.toggle('sel', this.isRowSelected(vi));
        tr.classList.toggle('full', this.isFullRow(vi));
        for (const td of tr.children) {
          if (td.dataset.c === undefined) continue;
          const c = Number(td.dataset.c);
          td.classList.toggle('in-sel', this.isCellSelected(vi, c));
          td.classList.toggle('cur', this.sel.r === vi && this.sel.c === c);
        }
      }
    }

    hit(target) {
      const td = target && target.closest && target.closest('td');
      const tr = td && td.parentNode;
      if (!td || !tr || tr.dataset.vi === undefined || !this.tbody.contains(tr)) return null;
      return { vi: Number(tr.dataset.vi), c: td.dataset.c === undefined ? -1 : Number(td.dataset.c), gutter: td.classList.contains('rn') };
    }

    onMouseDown(e) {
      const p = this.hit(e.target);
      if (!p) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.button === 2) {
        // Right-click inside the selection keeps it; otherwise select what was clicked.
        const inside = p.gutter ? this.isRowSelected(p.vi) : this.isCellSelected(p.vi, p.c) || (this.sel.r === p.vi && this.sel.c === p.c);
        if (!inside) {
          if (p.gutter) this.setSelection({ r: p.vi, c: 0 }, { r: p.vi, c: this.columns.length - 1 }, { rowMode: true });
          else this.setSelection({ r: p.vi, c: p.c }, { r: p.vi, c: p.c });
        }
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault(); // no text selection while dragging
      this.el.focus({ preventScroll: true });
      const c = p.gutter ? Math.max(0, this.sel.c) : p.c;
      if (e.shiftKey && this.sel.r >= 0) {
        // Extend from the anchor to here.
        const rowMode = p.gutter || this.rowMode;
        this.setSelection(this.anchor.r >= 0 ? this.anchor : this.sel, { r: p.vi, c: rowMode ? this.columns.length - 1 : c }, { rowMode, keepExtra: true });
      } else if (mod) {
        // Ctrl/Cmd-click toggles whole rows; the current selection becomes part of the set.
        this.selectedVisualRows().forEach((r) => this.extra.add(r));
        const was = this.extra.has(p.vi);
        if (was) this.extra.delete(p.vi); else this.extra.add(p.vi);
        this.rowMode = false;
        if (!was) this.sel = { r: p.vi, c };
        else { const rest = [...this.extra]; this.sel = rest.length ? { r: rest[rest.length - 1], c } : { r: -1, c: -1 }; }
        this.anchor = { ...this.sel };
        this.updateSel();
        this.emitSelect();
        return;
      } else if (p.gutter) {
        this.setSelection({ r: p.vi, c: 0 }, { r: p.vi, c: this.columns.length - 1 }, { rowMode: true });
      } else {
        this.setSelection({ r: p.vi, c }, { r: p.vi, c });
      }
      this.startDrag(e, p.gutter || this.rowMode);
    }

    startDrag(e0, rowMode) {
      const wrap = this.el;
      let lastX = e0.clientX;
      let lastY = e0.clientY;
      let raf = 0;
      const headH = () => this.thead.offsetHeight || 30;
      const update = () => {
        const r = wrap.getBoundingClientRect();
        // Clamp inside the grid so dragging past an edge still picks the edge cell.
        const x = Math.min(Math.max(lastX, r.left + 50), r.right - 14);
        const y = Math.min(Math.max(lastY, r.top + headH() + 2), r.bottom - 14);
        const p = this.hit(document.elementFromPoint(x, y));
        if (!p) return;
        const c = rowMode ? this.columns.length - 1 : p.gutter ? 0 : p.c;
        if (p.vi !== this.sel.r || c !== this.sel.c) {
          this.sel = { r: p.vi, c };
          this.updateSel();
          this.emitSelect();
        }
      };
      const tick = () => {
        // Auto-scroll while the pointer is past the top/bottom (or sides) of the grid.
        const r = wrap.getBoundingClientRect();
        const top = r.top + headH();
        let dy = 0;
        let dx = 0;
        if (lastY < top) dy = -Math.min(40, (top - lastY) / 2 + 4);
        else if (lastY > r.bottom) dy = Math.min(40, (lastY - r.bottom) / 2 + 4);
        if (!rowMode) {
          if (lastX < r.left + 48) dx = -Math.min(40, (r.left + 48 - lastX) / 2 + 4);
          else if (lastX > r.right) dx = Math.min(40, (lastX - r.right) / 2 + 4);
        }
        if (dy || dx) {
          wrap.scrollTop += dy;
          wrap.scrollLeft += dx;
          this.paint();
          update();
        }
        raf = requestAnimationFrame(tick);
      };
      const move = (ev) => { lastX = ev.clientX; lastY = ev.clientY; update(); };
      const up = () => {
        cancelAnimationFrame(raf);
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
      raf = requestAnimationFrame(tick);
    }

    emitSelect() {
      if (!this.o.onSelect) return;
      if (this.sel.r < 0 || this.sel.r >= this.total) { this.o.onSelect(null); return; }
      this.o.onSelect(this.rowAt(this.sel.r).index);
    }

    scrollToRow(vi) {
      const y = vi * ROW_H;
      const headH = this.thead.offsetHeight || ROW_H;
      if (y < this.el.scrollTop) this.el.scrollTop = y;
      else if (y + ROW_H > this.el.scrollTop + this.el.clientHeight - headH) this.el.scrollTop = y + ROW_H - this.el.clientHeight + headH;
    }

    scrollToCol(c) {
      let x = 48;
      for (let i = 0; i < c; i++) x += this.widths[i];
      const w = this.widths[c] || 0;
      if (x - 48 < this.el.scrollLeft) this.el.scrollLeft = x - 48;
      else if (x + w > this.el.scrollLeft + this.el.clientWidth) this.el.scrollLeft = x + w - this.el.clientWidth;
    }

    onKey(e) {
      if (e.target !== this.el) return;
      const mod = e.ctrlKey || e.metaKey;
      const { r, c } = this.sel;
      const move = (dr, dc) => {
        e.preventDefault();
        if (!this.total) return;
        const nr = Math.min(Math.max(0, (r < 0 ? 0 : r) + dr), this.total - 1);
        const nc = Math.min(Math.max(0, (c < 0 ? 0 : c) + dc), this.columns.length - 1);
        if (e.shiftKey && e.key !== 'Tab' && r >= 0) {
          this.sel = { r: nr, c: nc };
          this.extra.clear();
          this.updateSel();
          this.emitSelect();
        } else {
          this.setSelection({ r: nr, c: nc }, { r: nr, c: nc });
        }
        this.scrollToRow(nr);
        this.scrollToCol(nc);
        this.paint();
        this.updateSel();
      };
      if (e.key === 'ArrowDown') return move(mod ? this.total : 1, 0);
      if (e.key === 'ArrowUp') return move(mod ? -this.total : -1, 0);
      if (e.key === 'ArrowLeft') return move(0, mod ? -this.columns.length : -1);
      if (e.key === 'ArrowRight') return move(0, mod ? this.columns.length : 1);
      if (e.key === 'Tab') return move(0, e.shiftKey ? -1 : 1);
      if (e.key === 'PageDown') return move(20, 0);
      if (e.key === 'PageUp') return move(-20, 0);
      if (e.key === 'Home') return move(0, -this.columns.length);
      if (e.key === 'End') return move(0, this.columns.length);
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); return; }
      if (e.key === 'Escape' && (this.selRows.size || this.isMulti())) { e.preventDefault(); this.setSelection(this.sel, this.sel); return; }
      if (r < 0) return;
      if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); this.edit(r, c); return; }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        this.copySelection(e.shiftKey);
        return;
      }
      if (mod && e.key.toLowerCase() === 'd' && this.editable) { e.preventDefault(); this.duplicateRow(r); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.editable) {
        e.preventDefault();
        this.deleteRows(this.selectedVisualRows()); // works for one row (focused cell) or many
      }
    }

    isMulti() {
      const [a, b] = this.rangeRows();
      const [x, y] = this.rangeCols();
      return this.extra.size > 0 || a !== b || x !== y;
    }

    /** Copies the selection as tab-separated text (pastes into Excel as cells). */
    copySelection(withHeader = false) {
      if (this.sel.r < 0) return;
      if (!this.isMulti()) { window.api.copy(cellText(this.value(this.rowAt(this.sel.r).index, this.sel.c))); return; }
      const rows = this.selectedVisualRows();
      let [x, y] = this.rangeCols();
      if (this.extra.size || this.rowMode) { x = 0; y = this.columns.length - 1; }
      const lines = [];
      if (withHeader) lines.push(this.columns.slice(x, y + 1).map((col) => col.name).join('\t'));
      for (const vi of rows) {
        const { index } = this.rowAt(vi);
        const cells = [];
        for (let col = x; col <= y; col++) {
          const v = this.value(index, col);
          cells.push(v === null ? '' : cellText(v).replace(/[\t\n\r]/g, ' '));
        }
        lines.push(cells.join('\t'));
      }
      window.api.copy(lines.join('\n'));
    }

    copyRows(vis, withHeader = true) {
      const lines = [];
      if (withHeader) lines.push(this.columns.map((c) => c.name).join('\t'));
      for (const vi of vis) {
        const { index } = this.rowAt(vi);
        lines.push(this.columns.map((_, c) => {
          const v = this.value(index, c);
          return v === null ? '' : cellText(v).replace(/[\t\n\r]/g, ' ');
        }).join('\t'));
      }
      window.api.copy(lines.join('\n'));
    }

    /** Copies the selected rows, with every column, as INSERT statements into o.sqlTarget. */
    async copySql() {
      if (this.sel.r < 0 || !this.o.sqlTarget) return;
      const cols = this.columns.map((c) => ({ name: c.name, type: c.type }));
      const vis = this.selectedVisualRows();
      const rows = vis.map((vi) => { const { index } = this.rowAt(vi); return cols.map((_, c) => this.value(index, c)); });
      try {
        await window.api.copy(await window.api.sqlInserts(this.o.sqlTarget, cols, rows));
        toast(`Copied ${vis.length} INSERT statement${vis.length === 1 ? '' : 's'}`, 'ok', 1800);
      } catch (e) { toast(e.message, 'err', 5000); }
    }

    edit(vi, c) {
      if (!this.editable || vi < 0) return;
      const { index } = this.rowAt(vi);
      if (this.deleted.has(index)) return;
      const cur = this.value(index, c);
      if (cur && typeof cur === 'object') return; // binary preview: edit via SQL
      const text = cur === null ? '' : String(cur);
      if (text.length > 120 || text.includes('\n')) { this.editLong(index, c, text); return; }
      const row = this.tbody.querySelector(`tr[data-vi="${vi}"]`);
      const td = row && row.querySelector(`td[data-c="${c}"]`);
      if (!td) return;
      const input = h('input', { class: 'cell-edit', spellcheck: 'false' });
      input.value = text;
      const rect = td.getBoundingClientRect();
      const wrap = this.el.getBoundingClientRect();
      Object.assign(input.style, {
        left: rect.left - wrap.left + this.el.scrollLeft + 'px',
        top: rect.top - wrap.top + this.el.scrollTop + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      });
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        if (save && input.value !== text) this.setValue(index, c, input.value === '' && cur === null ? null : input.value);
        input.remove();
        this.el.focus();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        else if (e.key === 'Tab') { e.preventDefault(); finish(true); const nc = Math.min(c + 1, this.columns.length - 1); this.setSelection({ r: vi, c: nc }, { r: vi, c: nc }); }
      });
      input.addEventListener('blur', () => finish(true));
      this.el.append(input);
      input.focus();
      input.select();
    }

    editLong(index, c, text) {
      const ta = h('textarea', { class: 'long-edit', spellcheck: 'false' });
      ta.value = text;
      modal({
        title: `Edit ${this.columns[c].name}`,
        wide: true,
        body: ta,
        actions: [
          { label: 'Set NULL', onClick: () => this.setValue(index, c, null) },
          { label: 'Cancel' },
          { label: 'Apply', kind: 'primary', onClick: () => { if (ta.value !== text) this.setValue(index, c, ta.value); } },
        ],
      });
    }

    // ---------- Undo / redo of pending (uncommitted) changes ----------
    snapshot() {
      return {
        edits: new Map([...this.edits].map(([k, v]) => [k, { ...v }])),
        deleted: new Set(this.deleted),
        inserted: this.inserted.map((r) => [...r]),
        sel: { ...this.sel },
      };
    }
    restore(snap) {
      this.edits = new Map([...snap.edits].map(([k, v]) => [k, { ...v }]));
      this.deleted = new Set(snap.deleted);
      this.inserted = snap.inserted.map((r) => [...r]);
      const r = Math.min(snap.sel.r, this.total - 1);
      if (r >= 0) { this.anchor = { r, c: snap.sel.c }; this.sel = { r, c: snap.sel.c }; } else this.clearSelection();
      this.rowMode = false;
      this.extra.clear();
      this.refresh();
      if (r >= 0) this.scrollToRow(r);
      this.changed();
      this.emitSelect();
    }
    record(label) {
      this.undoStack.push({ label, snap: this.snapshot() });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
    undo() {
      const step = this.undoStack.pop();
      if (!step) return null;
      this.redoStack.push({ label: step.label, snap: this.snapshot() });
      this.restore(step.snap);
      return step.label;
    }
    redo() {
      const step = this.redoStack.pop();
      if (!step) return null;
      this.undoStack.push({ label: step.label, snap: this.snapshot() });
      this.restore(step.snap);
      return step.label;
    }

    setValue(index, c, v) {
      this.record(v === null ? 'set NULL' : `edit ${this.columns[c].name}`);
      if (index < 0) {
        this.inserted[-1 - index][c] = v;
      } else {
        const orig = this.rows[index][c];
        const e = this.edits.get(index) || {};
        if (v === orig || (v !== null && orig !== null && String(v) === String(orig))) delete e[c];
        else e[c] = v;
        if (Object.keys(e).length) this.edits.set(index, e); else this.edits.delete(index);
      }
      this.refresh();
      this.changed();
    }

    addRow() {
      if (!this.editable) return;
      this.insertRow(this.columns.map(() => null), 'add row', 0);
    }

    /** Adds a pending copy of row vi to edit before saving. The primary key is left empty (the copy
     *  needs its own; an auto-generated one is filled in by the database), as is a binary the grid only
     *  read part of. The first key column (else the first column) opens for editing. */
    duplicateRow(vi) {
      if (!this.editable || vi < 0 || vi >= this.total) return;
      const { index } = this.rowAt(vi);
      const keys = new Set(this.o.keyColumns || []);
      let partial = 0;
      const values = this.columns.map((col, c) => {
        const v = this.value(index, c);
        if (keys.has(col.name)) return null;
        if (v && typeof v === 'object' && v.$bin !== undefined && v.$bin.length / 2 < v.len) { partial++; return null; }
        return v;
      });
      this.insertRow(values, 'duplicate row', Math.max(0, this.columns.findIndex((col) => keys.has(col.name))));
      if (partial) toast(`${partial} binary value${partial === 1 ? ' was' : 's were'} too large to copy here and ${partial === 1 ? 'was' : 'were'} left empty`, 'info', 4000);
    }

    insertRow(values, label, editCol) {
      this.record(label);
      this.inserted.push(values);
      const vi = this.total - 1;
      this.anchor = { r: vi, c: editCol };
      this.sel = { r: vi, c: editCol };
      this.rowMode = false;
      this.extra.clear();
      this.refresh();
      this.el.scrollTop = this.el.scrollHeight;
      this.changed();
      this.emitSelect();
      setTimeout(() => this.edit(vi, editCol), 30);
    }

    deleteRows(vis) {
      if (!this.editable || !vis.length) return;
      const alreadyAll = vis.every((vi) => { const { index } = this.rowAt(vi); return index >= 0 && this.deleted.has(index); });
      this.record(alreadyAll ? `restore ${vis.length} row${vis.length === 1 ? '' : 's'}` : `delete ${vis.length} row${vis.length === 1 ? '' : 's'}`);
      const insToRemove = [];
      for (const vi of vis) {
        const { index } = this.rowAt(vi);
        if (index < 0) insToRemove.push(-1 - index);
        else if (this.deleted.has(index)) this.deleted.delete(index);
        else this.deleted.add(index);
      }
      insToRemove.sort((a, b) => b - a).forEach((k) => this.inserted.splice(k, 1));
      this.extra.clear();
      this.rowMode = false;
      if (this.sel.r >= this.total) this.sel.r = this.total - 1;
      this.anchor = { ...this.sel };
      this.refresh();
      this.changed();
    }

    changeCount() {
      let n = this.deleted.size + this.inserted.length;
      for (const [i] of this.edits) if (!this.deleted.has(i)) n++;
      return n;
    }

    getChanges() {
      const name = (c) => this.columns[c].name;
      const updates = [];
      for (const [i, e] of this.edits) {
        if (this.deleted.has(i)) continue;
        const values = {};
        for (const c of Object.keys(e)) values[name(c)] = e[c];
        updates.push({ rowid: this.rowids[i], values });
      }
      const inserts = this.inserted.map((r) => {
        const values = {};
        r.forEach((v, c) => { if (v !== null) values[name(c)] = v; });
        return { values };
      }).filter((x) => Object.keys(x.values).length);
      const deletes = [...this.deleted].map((i) => ({ rowid: this.rowids[i] }));
      return { updates, inserts, deletes };
    }

    discard() {
      if (this.changeCount()) this.record('discard changes');
      this.edits.clear();
      this.deleted.clear();
      this.inserted = [];
      this.refresh();
      this.changed();
    }

    changed() { this.o.onChange && this.o.onChange(this.changeCount()); }

    menu(e, vi, c) {
      e.preventDefault();
      if (this.sel.r < 0) this.setSelection({ r: vi, c }, { r: vi, c });
      const { index } = this.rowAt(vi);
      const v = this.value(index, c);
      const col = this.columns[c];
      const items = [
        this.isMulti()
          ? { label: 'Copy selection', icon: 'copy', hint: 'Ctrl+C', onClick: () => this.copySelection(false) }
          : { label: 'Copy value', icon: 'copy', hint: 'Ctrl+C', onClick: () => window.api.copy(cellText(v)) },
        this.isMulti() ? { label: 'Copy selection with headers', hint: 'Ctrl+Shift+C', onClick: () => this.copySelection(true) } : null,
        { label: 'Copy row(s) with headers', icon: 'columns', onClick: () => this.copyRows(this.selectedVisualRows()) },
        this.o.sqlTarget ? { label: 'Copy as SQL INSERT', icon: 'code', onClick: () => this.copySql() } : null,
        { label: 'Copy column name', onClick: () => window.api.copy(col.name) },
      ];
      if (this.o.onFilterValue && index >= 0) {
        items.push('-', { label: `Filter ${col.name} = this value`, icon: 'filter', onClick: () => this.o.onFilterValue(col.name, v) });
      }
      if (this.editable) {
        items.push('-',
          { label: 'Edit cell', icon: 'edit', hint: 'Enter', onClick: () => this.edit(vi, c) },
          { label: 'Edit in larger editor', onClick: () => this.editLong(index, c, v === null ? '' : String(v)), disabled: v && typeof v === 'object' },
          { label: 'Set NULL', onClick: () => this.setValue(index, c, null) },
          '-',
          { label: 'Duplicate row', icon: 'copy', hint: 'Ctrl+D', onClick: () => this.duplicateRow(vi) },
          // Undo / Redo are Ctrl+Z / Ctrl+Shift+Z only, not in this menu.
          { label: this.deleted.has(index) ? 'Restore row' : 'Delete row(s)', icon: 'trash', danger: !this.deleted.has(index), hint: 'Del', onClick: () => this.deleteRows(this.selectedVisualRows()) });
      }
      contextMenu(e.clientX, e.clientY, items.filter(Boolean));
    }
  }

  window.DataGrid = DataGrid;
})();
