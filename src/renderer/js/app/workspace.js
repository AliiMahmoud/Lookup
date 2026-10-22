// Entering and leaving a connection workspace, the SQL log panel, and commands sent by the window (title bar, menus).
(function () {
  const { toast, confirmBox } = window.U;
  const api = window.api;
  const $ = (sel, root = document) => root.querySelector(sel);
  const Lookup = window.Lookup;
  const { S } = Lookup;

  let sqlLogInst = null;
  function sqlLogPanel() {
    if (!sqlLogInst) sqlLogInst = window.SqlLog.create(document.querySelector('#workspace .main'), api);
    return sqlLogInst;
  }
  async function enterWorkspace() {
    S.lost = null;
    if (sqlLogInst) sqlLogInst.reset(); else if (localStorage.getItem('lookup.sqllog.open') === 'true') sqlLogPanel();
    $('#welcome').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    S.tabs.forEach((t) => { t.destroy && t.destroy(); t.el.remove(); });
    S.tabs = [];
    S.active = null;
    Lookup.renderTitlebar();
    Lookup.renderStatus();
    const own = Lookup.profile().workspace; // Redis / MongoDB have their own screens, loaded on first use
    if (own === 'redis' || own === 'mongodb') {
      await Lookup.loadFeature(own);
      Lookup.renderStatus(); // again, now with the engine's own status-bar items
      await (own === 'redis' ? Lookup.enterRedis() : Lookup.enterMongo());
      return;
    }
    Lookup.renderSidebarShell();
    try {
      S.schemas = await api.schemas();
    } catch { S.schemas = [{ name: S.schema }]; }
    Lookup.paintSchemaSelect();
    await Lookup.loadObjects();
    Lookup.restoreQueryTabs();
    Lookup.renderTabs();
  }
  async function confirmLeave(verb) {
    const pending = S.tabs.some((t) => t.grid && t.grid.changeCount());
    if (pending && !(await confirmBox('Unsaved changes', `Some tables have edits that were not committed. ${verb} anyway?`, verb, true))) return false;
    if (S.txPending && !S.autoCommit && !(await confirmBox('Open transaction', `You have uncommitted changes in this session. ${verb === 'Close' ? 'Closing' : 'Disconnecting'} will roll them back.`, verb, true))) return false;
    return true;
  }
  async function leaveWorkspace({ close = false } = {}) {
    if (S.current) {
      if (!(await confirmLeave(close ? 'Close' : 'Disconnect'))) return;
      Lookup.saveQueryTabs();
      await api.disconnect().catch(() => {});
      S.tabs.forEach((t) => { t.destroy && t.destroy(); t.el.remove(); });
      S.tabs = [];
      S.current = null;
      S.info = null;
    }
    if (close && api.closeSelf) { api.closeSelf(); return; }
    Lookup.showWelcome();
  }
  // Commands from the window title bar (connection tabs and their buttons).
  if (api.onWsAction) {
    api.onWsAction(({ action, connId, dir, message, ...rest }) => {
      if (action === 'zoom') { Lookup.zoomShortcut(dir); return; }
      if (action === 'connectionLost') { Lookup.connectionLost(message); return; }
      if (action === 'askSeconds') { Lookup.askSeconds(rest); return; }
      if (action === 'toast') { toast(message, rest.kind || 'info', 4000); return; }
      if (document.querySelector('.modal-back') && action !== 'close' && action !== 'disconnect') return;
      if (action === 'flash') { if (S.current) toast(`Already connected to ${S.current.name || S.current.user} — switched to this tab`, 'info', 2500); return; }
      if (action === 'shown') { if (!S.current && !document.querySelector('.connecting')) Lookup.showWelcome(); return; }
      if (action === 'sqlLog') { sqlLogPanel().toggle(); return; }
      if (action === 'close' || action === 'disconnect') { leaveWorkspace({ close: true }); return; } // disconnecting removes the tile
      else if (action === 'connect' && !S.current) Lookup.connectTo(connId);
      else if (!S.current) return;
      else if (action === 'newQuery') Lookup.openQueryTab();
      else if (action === 'persistedQueries') Lookup.openPersistedQueries();
      else if (action === 'newShell' && Lookup.openRedisShell) Lookup.openRedisShell();
      else if (action === 'deleteKeys' && Lookup.redisDeletePattern) Lookup.redisDeletePattern();
      else if (action === 'overview') (Lookup.profile().workspace === 'mongodb' ? Lookup.openMongoOverview : Lookup.openRedisOverview)();
      else if (action === 'aggregation' && Lookup.openMongoAggregation) Lookup.openMongoAggregation();
      else if (action === 'openAnything') Lookup.openAnything();
      else if (action === 'commit' || action === 'rollback') Lookup.txAction(action);
      else if (action === 'toggleAutoCommit') Lookup.toggleAutoCommit();
    });
  }

  Object.assign(Lookup, { sqlLogPanel, enterWorkspace, leaveWorkspace });
})();
