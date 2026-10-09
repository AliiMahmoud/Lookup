// Settings from the gear menu (Custom… seconds) and zoom (SQL editor only, or the whole window).
(function () {
  const { h, toast, modal } = window.U;
  const api = window.api;
  const Lookup = window.Lookup;
  const { S } = Lookup;

  // ---------- Settings: Custom… value for a connection timing (from the gear menu) ----------
  function askSeconds({ key, label, current, min = 0 }) {
    const input = h('input', { class: 'input', type: 'number', min: String(min), step: '1', value: String(current) });
    const save = async () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < min) { toast(`Enter a whole number of seconds${min ? ` (at least ${min})` : ' (0 = off)'}`, 'err'); return false; }
      try { await api.setAppSetting(key, Math.round(v)); } catch (e) { toast(e.message, 'err'); return false; }
      return true;
    };
    input.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { e.preventDefault(); if (await save()) m.close(); } });
    const m = modal({
      title: label,
      body: h('div', { class: 'field' }, h('div', { class: 'secs-row' }, input, h('span', { class: 'muted' }, 'seconds')),
        min ? null : h('div', { class: 'muted small' }, '0 turns it off')),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: save }],
    });
    setTimeout(() => input.select(), 0);
  }
  // ---------- Zoom: SQL editor only when it has focus, otherwise the whole window ----------
  async function zoomShortcut(dir) {
    const tab = S.tabs.find((t) => t.id === S.active && t.kind === 'query');
    if (tab && tab.editor && tab.editor.el.contains(document.activeElement)) {
      tab.editor.zoomStep(dir);
      Lookup.saveQueryTabs();
      return;
    }
    try { await api.zoomWindow(dir); } catch { /* ignore */ }
  }

  Object.assign(Lookup, { askSeconds, zoomShortcut });
})();
