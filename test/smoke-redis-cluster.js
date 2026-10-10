// The real app against a real Redis cluster: key browser over all masters, a key on another node,
// Workbench (node shown, every master), Shell redirects, Overview nodes. Skips without a cluster.
// Run: xvfb-run -a npx electron test/smoke-redis-cluster.js --no-sandbox   (SHOTS=<dir> saves screenshots)
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-redis-cluster'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
require('../src/main/main.js');
const { open, Pipe, Cmd } = require('../src/main/db/redis/connect');

const U = new URL(process.env.LOOKUP_REDIS_CLUSTER_URL || 'redis://lookup:lookup@127.0.0.1:7000');
const SHOTS = process.env.SHOTS;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const views = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html') && !w.isDestroyed());

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    const errors = [];
    let n = 0;
    let admin;
    const cfg = { engine: 'redis', host: U.hostname, port: Number(U.port) || 7000, database: 0, user: decodeURIComponent(U.username), password: decodeURIComponent(U.password), ssl: 'disable', autoCommit: true };
    const shot = async (name, ws) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await wait(350);
      const tag = `light-cluster-${String(++n).padStart(2, '0')}-${name}`;
      fs.writeFileSync(path.join(SHOTS, `${tag}-shell.png`), (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(SHOTS, `${tag}-ws.png`), (await ws.capturePage()).toPNG());
    };
    try {
      try {
        admin = await open(cfg);
        if (!admin.cluster) throw new Error('not a cluster');
      } catch (e) { console.log(`SMOKE-REDIS-CLUSTER skipped: ${e.message}`); app.exit(0); return; }
      await Promise.all(admin.masterIds().map((id) => admin.execute(new Cmd(['FLUSHALL'], id))));
      await admin.execute(new Pipe([
        ...Array.from({ length: 120 }, (_, i) => ['SET', `session:${i}`, 'x']),
        ['HSET', 'user:1042:profile', 'name', 'Ali Hussien', 'plan', 'pro'], ['SET', 'foo', 'bar'], ['SET', 'hello', 'world'],
        ['ZADD', 'leaderboard:weekly', '9840', 'alice', '9612', 'ali.h']]));
      win.setSize(1280, 860);
      await wait(1500);
      const [ws] = views();
      ws.on('console-message', (_ev, level, message) => { if (level >= 3) errors.push(message); });
      const js = (code) => ws.executeJavaScript(code).catch((e) => { throw new Error(`${e.message} — in: ${code.slice(0, 100)}`); });
      const id = await js(`window.api.saveConnection(${JSON.stringify({ ...cfg, name: 'Cart cluster', env: 'staging' })})`);
      await js('Lookup.showWelcome()');
      await wait(300);
      await js(`Lookup.connectTo(${JSON.stringify(id)}); 1`);
      await wait(500);
      await js(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = ${JSON.stringify(cfg.password)}; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`);
      await wait(2500);
      out.status = await js(`document.querySelector('#statusbar').textContent`);
      out.sidebar = await js(`({ db: document.querySelector('#r-db').selectedOptions[0].textContent, disabled: document.querySelector('#r-db').disabled, rows: [...document.querySelectorAll('#tree .r-row')].map((r) => r.textContent), scan: document.querySelector('#r-scanbar').textContent })`);
      await js(`Lookup.openRedisKey({ key: 'user:1042:profile', type: 'hash' }); 1`);
      await wait(800);
      out.hash = await js(`[...document.querySelectorAll('.tabview:not(.hidden) .r-table tbody tr')].map((tr) => tr.textContent)`);
      await shot('hash', ws);
      await js(`Lookup.openQueryTab(); 1`);
      await wait(300);
      const wb = async (text, node) => {
        await js(`(() => { ${node ? `const s = document.querySelector('.tabview:not(.hidden) .r-node-sel'); s.value = ${JSON.stringify(node)}; s.dispatchEvent(new Event('change'));` : ''} const i = document.querySelector('.tabview:not(.hidden) .r-wb-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
        await wait(700);
      };
      out.nodeOptions = await js(`[...document.querySelectorAll('.tabview:not(.hidden) .r-node-sel option')].map((o) => o.textContent)`);
      await wb('GET foo\nGET hello');
      await wb('DBSIZE', 'all');
      out.workbench = await js(`[...document.querySelectorAll('.tabview:not(.hidden) .r-block')].map((b) => b.querySelector('.r-block-cmd').textContent + ' [' + b.querySelector('.r-block-ms').textContent.replace(/ · \\d+ ms$/, '') + '] => ' + b.querySelector('.r-block-body').textContent)`);
      await shot('workbench', ws);
      await js(`Lookup.openRedisShell(); 1`);
      await wait(800);
      const sh = async (text) => {
        await js(`(() => { const i = document.querySelector('.tabview:not(.hidden) .r-term-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
        await wait(600);
      };
      await sh('get foo');
      await sh('get hello');
      out.shell = await js(`[...document.querySelectorAll('.tabview:not(.hidden) .r-tl')].slice(1).map((x) => x.textContent)`);
      out.prompt = await js(`document.querySelector('.tabview:not(.hidden) .r-prompt').textContent`);
      await shot('shell', ws);
      await win.webContents.executeJavaScript(`document.querySelector('#shell-actions [title^="Overview"]').click()`);
      await wait(1800);
      out.overview = await js(`[...document.querySelectorAll('.tabview:not(.hidden) .r-ov-nodes tbody tr')].map((tr) => tr.textContent)`);
      await shot('overview', ws);
      out.errors = errors;
      console.log('SMOKE-REDIS-CLUSTER', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-REDIS-CLUSTER FAILED', e.stack.split('\n').slice(0, 3).join(' | ')); console.log('SMOKE-REDIS-CLUSTER', JSON.stringify(out)); }
    if (admin) { await Promise.all(admin.masterIds().map((x) => admin.execute(new Cmd(['FLUSHALL'], x)).catch(() => {}))); await admin.close(); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
