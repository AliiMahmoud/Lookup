// Draws a pop-up menu (with submenus, ticks and keyboard support) in the menu layer, using the same
// look as the app's context menus. Clicking outside or pressing Esc closes it.
(function () {
  const { h, icon } = window.U;
  const api = window.menuApi;
  let panels = []; // open panels: [root, submenu, sub-submenu…]
  let openTimer = null;

  const close = () => { clear(); api.close(); };
  function clear() { panels.forEach((p) => p.el.remove()); panels = []; }

  function place(el, x, y, alignRight) {
    const r = el.getBoundingClientRect();
    let left = alignRight !== undefined ? alignRight - r.width : x;
    left = Math.max(6, Math.min(left, innerWidth - r.width - 6));
    const top = Math.max(6, Math.min(y, innerHeight - r.height - 6));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function openPanel(items, level, x, y, alignRight, fromItem) {
    panels.splice(level).forEach((p) => p.el.remove());
    const hasTicks = items.some((it) => it.checked !== undefined);
    const panel = { el: h('div', { class: 'ctx menu-panel' + (hasTicks ? ' with-ticks' : '') }), items, rows: [], index: -1 };
    items.forEach((it, i) => {
      if (it.separator) { panel.el.append(h('div', { class: 'ctx-sep' })); panel.rows.push(null); return; }
      const row = h('div', {
        class: 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '') + (it.submenu ? ' has-sub' : ''),
        onmouseenter: () => { setIndex(level, i); scheduleSub(level, i); },
        onclick: (e) => { e.stopPropagation(); activate(level, i); },
      },
      hasTicks ? (it.checked ? icon('check') : h('span', { class: 'ic' })) : null,
      h('span', { class: 'ctx-label' }, it.label),
      it.hint ? h('span', { class: 'ctx-hint' }, it.hint) : null,
      it.submenu ? icon('chevron', 'ctx-chevron') : null);
      panel.el.append(row);
      panel.rows.push(row);
    });
    document.body.append(panel.el);
    if (fromItem) {
      const r = fromItem.getBoundingClientRect();
      const w = panel.el.getBoundingClientRect().width;
      const right = r.right + w + 2 <= innerWidth - 6;
      place(panel.el, right ? r.right + 2 : r.left - w - 2, r.top - 5);
    } else {
      place(panel.el, x, y, alignRight);
    }
    panels[level] = panel;
    return panel;
  }

  function setIndex(level, i) {
    const p = panels[level];
    if (!p) return;
    p.rows.forEach((row, k) => row && row.classList.toggle('active', k === i));
    p.index = i;
    panels.slice(level + 1).forEach((q) => q.rows.forEach((row) => row && row.classList.remove('active')));
  }
  function scheduleSub(level, i) {
    clearTimeout(openTimer);
    const it = panels[level].items[i];
    openTimer = setTimeout(() => {
      if (it.submenu && !it.disabled) openPanel(it.submenu, level + 1, 0, 0, undefined, panels[level].rows[i]);
      else panels.splice(level + 1).forEach((q) => q.el.remove());
    }, it.submenu ? 80 : 150);
  }
  function activate(level, i) {
    const it = panels[level] && panels[level].items[i];
    if (!it || it.separator || it.disabled) return;
    if (it.submenu) { clearTimeout(openTimer); const sub = openPanel(it.submenu, level + 1, 0, 0, undefined, panels[level].rows[i]); move(sub, level + 1, 1); return; }
    clear();
    api.choose(it.id);
  }
  function move(panel, level, dir) {
    const n = panel.items.length;
    for (let k = 1; k <= n; k++) {
      const j = (panel.index + dir * k + n * 2) % n;
      const it = panel.items[j];
      if (!it.separator && !it.disabled) { setIndex(level, j); return; }
    }
  }

  document.addEventListener('mousedown', (e) => { if (!panels.some((p) => p.el.contains(e.target))) close(); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (!panels.length) return;
    const level = panels.length - 1;
    const p = panels[level];
    if (e.key === 'Escape') { e.preventDefault(); if (level > 0) { panels.pop().el.remove(); } else close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(p, level, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(p, level, -1); }
    else if (e.key === 'ArrowRight' && p.index >= 0 && p.items[p.index].submenu) { e.preventDefault(); activate(level, p.index); }
    else if (e.key === 'ArrowLeft' && level > 0) { e.preventDefault(); panels.pop().el.remove(); }
    else if ((e.key === 'Enter' || e.key === ' ') && p.index >= 0) { e.preventDefault(); activate(level, p.index); }
  });

  api.onShow(({ items, at }) => {
    clear();
    openPanel(items, 0, at.x, at.y, at.right);
  });
  api.onHide(clear);
  document.body.classList.add('platform-' + api.platform);
})();
