// Persisted Queries in the real app: the title-bar button opens one query tab per connection whose
// text and look (cursor, scroll, zoom, row limit, editor height) are saved as you work; closing and
// reopening it, or disconnecting and connecting again, shows it exactly as it was.
// Run: npx electron test/smoke-persisted.js
// Servers from test/docker: Oracle on 1522 and PostgreSQL on 5432 (skips when Oracle does not answer).
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');

app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-persisted'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ORACLE = { name: 'pq-oracle', engine: 'oracle', host: '127.0.0.1', port: 1522, service: 'FREEPDB1', user: 'lookup', password: 'lookup' };
const PG = { name: 'pq-pg', engine: 'postgres', host: '127.0.0.1', port: 5432, database: 'shop', user: 'lookup', password: 'lookup', ssl: 'prefer' };
const TEXT = Array.from({ length: 120 }, (_, i) => `-- line ${i + 1}`).join('\n') + '\nselect 42 as answer from dual\n';

let passed = 0;
const failures = [];
// Look without the (long) text, for failure messages.
const brief = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'text' ? `${String(v).length} chars` : brief(v)])) : o);
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('  ok  ', name); } else { failures.push(name); console.log('  FAIL', name, detail !== undefined ? '\n    ' + JSON.stringify(brief(detail)).slice(0, 700) : ''); }
};

// What the Persisted Queries tab shows right now.
const LOOK = `(() => { const t = Lookup.S.tabs.find((x) => x.persisted); if (!t) return null; const ta = t.editor.ta;
  return { title: t.title, active: Lookup.S.active === t.id, text: ta.value, sel: [ta.selectionStart, ta.selectionEnd], scroll: ta.scrollTop,
    zoom: t.editor.zoom, maxRows: t.parts.maxRows.value, edHeight: t.parts.edHost.style.flexBasis,
    count: Lookup.S.tabs.filter((x) => x.persisted).length }; })()`;
const BUTTON = `[...document.querySelectorAll('.tb-btn')].find((b) => b.textContent.includes('Persisted Queries'))`;
const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'persisted-queries.json'), 'utf8')); } catch { return {}; } };

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    let code = 0;
    try {
      await wait(1500);
      const view = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      const js = (s) => view.executeJavaScript(s);
      const shell = (s) => win.webContents.executeJavaScript(s); // the window's title bar
      const connect = async (id) => {
        await js(`Lookup.connectTo(${JSON.stringify(id)}); 1`);
        for (let i = 0; i < 60 && !(await js('!!(Lookup.S.current && Lookup.S.info)')); i++) await wait(250);
        await wait(1200);
      };
      const ids = await js(`(async () => [await api.saveConnection(${JSON.stringify(ORACLE)}), await api.saveConnection(${JSON.stringify(PG)})])()`);
      const [oraId, pgId] = ids.map((x) => (x && x.id) || x);
      await connect(oraId);
      if (!(await js('!!Lookup.S.current'))) { console.log('Oracle not answering: skipped'); app.exit(0); return; }

      await wait(500);
      check('the title bar has a Persisted Queries button right after Query', await shell(`(() => { const b = ${BUTTON}; return !!b && b.previousElementSibling.textContent.trim() === 'Query'; })()`));
      await shell(`${BUTTON}.click(); 1`);
      await wait(800);
      let look = await js(LOOK);
      check('the button opens the Persisted Queries tab, empty the first time', look && look.title === 'Persisted Queries' && look.active && look.text === '', look);

      // Work in it: text, cursor on the SELECT, scroll, zoom, row limit, editor height; run the statement.
      await js(`(async () => { const t = Lookup.S.tabs.find((x) => x.persisted); const ta = t.editor.ta;
        ta.value = ${JSON.stringify(TEXT)}; ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
        const at = ta.value.indexOf('select 42') + 3; ta.setSelectionRange(at, at);
        t.editor.setZoom(130);
        t.parts.maxRows.value = '1000'; t.parts.maxRows.dispatchEvent(new Event('change'));
        t.parts.edHost.style.flexBasis = '260px';
        ta.scrollTop = 600; ta.dispatchEvent(new Event('scroll'));
        ta.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        t.parts.runBtn.click(); })(); 1`);
      await wait(2500);
      const ran = await js(`(() => { const t = Lookup.S.tabs.find((x) => x.persisted); const r = t.results.find((x) => x.kind === 'rows'); return r ? r.rows : t.results.map((x) => x.message); })()`);
      check('it is a working query tab: Run runs the statement at the cursor', JSON.stringify(ran) === '[["42"]]' || JSON.stringify(ran) === '[[42]]', ran);
      const before = await js(LOOK);
      await wait(700);
      check('what you type is saved as you work (before closing)', saved()[oraId] && saved()[oraId].text === TEXT && saved()[oraId].open === true, saved()[oraId]);

      // Close with its ×, then open again from the title bar.
      await js(`(() => { const t = Lookup.S.tabs.find((x) => x.persisted); document.querySelector('.tab[data-id="' + t.id + '"] .tab-x').click(); })(); 1`);
      await wait(800);
      check('closing removes the tab and saves it as closed', (await js(LOOK)) === null && saved()[oraId].open === false && saved()[oraId].text === TEXT);
      await shell(`${BUTTON}.click(); ${BUTTON}.click(); 1`); // a double click opens one tab
      await wait(1000);
      look = await js(LOOK);
      const same = (a, b) => a && b && a.text === b.text && JSON.stringify(a.sel) === JSON.stringify(b.sel) && a.zoom === b.zoom
        && a.maxRows === b.maxRows && a.edHeight === b.edHeight && Math.abs(a.scroll - b.scroll) <= 2;
      check('reopened, it looks the same: text, cursor, scroll, zoom, row limit, editor height', same(look, before), { before, look });
      check('clicking the button twice opens it once', look && look.count === 1, look);
      await js(`(() => { const t = Lookup.S.tabs.find((x) => x.persisted); document.querySelector('.tab[data-id="' + t.id + '"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); })(); 1`);
      await wait(150);
      const menu = await js(`[...document.querySelectorAll('.ctx .ctx-item')].map((x) => x.textContent.trim())`);
      await js(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 1`);
      check('its name is fixed (no Rename)', !menu.some((x) => x.startsWith('Rename')) && menu.some((x) => x.startsWith('Close')), menu);

      // Rename: not for table tabs (they keep the table's name); still there for normal query tabs.
      const tabMenu = async (find) => {
        await js(`(() => { const t = Lookup.S.tabs.find(${find}); const el = document.querySelector('.tab[data-id="' + t.id + '"]');
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); })(); 1`);
        await wait(150);
        const items = await js(`[...document.querySelectorAll('.ctx .ctx-item')].map((x) => x.textContent.trim())`);
        await js(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 1`);
        return items;
      };
      const dblclickTitle = (find) => js(`(() => { const t = Lookup.S.tabs.find(${find}); const el = document.querySelector('.tab[data-id="' + t.id + '"] .tab-title');
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); const r = !!document.querySelector('.tab-rename'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return r; })()`);
      await js(`Lookup.openTableTab('LOOKUP', 'CUSTOMERS', 'TABLE'); 1`);
      await wait(1500);
      const tableMenu = await tabMenu(`(x) => x.kind === 'table'`);
      check('a table tab has no Rename in its menu', !tableMenu.some((x) => x.startsWith('Rename')) && tableMenu.some((x) => x.startsWith('Close')), tableMenu);
      check('double-clicking a table tab does not start renaming it', (await dblclickTitle(`(x) => x.kind === 'table'`)) === false);
      await js(`(() => { const t = Lookup.S.tabs.find((x) => x.kind === 'table'); document.querySelector('.tab[data-id="' + t.id + '"] .tab-x').click(); })(); 1`);
      await wait(300);
      await js(`Lookup.openQueryTab({ title: 'renameme' }); 1`);
      await wait(300);
      const queryMenu = await tabMenu(`(x) => x.title === 'renameme'`);
      check('a normal query tab can still be renamed (menu and double-click)', queryMenu.some((x) => x.startsWith('Rename'))
        && (await dblclickTitle(`(x) => x.title === 'renameme'`)) === true, queryMenu);
      await js(`(() => { const t = Lookup.S.tabs.find((x) => x.title === 'renameme'); document.querySelector('.tab[data-id="' + t.id + '"] .tab-x').click(); })(); 1`);
      await wait(300);

      // A normal query tab next to it is saved separately, and stays in front after reconnecting.
      await js(`(() => { const t = Lookup.openQueryTab({ title: 'scratch', text: 'select 1 from dual' }); Lookup.saveQueryTabs(); })(); 1`);
      await wait(300);
      const qtabs = await js(`JSON.parse(localStorage.getItem('lookup.queries.' + Lookup.S.current.id))`);
      check('normal query tabs are saved as before, without the Persisted Queries tab', qtabs.length === 1 && qtabs[0].title === 'scratch', qtabs);

      // Disconnect with it open; connect again: it comes back by itself, as it was.
      await js(`Lookup.leaveWorkspace(); 1`);
      await wait(1500);
      check('disconnecting keeps it marked open', saved()[oraId].open === true && saved()[oraId].text === TEXT, saved()[oraId]);
      await connect(oraId);
      await wait(800);
      const front = await js(`Lookup.S.tabs.find((t) => t.id === Lookup.S.active).title`);
      check('the normal query tab stays in front', front === 'scratch', front);
      await js(`(() => { const t = Lookup.S.tabs.find((x) => x.persisted); document.querySelector('.tab[data-id="' + t.id + '"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })(); 1`);
      await wait(300);
      look = await js(LOOK);
      check('after reconnecting it is open again and, when shown, looks the same', same(look, before), { before, look });

      // Another connection has its own Persisted Queries.
      await js(`Lookup.leaveWorkspace(); 1`);
      await wait(1500);
      await connect(pgId);
      if (await js('!!Lookup.S.current')) {
        check('another connection does not reopen it (never opened there)', (await js(LOOK)) === null);
        await wait(500);
        await shell(`${BUTTON}.click(); 1`);
        await wait(800);
        look = await js(LOOK);
        check('another connection has its own, empty one', look && look.text === '', look);
        await js(`(() => { const ta = Lookup.S.tabs.find((x) => x.persisted).editor.ta; ta.value = 'select 7'; ta.dispatchEvent(new InputEvent('input', { bubbles: true })); })(); 1`);
        await wait(900);
        check('each connection keeps its own text', saved()[pgId] && saved()[pgId].text === 'select 7' && saved()[oraId].text === TEXT, { pg: saved()[pgId], ora: saved()[oraId] });
        await js(`Lookup.leaveWorkspace(); 1`);
        await wait(1500);
      } else console.log('  (PostgreSQL not answering: second-connection checks skipped)');

      // Deleting a connection deletes its Persisted Queries.
      await js(`api.deleteConnection(${JSON.stringify(oraId)})`);
      check('deleting the connection deletes its saved Persisted Queries', !(oraId in saved()), Object.keys(saved()));

      console.log(`\n${passed} passed, ${failures.length} failed`);
      if (failures.length) code = 1;
    } catch (e) {
      console.log('SMOKE ERROR', e.stack);
      code = 1;
    }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(code);
  });
});
