# Lookup: notes for Claude Code

Lookup (formerly **OraDesk**) is a TablePlus-style desktop client for **Oracle Database**, built by
Ali with Claude. Electron + plain JavaScript (no build step, no framework) + node-oracledb in
**Thin mode** (pure JS, no Oracle Instant Client). The main user works on a **Mac with limited RAM**
and also targets **Windows** (installer + portable .exe). README.md has the full feature list.

## Commands

```bash
npm install
npm start                       # run the app (quit it fully and restart after main-process changes)
npm test                        # unit tests: run.js, binds-test, export-test, alter-test, lost-test
npx electron test/smoke-tour.js # one smoke test: boots the real app with a simulated database
npx electron test/bench.js      # memory benchmark (PSS per process); see README "Memory"
npm run dist:win | dist:portable | dist:zip   # Windows builds (electron-builder), run on Windows
```

On Linux CI/containers run Electron tests as `xvfb-run -a npx electron test/<name>.js --no-sandbox`.
Each smoke test prints one `SMOKE-…` JSON line (or `… FAILED` + stack) and exits.

Smoke tests: `smoke` (IPC, export, password never stored plain), `smoke-tabs`, `smoke-dedupe`,
`smoke-disconnect`, `smoke-pdb`, `smoke-settings` (gear menu, flags), `smoke-rename` (OraDesk data
migration, title bar, 500-row limit, show password, SQL log height), `smoke-zoom`, `smoke-lost`,
`smoke-cancel` (cancel connecting), `smoke-stop`, `smoke-tour` (visits most screens, reports console
errors), `smoke-menus` (shell pop-up menus), `smoke-conn-io` (SQL Developer import/export, with and
without passwords), `smoke-home` (home screen). `test/menu-helper.js` drives the pop-up menu layer.
Tests stub the database by `Object.assign(require('../src/main/db'), { connect, run, … })` before
requiring `src/main/main.js`; there is no real Oracle in tests.

## Architecture

Processes (kept to 3 for memory): main (network service runs inside it), GPU (software rendering;
hardware acceleration is off by default) and **one shared renderer** for all views via `process-per-site`.

- **Main process** `src/main/`: `main.js` only sets start-up order and lifecycle.
  - Order matters: `app-data.js` (portable `Lookup-data` folder, OraDesk carry-over) → `app-settings.js`
    (reads settings.json, applies Chromium flags *before* ready) → everything else.
  - `windows.js`: a window = **shell** (title bar + left rail, `renderer/shell.html`) + one
    `WebContentsView` per connection workspace (`renderer/index.html`) at x=RAIL_W(76), y=TITLE_H(40).
  - `popup-menu.js` + `renderer/menu.html`: a transparent view laid over the window that draws the
    gear / + / databases ▾ / tile menus in the app's own style. Only File/Edit/View stays native.
  - `ipc/handle.js`: every handler returns `{ ok, data }` or `{ ok:false, error }`; `ipc/shell.js`,
    `ipc/db.js`, `ipc/files.js` hold the handlers. Workspace id = its webContents id (`winId`).
  - `db/` is the Oracle layer; **`db/index.js` is the only entry point** (tests stub it):
    connection, settings (descriptor, timeouts, keep-alive), health (lost connections, idle ping),
    sql-log, metadata, ddl (DBMS_METADATA), table-data (paging, grid edits by ROWID), query (user SQL),
    table-admin, export-job, values, sessions, driver (lazy `require('oracledb')`).
  - `sqlgen.js` builds all bound SQL (unit-tested). `store.js` = connections (passwords encrypted with
    Electron `safeStorage`, never plaintext) + history. `conn-seal.js` = passwords in exported files.
- **Preloads**: `preload.js` (`window.api`), `shell-preload.js` (`window.shellApi`), `menu-preload.js`.
- **Workspace renderer** `src/renderer/js/app/*.js`: one feature per file, sharing **`window.Lookup`**.
  `core.js` loads first (state `S`, constants), `boot.js` last; index.html lists the order. Cross-file
  calls are `Lookup.fn()`; shared constants are destructured at the top (`const { S } = Lookup`).
  Shared widgets in `js/`: util (h(), icons, modal, toast, contextMenu), editor, grid, export dialog,
  create-table, structure, sqllog, shell, menu.
- **Styles**: `styles.css` only `@import`s `styles/*.css` **in order** (tokens, titlebar, controls,
  welcome, workspace, grid, editor, query, table-design, dialogs, sqllog). Later rules win ties, so
  check class-name collisions (`.xp-*` belongs to the export dialog; connections export uses `.cx-*`).
  Images in styles/ use `url('../assets/…')`.

## Rules and conventions

- **Memory first.** Lazy-load heavy modules (oracledb, exceljs, sql-formatter); no new processes; no
  new dependencies without a reason. Re-run `test/bench.js` after anything that could add memory.
- **Don't break behaviour.** Before refactors: commit, record all smoke outputs, compare after.
  For CSS moves, compare screenshots and computed styles (that's how the style split was verified).
- Every source file starts with a one-line comment saying what it is. Plain words, no jargon in UI.
- User queries run via `conn.rawExecute` (not in the SQL log); app-issued SQL goes through the logged
  `conn.execute`. Bind names must start with a letter (`__x` binds broke with NJS-098).
- Connect strings are always full `(DESCRIPTION=…)` descriptors (EZConnect parsing broke, NJS-515).
- Keep localStorage keys prefixed `oradesk.` (renaming them would lose users' saved query tabs).
- Destructive actions on Production-tagged connections require typing the name / confirming.
- After changing main-process code, the user must quit the app fully; the preload shows a
  "restart" message for "No handler registered" errors.

## Product decisions (from Ali, keep unless asked)

- Name **Lookup**; app icon = red database (`build/icon.ico`, `assets/app-icon.svg`).
- Home screen like TablePlus: logo + version + Create / Import / Export buttons left; search +
  connection list right (initials badge in tag colour, `(tag)`, `host : service`); form in a dialog.
- Left rail of open connections (tiles), no duplicate session to the same database (switch instead),
  PDB menu (database ▾) and **Query** button left in the title bar, gear (settings) top-right.
- Query tab: row limit default **500**, options 100/500/1000/5000/**No limit (last)**; results panel
  hidden until a run and closable; Beautify = **Ctrl+B** (also Ctrl+I), silent on unparsable SQL.
- Transactions: manual commit, **Ctrl+S** commits; no commit/rollback buttons in the title bar or
  tile menu; status bar shows "Uncommitted transaction" only while one is open.
- Stop: send **one** break, show "Cancelling…", plain "Query cancelled"; after 10 s offer Keep waiting
  / Close session. Never auto-disconnect or retry (avoid extra DB load).
- Lost connection: red status + Reconnect (**Ctrl+R / Ctrl+Shift+R**); gear settings for connect
  timeout, keep-alive and idle health check, all in **seconds**. Connecting has a Cancel button.
- Zoom: Ctrl +/−/0 zooms only the SQL editor when it has focus, else the window; no zoom toasts.
- Gear menu = app-styled pop-up (not native): memory, dark theme / follow system, timings submenus,
  GPU and separate-process toggles (off by default to save RAM).
- Import/export connections in **Oracle SQL Developer** format (XML + JSON import, XML export).
  Export can include passwords sealed with a file password (AES-256-GCM, scrypt); SQL Developer then
  imports without passwords. Sample file: `test/fixtures/sqldeveloper-connections-test.xml` (7 import, 2 skipped on purpose).
- Other shortcuts: Ctrl+N connect, Ctrl+T query tab, Ctrl+W close tab, Ctrl+P open anything,
  Ctrl+E export, Ctrl+Shift+L SQL log, Ctrl+Shift+S save .sql, Ctrl+Z/Y grid undo/redo.

## Known limits / gotchas

- The driver's connect timeout applies **per address**; `localhost` on a Mac is ::1 and 127.0.0.1,
  so a hung server can take 2× the timeout. A fix (overall deadline) was written and then reverted
  at Ali's request; using `127.0.0.1` avoids it.
- Stop speed depends on the server noticing the in-band break (Thin mode has no out-of-band break).
- Mac Keychain: passwords saved under the old "OraDesk" name can't be decrypted after the rename;
  users re-enter them once.
- "Window move completed without beginning" in the macOS terminal is harmless (custom title bar).

## Next: multi-database support (planned, not started)

Agreed approach: phase 1, put an **adapter interface** in front of `db/` with Oracle as the first
adapter (no visible change, verify with the full smoke suite); phase 2, PostgreSQL (`pg`) browse /
query / export, engine picker in the connection form, Pg/Ms/Oc badges; phase 3, MySQL/MariaDB
(`mysql2`); phase 4, grid edits by primary key + Structure view; phase 5, create/alter table + DDL.
Oracle-specific spots to abstract: metadata views, DBMS_METADATA, ROWID edits, paging/quoting/binds
in sqlgen, PL/SQL script splitting (`shared/sqlsplit.js`), break-based Stop, ORA- error codes,
PDB menu, SYSDBA roles, DBMS_OUTPUT. ClickHouse could come later (read-only).
