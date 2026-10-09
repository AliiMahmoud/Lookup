# Lookup

A fast desktop client for Oracle Database, in the spirit of TablePlus: connection manager, schema browser, editable data grid, structure/DDL views and a SQL editor.

Built with **Electron** and **node-oracledb in Thin mode**, so it talks to Oracle directly in JavaScript — **no Oracle Instant Client to install**.

Formerly called OraDesk. On first start Lookup copies saved connections (with their passwords), history, settings and query tabs from the OraDesk data folder, and a portable `OraDesk-data` folder is renamed to `Lookup-data`. Saved window state (query tabs, sidebar width, SQL log panel) is moved to Lookup's own keys on first start.

## Run it

Requirements: Node.js 20+ on Windows, macOS or Linux.

```bash
npm install
npm start
```

## Build a Windows installer

On a Windows machine:

```bash
npm run dist:win        # NSIS installer -> dist/Lookup Setup 0.1.0.exe
npm run dist:portable   # single portable .exe
```

## Portable mode

`npm run dist:portable` builds `dist/Lookup-<version>-portable.exe`, a single file that needs no installation.

In portable mode, connections, history and settings are kept in a `Lookup-data` folder **next to the .exe** instead of `%APPDATA%`. Portable mode is on automatically for the portable .exe, and for an unzipped folder build when a file named `portable` sits next to `Lookup.exe`.

Saved passwords are still encrypted with the Windows account that saved them, so on another PC the connections carry over but you re-enter the passwords.

## Features

**Connections**
- Home screen like TablePlus: Lookup's logo and version with **Create Connection**, **Import Connections** and **Export Connections** on the left; on the right a search box and your connections, each with a round badge in its tag colour, the tag in brackets and `host : service` under the name
- Double-click or `Enter` connects, `↑` `↓` move, typing searches; right-click for Connect, Connect in a new tab, Edit…, Duplicate…, Delete. The connection form opens in a dialog (Create Connection, `+`, Edit…)
- Home screen like TablePlus: Lookup's logo and version with **Create Connection**, **Import Connections** and **Export Connections** on the left; on the right a search box and your connections, each with a round badge in its tag colour, the tag in brackets and `host : service` under the name
- Double-click or `Enter` connects, `↑` `↓` move, typing searches; right-click for Connect, Connect in a new tab, Edit…, Duplicate…, Delete. The connection form opens in a dialog (Create Connection, `+`, Edit…)
- Basic (host / port / service name or SID) or a full connect string (EZConnect or TNS descriptor)
- Roles: Default, SYSDBA, SYSOPER, SYSBACKUP
- Colour tags (Local / Dev / Staging / Production). Production adds a confirmation before data-changing statements and grid commits
- The eye button in the password field shows or hides the password (including a saved one)
- Passwords encrypted with the OS keychain (DPAPI on Windows). If no keychain is available, the password is never written to disk and the app asks for it on connect

**Several databases at once**
- Open connections are listed in a rail on the left (database icon in the tag colour + name); each has its own sidebar, query tabs, results and transaction
- Click a tile to switch; `+` (or `Ctrl+N`) opens another saved connection; drag tiles to reorder; right-click for Disconnect, Move up / down, Disconnect all others, or hover and click its × (`Ctrl+Shift+W`) to disconnect; disconnecting removes the tile, and an empty "New" tile disappears when you switch away from it
- `Ctrl+Alt+→` / `Ctrl+Alt+←` next/previous connection, `Ctrl+Alt+1…9` jump to one, `Ctrl+Shift+W` close it
- Colour tags and an amber dot for an uncommitted transaction show on each tile
- Opening a database that is already open (the same saved connection, or another one with the same host, port, service and user) switches to its tab instead of starting a second session
- Right-click a saved connection → Connect in a new tab
- **Import / export** (buttons on the home screen): reads Oracle SQL Developer connection exports (XML, or the newer JSON) and writes SQL Developer's XML, so connections move both ways. Basic (host / port / service name or SID), custom JDBC URLs and SYSDBA / SYSOPER roles are supported; TNS-alias and non-Oracle connections are listed as skipped, and ones you already have are unticked. SQL Developer's own passwords can't be read (they're encrypted with a key tied to its installation). Export can **include passwords**, encrypted (AES-256-GCM, key from scrypt) with a password you choose for the file; Lookup asks for it on import, and SQL Developer imports those connections without passwords

**Lost connections**
- While connecting, **Cancel** (or Esc) stops waiting and returns to the connection form; if the server answers afterwards, that session is closed straight away
- Connecting gives up after the **connect timeout** (60 s by default) instead of waiting forever. It's the total wait: Oracle's driver applies its timeout to each address of a host in turn (localhost is both ::1 and 127.0.0.1 on a Mac), so Lookup caps the whole attempt
- If the database or network goes away, the status bar turns red ("Connection lost") with a **Reconnect** button; it's noticed when a call fails, by a network **keep-alive probe** (every 60 s by default), and by an **idle health check** (every 30 s by default)
- All three are set in seconds in the gear menu: pick a common value from each submenu, or Custom… to type any number (Off / 0 turns the keep-alive or health check off). The connect timeout and keep-alive apply to new connections and Reconnect; the health check applies at once. Easy Connect strings get the keep-alive rounded to whole minutes (a driver limit); host/port connections and TNS descriptors use the exact seconds
- **Stop** sends the database one cancel request, like SQL Developer or DBeaver: the button shows "Stopping…" and the results "Cancelling…", and when the database confirms you get a plain "Query cancelled". The database notices the request the next time it checks, so a busy query can take a few seconds. Nothing is retried and no extra session is opened, so the database gets no extra load. If it still hasn't stopped after 10 seconds you can **Keep waiting** or **Close session** (the database then ends the query and rolls back uncommitted changes; `Ctrl+R` reconnects)
- Reconnect (`Ctrl+R`) opens a fresh session with the same login (uncommitted changes on the lost session are rolled back by the database)

**Other databases on the same server**
- The database button in the title bar (left, next to the connection name, beside **Query** which opens a new query tab) lists the pluggable databases (PDBs) on the server you're connected to, plus CDB$ROOT
- Pick one to open it in a new connection with the same login; it's saved as "<name> · <PDB>" so you can reopen it, and an already-open PDB just switches to its tile
- Closed (mounted) PDBs are shown but can't be opened. Seeing other PDBs needs a connection to CDB$ROOT with access to `V$PDBS`

**SQL log** (title bar log button, or `Ctrl+Shift+L`)
- A panel listing every statement Lookup ran by itself on this connection: opening tables and counts, metadata and DDL lookups, grid inserts/updates/deletes, structure changes, COMMIT/ROLLBACK, exports
- Your own queries from query tabs are not listed (they're in Query history)
- Drag its top edge to resize; the query editor shrinks first and the results always keep a few rows visible
- Bind values are shown inline, with timestamp, duration, row counts and errors; filter, copy all, clear, and toggle syntax highlighting

**Browser**
- Schema switcher, object filter (the × or Esc clears it), tables, views, materialized views, sequences, packages, procedures, functions, triggers, types, synonyms
- Invalid objects are underlined
- Right-click a table → Truncate table… or Delete table… (both red, with a confirmation; on Production you type the table name). Delete offers CASCADE CONSTRAINTS and PURGE
- `Ctrl+P` jumps to any object

**Data grid**
- Server-side paging (`OFFSET … FETCH`); rows per page: click for 100 / 300 / 500 / 1,000, or double-click to type any number up to 100,000 (Enter applies, Esc cancels), sorting by clicking headers, row count
- Filters: column + operator (=, <>, <, >, contains, like, in, is null…) or a raw `WHERE` clause; right-click a cell → filter by value
- Inline editing, add rows, delete rows. Edits stay pending (yellow / green / red) until you **Preview SQL** or **Commit** (`Ctrl+S`). All edits run in one transaction keyed by `ROWID` and roll back together on error
- Row details side panel, long-text editor, set NULL, copy cell / rows as TSV
- Virtualized rendering, so large pages scroll smoothly

**Export** (`Ctrl+E`, the download button, or right-click a table → Export data…)
- Formats: CSV (comma, semicolon, tab or pipe; UTF-8 with BOM for Excel), Excel `.xlsx` (real number and date cells, frozen header), JSON (array or JSON Lines), SQL `INSERT` script (optional `CREATE TABLE` + indexes first, `COMMIT` every N rows)
- Rows: the whole table (respecting the current filter and sort), the current page, or selected rows
- Query results: export the rows shown, or re-run the query without the row limit to export everything
- Pick which columns to include
- Streams in batches on a separate connection, so millions of rows don't freeze the app; progress, Cancel, and Show in folder

**New table** (the `+` on the TABLES header)
- TablePlus-style editor: table name, Primary key chips, and a column list with column_name, data_type (suggestions for common Oracle types, including identity), is_nullable and column_default
- New tables start with `id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY`; a single-column key is written inline, a multi-column key as a named constraint, and typing PRIMARY KEY in data_type works too
- Type in the empty row to add a column; right-click a row to add it to the primary key, make it an identity (auto-increment), insert, move or delete
- Preview SQL, or Create table (`Ctrl+S`); the new table opens in Structure view. Plain names are stored in upper case like any unquoted Oracle name

**Structure & DDL**
- Columns (types, nullability, defaults, comments, PK, identity), constraints, indexes
- Editable for tables: rename columns, change type / nullable / default / comment, add or drop columns; add primary key, unique, foreign key (pick the table and its columns, on delete cascade / set null) or check constraints; enable, disable or drop constraints; add or drop indexes; table comment
- Changes are highlighted and stay pending: Preview SQL, Discard, or Apply (`Ctrl+S`). Statements run in a safe order (drops, renames, changes, adds, constraints, indexes, comments) and stop at the first error, showing what already ran — Oracle commits each DDL statement on its own
- Full DDL via `DBMS_METADATA`: the table plus its indexes, comments, triggers and (optionally) grants; toggle storage/tablespace clauses and the schema prefix
- Copy, save as `.sql`, or open in the editor

**SQL editor**
- Syntax highlighting, line numbers, current-statement marker
- **Beautify** (`Ctrl+B`): formats the selection or the whole script with uppercase keywords and 2-space indents; comments and PL/SQL blocks are kept as written, and `Ctrl+Z` undoes it
- `Ctrl+Enter` runs the statement under the cursor (or the selection); `Ctrl+Shift+Enter` runs the whole script
- Understands PL/SQL blocks terminated by `/`, `q'[…]'` quotes and comments
- Autocomplete for keywords, functions, schemas, objects and columns (`alias.` resolves the table)
- `DBMS_OUTPUT` shown in Messages, error position jumps to the failing spot, Explain plan, Stop
- Manual commit by default: `Ctrl+S` commits. While a transaction is open the status bar shows "Uncommitted transaction"; click it to commit, roll back or turn auto-commit on. Auto-commit can also be set per connection in the connection form
- Results show the first 500 rows by default (limit picker: 100 / 500 / 1,000 / 5,000 / No limit); "limit reached" means there are more, and Export → re-run without the limit writes them all to a file
- The results panel stays hidden until you run something, then appears below the editor; the × on its tab bar closes it (and frees the rows from memory) and the next run brings it back
- Query history, open/save `.sql`, query tabs restored per connection

## Memory

Lookup is tuned for laptops with little RAM. Measured with `npx electron test/bench.js` (the real app with a simulated database; numbers are PSS, i.e. the app's real share of RAM):

| Scenario | Before | Now |
|---|---|---|
| Started, connection list | 269 MB | **189 MB** |
| Connected, a table open (300 rows) | 276 MB | **195 MB** |
| + a query result of 50,000 rows | 339 MB | **240 MB** |
| 3 connections, a table open in each | 316 MB | **225 MB** |

What changed: software rendering instead of a GPU process (-50 MB), all connections share one renderer process (about -20 MB per extra connection), the network service runs inside the main process (-16 MB), V8 tuned for size, the Oracle driver loads on first connect (-13 MB at startup), and large results are converted in place instead of copied.

The gear (settings) in the top-right corner of the title bar has **Dark theme** and **Follow system theme** switches (applied at once to every window and remembered), the connection timings, shows the memory in use (read each time the menu opens), and lets you turn GPU acceleration or separate processes per connection back on (takes effect after restart). Query results are capped at 500 rows by default (100, 1,000, 5,000 or No limit in the picker). **No limit** keeps every row in memory, so for very large results use Export, which streams them to a file.

## Shortcuts

| Keys | Action |
|---|---|
| `Ctrl+N` | Open a connection (saved list, or New connection…) |
| `Ctrl+T` / `Ctrl+W` | New query tab / close tab |
| `Ctrl+Tab` | Next tab |
| Double-click a tab | Rename it (Enter saves, Esc cancels); right-click for close others / to the right / all |
| `Ctrl+P` | Open anything |
| `Ctrl+R` / `Ctrl+Shift+R` | Reconnect this connection (after it was lost, or to start a fresh session; asks first if there are uncommitted changes) |
| `Ctrl+R` / `Ctrl+Shift+R` | Reconnect this connection (after it was lost, or to start a fresh session; asks first if there are uncommitted changes) |
| `Ctrl+Shift+L` | Show / hide the SQL log |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` | Run statement / run all |
| `Ctrl+Space` | Autocomplete |
| `Ctrl+B` (also `Ctrl+I`, `Ctrl+Shift+F`) | Beautify SQL (selection or whole editor) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset. With the cursor in the SQL editor only that editor zooms (remembered per query tab); anywhere else the whole window zooms (remembered between runs). The title bar and connection rail stay at normal size |
| `Ctrl+/` | Toggle comment |
| `Ctrl+S` | Commit (grid edits in a table tab, otherwise the open transaction) · applies pending changes in Structure / New table |
| `Ctrl+Shift+S` | Save the query tab as .sql |
| `Ctrl+F` / `F5` | Filter / refresh (table tab) |
| `Enter`, `F2`, double-click | Edit cell |
| Drag / `Shift`+click / `Shift`+arrows | Select a range of cells (drag past the edge to auto-scroll) |
| Click or drag row numbers | Select whole rows; `Ctrl`+click adds or removes single rows |
| `Ctrl+C` / `Ctrl+Shift+C` | Copy selection as tab-separated cells (pastes into Excel) / with headers |
| `Ctrl+A` | Select all rows |
| `Del` | Mark the selected row(s) for deletion (a single selected cell deletes its row) |
| `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) | Undo / redo uncommitted grid changes: deletes, edits, added rows, Discard |

## Project layout

Plain JavaScript, no build step. Each file does one job and starts with a one-line comment saying what it is.

```
src/
  main/                       Electron main process
    main.js                   entry point: loads the modules below in start-up order, app lifecycle
    app-data.js               data folder (portable mode, carry-over from OraDesk)
    app-settings.js           settings.json, theme, start-up flags that keep memory low
    windows.js                windows: title bar shell + one view per connection
    connection-menus.js       + menu, databases (PDB) menu, switching to an already-open database
    settings-menu.js          gear menu (memory, theme, connection timings, performance)
    app-menu.js               File / Edit / View menu and shortcuts
    zoom.js                   editor-only or whole-window zoom
    popup-menu.js             the gear, +, databases and tile menus, drawn in the app's own menu style over the window
    ipc/                      IPC handlers: handle.js (helper), shell.js, db.js, files.js
    db/                       Oracle access (node-oracledb Thin); index.js is the public API
      connection.js           connect, Test, Cancel, Stop, Reconnect, transactions
      settings.js             connect descriptor, timeouts, keep-alive
      health.js               lost-connection detection and the idle health check
      metadata.js, ddl.js     schemas, objects, structure, PDBs; DDL via DBMS_METADATA
      table-data.js           paging and grid edits; table-admin.js: create / alter / truncate / drop
      query.js                running the user's SQL; export-job.js: streaming exports
      sql-log.js, values.js, sessions.js, driver.js
    sqlgen.js                 bound SQL for grid edits, filters and DDL (unit-tested)
    export.js                 CSV / Excel / JSON / SQL writers
    format.js                 Beautify (sql-formatter)
    store.js                  saved connections (encrypted passwords) and history
    conn-seal.js              passwords in exported files, locked with the file password
  preload.js, shell-preload.js  safe bridges: window.api and window.shellApi
  shared/sqlsplit.js          Oracle script splitter (unit-tested)
  renderer/
    index.html                a connection workspace; shell.html: title bar + rail; menu.html: pop-up menu layer
    styles.css                imports styles/*.css in order (tokens, titlebar, controls, welcome, workspace, grid, …)
    js/app/                   the workspace, one feature per file, sharing window.Lookup
      core.js                 shared state and constants (loaded first)
      status.js               title bar state, status bar, transactions, lost connection + Reconnect
      connections.js          welcome screen, connection form, connecting
      conn-io.js              import / export connections (Oracle SQL Developer format)
      workspace.js            entering / leaving a connection, SQL log panel, window commands
      sidebar.js, tabs.js     object tree, menus, Open anything; workspace tabs
      table-tab.js            table Data view and the rows-per-page picker
      table-design.js         New table, editable Structure, DDL view
      query-tab.js            query tabs: run, Stop, results, history
      exports.js, settings.js export entry points; Custom… seconds and zoom
      boot.js                 keyboard shortcuts and start-up (loaded last)
    js/                       shared UI pieces: util, editor, grid, export dialog, create-table, structure, sqllog, shell
test/
  run.js, *-test.js           unit tests: npm test
  smoke*.js                   boot the real app with a simulated database: npx electron test/<name>.js
  smoke-tour.js               visits most screens and checks for errors
  smoke-home.js               home screen: list, search, keyboard, menu, connection dialog
  smoke-home.js               home screen: list, search, keyboard, menu, connection dialog
  smoke-conn-io.js            import / export (with and without passwords) of SQL Developer connection files
  smoke-menus.js              the pop-up menus (+, tile, Esc / click outside); menu-helper.js drives them
  bench.js                    memory benchmark
```

## Notes and limits

- Paging uses `OFFSET … FETCH`, which needs Oracle 12c or later.
- Thin mode supports Oracle 12.1+. For older databases or features such as native network encryption with certain settings, switch node-oracledb to Thick mode (`oracledb.initOracleClient()` in `src/main/db.js`) and install Instant Client.
- Committing grid edits commits the whole session, including statements run in query tabs; the app warns you when that applies.
- Grid editing is for tables (via `ROWID`). Views are read-only. Binary columns are shown as hex and edited through SQL.
- No SSH tunnel yet; use an existing tunnel (`ssh -L 1521:db:1521 bastion`) and connect to `localhost`.
