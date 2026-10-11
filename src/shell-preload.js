// Bridge for the window's title bar (connection tabs).
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Main asks every page to hand back memory it no longer uses (after big results are closed, or from the gear menu).
ipcRenderer.on('mem:trim', () => { try { webFrame.clearCache(); } catch { /* ignore */ } });

contextBridge.exposeInMainWorld('shellApi', {
  platform: process.platform,
  ready: () => ipcRenderer.send('shell:ready'),
  onWorkspaces: (cb) => ipcRenderer.on('shell:workspaces', (_e, data) => cb(data)),
  activate: (id) => ipcRenderer.send('shell:activate', id),
  close: (id) => ipcRenderer.send('shell:close', id),
  connectMenu: (at) => ipcRenderer.send('shell:connectMenu', at),
  newConnection: () => ipcRenderer.send('shell:newConnection'),
  tileMenu: (id) => ipcRenderer.send('shell:tileMenu', id),
  pdbMenu: (at) => ipcRenderer.send('shell:pdbMenu', at),
  settingsMenu: (at) => ipcRenderer.send('shell:settingsMenu', at),
  action: (name) => ipcRenderer.send('shell:action', name),
  move: (id, to) => ipcRenderer.send('shell:move', { id, to }),
});
