// App-styled pop-up menus for the window shell (gear, +, databases ▾, right-click on a connection
// tile). They are drawn in a transparent view laid over the whole window, so they can overlap the
// connection views the way native menus do, but look like the app's own context menus.
// Templates use the Electron menu format: { label, click, enabled, type: 'checkbox'|'radio'|
// 'separator', checked, accelerator, submenu }, plus `hint` (grey text on the right) and `danger`.
const path = require('path');
const { WebContentsView, ipcMain, screen } = require('electron');

const layers = new WeakMap(); // BrowserWindow -> { view, ready, pending, actions, refocus, idle }
// The layer is a page of its own (about 2 MB): closed after this long unused, made again on the next menu.
const IDLE_MS = 2 * 60 * 1000;

function layerFor(win) {
  let L = layers.get(win);
  if (L) return L;
  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, '../menu-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  view.setBackgroundColor('#00000000');
  view.setVisible(false);
  L = { view, ready: false, pending: null, actions: new Map(), refocus: null };
  layers.set(win, L);
  win.contentView.addChildView(view);
  view.webContents.once('did-finish-load', () => {
    L.ready = true;
    if (L.pending) { view.webContents.send('menu:show', L.pending); L.pending = null; }
  });
  view.webContents.loadFile(path.join(__dirname, '../renderer/menu.html'));
  if (!win.menuLayerHooks) { // once per window, however often the layer is made again
    win.menuLayerHooks = true;
    const hideOnChange = () => hide(win);
    win.on('resize', hideOnChange);
    win.on('blur', hideOnChange);
    win.on('closed', () => layers.delete(win));
  }
  return L;
}

/** Closes an unused layer's page to free its memory. */
function release(win) {
  const L = layers.get(win);
  if (!L || L.view.getVisible() || win.isDestroyed()) return;
  layers.delete(win);
  try { win.contentView.removeChildView(L.view); } catch { /* already gone */ }
  if (!L.view.webContents.isDestroyed()) L.view.webContents.close();
}

const keyLabel = (acc) => (acc ? acc.replace(/CmdOrCtrl|CommandOrControl/g, process.platform === 'darwin' ? '⌘' : 'Ctrl') : null);

// Turns a template into plain data for the menu page; click handlers stay here, keyed by id.
function serialize(items, actions) {
  return items.filter(Boolean).map((it) => {
    if (it.type === 'separator') return { separator: true };
    const id = actions.size + 1;
    if (it.click) actions.set(id, it.click);
    return {
      id,
      label: it.label,
      hint: it.hint || keyLabel(it.accelerator),
      checked: it.type === 'checkbox' || it.type === 'radio' ? !!it.checked : undefined,
      disabled: it.enabled === false,
      danger: !!it.danger,
      submenu: it.submenu ? serialize(it.submenu, actions) : undefined,
    };
  });
}

/** Shows a menu. `at` = { x, y } in window coordinates (optionally `right` to align the menu's
 *  right edge there); without `at` the menu opens at the mouse pointer. */
function showMenu(win, template, at) {
  if (!win || win.isDestroyed()) return;
  const L = layerFor(win);
  clearTimeout(L.idle);
  if (!at || at.x === undefined) {
    const c = win.getContentBounds();
    const p = screen.getCursorScreenPoint();
    at = { x: p.x - c.x, y: p.y - c.y };
  }
  L.actions = new Map();
  const payload = { items: serialize(template, L.actions), at };
  const focused = win.webContents.isFocused() ? win.webContents : (win.workspaces || []).map((w) => w.view.webContents).find((wc) => wc.isFocused());
  L.refocus = focused || null;
  const [w, h] = win.getContentSize();
  L.view.setBounds({ x: 0, y: 0, width: w, height: h });
  win.contentView.addChildView(L.view); // on top of the connection views
  L.view.setVisible(true);
  L.view.webContents.focus();
  if (L.ready) L.view.webContents.send('menu:show', payload); else L.pending = payload;
}

function hide(win) {
  const L = layers.get(win);
  if (!L || !L.view.getVisible()) return;
  L.view.setVisible(false);
  L.view.webContents.send('menu:hide');
  if (L.refocus && !L.refocus.isDestroyed()) L.refocus.focus();
  clearTimeout(L.idle);
  L.idle = setTimeout(() => release(win), IDLE_MS);
}

const winOfMenu = (sender) => {
  for (const w of require('electron').BrowserWindow.getAllWindows()) { const L = layers.get(w); if (L && L.view.webContents === sender) return w; }
  return null;
};
ipcMain.on('menu:choose', (event, id) => {
  const win = winOfMenu(event.sender);
  if (!win) return;
  const L = layers.get(win);
  const action = L.actions.get(id);
  hide(win);
  if (action) setImmediate(() => action());
});
ipcMain.on('menu:close', (event) => { const win = winOfMenu(event.sender); if (win) hide(win); });

module.exports = { showMenu };
