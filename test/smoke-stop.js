// Stop: "Stopping…" / "Cancelling…", plain "Query cancelled" on ORA-01013, and after 10 s
// the Keep waiting / Close session choice. Run with: npx electron test/smoke-stop.js
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-stop'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
const db = require('../src/main/db');
let finish = null;
let cancels = 0;
let closed = 0;
Object.assign(db, {
  connect: async () => ({ version: '23.26.3.0.0', schema: 'SYSTEM', dbName: 'FREE', autoCommit: false }),
  schemas: async () => [{ name: 'SYSTEM' }],
  objects: async () => [],
  columns: async () => [],
  sqlLog: () => ({ entries: [], last: 0 }),
  run: (_w, stmts) => new Promise((resolve) => { finish = (r) => resolve(stmts.map((sql) => ({ ...r, sql, ms: 1234 }))); }),
  cancel: async () => { cancels++; },
  closeStuckSession: async () => { closed++; finish({ kind: 'error', message: 'Session closed because the query did not stop', lost: true }); },
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
      const view = () => ws.executeJavaScript(`(() => { const t = Lookup.S.tabs.find((x) => x.kind === 'query'); const b = t.parts.stopBtn;
        return { stop: b.classList.contains('hidden') ? 'hidden' : b.textContent + (b.disabled ? ' (disabled)' : ''), body: t.parts.resBody.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) }; })()`);
      // 1. Server confirms the cancel.
      await ws.executeJavaScript(`Lookup.openQueryTab({ text: 'select * from big_table', run: true }); 1`);
      await wait(300);
      out.running = await view();
      await ws.executeJavaScript(`Lookup.S.tabs.find((x) => x.kind === 'query').parts.stopBtn.click(); 1`);
      await wait(200);
      out.stopping = await view();
      finish({ kind: 'error', message: 'ORA-01013: user requested cancel of current operation', code: 'ORA-01013', cancelled: true });
      await wait(400);
      out.cancelled = await view();
      // 2. Server doesn't respond: after 10 s offer Keep waiting / Close session.
      await ws.executeJavaScript(`Lookup.S.tabs.find((x) => x.kind === 'query').parts.runBtn.click(); 1`);
      await wait(300);
      await ws.executeJavaScript(`Lookup.S.tabs.find((x) => x.kind === 'query').parts.stopBtn.click(); 1`);
      await wait(10500);
      out.stuck = await view();
      fs.writeFileSync(path.join(__dirname, 'smoke-stop.png'), (await ws.capturePage()).toPNG());
      await ws.executeJavaScript(`[...document.querySelectorAll('.stop-stuck button')].find((b) => b.textContent === 'Close session').click(); 1`);
      await wait(500);
      out.afterClose = await view();
      out.cancels = cancels;
      out.closed = closed;
      console.log('SMOKE-STOP', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-STOP FAILED', e.stack); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
