// Small DOM helpers, icons, toasts, modals and context menus.
(function () {
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') {
          for (const [sk, sv] of Object.entries(v)) {
            if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
          }
        }
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') el.innerHTML = v;
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const P = {
    table: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M6.5 6.5V13"/>',
    view: '<path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>',
    mview: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="8" cy="8.6" r="1.7"/><path d="M2.5 5.8h11"/>',
    sequence: '<path d="M3 4.5h2M3 8h4M3 11.5h6M11 3v10M9.5 11.5 11 13l1.5-1.5"/>',
    procedure: '<path d="M5.5 4 2.5 8l3 4M10.5 4l3 4-3 4"/>',
    function: '<path d="M10 3.2c-2.4-.6-3 .9-3.3 2.6L5.6 12c-.3 1.6-1.2 1.8-2.1 1.5M4.5 7h5"/>',
    package: '<path d="M8 2 13.5 5v6L8 14 2.5 11V5z"/><path d="M2.5 5 8 8l5.5-3M8 8v6"/>',
    trigger: '<path d="M9 2 4 9h3.5L7 14l5-7H8.5z"/>',
    synonym: '<path d="M3 6h8.5L9 3.5M13 10H4.5L7 12.5"/>',
    type: '<path d="M3.5 3.5h9M8 3.5v9M5.5 12.5h5"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6"/>',
    play: '<path d="M5 3.3v9.4L12.5 8z" fill="currentColor"/>',
    playAll: '<path d="M3 3.5v9l5-4.5zM8.5 3.5v9l5-4.5z" fill="currentColor"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/>',
    filter: '<path d="M2.5 3.5h11L9.2 8.6v4l-2.4 1V8.6z"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    chevron: '<path d="M6 4l4 4-4 4"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/>',
    db: '<ellipse cx="8" cy="4" rx="5" ry="1.8"/><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8"/>',
    plug: '<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
    save: '<path d="M3 3h8l2 2v8H3zM5.5 3v3h4V3M5 13V9h6v4"/>',
    history: '<path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8M2.5 2.8v2.6h2.6M8 5.2V8l2 1.3"/>',
    download: '<path d="M8 2.5v7.5M5 7l3 3 3-3M3 12.5h10"/>',
    code: '<path d="M2.5 3h11v10h-11zM5 6.5l1.8 1.5L5 9.5M8.5 10h2.5"/>',
    columns: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.2 3v10M9.8 3v10"/>',
    key: '<circle cx="5.5" cy="8" r="2.5"/><path d="M8 8h5.5M11.5 8v2M13.5 8v1.5"/>',
    check: '<path d="M3 8.5 6.5 12 13 4.5"/>',
    undo: '<path d="M5 6.5H10a3 3 0 0 1 0 6H6M5 6.5 7.5 4M5 6.5 7.5 9"/>',
    sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
    panel: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/>',
    open: '<path d="M2.5 4.5V12.5h9l2-5.5H5l-2.5 5.5M2.5 4.5V3.5h4l1 1h4.5V7"/>',
    edit: '<path d="M10.5 2.8 13.2 5.5 6 12.7H3.3V10z"/>',
    copy: '<rect x="5" y="5" width="8" height="8" rx="1.2"/><path d="M3 10.5V3h7.5"/>',
    dots: '<circle cx="4" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12" cy="8" r="1" fill="currentColor"/>',
    gear: '<path d="M12.78 6.54 L14.48 6.74 L14.48 9.26 L12.78 9.46 L12.41 10.35 L13.47 11.69 L11.69 13.47 L10.35 12.41 L9.46 12.78 L9.26 14.48 L6.74 14.48 L6.54 12.78 L5.65 12.41 L4.31 13.47 L2.53 11.69 L3.59 10.35 L3.22 9.46 L1.52 9.26 L1.52 6.74 L3.22 6.54 L3.59 5.65 L2.53 4.31 L4.31 2.53 L5.65 3.59 L6.54 3.22 L6.74 1.52 L9.26 1.52 L9.46 3.22 L10.35 3.59 L11.69 2.53 L13.47 4.31 L12.41 5.65Z"/><circle cx="8" cy="8" r="2.1"/>',
    eraser: '<path d="M9.2 3.2 13 7 7.5 12.5H4.8L3 10.7a1 1 0 0 1 0-1.4z"/><path d="M6.3 6.1 10.1 9.9M7.5 12.5H13"/>',
    log: '<path d="M4 2.5h5.5L12.5 5.5v8H4z"/><path d="M6 7.5h4.5M6 10h4.5M6 12.5h2.5"/>',
    format: '<path d="M2.5 4h11M2.5 7h7M4.5 10h9M4.5 13h5"/>',
    eye: '<path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/>',
    eyeOff: '<path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/><path d="M2.5 2.5l11 11"/>',
    window: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6h11"/>',
    terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.8 6.3 6.8 8l-2 1.7M8.3 10.2h3"/>',
    gauge: '<path d="M2.6 11.5a5.6 5.6 0 1 1 10.8 0"/><path d="M8 9.6 10.6 6M8 9.6h.01"/>',
    folder: '<path d="M2 4.5h4l1.2 1.3H14v6.7H2z"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
    link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>',
  };
  function icon(name, cls) {
    const span = document.createElement('span');
    span.className = 'ic' + (cls ? ' ' + cls : '');
    span.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
    return span;
  }

  function toast(msg, kind = 'info', ms = 3200) {
    const root = document.getElementById('toast-root');
    const t = h('div', { class: 'toast ' + kind }, msg);
    root.append(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, ms);
  }

  /** modal({ title, body, actions:[{label, kind, onClick -> false keeps open}], wide }) */
  function modal({ title, body, actions = [], wide = false, onClose }) {
    const root = document.getElementById('modal-root');
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
      h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, title),
        h('button', { class: 'icon-btn', onclick: close, title: 'Close' }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) =>
        h('button', {
          class: 'btn ' + (a.kind || ''),
          onclick: async () => { const r = await a.onClick?.(); if (r !== false) close(); },
        }, a.label))) : null);
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } }, box);
    root.append(back);
    const f = box.querySelector('textarea, input, select');
    if (f) setTimeout(() => f.focus(), 0);
    return { close, box };
  }

  function confirmBox(title, text, okLabel = 'OK', danger = false) {
    return new Promise((resolve) => {
      let answered = false;
      modal({
        title,
        body: h('p', { class: 'muted' }, text),
        actions: [
          { label: 'Cancel', onClick: () => { answered = true; resolve(false); } },
          { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { answered = true; resolve(true); } },
        ],
        onClose: () => { if (!answered) resolve(false); },
      });
    });
  }

  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  /** items: [{ label, icon, onClick, danger, disabled } | '-'] */
  function contextMenu(x, y, items) {
    closeMenu();
    menuEl = h('div', { class: 'ctx' }, items.map((it) => it === '-'
      ? h('div', { class: 'ctx-sep' })
      : h('div', {
        class: 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''),
        onclick: () => { if (it.disabled) return; closeMenu(); it.onClick(); },
      }, it.icon ? icon(it.icon) : h('span', { class: 'ic' }), h('span', null, it.label), it.hint ? h('span', { class: 'ctx-hint' }, it.hint) : null)));
    document.body.append(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
    menuEl.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  }
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  window.addEventListener('blur', closeMenu);

  function fmtNum(n) { return n === null || n === undefined ? '?' : Number(n).toLocaleString(); }
  function fmtMs(ms) { return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s'; }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function cellText(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'object' && v.$bin !== undefined) return '0x' + v.$bin + (v.len > 256 ? '…' : '');
    return String(v);
  }
  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  window.U = { h, icon, toast, modal, confirmBox, contextMenu, closeMenu, fmtNum, fmtMs, fmtBytes, cellText, debounce };
})();
