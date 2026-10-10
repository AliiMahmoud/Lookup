// Rename to Lookup: data from the old OraDesk folder is carried over; title bar layout; 500-row default.
// Run with: npx electron test/smoke-rename.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, webContents } = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-mig-'));
const oldDir = path.join(root, 'OraDesk');
fs.mkdirSync(path.join(oldDir, 'Local Storage', 'leveldb'), { recursive: true });
fs.writeFileSync(path.join(oldDir, 'connections.json'), '[]');
fs.writeFileSync(path.join(oldDir, 'history.json'), '[{"sql":"select 1 from dual"}]');
fs.writeFileSync(path.join(oldDir, 'Local State'), '{"os_crypt":{"encrypted_key":"x"}}');
fs.writeFileSync(path.join(oldDir, 'Local Storage', 'leveldb', '000003.log'), 'tabs');
app.setPath('userData', path.join(root, 'Lookup'));

const db = require('../src/main/db');
let runOpts = null;
const cols = [{ name: 'ID', type: 'NUMBER', kind: 'number' }];
Object.assign(db, {
  connect: async () => ({ version: '23.5', schema: 'HR', dbName: 'FREE', autoCommit: false }),
  schemas: async () => [{ name: 'HR' }],
  objects: async () => [{ name: 'EMPLOYEES', type: 'TABLE' }],
  columns: async () => cols,
  run: async (_w, stmts, opts) => { runOpts = opts; return stmts.map((s) => ({ kind: 'rows', sql: s, ms: 3, columns: cols, rows: Array.from({ length: opts.maxRows }, (_, i) => [String(i)]), truncated: true, output: [] })); },
  sqlLog: () => ({ entries: [], last: 0 }),
});
// No keychain on the test machine: pretend the saved connection has an encrypted password.
const store = require('../src/main/store');
const { list, get } = store.connections;
store.connections.list = () => list().map((c) => ({ ...c, hasPassword: true }));
store.connections.get = (id) => { const c = get(id); return c && { ...c, password: 'S3cret!' }; };
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      const now = app.getPath('userData');
      out.migrated = ['connections.json', 'history.json', 'Local State', 'Local Storage/leveldb/000003.log'].filter((f) => fs.existsSync(path.join(now, f)));
      out.windowTitle = win.getTitle();
      // Saved window state under the old "oradesk." keys moves to "lookup." on the next load.
      const ws0 = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      await ws0.executeJavaScript(`localStorage.setItem('oradesk.sidebarW', '333px'); localStorage.setItem('oradesk.queries.abc', '[{"title":"Q","text":"select 1"}]'); localStorage.setItem('oradesk.sqllog.open', 'true'); localStorage.setItem('lookup.sqllog.open', 'false'); 1`);
      ws0.reload();
      await new Promise((r) => ws0.once('did-finish-load', r));
      await wait(500);
      out.storageMoved = await ws0.executeJavaScript(`({ keys: Object.keys(localStorage).sort(), sidebarW: localStorage.getItem('lookup.sidebarW'), sqllogKeptNewer: localStorage.getItem('lookup.sqllog.open'), cssWidth: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim() })`);
      const ws = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      const id = await ws.executeJavaScript(`window.api.saveConnection({ name: 'HR Dev', host: 'h', service: 'FREEPDB1', user: 'hr', password: 'p', env: 'dev' })`);
      // Connection form: the eye button shows the saved password.
      ws.reload();
      await new Promise((r) => ws.once('did-finish-load', r));
      await wait(800);
      out.reveal = await ws.executeJavaScript(`(async () => {
        document.querySelector('.conn-item')?.click();
        await new Promise((r) => setTimeout(r, 300));
        const pw = document.querySelector('.pw-wrap input');
        const before = pw.type + ':' + pw.value;
        document.querySelector('.pw-eye').click();
        await new Promise((r) => setTimeout(r, 300));
        return { before, after: pw.type + ':' + pw.value };
      })()`);
      fs.writeFileSync(path.join(__dirname, 'smoke-rename-form.png'), (await ws.capturePage()).toPNG());
      ws.send('ws:action', { action: 'connect', connId: id });
      await wait(800);
      // No OS keychain on the test machine, so the app asks for the password.
      await ws.executeJavaScript(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = 'p'; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`);
      await wait(1500);
      // Results panel: hidden until a run, closable, back on the next run.
      const resState = () => ws.executeJavaScript(`(() => { const t = Lookup.S.tabs.find((x) => x.kind === 'query'); const r = t.el.querySelector('.results');
        return { visible: r.offsetHeight > 0, editorH: t.parts.edHost.offsetHeight, rowsHeld: t.results.length }; })()`);
      await ws.executeJavaScript(`Lookup.openQueryTab({ text: 'select * from employees' }); 1`);
      await wait(300);
      out.results = { beforeRun: await resState() };
      await ws.executeJavaScript(`Lookup.S.tabs.find((x) => x.kind === 'query').el.querySelector('.btn.primary').click(); 1`);
      await wait(600);
      out.results.afterRun = await resState();
      fs.writeFileSync(path.join(__dirname, 'smoke-results.png'), (await ws.capturePage()).toPNG());
      await ws.executeJavaScript(`document.querySelector('.res-close').click(); 1`);
      await wait(300);
      out.results.afterClose = await resState();
      await ws.executeJavaScript(`Lookup.S.tabs.find((x) => x.kind === 'query').el.querySelector('.btn.primary').click(); 1`);
      await wait(600);
      out.results.afterRunAgain = await resState();
      await wait(800);
      out.limitOptions = await ws.executeJavaScript(`[...document.querySelectorAll('.toolbar select option')].map((o) => o.textContent + (o.selected ? ' *' : ''))`);
      out.runOpts = runOpts;
      out.titleBar = await win.webContents.executeJavaScript(`({
        brand: document.querySelector('.brand-name').textContent,
        left: [...document.querySelectorAll('#shell-left .tb-btn')].map((b) => b.textContent.trim() || b.title.split(' ')[0]),
        right: [...document.querySelectorAll('#shell-actions .tb-btn')].map((b) => b.title.split(' (')[0].split(' —')[0]),
        gapAfterName: Math.round(document.getElementById('shell-left').getBoundingClientRect().left - document.getElementById('active-conn').getBoundingClientRect().right),
      })`);
      // SQL log dragged as tall as it goes must not cover the query results.
      await ws.executeJavaScript(`(() => { const e = new KeyboardEvent('keydown', { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true, bubbles: true }); document.dispatchEvent(e); })(); 1`);
      await wait(500);
      out.sqlLog = await ws.executeJavaScript(`(async () => {
        const log = document.querySelector('.sqllog');
        if (!log) return 'log not open';
        const handle = log.querySelector('.sl-resize');
        const r = handle.getBoundingClientRect();
        handle.dispatchEvent(new MouseEvent('mousedown', { clientY: r.top + 2, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientY: 0, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
        const tab = [...document.querySelectorAll('.tabview.query')].find((t) => t.offsetParent);
        const res = tab.querySelector('.results').getBoundingClientRect();
        const ed = tab.querySelector('.ed-host').getBoundingClientRect();
        const lg = log.getBoundingClientRect();
        return { logH: Math.round(lg.height), editorH: Math.round(ed.height), resultsH: Math.round(res.height), resultsBottom: Math.round(res.bottom), logTop: Math.round(lg.top) };
      })()`);
      fs.writeFileSync(path.join(__dirname, 'smoke-rename.png'), (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(__dirname, 'smoke-rename-ws.png'), (await ws.capturePage()).toPNG());
      console.log('SMOKE-RENAME', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-RENAME FAILED', e.stack); }
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(0);
  });
});
