// The real app against real PostgreSQL and MySQL / MariaDB servers (no stubs): choose-database cards,
// the form per engine, badges, connecting, sidebar sections, read-only table data, queries,
// transactions, Explain, Beautify, DDL and the databases menu. Skips when the servers aren't running.
// Run: xvfb-run -a npx electron test/smoke-engines.js --no-sandbox   (SHOTS=<dir> also saves screenshots)
// Servers: LOOKUP_PG_URL (default postgres://lookup:lookup@127.0.0.1:5432/shop),
//          LOOKUP_MYSQL_URL (default mysql://lookup:lookup@127.0.0.1:3306)
const path = require('path');
const fs = require('fs');
const electron = require('electron');
const { app, webContents, nativeTheme } = electron;
const { menuItems } = require('./menu-helper');
const { split } = require('../src/shared/sqlsplit');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-engines'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
require('../src/main/main.js');

const PG = new URL(process.env.LOOKUP_PG_URL || 'postgres://lookup:lookup@127.0.0.1:5432/shop');
const MY = new URL(process.env.LOOKUP_MYSQL_URL || 'mysql://lookup:lookup@127.0.0.1:3306');
const CH = new URL(process.env.LOOKUP_CH_URL || 'http://lookup:lookup@127.0.0.1:8123');
const SQLITE_FILE = path.join(app.getPath('temp'), 'lookup-smoke-shop.db');
const SHOTS = process.env.SHOTS;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const views = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html') && !w.isDestroyed());
// Grid edit in the open table tab: first row, one column, typed and Enter; then Ctrl+S commits.
const GRID_EDIT = (col, value) => `(() => { const t = Lookup.S.tabs.find((x) => x.id === Lookup.S.active); const g = t.grid;
  g.edit(0, g.columns.findIndex((x) => x.name === ${JSON.stringify(col)})); const i = document.querySelector('.tabview:not(.hidden) .cell-edit');
  i.value = ${JSON.stringify(value)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return g.changeCount(); })()`;
const CTRL_S = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); 1`;
const LAST_TOAST = `[...document.querySelectorAll('.toast')].map((x) => x.textContent).pop() || null`;
// Table design in the window: New table (name + one typed column) → Create; Structure: add a column → Apply;
// sidebar: Delete table… → confirm. Returns what each step showed.
async function designFlow(run, shot, types) {
  const r = {};
  // Production connections ask first (the name is typed for destructive actions): answer and note the question.
  const answerProd = async (key) => {
    const q = await run(`(() => { const m = document.querySelector('.modal'); if (!m || !/Production/.test(m.textContent)) return null;
      m.querySelectorAll('input.input, input[type=text]').forEach((i) => { i.value = 'smoke_design'; i.dispatchEvent(new Event('input')); });
      const t = m.querySelector('h2, .modal-title, .modal-head'); const text = t ? t.textContent : m.textContent.slice(0, 40);
      (m.querySelector('.btn.danger') || m.querySelector('.btn.primary')).click(); return text; })()`);
    if (q) { (r.prodAsked = r.prodAsked || {})[key] = q; await wait(1500); }
  };
  const act = `Lookup.S.tabs.find((t) => t.id === Lookup.S.active).el`;
  await run(`Lookup.openCreateTable(); 1`);
  await wait(500);
  r.firstColumn = await run(`[...${act}.querySelectorAll('.ct-row:not(.ghost) .ct-cell')].slice(0, 2).map((i) => i.value)`);
  await run(`(() => { const el = ${act}; const n = el.querySelector('.ct-name'); n.value = 'smoke_design'; n.dispatchEvent(new Event('input'));
    const g = el.querySelector('.ct-row.ghost .ct-cell'); g.value = 'title'; g.dispatchEvent(new Event('input')); })(); 1`);
  await wait(200);
  await run(`(() => { const rows = ${act}.querySelectorAll('.ct-row:not(.ghost)'); const t = rows[rows.length - 1].querySelectorAll('.ct-cell')[1]; t.value = ${JSON.stringify(types.text)}; t.dispatchEvent(new Event('input')); })(); 1`);
  await shot('new-table');
  await run(`${act}.querySelector('.ct-foot .btn.primary').click(); 1`);
  await wait(400);
  await answerProd('create');
  await wait(1400);
  r.created = { toast: await run(LAST_TOAST), tab: await run(`Lookup.S.tabs.find((t) => t.id === Lookup.S.active).title`) };
  const createError = await run(`(${act}.querySelector('.ct-errors:not(.hidden)') || {}).textContent || ''`);
  if (createError) throw new Error('Create table failed: ' + createError);
  // Structure: add a column and apply.
  await run(`[...${act}.querySelectorAll('.se-h .btn')].find((b) => b.textContent.includes('Column')).click(); 1`);
  await wait(200);
  await run(`(() => { const rows = ${act}.querySelectorAll('.se-cols tr.added'); const ins = rows[rows.length - 1].querySelectorAll('.se-in');
    ins[0].value = 'qty'; ins[0].dispatchEvent(new Event('input')); ins[1].value = ${JSON.stringify(types.int)}; ins[1].dispatchEvent(new Event('input')); })(); 1`);
  await wait(200);
  r.pending = await run(`${act}.querySelector('.se-bar').textContent`);
  await shot('structure-edit');
  await run(`${act}.querySelector('.se-bar .btn.primary').click(); 1`);
  await wait(400);
  await answerProd('apply');
  await wait(1400);
  r.applied = { toast: await run(LAST_TOAST), columns: await run(`[...${act}.querySelectorAll('.se-cols tbody tr')].map((tr) => tr.querySelector('.se-in').value)`) };
  // Sidebar: Delete table… and confirm.
  await run(`(() => { const it = [...document.querySelectorAll('#tree .tree-item')].find((x) => x.title === 'smoke_design'); it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 })); })(); 1`);
  await wait(200);
  r.menu = await run(`[...document.querySelectorAll('.ctx .ctx-item')].map((x) => x.textContent).filter((t) => /table/i.test(t))`);
  await run(`[...document.querySelectorAll('.ctx .ctx-item')].find((x) => x.textContent.startsWith('Delete table')).click(); 1`);
  await wait(300);
  r.dropDialog = await run(`[...document.querySelectorAll('.modal .check span')].map((x) => x.textContent)`);
  if (await run(`/Production/.test(document.querySelector('.modal').textContent)`)) await answerProd('drop');
  else { await run(`document.querySelector('.modal .btn.danger').click(); 1`); await wait(1500); }
  r.dropped = { toast: await run(LAST_TOAST), stillListed: await run(`[...document.querySelectorAll('#tree .tree-item')].some((x) => x.title === 'smoke_design')`) };
  return r;
}


async function loadFixtures() {
  const { Client } = require('pg');
  const pg = new Client({ connectionString: PG.toString() });
  await pg.connect();
  await pg.query(fs.readFileSync(path.join(__dirname, 'fixtures/pg-test.sql'), 'utf8'));
  await pg.end();
  const my = await require('mysql2/promise').createConnection({ host: MY.hostname, port: Number(MY.port) || 3306, user: MY.username, password: MY.password });
  for (const st of split(fs.readFileSync(path.join(__dirname, 'fixtures/mysql-test.sql'), 'utf8'), 'mysql')) await my.query(st.text);
  await my.end();
  // SQLite: a small file built with Electron's own SQLite.
  fs.rmSync(SQLITE_FILE, { force: true });
  const { DatabaseSync } = require('node:sqlite');
  const lite = new DatabaseSync(SQLITE_FILE);
  lite.exec(`CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT);
    CREATE TABLE albums (id INTEGER PRIMARY KEY, artist_id INTEGER REFERENCES artists (id), title TEXT, year INTEGER, cover BLOB);
    CREATE INDEX albums_year ON albums (year);
    CREATE VIEW recent AS SELECT * FROM albums WHERE year >= 2000;
    CREATE TRIGGER albums_touch AFTER UPDATE ON albums BEGIN SELECT 1; END;
    WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 50) INSERT INTO artists SELECT n, 'Artist ' || n, CASE n % 2 WHEN 0 THEN 'EG' ELSE 'UK' END FROM g;
    WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 400) INSERT INTO albums SELECT n, 1 + n % 50, 'Album ' || n, 1970 + n % 55, x'CAFE' FROM g;`);
  lite.close();
  // ClickHouse: the engine test's fixture.
  const ch = require('@clickhouse/client').createClient({ url: `${CH.protocol}//${CH.host}`, username: CH.username, password: CH.password });
  for (const st of split(fs.readFileSync(path.join(__dirname, 'fixtures/clickhouse-test.sql'), 'utf8'), 'clickhouse')) await ch.command({ query: st.text });
  await ch.close();
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    const errors = [];
    let n = 0;
    const shot = async (name, ws) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await wait(300);
      const a = await win.webContents.capturePage();
      const b = await ws.capturePage();
      const tag = `${process.env.THEME || 'light'}-${String(++n).padStart(2, '0')}-${name}`;
      fs.writeFileSync(path.join(SHOTS, `${tag}-shell.png`), a.toPNG());
      fs.writeFileSync(path.join(SHOTS, `${tag}-ws.png`), b.toPNG());
    };
    try {
      try { await loadFixtures(); } catch (e) { console.log(`SMOKE-ENGINES skipped: ${e.message}`); app.exit(0); return; }
      win.setSize(1280, 860);
      await wait(1500);
      const [ws] = views();
      ws.on('console-message', (_ev, level, message) => { if (level >= 3) errors.push(message); });
      const js = (code) => ws.executeJavaScript(code);
      const pgId = await js(`window.api.saveConnection(${JSON.stringify({ engine: 'postgres', name: 'Shop (Postgres)', env: 'staging', host: PG.hostname, port: Number(PG.port) || 5432, database: PG.pathname.slice(1), user: PG.username, password: PG.password, ssl: 'prefer' })})`);
      const myId = await js(`window.api.saveConnection(${JSON.stringify({ engine: 'mysql', name: 'Shop (MariaDB)', env: 'local', host: MY.hostname, port: Number(MY.port) || 3306, database: 'lookup_test', user: MY.username, password: MY.password, ssl: 'prefer' })})`);
      await js(`window.api.saveConnection({ name: 'HR Dev', env: 'dev', host: 'db-dev.example.com', service: 'HRDEV', user: 'hr', password: 'p' })`);
      const liteId = await js(`window.api.saveConnection(${JSON.stringify({ engine: 'sqlite', name: 'Music (SQLite)', env: 'local', file: SQLITE_FILE, readOnly: false, mode: 'basic' })})`);
      const chId = await js(`window.api.saveConnection(${JSON.stringify({ engine: 'clickhouse', name: 'Events (ClickHouse)', env: 'prod', host: CH.hostname, port: Number(CH.port) || 8123, database: 'lookup_test', user: CH.username, password: CH.password, ssl: 'disable', autoCommit: true })})`);
      await js(`Lookup.showWelcome()`);
      await wait(400);
      out.list = await js(`[...document.querySelectorAll('.conn-item')].map((x) => x.querySelector('.conn-badge').textContent + ' ' + x.querySelector('.conn-item-name').firstChild.textContent + ' | ' + x.querySelector('.conn-item-sub').textContent)`);

      // New: choose the database, then the form for that engine.
      await js(`[...document.querySelectorAll('.welcome-head .btn')].find((b) => /New/.test(b.textContent)).click(); 1`);
      await wait(200);
      out.cards = await js(`[...document.querySelectorAll('.choose-card')].map((c) => c.querySelector('.choose-name').textContent + (c.classList.contains('on') ? '*' : ''))`);
      await js(`document.querySelector('.choose-card[data-engine=postgres]').click(); 1`);
      await shot('choose-database', ws);
      await js(`[...document.querySelectorAll('.choose-actions .btn')].find((b) => b.textContent === 'Continue').click(); 1`);
      await wait(200);
      const formInfo = `({ labels: [...document.querySelectorAll('.conn-form .field-label')].map((l) => l.textContent), type: document.querySelector('.type-chip.on').textContent, port: [...document.querySelectorAll('.conn-form .field')].find((f) => f.querySelector('.field-label').textContent === 'Port').querySelector('input').value, seg: [...document.querySelectorAll('.conn-form .seg button')].map((b) => b.textContent) })`;
      out.pgForm = await js(formInfo);
      await js(`[...document.querySelectorAll('.type-chip')].find((b) => /MySQL/.test(b.textContent)).click(); 1`);
      await wait(150);
      out.mysqlForm = await js(formInfo);
      await js(`[...document.querySelectorAll('.type-chip')].find((b) => /Oracle/.test(b.textContent)).click(); 1`);
      await wait(150);
      out.oracleForm = await js(formInfo);
      await js(`[...document.querySelectorAll('.type-chip')].find((b) => /SQLite/.test(b.textContent)).click(); 1`);
      await wait(150);
      out.sqliteForm = await js(`({ labels: [...document.querySelectorAll('.conn-form .field-label')].map((l) => l.textContent), buttons: [...document.querySelectorAll('.file-row .btn')].map((b) => b.textContent), seg: !!document.querySelector('.conn-form .seg'), checks: [...document.querySelectorAll('.conn-form .check span')].map((s) => s.textContent) })`);
      await js(`[...document.querySelectorAll('.type-chip')].find((b) => /ClickHouse/.test(b.textContent)).click(); 1`);
      await wait(150);
      out.clickhouseForm = await js(formInfo);
      out.clickhouseNote = await js(`(document.querySelector('.checks-row .muted') || {}).textContent`);
      // Test from the form of the saved PostgreSQL connection.
      await js(`[...document.querySelectorAll('.conn-item')].find((x) => /Postgres/.test(x.textContent)).click(); 1`);
      await wait(200);
      // No OS keychain in CI, so passwords aren't saved: type it, as a user would.
      await js(`(() => { const i = document.querySelector('.pw-wrap input'); i.value = ${JSON.stringify(PG.password)}; i.dispatchEvent(new Event('input')); })(); 1`);
      await js(`[...document.querySelectorAll('.form-actions .btn')].find((b) => b.textContent === 'Test').click(); 1`);
      await wait(1500);
      out.pgTest = await js(`document.querySelector('.form-status').textContent`);
      await shot('postgres-form', ws);

      // Connect to PostgreSQL.
      const typePassword = (run, pw) => run(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = ${JSON.stringify(pw)}; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`);
      await js(`Lookup.connectTo(${JSON.stringify(pgId)}); 1`);
      await wait(500);
      await typePassword(js, PG.password);
      await wait(2000);
      out.pgInfo = await js(`({ id: Lookup.engineId(), label: Lookup.profile().label, schema: Lookup.S.schema, status: document.querySelector('#statusbar').textContent })`);
      await js(`window.Lookup.S.schema = 'lookup_test'; Lookup.paintSchemaSelect(); Lookup.loadObjects(); 1`);
      await wait(800);
      out.pgSections = await js(`[...document.querySelectorAll('.tree-head > span:not(.count)')].map((s) => s.textContent + ' ' + s.parentNode.querySelector('.count').textContent)`);
      out.pgSchemaGroups = await js(`[...document.querySelectorAll('#schema-select optgroup')].map((g) => g.label)`);
      out.rail = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.rail-tile')].map((t) => t.querySelector('.rail-name').textContent)`);
      out.titleMeta = await win.webContents.executeJavaScript(`document.querySelector('#active-conn .meta').textContent`);
      out.dbButton = await win.webContents.executeJavaScript(`(document.querySelector('[title^="Databases on this server"]') || {}).title || null`);
      await js(`Lookup.openTableTab('lookup_test', 'orders', 'TABLE', 'data'); 1`);
      await wait(1200);
      out.pgTable = await js(`(() => { const t = document.querySelector('.tabview:not(.hidden)') || document; return {
        note: (document.querySelector('.ro-note:not(.hidden)') || {}).textContent,
        pager: document.querySelector('.pager-info').textContent,
        addRowButton: !!document.querySelector('.tools [title="Add row"]'),
        heads: [...document.querySelectorAll('.grid .hd .hd-name, .grid th')].slice(0, 4).map((x) => x.textContent) }; })()`);
      await shot('postgres-table', ws);
      // Grid edit + commit, checked from another connection.
      await js(`Lookup.openTableTab('lookup_test', 'customers', 'TABLE', 'data'); 1`);
      await wait(1000);
      out.pgEdit = { pending: await js(GRID_EDIT('city', 'Edited in grid')), bar: await js(`document.querySelector('.tabview:not(.hidden) .changes').textContent`) };
      await shot('postgres-edit', ws);
      await js(CTRL_S);
      await wait(1200);
      out.pgEdit.toast = await js(LAST_TOAST);
      { const { Client } = require('pg'); const c = new Client({ connectionString: PG.toString() }); await c.connect(); out.pgEdit.saved = (await c.query('SELECT city FROM lookup_test.customers WHERE id = 1')).rows[0].city; await c.end(); }
      await js(`Lookup.openTableTab('lookup_test', 'audit_log', 'TABLE', 'data'); 1`);
      await wait(1000);
      out.pgNoKey = await js(`({ note: (document.querySelector('.tabview:not(.hidden) .ro-note:not(.hidden)') || {}).textContent, addDisabled: document.querySelector('.tabview:not(.hidden) .tools [title="Add row"]').disabled })`);
      await shot('postgres-nokey', ws);
      out.pgDesign = await designFlow(js, (n) => shot('postgres-' + n, ws), { text: 'varchar(50)', int: 'integer' });
      await js(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Structure').click(); 1`);
      await wait(800);
      out.pgStructure = await js(`({ editor: !!document.querySelector('.se-bar'), h3: [...document.querySelectorAll('.view-structure h3')].map((x) => x.textContent) })`);
      await js(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'DDL').click(); 1`);
      await wait(800);
      out.pgDdl = await js(`({ first: document.querySelector('.view-ddl:not(.hidden) .ddl-code').textContent.split('\\n')[0], options: [...document.querySelectorAll('.view-ddl:not(.hidden) .ddl-opts label')].map((l) => l.textContent) })`);

      // Query tab: rows, a change (transaction), Ctrl+S commit, Explain, Beautify.
      await js(`Lookup.openQueryTab({ text: "select id, name, city from lookup_test.customers order by id;\\nupdate lookup_test.customers set city = 'Luxor' where id = 1;" }); 1`);
      await wait(400);
      await js(`(() => { const t = Lookup.S.tabs.find((x) => x.id === Lookup.S.active); t.editor.ta.setSelectionRange(0, 0); })(); 1`);
      await js(`document.querySelector('.tabview:not(.hidden) .toolbar .btn.primary').click(); 1`);
      await wait(1200);
      out.pgQuery = await js(`({ foot: document.querySelector('.tabview:not(.hidden) .pager').textContent, status: document.querySelector('#statusbar').textContent })`);
      await js(`[...document.querySelectorAll('.tabview:not(.hidden) .toolbar button')].find((b) => /Run all/.test(b.title || b.textContent)).click(); 1`);
      await wait(1500);
      out.pgTx = await js(`document.querySelector('#statusbar').textContent`);
      await shot('postgres-query', ws);
      await js(`Lookup.commitShortcut(); 1`);
      await wait(800);
      out.pgAfterCommit = await js(`document.querySelector('#statusbar').textContent`);
      await js(`(() => { const t = Lookup.S.tabs.find((x) => x.id === Lookup.S.active); t.editor.value = 'select * from lookup_test.orders where id = 1'; t.editor.ta.setSelectionRange(5, 5); })(); 1`);
      await js(`[...document.querySelectorAll('.tabview:not(.hidden) .toolbar button')].find((b) => b.textContent === 'Explain').click(); 1`);
      await wait(1200);
      out.pgExplain = await js(`(document.querySelector('.tabview:not(.hidden) .res-body') || {}).textContent.slice(0, 60)`);
      await js(`(() => { const t = Lookup.S.tabs.find((x) => x.id === Lookup.S.active); t.editor.value = 'select a::int, b from t where x = 1'; })(); 1`);
      await js(`Lookup.S.tabs.find((x) => x.id === Lookup.S.active).editor.ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true })); 1`);
      await wait(800);
      out.pgBeautify = await js(`Lookup.S.tabs.find((x) => x.id === Lookup.S.active).editor.value`);
      // Databases menu (PostgreSQL databases on the server).
      await win.webContents.executeJavaScript(`document.querySelector('[title^="Databases on this server"]').click()`);
      await wait(600);
      out.pgDatabases = ((await menuItems())[0] || []).filter((x) => /shop|postgres/.test(x));
      await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`).catch(() => {});

      // MySQL / MariaDB in a second tab.
      await js(`window.api.openConnection(${JSON.stringify(myId)}); 1`);
      await wait(2500);
      const my = views().find((v) => v.id !== ws.id);
      const mj = (code) => my.executeJavaScript(code);
      await typePassword(mj, MY.password);
      await wait(2500);
      out.myInfo = await mj(`({ id: Lookup.engineId(), label: Lookup.profile().label, schema: Lookup.S.schema, status: document.querySelector('#statusbar').textContent })`);
      out.mySections = await mj(`[...document.querySelectorAll('.tree-head > span:not(.count)')].map((s) => s.textContent + ' ' + s.parentNode.querySelector('.count').textContent)`);
      out.rail2 = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.rail-tile')].map((t) => t.querySelector('.rail-name').textContent)`);
      out.myDbButton = await win.webContents.executeJavaScript(`!!document.querySelector('[title^="Databases on this server"]')`);
      await mj(`Lookup.openTableTab('lookup_test', 'orders', 'TABLE', 'data'); 1`);
      await wait(1200);
      out.myTable = await mj(`({ note: (document.querySelector('.ro-note:not(.hidden)') || {}).textContent, pager: document.querySelector('.pager-info').textContent })`);
      await shot('mysql-table', my);
      await mj(`Lookup.openTableTab('lookup_test', 'customers', 'TABLE', 'data'); 1`);
      await wait(1000);
      out.myEdit = { pending: await mj(GRID_EDIT('city', 'Edited in grid')) };
      await mj(CTRL_S);
      await wait(1200);
      out.myEdit.toast = await mj(LAST_TOAST);
      { const c = await require('mysql2/promise').createConnection({ host: MY.hostname, port: Number(MY.port) || 3306, user: MY.username, password: MY.password }); out.myEdit.saved = (await c.query('SELECT city FROM lookup_test.customers WHERE id = 1'))[0][0].city; await c.end(); }
      out.myDesign = await designFlow(mj, (n) => shot('mysql-' + n, my), { text: 'VARCHAR(50)', int: 'INT' });
      await mj(`Lookup.openQueryTab({ text: "select id, amount, status from orders order by id" }); 1`);
      await wait(400);
      await mj(`document.querySelector('.tabview:not(.hidden) .toolbar .btn.primary').click(); 1`);
      await wait(1200);
      out.myQuery = await mj(`document.querySelector('.tabview:not(.hidden) .pager').textContent`);
      await mj(`Lookup.openDdlTab('lookup_test', { name: 'touch_log', type: 'PROCEDURE' }); 1`);
      await wait(800);
      out.myDdl = await mj(`document.querySelector('.tabview:not(.hidden) .ddl-code').textContent.split('\\n').slice(0, 2).join(' | ')`);
      await shot('mysql-ddl', my);
      my.on('console-message', (_ev, level, message) => { if (level >= 3) errors.push(message); });

      // SQLite and ClickHouse in two more tabs (no password prompt for a file).
      const openTab = async (id, pw) => {
        const before = views().map((v) => v.id);
        await js(`window.api.openConnection(${JSON.stringify(id)}); 1`);
        await wait(2500);
        const v = views().find((x) => !before.includes(x.id));
        if (pw !== undefined) { await typePassword((code) => v.executeJavaScript(code), pw); await wait(2500); }
        v.on('console-message', (_ev, level, message) => { if (level >= 3) errors.push(message); });
        const run = (code) => v.executeJavaScript(code).catch((e) => { throw new Error(`${e.message} — in: ${code.slice(0, 90)}`); });
        run.view = v;
        return run;
      };
      const lj = await openTab(liteId);
      out.liteInfo = await lj(`({ id: Lookup.engineId(), schema: Lookup.S.schema, status: document.querySelector('#statusbar').textContent, schemas: [...document.querySelectorAll('#schema-select option')].map((o) => o.value) })`);
      out.liteSections = await lj(`[...document.querySelectorAll('.tree-head > span:not(.count)')].map((s) => s.textContent + ' ' + s.parentNode.querySelector('.count').textContent)`);
      await lj(`Lookup.openTableTab('main', 'albums', 'TABLE', 'data'); 1`);
      await wait(1000);
      out.liteTable = await lj(`({ note: (document.querySelector('.ro-note:not(.hidden)') || {}).textContent, pager: document.querySelector('.pager-info').textContent })`);
      await shot('sqlite-table', lj.view);
      out.liteEdit = { pending: await lj(GRID_EDIT('title', 'Edited in grid')) };
      await lj(CTRL_S);
      await wait(1200);
      out.liteEdit.toast = await lj(LAST_TOAST);
      { const { DatabaseSync } = require('node:sqlite'); const f = new DatabaseSync(SQLITE_FILE, { readOnly: true }); out.liteEdit.saved = f.prepare('SELECT title FROM albums WHERE id = 1').get().title; f.close(); }
      out.liteDesign = await designFlow(lj, (n) => shot('sqlite-' + n, lj.view), { text: 'TEXT', int: 'INTEGER' });
      await lj(`Lookup.openQueryTab({ text: "select country, count(*) n from artists group by country order by country;\\nupdate artists set country = 'FR' where id = 1;" }); 1`);
      await wait(400);
      await lj(`Lookup.S.tabs.find((x) => x.id === Lookup.S.active).editor.ta.setSelectionRange(0, 0); 1`);
      await lj(`document.querySelector('.tabview:not(.hidden) .toolbar .btn.primary').click(); 1`);
      await wait(1000);
      out.liteQuery = await lj(`(() => { const t = Lookup.S.tabs.find((x) => x.id === Lookup.S.active); return document.querySelector('.tabview:not(.hidden) .pager').textContent + ' | ' + JSON.stringify(t.results.map((r) => [r.kind, r.message || (r.rows || []).length])); })()`);
      await lj(`[...document.querySelectorAll('.tabview:not(.hidden) .toolbar button')].find((b) => /Run all/.test(b.title || b.textContent)).click(); 1`);
      await wait(1200);
      out.liteTx = await lj(`document.querySelector('#statusbar').textContent`);
      await lj(`Lookup.commitShortcut(); 1`);
      await wait(600);
      out.liteAfterCommit = await lj(`document.querySelector('#statusbar').textContent`);

      const cj = await openTab(chId, CH.password);
      out.chInfo = await cj(`({ id: Lookup.engineId(), schema: Lookup.S.schema, autoCommit: Lookup.S.autoCommit, status: document.querySelector('#statusbar').textContent })`);
      out.chSections = await cj(`[...document.querySelectorAll('.tree-head > span:not(.count)')].map((s) => s.textContent + ' ' + s.parentNode.querySelector('.count').textContent)`);
      await cj(`Lookup.openTableTab('lookup_test', 'events', 'TABLE', 'data'); 1`);
      await wait(1200);
      out.chTable = await cj(`({ note: (document.querySelector('.ro-note:not(.hidden)') || {}).textContent, pager: document.querySelector('.pager-info').textContent })`);
      await cj(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Structure').click(); 1`);
      await wait(800);
      out.chStructure = await cj(`[...document.querySelectorAll('.view-structure h3')].map((x) => x.textContent)`);
      out.chDesign = await designFlow(cj, (n) => shot('clickhouse-' + n, cj.view), { text: 'String', int: 'Int32' });
      await cj(`Lookup.openQueryTab({ text: "select kind, count() n, sum(amount) total from events group by kind order by kind" }); 1`);
      await wait(400);
      await cj(`document.querySelector('.tabview:not(.hidden) .toolbar .btn.primary').click(); 1`);
      await wait(1200);
      await shot('clickhouse-query', cj.view);
      out.chQuery = await cj(`({ foot: document.querySelector('.tabview:not(.hidden) .pager').textContent, cells: [...document.querySelectorAll('.tabview:not(.hidden) .grid .cell')].slice(0, 3).map((c) => c.textContent), status: document.querySelector('#statusbar').textContent })`);
      out.rail3 = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.rail-tile')].map((t) => t.querySelector('.rail-name').textContent)`);
      out.errors = errors;
      console.log('SMOKE-ENGINES', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-ENGINES FAILED', e.stack, JSON.stringify({ ...out, errors })); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
