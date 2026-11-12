// Per-field undo / redo.
// Chromium keeps ONE undo stack for the whole page, so Ctrl+Z in a query tab's editor would undo
// typing done in the sidebar search (or in another query tab). Here every text field gets its own
// history, and the native undo is never used.
// A step keeps only what changed ({ a, del, ins }: at a, `del` became `ins`), so a large script costs little per step.
(function () {
  const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);
  const LIMIT = 300; // steps per field
  const MAX_CHARS = 4e6; // text kept in the steps of one field; the oldest go first
  const GROUP_MS = 1000;

  const states = new WeakMap(); // field -> { undo: [], redo: [], snap, after, kind, t }
  let applying = false;

  const isField = (el) => !!el && !el.readOnly && !el.disabled
    && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase())));

  /** The change from `before` to `after` as one replaced range. */
  function diff(before, after) {
    let a = 0;
    const max = Math.min(before.length, after.length);
    while (a < max && before[a] === after[a]) a++;
    let b = 0;
    while (b < max - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
    return { a, del: before.slice(a, before.length - b), ins: after.slice(a, after.length - b) };
  }
  const back = (p, v) => v.slice(0, p.a) + p.del + v.slice(p.a + p.ins.length); // after -> before
  const forward = (p, v) => v.slice(0, p.a) + p.ins + v.slice(p.a + p.del.length); // before -> after
  const size = (p) => p.del.length + p.ins.length;

  function stateOf(el) {
    let s = states.get(el);
    if (!s) { s = { undo: [], redo: [], snap: el.value, after: el.value, kind: null, t: 0, chars: 0 }; states.set(el, s); }
    return s;
  }

  function push(s, stack, p) {
    stack.push(p);
    s.chars += size(p);
    while (s.undo.length + s.redo.length > 1 && (s.undo.length > LIMIT || s.chars > MAX_CHARS)) {
      const old = s.undo.length ? s.undo.shift() : s.redo.shift();
      s.chars -= size(old);
    }
  }
  function pop(s, stack) {
    const p = stack.pop();
    if (p) s.chars -= size(p);
    return p;
  }
  function clearRedo(s) {
    for (const p of s.redo) s.chars -= size(p);
    s.redo = [];
  }

  // Remember the value just before the user changes it (catches values set from code in the meantime).
  function refresh(el) {
    if (!isField(el)) return;
    const s = stateOf(el);
    s.snap = el.value;
    if (s.after !== el.value) { s.after = el.value; s.kind = null; } // changed by code: don't merge across it
  }

  function record(el, e) {
    const s = stateOf(el);
    const before = s.snap;
    const now = el.value;
    if (before === now) return;
    const type = e.inputType || '';
    const data = e.data || '';
    let kind = null;
    if (type === 'insertText' && data.length === 1 && !/\s/.test(data)) kind = 'ins';
    else if (type === 'deleteContentBackward' || type === 'deleteContentForward') kind = 'del';
    const t = Date.now();
    clearRedo(s);
    if (kind && kind === s.kind && t - s.t < GROUP_MS && s.undo.length && s.after === before) {
      // Typing goes on: one step from the text before the group to now.
      const last = pop(s, s.undo);
      push(s, s.undo, diff(back(last, before), now));
    } else {
      push(s, s.undo, diff(before, now));
    }
    s.kind = kind;
    s.t = t;
    s.snap = s.after = now;
  }

  function apply(el, value, caret) {
    applying = true;
    try {
      el.value = value;
      try { el.setSelectionRange(caret, caret); } catch (_) { /* number inputs */ }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } finally { applying = false; }
    const s = stateOf(el);
    s.snap = s.after = value;
    s.kind = null;
  }

  function step(el, redo) {
    const s = stateOf(el);
    const cur = el.value;
    if (!redo && s.after !== cur) { // changed from code since the last step: undo that first
      const p = diff(s.after, cur);
      push(s, s.redo, p);
      apply(el, s.after, p.a + p.del.length);
      return;
    }
    const p = pop(s, redo ? s.redo : s.undo);
    if (!p) return;
    push(s, redo ? s.undo : s.redo, p);
    if (redo) apply(el, forward(p, cur), p.a + p.ins.length);
    else apply(el, back(p, cur), p.a + p.del.length);
  }

  // ---- wiring ----
  let keyHandledAt = 0;
  document.addEventListener('focusin', (e) => refresh(e.target), true);
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!isField(el)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && (k === 'z' || k === 'y')) { // Ctrl/Cmd+Y = Ctrl/Cmd+Shift+Z = redo
      e.preventDefault();
      keyHandledAt = performance.now();
      step(el, k === 'y' || e.shiftKey);
      return;
    }
    if (!e.isComposing) refresh(el);
  }, true);
  document.addEventListener('beforeinput', (e) => {
    const el = e.target;
    if (!isField(el)) return;
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault(); // Edit menu (or a key the keydown above didn't see)
      if (performance.now() - keyHandledAt > 300) step(el, e.inputType === 'historyRedo');
      return;
    }
    if (!e.isComposing) refresh(el);
  }, true);
  document.addEventListener('input', (e) => {
    if (applying || e.isComposing || !isField(e.target)) return;
    record(e.target, e);
  }, true);
  document.addEventListener('compositionend', (e) => {
    if (isField(e.target)) record(e.target, { inputType: 'insertCompositionText' });
  }, true);
})();
