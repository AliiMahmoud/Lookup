// The real app against a real MongoDB server (FerretDB in the Linux container): the card and form,
// connecting, the database tree, Documents (list, filter, edit + Update, table, JSON), Aggregations
// with previews, Schema, Indexes (create + explain), the Shell, the Overview, and the Production
// question. Uses (and drops) database lookup_smoke. Skips without a server.
// Run: xvfb-run -a npx electron test/smoke-mongodb.js --no-sandbox   (SHOTS=<dir> saves screenshots)
const path = require('path');
const fs = require('fs');
const { app, webContents, nativeTheme } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-mongodb'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
require('../src/main/main.js');

const URL_ = process.env.LOOKUP_MONGO_URL || 'mongodb://127.0.0.1:27017';
const D = 'lookup_smoke';
const SHOTS = process.env.SHOTS;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const views = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html') && !w.isDestroyed());

async function seed() {
  const { MongoClient, BSON } = require('mongodb');
  const c = new MongoClient(URL_, { serverSelectionTimeoutMS: 3000 });
  await c.connect();
  await c.db(D).dropDatabase();
  const hubs = ['Nasr City', 'Maadi', 'Zamalek', 'Heliopolis'];
  await c.db(D).collection('orders').insertMany(Array.from({ length: 64 }, (_, i) => ({
    orderNo: `BS-2026-${1042800 + i}`, status: ['delivered', 'delivered', 'delivered', 'in_transit', 'pending', 'returned'][i % 6], hub: hubs[i % 4],
    total: new BSON.Double(Math.round((120 + ((i * 97) % 3300)) * 100) / 100), items: Array.from({ length: (i % 4) + 1 }, (_, k) => ({ sku: `SKU-${k + 10}`, qty: new BSON.Int32(k + 1) })),
    address: { city: i % 3 ? 'Cairo' : 'Giza', street: '26 July St.', zip: '11511', geo: [30.06, 31.24] }, createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 9), 8 + (i % 12))),
  })));
  await c.db(D).collection('customers').insertMany([{ name: 'Ali Hussien', email: 'ali@example.com', tier: 'gold' }, { name: 'Omar', tier: 'silver' }]);
  await c.db(D).collection('couriers').insertOne({ name: 'Karim', vehicle: 'bike' });
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
      const tag = `${process.env.THEME || 'light'}-mongo-${String(++n).padStart(2, '0')}-${name}`;
      fs.writeFileSync(path.join(SHOTS, `${tag}-shell.png`), (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(SHOTS, `${tag}-ws.png`), (await ws.capturePage()).toPNG());
    };
    try {
      try { admin = await seed(); } catch (e) { console.log(`SMOKE-MONGODB skipped: ${e.message.split('\n')[0]}`); app.exit(0); return; }
      win.setSize(1280, 860);
      await wait(1500);
      const [ws] = views();
      ws.on('console-message', (_ev, level, message) => { if (level >= 3) errors.push(message); });
      const js = (code) => ws.executeJavaScript(code).catch((e) => { throw new Error(`${e.message} — in: ${code.slice(0, 120)}`); });
      const u = new URL(URL_);
      const cfg = { engine: 'mongodb', mode: 'basic', host: u.hostname, port: Number(u.port) || 27017, database: D, srv: false, ssl: 'disable', authMechanism: 'DEFAULT', readPreference: 'primary', autoCommit: true };
      const id = await js(`window.api.saveConnection(${JSON.stringify({ ...cfg, name: 'Orders (local)', env: 'staging' })})`);
      const prodId = await js(`window.api.saveConnection(${JSON.stringify({ ...cfg, database: 'lookup_smoke_prod', name: 'Tracking', env: 'prod' })})`);
      await js('Lookup.showWelcome()');
      await wait(300);
      out.list = await js(`[...document.querySelectorAll('.conn-item')].map((x) => x.querySelector('.conn-badge').textContent + ' ' + x.querySelector('.conn-item-name').firstChild.textContent + ' | ' + x.querySelector('.conn-item-sub').textContent)`);
      await js(`[...document.querySelectorAll('.welcome-head .btn')].find((b) => /New/.test(b.textContent)).click(); 1`);
      await wait(200);
      out.cards = await js(`[...document.querySelectorAll('.choose-card .choose-name')].map((c) => c.textContent)`);
      await js(`document.querySelector('.choose-card[data-engine=mongodb]').click(); [...document.querySelectorAll('.choose-actions .btn')].find((b) => b.textContent === 'Continue').click(); 1`);
      await wait(250);
      out.form = await js(`({ labels: [...document.querySelectorAll('.conn-form .field-label')].map((l) => l.textContent), url: document.querySelector('.form-urlprev').textContent, checks: [...document.querySelectorAll('.conn-form .check span')].map((s) => s.textContent) })`);
      await js(`(() => { const i = [...document.querySelectorAll('.conn-form .field')].find((f) => f.querySelector('.field-label').textContent === 'Hosts').querySelector('input'); i.value = 'mongo1, mongo2:27018'; i.dispatchEvent(new Event('input', { bubbles: true })); })(); 1`);
      await wait(100);
      out.urlAfter = await js(`document.querySelector('.form-urlprev').textContent`);
      await shot('form', ws);

      // Connect (no user: no password asked).
      await js(`Lookup.connectTo(${JSON.stringify(id)}); 1`);
      await wait(2500);
      out.info = await js(`({ workspace: Lookup.profile().workspace, status: document.querySelector('#statusbar').textContent, title: [...document.querySelectorAll('#tree .r-row')].map((r) => r.textContent).slice(0, 8) })`);
      out.titleButtons = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#shell-left .tb-btn, #shell-actions .tb-btn')].map((b) => b.textContent || b.title.split(':')[0])`);
      await js(`[...document.querySelectorAll('#tree .m-coll')].find((r) => r.textContent.startsWith('orders')).click(); 1`);
      await wait(1500);
      const V = `document.querySelector('.tabview:not(.hidden)')`;
      out.docs = await js(`(() => { const v = ${V}; return { head: v.querySelector('.m-collhead').textContent, subtabs: [...v.querySelectorAll('.m-subtab')].map((b) => b.textContent), cards: v.querySelectorAll('.m-doc').length, range: v.querySelector('.m-range').textContent, firstRows: [...v.querySelector('.m-doc .mt').children].slice(0, 9).map((r) => r.textContent) }; })()`);
      // Filter + Enter
      await js(`(() => { const i = ${V}.querySelector('.m-qin.grow'); i.value = "{ status: 'returned', hub: 'Maadi' }"; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(); 1`);
      await wait(1000);
      out.filtered = await js(`({ cards: ${V}.querySelectorAll('.m-doc').length, range: ${V}.querySelector('.m-range').textContent })`);
      // Edit the first card: change status, Ctrl+S.
      await js(`${V}.querySelector('.m-doc').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 1`);
      await wait(200);
      await js(`(() => { const ta = ${V}.querySelector('.m-editor'); ta.value = ta.value.replace("status: 'returned'", "status: 'refunded'").replace("hub: 'Maadi'", "hub: 'Maadi',\\n  note: 'box damaged'"); ta.dispatchEvent(new Event('input')); })(); 1`);
      await wait(400);
      out.editStatus = await js(`${V}.querySelector('.m-edit-status').textContent`);
      await shot('edit', ws);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); 1`);
      await wait(900);
      out.saved = await admin.db(D).collection('orders').countDocuments({ status: 'refunded', note: 'box damaged' });
      out.savedCard = await js(`[...${V}.querySelectorAll('.m-doc.saved .mt-row.changed')].map((r) => r.textContent)`);
      await shot('docs', ws);
      // Table and JSON views.
      await js(`(() => { const i = ${V}.querySelector('.m-qin.grow'); i.value = ''; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(); 1`);
      await wait(900);
      await js(`[...${V}.querySelectorAll('.seg button')].find((b) => b.textContent === 'Table').click(); 1`);
      await wait(300);
      out.table = await js(`({ heads: [...${V}.querySelectorAll('.m-table th')].map((t) => t.textContent).slice(0, 9), firstRow: [...${V}.querySelectorAll('.m-table tbody tr:first-child td')].map((t) => t.textContent).slice(0, 9) })`);
      await shot('table', ws);
      await js(`[...${V}.querySelectorAll('.seg button')].find((b) => b.textContent === 'JSON').click(); 1`);
      await wait(200);
      out.json = await js(`${V}.querySelector('.m-json').textContent.split('\\n').slice(0, 4)`);
      await js(`[...${V}.querySelectorAll('.seg button')].find((b) => b.textContent === 'List').click(); 1`);

      // Aggregations: $match + $group + $sort with previews.
      await js(`[...${V}.querySelectorAll('.m-subtab')].find((b) => b.textContent === 'Aggregations').click(); 1`);
      await wait(600);
      await js(`(() => { const ta = ${V}.querySelector('.m-stage-body'); ta.value = "{ status: 'delivered' }"; ta.dispatchEvent(new Event('input')); })(); 1`);
      await js(`[...${V}.querySelectorAll('.m-addstage .btn')][0].click(); 1`);
      await wait(100);
      await js(`(() => { const ops = ${V}.querySelectorAll('.m-stage-op'); ops[1].value = '$group'; ops[1].dispatchEvent(new Event('input')); const tas = ${V}.querySelectorAll('.m-stage-body'); tas[1].value = "{ _id: '$hub', orders: { $sum: 1 }, revenue: { $sum: '$total' } }"; tas[1].dispatchEvent(new Event('input')); })(); 1`);
      await js(`[...${V}.querySelectorAll('.m-addstage .btn')][0].click(); 1`);
      await wait(100);
      await js(`(() => { const ops = ${V}.querySelectorAll('.m-stage-op'); ops[2].value = '$sort'; ops[2].dispatchEvent(new Event('input')); const tas = ${V}.querySelectorAll('.m-stage-body'); tas[2].value = '{ revenue: -1 }'; tas[2].dispatchEvent(new Event('input')); })(); 1`);
      await wait(1800);
      out.agg = await js(`[...${V}.querySelectorAll('.m-stage-r')].map((r) => r.querySelector('.m-prev-h').textContent.replace(/ · \\d+ ms$/, '') + ' | ' + (r.querySelector('.m-mini') ? r.querySelector('.m-mini').textContent.replace(/\\s+/g, ' ').slice(0, 60) : ''))`);
      await js(`[...${V}.querySelectorAll('.r-toolbar .btn')].find((b) => b.textContent === 'Run').click(); 1`);
      await wait(1000);
      out.aggRun = await js(`${V}.querySelector('.m-aggres-h').textContent`);
      await shot('aggregation', ws);

      // Schema
      await js(`[...${V}.querySelectorAll('.m-subtab')].find((b) => b.textContent === 'Schema').click(); 1`);
      await wait(200);
      await js(`[...${V}.querySelectorAll('.r-toolbar .btn')].find((b) => b.textContent === 'Analyze').click(); 1`);
      await wait(1500);
      out.schema = await js(`[...${V}.querySelectorAll('.m-field')].map((f) => f.querySelector('.m-fname').textContent + ': ' + f.querySelector('.m-legend').textContent).slice(0, 8)`);
      await shot('schema', ws);

      // Indexes: create one through the dialog, then explain.
      await js(`[...${V}.querySelectorAll('.m-subtab')].find((b) => b.textContent === 'Indexes').click(); 1`);
      await wait(800);
      await js(`[...${V}.querySelectorAll('.r-toolbar .btn')].find((b) => /Create index/.test(b.textContent)).click(); 1`);
      await wait(200);
      await js(`(() => { const i = document.querySelector('.m-ixrow input'); i.value = 'hub'; i.dispatchEvent(new Event('input')); [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Create').click(); })(); 1`);
      await wait(1200);
      out.indexes = await js(`[...${V}.querySelectorAll('.m-ixtable tbody tr')].map((tr) => tr.children[0].textContent + ' ' + tr.children[1].textContent)`);
      await js(`[...${V}.querySelectorAll('.m-xhead .btn')].find((b) => b.textContent === 'Explain').click(); 1`);
      await wait(900);
      out.explain = await js(`[...${V}.querySelectorAll('.m-xnode b')].map((b) => b.textContent)`);
      await shot('indexes', ws);

      // Shell
      await js(`Lookup.openQueryTab(); 1`);
      await wait(900);
      const sh = async (text) => {
        await js(`(() => { const i = ${V}.querySelector('.r-term-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
        await wait(700);
      };
      out.prompt = await js(`${V}.querySelector('.r-prompt').textContent`);
      await js(`(() => { const i = ${V}.querySelector('.r-term-input'); i.value = 'db.orders.find({ a: 1 }, '; i.dispatchEvent(new Event('input')); })(); 1`);
      out.ghost = await js(`${V}.querySelector('.r-ghost').textContent`);
      await sh('show collections');
      await sh("db.orders.find({ status: 'pending' }, { orderNo: 1, total: 1, _id: 0 }).sort({ orderNo: 1 }).limit(2)");
      await sh("db.orders.countDocuments({ hub: 'Zamalek' })");
      await sh("db.customers.updateOne({ name: 'Omar' }, { $set: { tier: 'gold' } })");
      await sh('var x = 1');
      out.shell = await js(`[...${V}.querySelectorAll('.r-tl')].slice(1).map((x) => x.textContent)`);
      await shot('shell', ws);

      // Overview
      await win.webContents.executeJavaScript(`document.querySelector('#shell-actions [title^="Overview"]').click()`);
      await wait(1500);
      out.overview = await js(`({ cards: [...${V}.querySelectorAll('.r-card-title')].map((x) => x.textContent), server: [...${V}.querySelectorAll('.r-kv td:first-child')].map((x) => x.textContent).slice(-6) })`);
      await shot('overview', ws);

      // Production: inserting asks first; Cancel sends nothing.
      const before = views().map((v) => v.id);
      await js(`window.api.openConnection(${JSON.stringify(prodId)}); 1`);
      await wait(3000);
      const pv = views().find((x) => !before.includes(x.id));
      const pj = (code) => pv.executeJavaScript(code);
      await pj(`Lookup.openMongoShell(); 1`);
      await wait(800);
      await pj(`(() => { const i = document.querySelector('.tabview:not(.hidden) .r-term-input'); i.value = "db.events.insertOne({ kind: 'test' })"; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
      await wait(800);
      out.prodAsk = await pj(`({ title: (document.querySelector('.modal-title') || {}).textContent, cmds: (document.querySelector('.r-confirm-cmds') || {}).textContent })`);
      await shot('production', pv);
      await pj(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Cancel').click(); 1`);
      await wait(500);
      out.prodNotSent = [await pj(`[...document.querySelectorAll('.tabview:not(.hidden) .r-tl')].pop().textContent`), await admin.db('lookup_smoke_prod').collection('events').countDocuments()];
      pv.on('console-message', (_ev, level, message) => { if (level >= 3) errors.push(message); });
      out.errors = errors;
      console.log('SMOKE-MONGODB', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-MONGODB FAILED', e.stack.split('\n').slice(0, 3).join(' | ')); console.log('SMOKE-MONGODB', JSON.stringify(out)); }
    if (admin) { await admin.db(D).dropDatabase().catch(() => {}); await admin.db('lookup_smoke_prod').dropDatabase().catch(() => {}); await admin.close(); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
