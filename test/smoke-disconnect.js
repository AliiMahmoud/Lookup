// Disconnect removes the connection's tile; leaving an empty "New" tile removes it too.
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'oradesk-smoke-disc'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
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
      const ids = await a.executeJavaScript(`(async () => [
        await window.api.saveConnection({ name: 'One', host: 'h1', service: 'S', user: 'u', password: 'p' }),
        await window.api.saveConnection({ name: 'Two', host: 'h2', service: 'S', user: 'u', password: 'p' })])()`);
      const fake = (wc, name, id) => wc.executeJavaScript(`window.api.wsState({ connected: true, connId: ${JSON.stringify(id)}, title: '${name}' })`);
      await fake(a, 'One', ids[0]);
      await a.executeJavaScript(`window.api.openConnection(${JSON.stringify(ids[1])})`);
      await wait(2000);
      const b = views().find((v) => v.id !== a.id);
      await fake(b, 'Two', ids[1]);
      await wait(200);
      out.twoOpen = await tiles(win);
      // Disconnect "Two" from the title bar button.
      await win.webContents.executeJavaScript(`window.shellApi.action('disconnect')`);
      await wait(1200);
      out.afterDisconnect = await tiles(win);
      // Open an empty tile, then switch away from it: it should disappear.
      await a.executeJavaScript(`void 0`);
      await win.webContents.executeJavaScript(`void 0`);
      out.beforeEmpty = (await tiles(win)).length;
      const { BrowserWindow } = require('electron');
      win.webContents.executeJavaScript(`void 0`);
      win.emit('noop');
      require('electron').Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.label === 'New Connection Tab').click();
      await wait(1500);
      out.withEmpty = await tiles(win);
      await win.webContents.executeJavaScript(`document.querySelectorAll('.rail-tile')[0].dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))`);
      await wait(800);
      out.afterLeavingEmpty = await tiles(win);
      console.log('SMOKE-DISC', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-DISC FAILED', e.message, JSON.stringify(out)); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
