// The real app, Redis through RedisInsight (no Redis server involved): the RedisInsight mode in the Redis
// form (host and login fields hidden, Test), connecting opens RedisInsight in place of the workspace, full
// size with no address bar (a plain web page: no Node, no preload), the title bar, back / forward / reload
// with no buttons (keys, the mouse's side buttons, a swipe), links that open a new window going to the
// browser, a RedisInsight that doesn't answer (error, Try again, Edit connection), and Disconnect.
// A small local HTTP server stands in for RedisInsight.
// Run: npx electron test/smoke-redis-insight.js   (SHOTS=<dir> also saves screenshots)
const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, webContents, shell } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-redis-insight'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
require('../src/main/main.js');

const SHOTS = process.env.SHOTS;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const views = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html') && !w.isDestroyed());
const guests = () => webContents.getAllWebContents().filter((w) => w.getType() === 'webview' && !w.isDestroyed());
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await wait(100); } };

const opened = [];
shell.openExternal = async (url) => { opened.push(url); };

let hits = 0; // page loads served (to see a reload)
function fakeInsight(port = 0) {
  const page = (title, body) => `<!doctype html><title>${title}</title><body style="font:14px sans-serif">${body}</body>`;
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/info') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ appVersion: '3.8.0' })); return; }
    res.setHeader('content-type', 'text/html');
    if (!req.url.startsWith('/favicon')) hits++;
    if (req.url === '/') res.end(page('Redis Insight', '<h1>Databases</h1><a id="next" href="/browser">Browser</a> <a id="docs" href="https://redis.io/docs/" target="_blank">Docs</a>'));
    else if (req.url === '/browser') res.end(page('Browser', '<h1>Browser</h1>'));
    else { res.statusCode = 404; res.end('nope'); }
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    const errors = [];
    let srv;
    let n = 0;
    try {
      srv = await fakeInsight();
      const port = srv.address().port;
      const base = `http://127.0.0.1:${port}`;
      win.setSize(1280, 820);
      await wait(1500);
      const [ws] = views();
      ws.on('console-message', (_ev, level, message) => { if (level >= 3) errors.push(message); });
      const js = (code) => ws.executeJavaScript(code).catch((e) => { throw new Error(`${e.message} — in: ${code.slice(0, 100)}`); });
      const shellJs = (code) => win.webContents.executeJavaScript(code);
      const shot = async (name) => {
        if (!SHOTS) return;
        fs.mkdirSync(SHOTS, { recursive: true });
        await wait(350);
        fs.writeFileSync(path.join(SHOTS, `insight-${String(++n).padStart(2, '0')}-${name}.png`), (await ws.capturePage()).toPNG());
      };
      const visibleLabels = () => js(`[...document.querySelectorAll('.conn-form .field-label')].filter((l) => l.offsetParent).map((l) => l.textContent)`);

      // The form: Redis has a RedisInsight mode; it hides host and login.
      await js(`Lookup.S.selectedConn = { engine: 'redis' }; Lookup.renderWelcome(); 1`);
      await wait(300);
      out.seg = await js(`[...document.querySelectorAll('.conn-form .seg button')].map((b) => b.textContent)`);
      await js(`[...document.querySelectorAll('.conn-form .seg button')].find((b) => b.textContent === 'RedisInsight').click(); 1`);
      await wait(150);
      out.insightLabels = await visibleLabels();
      out.checksHidden = await js(`!document.querySelector('.conn-form .checks-row').offsetParent`);
      await js(`(() => { const i = [...document.querySelectorAll('.conn-form input')].find((x) => x.placeholder.startsWith('https://redisinsight')); i.value = '127.0.0.1:${port}/'; i.dispatchEvent(new Event('input')); })(); 1`);
      await js(`[...document.querySelectorAll('.conn-form .form-actions .btn')].find((b) => b.textContent === 'Test').click(); 1`);
      await until(() => js(`/answers/.test(document.querySelector('.form-status').textContent)`));
      out.test = await js(`document.querySelector('.form-status').textContent`);
      await shot('form');
      // Back to Fields: host and login come back.
      await js(`[...document.querySelectorAll('.conn-form .seg button')].find((b) => b.textContent === 'Fields').click(); 1`);
      await wait(100);
      out.fieldsLabels = await visibleLabels();
      await js(`[...document.querySelectorAll('.conn-form .seg button')].find((b) => b.textContent === 'RedisInsight').click(); 1`);
      await wait(100);

      // Connect: saved, and RedisInsight opens in place of the workspace.
      await js(`document.querySelector('.conn-form .btn.primary').click(); 1`);
      await until(() => guests().length && guests()[0].getURL().startsWith(base) && !guests()[0].isLoading());
      await wait(500);
      const g = guests()[0];
      const saved = (await js(`window.api.listConnections()`))[0];
      out.saved = { mode: saved.mode, insightUrl: saved.insightUrl, name: saved.name };
      out.view = await js(`({ insight: !!document.querySelector('#insight'), workspace: !document.querySelector('#workspace').classList.contains('hidden'), welcome: !document.querySelector('#welcome').classList.contains('hidden'), status: !!document.querySelector('#statusbar').offsetParent, bar: document.querySelectorAll('#insight button, #insight .ri-bar, #insight .ri-addr').length, cover: document.querySelector('.ri-cover').classList.contains('hidden'), fill: (() => { const r = document.querySelector('#insight webview').getBoundingClientRect(); return [Math.round(r.width) === innerWidth, Math.round(r.height) === innerHeight]; })() })`);
      out.shell = await shellJs(`({ name: document.querySelector('#active-conn').textContent, left: document.querySelectorAll('#shell-left .tb-btn').length, right: document.querySelectorAll('#shell-actions .tb-btn').length, tile: document.querySelector('#conn-tabs').textContent })`);
      out.guest = await g.executeJavaScript(`({ title: document.title, require: typeof require, process: typeof process, api: typeof window.api })`);
      await shot('open');

      // Back / forward with no buttons. (Links clicked as a user would: Chromium skips Back for script-only navigations.)
      const atBrowser = () => g.getURL().endsWith('/browser');
      const goNext = async () => { await g.executeJavaScript(`document.getElementById('next').click(); 1`, true); await until(atBrowser); await wait(200); };
      const key = (k, mods) => { g.focus(); g.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods }); g.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods }); };
      const navMods = process.platform === 'darwin' ? ['meta'] : ['alt'];
      const [backKey, fwdKey] = process.platform === 'darwin' ? ['[', ']'] : ['Left', 'Right'];
      out.nav = {};
      await goNext();
      key(backKey, navMods);
      out.nav.keyBack = !!(await until(() => !atBrowser(), 3000));
      key(fwdKey, navMods);
      out.nav.keyForward = !!(await until(atBrowser, 3000));
      // The mouse's back / forward buttons (3 and 4).
      await wait(300);
      await g.executeJavaScript(`document.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true })); 1`);
      out.nav.mouseBack = !!(await until(() => !atBrowser(), 3000));
      await wait(300);
      await g.executeJavaScript(`document.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true })); 1`);
      out.nav.mouseForward = !!(await until(atBrowser, 3000));
      // A three-finger swipe on macOS: fingers to the right (Electron says 'left') go back, as in Safari.
      win.emit('swipe', {}, 'left');
      out.nav.swipeBack = !!(await until(() => !atBrowser(), 3000));
      win.emit('swipe', {}, 'right');
      out.nav.swipeForward = !!(await until(atBrowser, 3000));
      // Reload: ⌘R / Ctrl+R.
      const before = hits;
      key('R', [process.platform === 'darwin' ? 'meta' : 'control']);
      out.nav.reload = !!(await until(() => hits > before, 3000));
      await until(() => !g.isLoading());
      // The keys that aren't navigation still reach the page (typing [ in a box).
      await g.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<input id=box>'); document.getElementById('box').focus(); 1`);
      g.sendInputEvent({ type: 'char', keyCode: '[' });
      await wait(150);
      out.nav.typed = await g.executeJavaScript(`document.getElementById('box').value`);
      await g.executeJavaScript(`history.back(); 1`);
      await until(() => !atBrowser());

      // target=_blank: to the browser, not a new window.
      await g.executeJavaScript(`document.getElementById('docs').click(); 1`, true);
      await wait(500);
      out.opened = [...opened];

      // RedisInsight stops answering: the error, then Try again once it is back.
      srv.close(); srv.closeAllConnections();
      key('R', [process.platform === 'darwin' ? 'meta' : 'control']);
      await until(() => js(`!document.querySelector('.ri-error').classList.contains('hidden')`));
      out.error = await js(`document.querySelector('.ri-error').innerText`);
      await shot('error');
      srv = await fakeInsight(port);
      await js(`[...document.querySelectorAll('.ri-error .btn')].find((b) => /Try again/.test(b.textContent)).click(); 1`);
      await until(() => js(`document.querySelector('.ri-error').classList.contains('hidden')`));
      await until(() => !g.isLoading());
      out.retried = await g.executeJavaScript('document.title');

      // Opening the same connection from another tab switches to this one.
      out.dedupe = await js(`window.api.focusExisting(${JSON.stringify(saved.id)})`).catch((e) => e.message);

      // Edit connection: back to the form, in RedisInsight mode.
      await js(`window.Lookup.closeInsight(); Lookup.S.current = null; Lookup.S.selectedConn = { ...(${JSON.stringify(saved)}), keepPassword: true }; Lookup.showWelcome(); 1`);
      await wait(400);
      out.edit = await js(`({ seg: document.querySelector('.conn-form .seg .on').textContent, list: document.querySelector('.conn-item-sub').textContent, insight: !!document.querySelector('#insight') })`);

      // Connect from the list, then Disconnect (the tile closes; a fresh one is left).
      await js(`Lookup.connectTo(${JSON.stringify(saved.id)}); 1`);
      await until(() => js(`!!document.querySelector('#insight')`));
      await shellJs(`window.shellApi.action('disconnect'); 1`);
      await wait(800);
      out.afterDisconnect = { guests: guests().length, views: views().length };

      out.errors = errors;
      console.log('SMOKE-REDIS-INSIGHT ' + JSON.stringify(out, null, 1));
      const ok = JSON.stringify(out.seg) === JSON.stringify(['Fields', 'URL', 'RedisInsight'])
        && out.insightLabels.includes('RedisInsight URL') && !out.insightLabels.includes('Host') && !out.insightLabels.includes('User') && !out.insightLabels.includes('Cluster nodes (optional)') && out.checksHidden
        && /RedisInsight 3\.8\.0 answers/.test(out.test)
        && out.fieldsLabels.includes('Host') && out.fieldsLabels.includes('User')
        && out.saved.mode === 'insight' && out.saved.insightUrl === base && out.saved.name === `RedisInsight · 127.0.0.1:${port}`
        && out.view.insight && !out.view.workspace && !out.view.welcome && !out.view.status && out.view.bar === 0 && out.view.cover && out.view.fill.every(Boolean)
        && /RedisInsight/.test(out.shell.name) && out.shell.left === 0 && out.shell.right === 0
        && out.guest.title === 'Redis Insight' && out.guest.require === 'undefined' && out.guest.process === 'undefined' && out.guest.api === 'undefined'
        && Object.entries(out.nav).every(([k, v]) => (k === 'typed' ? v === '[' : v === true))
        && out.opened.includes('https://redis.io/docs/')
        && /Could not open RedisInsight/.test(out.error) && out.retried === 'Redis Insight'
        && out.edit.seg === 'RedisInsight' && /RedisInsight · http/.test(out.edit.list) && !out.edit.insight
        && out.afterDisconnect.guests === 0
        && !errors.length;
      console.log(ok ? 'SMOKE-REDIS-INSIGHT OK' : 'SMOKE-REDIS-INSIGHT FAIL');
      process.exitCode = ok ? 0 : 1;
    } catch (e) {
      console.log('SMOKE-REDIS-INSIGHT FAIL ' + e.stack + '\n' + JSON.stringify(out, null, 1));
      process.exitCode = 1;
    } finally {
      if (srv) srv.close();
      app.exit(process.exitCode || 0);
    }
  });
});
