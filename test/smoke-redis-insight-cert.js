// The real app, Redis through RedisInsight served over HTTPS with a self-signed certificate: Test says the
// certificate isn't trusted, connecting shows "Your connection is not private" with the certificate, and
// "Proceed" trusts that certificate (kept between runs) and opens the page; Test then answers too.
// Needs openssl on the PATH (to make the certificate).
// Run: npx electron test/smoke-redis-insight-cert.js   (SHOTS=<dir> also saves screenshots)
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');
const { app, webContents } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-redis-insight-cert'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
require('../src/main/main.js');

const SHOTS = process.env.SHOTS;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const views = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html') && !w.isDestroyed());
const guests = () => webContents.getAllWebContents().filter((w) => w.getType() === 'webview' && !w.isDestroyed());
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await wait(100); } };

function selfSigned() {
  const dir = path.join(app.getPath('temp'), 'lookup-smoke-cert');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function fakeInsight(tls) {
  const srv = https.createServer(tls, (req, res) => {
    if (req.url === '/api/info') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ appVersion: '3.8.0' })); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Redis Insight</title><h1>Databases</h1>');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    let srv;
    try {
      srv = await fakeInsight(selfSigned());
      const base = `https://127.0.0.1:${srv.address().port}`;
      win.setSize(1280, 820);
      await wait(1500);
      const [ws] = views();
      const js = (code) => ws.executeJavaScript(code);
      const shot = async (name) => {
        if (!SHOTS) return;
        fs.mkdirSync(SHOTS, { recursive: true });
        await wait(350);
        fs.writeFileSync(path.join(SHOTS, `insight-cert-${name}.png`), (await ws.capturePage()).toPNG());
      };

      out.testBefore = await js(`window.api.testInsight(${JSON.stringify(base)}).then((r) => 'ok ' + r.version, (e) => e.message)`);

      const id = await js(`window.api.saveConnection({ engine: 'redis', mode: 'insight', insightUrl: ${JSON.stringify(base)}, name: 'RI tls', host: 'localhost', port: 6379 })`);
      await js(`Lookup.connectTo(${JSON.stringify(id)}); 1`);
      await until(() => js(`!!document.querySelector('.ri-error:not(.hidden) .ri-cert')`));
      out.page = await js(`document.querySelector('.ri-error').innerText`);
      await shot('not-private');

      await js(`[...document.querySelectorAll('.ri-error .btn')].find((b) => /Proceed/.test(b.textContent)).click(); 1`);
      await until(() => guests().length && !guests()[0].isLoading() && js(`document.querySelector('.ri-error').classList.contains('hidden')`));
      await until(async () => (await guests()[0].executeJavaScript('document.title').catch(() => '')) === 'Redis Insight');
      out.title = await guests()[0].executeJavaScript('document.title');
      out.errorHidden = await js(`document.querySelector('.ri-error').classList.contains('hidden')`);
      await shot('proceeded');

      out.testAfter = await js(`window.api.testInsight(${JSON.stringify(base)}).then((r) => 'ok ' + r.version, (e) => e.message)`);
      out.saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'insight-certs.json'), 'utf8'));

      console.log('SMOKE-REDIS-INSIGHT-CERT ' + JSON.stringify(out, null, 1));
      const ok = /certificate that isn't trusted/.test(out.testBefore)
        && /not private/.test(out.page) && /Proceed to 127\.0\.0\.1/.test(out.page) && /ERR_CERT_AUTHORITY_INVALID/.test(out.page)
        && out.title === 'Redis Insight' && out.errorHidden
        && out.testAfter === 'ok 3.8.0'
        && (out.saved['127.0.0.1'] || []).length === 1;
      console.log(ok ? 'SMOKE-REDIS-INSIGHT-CERT OK' : 'SMOKE-REDIS-INSIGHT-CERT FAIL');
      process.exitCode = ok ? 0 : 1;
    } catch (e) {
      console.log('SMOKE-REDIS-INSIGHT-CERT FAIL ' + e.stack + '\n' + JSON.stringify(out, null, 1));
      process.exitCode = 1;
    } finally {
      if (srv) srv.close();
      app.exit(process.exitCode || 0);
    }
  });
});
