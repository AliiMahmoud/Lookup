// Test helpers for the shell's pop-up menus (drawn in the menu layer, src/renderer/menu.html).
const { webContents } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const layer = () => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().includes('menu.html'));

/** Items of every open panel: "✓ Label  hint ▸" (✓ = ticked, ▸ = has a submenu), panels joined by " | ". */
async function menuItems() {
  const wc = layer();
  if (!wc) return null;
  return wc.executeJavaScript(`[...document.querySelectorAll('.menu-panel')].map((p) => [...p.children].map((r) => r.classList.contains('ctx-sep') ? '—'
    : (r.querySelector('.ic svg path') && !r.querySelector('.ctx-chevron') || (r.firstChild && r.firstChild.querySelector && r.firstChild.querySelector('svg')) ? '✓ ' : '')
      + r.querySelector('.ctx-label').textContent + (r.querySelector('.ctx-hint') ? '  ' + r.querySelector('.ctx-hint').textContent : '')
      + (r.classList.contains('disabled') ? ' [disabled]' : '') + (r.classList.contains('has-sub') ? ' ▸' : '')))`);
}
/** Clicks the item whose label starts with `label`, in the deepest open panel that has it. */
async function clickItem(label) {
  const wc = layer();
  await wc.executeJavaScript(`(() => { const rows = [...document.querySelectorAll('.menu-panel .ctx-item')].reverse();
    const r = rows.find((x) => x.querySelector('.ctx-label').textContent.startsWith(${JSON.stringify(label)}));
    if (!r) throw new Error('no menu item ' + ${JSON.stringify(label)}); r.click(); })(); 1`);
  await wait(150);
}
const isOpen = async () => { const wc = layer(); return !!wc && (await wc.executeJavaScript(`document.querySelectorAll('.menu-panel').length`)) > 0; };
module.exports = { menuItems, clickItem, isOpen, layer };
