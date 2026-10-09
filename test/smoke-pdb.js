// The database button lists PDBs; picking one saves/opens a connection to it once.
const path = require('path');
const fs = require('fs');
const electron = require('electron');
const { app, webContents } = electron;
const { menuItems, clickItem } = require('./menu-helper');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-pdb'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
const db = require('../src/main/db');
db.pdbs = async () => ({ current: 'CDB$ROOT', list: [
  { name: 'CDB$ROOT', open: true, openMode: 'READ WRITE', service: 'free', root: true },
  { name: 'FREEPDB1', open: true, openMode: 'READ WRITE', service: 'freepdb1' },
  { name: 'SALESPDB', open: false, openMode: 'MOUNTED', service: 'salespdb' }], note: null });
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tiles = (win) => win.webContents.executeJavaScript(`[...document.querySelectorAll('.rail-tile')].map((t) => (t.classList.contains('active') ? '*' : '') + t.querySelector('.rail-name').textContent)`);
const views = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html') && !w.isDestroyed());
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      const [a] = views();
      const id = await a.executeJavaScript(`window.api.saveConnection({ name: 'Oracle DB', host: 'localhost', port: 1521, service: 'free', user: 'system', password: 'p' })`);
      await a.executeJavaScript(`window.api.wsState({ connected: true, connId: ${JSON.stringify(id)}, title: 'Oracle DB', schema: 'SYSTEM' })`);
      await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[title^="Databases on this server"]').click()`);
      await wait(500);
      out.menu = (await menuItems())[0];
      await clickItem('FREEPDB1');
      await wait(2000);
      out.tilesAfterPick = await tiles(win);
      out.saved = (await a.executeJavaScript(`window.api.listConnections()`)).map((c) => `${c.name} -> ${c.service}`);
      // Pick it again (simulate the new tab being connected): no new tab, no duplicate saved connection.
      const b = views().find((v) => v.id !== a.id);
      const savedPdb = (await a.executeJavaScript(`window.api.listConnections()`)).find((c) => c.service === 'freepdb1');
      await b.executeJavaScript(`window.api.wsState({ connected: true, connId: ${JSON.stringify(savedPdb.id)}, title: 'Oracle DB · FREEPDB1' })`);
      await win.webContents.executeJavaScript(`document.querySelectorAll('.rail-tile')[0].dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))`);
      await wait(300);
      await a.executeJavaScript(`window.api.wsState({ connected: true, connId: ${JSON.stringify(id)}, title: 'Oracle DB', schema: 'SYSTEM' })`);
      await wait(200);
      await win.webContents.executeJavaScript(`document.querySelector('[title^="Databases on this server"]').click()`);
      await wait(500);
      out.menu2 = (await menuItems())[0];
      await clickItem('FREEPDB1');
      await wait(800);
      out.tilesAfterRepick = await tiles(win);
      out.savedCount = (await a.executeJavaScript(`window.api.listConnections()`)).length;
      console.log('SMOKE-PDB', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-PDB FAILED', e.stack, JSON.stringify(out)); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
