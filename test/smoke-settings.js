// The memory & performance menu: shows memory, saves settings, flags applied at startup.
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');
const { menuItems, clickItem, isOpen } = require('./menu-helper');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-settings'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      out.switches = ['process-per-site', 'enable-features', 'disable-features', 'js-flags'].map((k) => `${k}=${app.commandLine.getSwitchValue(k) || (app.commandLine.hasSwitch(k) ? 'on' : 'off')}`);
      out.renderers = app.getAppMetrics().filter((p) => p.type === 'Tab').length;
      const ws = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      const openMenu = async () => { await win.webContents.executeJavaScript(`document.getElementById('tb-settings').click()`); await wait(500); return menuItems(); };
      out.menu = (await openMenu())[0];
      // Memory is read each time the menu opens.
      await clickItem('Memory'); // opens the memory details
      out.stillOpen = await isOpen();
      out.memoryDetails = ((await menuItems())[1] || []).map((x) => x.replace(/\d+ MB/, 'N MB'));
      await ws.executeJavaScript(`window.__hog = Array.from({ length: 3e6 }, (_, i) => 'row ' + i); 1`);
      await wait(1500);
      out.memoryChanged = (await openMenu())[0][0] !== out.menu[0];
      // Free unused memory: the big array is dropped first, then the menu action hands memory back and says how much.
      await require('./menu-helper').layer().executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 1`); // close
      await wait(300);
      await ws.executeJavaScript(`window.__hog = null; 1`);
      await openMenu();
      await clickItem('Memory');
      await clickItem('Free unused memory');
      await wait(2500);
      out.freed = /^(Freed \d+ MB|Nothing more to free) · \d+ MB in use$/.test(await ws.executeJavaScript(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).pop() || ''`));
      await openMenu();
      // Dark theme.
      await clickItem('Dark theme');
      await wait(500);
      out.closedAfterPick = !(await isOpen());
      out.dark = {
        workspace: await ws.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches`),
        saved: JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).theme,
      };
      // Preset from a submenu.
      await openMenu();
      await clickItem('Connect timeout');
      out.submenu = await menuItems();
      await clickItem('30 seconds');
      await openMenu(); await clickItem('Idle health check every'); await clickItem('Off');
      // Custom… asks in the connection view.
      await openMenu(); await clickItem('Keep-alive probe every'); await clickItem('Custom…');
      await wait(400);
      out.customDialog = await ws.executeJavaScript(`document.querySelector('.modal-title')?.textContent`);
      await ws.executeJavaScript(`(() => { const i = document.querySelector('.modal input'); i.value = '20'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(); 1`);
      await wait(400);
      out.dialogClosed = await ws.executeJavaScript(`!document.querySelector('.modal')`);
      out.menuAfter = (await openMenu())[0].filter((x) => x.endsWith('▸'));
      out.netApplied = require('../src/main/db').configure();
      fs.writeFileSync(path.join(__dirname, 'smoke-settings-menu.png'), (await win.webContents.capturePage()).toPNG());
      await clickItem('Use GPU');
      out.saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
      console.log('SMOKE-SETTINGS', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-SETTINGS FAILED', e.stack); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
