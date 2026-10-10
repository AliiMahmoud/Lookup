// Boots the real app, checks the renderer and IPC wiring, then quits.
// Run with: npx electron test/smoke.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, webContents } = require('electron');

app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke'));
require('../src/main/main.js');

app.on('browser-window-created', (_e, win) => {
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const ws = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      const res = await ws.executeJavaScript(`(async () => {
        const out = { api: typeof window.api, welcome: !!document.querySelector('.home-intro') };
        out.saved = await window.api.saveConnection({ name: 'smoke', host: '127.0.0.1', port: 1599, service: 'FREEPDB1', user: 'x', password: 'secret' });
        out.list = (await window.api.listConnections()).map((c) => c.name + ':' + c.hasPassword);
        try { await window.api.testConnection({ user: 'x', password: 'y', host: '127.0.0.1', port: 1599, service: 'FREEPDB1' }); out.test = 'connected?'; }
        catch (e) { out.test = e.message.split('\\n')[0]; }
        const xf = ${JSON.stringify(require('path').join(require('os').tmpdir(), 'lookup-smoke.xlsx'))};
        const seen = [];
        const off = window.api.onExportProgress((p) => seen.push(p.rows));
        const r = await window.api.exportRun({ jobId: 'j1', source: 'rows', format: 'xlsx', filePath: xf, options: { header: true },
          columns: [{ name: 'ID', type: 'NUMBER' }, { name: 'AT', type: 'DATE' }],
          rows: Array.from({ length: 2500 }, (_, i) => [String(i), '2026-01-01 00:00:00']) });
        off();
        out.export = { rows: r.rows, progressEvents: seen.length };
        out.format = (await window.api.formatSql('select a,b from t where x=:id')).text;
        out.sqlLog = await window.api.sqlLog(0);
        return out;
      })()`);
      res.xlsxBytes = fs.statSync(require('path').join(require('os').tmpdir(), 'lookup-smoke.xlsx')).size;
      const stored = fs.readFileSync(path.join(app.getPath('userData'), 'connections.json'), 'utf8');
      res.passwordStoredPlain = stored.includes('secret');
      const img = await ws.capturePage();
      fs.writeFileSync(path.join(__dirname, 'smoke.png'), img.toPNG());
      console.log('SMOKE', JSON.stringify(res), 'errors:', JSON.stringify(errors));
    } catch (e) {
      console.log('SMOKE FAILED', e.message);
    }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    app.exit(0);
  });
});
