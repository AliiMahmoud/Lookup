// Home screen: list with search, keyboard (↓ / Enter), right-click menu, Create / Edit / Duplicate in a
// dialog, Delete. Run with: npx electron test/smoke-home.js
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-home'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
const db = require('../src/main/db');
let connected = null;
db.connect = async (_w, cfg) => { connected = cfg.name; return { version: '23.5', schema: 'HR', dbName: 'FREE', autoCommit: false }; };
db.schemas = async () => [{ name: 'HR' }];
db.objects = async () => [];
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      const ws = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      const js = (s) => ws.executeJavaScript(s);
      const rows = () => js(`[...document.querySelectorAll('.home-conn')].map((r) => (r.classList.contains('sel') ? '*' : '') + r.querySelector('.home-badge').textContent + ' ' + r.querySelector('.home-conn-name').textContent + ' | ' + r.querySelector('.home-conn-sub').textContent)`);
      out.empty = await js(`document.querySelector('.home-empty')?.innerText.replace(/\\s+/g, ' ')`);
      out.brand = await js(`document.querySelector('.home-brand').innerText.replace(/\\s+/g, ' ')`);
      // Create Connection -> dialog -> Save
      await js(`[...document.querySelectorAll('.home-btn')].find((b) => b.textContent.includes('Create')).click(); 1`); await wait(300);
      out.createDialog = await js(`document.querySelector('.modal-title').textContent`);
      out.dialogFields = await js(`[...document.querySelectorAll('.modal .field-label')].map((x) => x.textContent).join(', ')`);
      await js(`(() => { const set = (label, v) => { const f = [...document.querySelectorAll('.modal .field')].find((x) => x.querySelector('.field-label')?.textContent === label); const i = f.querySelector('input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
        set('Name', 'HR Dev'); set('Host', 'db-dev'); set('Service / SID', 'HRDEV'); set('User', 'hr'); set('Password', 'secret');
        [...document.querySelectorAll('.modal .env-chip')].find((b) => b.textContent === 'Dev').click();
        [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Save').click(); })(); 1`);
      await wait(500);
      out.dialogClosedAfterSave = await js(`!document.querySelector('.modal')`);
      for (const [n, env, host] of [['Billing', 'prod', 'bill-db'], ['Reporting', 'none', 'rpt']]) await js(`window.api.saveConnection({ name: '${n}', env: '${env}', host: '${host}', port: 1521, serviceType: 'service', service: 'S', user: 'u', password: 'p', role: 'DEFAULT' })`);
      await js(`Lookup.showWelcome()`); await wait(300);
      out.list = await rows();
      // Search + keyboard
      await js(`(() => { const s = document.querySelector('.home-search-input'); s.value = 'bill'; s.dispatchEvent(new Event('input', { bubbles: true })); })(); 1`); await wait(100);
      out.searchBill = await rows();
      await js(`(() => { const s = document.querySelector('.home-search-input'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })(); 1`); await wait(100);
      out.afterDown = (await rows()).find((r) => r.startsWith('*'));
      // Right-click menu, Duplicate -> dialog title
      await js(`document.querySelectorAll('.home-conn')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 120 })); 1`); await wait(150);
      out.menu = await js(`[...document.querySelectorAll('.ctx .ctx-item')].map((x) => x.textContent)`);
      await js(`[...document.querySelectorAll('.ctx .ctx-item')].find((x) => x.textContent.startsWith('Duplicate')).click(); 1`); await wait(200);
      out.duplicateDialog = await js(`document.querySelector('.modal-title').textContent + ' | name=' + document.querySelector('.modal input').value`);
      await js(`document.querySelector('.modal .modal-head .icon-btn').click(); 1`); await wait(150);
      // Enter connects the selected one
      await js(`document.querySelector('.home-search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1`); await wait(500);
      // (no OS keychain on the test machine, so the password is asked for)
      await js(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = 'p'; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`); await wait(800);
      out.connected = connected;
      out.saved = (await js(`window.api.listConnections()`)).map((c) => `${c.name}:${c.env}:${c.hasPassword ? 'pw' : 'nopw'}`);
      console.log('SMOKE-HOME', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-HOME FAILED', e.stack, JSON.stringify(out)); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
