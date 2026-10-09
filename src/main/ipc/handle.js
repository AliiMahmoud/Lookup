// handle(): registers an IPC handler that returns { ok, data } or { ok: false, error }.
const { ipcMain } = require('electron');

// Every handler returns { ok, data } or { ok: false, error } so Oracle error text
// (ORA-xxxxx) reaches the UI intact.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(event.sender.id, ...args) };
    } catch (e) {
      return { ok: false, error: { message: e.message, code: e.code, offset: e.offset } };
    }
  });
}

module.exports = { handle };
