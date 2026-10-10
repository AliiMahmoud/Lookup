// Global keyboard shortcuts and start-up. Loaded last.
(function () {
  const api = window.api;
  const Lookup = window.Lookup;
  const { params, EMBEDDED, S } = Lookup;

  // ---------- Global keys & layout ----------
  document.addEventListener('keydown', (e) => {
    if (!S.current || document.querySelector('.modal-back') || e.defaultPrevented) return; // already handled (e.g. by the editor)
    const mod = e.ctrlKey || e.metaKey;
    const t = S.tabs.find((x) => x.id === S.active);
    if (t && t.onKey && t.onKey(e)) return;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); Lookup.commitShortcut(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); Lookup.sqlLogPanel().toggle(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 't' && Lookup.isRedis && Lookup.isRedis()) { e.preventDefault(); Lookup.openRedisShell(); }
    else if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); Lookup.openQueryTab(); }
    else if (mod && e.key.toLowerCase() === 'w') { e.preventDefault(); if (S.active) Lookup.closeTab(S.active); }
    else if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); Lookup.openAnything(); }
    else if (mod && !e.altKey && e.key.toLowerCase() === 'r') { e.preventDefault(); if (S.current) Lookup.reconnect(); } // Ctrl+R / Ctrl+Shift+R
    else if (mod && e.key.toLowerCase() === 'e' && t) {
      e.preventDefault();
      if (t.kind === 'table' && t.view === 'data') Lookup.exportTable(t);
      else if (t.kind === 'query' && t.resIndex >= 0 && t.results[t.resIndex]) Lookup.exportResult(t, t.results[t.resIndex]);
    }
    else if (mod && e.key === 'Tab' && S.tabs.length) {
      e.preventDefault();
      const i = S.tabs.findIndex((x) => x.id === S.active);
      const n = S.tabs[(i + (e.shiftKey ? -1 : 1) + S.tabs.length) % S.tabs.length];
      Lookup.activate(n.id);
    }
  });
  window.addEventListener('beforeunload', () => Lookup.saveQueryTabs());
  async function init() {
    try { S.platform = await api.platform(); } catch { /* default */ }
    document.body.classList.add('platform-' + S.platform);
    if (EMBEDDED) document.body.classList.add('embedded');
    Lookup.initSidebarResize();
    await Lookup.showWelcome();
    const connectId = params.get('connect');
    if (connectId && S.connections.some((c) => c.id === connectId)) Lookup.connectTo(connectId);
  }
  init();
})();
