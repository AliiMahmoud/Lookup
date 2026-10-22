// Export dialog: format, row scope, columns and per-format options, then a progress view.
(function () {
  const { h, icon, modal, fmtNum, toast } = window.U;
  const api = window.api;

  const FORMATS = [
    ['csv', 'CSV'],
    ['xlsx', 'Excel'],
    ['json', 'JSON'],
    ['sql', 'SQL INSERT'],
  ];

  const remembered = { format: 'csv', delimiter: ',', header: true, nullAs: '', jsonStyle: 'array', commitEvery: 1000, includeDdl: false };

  /**
   * ctx = {
   *   title, columns: [{name, type}],
   *   owner, name, type,                 // when exporting a table
   *   page: { rows, label },             // rows already loaded
   *   selected: rows | null,             // selected rows (optional)
   *   all: { source: 'table', filters, sort, total } | { source: 'query', sql, loaded, truncated } | null,
   *   target: 'default INSERT target',
   * }
   */
  function openExport(ctx) {
    const st = {
      format: remembered.format,
      scope: ctx.selected && ctx.selected.length ? 'selected' : ctx.all ? 'all' : 'page',
      cols: new Set(ctx.columns.map((_, i) => i)),
      delimiter: remembered.delimiter,
      header: remembered.header,
      nullAs: remembered.nullAs,
      jsonStyle: remembered.jsonStyle,
      commitEvery: remembered.commitEvery,
      includeDdl: remembered.includeDdl,
      target: ctx.target || ctx.title,
    };

    const body = h('div', { class: 'xp' });
    let m;

    const radio = (name, value, label, sub, checked, onchange) => {
      const input = h('input', { type: 'radio', name, value, onchange });
      input.checked = checked;
      return h('label', { class: 'xp-radio' }, input, h('span', null, label, sub ? h('span', { class: 'muted' }, '  ' + sub) : null));
    };
    const check = (label, value, onchange) => {
      const input = h('input', { type: 'checkbox', onchange: (e) => onchange(e.target.checked) });
      input.checked = value;
      return h('label', { class: 'check' }, input, h('span', null, label));
    };

    function paint() {
      body.innerHTML = '';
      // Format
      const seg = h('div', { class: 'seg xp-seg' }, FORMATS.map(([k, label]) => h('button', {
        type: 'button', class: st.format === k ? 'on' : '', onclick: () => { st.format = k; paint(); paintFoot(); },
      }, label)));

      // Rows
      const scopes = h('div', { class: 'xp-col' });
      if (ctx.all) {
        const sub = ctx.all.source === 'table'
          ? (ctx.all.total !== null && ctx.all.total !== undefined ? fmtNum(ctx.all.total) + ' rows' : '') + (ctx.all.filters && ctx.all.filters.length ? ' · with current filter' : '')
          : 're-runs the query without the row limit';
        scopes.append(radio('xp-scope', 'all', ctx.all.source === 'table' ? 'All rows' : 'All rows of the query', sub, st.scope === 'all', () => { st.scope = 'all'; }));
      }
      if (ctx.page) scopes.append(radio('xp-scope', 'page', ctx.page.label || 'Loaded rows', fmtNum(ctx.page.rows.length) + ' rows', st.scope === 'page', () => { st.scope = 'page'; }));
      if (ctx.selected && ctx.selected.length) {
        scopes.append(radio('xp-scope', 'selected', 'Selected rows', fmtNum(ctx.selected.length) + ' rows', st.scope === 'selected', () => { st.scope = 'selected'; }));
      }

      // Columns
      const colBox = h('div', { class: 'xp-cols' }, ctx.columns.map((c, i) => check(c.name, st.cols.has(i), (on) => {
        if (on) st.cols.add(i); else st.cols.delete(i);
        countEl.textContent = `${st.cols.size} of ${ctx.columns.length}`;
      })));
      const countEl = h('span', { class: 'muted' }, `${st.cols.size} of ${ctx.columns.length}`);
      const colHead = h('div', { class: 'xp-colhead' }, h('span', { class: 'xp-label' }, 'Columns'), countEl, h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'link', onclick: () => { st.cols = new Set(ctx.columns.map((_, i) => i)); paint(); } }, 'All'),
        h('button', { type: 'button', class: 'link', onclick: () => { st.cols.clear(); paint(); } }, 'None'));

      // Options
      const opts = h('div', { class: 'xp-col' });
      if (st.format === 'csv') {
        const delim = h('select', { class: 'input xs', onchange: (e) => { st.delimiter = e.target.value === 'tab' ? '\t' : e.target.value; } },
          [[',', 'Comma ,'], [';', 'Semicolon ;'], ['tab', 'Tab'], ['|', 'Pipe |']].map(([v, l]) => h('option', { value: v }, l)));
        delim.value = st.delimiter === '\t' ? 'tab' : st.delimiter;
        const nul = h('select', { class: 'input xs', onchange: (e) => { st.nullAs = e.target.value; } },
          h('option', { value: '' }, 'Empty'), h('option', { value: 'NULL' }, 'NULL text'));
        nul.value = st.nullAs;
        opts.append(
          h('div', { class: 'xp-opt' }, h('span', null, 'Delimiter'), delim),
          h('div', { class: 'xp-opt' }, h('span', null, 'NULL values'), nul),
          check('Header row', st.header, (v) => { st.header = v; }),
          h('p', { class: 'muted xp-note' }, 'UTF-8 with BOM, so Excel opens Arabic and other non-Latin text correctly.'));
      } else if (st.format === 'xlsx') {
        opts.append(
          check('Header row', st.header, (v) => { st.header = v; }),
          h('p', { class: 'muted xp-note' }, 'Numbers and dates keep their types. More than 1,048,575 rows continue on a new sheet.'));
      } else if (st.format === 'json') {
        const style = h('select', { class: 'input xs', onchange: (e) => { st.jsonStyle = e.target.value; } },
          h('option', { value: 'array' }, 'Array of objects'), h('option', { value: 'lines' }, 'JSON Lines (one per line)'));
        style.value = st.jsonStyle;
        opts.append(h('div', { class: 'xp-opt' }, h('span', null, 'Layout'), style),
          h('p', { class: 'muted xp-note' }, 'Numbers too large for JavaScript are kept as strings, so no digits are lost.'));
      } else if (st.format === 'sql') {
        const target = h('input', { class: 'input xs mono grow', oninput: (e) => { st.target = e.target.value; } });
        target.value = st.target;
        const every = h('select', { class: 'input xs', onchange: (e) => { st.commitEvery = Number(e.target.value); } },
          [[0, 'Only at the end'], [100, 'Every 100 rows'], [1000, 'Every 1,000 rows'], [10000, 'Every 10,000 rows']].map(([v, l]) => h('option', { value: v }, l)));
        every.value = String(st.commitEvery);
        opts.append(...[
          h('div', { class: 'xp-opt' }, h('span', null, 'Insert into'), target),
          h('div', { class: 'xp-opt' }, h('span', null, 'COMMIT'), every),
          ctx.owner ? check('Include CREATE TABLE and indexes first', st.includeDdl, (v) => { st.includeDdl = v; }) : null].filter(Boolean));
      }

      body.append(
        h('div', { class: 'xp-section' }, h('span', { class: 'xp-label' }, 'Format'), seg),
        h('div', { class: 'xp-grid' },
          h('div', { class: 'xp-section' }, h('span', { class: 'xp-label' }, 'Rows'), scopes, h('span', { class: 'xp-label xp-gap' }, 'Options'), opts),
          h('div', { class: 'xp-section' }, colHead, colBox)));
    }

    /** Export to a file the user picks, or (SQL INSERT only) to the clipboard. */
    async function start(toClipboard = false) {
      if (!st.cols.size) { toast('Pick at least one column', 'err'); return false; }
      Object.assign(remembered, { format: st.format, delimiter: st.delimiter, header: st.header, nullAs: st.nullAs, jsonStyle: st.jsonStyle, commitEvery: st.commitEvery, includeDdl: st.includeDdl });
      const filePath = toClipboard ? null : await api.exportPickFile(st.format, ctx.title);
      if (!toClipboard && !filePath) return false;
      const idx = [...st.cols].sort((a, b) => a - b);
      const allCols = idx.length === ctx.columns.length;
      const options = {
        delimiter: st.delimiter, header: st.header, nullAs: st.nullAs, jsonStyle: st.jsonStyle,
        commitEvery: st.commitEvery, target: st.target, includeDdl: st.format === 'sql' && st.includeDdl, sheetName: ctx.title,
      };
      const jobId = 'x' + Date.now() + Math.random().toString(36).slice(2, 7);
      const job = { jobId, format: st.format, filePath, toClipboard, options, owner: ctx.owner, name: ctx.name, type: ctx.type, engine: window.Lookup && window.Lookup.engineId ? window.Lookup.engineId() : undefined };
      let expected = null;
      if (st.scope === 'all' && ctx.all.source === 'table') {
        Object.assign(job, { source: 'table', filters: ctx.all.filters, sort: ctx.all.sort, columns: allCols ? null : idx.map((i) => ctx.columns[i].name) });
        expected = ctx.all.total;
      } else if (st.scope === 'all' && ctx.all.source === 'query') {
        Object.assign(job, { source: 'query', sql: ctx.all.sql, columns: allCols ? null : idx });
      } else {
        const rows = st.scope === 'selected' ? ctx.selected : ctx.page.rows;
        Object.assign(job, { source: 'rows', columns: idx.map((i) => ctx.columns[i]), rows: allCols ? rows : rows.map((r) => idx.map((i) => r[i])) });
        expected = rows.length;
      }
      runJob(job, expected);
      return false;
    }

    function runJob(job, expected) {
      const count = h('div', { class: 'xp-count' }, '0 rows');
      const bar = h('div', { class: 'xp-bar' }, h('div', { class: 'xp-fill' + (expected ? '' : ' indeterminate') }));
      const fileLine = h('div', { class: 'muted mono xp-file' }, job.toClipboard ? 'To the clipboard' : job.filePath);
      const cancelBtn = h('button', { class: 'btn', onclick: () => api.exportCancel(job.jobId) }, 'Cancel');
      const foot = m.box.querySelector('.modal-foot');
      body.innerHTML = '';
      body.append(h('div', { class: 'xp-progress' }, h('div', { class: 'spinner' }), h('div', null, count, fileLine), bar));
      foot.innerHTML = '';
      foot.append(cancelBtn);
      const t0 = Date.now();
      const off = api.onExportProgress((p) => {
        if (p.jobId !== job.jobId) return;
        count.textContent = `${fmtNum(p.rows)}${expected ? ' of ' + fmtNum(expected) : ''} rows`;
        if (expected) bar.firstChild.style.width = Math.min(100, (p.rows / expected) * 100) + '%';
      });
      api.exportRun(job).then((r) => {
        off();
        body.innerHTML = '';
        foot.innerHTML = '';
        if (r.cancelled) {
          body.append(h('div', { class: 'xp-done' }, h('p', null, `Export cancelled after ${fmtNum(r.rows)} rows. ${job.toClipboard ? 'Nothing was copied.' : 'The partial file was removed.'}`)));
          foot.append(h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close'));
          return;
        }
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.clipboard) {
          body.append(h('div', { class: 'xp-done' },
            h('div', { class: 'xp-ok' }, icon('check')),
            h('div', null, h('div', { class: 'strong' }, `Copied ${fmtNum(r.rows)} rows to the clipboard in ${secs} s`))));
          foot.append(h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done'));
          return;
        }
        body.append(h('div', { class: 'xp-done' },
          h('div', { class: 'xp-ok' }, icon('check')),
          h('div', null, h('div', { class: 'strong' }, `Exported ${fmtNum(r.rows)} rows in ${secs} s`), h('div', { class: 'muted mono xp-file' }, r.filePath))));
        foot.append(
          h('button', { class: 'btn', onclick: () => api.showInFolder(r.filePath) }, icon('open'), 'Show in folder'),
          h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done'));
      }).catch((e) => {
        off();
        body.innerHTML = '';
        foot.innerHTML = '';
        body.append(h('div', { class: 'err-title' }, 'Export failed'), h('pre', { class: 'err-text' }, e.message));
        foot.append(h('button', { class: 'btn', onclick: () => paint() || paintFoot() }, 'Back'), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close'));
      });
    }

    function paintFoot() {
      const foot = m.box.querySelector('.modal-foot');
      foot.innerHTML = '';
      foot.append(...[h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        st.format === 'sql' ? h('button', { class: 'btn', onclick: () => start(true) }, icon('copy'), 'Copy to clipboard') : null,
        h('button', { class: 'btn primary', onclick: () => start() }, icon('download'), 'Export…')].filter(Boolean));
    }

    paint();
    m = modal({
      title: `Export ${ctx.title}`,
      wide: true,
      body,
      actions: [{ label: 'Cancel' }],
    });
    paintFoot();
  }

  window.openExport = openExport;
})();
