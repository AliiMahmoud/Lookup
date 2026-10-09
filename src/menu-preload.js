// Bridge for the pop-up menu layer: receives a menu to show and reports the chosen item.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuApi', {
  platform: process.platform,
  onShow: (cb) => ipcRenderer.on('menu:show', (_e, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on('menu:hide', () => cb()),
  choose: (id) => ipcRenderer.send('menu:choose', id),
  close: () => ipcRenderer.send('menu:close'),
});
