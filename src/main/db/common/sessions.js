// Open sessions, one per connection workspace (keyed by its webContents id).
// A session = { engine, conn, cfg, autoCommit, colCache, schema, busy, log, … engine-specific fields }.

const sessions = new Map();

function get(winId) {
  const s = sessions.get(winId);
  if (!s) throw new Error('Not connected');
  if (s.lost) throw new Error(`${s.lost}. Reconnect from the status bar.`);
  return s;
}

module.exports = { sessions, get };
