// Connection lost: status bar turns red with Reconnect; Reconnect restores "Connected".
// Run with: npx electron test/smoke-lost.js
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');

app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-lost'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
const db = require('../src/main/db');
let reconnects = 0;
Object.assign(db, {
  connect: async () => ({ version: '23.26.3.0.0', schema: 'SYSTEM', dbName: 'FREE', autoCommit: false }),
  reconnect: async () => { reconnects++; return { version: '23.26.3.0.0', schema: 'SYSTEM', dbName: 'FREE', autoCommit: false }; },
  schemas: async () => [{ name: 'SYSTEM' }],
  objects: async () => [{ name: 'REDO_LOG', type: 'TABLE' }],
  columns: async () => [],
  sqlLog: () => ({ entries: [], last: 0 }),
});
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      const ws = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      const id = await ws.executeJavaScript(`window.api.saveConnection({ name: 'Local', host: 'localhost', service: 'Free', user: 'system', password: 'p' })`);
      ws.send('ws:action', { action: 'connect', connId: id });
      await wait(800);
      await ws.executeJavaScript(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = 'p'; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`);
      await wait(1500);
      const status = () => ws.executeJavaScript(`document.getElementById('statusbar').innerText.replace(/\\s+/g, ' ').trim()`);
      out.before = await status();
      ws.send('ws:action', { action: 'connectionLost', message: 'The database did not respond to Stop — the connection looks lost' });
      await wait(400);
      out.lost = await status();
      fs.writeFileSync(path.join(__dirname, 'smoke-lost.png'), (await ws.capturePage()).toPNG());
      await ws.executeJavaScript(`document.querySelector('.sb-reconnect').click(); 1`);
      await wait(600);
      out.afterReconnect = await status();
      // Ctrl+R and Ctrl+Shift+R reconnect too.
      ws.send('ws:action', { action: 'connectionLost', message: 'Connection lost: NJS-500' });
      await wait(300);
      await ws.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', ctrlKey: true, bubbles: true, cancelable: true })); 1`);
      await wait(500);
      out.afterCtrlR = await status();
      await ws.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); 1`);
      await wait(500);
      out.reconnects = reconnects;
      console.log('SMOKE-LOST', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-LOST FAILED', e.stack); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
