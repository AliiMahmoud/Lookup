// Table design: the New table editor, the editable Structure view, and the DDL view.
(function () {
  const { h, icon, toast, modal, confirmBox } = window.U;
  const api = window.api;
  const Lookup = window.Lookup;
  const { TYPE_ICON, S } = Lookup;

  // ---------- New table ----------
  function openCreateTable() {
    if (!S.current) return;
    const owner = S.schema;
    const tab = window.createTableTab({
      owner,
      previewSql: (spec) => api.createTableSql(spec),
      runCreate: (spec) => api.createTable(spec),
      openInEditor: (sql) => Lookup.openQueryTab({ title: 'create_table.sql', text: sql }),
      confirmProd: async () => !(S.current && S.current.env === 'prod')
        || confirmBox('Production database', `Create a table in ${owner} on a production connection?`, 'Create', true),
      onCreated: async (table) => {
        S.objCache.delete(owner);
        await Lookup.closeTab(tab.id, true);
        if (S.schema === owner) await Lookup.loadObjects(true);
        Lookup.openTableTab(owner, table, 'TABLE', 'structure');
      },
    });
    tab.rename = () => Lookup.renderTabs();
    Lookup.addTab(tab);
  }
  function cacheColumns(owner, name, columns) {
    S.colCache.set(owner + '.' + name, columns.map((c) => ({ name: c.name, type: c.fullType || c.type })));
  }
  async function loadStructure(tab, el) {
    const keepScroll = el.scrollTop;
    el.innerHTML = '';
    el.append(h('div', { class: 'grid-loading' }, h('div', { class: 'spinner' })));
    try {
      const s = await api.structure(tab.owner, tab.name);
      tab.structLoaded = true;
      el.innerHTML = '';
      if (tab.type === 'TABLE' && window.structureEditor && Lookup.feature('alterTable')) {
        // Editable: pending bar + editor.
        const count = h('span', { class: 'changes-count' });
        const bar = h('div', { class: 'se-bar hidden' },
          count,
          h('button', { class: 'btn sm', onclick: () => previewStructure(tab) }, 'Preview SQL'),
          h('button', { class: 'btn sm', onclick: () => { loadStructure(tab, el); } }, 'Discard'),
          h('button', { class: 'btn sm primary', title: 'Apply changes (Ctrl+S)', onclick: () => applyStructure(tab, el) }, 'Apply'));
        tab.structEditor = window.structureEditor({
          owner: tab.owner,
          table: tab.name,
          data: s,
          tables: S.objects.filter((o) => o.type === 'TABLE').map((o) => o.name),
          loadRef: (o, t) => api.structure(o, t),
          onChange: (n) => {
            bar.classList.toggle('hidden', !n);
            count.textContent = `${n} change${n === 1 ? '' : 's'}`;
            Lookup.paintTabState();
          },
        });
        el.append(bar, tab.structEditor.el);
        el.scrollTop = keepScroll;
        return;
      }
      tab.structEditor = null;
      const tbl = (head, rows) => h('table', { class: 'meta' }, h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))), h('tbody', null, rows));
      if (s.comment) el.append(h('p', { class: 'table-comment' }, s.comment));
      el.append(h('h3', null, 'Columns', h('span', { class: 'count' }, s.columns.length)),
        tbl(['#', 'Name', 'Type', 'Nullable', 'Default', 'Comment'], s.columns.map((c) => h('tr', null,
          h('td', { class: 'muted' }, c.id),
          h('td', { class: 'mono strong' }, c.pk ? icon('key', 'pk') : null, c.name),
          h('td', { class: 'mono type' }, c.fullType),
          h('td', null, c.nullable ? h('span', { class: 'muted' }, 'yes') : h('span', { class: 'tagx' }, 'NOT NULL')),
          h('td', { class: 'mono muted' }, c.identity === 'AUTO_INCREMENT' ? 'auto_increment' : c.identity ? `IDENTITY · ${String(c.identity).toLowerCase()}` : c.default ?? ''),
          h('td', { class: 'muted' }, c.comments || '')))));
      el.append(h('h3', null, 'Constraints', h('span', { class: 'count' }, s.constraints.length)),
        s.constraints.length ? tbl(['Name', 'Type', 'Columns', 'Detail', 'Status'], s.constraints.map((c) => h('tr', null,
          h('td', { class: 'mono strong' }, c.name), h('td', null, c.type), h('td', { class: 'mono' }, c.columns),
          h('td', { class: 'mono muted' }, c.detail || ''), h('td', { class: c.status === 'ENABLED' ? 'muted' : 'warn' }, c.status.toLowerCase())))) : h('p', { class: 'muted' }, 'None'));
      el.append(h('h3', null, 'Indexes', h('span', { class: 'count' }, s.indexes.length)),
        s.indexes.length ? tbl(['Name', 'Columns', 'Type', 'Unique', 'Status'], s.indexes.map((i) => h('tr', null,
          h('td', { class: 'mono strong' }, i.name), h('td', { class: 'mono' }, i.columns), h('td', { class: 'muted' }, i.type.toLowerCase()),
          h('td', null, i.unique ? 'yes' : h('span', { class: 'muted' }, 'no')), h('td', { class: i.status === 'VALID' || i.status === 'N/A' ? 'muted' : 'warn' }, i.status.toLowerCase())))) : h('p', { class: 'muted' }, 'None'));
    } catch (e) {
      el.innerHTML = '';
      el.append(h('div', { class: 'grid-error' }, h('pre', { class: 'err-text' }, e.message)));
    }
  }
  async function previewStructure(tab) {
    try {
      const steps = await api.alterTableSql(tab.structEditor.plan());
      const sql = steps.map((x) => x.sql + ';').join('\n');
      modal({
        title: `Pending changes · ${steps.length} statement${steps.length === 1 ? '' : 's'}`,
        wide: true,
        body: h('div', null,
          h('p', { class: 'muted se-note' }, 'Each statement is DDL: Oracle commits it on its own, so they cannot be rolled back as a group.'),
          h('pre', { class: 'ddl-code boxed', html: window.SqlEditor.highlight(sql) })),
        actions: [
          { label: 'Copy SQL', onClick: () => { api.copy(sql + '\n'); toast('Copied', 'ok'); return false; } },
          { label: 'Open in editor', onClick: () => Lookup.openQueryTab({ title: `alter_${tab.name.toLowerCase()}.sql`, text: sql + '\n' }) },
          { label: 'Apply', kind: 'primary', onClick: () => { applyStructure(tab); } },
        ],
      });
    } catch (e) {
      modal({ title: 'Check these first', body: h('pre', { class: 'err-text' }, e.message), actions: [{ label: 'OK', kind: 'primary' }] });
    }
  }
  async function applyStructure(tab, el) {
    const view = el || tab.el.querySelector('.view-structure');
    let steps;
    try { steps = await api.alterTableSql(tab.structEditor.plan()); } catch (e) {
      modal({ title: 'Check these first', body: h('pre', { class: 'err-text' }, e.message), actions: [{ label: 'OK', kind: 'primary' }] });
      return;
    }
    if (!steps.length) { toast('Nothing to apply', 'info'); return; }
    if (S.current && S.current.env === 'prod' && !(await confirmBox('Production database', `Run ${steps.length} structure change(s) on ${tab.owner}.${tab.name} on a production connection?`, 'Apply', true))) return;
    if (S.txPending && !S.autoCommit && !(await confirmBox('Open transaction', 'Structure changes commit automatically in Oracle, which will also commit the uncommitted statements you ran in query tabs.', 'Apply', true))) return;
    const r = await api.alterTable(tab.structEditor.plan()).catch((e) => ({ ok: false, done: [], error: e.message }));
    S.colCache.delete(tab.owner + '.' + tab.name);
    if (r.done && r.done.length) { S.txPending = false; Lookup.renderTitlebar(); Lookup.renderStatus(); }
    // The Data view must reload with the new columns.
    if (tab.grid) { tab.grid.destroy(); tab.grid = null; }
    tab.data = null;
    tab.ddlLoaded = false;
    if (r.ok) toast(`Applied ${r.done.length} change${r.done.length === 1 ? '' : 's'}`, 'ok');
    else {
      modal({
        title: r.done && r.done.length ? `Stopped after ${r.done.length} of ${r.total} statements` : 'Change failed',
        wide: true,
        body: h('div', null,
          r.done && r.done.length ? h('div', null, h('p', { class: 'muted' }, 'These already ran (DDL cannot be rolled back):'),
            h('pre', { class: 'ddl-code boxed', html: window.SqlEditor.highlight(r.done.map((x) => x.sql + ';').join('\n')) })) : null,
          r.failed ? h('p', { class: 'muted' }, 'This one failed:') : null,
          r.failed ? h('pre', { class: 'ddl-code boxed', html: window.SqlEditor.highlight(r.failed.sql + ';') }) : null,
          h('pre', { class: 'err-text' }, r.error)),
        actions: [{ label: 'OK', kind: 'primary' }],
      });
    }
    await loadStructure(tab, view);
  }
  const DDL_OPTS = { indexes: true, comments: true, triggers: true, grants: false, storage: false, schema: true };
  const PLSQL_TYPES = ['PACKAGE', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'TYPE'];
  // DDL viewer with options (tables/views), copy, save as .sql and open in editor.
  function ddlViewer(owner, name, type) {
    const tabular = ['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'DICTIONARY'].includes(type);
    const plsql = PLSQL_TYPES.includes(type);
    let text = '';
    const pre = h('pre', { class: 'ddl-code' });
    const status = h('span', { class: 'muted ddl-status' });
    const opt = (key, label, show = true) => {
      if (!show) return null;
      const input = h('input', { type: 'checkbox', onchange: (e) => { DDL_OPTS[key] = e.target.checked; load(); } });
      input.checked = DDL_OPTS[key];
      return h('label', { class: 'check sm' }, input, h('span', null, label));
    };
    // Oracle has every option; PostgreSQL builds tables from the catalog (indexes, comments, triggers);
    // MySQL's SHOW CREATE only allows the schema prefix on tables.
    const engine = Lookup.engineId();
    const full = engine === 'oracle';
    const pg = engine === 'postgres';
    const lite = engine === 'sqlite'; // indexes and triggers of a table; ClickHouse: SHOW CREATE only
    const options = h('div', { class: 'ddl-opts' },
      opt('indexes', 'Indexes', (full || pg || lite) && tabular && type !== 'VIEW'),
      opt('comments', 'Comments', (full || pg) && tabular),
      opt('triggers', 'Triggers', (full && tabular) || ((pg || lite) && type === 'TABLE')),
      opt('grants', 'Grants', full),
      opt('storage', 'Storage & tablespace', full && (type === 'TABLE' || type === 'MATERIALIZED VIEW')),
      opt('schema', 'Schema prefix', full || pg || (engine === 'mysql' && type === 'TABLE')));
    const scriptText = () => {
      let t = text.trim();
      if (full && plsql && !/\n\/\s*$/.test(t)) t += '\n/';
      return t + '\n';
    };
    const load = async () => {
      pre.classList.add('loading');
      status.textContent = 'Loading…';
      try {
        text = await api.ddl(owner, name, type, { ...DDL_OPTS });
        pre.innerHTML = window.SqlEditor.highlight(text);
        const lines = text.split('\n').length;
        status.textContent = `${lines} line${lines === 1 ? '' : 's'}`;
      } catch (e) {
        pre.innerHTML = '';
        pre.append(h('span', { class: 'err-text' }, e.message));
        status.textContent = '';
      } finally {
        pre.classList.remove('loading');
      }
    };
    const el = h('div', { class: 'ddl-wrap' },
      h('div', { class: 'ddl-tools' },
        h('button', { class: 'btn sm', onclick: () => { api.copy(scriptText()); toast('DDL copied', 'ok'); } }, icon('copy'), 'Copy'),
        h('button', {
          class: 'btn sm',
          onclick: async () => {
            try { const p = await api.saveSql({ name: `${name}`, text: scriptText() }); if (p) toast('Saved ' + p, 'ok'); } catch (e) { toast(e.message, 'err'); }
          },
        }, icon('save'), 'Save .sql'),
        h('button', { class: 'btn sm', onclick: () => Lookup.openQueryTab({ title: name + '.sql', text: scriptText() }) }, icon('edit'), 'Open in editor'),
        h('button', { class: 'tool', title: 'Reload', onclick: () => load() }, icon('refresh')),
        h('div', { class: 'spacer' }), status),
      options.children.length ? options : null,
      pre);
    load();
    return el;
  }
  function loadDdl(tab, el) {
    tab.ddlLoaded = true;
    el.innerHTML = '';
    el.append(ddlViewer(tab.owner, tab.name, tab.type));
  }
  function openDdlTab(owner, o) {
    const existing = S.tabs.find((t) => t.kind === 'ddl' && t.owner === owner && t.name === o.name);
    if (existing) { Lookup.activate(existing.id); return; }
    const tab = { kind: 'ddl', owner, name: o.name, type: o.type, title: o.name, tooltip: `${o.type} ${owner}.${o.name}`, icon: TYPE_ICON[o.type] || 'code' };
    tab.el = h('div', { class: 'tabview' }, h('div', { class: 'view-ddl' }, ddlViewer(owner, o.name, o.type)));
    Lookup.addTab(tab);
  }

  Object.assign(Lookup, { openCreateTable, cacheColumns, loadStructure, applyStructure, loadDdl, openDdlTab });
})();
