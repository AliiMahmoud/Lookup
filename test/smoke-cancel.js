// "Connecting to …" overlay: Cancel returns to the connection form without an error.
// Run with: npx electron test/smoke-cancel.js
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-cancel'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
const oracledb = require('oracledb');
oracledb.getConnection = () => new Promise(() => {}); // a server that never answers
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      const ws = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      const id = await ws.executeJavaScript(`window.api.saveConnection({ name: 'Oracle DB', host: 'localhost', service: 'Free', user: 'system', password: 'p' })`);
      ws.send('ws:action', { action: 'connect', connId: id });
      await wait(800);
      await ws.executeJavaScript(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = 'p'; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`);
      await wait(800);
      out.overlay = await ws.executeJavaScript(`document.querySelector('.connecting')?.innerText.replace(/\\s+/g, ' ')`);
      fs.writeFileSync(path.join(__dirname, 'smoke-cancel.png'), (await ws.capturePage()).toPNG());
      const t0 = Date.now();
      await ws.executeJavaScript(`document.querySelector('.connecting .btn').click(); 1`);
      await wait(500);
      out.afterCancel = await ws.executeJavaScript(`({ overlay: !!document.querySelector('.connecting'), errorModal: !!document.querySelector('.modal'), form: !!document.querySelector('.conn-form, .home-intro'), welcomeVisible: !document.getElementById('welcome').classList.contains('hidden') })`);
      out.tile = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.rail-name')].map((x) => x.textContent)`);
      console.log('SMOKE-CANCEL', JSON.stringify(out), Date.now() - t0, 'ms');
    } catch (e) { console.log('SMOKE-CANCEL FAILED', e.stack); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
