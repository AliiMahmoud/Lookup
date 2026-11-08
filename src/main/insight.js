// Redis through RedisInsight: for a Redis that Lookup can't reach (a private cluster) but a RedisInsight
// can, a connection can be just the RedisInsight address. Connecting shows RedisInsight in the connection
// tab, in a <webview>. Here: what a page may embed (only Lookup's workspace pages, only http(s), only in
// the RedisInsight partition, as a plain web page with no preload and no Node), new windows to the
// browser, a context menu, back / forward / reload (there is no address bar: keys, the mouse's side
// buttons, a three-finger swipe on macOS), and Test in the connection form.
const path = require('path');
const fs = require('fs');
const { app, shell, Menu, BrowserWindow, clipboard, session } = require('electron');
const { wsByWc, isMac } = require('./windows');
const { handle } = require('./ipc/handle');

const PARTITION = 'persist:redisinsight'; // RedisInsight's sign-in and settings, kept between runs

// Certificates the system doesn't trust (self-signed, a company CA): like a browser's "Proceed anyway",
// the user can trust one for its host. Only that exact certificate (by fingerprint) on that host is let
// through, only in the RedisInsight storage, and the choice is kept between runs (insight-certs.json).
// Lookup's own database connections are not affected.
const certsFile = () => path.join(app.getPath('userData'), 'insight-certs.json');
let trusted = null; // { hostname: [fingerprint, …] }
const lastBad = new Map(); // hostname → the certificate it last showed that failed: what "Proceed" trusts
function loadTrusted() {
  if (trusted) return trusted;
  try { trusted = JSON.parse(fs.readFileSync(certsFile(), 'utf8')) || {}; } catch { trusted = {}; }
  return trusted;
}
function saveTrusted() {
  try { fs.writeFileSync(certsFile(), JSON.stringify(trusted, null, 1)); } catch { /* read-only data folder: trusted for this run */ }
}
function certInfo(cert, error) {
  return {
    fingerprint: cert.fingerprint, subject: cert.subjectName, issuer: cert.issuerName, error,
    validFrom: cert.validStart * 1000, validTo: cert.validExpiry * 1000,
  };
}
function verifyProc(req, cb) {
  if (req.errorCode === 0) { cb(-3); return; } // the system trusts it: nothing to do
  const host = req.hostname.toLowerCase();
  if ((loadTrusted()[host] || []).includes(req.certificate.fingerprint)) { cb(0); return; }
  lastBad.set(host, certInfo(req.certificate, req.verificationResult));
  cb(-3); // Chromium's own verdict: the load fails with net::ERR_CERT_…, and the tab offers Proceed
}
app.whenReady().then(() => session.fromPartition(PARTITION).setCertificateVerifyProc(verifyProc));

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return ''; } };
const isCertError = (msg) => /ERR_CERT_|ERR_SSL_/i.test(String(msg || ''));

function guestMenu(guest, params, host) {
  const items = [];
  if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    items.push({ label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
  }
  if (params.isEditable) {
    items.push({ role: 'undo', enabled: params.editFlags.canUndo }, { role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste }, { role: 'selectAll' }, { type: 'separator' });
  } else if (params.selectionText) {
    items.push({ role: 'copy' }, { type: 'separator' });
  }
  const nav = guest.navigationHistory;
  items.push(
    { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
    { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
    { label: 'Reload', click: () => guest.reload() },
    { type: 'separator' },
    { label: 'Open in Browser', click: () => shell.openExternal(guest.getURL()) },
    { label: 'Inspect', click: () => guest.inspectElement(params.x, params.y) },
  );
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(host) || undefined });
}

// Back / forward like a browser: ⌘[ ⌘] on macOS, Alt+← Alt+→ elsewhere; reload: ⌘R / Ctrl+R / F5.
function navKey(input) {
  if (input.type !== 'keyDown') return null;
  if (isMac && input.meta && !input.alt && !input.control && !input.shift) {
    if (input.code === 'BracketLeft' || input.key === '[') return 'back';
    if (input.code === 'BracketRight' || input.key === ']') return 'forward';
  }
  if (!isMac && input.alt && !input.control && !input.meta && !input.shift) {
    if (input.key === 'ArrowLeft') return 'back';
    if (input.key === 'ArrowRight') return 'forward';
  }
  const mod = isMac ? input.meta : input.control;
  if ((mod && !input.alt && input.key.toLowerCase() === 'r') || (input.key === 'F5' && !input.alt)) return 'reload';
  return null;
}

function navigate(guest, what) {
  if (guest.isDestroyed()) return;
  const nav = guest.navigationHistory;
  if (what === 'back' && nav.canGoBack()) nav.goBack();
  else if (what === 'forward' && nav.canGoForward()) nav.goForward();
  else if (what === 'reload') guest.reload();
}

// The mouse's back / forward buttons (buttons 3 and 4) reach only the page, so a small listener there
// goes back / forward in the page's own history. Added again on each page load.
const MOUSE_NAV = `(() => {
  if (window.__lookupMouseNav) return;
  window.__lookupMouseNav = true;
  addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);
  addEventListener('mouseup', (e) => {
    if (e.button === 3) { e.preventDefault(); history.back(); }
    else if (e.button === 4) { e.preventDefault(); history.forward(); }
  }, true);
})()`;

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, prefs, params) => {
    if (!wsByWc.has(contents.id) || params.partition !== PARTITION || !/^https?:\/\//i.test(params.src || '')) {
      event.preventDefault();
      return;
    }
    delete prefs.preload;
    delete prefs.preloadURL;
    Object.assign(prefs, {
      nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false,
    });
    params.allowpopups = true; // so new-window links reach the handler below, which sends them to the browser
  });

  contents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    guest.on('will-navigate', (ev, url) => { if (!/^https?:/i.test(url)) ev.preventDefault(); });
    guest.on('context-menu', (_ev, params) => guestMenu(guest, params, contents));
    guest.on('before-input-event', (ev, input) => {
      const what = navKey(input);
      if (!what) return;
      ev.preventDefault();
      navigate(guest, what);
    });
    guest.on('dom-ready', () => { guest.executeJavaScript(MOUSE_NAV).catch(() => {}); });
    // macOS: a three-finger swipe (System Settings > Trackpad > Swipe between pages), on the window showing this tab.
    const win = BrowserWindow.fromWebContents(contents);
    if (win) {
      const onSwipe = (_ev, dir) => {
        const ws = wsByWc.get(contents.id);
        if (!ws || win.activeWs !== ws.id || guest.isDestroyed()) return;
        // Electron names the direction the other way round from the fingers: 'left' = fingers moved right = back (as in Safari).
        if (dir === 'left') navigate(guest, 'back');
        else if (dir === 'right') navigate(guest, 'forward');
      };
      win.on('swipe', onSwipe);
      guest.once('destroyed', () => { if (!win.isDestroyed()) win.removeListener('swipe', onSwipe); });
    }
  });
});

/** Test in the form: does RedisInsight answer at this address? (Through the same session the tab uses,
 *  so a proxy or a sign-in done in the tab applies.) Returns { version } when it is RedisInsight. */
handle('insight:test', async (_wcId, url) => {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Enter an http:// or https:// address');
  const ses = session.fromPartition(PARTITION);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    let res;
    try { res = await ses.fetch(url.replace(/\/$/, '') + '/api/info', { signal: ctl.signal, redirect: 'manual' }); } catch (e) {
      if (!ctl.signal.aborted && isCertError(e.message)) {
        throw new Error(`${url} has a certificate that isn't trusted (${e.message}). Connect to look at it and choose whether to proceed.`);
      }
      throw new Error(ctl.signal.aborted ? `${url} did not answer within 10 s` : `Could not reach ${url}: ${e.message}`);
    }
    let info = null;
    if (res.ok) { try { info = await res.json(); } catch { /* not JSON: a page in front of it (sign-in) */ } }
    if (info && info.appVersion) return { version: info.appVersion, status: res.status };
    // Something answers (a sign-in page or a proxy in front of RedisInsight): opening it shows what it is.
    const page = await ses.fetch(url, { signal: ctl.signal });
    if (!page.ok && page.status !== 401 && page.status !== 403) throw new Error(`${url} answered HTTP ${page.status}`);
    return { version: null, status: page.status };
  } finally { clearTimeout(timer); }
});

/** The certificate this address showed that isn't trusted (for the tab's "not private" page), or null. */
handle('insight:certInfo', async (_wcId, url) => lastBad.get(hostOf(url)) || null);

/** Proceed anyway: trust the certificate this address last showed (only that one, only for its host). */
handle('insight:trustCert', async (_wcId, url, fingerprint) => {
  const host = hostOf(url);
  const bad = lastBad.get(host);
  if (!host || !bad || bad.fingerprint !== fingerprint) throw new Error('The certificate changed: try again');
  const t = loadTrusted();
  t[host] = [...new Set([...(t[host] || []), fingerprint])];
  saveTrusted();
  lastBad.delete(host);
  const ses = session.fromPartition(PARTITION);
  ses.setCertificateVerifyProc(verifyProc); // again: drops verdicts Chromium cached for the untrusted certificate
  await ses.closeAllConnections();
  return true;
});

module.exports = { PARTITION };
