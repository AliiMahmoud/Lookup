// Boots the app and exercises connection tabs: open a second tab, switch, close.
// Run with: npx electron test/smoke-tabs.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, webContents } = require('electron');

app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-tabs'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shellTabs = (win) => win.webContents.executeJavaScript(
  `[...document.querySelectorAll('.rail-tile')].map((t) => (t.classList.contains('active') ? '*' : '') + t.querySelector('.rail-name').textContent)`);
const views = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('index.html'));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      out.start = await shellTabs(win);
      const [first] = views();
      // Save two connections from the first tab, then open the second one in a new tab.
      const ids = await first.executeJavaScript(`(async () => [
        await window.api.saveConnection({ name: 'Billing', env: 'staging', host: '127.0.0.1', port: 1599, service: 'A', user: 'u', password: 'p' }),
        await window.api.saveConnection({ name: 'CRM', env: 'prod', host: '127.0.0.1', port: 1598, service: 'B', user: 'u', password: 'p' }),
      ])()`);
      await first.executeJavaScript(`window.api.wsState({ connected: true, title: 'Billing', env: 'staging', schema: 'BILLING' })`);
      await first.executeJavaScript(`window.api.openConnection(${JSON.stringify(ids[1])})`);
      await wait(2500);
      out.afterOpen = await shellTabs(win);
      out.viewCount = views().length;
      // Switch back to the first tab from the title bar.
      await win.webContents.executeJavaScript(`document.querySelectorAll('.rail-tile')[0].dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))`);
      await wait(400);
      out.afterSwitch = await shellTabs(win);
      out.visible = win.contentView.children.map((v) => v.getVisible());
      const shot = await win.contentView.children.find((v) => v.getVisible()).webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'smoke-tabs.png'), shot.toPNG());
      const bar = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'smoke-tabs-bar.png'), bar.toPNG());
      // Close the second tab via its x button.
      await win.webContents.executeJavaScript(`document.querySelectorAll('.rail-x')[1].click()`);
      await wait(1200);
      out.afterClose = await shellTabs(win);
      out.viewsAfterClose = win.contentView.children.length;
      console.log('SMOKE-TABS', JSON.stringify(out));
    } catch (e) {
      console.log('SMOKE-TABS FAILED', e.message, JSON.stringify(out));
    }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
