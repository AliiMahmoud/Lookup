// Opening connections into workspaces: the + menu, the databases (PDB) menu, and switching to a database that is already open.
const { BrowserWindow, dialog } = require('electron');
const db = require('./db');
const store = require('./store');
const { TITLE_H, RAIL_W, wsByWc, addWorkspace, activateWorkspace, activeWorkspaceOf } = require('./windows');
const { showMenu } = require('./popup-menu');

// Two saved connections point at the same database login when target and user match.
function connKey(cfg) {
  if (!cfg) return null;
  const target = cfg.mode === 'string'
    ? String(cfg.connectString || '').replace(/\s+/g, '').toLowerCase()
    : `${String(cfg.host || 'localhost').toLowerCase()}:${cfg.port || 1521}/${String(cfg.service || '').toLowerCase()}/${cfg.serviceType || 'service'}`;
  return `${target}|${String(cfg.user || '').toUpperCase()}|${cfg.role || 'DEFAULT'}`;
}

/** An open (or connecting) tab for this saved connection or the same database login, in any window. */
function findOpenWorkspace(connId, exceptId) {
  const key = connKey(store.connections.get(connId));
  for (const w of BrowserWindow.getAllWindows()) {
    for (const ws of w.workspaces || []) {
      if (ws.id === exceptId || !(ws.state.connected || ws.state.connecting)) continue;
      if (ws.state.connId === connId || (key && ws.state.connKey === key)) return ws;
    }
  }
  return null;
}

/** Switches to the existing tab instead of opening a second session to the same database. */
function focusExisting(connId, exceptId) {
  const ws = findOpenWorkspace(connId, exceptId);
  if (!ws) return false;
  if (ws.win.isMinimized()) ws.win.restore();
  ws.win.focus();
  activateWorkspace(ws.win, ws.id);
  ws.view.webContents.send('ws:action', { action: 'flash' });
  return true;
}

function openConnection(win, connId, fromWs) {
  if (focusExisting(connId)) return;
  // Reuse an empty "New connection" tab instead of stacking blank tabs.
  const target = fromWs && !fromWs.state.connected && !fromWs.state.connecting ? fromWs : null;
  if (target) target.view.webContents.send('ws:action', { action: 'connect', connId });
  else addWorkspace(win, { connectId: connId });
}

/** A saved connection for another PDB on the same server: reuse one that matches, else save a copy. */
function connectionForPdb(base, pdb) {
  let cfg;
  if (base.mode === 'string') {
    const cs = String(base.connectString || '');
    let next = null;
    if (/SERVICE_NAME\s*=/i.test(cs)) next = cs.replace(/(SERVICE_NAME\s*=\s*)[^)\s]+/i, `$1${pdb.service}`);
    else if (/^[^()]+\/[^/]+$/.test(cs.trim())) next = cs.trim().replace(/\/[^/]+$/, `/${pdb.service}`);
    if (!next) throw new Error('Cannot derive a connect string for this PDB from the current one.');
    cfg = { ...base, connectString: next };
  } else {
    cfg = { ...base, serviceType: 'service', service: pdb.service };
  }
  const key = connKey(cfg);
  const existing = store.connections.list().find((c) => connKey(c) === key);
  if (existing) return existing.id;
  const { id, password, ...rest } = cfg;
  const baseName = String(base.name || base.user).replace(/\s*·\s*[^·]+$/, '');
  return store.connections.save({ ...rest, name: `${baseName} · ${pdb.name}`, password, savePassword: !!password });
}

async function popupPdbMenu(win, at) {
  const ws = activeWorkspaceOf(win);
  if (!ws || !ws.state.connected) return;
  let info;
  try { info = await db.pdbs(ws.id); } catch (e) { info = { list: [], note: e.message }; }
  const base = store.connections.get(ws.state.connId);
  const items = info.list.map((p) => {
    const isCurrent = p.name === info.current;
    let target = null;
    try { target = base ? connKey(base.mode === 'string' ? { ...base } : { ...base, serviceType: 'service', service: p.service }) : null; } catch { target = null; }
    const openWs = !isCurrent && target ? [...wsByWc.values()].find((x) => (x.state.connected || x.state.connecting) && x.state.connKey === target) : null;
    const hint = isCurrent ? 'this connection' : openWs ? 'open · switch to it' : p.open ? null : String(p.openMode || 'closed').toLowerCase();
    return {
      label: p.name,
      hint,
      type: isCurrent || openWs ? 'checkbox' : 'normal',
      checked: isCurrent || !!openWs,
      enabled: !isCurrent && (p.open || !!openWs),
      click: () => {
        if (openWs) { activateWorkspace(openWs.win, openWs.id); return; }
        try { openConnection(win, connectionForPdb(base, p), null); } catch (e) { dialog.showErrorBox('Open database', e.message); }
      },
    };
  });
  if (info.note) items.push(...(items.length ? [{ type: 'separator' }] : []), { label: info.note, enabled: false });
  if (!items.length) items.push({ label: 'No databases found', enabled: false });
  showMenu(win, items, at);
}

// The + menu for opening another connection.
function popupConnectMenu(win, { atRail = false, at: anchor } = {}) {
  const conns = store.connections.list();
  const active = activeWorkspaceOf(win);
  const items = conns.map((c) => {
    const open = !!findOpenWorkspace(c.id);
    return {
      label: c.name || c.user,
      hint: [c.env && c.env !== 'none' ? c.env : null, open ? 'open · switch to it' : null].filter(Boolean).join(' · ') || null,
      type: open ? 'checkbox' : 'normal',
      checked: open,
      click: () => openConnection(win, c.id, active),
    };
  });
  if (items.length) items.push({ type: 'separator' });
  items.push({ label: 'New connection…', click: () => { if (active && !active.state.connected) activateWorkspace(win, active.id); else addWorkspace(win); } });
  // From the keyboard, open it next to the rail's + button rather than at the mouse.
  const at = anchor || (atRail ? { x: RAIL_W - 8, y: TITLE_H + Math.min(win.workspaces.length, 9) * 76 + 10 } : null);
  showMenu(win, items, at);
}

module.exports = { connKey, focusExisting, openConnection, popupPdbMenu, popupConnectMenu };
