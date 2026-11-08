// Redis through RedisInsight: a connection whose Redis only a RedisInsight can reach (a private cluster)
// shows that RedisInsight in place of the workspace, full size, with no browser around it (no address bar
// or buttons). Lookup never connects to Redis here. The page is a <webview>; the main process (insight.js)
// keeps it a plain web page, sends links that open new windows to the browser, and handles back / forward
// / reload (⌘[ ⌘] or Alt+← Alt+→, the mouse's side buttons, a swipe; the right-click menu). RedisInsight's
// sign-in and settings are kept between runs in their own storage.
(function () {
  const { h, icon } = window.U;
  const $ = (sel, root = document) => root.querySelector(sel);
  const Lookup = window.Lookup;
  const { S } = Lookup;

  const PARTITION = 'persist:redisinsight';
  let view = null; // { el, wv }

  function openInsight(c) {
    closeInsight();
    S.current = c;
    S.info = null;
    S.insight = true;
    S.tabs = [];
    S.active = null;
    $('#welcome').classList.add('hidden');
    $('#workspace').classList.add('hidden');
    document.body.classList.add('insight-mode');

    const home = c.insightUrl;
    const wv = document.createElement('webview');
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('allowpopups', ''); // new windows never open: the main process sends their links to the browser
    wv.setAttribute('src', home);
    wv.className = 'ri-page';

    const progress = h('div', { class: 'ri-progress hidden' });
    const errBox = h('div', { class: 'ri-cover ri-error hidden' });
    const cover = h('div', { class: 'ri-cover' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, `Opening RedisInsight at ${home}…`));

    const el = h('div', { id: 'insight', class: 'insight-view' }, progress, wv, cover, errBox);
    $('#statusbar').before(el);
    view = { el, wv };

    let ready = false; // the page is attached: its methods can be called
    const reload = () => { hideError(); if (ready) wv.reload(); else wv.setAttribute('src', home); };
    function hideError() { errBox.classList.add('hidden'); }
    // A certificate the system doesn't trust (self-signed, a company CA): like a browser, say so and
    // offer to proceed. Proceeding trusts that one certificate for that host, from now on.
    async function showCertError(desc, url) {
      let cert = null;
      try { cert = await window.api.insightCertInfo(url || home); } catch { /* no details */ }
      const host = (() => { try { return new URL(url || home).host; } catch { return url || home; } })();
      const date = (ms) => (ms ? new Date(ms).toLocaleDateString() : '?');
      errBox.innerHTML = '';
      const proceed = async (e) => {
        e.currentTarget.disabled = true;
        try { await window.api.insightTrustCert(url || home, cert.fingerprint); hideError(); cover.classList.remove('hidden'); wv.loadURL(url || home); } catch (err) { e.currentTarget.disabled = false; showError(err.message, url); }
      };
      errBox.append(
        h('h3', null, 'Your connection is not private'),
        h('p', { class: 'muted' }, `The certificate of ${host} isn't trusted by this computer, so Lookup can't confirm it's the real server. That is usual for a self-signed certificate or one from a company's own authority; it can also mean someone is in the middle.`),
        h('p', { class: 'muted mono' }, desc),
        cert ? h('div', { class: 'ri-cert mono' },
          h('div', null, h('span', { class: 'muted' }, 'Issued to '), cert.subject || '?'),
          h('div', null, h('span', { class: 'muted' }, 'Issued by '), cert.issuer || '?'),
          h('div', null, h('span', { class: 'muted' }, 'Valid '), `${date(cert.validFrom)} – ${date(cert.validTo)}`),
          h('div', { class: 'ri-fp' }, h('span', { class: 'muted' }, 'SHA-256 '), String(cert.fingerprint || '').replace(/^sha256\//, ''))) : null,
        h('div', { class: 'ri-actions' },
          h('button', { class: 'btn primary', onclick: reload }, icon('refresh'), 'Try again'),
          h('button', { class: 'btn', onclick: () => editConnection(c) }, icon('edit'), 'Edit connection'),
          cert ? h('button', { class: 'btn ghost danger-text', title: 'Trust this certificate for this host from now on', onclick: proceed }, `Proceed to ${host} (unsafe)`) : null));
      errBox.classList.remove('hidden');
      cover.classList.add('hidden');
    }
    function showError(desc, url) {
      errBox.innerHTML = '';
      errBox.append(
        h('h3', null, 'Could not open RedisInsight'),
        h('p', { class: 'muted mono' }, `${url || home} — ${desc}`),
        h('p', { class: 'muted' }, 'Check that RedisInsight is running, that the address is right, and that you are on the network (VPN) that reaches it.'),
        h('div', { class: 'ri-actions' },
          h('button', { class: 'btn primary', onclick: reload }, icon('refresh'), 'Try again'),
          h('button', { class: 'btn', onclick: () => editConnection(c) }, icon('edit'), 'Edit connection')));
      errBox.classList.remove('hidden');
      cover.classList.add('hidden');
    }

    wv.addEventListener('dom-ready', () => { ready = true; });
    wv.addEventListener('did-start-loading', () => progress.classList.remove('hidden'));
    wv.addEventListener('did-stop-loading', () => { progress.classList.add('hidden'); cover.classList.add('hidden'); });
    wv.addEventListener('did-fail-load', (e) => {
      // -3 = aborted (another navigation started); only the page itself failing counts, not one of its frames.
      if (e.errorCode === -3 || !e.isMainFrame) return;
      // -200 … -299: certificate errors (net::ERR_CERT_AUTHORITY_INVALID is -202).
      if (e.errorCode <= -200 && e.errorCode > -300) { showCertError(e.errorDescription || `error ${e.errorCode}`, e.validatedURL); return; }
      showError(e.errorDescription || `error ${e.errorCode}`, e.validatedURL);
    });
    wv.addEventListener('render-process-gone', () => showError('the page stopped', wv.getURL()));

    Lookup.pushState();
    setTimeout(() => wv.focus(), 0);
  }

  function closeInsight() {
    if (view) { view.el.remove(); view = null; }
    document.body.classList.remove('insight-mode');
    S.insight = false;
  }

  /** Back to the start screen with this connection's form open (the tab stays). */
  function editConnection(c) {
    closeInsight();
    S.current = null;
    S.selectedConn = { ...c, keepPassword: true, password: '' };
    Lookup.showWelcome();
  }

  /** The window brought this tab to the front: give the page the keyboard. */
  function focusInsight() { if (view) setTimeout(() => view.wv.focus(), 0); }

  Object.assign(Lookup, { openInsight, closeInsight, focusInsight });
})();
