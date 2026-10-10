// PostgreSQL: loads node-postgres (pg) and pg-cursor on first use (pure JavaScript, no libpq).
// Values arrive as the server's own text, so nothing is shifted by time zones or rounded:
// only booleans and bytea (binary) are converted.

let pg = null;
let Cursor = null;

const BOOL = 16;
const BYTEA = 17;

function driver() {
  if (!pg) {
    pg = require('pg');
    Cursor = require('pg-cursor');
  }
  return { pg, Cursor };
}

/** Per-connection type parsing: text as sent by the server, except booleans and binaries. */
const types = {
  getTypeParser(oid, format) {
    if (oid === BOOL) return (v) => (v === null ? null : v === 't' || v === 'true');
    if (oid === BYTEA) return driver().pg.types.getTypeParser(oid, format);
    return (v) => v;
  },
};

module.exports = { driver, types };
