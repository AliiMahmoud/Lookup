// Memory benchmark: runs the real app with a simulated database and reports
// per-process memory for typical scenarios.  Run: npx electron test/bench.js
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');

const EXTRA_JS = process.env.BENCH_JS || '';
app.commandLine.appendSwitch('js-flags', ('--expose-gc --optimize-for-size ' + EXTRA_JS).trim()); // same V8 flags as the app, plus gc() for measuring
for (const f of (process.env.BENCH_SWITCHES || '').split(' ').filter(Boolean)) {
  const [k, v] = f.replace(/^--/, '').split('=');
  app.commandLine.appendSwitch(k, v);
}
if (process.env.BENCH_NOGPU) app.disableHardwareAcceleration();
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-bench'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });

// ---------- simulated database (replaces the Oracle layer) ----------
const db = require('../src/main/db');
const COLS = 12;
const cols = Array.from({ length: COLS }, (_, i) => ({ name: `COL_${i + 1}`, type: i % 3 === 0 ? 'NUMBER' : i % 3 === 1 ? 'VARCHAR2' : 'DATE', fullType: i % 3 === 1 ? 'VARCHAR2(100)' : i % 3 === 0 ? 'NUMBER' : 'DATE', kind: i % 3 === 0 ? 'number' : i % 3 === 1 ? 'text' : 'date', nullable: true }));
const cell = (r, c) => (c % 3 === 0 ? String(r * 31 + c) : c % 3 === 1 ? `value ${r}-${c} lorem ipsum` : '2026-01-01 10:00:00');
const rows = (n, w = COLS) => Array.from({ length: n }, (_, r) => Array.from({ length: w }, (_, c) => cell(r, c)));
const sessions = new Set();
Object.assign(db, {
  connect: async (winId) => { require('oracledb'); sessions.add(winId); return { version: '23.5.0.0.0', schema: 'BENCH', dbName: 'FREE', autoCommit: false }; },
  disconnect: async (winId) => { sessions.delete(winId); },
  schemas: async () => [{ name: 'BENCH' }, { name: 'HR' }, { name: 'SYS', system: true }],
  objects: async () => Array.from({ length: Number(process.env.BENCH_OBJECTS) || 250 }, (_, i) => ({ name: `TABLE_${String(i).padStart(3, '0')}`, type: i % 5 ? 'TABLE' : 'VIEW' })),
  columns: async () => cols.map((c, i) => ({ ...c, id: i + 1 })),
  tableData: async ({ limit = 300, offset = 0 }) => ({ columns: cols, rows: rows(limit), rowids: Array.from({ length: limit }, (_, i) => `AAAR${offset + i}`), total: 1_000_000, editable: true, ms: 5, sql: 'SELECT …' }),
  run: async (_winId, stmts) => stmts.map((s) => {
    const n = Number((/rows\s+(\d+)/i.exec(s) || [])[1] || 100);
    return { kind: 'rows', sql: s, ms: 10, columns: cols.slice(0, 8), rows: rows(n, 8), truncated: false, output: [] };
  }),
  sqlLog: () => ({ entries: [], last: 0 }),
});

require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const views = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().includes('index.html'));
const MB = (kb) => Math.round(kb / 1024);

// No keychain in test machines: the password is asked on connect.
const answerPassword = async (wc) => { try { await wc.executeJavaScript(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = 'p'; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`); } catch { /* closed */ } };

async function settle() {
  global.gc && global.gc();
  for (const wc of webContents.getAllWebContents()) { try { await wc.executeJavaScript('window.gc && gc(); 1'); } catch { /* ignore */ } }
  await wait(2500);
}

// PSS (proportional set size): shared pages are split between the processes that share them,
// so the sum is the app's real RAM use. Falls back to working set where /proc is missing.
function pssKB(pid) {
  try {
    const t = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    return Number((/^Pss:\s+(\d+)/m.exec(t) || [])[1]);
  } catch { return null; }
}

async function sample(label) {
  await settle();
  let best = null;
  for (let i = 0; i < 3; i++) {
    const m = app.getAppMetrics().map((p) => ({ ...p, kb: pssKB(p.pid) ?? (p.memory.privateBytes || p.memory.workingSetSize) }));
    const total = m.reduce((a, p) => a + p.kb, 0);
    if (!best || total < best.total) best = { total, m };
    await wait(400);
  }
  const by = {};
  for (const p of best.m) {
    const k = p.type === 'Tab' ? 'Renderer' : p.type === 'Browser' ? 'Main' : p.type === 'Utility' ? 'Network' : p.type;
    by[k] = (by[k] || 0) + p.kb;
  }
  const connected = [];
  for (const v of views()) { try { connected.push(await v.executeJavaScript('!!Lookup.S.current')); } catch { /* closing */ } }
  const row = { scenario: label, totalMB: MB(best.total), processes: best.m.length, views: views().length, connected: connected.filter(Boolean).length, breakdownMB: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, MB(v)])) };
  if (process.env.PERPROC) row.perProcess = best.m.map((p) => `${p.type}:${MB(p.kb)}`).join(' ');
  if (process.env.BENCH_DEBUG) {
    const v = views()[0];
    try {
      if (!v.debugger.isAttached()) v.debugger.attach('1.3');
      const u = await v.debugger.sendCommand('Runtime.getHeapUsage');
      row.rendererJsHeapMB = { used: MB(u.usedSize / 1024), total: MB(u.totalSize / 1024) };
      row.dom = [];
      for (const w of views()) {
        try {
          if (!w.debugger.isAttached()) w.debugger.attach('1.3');
          await w.debugger.sendCommand('Performance.enable');
          const { metrics } = await w.debugger.sendCommand('Performance.getMetrics');
          const g = (n) => (metrics.find((m) => m.name === n) || {}).value;
          row.dom.push({ nodes: g('Nodes'), listeners: g('JSEventListeners'), docs: g('Documents'), frames: g('Frames'), layout: g('LayoutObjects') });
        } catch { /* closing */ }
      }
    } catch (e) { row.rendererJsHeapMB = e.message; }
  }
  results.push(row);
  console.log('BENCH', JSON.stringify(row));
}

const results = [];
app.on('browser-window-created', (_e, win) => {
  if (results.started) return;
  results.started = true;
  win.webContents.once('did-finish-load', async () => {
    try {
      await wait(2500);
      await sample('1. Started, connection list');
      const [ws] = views();
      const ids = await ws.executeJavaScript(`(async () => [
        await window.api.saveConnection({ name: 'One', host: 'h1', service: 'S', user: 'u', password: 'p' }),
        await window.api.saveConnection({ name: 'Two', host: 'h2', service: 'S', user: 'u', password: 'p' }),
        await window.api.saveConnection({ name: 'Three', host: 'h3', service: 'S', user: 'u', password: 'p' })])()`);
      ws.send('ws:action', { action: 'connect', connId: ids[0] });
      await wait(800);
      await answerPassword(ws);
      await wait(1200);
      await ws.executeJavaScript(`Lookup.openTableTab('BENCH', 'TABLE_000', 'TABLE', 'data'); 1`);
      await wait(1500);
      await sample('2. Connected, 1 table open (300 rows)');
      await ws.executeJavaScript(`Lookup.openQueryTab({ text: 'select * from big -- rows 50000', run: true }); 1`);
      await wait(4000);
      console.log('query rows held:', await ws.executeJavaScript(`(Lookup.S.tabs.find((t) => t.kind === 'query') || {}).results?.map((r) => r.rows?.length || r.message)`));
      await sample('3. + query result of 50,000 rows');
      await ws.executeJavaScript(`Lookup.S.tabs.filter((t) => t.kind === 'query').forEach((t) => t.el.querySelector('.tab-x'));
        document.querySelectorAll('.tab .tab-x')[1].click(); 1`);
      await wait(800);
      for (const id of ids.slice(1)) {
        await ws.executeJavaScript(`window.api.openConnection(${JSON.stringify(id)}); 1`);
        await wait(1500);
        for (const v of views()) await answerPassword(v);
        await wait(1000);
      }
      for (const v of views()) { try { await v.executeJavaScript(`Lookup.S.current && !Lookup.S.tabs.length && Lookup.openTableTab('BENCH', 'TABLE_001', 'TABLE', 'data'); 1`); } catch { /* ignore */ } }
      await wait(2000);
      await sample('4. 3 connections, a table open in each');
      // 5: a pop-up menu shown once (its layer is a page of its own), then closed
      const win = require('electron').BrowserWindow.getAllWindows()[0];
      require('../src/main/popup-menu').showMenu(win, [{ label: 'One' }, { label: 'Two' }], { x: 20, y: 20 });
      await wait(1500);
      for (const w of webContents.getAllWebContents()) if (w.getURL().includes('menu.html')) require('electron').ipcMain.emit('menu:close', { sender: w });
      await wait(500);
      await sample('5. + a pop-up menu opened and closed');
      // 6: leak check: open and close 40 table / query tabs, then disconnect and reconnect 5 times
      let v0 = null; // the first connection's view (stays open)
      for (const v of views()) { try { if ((await v.executeJavaScript('Lookup.S.current && Lookup.S.current.id')) === ids[0]) v0 = v; } catch { /* ignore */ } }
      if (process.env.BENCH_DEBUG) console.log('v0', !!v0, Date.now());
      for (let i = 0; i < 40; i++) {
        await v0.executeJavaScript(`Lookup.openTableTab('BENCH', 'TABLE_${String(10 + i).padStart(3, '0')}', 'TABLE', 'data'); 1`);
        await wait(120);
        await v0.executeJavaScript(`Lookup.openQueryTab({ text: 'select 1 -- rows 200', run: true }); 1`);
        await wait(150);
        await v0.executeJavaScript(`(async () => { for (const t of [...Lookup.S.tabs].slice(1)) await Lookup.closeTab(t.id, true); })(); 1`);
        await wait(80);
        if (process.env.BENCH_DEBUG && i === 0) console.log('modal', await v0.executeJavaScript(`[...document.querySelectorAll('.modal')].map((m) => m.textContent.slice(0, 120))`));
      }
      if (process.env.BENCH_DEBUG) console.log('tabs done', Date.now());
      for (let i = 0; i < 5; i++) { // close the last connection's tile and open it again
        for (const v of views()) {
          let cid = null;
          try { cid = await v.executeJavaScript('Lookup.S.current && Lookup.S.current.id'); } catch { /* closing */ }
          if (cid === ids[2]) v.send('ws:action', { action: 'disconnect' });
        }
        await wait(1000);
        const before = views().length;
        await v0.executeJavaScript(`window.api.openConnection(${JSON.stringify(ids[2])}); 1`);
        await wait(1000);
        for (const v of views()) await answerPassword(v);
        await wait(1000);
        if (process.env.BENCH_DEBUG) console.log('cycle', i, before, views().length);
      }
      for (const v of views()) { try { await v.executeJavaScript(`Lookup.S.current && !Lookup.S.tabs.length && Lookup.openTableTab('BENCH', 'TABLE_001', 'TABLE', 'data'); 1`); } catch { /* ignore */ } }
      await wait(1500);
      await sample('6. after 80 tabs and 5 connections opened / closed');
      fs.writeFileSync(path.join(__dirname, 'bench-result.json'), JSON.stringify(results, null, 2));
    } catch (e) {
      console.log('BENCH FAILED', e.stack);
    }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
