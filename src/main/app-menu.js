// The application menu (File / Edit / View) and its shortcuts.
const { Menu } = require('electron');
const { isMac, createWindow, addWorkspace, activateWorkspace, cycleWorkspace, focusedWin, activeWc } = require('./windows');
const { popupConnectMenu } = require('./connection-menus');
const { zoomKey } = require('./zoom');

function buildMenu() {
  const conn = (i) => ({
    label: `Connection ${i}`,
    accelerator: `CmdOrCtrl+Alt+${i}`,
    click: () => { const w = focusedWin(); if (w && w.workspaces[i - 1]) activateWorkspace(w, w.workspaces[i - 1].id); },
  });
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Connection…', accelerator: 'CmdOrCtrl+N', click: () => { const w = focusedWin(); if (w) popupConnectMenu(w, { atRail: true }); } },
        { label: 'Open Connection… ', accelerator: 'CmdOrCtrl+Shift+O', visible: false, click: () => { const w = focusedWin(); if (w) popupConnectMenu(w, { atRail: true }); } },
        { label: 'New Connection Tab', accelerator: 'CmdOrCtrl+Alt+N', click: () => { const w = focusedWin(); if (w) addWorkspace(w); } },
        { label: 'Close Connection Tab', accelerator: 'CmdOrCtrl+Shift+W', click: () => { const wc = activeWc(); if (wc) wc.send('ws:action', { action: 'close' }); } },
        { type: 'separator' },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Next Connection', accelerator: 'CmdOrCtrl+Alt+Right', click: () => cycleWorkspace(focusedWin(), 1) },
        { label: 'Previous Connection', accelerator: 'CmdOrCtrl+Alt+Left', click: () => cycleWorkspace(focusedWin(), -1) },
        { label: 'Go to Connection', submenu: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(conn) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => { const wc = activeWc(); if (wc) wc.toggleDevTools(); } },
        { type: 'separator' },
        // In the SQL editor these zoom only that editor; anywhere else, the whole window.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoomKey(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoomKey(1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoomKey(-1) },
        { label: 'Zoom In ', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => zoomKey(1) },
        { label: 'Zoom In  ', accelerator: 'CmdOrCtrl+numadd', visible: false, click: () => zoomKey(1) },
        { label: 'Zoom Out ', accelerator: 'CmdOrCtrl+numsub', visible: false, click: () => zoomKey(-1) },
        { label: 'Actual Size ', accelerator: 'CmdOrCtrl+num0', visible: false, click: () => zoomKey(0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
