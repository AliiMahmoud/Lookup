// Loads node-oracledb (Thin mode: pure JavaScript, no Instant Client) on first use, so the app starts lighter.

// Oracle access layer. Uses node-oracledb in Thin mode: pure JavaScript,
// no Oracle Instant Client required. One session per app window.
// The driver is loaded on first use, so the app starts lighter (~13 MB) before any connection.
let driver = null;

function ora() {
  if (!driver) {
    driver = require('oracledb');
    driver.fetchAsString = [driver.NUMBER, driver.CLOB, driver.NCLOB];
    driver.fetchAsBuffer = [driver.BLOB];
  }
  return driver;
}

module.exports = { ora };
