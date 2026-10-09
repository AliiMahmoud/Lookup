// Export entry points: tables, objects, selected rows and query results (the dialog itself is js/export.js).
(function () {
  const { toast } = window.U;
  const api = window.api;
  const Lookup = window.Lookup;

  // ---------- Export entry points ----------
  function gridRows(grid, vis) {
    return vis.map((vi) => {
      const { index } = grid.rowAt(vi);
      return grid.columns.map((_, c) => grid.value(index, c));
    });
  }
  function selectedRows(grid) {
    if (!grid || !grid.selRows.size) return null;
    return gridRows(grid, [...grid.selRows].sort((a, b) => a - b));
  }
  function colsOf(columns) {
    return columns.map((c) => ({ name: c.name, type: c.type }));
  }
  function exportTable(tab) {
    if (!tab.data) return;
    window.openExport({
      title: tab.name,
      owner: tab.owner, name: tab.name, type: tab.type,
      columns: colsOf(tab.data.columns),
      page: { rows: tab.grid ? gridRows(tab.grid, tab.grid.order.map((_, i) => i)) : tab.data.rows, label: 'Current page' },
      selected: selectedRows(tab.grid),
      all: { source: 'table', filters: tab.filters, sort: tab.sort, total: tab.data.total },
      target: `${Lookup.qident(tab.owner)}.${Lookup.qident(tab.name)}`,
    });
  }
  async function exportObject(owner, o) {
    try {
      const cols = await api.columns(owner, o.name);
      window.openExport({
        title: o.name,
        owner, name: o.name, type: o.type,
        columns: cols.map((c) => ({ name: c.name, type: c.type })),
        page: null,
        selected: null,
        all: { source: 'table', filters: [], sort: null, total: null },
        target: `${Lookup.qident(owner)}.${Lookup.qident(o.name)}`,
      });
    } catch (e) { toast(e.message, 'err', 6000); }
  }
  function exportResult(tab, r) {
    const fromQuery = /^\s*(select|with)\b/i.test(r.sql || '');
    const m = /\bfrom\s+((?:"?[\w$#]+"?\.)?"?[\w$#]+"?)/i.exec(r.sql || '');
    window.openExport({
      title: (m ? m[1].replace(/"/g, '').split('.').pop() : tab.title.replace(/\s+/g, '_')),
      columns: colsOf(r.columns),
      page: { rows: r.rows, label: r.truncated ? 'Rows shown (limit reached)' : 'Rows shown' },
      selected: selectedRows(tab.grid),
      all: fromQuery && r.truncated ? { source: 'query', sql: r.sql } : null,
      target: m ? m[1] : 'TABLE_NAME',
    });
  }

  Object.assign(Lookup, { exportTable, exportObject, exportResult });
})();
