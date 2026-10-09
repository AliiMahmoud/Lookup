// Visits most screens once (table Data / Structure / DDL, New table, query + history, Open anything,
// SQL log, export dialog, tab and object context menus) and reports console errors.
// Run with: npx electron test/smoke-tour.js
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-tour'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
const db = require('../src/main/db');
const cols = [
  { name: 'ID', type: 'NUMBER', fullType: 'NUMBER', kind: 'number', nullable: false, id: 1 },
  { name: 'NAME', type: 'VARCHAR2', fullType: 'VARCHAR2(100)', kind: 'text', nullable: true, id: 2, comment: 'Full name' },
  { name: 'CREATED', type: 'DATE', fullType: 'DATE', kind: 'date', nullable: true, id: 3, default: 'SYSDATE' },
];
const rows = Array.from({ length: 40 }, (_, i) => [String(i + 1), 'Name ' + (i + 1), '2026-01-01 00:00:00']);
Object.assign(db, {
  connect: async () => ({ version: '23.26.3.0.0', schema: 'HR', dbName: 'FREE', autoCommit: false }),
  schemas: async () => [{ name: 'HR' }, { name: 'SYS', system: true }],
  objects: async () => [{ name: 'EMPLOYEES', type: 'TABLE' }, { name: 'DEPTS', type: 'TABLE' }, { name: 'EMP_V', type: 'VIEW' }, { name: 'EMP_SEQ', type: 'SEQUENCE' }],
  columns: async () => cols,
  tableData: async () => ({ columns: cols, rows, rowids: rows.map((_, i) => 'R' + i), total: 40, editable: true, ms: 3, sql: 'SELECT …' }),
  structure: async () => ({ columns: cols.map((c) => ({ ...c, pk: c.name === 'ID', identity: null })), constraints: [], indexes: [], comment: 'Employees' }),
  ddl: async () => 'CREATE TABLE "HR"."EMPLOYEES" (\n  "ID" NUMBER NOT NULL\n);',
  run: async (_w, stmts) => stmts.map((sql) => ({ kind: 'rows', sql, ms: 5, columns: cols, rows: rows.slice(0, 5), truncated: false, output: [] })),
  createTableSql: async () => ({ sql: 'CREATE TABLE t (id NUMBER)', table: 'T' }),
  sqlLog: () => ({ entries: [{ id: 1, at: Date.now(), sql: 'SELECT 1 FROM dual', ms: 2, rows: 1 }], last: 1 }),
});
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    const errors = [];
    try {
      await wait(1500);
      const ws = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      ws.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
      const js = (s) => ws.executeJavaScript(s);
      const key = (k, mods = {}) => js(`document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }, ${JSON.stringify(mods)}))); 1`);
      const id = await js(`window.api.saveConnection({ name: 'HR', host: 'h', service: 'S', user: 'hr', password: 'p' })`);
      ws.send('ws:action', { action: 'connect', connId: id });
      await wait(700);
      await js(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = 'p'; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`);
      await wait(1200);
      out.tree = await js(`[...document.querySelectorAll('#tree')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim())[0]`);
      // Table: Data, Structure, DDL
      await js(`Lookup.openTableTab('HR', 'EMPLOYEES', 'TABLE', 'data'); 1`); await wait(600);
      out.data = await js(`document.querySelector('.pager-info')?.textContent`);
      await js(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Structure').click(); 1`); await wait(600);
      out.structure = await js(`[...document.querySelectorAll('.tabview:not(.hidden) input, .tabview:not(.hidden) td')].slice(0, 6).map((x) => x.value || x.textContent).join('|')`);
      await js(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'DDL').click(); 1`); await wait(600);
      out.ddl = await js(`(document.querySelector('.tabview:not(.hidden) pre, .tabview:not(.hidden) .ddl') || {}).textContent?.slice(0, 30)`);
      // Export dialog (Ctrl+E on the Data view)
      await js(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Data').click(); 1`); await wait(300);
      await key('e', { ctrlKey: true }); await wait(400);
      out.exportDialog = await js(`document.querySelector('.modal-title')?.textContent`);
      await key('Escape'); await wait(200);
      // New table
      await js(`[...document.querySelectorAll('.tree-add')][0].click(); 1`); await wait(500);
      out.newTable = await js(`document.querySelector('.tab.active')?.textContent`);
      // Query + history + Open anything + SQL log
      await key('t', { ctrlKey: true }); await wait(300);
      await js(`Lookup.S.tabs.find((t) => t.kind === 'query').editor.value = 'select * from employees'; Lookup.S.tabs.find((t) => t.kind === 'query').parts.runBtn.click(); 1`); await wait(600);
      out.queryRows = await js(`document.querySelector('.res-tab .count')?.textContent`);
      await js(`document.querySelector('[title="Query history"]').click(); 1`); await wait(400);
      out.history = await js(`document.querySelector('.modal')?.innerText.includes('select * from employees')`);
      await key('Escape'); await wait(200);
      await key('p', { ctrlKey: true }); await wait(300);
      out.openAnything = await js(`document.querySelector('.qs-list')?.innerText.replace(/\\s+/g, ' ').trim()`);
      await key('Escape'); await wait(200);
      await key('L', { ctrlKey: true, shiftKey: true }); await wait(900);
      out.sqlLog = await js(`document.querySelector('.sqllog')?.innerText.includes('SELECT 1 FROM dual')`);
      // Context menus: tab and object
      await js(`document.querySelector('.tab').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 20 })); 1`); await wait(200);
      out.tabMenu = await js(`[...document.querySelectorAll('.ctx .ctx-item')].map((x) => x.textContent)`);
      await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 1`);
      const item = await js(`(() => { const el = [...document.querySelectorAll('#tree *')].find((x) => x.children.length <= 2 && x.textContent.trim() === 'EMPLOYEES'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 })); return !!el; })()`);
      await wait(200);
      out.objectMenu = item && await js(`[...document.querySelectorAll('.ctx .ctx-item')].map((x) => x.textContent)`);
      out.tabs = await js(`Lookup.S.tabs.map((t) => t.kind + ':' + t.title)`);
      out.errors = errors;
      console.log('SMOKE-TOUR', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-TOUR FAILED', e.stack, JSON.stringify(out), errors); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
