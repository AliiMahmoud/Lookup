// App settings (settings.json): theme, zoom, network timings, and the start-up flags that keep memory low. Flags are applied on require, so this loads before the app is ready.
const path = require('path');
const fs = require('fs');
const { app, nativeTheme } = require('electron');
const db = require('./db');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  gpu: false, separateProcesses: false, zoom: 100, theme: 'system', // theme: system | light | dark
  connectTimeoutSec: 60, keepAliveSec: 60, healthCheckSec: 30, // network, in seconds (0 = off for the last two)
};

function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { return { ...DEFAULT_SETTINGS }; }
}

function writeSettings(next) {
  try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2)); } catch { /* read-only */ }
}

const settings = readSettings();

const startedWith = { ...settings };

// Light / dark: themeSource switches prefers-color-scheme in every window at once.
nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';

// Measured with test/bench.js (see README "Memory"):
//  - software rendering instead of the GPU process: about -50 MB (a database grid does not need the GPU)
//  - all connections share one renderer process: about -20 MB per extra connection
//  - network service inside the main process: about -16 MB (the app makes no web requests)
//  - V8 tuned for size: smaller heaps with large result sets
if (!settings.gpu) app.disableHardwareAcceleration();

if (!settings.separateProcesses) app.commandLine.appendSwitch('process-per-site');

app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');

app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,BackForwardCache');

if (!app.commandLine.hasSwitch('js-flags')) app.commandLine.appendSwitch('js-flags', '--optimize-for-size');

db.configure({ connectTimeoutSec: settings.connectTimeoutSec, keepAliveSec: settings.keepAliveSec, healthCheckSec: settings.healthCheckSec });

function setTheme(theme) {
  settings.theme = theme;
  writeSettings(settings);
  nativeTheme.themeSource = theme;
}

module.exports = { writeSettings, settings, startedWith, setTheme };
