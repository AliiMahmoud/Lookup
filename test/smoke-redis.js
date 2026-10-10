// The real app against a real Redis server (no stubs): choose card and form, connecting, the key
// browser (database picker, folders, type chips, filter), key tabs (hash edit + Save, string JSON,
// sorted set, list, stream), Workbench, Shell (exact redis-cli output, hints, SUBSCRIBE + Ctrl+C),
// Overview, and the Production question before a write. Uses database 9 (flushed). Skips without a server.
// Run: xvfb-run -a npx electron test/smoke-redis.js --no-sandbox   (SHOTS=<dir> also saves screenshots)
const path = require('path');
const fs = require('fs');
const { app, webContents, nativeTheme } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-redis'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
require('../src/main/main.js');
const { RespClient } = require('../src/main/db/redis/resp');

const U = new URL(process.env.LOOKUP_REDIS_URL || 'redis://lookup:lookup@127.0.0.1:6379');
const DB = 9;
const SHOTS = process.env.SHOTS;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const views = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html') && !w.isDestroyed());

async function seed() {
  const c = new RespClient();
  await c.connect({ host: U.hostname, port: Number(U.port) || 6379, timeoutMs: 3000 });
  await c.call('AUTH', decodeURIComponent(U.username), decodeURIComponent(U.password));
  await c.call('SELECT', DB);
  await c.call('FLUSHDB');
  await c.call('HSET', 'user:1042:profile', 'name', 'Ali Hussien', 'email', 'ali@example.com', 'plan', 'pro',
    'address', JSON.stringify({ city: 'Cairo', street: '26 July St.', zip: '11511', geo: [30.06, 31.24] }), 'created_at', '2025-03-14T09:20:11Z', 'logins', '1842');
  await c.call('RPUSH', 'user:1042:orders', ...Array.from({ length: 140 }, (_, i) => `order-${5000 + i}`));
  await c.call('SADD', 'user:1042:tags', 'vip', 'beta', 'arabic');
  await c.call('SET', 'user:1042:session', JSON.stringify({ user_id: 1042, device: 'MacBook Air · Safari 19', roles: ['admin', 'billing'], mfa: true, cart: { items: 3, total: 1249.5, currency: 'EGP' } }), 'EX', 1754);
  for (const id of [1041, 1043, 1044, 1045]) await c.call('HSET', `user:${id}:profile`, 'name', `User ${id}`);
  await c.call('SET', 'user:count', '48211');
  await c.call('ZADD', 'leaderboard:weekly', 9840, 'alice', 9612, 'ali.h', 9120.5, 'omar_k', 8877, 'nour', 8650, 'sara.m', 8302, 'youssef');
  await c.call('EXPIRE', 'leaderboard:weekly', 3 * 86400 + 4 * 3600);
  await c.call('XADD', 'events:signup', '*', 'user', '1042', 'source', 'web');
  await c.call('XADD', 'events:signup', '*', 'user', '1043', 'source', 'ios');
  for (let i = 0; i < 40; i++) await c.call('SET', `session:${(i * 7919).toString(36)}`, 'x', 'EX', 600 + i);
  return c;
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    const errors = [];
    let n = 0;
    let admin;
    const shot = async (name, ws) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await wait(350);
      const tag = `${process.env.THEME || 'light'}-redis-${String(++n).padStart(2, '0')}-${name}`;
      fs.writeFileSync(path.join(SHOTS, `${tag}-shell.png`), (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(SHOTS, `${tag}-ws.png`), (await ws.capturePage()).toPNG());
    };
    try {
      try { admin = await seed(); } catch (e) { console.log(`SMOKE-REDIS skipped: ${e.message}`); app.exit(0); return; }
      win.setSize(1280, 860);
      await wait(1500);
      const [ws] = views();
      ws.on('console-message', (_ev, level, message) => { if (level >= 3) errors.push(message); });
      const js = (code) => ws.executeJavaScript(code).catch((e) => { throw new Error(`${e.message} — in: ${code.slice(0, 100)}`); });
      const cfg = { engine: 'redis', host: U.hostname, port: Number(U.port) || 6379, database: DB, user: decodeURIComponent(U.username), password: decodeURIComponent(U.password), ssl: 'disable', autoCommit: true };
      const id = await js(`window.api.saveConnection(${JSON.stringify({ ...cfg, name: 'Sessions cache', env: 'staging' })})`);
      // Another database, so it isn't treated as the same open connection.
      const prodId = await js(`window.api.saveConnection(${JSON.stringify({ ...cfg, database: DB - 1, name: 'Rate limiter', env: 'prod' })})`);
      await js('Lookup.showWelcome()');
      await wait(400);
      out.list = await js(`[...document.querySelectorAll('.conn-item')].map((x) => x.querySelector('.conn-badge').textContent + ' ' + x.querySelector('.conn-item-name').firstChild.textContent + ' | ' + x.querySelector('.conn-item-sub').textContent)`);
      await js(`[...document.querySelectorAll('.welcome-head .btn')].find((b) => /New/.test(b.textContent)).click(); 1`);
      await wait(200);
      out.cards = await js(`[...document.querySelectorAll('.choose-card .choose-name')].map((c) => c.textContent)`);
      await js(`document.querySelector('.choose-card[data-engine=redis]').click(); [...document.querySelectorAll('.choose-actions .btn')].find((b) => b.textContent === 'Continue').click(); 1`);
      await wait(250);
      out.form = await js(`({ labels: [...document.querySelectorAll('.conn-form .field-label')].map((l) => l.textContent), checks: [...document.querySelectorAll('.conn-form .check span')].map((s) => s.textContent), tls: [...document.querySelectorAll('.conn-form select option')].map((o) => o.textContent), seg: [...document.querySelectorAll('.conn-form .seg button')].map((b) => b.textContent) })`);
      await shot('form', ws);

      // Connect (no OS keychain in CI: the password is typed when asked).
      const typePassword = async (run) => run(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = ${JSON.stringify(cfg.password)}; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`);
      await js(`Lookup.connectTo(${JSON.stringify(id)}); 1`);
      await wait(500);
      await typePassword(js);
      await wait(2500);
      out.info = await js(`({ id: Lookup.engineId(), workspace: Lookup.profile().workspace, schema: Lookup.S.schema, status: document.querySelector('#statusbar').textContent })`);
      out.titleButtons = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#shell-left .tb-btn, #shell-actions .tb-btn')].map((b) => b.textContent || b.title.split(':')[0])`);
      out.sidebar = await js(`({ db: document.querySelector('#r-db').selectedOptions[0].textContent, chips: [...document.querySelectorAll('.r-chip')].map((c) => c.textContent), rows: [...document.querySelectorAll('#tree .r-row')].map((r) => r.textContent), scan: document.querySelector('#r-scanbar').textContent })`);
      await js(`[...document.querySelectorAll('#tree .r-folder')].find((r) => r.querySelector('.r-folder-name').textContent === 'user').click(); 1`);
      await wait(100);
      await js(`[...document.querySelectorAll('#tree .r-folder')].find((r) => r.querySelector('.r-folder-name').textContent === '1042').click(); 1`);
      await wait(100);
      out.tree1042 = await js(`[...document.querySelectorAll('#tree .r-key')].map((r) => r.querySelector('.rtype').textContent + ' ' + r.querySelector('.r-key-name').textContent + (r.querySelector('.r-ttl') ? ' ' + r.querySelector('.r-ttl').textContent : ''))`);

      // Hash tab: rows, side panel with JSON, edit a value, Save.
      await js(`[...document.querySelectorAll('#tree .r-key')].find((r) => r.querySelector('.r-key-name').textContent === 'user:1042:profile').click(); 1`);
      await wait(900);
      out.hash = await js(`(() => { const v = document.querySelector('.tabview:not(.hidden)'); return {
        head: v.querySelector('.r-keyhead').textContent, rows: [...v.querySelectorAll('.r-table tbody tr')].map((tr) => [...tr.querySelectorAll('td.r-cell')].map((td) => td.textContent).join('=')),
        foot: v.querySelector('.r-foot').textContent }; })()`);
      await js(`[...document.querySelectorAll('.tabview:not(.hidden) .r-table tbody tr')].find((tr) => tr.textContent.includes('address')).click(); 1`);
      await wait(200);
      out.side = await js(`(() => { const s = document.querySelector('.tabview:not(.hidden) .r-side'); return { title: s.querySelector('.r-side-title').textContent, view: s.querySelector('.seg .on').textContent, json: !!s.querySelector('.r-json .j-key'), foot: s.querySelector('.r-side-foot').textContent }; })()`);
      await js(`(() => { const td = [...document.querySelectorAll('.tabview:not(.hidden) .r-table tbody tr')].find((tr) => tr.textContent.includes('plan')).querySelector('td[data-col=value]'); td.dispatchEvent(new MouseEvent('dblclick')); const i = td.querySelector('input'); i.value = 'business'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(); 1`);
      await wait(200);
      out.hashDirty = await js(`({ bar: document.querySelector('.tabview:not(.hidden) .r-changes').textContent, tab: document.querySelector('.tab.active').classList.contains('dirty') })`);
      await shot('hash', ws);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); 1`);
      await wait(900);
      out.hashSaved = await admin.call('HGET', 'user:1042:profile', 'plan');

      // String with JSON, sorted set, list, stream.
      await js(`Lookup.openRedisKey({ key: 'user:1042:session', type: 'string' }); 1`);
      await wait(800);
      out.string = await js(`(() => { const v = document.querySelector('.tabview:not(.hidden)'); return { view: v.querySelector('.r-toolbar .seg .on').textContent, firstLines: v.querySelector('.r-textarea').value.split('\\n').slice(0, 3), foot: v.querySelector('.r-foot').textContent, ttl: v.querySelector('.r-pill').textContent }; })()`);
      await shot('string', ws);
      await js(`Lookup.openRedisKey({ key: 'leaderboard:weekly', type: 'zset' }); 1`);
      await wait(800);
      out.zset = await js(`(() => { const v = document.querySelector('.tabview:not(.hidden)'); return { rows: [...v.querySelectorAll('.r-table tbody tr')].slice(0, 3).map((tr) => tr.textContent), order: v.querySelector('.seg .on').textContent, foot: v.querySelector('.r-foot').textContent }; })()`);
      await shot('zset', ws);
      await js(`Lookup.openRedisKey({ key: 'user:1042:orders', type: 'list' }); 1`);
      await wait(800);
      out.list = await js(`document.querySelector('.tabview:not(.hidden) .r-foot').textContent`);
      await js(`Lookup.openRedisKey({ key: 'events:signup', type: 'stream' }); 1`);
      await wait(800);
      out.stream = await js(`(() => { const v = document.querySelector('.tabview:not(.hidden)'); return { heads: [...v.querySelectorAll('.r-table th')].map((t) => t.textContent), rows: v.querySelectorAll('.r-table tbody tr').length, foot: v.querySelector('.r-foot').textContent }; })()`);

      // Type chips and filter.
      await js(`document.querySelector('.r-chip[data-type=zset]').click(); 1`);
      await wait(600);
      out.chipZset = await js(`[...document.querySelectorAll('#tree .r-key .r-key-name')].map((x) => x.textContent)`);
      await js(`document.querySelector('.r-chip[data-type=""]').click(); (() => { const f = document.querySelector('#r-filter'); f.value = 'session'; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(); 1`);
      await wait(800);
      out.filter = await js(`({ keys: document.querySelectorAll('#tree .r-key').length, scan: document.querySelector('#r-scanbar').textContent })`);
      await js(`(() => { const f = document.querySelector('#r-filter'); f.value = ''; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(); 1`);
      await wait(600);

      // Workbench (Ctrl+T): formatted replies.
      await js(`Lookup.openQueryTab(); 1`);
      await wait(300);
      const wbRun = async (text) => {
        await js(`(() => { const i = document.querySelector('.tabview:not(.hidden) .r-wb-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
        await wait(700);
      };
      await js(`(() => { const i = document.querySelector('.tabview:not(.hidden) .r-wb-input'); i.value = 'ZRA'; i.dispatchEvent(new Event('input')); })(); 1`);
      await wait(200);
      out.suggest = await js(`[...document.querySelectorAll('.r-suggest-item .r-suggest-name')].map((x) => x.textContent)`);
      await wbRun('HGETALL user:1042:profile\nINCR stats:signups\nZREVRANGE leaderboard:weekly 0 2 WITHSCORES\nGET user:9999:session\nHSET user:1042:profile');
      out.workbench = await js(`[...document.querySelectorAll('.tabview:not(.hidden) .r-block')].map((b) => b.querySelector('.r-block-cmd').textContent + ' => ' + b.querySelector('.r-block-body').textContent.slice(0, 60))`);
      await shot('workbench', ws);

      // Shell: exact redis-cli output, prompt with [db], hints, SUBSCRIBE + Ctrl+C.
      await js(`Lookup.openRedisShell(); 1`);
      await wait(800);
      const sh = async (text, ms = 500) => {
        await js(`(() => { const i = document.querySelector('.tabview:not(.hidden) .r-term-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
        await wait(ms);
      };
      out.prompt = await js(`document.querySelector('.tabview:not(.hidden) .r-prompt').textContent`);
      await js(`(() => { const i = document.querySelector('.tabview:not(.hidden) .r-term-input'); i.value = 'hset'; i.dispatchEvent(new Event('input')); })(); 1`);
      await wait(100);
      out.ghost = await js(`document.querySelector('.tabview:not(.hidden) .r-ghost').textContent`);
      await sh('hgetall user:1042:profile');
      await sh('get nothing');
      await sh('select 3');
      out.prompt3 = await js(`document.querySelector('.tabview:not(.hidden) .r-prompt').textContent`);
      await sh('select 9');
      await sh('subscribe news');
      await admin.call('PUBLISH', 'news', 'hello from the test');
      await wait(400);
      out.streaming = await js(`document.querySelector('.tabview:not(.hidden) .r-termline').classList.contains('hidden')`);
      await shot('shell', ws);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })); 1`);
      await wait(600);
      await sh('ping');
      out.shell = await js(`[...document.querySelectorAll('.tabview:not(.hidden) .r-tl')].map((x) => x.textContent).join('\\n')`);

      // Overview.
      await win.webContents.executeJavaScript(`document.querySelector('#shell-actions [title^="Overview"]').click()`);
      await wait(1500);
      out.overview = await js(`(() => { const v = document.querySelector('.tabview:not(.hidden)'); return { cards: [...v.querySelectorAll('.r-card-title')].map((x) => x.textContent), h3: [...v.querySelectorAll('h3')].map((x) => x.textContent), server: [...v.querySelectorAll('.r-kv td:first-child')].map((x) => x.textContent) }; })()`);
      await shot('overview', ws);

      // Production: a write in the Workbench asks first; Cancel sends nothing.
      const before = views().map((v) => v.id);
      await js(`window.api.openConnection(${JSON.stringify(prodId)}); 1`);
      await wait(2500);
      const pv = views().find((x) => !before.includes(x.id));
      const pj = (code) => pv.executeJavaScript(code);
      await typePassword(pj);
      await wait(2500);
      out.prodInfo = await pj(`({ engine: Lookup.S.info && Lookup.engineId(), status: document.querySelector('#statusbar').textContent, modal: (document.querySelector('.modal-title') || {}).textContent })`);
      await pj(`Lookup.openQueryTab(); 1`);
      await wait(300);
      await pj(`(() => { const i = document.querySelector('.tabview:not(.hidden) .r-wb-input'); i.value = 'SET prod:test 1'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
      await wait(700);
      out.prodAsk = await pj(`({ title: (document.querySelector('.modal-title') || {}).textContent, cmds: (document.querySelector('.r-confirm-cmds') || {}).textContent })`);
      await shot('production-confirm', pv);
      await pj(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Cancel').click(); 1`);
      await wait(400);
      await admin.call('SELECT', DB - 1);
      out.prodNotSent = [await pj(`document.querySelector('.tabview:not(.hidden) .r-block-body').textContent`), await admin.call('EXISTS', 'prod:test')];
      await admin.call('SELECT', DB);
      pv.on('console-message', (_ev, level, message) => { if (level >= 3) errors.push(message); });
      out.errors = errors;
      console.log('SMOKE-REDIS', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-REDIS FAILED', e.stack.split('\n').slice(0, 3).join(' | ')); console.log('SMOKE-REDIS', JSON.stringify(out)); }
    if (admin) { await admin.call('FLUSHDB').catch(() => {}); admin.destroy(); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
