// Bridge for the pop-up menu layer: receives a menu to show and reports the chosen item.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Main asks every page to hand back memory it no longer uses (after big results are closed, or from the gear menu).
ipcRenderer.on('mem:trim', () => { try { webFrame.clearCache(); } catch { /* ignore */ } });

contextBridge.exposeInMainWorld('menuApi', {
  platform: process.platform,
  onShow: (cb) => ipcRenderer.on('menu:show', (_e, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on('menu:hide', () => cb()),
  choose: (id) => ipcRenderer.send('menu:choose', id),
  close: () => ipcRenderer.send('menu:close'),
});
