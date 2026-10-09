// Bridge for the window's title bar (connection tabs).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellApi', {
  platform: process.platform,
  ready: () => ipcRenderer.send('shell:ready'),
  onWorkspaces: (cb) => ipcRenderer.on('shell:workspaces', (_e, data) => cb(data)),
  activate: (id) => ipcRenderer.send('shell:activate', id),
  close: (id) => ipcRenderer.send('shell:close', id),
  connectMenu: (at) => ipcRenderer.send('shell:connectMenu', at),
  tileMenu: (id) => ipcRenderer.send('shell:tileMenu', id),
  pdbMenu: (at) => ipcRenderer.send('shell:pdbMenu', at),
  settingsMenu: (at) => ipcRenderer.send('shell:settingsMenu', at),
  action: (name) => ipcRenderer.send('shell:action', name),
  move: (id, to) => ipcRenderer.send('shell:move', { id, to }),
});
