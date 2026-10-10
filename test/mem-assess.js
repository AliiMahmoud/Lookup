// Memory assessment: boots the app (simulated Oracle, like bench.js) and reports what is loaded and how big:
// the main-process modules loaded at start (by package), the main heap, and the pages' JS heap and DOM size.
// Run: npx electron test/mem-assess.js   (a module showing up here that isn't needed at start is a lazy-load candidate)
const path = require('path');
const fs = require('fs');
const { app, webContents } = require('electron');
app.commandLine.appendSwitch('js-flags', '--expose-gc --optimize-for-size');
app.setPath('userData', path.join(app.getPath('temp'), 'lookup-assess'));
fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
require('../src/main/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (b) => Math.round(b / 1048576 * 10) / 10;

function mainModules() {
  const by = {};
  for (const k of Object.keys(require.cache)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(k);
    const key = m ? m[1] : k.replace(path.resolve(__dirname, '..') + '/', '');
    let size = 0; try { size = fs.statSync(k).size; } catch {}
    by[key] = by[key] || { files: 0, kb: 0 };
    by[key].files++; by[key].kb += Math.round(size / 1024);
  }
  return by;
}
async function pageHeap(wc) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('HeapProfiler.collectGarbage');
    const { metrics } = await (wc.debugger.sendCommand('Performance.enable'), wc.debugger.sendCommand('Performance.getMetrics'));
    const g = (n) => (metrics.find((m) => m.name === n) || {}).value;
    return { url: wc.getURL().split('/').pop(), jsHeapUsedMB: MB(g('JSHeapUsedSize')), jsHeapTotalMB: MB(g('JSHeapTotalSize')), nodes: g('Nodes'), listeners: g('JSEventListeners'), docs: g('Documents') };
  } catch (e) { return { url: wc.getURL(), err: e.message }; }
}
async function report(label) {
  global.gc && global.gc();
  await wait(1500);
  const pages = [];
  for (const wc of webContents.getAllWebContents()) pages.push(await pageHeap(wc));
  const mu = process.memoryUsage();
  console.log('ASSESS', JSON.stringify({ label, main: { rssMB: MB(mu.rss), heapUsedMB: MB(mu.heapUsed), externalMB: MB(mu.external) }, pages }));
}
app.on('browser-window-created', (_e, win) => {
  if (app._assessed) return; app._assessed = true;
  win.webContents.once('did-finish-load', async () => {
    try {
      await wait(3000);
      await report('started');
      const mods = mainModules();
      console.log('MODULES', JSON.stringify(Object.entries(mods).sort((a, b) => b[1].kb - a[1].kb)));
    } catch (e) { console.log('ASSESS FAILED', e.stack); }
    app.exit(0);
  });
});
