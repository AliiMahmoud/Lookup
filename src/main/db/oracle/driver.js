// Oracle: loads node-oracledb (Thin mode: pure JavaScript, no Instant Client) on first use, so the app starts lighter.

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
