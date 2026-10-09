// Shell pop-up menus in the app's own style: + menu, connection-tile menu, Esc / click-outside,
// focus returns to the connection view, and no extra process. Run: npx electron test/smoke-menus.js
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');
const { menuItems, clickItem, isOpen, layer } = require('./menu-helper');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-menus'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tiles = (win) => win.webContents.executeJavaScript(`[...document.querySelectorAll('.rail-tile')].map((t) => (t.classList.contains('active') ? '*' : '') + t.querySelector('.rail-name').textContent)`);
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      const ws = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html') && !w.isDestroyed());
      const [a] = ws();
      const id = await a.executeJavaScript(`window.api.saveConnection({ name: 'Billing', env: 'prod', host: 'h', service: 'S', user: 'u', password: 'p' })`);
      await a.executeJavaScript(`window.api.wsState({ connected: true, connId: ${JSON.stringify(id)}, title: 'Billing' })`);
      await wait(300);
      const procsBefore = app.getAppMetrics().length;
      // + menu
      await win.webContents.executeJavaScript(`document.getElementById('conn-add').click()`); await wait(500);
      out.plusMenu = (await menuItems())[0];
      out.processesBefore = procsBefore;
      out.processesWithMenu = app.getAppMetrics().length;
      await layer().executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 1`); await wait(200);
      out.closedByEsc = !(await isOpen());
      await win.webContents.executeJavaScript(`document.getElementById('conn-add').click()`); await wait(300);
      await layer().executeJavaScript(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 900, clientY: 600 })); 1`); await wait(200);
      out.closedByOutsideClick = !(await isOpen());
      await win.webContents.executeJavaScript(`document.getElementById('conn-add').click()`); await wait(300);
      await clickItem('New connection');
      await wait(800);
      out.tilesAfterNew = await tiles(win);
      // Tile right-click menu
      await win.webContents.executeJavaScript(`document.querySelectorAll('.rail-tile')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 80 }))`); await wait(400);
      out.tileMenu = (await menuItems())[0];
      // keyboard: Down twice then Enter = second enabled item
      await clickItem('Move down');
      await wait(300);
      out.tilesAfterMove = await tiles(win);
      out.focusBack = webContents.getAllWebContents().filter((w) => w.isFocused()).map((w) => w.getURL().split('/').pop().split('?')[0]);
      console.log('SMOKE-MENUS', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-MENUS FAILED', e.stack, JSON.stringify(out)); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
