// The gear menu in the title bar: memory in use, theme, connection timings, performance options.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const db = require('./db');
const { writeSettings, settings, startedWith, setTheme } = require('./app-settings');
const { activeWorkspaceOf } = require('./windows');
const { handle } = require('./ipc/handle');
const { showMenu } = require('./popup-menu');
const { memoryReport, connectionUse, freeMemory } = require('./memory');

// Settings menu (gear in the title bar). The memory figure is read when it opens.
const RESTART_KEYS = ['gpu', 'separateProcesses', 'separateGpuProcess'];
const restartNeeded = () => RESTART_KEYS.some((k) => !!settings[k] !== !!startedWith[k]);

const NET_KEYS = ['connectTimeoutSec', 'keepAliveSec', 'healthCheckSec'];

function settingsState() {
  return {
    ...db.configure(), // current network values (clamped)
    memory: memoryReport(),
    dark: nativeTheme.shouldUseDarkColors, followSystem: settings.theme === 'system',
    gpu: !!settings.gpu, separateProcesses: !!settings.separateProcesses, separateGpuProcess: !!settings.separateGpuProcess, restartNeeded: restartNeeded(),
  };
}

function applySetting(key, value) {
  if (NET_KEYS.includes(key)) {
    const applied = db.configure({ [key]: value });
    settings[key] = applied[key];
    writeSettings(settings);
  } else if (key === 'dark') setTheme(nativeTheme.shouldUseDarkColors ? 'light' : 'dark');
  else if (key === 'followSystem') setTheme(settings.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : 'system');
  else if (RESTART_KEYS.includes(key)) { settings[key] = !settings[key]; writeSettings(settings); }
  else if (key === 'restart') { app.relaunch(); app.quit(); }
  return settingsState();
}

ipcMain.on('shell:settingsMenu', async (event, at) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const ws = activeWorkspaceOf(win);
  const st = settingsState();
  const conns = await connectionUse();
  const mem = st.memory;
  const rowsText = (n) => (n ? `${n.toLocaleString('en-US')} rows loaded` : 'no rows loaded');
  const free = async () => {
    const r = await freeMemory();
    const target = activeWorkspaceOf(win);
    if (target && !target.view.webContents.isDestroyed()) {
      target.view.webContents.send('ws:action', { action: 'toast', kind: 'info', message: r.freedMB ? `Freed ${r.freedMB} MB · ${r.after} MB in use` : `Nothing more to free · ${r.after} MB in use` });
    }
  };
  // Connection timings: common values, plus Custom… which asks for any number of seconds.
  const secs = (label, key, choices, offOk) => {
    const cur = st[key];
    const list = [...new Set([...choices, cur])].sort((x, y) => x - y);
    return {
      label,
      hint: cur ? `${cur} s` : 'off',
      submenu: [
        ...list.map((v) => ({ label: v === 0 && offOk ? 'Off' : `${v} seconds`, type: 'radio', checked: v === cur, click: () => applySetting(key, v) })),
        { type: 'separator' },
        { label: 'Custom…', enabled: !!ws, click: () => ws.view.webContents.send('ws:action', { action: 'askSeconds', key, label, current: cur, min: offOk ? 0 : 1 }) },
      ],
    };
  };
  showMenu(win, [
    {
      label: `Memory in use: ${mem.totalMB} MB`,
      hint: `${mem.processes} processes`,
      submenu: [
        ...mem.parts.map((p) => ({ label: p.label, hint: `${p.mb} MB`, enabled: false })),
        ...(conns.length ? [{ type: 'separator' }, ...conns.map((c) => ({ label: c.title, hint: c.rows === undefined ? '' : `${rowsText(c.rows)} · ${c.tabs} tabs`, enabled: false }))] : []),
        { type: 'separator' },
        { label: 'Free unused memory', click: free },
      ],
    },
    { type: 'separator' },
    { label: 'Dark theme', type: 'checkbox', checked: st.dark, click: () => applySetting('dark') },
    { label: 'Follow system theme', type: 'checkbox', checked: st.followSystem, click: () => applySetting('followSystem') },
    { type: 'separator' },
    secs('Connect timeout', 'connectTimeoutSec', [10, 20, 30, 60, 120, 300], false),
    secs('Keep-alive probe every', 'keepAliveSec', [0, 15, 30, 60, 120, 300], true),
    secs('Idle health check every', 'healthCheckSec', [0, 10, 15, 30, 60, 120], true),
    { type: 'separator' },
    { label: 'Use GPU acceleration', hint: 'uses more memory', type: 'checkbox', checked: st.gpu, click: () => applySetting('gpu') },
    { label: 'Separate process per connection', hint: 'uses more memory', type: 'checkbox', checked: st.separateProcesses, click: () => applySetting('separateProcesses') },
    { label: 'Separate graphics process', hint: 'uses more memory', type: 'checkbox', checked: st.separateGpuProcess || st.gpu, enabled: !st.gpu, click: () => applySetting('separateGpuProcess') },
    { type: 'separator' },
    { label: st.restartNeeded ? 'Restart Lookup to apply' : 'Restart Lookup', click: () => applySetting('restart') },
  ], at);
});

handle('app:settings', () => settingsState());

handle('app:setSetting', (_id, key, value) => applySetting(key, value));
