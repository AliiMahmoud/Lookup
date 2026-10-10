// Memory: what each Lookup process uses (for the gear menu), and handing unused memory back — on request, after a
// connection tab closes, and once while Lookup sits in the background. Measured with test/bench.js (README "Memory").
const fs = require('fs');
const v8 = require('v8');
const { app, webContents, BrowserWindow } = require('electron');

/** One process's memory in KB: private bytes on Windows / macOS (what Task Manager / Activity Monitor show), PSS on Linux. */
function processKB(p) {
  let v = p.memory.privateBytes;
  if (!v) {
    try { v = Number((/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${p.pid}/smaps_rollup`, 'utf8')) || [])[1]); } catch { v = 0; }
  }
  return v || p.memory.workingSetSize || 0;
}

// Plain names for Chromium's process types.
const KIND = { Browser: 'App and network', GPU: 'Graphics', Tab: 'Windows and connections', Utility: 'Helpers' };

/** { totalMB, processes, parts: [{ label, mb }] } — parts in a fixed order, only those present. */
function memoryReport() {
  const by = new Map();
  let total = 0;
  const metrics = app.getAppMetrics();
  for (const p of metrics) {
    const kb = processKB(p);
    total += kb;
    const label = KIND[p.type] || 'Helpers';
    by.set(label, (by.get(label) || 0) + kb);
  }
  const order = Object.values(KIND);
  const parts = [...by].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([label, kb]) => ({ label, mb: Math.round(kb / 1024) }));
  return { totalMB: Math.round(total / 1024), processes: metrics.length, parts };
}

/** Rows each connection tab holds in its results and table tabs (asked of each workspace, at most 300 ms). */
async function connectionUse() {
  const out = [];
  for (const w of BrowserWindow.getAllWindows()) {
    for (const ws of w.workspaces || []) {
      const wc = ws.view.webContents;
      if (wc.isDestroyed() || !ws.state.connected) continue;
      const use = await Promise.race([
        wc.executeJavaScript('window.Lookup && Lookup.memoryUse ? Lookup.memoryUse() : null', true).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 300)),
      ]);
      out.push({ title: ws.state.title || 'Connection', ...(use || {}) });
    }
  }
  return out;
}

// gc() for the main process, without starting it with --expose-gc (V8 flag set at run time, then a fresh context).
let mainGc = null;
function collectMain() {
  try {
    if (!mainGc) { v8.setFlagsFromString('--expose-gc'); mainGc = require('vm').runInNewContext('gc'); }
    mainGc();
  } catch { /* not available */ }
}

/** Asks every page to drop caches it no longer needs (preloads call webFrame.clearCache) and collects the main process. */
function trimAll({ main = false } = {}) {
  for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed()) wc.send('mem:trim');
  if (main) collectMain();
}

/** Trims, waits for it to take effect, and says how much was handed back. */
async function freeMemory() {
  const before = memoryReport().totalMB;
  trimAll({ main: true });
  await new Promise((r) => setTimeout(r, 1500));
  const after = memoryReport().totalMB;
  return { before, after, freedMB: Math.max(0, before - after) };
}

// In the background: trim once after a minute without focus (Lookup isn't being looked at, so nothing is lost).
const BACKGROUND_MS = 60 * 1000;
let bgTimer = null;
app.on('browser-window-blur', () => {
  clearTimeout(bgTimer);
  bgTimer = setTimeout(() => { if (!BrowserWindow.getFocusedWindow()) trimAll({ main: true }); }, BACKGROUND_MS);
});
app.on('browser-window-focus', () => { clearTimeout(bgTimer); bgTimer = null; });

module.exports = { memoryReport, connectionUse, trimAll, freeMemory, processKB };
