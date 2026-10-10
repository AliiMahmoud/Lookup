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
      out.pgSections = await js(`[...document.querySelectorAll('.tree-head span:not(.count)')].map((s) => s.textContent + ' ' + s.parentNode.querySelector('.count').textContent)`);
      out.pgSchemaGroups = await js(`[...document.querySelectorAll('#schema-select optgroup')].map((g) => g.label)`);
      out.rail = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.rail-tile')].map((t) => t.querySelector('.rail-name').textContent)`);
      out.titleMeta = await win.webContents.executeJavaScript(`document.querySelector('#active-conn .meta').textContent`);
      out.dbButton = await win.webContents.executeJavaScript(`(document.querySelector('[title^="Databases on this server"]') || {}).title || null`);
      await js(`Lookup.openTableTab('lookup_test', 'orders', 'TABLE', 'data'); 1`);
      await wait(1200);
      out.pgTable = await js(`(() => { const t = document.querySelector('.tabview:not(.hidden)') || document; return {
        note: (document.querySelector('.ro-note') || {}).textContent,
        pager: document.querySelector('.pager-info').textContent,
        addRowButton: !!document.querySelector('.tools [title="Add row"]'),
        heads: [...document.querySelectorAll('.grid .hd .hd-name, .grid th')].slice(0, 4).map((x) => x.textContent) }; })()`);
      await shot('postgres-table', ws);
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
      out.mySections = await mj(`[...document.querySelectorAll('.tree-head span:not(.count)')].map((s) => s.textContent + ' ' + s.parentNode.querySelector('.count').textContent)`);
      out.rail2 = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.rail-tile')].map((t) => t.querySelector('.rail-name').textContent)`);
      out.myDbButton = await win.webContents.executeJavaScript(`!!document.querySelector('[title^="Databases on this server"]')`);
      await mj(`Lookup.openTableTab('lookup_test', 'orders', 'TABLE', 'data'); 1`);
      await wait(1200);
      out.myTable = await mj(`({ note: (document.querySelector('.ro-note') || {}).textContent, pager: document.querySelector('.pager-info').textContent })`);
      await shot('mysql-table', my);
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
      out.liteSections = await lj(`[...document.querySelectorAll('.tree-head span:not(.count)')].map((s) => s.textContent + ' ' + s.parentNode.querySelector('.count').textContent)`);
      await lj(`Lookup.openTableTab('main', 'albums', 'TABLE', 'data'); 1`);
      await wait(1000);
      out.liteTable = await lj(`({ note: (document.querySelector('.ro-note') || {}).textContent, pager: document.querySelector('.pager-info').textContent })`);
      await shot('sqlite-table', lj.view);
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
      out.chSections = await cj(`[...document.querySelectorAll('.tree-head span:not(.count)')].map((s) => s.textContent + ' ' + s.parentNode.querySelector('.count').textContent)`);
      await cj(`Lookup.openTableTab('lookup_test', 'events', 'TABLE', 'data'); 1`);
      await wait(1200);
      out.chTable = await cj(`({ note: (document.querySelector('.ro-note') || {}).textContent, pager: document.querySelector('.pager-info').textContent })`);
      await cj(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Structure').click(); 1`);
      await wait(800);
      out.chStructure = await cj(`[...document.querySelectorAll('.view-structure h3')].map((x) => x.textContent)`);
      await cj(`Lookup.openQueryTab({ text: "select kind, count() n, sum(amount) total from events group by kind order by kind" }); 1`);
      await wait(400);
      await cj(`document.querySelector('.tabview:not(.hidden) .toolbar .btn.primary').click(); 1`);
      await wait(1200);
      await shot('clickhouse-query', cj.view);
      out.chQuery = await cj(`({ foot: document.querySelector('.tabview:not(.hidden) .pager').textContent, cells: [...document.querySelectorAll('.tabview:not(.hidden) .grid .cell')].slice(0, 3).map((c) => c.textContent), status: document.querySelector('#statusbar').textContent })`);
      out.rail3 = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.rail-tile')].map((t) => t.querySelector('.rail-name').textContent)`);
      out.errors = errors;
      console.log('SMOKE-ENGINES', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-ENGINES FAILED', e.stack, JSON.stringify(out)); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
