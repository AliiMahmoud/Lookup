# Lookup

A fast desktop client for **Oracle**, **PostgreSQL**, **MySQL / MariaDB**, **SQLite**, **ClickHouse**, **Redis** and **MongoDB**, in the spirit of TablePlus: connection manager, schema browser, data grid, structure/DDL views and a SQL editor — for Redis, a key browser, key editors, a Workbench and a redis-cli Shell, and for MongoDB, a Compass-like collection view with a light mongosh-style shell.

Built with **Electron**. Every database is reached with a pure-JavaScript driver (node-oracledb in Thin mode, node-postgres, mysql2, the official ClickHouse and MongoDB drivers), the SQLite built into Electron itself, or, for Redis, Lookup's own small Redis protocol client, so there is **no client software to install** (no redis-cli or mongosh either).

| | Oracle | PostgreSQL | MySQL / MariaDB | SQLite | ClickHouse |
|---|---|---|---|---|---|
| Connect, Test, Stop, Reconnect, lost-connection detection | ✓ | ✓ | ✓ | ✓ (a file) | ✓ (HTTP/S) |
| Browse objects, Structure, DDL | ✓ | ✓ | ✓ | ✓ | ✓ |
| Table data with paging, filters, sorting, count; export | ✓ | ✓ | ✓ | ✓ | ✓ |
| Query tabs: row limit, Explain, Beautify | ✓ | ✓ | ✓ | ✓ | ✓ |
| Transactions (manual commit, Ctrl+S) | ✓ | ✓ | ✓ | ✓ | — none in ClickHouse |
| Edit rows in the grid, create / alter / truncate / drop tables | ✓ | later | later | later | — (analytics; use SQL) |
| Databases menu (database ▾) | PDBs | databases | — (databases are the schemas) | — (attached files are the schemas) | — (databases are the schemas) |

Redis and MongoDB aren't SQL, so each gets its own workspace (see **Redis** and **MongoDB** below).

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
- Home screen: your saved connections on the left, each with a badge of its initials ("Ali Oracle DB" → **AO**) in its database's colour (the tooltip names the database type); on the right Lookup's logo and the main shortcuts until you click a connection, which opens its form there (× closes it). Double-click connects
- **+ New** first asks which database (Oracle / PostgreSQL / MySQL cards; arrow keys and Enter work), then shows that database's form. While making a new connection, the form's **Type** row switches to another database, keeping name, tag, host and login (a saved connection keeps its type, so editing one doesn't show it)
- Oracle: Basic (host / port / service name or SID) or a full connect string (EZConnect or TNS descriptor); roles Default, SYSDBA, SYSOPER, SYSBACKUP
- PostgreSQL and MySQL: host, port, database and SSL (Prefer — SSL when the server has it, like psql —, Require, Require and verify certificate, Off), or a URL (`postgres://…`, `mysql://…`). MariaDB is detected and shown by name
- SQLite: a database file — **Open file…** or **New file…** (creates an empty database), optionally **read-only**. No password. Attached databases (`ATTACH '…' AS x`) show up as schemas
- ClickHouse: host, port (8123, or 8443 for HTTPS), database, user and password, or a URL (`https://…:8443` for ClickHouse Cloud). No transactions, so auto-commit is always on
- Redis (also Valkey): host, port 6379, database number, TLS (Off / TLS / TLS and verify certificate), user (ACL, optional) and password, or a URL (`redis://user@host:6379/0`, `rediss://` for TLS), and **Read-only (block write commands)**. Without a user Lookup connects without asking for a password and asks only if the server wants one
- MongoDB (also FerretDB, Amazon DocumentDB, Azure Cosmos DB for MongoDB): hosts (one, or several for a replica set), port 27017, Standard or SRV (`mongodb+srv://`, Atlas), default database, read preference, authentication (username / password, SCRAM-SHA-256 / SHA-1, LDAP (PLAIN), X.509 certificate, AWS IAM, or none) and auth database, TLS (Off / On / On, allow invalid certificates), replica set, or a URL; the form shows the URL it builds. **Read-only (block changes)**. Kerberos is not supported
- Colour tags (Local / Dev / Staging / Production). Production adds a confirmation before data-changing statements and grid commits
- The eye button in the password field shows or hides the password (including a saved one)
- Passwords encrypted with the OS keychain (DPAPI on Windows). If no keychain is available, the password is never written to disk and the app asks for it on connect

**Several databases at once**
- Open connections are listed in a rail on the left: a connected one shows its badge (initials in its database's colour, with a dot in its tag colour) and its name under it; the tooltip says which database type; each has its own sidebar, query tabs, results and transaction
- Click a tile to switch; `+` (or `Ctrl+N`) opens another saved connection; drag tiles to reorder; right-click for Disconnect, Move up / down, Disconnect all others, or hover and click its × (`Ctrl+Shift+W`) to disconnect; disconnecting removes the tile, and an empty "New" tile disappears when you switch away from it
- `Ctrl+Alt+→` / `Ctrl+Alt+←` next/previous connection, `Ctrl+Alt+1…9` jump to one, `Ctrl+Shift+W` close it
- Colour tags and an amber dot for an uncommitted transaction show on each tile
- Opening a database that is already open (the same saved connection, or another one with the same database type, host, port, service or database and user) switches to its tab instead of starting a second session
- Right-click a saved connection → Connect in a new tab
- **Import / export** (the two icons next to New on the home screen): reads Oracle SQL Developer connection exports (XML, or the newer JSON) and writes SQL Developer's XML, so connections move both ways. Basic (host / port / service name or SID), custom JDBC URLs and SYSDBA / SYSOPER roles are supported, and SQL Developer's MySQL connections are imported too; TNS-alias connections and other types are listed as skipped, and ones you already have are unticked. PostgreSQL and MySQL connections are written to the same file with Lookup's own fields, so they move between Lookup installs (SQL Developer can't open them). SQL Developer's own passwords can't be read (they're encrypted with a key tied to its installation). Export can **include passwords**, encrypted (AES-256-GCM, key from scrypt) with a password you choose for the file; Lookup asks for it on import, and SQL Developer imports those connections without passwords

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

**Redis**
- **Key browser** (sidebar): database picker with key counts (switches in place), filter by pattern (`user:*`, as Redis matches it) or plain text (keys containing it, upper or lower case; an exact key comes first). A filter is searched in Redis itself, step after step, until 300 matches are found or every key was looked at, so a key is found wherever it is in a big database, type chips (String, Hash, List, Set, ZSet, Stream, JSON), keys grouped in folders at `:`, each with its type, time to live and memory. Keys are read with `SCAN` in steps (never `KEYS`), with type / TTL / memory for each step in one round trip; **Scan more** looks further, **Scan all** reads the whole database (it asks first above 200,000 keys; **Stop** keeps what was found), and the footer says how much of the database was scanned. Right-click a key: open, copy name or command, rename, set time to live, delete; right-click a folder to filter to it. `+` creates a key of any type, with an optional time to live
- **Key tabs**: type, name, time to live counting down (click to change or remove it), size; rename (never overwrites another key), reload, delete
  - Strings: Text / JSON / Hex views; JSON is shown formatted and saved compact; Save keeps the time to live. Binary values are shown as hex; very large values (over 512 KB) are shown in part and read-only
  - Hashes, lists, sets and sorted sets: a table with filter (hashes, sets, sorted sets), Highest / Lowest first (sorted sets), paging or Load more, and a side panel with the selected value as Text / JSON / Hex. Double-click to edit, add rows, mark rows for deletion; changes stay pending (yellow / green / red) and **Save** (`Ctrl+S`) sends them together in `MULTI` / `EXEC`, so they apply all or nothing. List elements are deleted by position safely (marked, then removed)
  - Streams: entries newest first with a column per field, older / newer pages, add and delete entries, consumer groups. JSON keys (RedisJSON module): formatted, saved with `JSON.SET`
- **Workbench** (`Ctrl+T`, title bar): type commands, several lines run one after another; replies formatted (pairs from `HGETALL`, `WITHSCORES` … in two columns, JSON strings pretty) or **Raw**; the command list with arguments appears as you type (Tab / Enter picks), argument hint below the input, history (↑, and the history button), **Stop** releases a blocking command (`CLIENT UNBLOCK`). It runs on its own connection and follows the key browser's database
- **Shell** (`Ctrl+Shift+T`, title bar): redis-cli in a tab — `host:port[db]>` prompt (`(TX)` inside `MULTI`), replies printed exactly as redis-cli prints them (`OK`, `"text"`, `(integer) 1`, `(nil)`, `(error) …`, `(empty array)`, numbered nested lists), grey argument hints as you type, Tab completion, ↑ / ↓ history, `HELP`, `HELP <command>`, `HELP @<group>`, `CLEAR` (`Ctrl+L`), `QUIT`, repeat count (`3 INCR n`). `SUBSCRIBE`, `PSUBSCRIBE`, `SSUBSCRIBE` and `MONITOR` print messages as they arrive until **Ctrl+C**. Each Shell tab has its own connection (its own `SELECT`, `MULTI`, subscriptions); if the server drops it, the prompt says `not connected>` and the next command reconnects, like redis-cli
- **Overview** (title bar): commands per second, memory, clients and hit rate with the last 5 minutes drawn, databases, memory limit and eviction, version, uptime, persistence, replication, modules, slow log; refreshes every 5 s while shown
- **Redis Cluster** is found out by itself when connecting (nothing to set in the form; enter any node). Each key is read and changed on the node holding its slot (hash tags `{…}` respected), and when slots move Lookup follows `MOVED` / `ASK` and updates its slot map. The key browser scans every master in turn and the picker shows "Cluster · N masters · N keys" (a cluster has database 0 only). Workbench commands with a key go to its node (shown next to the time); commands without a key run on the node you pick, or on **every master** with one reply per node. The Shell behaves like `redis-cli -c`: it follows redirects, prints `-> Redirected to slot [12182] located at 10.0.0.3:7002` and its prompt moves to that node. The Overview adds a table of nodes (slots, keys, memory, ops/sec, clients, replicas) and adds the figures up. Nodes that announce an address Lookup can't reach (Docker, SSH tunnels) are tried at the host you typed with the node's port
- **Read-only** connections block every command that changes data (Lookup knows the common commands and asks the server about others with `COMMAND INFO`); **Production** connections ask first and show the exact commands that will be sent
- Status bar: user, host, database, version, memory used and number of keys. The SQL log lists what Lookup sent (SCAN, pipelined TYPE / PTTL / MEMORY USAGE, MULTI … EXEC); your own Workbench and Shell commands are not listed

**MongoDB**
- **Sidebar**: databases and their collections (views and time-series marked) with document counts, filter, right-click to open, create, rename or drop (dropping asks you to type the name); `+` creates a collection (optionally capped or time-series). The topology (Standalone, replica set name, sharded) is shown at the top
- **Collection tabs** with document count, size and index figures, and five sections:
  - **Documents**: Filter / Project / Sort / Limit in mongosh syntax (`{ status: 'paid', total: { $gte: 100 } }`), history of recent queries, **Explain**; views List (expandable documents with coloured types), JSON and Table (a column per field with its type). Edit a document as text and **Update** (`Ctrl+S`): only the changed fields are sent (`$set` / `$unset`), number types are kept (`530` stays a Double), and if someone changed those fields meanwhile you're told instead of overwriting their change. Clone, delete, **Add data** (one document or an array), **Export** (JSON or CSV, the current filter)
  - **Aggregations**: stages as cards with a live preview of each stage's output (a few documents each), turn stages on and off, or edit the whole pipeline as text; **Run** shows the results, **Explain** the plan; save pipelines by name; copy as mongosh code. `$out` / `$merge` run only with Run (and ask first on Production)
  - **Schema**: fields from a sample of documents with how often each appears, its types, top values, number and date ranges as small charts, array lengths; copy as JSON Schema
  - **Indexes**: keys, size, usage, properties (unique, sparse, TTL, partial); create and drop
  - **Validation**: the collection's validator, level and action, edit and save
- **Shell** (`Ctrl+T`, title bar): a light mongosh-style shell — not the real mongosh, so no JavaScript (variables, loops, functions), but the commands people type most: `show dbs`, `show collections`, `use <db>`, `db`, `db.coll.find(…)` / `findOne` / `aggregate` / `countDocuments` / `insertOne` / `updateMany` / `deleteOne` / `createIndex` … with `.sort()` / `.limit()` / `.skip()` / `.projection()` / `.explain()`, `it` for the next 20 documents, `db.runCommand(…)`, `db.getSiblingDB('x').coll…`, `help`. Results are printed like mongosh (`ObjectId('…')`, `ISODate('…')`, `NumberLong(…)`), errors as `MongoServerError[Code]: …`. Grey hints as you type, Tab completion (collections and methods), ↑ / ↓ history, Ctrl+C stops a running command, `cls`, `exit`. Prompt `rs0 [primary] db>` on a replica set
- **Overview** (title bar): operations per second, connections, memory, network, operations since start, replica set members and their state, server version and uptime; refreshes every 5 s
- **Stop** aborts the query and, when the user may, kills it on the server (`killOp`); every Lookup query is tagged so it can be found
- **Read-only** connections block every change; **Production** connections ask first and show what will be sent. The SQL log lists what Lookup ran, in mongosh syntax

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

Lookup is tuned for laptops with little RAM. Measured with `npx electron test/bench.js` (the real app with a simulated Oracle database; numbers are PSS, the app's real share of RAM, on Linux). "Before" is the previous version measured with the same benchmark (which now really connects: older figures were taken with the password question still open):

| Scenario | Before | Now | With a 6,000-object schema: before → now |
|---|---|---|---|
| Started, connection list | 193 MB | **184 MB** | 194 → **184 MB** |
| Connected, a table open (300 rows) | 224 MB | **209 MB** | 264 → **210 MB** |
| + a query result of 50,000 rows | 264 MB | **250 MB** | 302 → **251 MB** |
| 3 connections, a table open in each | 253 MB | **233 MB** | 355 → **235 MB** |
| after opening / closing 80 tabs and 5 connections | 261 MB | **245 MB** | 382 → **246 MB** |

Where the memory goes (from `test/bench.js` and `test/mem-assess.js`): about 115 MB is Electron itself (the main process with the network service and, now, the graphics work); Lookup's own JavaScript in the main process is about 4 MB, and no database driver is loaded until a connection needs it. The page process starts at about 67 MB for the window and its first connection page, and each connection adds about 12 MB plus the rows it holds (50,000 rows of 8 columns ≈ 17 MB). No leak: after opening and closing 80 tabs and 5 connections the DOM size and the JavaScript heap are back where they were (the process keeps about 10 MB of freed memory reserved for reuse).

What keeps it low:
- Software rendering, and its graphics work runs **inside the main process** instead of a GPU process of its own (-9 MB, one process fewer; gear → **Separate graphics process** turns it back on if a machine draws badly)
- All connections share one page process; the network service runs inside the main process; V8 tuned for size
- **Loaded on first use**: every database driver (Oracle, PostgreSQL, MySQL, ClickHouse, MongoDB…), exports (and Excel), Beautify, the **Redis and MongoDB screens** (their code and styles are only added to a connection page that opens one), and the pop-up menu layer (closed again after 2 minutes unused)
- The sidebar puts only the objects **in view** into the page, so a schema with thousands of tables costs the same as a small one (before: about 40 MB for 3,200 rows; the old 2,000-per-group cap is gone)
- Memory is **handed back**: closing tabs, results or a connection, and a minute in the background, ask the pages to drop caches they no longer need (closing a 50,000-row result now gives back about 13 MB that used to stay)
- Large results are converted in place instead of copied

**Watching it**: the gear (settings) menu shows **Memory in use** (read each time it opens); its submenu splits it into the app, graphics and connection pages, lists each connection with the rows it holds and its tabs, and has **Free unused memory**, which says how much it gave back. `npx electron test/bench.js` prints the scenarios above (`BENCH_OBJECTS=6000` for a big schema, `BENCH_DEBUG=1` adds the JavaScript heap and DOM counts), and `npx electron test/mem-assess.js` lists the modules the main process loaded at start.

The gear menu also has **Dark theme** and **Follow system theme** switches (applied at once to every window and remembered), the connection timings, and lets you turn GPU acceleration, separate processes per connection or a separate graphics process back on (takes effect after restart). Query results are capped at 500 rows by default (100, 1,000, 5,000 or No limit in the picker). **No limit** keeps every row in memory, so for very large results use Export, which streams them to a file.

## Shortcuts

| Keys | Action |
|---|---|
| `Ctrl+N` | Open a connection (saved list, or New connection…) |
| `Ctrl+T` / `Ctrl+W` | New query tab (Redis: Workbench) / close tab |
| `Ctrl+Shift+T` | Redis: new Shell tab |
| `Ctrl+S` (MongoDB) | Update the document being edited |
| `Ctrl+Tab` | Next tab |
| Double-click a tab | Rename it (Enter saves, Esc cancels); right-click for close others / to the right / all |
| `Ctrl+P` | Open anything |
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
    connection-menus.js       + menu, databases menu (PDBs / PostgreSQL databases), switching to an already-open database
    settings-menu.js          gear menu (memory, theme, connection timings, performance)
    memory.js                 memory per process, rows per connection, Free unused memory, trimming in the background
    app-menu.js               File / Edit / View menu and shortcuts
    zoom.js                   editor-only or whole-window zoom
    popup-menu.js             the gear, +, databases and tile menus, drawn in the app's own menu style over the window
    ipc/                      IPC handlers: handle.js (helper), shell.js, db.js, files.js
    db/                       database access; index.js is the public API (routes each call to the session's engine)
      engines.js              the engines (oracle, postgres, mysql), each loaded on first use
      common/                 engine-neutral: sessions, connecting / Cancel / Stop / Reconnect (connection.js),
                              network settings (net.js), lost connections and health check (health.js),
                              SQL log, query runs (query.js), export jobs, value conversion
      oracle/                 node-oracledb Thin: connect descriptor, metadata, DBMS_METADATA DDL, ROWID grid edits,
                              table admin, DBMS_OUTPUT, sqlgen.js (bound SQL, unit-tested), dialect.js, profile.js
      postgres/               node-postgres + pg-cursor: catalog metadata, DDL from pg_get_*def, cursor-based
                              row limit, savepoints that keep a transaction alive after a failed statement
      mysql/                  mysql2: information_schema metadata, SHOW CREATE DDL, LIMIT added to SELECTs,
                              KILL QUERY for Stop, warnings shown under results
      sqlite/                 node:sqlite built into Electron, run on one worker thread per file (worker.js);
                              DDL as stored in sqlite_master, keys / indexes from the pragmas
      clickhouse/             @clickhouse/client over HTTP: system-table metadata, SHOW CREATE DDL, results
                              streamed and cut at the row limit, Stop = abort + KILL QUERY, typed filters
      redis/                  own Redis protocol client (resp.js: RESP2/3, TLS, pipelining), key browser (keys.js),
                              values per type (value.js), edits in MULTI/EXEC (edit.js), Workbench and Shell
                              connections (cli.js), Overview, read-only / Production rules (guard.js), Redis
                              Cluster (cluster.js: slots, routing, MOVED / ASK, per-node connections); reached
                              through db.engineOp (Redis has no SQL)
      mongodb/                official driver (loaded on first use): connect.js (URL, auth, TLS, Stop), browse, documents
                              (docs.js), aggregation previews (agg.js), schema sampling, indexes / validation / admin,
                              the light shell (shell.js); values travel as canonical Extended JSON so types stay exact
                              (each engine: index.js lists its functions, profile.js tells the UI what it supports)
    export.js                 CSV / Excel / JSON / SQL writers (SQL literals come from the engine's dialect)
    format.js                 Beautify (sql-formatter)
    store.js                  saved connections (encrypted passwords) and history
    conn-seal.js              passwords in exported files, locked with the file password
  preload.js, shell-preload.js  safe bridges: window.api and window.shellApi
  shared/sqlsplit.js          script splitter: Oracle (PL/SQL, /), PostgreSQL ($$ bodies), MySQL (DELIMITER),
                              SQLite (trigger bodies), ClickHouse
  shared/redis-cli.js         redis-cli line splitting and reply printing (Shell, Workbench and tests)
  shared/redis-commands.js    Redis commands: argument hints, completion, HELP, which ones change data
  shared/mongo-lit.js         mongosh values: parse and print ObjectId(…), ISODate(…), NumberLong(…) to and from Extended JSON
  shared/mongo-shell.js       MongoDB shell methods: hints, completion, HELP
  renderer/
    index.html                a connection workspace; shell.html: title bar + rail; menu.html: pop-up menu layer
    styles.css                imports styles/*.css in order (tokens, titlebar, controls, welcome, workspace, grid, …)
    js/app/                   the workspace, one feature per file, sharing window.Lookup
      core.js                 shared state and constants (loaded first)
      engines.js              database types for the UI: badges, form defaults, what the connected engine supports
      status.js               title bar state, status bar, transactions, lost connection + Reconnect
      connections.js          welcome screen, connection form, connecting
      conn-io.js              import / export connections (Oracle SQL Developer format)
      workspace.js            entering / leaving a connection, SQL log panel, window commands
      sidebar.js, tabs.js     object tree, menus, Open anything; workspace tabs
      table-tab.js            table Data view and the rows-per-page picker
      table-design.js         New table, editable Structure, DDL view
      query-tab.js            query tabs: run, Stop, results, history
      exports.js, settings.js export entry points; Custom… seconds and zoom
      features.js             loads the Redis / MongoDB screens (scripts + styles) on their first connection
      engine-ops.js           calls for Redis / MongoDB (api.op), the Production question, a text prompt
      redis.js                Redis workspace: key browser, new keys, key menus, Production question (rop)
      redis-key.js            Redis key tabs: string / JSON, table editor (hash, list, set, sorted set), stream
      redis-cli.js            Redis Workbench and Shell tabs
      redis-overview.js       Redis Overview tab
      mongo.js                MongoDB workspace: database tree, menus, document view and coloured values
      mongo-coll.js           MongoDB collection tabs: Documents, Aggregations, Schema, Indexes, Validation
      mongo-shell.js          MongoDB Shell tab and Overview
      boot.js                 keyboard shortcuts and start-up (loaded last)
    js/                       shared UI pieces: util, editor, grid, export dialog, create-table, structure, sqllog, shell
test/
  run.js, *-test.js           unit tests: npm test
  smoke*.js                   boot the real app with a simulated database: npx electron test/<name>.js
  smoke-tour.js               visits most screens and checks for errors
  smoke-conn-io.js            import / export (with and without passwords) of SQL Developer connection files
  smoke-menus.js              the pop-up menus (+, tile, Esc / click outside); menu-helper.js drives them
  pg-test.js, mysql-test.js, clickhouse-test.js, redis-test.js   engines against real servers (skipped when none is running);
                              redis-test.js also compares Lookup's replies with the real redis-cli's
  sqlite-test.js              the SQLite engine on real files
  smoke-engines.js            the real app against real PostgreSQL, MariaDB and ClickHouse servers and a SQLite file
  smoke-redis.js              the real app against a real Redis server: key browser, key tabs, Workbench, Shell, Overview
  redis-cluster-test.js, smoke-redis-cluster.js   the Redis engine and the app against a real 3-master cluster
  mongodb-test.js, smoke-mongodb.js   the MongoDB engine and the app against a real MongoDB-compatible server (FerretDB)
  start-test-servers.sh       starts the local test servers (Linux)
  bench.js                    memory benchmark (scenarios, BENCH_OBJECTS, BENCH_DEBUG)
  mem-assess.js               what the main process loads at start, page heaps and DOM size
```

## Notes and limits

- PostgreSQL 11+, MySQL 5.7+ / MariaDB 10.3+, any SQLite file, ClickHouse 22+. Their tables are read-only in the grid for now (change data with SQL in a query tab); creating and altering tables comes later. ClickHouse stays read-only in the grid: it is built for analytics, and row edits are slow mutations there.
- SQLite runs inside Lookup on its own thread (no extra process). SQLite can't be interrupted from outside, so **Stop** opens the file again on a fresh thread at once; a statement that was in the middle of one long step finishes in the background and is then **rolled back** (changing statements always run under a savepoint), so a stopped statement never commits. A query that never ends (an endless recursive WITH) keeps one CPU core busy until Lookup quits.
- Redis 5+ and Valkey, standalone servers and Redis Cluster (Sentinel is not supported yet; connect to the current primary). On a cluster, commands over several keys need the keys in one slot (use hash tags), as in any Redis client. The Shell prints replies exactly like redis-cli, including `\xHH` for non-ASCII bytes; the Workbench shows UTF-8 text as text. Very long replies are cut after 20,000 elements (the rest is counted), and a `MONITOR` flood shows at most 2,000 messages per 50 ms (the rest is counted)
- MongoDB 4.2+ (and compatible servers: FerretDB, DocumentDB, Cosmos DB, with their own limits). Kerberos (GSSAPI) login is not supported; LDAP works with the LDAP (PLAIN) option. The Shell is not JavaScript: it understands `db.collection.method(…)` chains, `show`, `use`, `it`, `db.method(…)` and mongosh literals, and says so for anything else. Edits replace changed top-level fields as a whole (change one array element and the whole array is sent). Schema and Table view read at most the sampled / loaded documents. On FerretDB some features are missing on the server side: no Decimal128 values, no `$sample` (Lookup samples the first documents instead), a SQL-shaped explain plan, no index usage figures
- ClickHouse has no transactions: every statement applies at once, and Ctrl+S just says so. Beautify keeps your casing for ClickHouse, because its names and functions are case-sensitive.
- PostgreSQL with auto-commit off: the first changing statement opens a transaction (reads don't), as in Oracle; each statement inside it runs under a savepoint, so a failing statement is undone on its own and the transaction stays usable. `VACUUM`, `CREATE DATABASE` and the like run outside a transaction.
- MySQL with auto-commit off: the same, using `START TRANSACTION`; remember that MySQL commits by itself before and after DDL (`CREATE`, `ALTER`, `DROP`…), and Lookup shows the transaction as closed afterwards.
- Values are shown exactly as the server sends them (numbers, dates and JSON as text), so nothing is rounded or moved to another time zone.
- Paging uses `OFFSET … FETCH`, which needs Oracle 12c or later.
- Thin mode supports Oracle 12.1+. For older databases or features such as native network encryption with certain settings, switch node-oracledb to Thick mode (`oracledb.initOracleClient()` in `src/main/db.js`) and install Instant Client.
- Committing grid edits commits the whole session, including statements run in query tabs; the app warns you when that applies.
- Grid editing is for tables (via `ROWID`). Views are read-only. Binary columns are shown as hex and edited through SQL.
- No SSH tunnel yet; use an existing tunnel (`ssh -L 1521:db:1521 bastion`) and connect to `localhost`.
