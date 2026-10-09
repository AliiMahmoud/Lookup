// Ctrl+= / Ctrl+- / Ctrl+0: zoom only the SQL editor when it has focus, otherwise the whole window.
// Run with: npx electron test/smoke-zoom.js
const path = require('path');
const fs = require('fs');
const { app, Menu, webContents } = require('electron');

app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-zoom'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
const db = require('../src/main/db');
Object.assign(db, {
  connect: async () => ({ version: '23.5', schema: 'HR', dbName: 'FREE', autoCommit: false }),
  schemas: async () => [{ name: 'HR' }],
  objects: async () => [{ name: 'EMPLOYEES', type: 'TABLE' }],
  columns: async () => [],
  sqlLog: () => ({ entries: [], last: 0 }),
  tableData: async (_w, { offset = 0, limit }) => { global.lastLimit = limit; return { columns: [{ name: 'ID', type: 'NUMBER', kind: 'number' }], rows: Array.from({ length: Math.min(limit, 100002 - offset) }, (_, i) => [String(offset + i)]), rowids: Array.from({ length: Math.min(limit, 100002 - offset) }, (_, i) => 'R' + i), total: 100002, editable: false, ms: 2, sql: 'SELECT …' }; },
});
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const press = (label) => {
  const view = Menu.getApplicationMenu().items.find((i) => i.label === 'View');
  view.submenu.items.find((i) => i.label === label).click();
};

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      win.focus();
      const ws = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      await ws.executeJavaScript(`window.api.saveConnection({ name: 'HR Dev', host: 'h', service: 'FREEPDB1', user: 'hr', password: 'p' })`).then((id) => ws.send('ws:action', { action: 'connect', connId: id }));
      await wait(800);
      await ws.executeJavaScript(`(() => { const i = document.querySelector('.modal input[type=password]'); if (i) { i.value = 'p'; [...document.querySelectorAll('.modal .btn.primary')].pop().click(); } })(); 1`);
      await wait(1500);
      await ws.executeJavaScript(`Lookup.openQueryTab({ text: 'select employee_id, first_name\\n  from employees\\n where rownum < 10' }); 1`);
      await wait(300);
      const state = () => ws.executeJavaScript(`(() => {
        const t = Lookup.S.tabs.find((x) => x.kind === 'query');
        return { editorZoom: t.editor.zoom, editorFont: getComputedStyle(t.editor.ta).fontSize, gutterRow: getComputedStyle(t.editor.el.querySelector('.ed-gutter div')).height,
          sidebarFont: getComputedStyle(document.querySelector('.input')).fontSize };
      })()`);
      const levels = () => ({ ws: Math.round(ws.getZoomFactor() * 100), shell: Math.round(win.webContents.getZoomFactor() * 100) });

      // 1. Focus in the SQL editor: only the editor zooms.
      await ws.executeJavaScript(`Lookup.S.tabs.find((x) => x.kind === 'query').editor.focus(); 1`);
      press('Zoom Out'); await wait(150); press('Zoom Out'); await wait(300);
      out.editorFocused = { ...(await state()), ...levels() };
      press('Zoom In'); await wait(300);
      out.editorZoomIn = (await state()).editorZoom;

      // 2. Focus elsewhere (object filter): the whole window zooms, the title bar does not.
      await ws.executeJavaScript(`document.querySelector('.sidebar input, input[placeholder^="Filter"]').focus(); 1`);
      press('Zoom Out'); await wait(400);
      out.elsewhere = { ...(await state()), ...levels(), saved: JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).zoom };
      fs.writeFileSync(path.join(__dirname, 'smoke-zoom.png'), (await ws.capturePage()).toPNG());
      press('Actual Size'); await wait(300);
      out.reset = levels();

      // 4. Ctrl+B beautifies; the limit picker ends with No limit.
      out.ctrlB = await ws.executeJavaScript(`(async () => {
        const t = Lookup.S.tabs.find((x) => x.kind === 'query');
        t.editor.focus();
        t.editor.ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 500));
        return { text: t.editor.value, limits: [...t.el.querySelectorAll('.toolbar select option')].map((o) => o.textContent + (o.selected ? ' *' : '')) };
      })()`);

      // 5. Table pager: click opens the list, double-click lets you type a number.
      await ws.executeJavaScript(`Lookup.openTableTab('HR', 'EMPLOYEES', 'TABLE', 'data'); 1`);
      await wait(800);
      out.pageSize = { start: global.lastLimit };
      await ws.executeJavaScript(`document.querySelector('.page-size').click(); 1`);
      await wait(500);
      out.pageSize.menu = await ws.executeJavaScript(`[...document.querySelectorAll('.ctx .ctx-item')].map((x) => x.textContent)`);
      await ws.executeJavaScript(`[...document.querySelectorAll('.ctx .ctx-item')].find((x) => x.textContent.startsWith('1,000')).click(); 1`);
      await wait(500);
      out.pageSize.picked = global.lastLimit;
      await ws.executeJavaScript(`(() => { const b = document.querySelector('.page-size'); b.click(); b.click(); b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })(); 1`);
      await wait(400);
      out.pageSize.menuAfterDbl = await ws.executeJavaScript(`!!document.querySelector('.ctx')`);
      await ws.executeJavaScript(`(() => { const i = document.querySelector('.page-size-input'); i.value = '2500'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(); 1`);
      await wait(500);
      out.pageSize.typed = global.lastLimit;
      out.pageSize.label = await ws.executeJavaScript(`document.querySelector('.page-size').textContent + ' | ' + document.querySelector('.pager-info').textContent`);

      // 6. Sidebar filter: × clears it.
      out.filterClear = await ws.executeJavaScript(`(async () => {
        const f = document.getElementById('obj-filter'); const x = document.querySelector('.sb-search-clear');
        const r = { hiddenWhenEmpty: x.classList.contains('hidden') };
        f.focus(); f.value = 'zzz'; f.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((res) => setTimeout(res, 150));
        r.shownWhenTyped = !x.classList.contains('hidden'); r.itemsFiltered = document.querySelectorAll('#tree .tree-item, #tree [title]').length;
        x.click();
        await new Promise((res) => setTimeout(res, 150));
        r.afterClear = { value: f.value, hidden: x.classList.contains('hidden'), items: document.querySelectorAll('#tree .tree-item, #tree [title]').length, focused: document.activeElement === f };
        return r;
      })()`);
      await ws.executeJavaScript(`(() => { const f = document.getElementById('obj-filter'); f.value = 'testin'; f.dispatchEvent(new Event('input', { bubbles: true })); })(); 1`);
      await wait(200);
      fs.writeFileSync(path.join(__dirname, 'smoke-zoom-filter.png'), (await ws.capturePage({ x: 0, y: 0, width: 260, height: 140 })).toPNG());

      await ws.executeJavaScript(`document.querySelector('.sb-search-clear').click(); 1`);

      // 3. Editor zoom is remembered with the query tab.
      out.savedTab = await ws.executeJavaScript(`(JSON.parse(localStorage.getItem('oradesk.queries.' + Lookup.S.current.id))[0] || {}).zoom`);
      console.log('SMOKE-ZOOM', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-ZOOM FAILED', e.stack); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
