// Changing data from the MongoDB workspace: read-only connections refuse, Production connections ask
// first (the window sends the request again with confirmed: true, as for Redis).
function guard(s, what, confirmed) {
  if (s.conn.readOnly) {
    throw Object.assign(new Error(`This connection is read-only, so ${what} was not run. Turn off "Read-only" in the connection's settings to change data.`), { code: 'READ_ONLY' });
  }
  if ((s.cfg.env === 'prod' || s.cfg.env === 'production') && !confirmed) {
    throw Object.assign(new Error(`${what} will change data on a Production connection.`), { code: 'CONFIRM_WRITE' });
  }
}

module.exports = { guard };
