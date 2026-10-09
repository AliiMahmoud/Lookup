// Where Lookup keeps its data: portable mode ("Lookup-data" next to the .exe) and carrying data over from OraDesk. Runs on require, before anything reads the data folder.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Portable mode: keep connections, history and settings in "Lookup-data" next to the .exe.
// Active for the portable .exe (electron-builder sets PORTABLE_EXECUTABLE_DIR), or when a
// file named "portable" sits next to Lookup.exe (e.g. an unzipped folder build).
(function usePortableDataDir() {
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR
    || (app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), 'portable')) ? path.dirname(process.execPath) : null);
  if (!exeDir) return;
  const dataDir = path.join(exeDir, 'Lookup-data');
  try {
    // The app used to be called OraDesk: carry its data folder over once.
    const oldDir = path.join(exeDir, 'OraDesk-data');
    if (!fs.existsSync(dataDir) && fs.existsSync(oldDir)) fs.renameSync(oldDir, dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
    app.setPath('sessionData', dataDir);
  } catch { /* read-only location: fall back to %APPDATA% */ }
})();

// The app used to be called OraDesk: copy saved connections, history and settings from its
// data folder the first time Lookup starts (installed builds; portable mode handles it above).
(function migrateFromOraDesk() {
  try {
    const now = app.getPath('userData');
    const old = path.join(path.dirname(now), 'OraDesk');
    if (path.basename(now) !== 'Lookup' || !fs.existsSync(old)) return;
    fs.mkdirSync(now, { recursive: true });
    if (fs.existsSync(path.join(now, 'connections.json'))) return; // already migrated or set up fresh
    // "Local State" holds the key that decrypts saved passwords; "Local Storage" the query tabs.
    for (const f of ['connections.json', 'history.json', 'settings.json', 'Local State', 'Local Storage']) {
      const src = path.join(old, f), dst = path.join(now, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.cpSync(src, dst, { recursive: true });
    }
  } catch { /* nothing to migrate */ }
})();
