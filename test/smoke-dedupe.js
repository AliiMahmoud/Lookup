// Opening a database that is already open switches to its tab instead of adding one.
// Run with: npx electron test/smoke-dedupe.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, webContents } = require('electron');

app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-dedupe'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tabs = (win) => win.webContents.executeJavaScript(
  `[...document.querySelectorAll('.rail-tile')].map((t) => (t.classList.contains('active') ? '*' : '') + t.querySelector('.rail-name').textContent)`);
const views = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html'));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      const [first] = views();
      const ids = await first.executeJavaScript(`(async () => [
        await window.api.saveConnection({ name: 'Billing', host: 'db1', port: 1521, service: 'BILL', user: 'app', password: 'p' }),
        await window.api.saveConnection({ name: 'CRM', host: '127.0.0.1', port: 1598, service: 'CRM', user: 'app', password: 'p' }),
        await window.api.saveConnection({ name: 'Billing copy', host: 'DB1', port: 1521, service: 'bill', user: 'APP', password: 'p' }),
      ])()`);
      // Pretend tab 1 is connected to Billing (re-sent before each step, since there is no real database here).
      const fake = async () => { await first.executeJavaScript(`window.api.wsState({ connected: true, connId: ${JSON.stringify(ids[0])}, title: 'Billing', schema: 'APP' })`); await wait(150); };
      await fake();
      await first.executeJavaScript(`window.api.openConnection(${JSON.stringify(ids[0])})`);
      await wait(800);
      out.sameConnection = await tabs(win);
      await fake();
      await first.executeJavaScript(`window.api.openConnection(${JSON.stringify(ids[2])})`);
      await wait(800);
      out.sameDatabaseOtherName = await tabs(win);
      await fake();
      await first.executeJavaScript(`window.api.openConnection(${JSON.stringify(ids[1])})`);
      await wait(2500);
      out.differentDatabase = await tabs(win);
      // From the new tab, try to connect to Billing: it should switch back to tab 1.
      await fake();
      const second = views().find((v) => v.id !== first.id);
      out.focusExisting = await second.executeJavaScript(`window.api.focusExisting(${JSON.stringify(ids[0])})`);
      await wait(400);
      out.afterFocus = await tabs(win);
      console.log('SMOKE-DEDUPE', JSON.stringify(out));
    } catch (e) {
      console.log('SMOKE-DEDUPE FAILED', e.message, JSON.stringify(out));
    }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
