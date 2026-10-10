// Calls to engines that aren't SQL (Redis, MongoDB) through api.op, the Production question before changing data, and a small text prompt.
(function () {
  const { h, toast, modal } = window.U;
  const api = window.api;
  const Lookup = window.Lookup;
  const { S } = Lookup;

  /** api.op without the Production question; errors keep their code. */
  async function opCall(name, params) {
    const r = await api.op(name, params);
    if (r.ok) return r.data;
    throw Object.assign(new Error(r.error.message), { code: r.error.code });
  }

  /**
   * An engine call. On a Production connection a call that changes data comes back with
   * CONFIRM_WRITE: ask (showing what will be sent), then send again confirmed. A "no" throws
   * { notSent: true }, which callers ignore.
   */
  async function rop(name, params = {}, { describe, ack } = {}) {
    try {
      return await opCall(name, params);
    } catch (e) {
      if (e.code !== 'CONFIRM_WRITE') throw e;
      const ok = await new Promise((resolve) => {
        let answered = false;
        modal({
          title: 'Change data on Production?',
          body: h('div', { class: 'r-confirm' },
            h('p', null, e.message),
            describe ? h('pre', { class: 'r-confirm-cmds' }, describe) : null,
            h('p', { class: 'muted' }, `Connection: ${S.current.name || ''}${Lookup.opWhere ? Lookup.opWhere() : ''}`)),
          actions: [
            { label: 'Cancel', onClick: () => { answered = true; resolve(false); } },
            { label: 'Run on Production', kind: 'danger', onClick: () => { answered = true; resolve(true); } },
          ],
          onClose: () => { if (!answered) resolve(false); },
        });
      });
      if (!ok) throw Object.assign(new Error('Not sent'), { notSent: true });
      if (ack) ack.yes = true; // the caller may skip asking again for the rest of a run
      return opCall(name, { ...params, confirmed: true });
    }
  }

  /** Shows an error unless the user chose not to send. */
  const opFail = (e) => { if (!e.notSent) toast(e.message, 'err', 6000); };

  function askText(title, label, value = '', { ok = 'Save', hint, mono = true } = {}) {
    return new Promise((resolve) => {
      const input = h('input', { class: 'input' + (mono ? ' mono' : ''), spellcheck: 'false' });
      input.value = value;
      let done = false;
      const m = modal({
        title,
        body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null),
        actions: [{ label: 'Cancel' }, { label: ok, kind: 'primary', onClick: () => { done = true; resolve(input.value); } }],
        onClose: () => { if (!done) resolve(null); },
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done = true; resolve(input.value); m.close(); } });
      setTimeout(() => input.select(), 0);
    });
  }

  Object.assign(Lookup, { opCall, rop, opFail, askText });
})();
