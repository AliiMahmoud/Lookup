// Import / export of connections in Oracle SQL Developer format (XML and JSON), via the home screen
// buttons, with the file dialogs answered by the test. Run: npx electron test/smoke-conn-io.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const electron = require('electron');
const { app, webContents, dialog } = electron;
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-smoke-connio'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-connio-'));
const ref = (name, fields) => `   <Reference name="${name}" className="oracle.jdeveloper.db.adapter.DatabaseProvider" xmlns="">
      <Factory className="oracle.jdeveloper.db.adapter.DatabaseProviderFactory1212"/>
      <RefAddresses>
${Object.entries(fields).map(([k, v]) => `         <StringRefAddr addrType="${k}">\n            <Contents>${v}</Contents>\n         </StringRefAddr>`).join('\n')}
      </RefAddresses>
   </Reference>`;
const common = { RaptorConnectionType: 'Oracle', SavePassword: 'true', password: 'v2__AbCdEfEncrypted==', driver: 'oracle.jdbc.OracleDriver', oraDriverType: 'thin', subtype: 'oraJDBC', OS_AUTHENTICATION: 'false', KERBEROS_AUTHENTICATION: 'false' };
fs.writeFileSync(path.join(dir, 'sqldev.xml'), `<?xml version = '1.0' encoding = 'UTF-8'?>
<References xmlns="http://xmlns.oracle.com/adf/jndi">
${ref('HR Dev', { ...common, ConnName: 'HR Dev', hostname: 'db-dev.local', port: '1521', serviceName: 'FREEPDB1', user: 'hr' })}
${ref('Legacy SID', { ...common, ConnName: 'Legacy SID', hostname: '10.0.0.5', port: '1522', sid: 'ORCL', user: 'scott' })}
${ref('Prod descriptor', { ...common, ConnName: 'Prod descriptor', customUrl: 'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=prod)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=PRD)))', user: 'app' })}
${ref('As SYSDBA', { ...common, ConnName: 'As SYSDBA', hostname: 'localhost', port: '1521', serviceName: 'FREE', user: 'sys', role: 'sysdba' })}
${ref('Via TNS', { ...common, ConnName: 'Via TNS', tnsalias: 'PRODDB', user: 'app' })}
${ref('My MySQL', { ...common, RaptorConnectionType: 'MySQL', ConnName: 'My MySQL', hostname: 'm', port: '3306', user: 'root' })}
${ref('Already here', { ...common, ConnName: 'Already here', hostname: 'localhost', port: '1521', serviceName: 'FREEPDB1', user: 'SYSTEM' })}
</References>`);
fs.writeFileSync(path.join(dir, 'sqldev.json'), JSON.stringify({ connections: [
  { name: 'From JSON', type: 'jdbc', info: { RaptorConnectionType: 'Oracle', hostname: 'jhost', port: '1521', serviceName: 'JSVC', user: 'ju', ConnName: 'From JSON' } }] }));
let openPath = null;
let savePath = null;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [openPath] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: savePath });
// No OS keychain on the test machine: keep saved passwords in memory so export/import can be checked.
const store = require('../src/main/store');
const pwById = new Map();
const { list, get, save } = store.connections;
store.connections.save = (c) => { const id = save(c); if (c.password) pwById.set(id, c.password); return id; };
store.connections.list = () => list().map((c) => ({ ...c, hasPassword: pwById.has(c.id) }));
store.connections.get = (id) => { const c = get(id); return c && { ...c, password: pwById.get(id) || '' }; };
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const out = {};
    try {
      await wait(1500);
      const ws = webContents.getAllWebContents().find((w) => w.getURL().includes('index.html'));
      const js = (s) => ws.executeJavaScript(s);
      await js(`window.api.saveConnection({ name: 'Existing', host: 'localhost', port: 1521, service: 'FREEPDB1', user: 'system', password: 'p' })`);
      await js(`Lookup.showWelcome()`); await wait(300);
      out.buttons = await js(`[...document.querySelectorAll('.home-actions .home-btn')].map((b) => b.textContent.trim() + (b.disabled ? ' [disabled]' : ''))`);
      // Import the XML
      openPath = path.join(dir, 'sqldev.xml');
      await js(`[...document.querySelectorAll('.home-btn')].find((b) => b.textContent.includes('Import')).click(); 1`); await wait(600);
      out.preview = await js(`[...document.querySelectorAll('.imp-row')].map((r) => (r.querySelector('input').checked ? '[x] ' : '[ ] ') + r.innerText.replace(/\\s+/g, ' ').trim())`);
      out.note = await js(`document.querySelector('.imp-note').textContent`);
      out.button = await js(`[...document.querySelectorAll('.modal-foot .btn')].pop().textContent`);
      fs.writeFileSync(path.join(__dirname, 'smoke-conn-io.png'), (await ws.capturePage()).toPNG());
      await js(`[...document.querySelectorAll('.modal-foot .btn')].pop().click(); 1`); await wait(800);
      out.afterImport = (await js(`window.api.listConnections()`)).map((c) => `${c.name} | ${c.mode || 'basic'} | ${c.mode === 'string' ? c.connectString : `${c.user}@${c.host}:${c.port}/${c.service} ${c.serviceType}`} | ${c.role || 'DEFAULT'} | pw:${c.hasPassword}`);
      out.homeList = await js(`[...document.querySelectorAll('.home-conn-name > span:first-child')].map((x) => x.textContent)`);
      // Import JSON
      openPath = path.join(dir, 'sqldev.json');
      await js(`[...document.querySelectorAll('.home-btn')].find((b) => b.textContent.includes('Import')).click(); 1`); await wait(500);
      await js(`[...document.querySelectorAll('.modal-foot .btn')].pop().click(); 1`); await wait(600);
      out.afterJson = (await js(`window.api.listConnections()`)).length;
      // Export, then re-read the export: same connections come back
      savePath = path.join(dir, 'export.xml');
      await js(`[...document.querySelectorAll('.home-btn')].find((b) => b.textContent.includes('Export')).click(); 1`); await wait(400);
      await js(`(() => { const c = document.querySelector('.cx-body input[type=checkbox]'); if (c.checked) c.click(); [...document.querySelectorAll('.modal-foot .btn')].pop().click(); })(); 1`); await wait(600);
      const xml = fs.readFileSync(savePath, 'utf8');
      out.exportHead = xml.split('\n').slice(0, 3).join(' ');
      out.exportHasPassword = /addrType="password"/.test(xml);
      out.roundTrip = await js(`Lookup.readSqlDevFile(${JSON.stringify(xml)}).map(Lookup.toLookup).map((c) => c.name + ' | ' + (c.mode === 'string' ? c.connectString : c.user + '@' + c.host + ':' + c.port + '/' + c.service + ' ' + c.serviceType) + ' | ' + c.role)`);
      // Export with passwords: dialog, locked with a file password, then import into a clean list.
      await js(`window.api.saveConnection({ name: 'With password', host: 'pwhost', port: 1521, serviceType: 'service', service: 'P', user: 'pu', password: 'S3cret!', role: 'DEFAULT' })`);
      await js(`Lookup.showWelcome()`); await wait(300);
      savePath = path.join(dir, 'export-pw.xml');
      await js(`[...document.querySelectorAll('.home-btn')].find((b) => b.textContent.includes('Export')).click(); 1`); await wait(400);
      out.exportDialog = await js(`({ title: document.querySelector('.modal-title').textContent, include: document.querySelector('.cx-body input[type=checkbox]').checked, saveDisabled: [...document.querySelectorAll('.modal-foot .btn')].pop().disabled, text: document.querySelector('.cx-body').innerText.replace(/\s+/g, ' ') })`);
      fs.writeFileSync(path.join(__dirname, 'smoke-conn-io-export.png'), (await ws.capturePage()).toPNG());
      await js(`(() => { const i = document.querySelector('.cx-pw input'); i.value = 'file-pass'; i.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('.modal-foot .btn')].pop().click(); })(); 1`); await wait(1200);
      const xml2 = fs.readFileSync(savePath, 'utf8');
      out.exportPw = { lockedValues: (xml2.match(/addrType="LookupPassword"/g) || []).length, plaintextInFile: xml2.includes('S3cret!') };
      // wipe the list, then import the file with passwords
      for (const c of await js(`window.api.listConnections()`)) await js(`window.api.deleteConnection(${JSON.stringify(c.id)})`);
      pwById.clear();
      await js(`Lookup.showWelcome()`); await wait(300);
      openPath = savePath;
      await js(`[...document.querySelectorAll('.home-btn')].find((b) => b.textContent.includes('Import')).click(); 1`); await wait(600);
      out.importPwBox = await js(`document.querySelector('.cx-box')?.innerText.replace(/\s+/g, ' ')`);
      fs.writeFileSync(path.join(__dirname, 'smoke-conn-io-import.png'), (await ws.capturePage()).toPNG());
      await js(`(() => { const i = document.querySelector('.cx-box input[type=password]'); i.value = 'wrong'; i.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('.modal-foot .btn')].pop().click(); })(); 1`); await wait(800);
      out.wrongPassword = await js(`document.querySelector('.cx-box .cx-status').textContent + ' | dialog open: ' + !!document.querySelector('.modal')`);
      await js(`(() => { const i = document.querySelector('.cx-box input[type=password]'); i.value = 'file-pass'; i.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('.modal-foot .btn')].pop().click(); })(); 1`); await wait(1200);
      out.afterPwImport = (await js(`window.api.listConnections()`)).map((c) => `${c.name}:${c.hasPassword ? 'pw' : '-'}`);
      out.restoredPassword = [...pwById.values()];
      out.errors = [];
      console.log('SMOKE-CONNIO', JSON.stringify(out));
    } catch (e) { console.log('SMOKE-CONNIO FAILED', e.stack, JSON.stringify(out)); }
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    app.exit(0);
  });
});
