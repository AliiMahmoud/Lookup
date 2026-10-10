# Lookup: notes for Claude Code

Lookup (formerly **OraDesk**) is a TablePlus-style desktop client for **Oracle, PostgreSQL,
MySQL / MariaDB, SQLite, ClickHouse, Redis and MongoDB**, built by Ali with Claude. Electron + plain JavaScript (no build
step, no framework); pure-JS drivers only: node-oracledb in **Thin mode**, `pg` + `pg-cursor`, `mysql2`,
`@clickhouse/client`, `mongodb` (official driver, pure JS), Electron's built-in `node:sqlite`, and for Redis our own protocol client
(`db/redis/resp.js`, no dependency; no client software, no native modules, no redis-cli needed). The main user works on a **Mac with limited RAM**
and also targets **Windows** (installer + portable .exe). README.md has the full feature list.

## Commands

```bash
npm install
npm start                       # run the app (quit it fully and restart after main-process changes)
npm test                        # unit tests + pg/mysql/clickhouse/redis/mongodb tests (real servers; skip when none answers) + sqlite-test
test/start-test-servers.sh      # Linux container: start PostgreSQL, MariaDB, ClickHouse, Redis and FerretDB for the tests
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
without passwords), `smoke-engines` (the real app against real PostgreSQL + MariaDB: choose-database
cards, forms, badges, sidebar, read-only table data, queries, transactions, Explain, Beautify, DDL;
`SHOTS=<dir>` saves screenshots), `smoke-redis` (the real app against real Redis: key browser, key tabs
with a hash edit + Save, Workbench, Shell output, SUBSCRIBE + Ctrl+C, Overview, Production question),
`smoke-redis-cluster`, `smoke-mongodb` (the real app against FerretDB: form, tree, find, edit + Update, Table view,
aggregation previews, schema, indexes, Shell, Overview, Production question; `SHOTS=<dir>` saves screenshots).
`test/menu-helper.js` drives the pop-up menu layer.

Redis server for tests: `apt install redis-server` (7.0); `start-test-servers.sh` starts it on 6379 with
/opt/redis/users.acl (users `default` nopass and `lookup`/`lookup`), and a 3-master cluster on 7000-7002
(/opt/rcluster) for `redis-cluster-test.js` / `smoke-redis-cluster.js` (they flush it). The tests use database 9 (flushed).
`LOOKUP_REDIS_URL` overrides. `redis-test.js` compares our reply printing with the real `redis-cli --no-raw`.
MongoDB server for tests: **FerretDB v1.24.0** (static binary from GitHub releases; fastdl.mongodb.org and Percona
are blocked here) in /opt/ferretdb, SQLite backend in /opt/ferretdb/data, 127.0.0.1:27017, no auth;
`start-test-servers.sh` starts it. `LOOKUP_MONGO_URL` overrides. Tests use databases `lookup_test` / `lookup_smoke*` (dropped).
FerretDB limits the tests work around: Decimal128 drops the connection (tests use Double when `buildInfo.ferretdbVersion`
is set), no `$sample` (engine falls back to find + limit), explain is `queryPlanner.Plan` SQL lines (handled), no
`$indexStats` / `$collStats` (fallbacks), and a server bug: a second `$sum` in one `$group` comes out 0 (not ours).
Oracle smoke tests stub the database by `Object.assign(require('../src/main/db'), { connect, run, … })`
before requiring `src/main/main.js`; there is no real Oracle in tests.

ClickHouse server for tests: the static build from GitHub releases (`clickhouse-common-static-<v>-amd64.tgz`,
the clickhouse.com download site is blocked here) unpacked in /opt/ch, data + `lookup-users.xml` (user
lookup/lookup) in /opt/ch/data; `start-test-servers.sh` starts it. `LOOKUP_CH_URL` overrides.
Real servers for the PostgreSQL / MySQL tests (Linux container): `apt install postgresql mariadb-server`,
`pg_ctlcluster 16 main start`, `mkdir -p /run/mysqld && chown mysql: /run/mysqld && mysqld_safe &`;
user `lookup` / password `lookup` (superuser in PostgreSQL, all privileges in MariaDB) and a PostgreSQL
database `shop`. Override with `LOOKUP_PG_URL` / `LOOKUP_MYSQL_URL`. The tests create and drop their own
`lookup_test` schema / database from `test/fixtures/pg-test.sql` and `mysql-test.sql`.

## Architecture

Processes (kept to 2 for memory): main (network service and, with software rendering, the graphics work run inside
it: `in-process-gpu`; hardware acceleration is off by default) and **one shared renderer** for all views via `process-per-site`.

- **Main process** `src/main/`: `main.js` only sets start-up order and lifecycle.
  - Order matters: `app-data.js` (portable `Lookup-data` folder, OraDesk carry-over) → `app-settings.js`
    (reads settings.json, applies Chromium flags *before* ready) → everything else.
  - `windows.js`: a window = **shell** (title bar + left rail, `renderer/shell.html`) + one
    `WebContentsView` per connection workspace (`renderer/index.html`) at x=RAIL_W(76), y=TITLE_H(40).
  - `popup-menu.js` + `renderer/menu.html`: a transparent view laid over the window that draws the
    gear / + / databases ▾ / tile menus in the app's own style. Only File/Edit/View stays native.
  - `ipc/handle.js`: every handler returns `{ ok, data }` or `{ ok:false, error }`; `ipc/shell.js`,
    `ipc/db.js`, `ipc/files.js` hold the handlers. Workspace id = its webContents id (`winId`).
  - `db/` = database access, **separated per engine**; **`db/index.js` is the only entry point** (tests
    stub it). Calls on a workspace go to its session's engine (`onSession`); saved-connection helpers
    (`targetKey`, `cfgForDatabase`) go by `cfg.engine` (missing = `'oracle'`, for old saved connections).
    - `db/engines.js`: registry, each engine lazy-loaded. `db/common/`: engine-neutral only — sessions,
      connection (connect / Test / Cancel / one-request Stop / Reconnect / transactions), net (gear-menu
      timings), health (markLost, idle ping), sql-log, query (run loop, row limit, abort race), export-job,
      values. **Nothing database-specific goes in common/.**
    - `db/oracle|postgres|mysql/index.js` export the same function set: `open, describe, prepareSession,
      targetKey, cfgForDatabase, isLostError, isCancelError, cancel, schemas, objects, columns, structure,
      databases?, ddl, ddlFor, tableData, runStatement, readOutput, inTransaction?, tableExportQuery,
      streamQuery, cancelOn` (+ Oracle only: previewChanges, applyChanges, create/alter/truncate/drop).
      Plus `dialect.js` (quoting, SQL literals for INSERT exports, splitter + formatter language) and
      `profile.js` (sent to the renderer on connect: label, badge, sidebar sections, features, explain,
      select/nextval templates). A missing function = "not supported yet" error; the UI hides it via features.
    - Engine connections are wrapped to look like an oracledb connection (`execute` logged, `commit`,
      `rollback`, `ping`, `close`). PostgreSQL: `PgConn` queues calls (`lock`) so savepoints never
      interleave; cursor-based row limit; Stop = cancel request on a raw socket; values as server text
      (only bool/bytea parsed). MySQL: `MyConn`; Stop = `KILL QUERY` from a 2nd connection; `LIMIT n+1`
      added to plain SELECTs (Workbench style) + streaming cap; tx state from OK-packet status flags.
    - SQLite: `SqliteConn` runs each file on a **worker thread** (`sqlite/worker.js`, started from its source
      text with `eval: true` so it works inside asar). node:sqlite has no interrupt, so Stop rejects the run,
      `terminate()`s the worker without waiting and starts a new one; changing statements run under
      `SAVEPOINT lookup_stmt` even in auto-commit, so an abandoned statement is rolled back, never committed.
      A helper *process* was measured at ~40 MB PSS and rejected (memory rule).
    - ClickHouse: `ChConn` over HTTP; `profile.features.transactions === false` makes the session always
      auto-commit (common/connection.js). Rows via JSONCompactEachRowWithNamesAndTypes, 64-bit ints and
      decimals quoted (exact), stream closed at the row limit; Stop = AbortController + `KILL QUERY`.
      Beautify keeps all casing (names/functions are case-sensitive).
    - Redis (`db/redis/`): not SQL, so besides connect / describe / lost / cancel it exposes `ops`, reached
      through `db.engineOp(winId, name, params)` (IPC `db:op`, preload `api.op`); engine messages to the window
      (Shell SUBSCRIBE / MONITOR output, dropped Shell connections) go through `db.setOnPush` → `db:push` →
      `api.onPush`. `RedisConn.execute(new Cmd([...]) | new Pipe([...], label))` is the logged path (SQL log shows
      redis-cli syntax). The key browser uses the main connection; the Workbench one extra connection (follows the
      browser's database; Stop = `CLIENT UNBLOCK` from the main connection, else drop it); each Shell tab its own
      connection (`shellOpen/Run/Stop/Close`, pushes batched every 50 ms, capped). `guard.js`: read-only blocks,
      Production (`env === 'prod'`) throws `CONFIRM_WRITE` until the window resends with `confirmed: true`.
      Key tab edits are commands built in the window and checked in `edit.js` (editing commands on that key only),
      run in MULTI / EXEC. Values travel as strings, or `{ b64 }` when not UTF-8 text.
      Cluster (`cluster.js`, chosen in `connect.open` when INFO says redis_mode:cluster): `ClusterConn` extends
      `RedisConn`; `execute` routes a Cmd by its key (internal commands: key at arg 1, MEMORY / OBJECT / XINFO
      at 2, see `keyOf`) or to `cmd.node`; Pipes are split per node (MULTI pipes go whole to the first key's
      node); `NodePool` per purpose (browser, Workbench) follows MOVED (slot map refresh) / ASK. User commands
      in the Workbench are routed with COMMAND INFO first-key / GETKEYS (`cli.js userKey`). Scan cursors on a
      cluster are "<master index>:<cursor>". The Shell follows redirects and prints redis-cli -c's line.
      MongoDB (`db/mongodb/`): also `ops` only (profile `workspace: 'mongodb'`, `transactions: false`). Values cross IPC as
      **canonical Extended JSON** (`values.js`: `toWire` / `fromWire`; reads use `READ` = promoteValues/Longs false,
      bsonRegExp) so Int32 / Int64 / Double / Decimal128 stay exact; `shared/mongo-lit.js` parses / prints mongosh literals
      (`ObjectId('…')`, `NumberLong('…')`) to and from it, and `keepTypes(edited, original)` keeps a number's type when its
      value didn't change. `MongoConn.execute(new Op(text, run))` is the logged path (SQL log shows mongosh text); each
      query gets `track()` (comment tag + AbortSignal) so `cancelRunning` aborts and, where allowed, `killOp`s it.
      Document edits = `$set` / `$unset` of changed top-level fields, filter = `_id` + their old values; no match →
      `DOC_CHANGED`. Same `guard.js` rules as Redis (READ_ONLY, CONFIRM_WRITE on Production). `shell.js` is the
      **light shell** (not mongosh, no JS): `parseChain` / `plan` for `db.coll.method(…).cursor…`, `getSiblingDB`,
      `show`, `use`, `it` (batches of 20), write detection via READ_COMMANDS; `shared/mongo-shell.js` = method
      tables, hints, completion, HELP.
      `shared/redis-cli.js` (line splitting, redis-cli TTY printing) and `shared/redis-commands.js` (hints,
      completion, write flags) are used by main, window and tests.
    - Oracle's `sqlgen.js` (bound SQL, unit-tested) now lives in `db/oracle/`. `export.js` writers need
      `options.dialect`. `store.js` = connections (passwords encrypted with Electron `safeStorage`, never
      plaintext) + history. `conn-seal.js` = passwords in exported files.
- **Preloads**: `preload.js` (`window.api`), `shell-preload.js` (`window.shellApi`), `menu-preload.js`.
- **Workspace renderer** `src/renderer/js/app/*.js`: one feature per file, sharing **`window.Lookup`**.
  `core.js` loads first (state `S`, constants), then `engines.js` (ENGINES table for forms/badges,
  `Lookup.profile()` / `feature()` / `dialect()` / `qident()` for the connected engine), `boot.js` last;
  index.html lists the order. Cross-file
  calls are `Lookup.fn()`; shared constants are destructured at the top (`const { S } = Lookup`).
  Shared widgets in `js/`: util (h(), icons, modal, toast, contextMenu), editor, grid, export dialog,
  create-table, structure, sqllog, shell, menu.
  Redis workspace (`profile.workspace === 'redis'`): `enterWorkspace` hands over to `Lookup.enterRedis()`;
  `redis.js` (key browser in #sidebar, `Lookup.rop()` = api.op + the Production question), `redis-key.js`
  (tab kind `rkey`; fake `grid.changeCount()` so the shared close / leave checks see unsaved edits),
  `redis-cli.js` (`rwb` Workbench, `rshell` Shell), `redis-overview.js` (`roverview`). redis.js wraps
  openQueryTab / openAnything / commitShortcut so Ctrl+T, Ctrl+P, Ctrl+S do the Redis thing. Styles: `styles/redis.css`.
  MongoDB workspace (`profile.workspace === 'mongodb'` → `Lookup.enterMongo()`): `mongo.js` (tree, menus,
  `highlight`, `docTree`, wraps for Ctrl+T / Ctrl+P / Ctrl+S), `mongo-coll.js` (collection tab: Documents /
  Aggregations / Schema / Indexes / Validation, `openMongoAggregation`, `explainView`), `mongo-shell.js` (Shell tab,
  `openMongoOverview`). Styles: `styles/mongo.css`.
- **Styles**: `styles.css` only `@import`s `styles/*.css` **in order** (tokens, titlebar, controls,
  welcome, workspace, grid, editor, query, table-design, dialogs, sqllog; redis.css / mongo.css are added as
  `<link>`s by features.js, after them). Later rules win ties, so
  check class-name collisions (`.xp-*` belongs to the export dialog; connections export uses `.cx-*`).
  Images in styles/ use `url('../assets/…')`.

## Rules and conventions

- **Memory first.** Lazy-load heavy modules (oracledb, exceljs, sql-formatter, every driver, export.js); no new
  processes; no new dependencies without a reason. Re-run `test/bench.js` after anything that could add memory
  (`BENCH_OBJECTS=6000` = big schema, `BENCH_DEBUG=1` = JS heap + DOM counts; it answers the password prompt, since
  test machines have no keychain). `test/mem-assess.js` lists main-process modules loaded at start.
  - Renderer: engine-only screens load through `features.js` (`Lookup.loadFeature('redis' | 'mongodb')`, called in
    `enterWorkspace`); their wraps use `Lookup.whenLoaded` (runs at once when loaded late). Shared non-SQL plumbing
    (`opCall`, `rop`, `opFail`, `askText`) is in `engine-ops.js`, always loaded. Long lists must be virtualized like
    the sidebar (`paintVisible`, 23 px rows + spacers).
  - `memory.js` (main): gear-menu report (per process kind, rows per connection via `Lookup.memoryUse`), Free unused
    memory, `mem:trim` to every page (preloads call `webFrame.clearCache`) after a connection closes and after 60 s
    in the background; the renderer trims itself 1.5 s after tabs / results close (`Lookup.trimSoon`).
  - Graphics run in the main process (`--in-process-gpu`) unless GPU acceleration or "Separate graphics process"
    is on; the pop-up menu layer is closed after 2 minutes unused (`popup-menu.js` `release`).
- **Don't break behaviour.** Before refactors: commit, record all smoke outputs, compare after.
  For CSS moves, compare screenshots and computed styles (that's how the style split was verified).
- Every source file starts with a one-line comment saying what it is. Plain words, no jargon in UI.
- User queries run unlogged (Oracle `conn.rawExecute`; PG/MySQL engines use the driver directly);
  app-issued SQL goes through the logged `conn.execute`. Oracle bind names must start with a letter
  (`__x` binds broke with NJS-098). PG binds `$1…`, MySQL `?`.
- Oracle connect strings are always full `(DESCRIPTION=…)` descriptors (EZConnect parsing broke, NJS-515).
- Engine-specific behaviour in the renderer goes through `Lookup.profile()` / `Lookup.feature(name)`,
  never `if engine === …` scattered around (a few display-only checks exist in status/shell/DDL options).
- Phase-1 rule still applies to Oracle: any change must leave the Oracle smoke outputs identical
  (baseline compare), except where the change is intended.
- localStorage keys use the `lookup.` prefix; `app/core.js` moves any old `oradesk.` keys over once.
  The only intended "OraDesk" strings left are the data carry-over (`app-data.js`, that test, the core.js move).
- Destructive actions on Production-tagged connections require typing the name / confirming.
- After changing main-process code, the user must quit the app fully; the preload shows a
  "restart" message for "No handler registered" errors.

## Product decisions (from Ali, keep unless asked)

- Name **Lookup**; app icon = red database (`build/icon.ico`, `assets/app-icon.svg`).
- Home screen: connections list on the left (search, Import / Export icons, + New). The right side
  shows the logo + shortcuts until a connection is clicked (or New / Duplicate); then the form, with
  × to go back. A TablePlus-style home (logo left, form in a dialog) was built and
  then reverted at Ali's request; keep this layout.
- Left rail of open connections: a connected tile shows the connection's initials badge on its database colour, a
  tag dot at its corner and the name as typed under it (2 lines max); connecting / empty tiles keep the database /
  plug icon (Ali's choice, Oct 2026; official logos aren't bundled — trademarks). No duplicate session to the same database
  (switch instead), databases menu (database ▾: Oracle PDBs, PostgreSQL databases; hidden for MySQL)
  and **Query** button left in the title bar, gear (settings) top-right.
- Redis (agreed with mockups, plus a redis-cli Shell at Ali's request): badge **Rd** #d82c20; form Host, Port
  6379, Database, TLS, User, Password, Save password, Read-only (block write commands); title bar shows
  **Workbench** (Ctrl+T), **Shell** (Ctrl+Shift+T) and **Delete keys** (pattern → `redisDeletePattern`) instead of Query,
  and an Overview button on the right;
  sidebar = key browser (db picker "dbN · N keys", filter searched in Redis until 300 matches or the whole
  keyspace — plain text any case via `[aA]` globs, patterns as typed; type chips, folders at ":", Scan more, Scan all / Stop); the Shell must
  print exactly like redis-cli (tested against it).
- MongoDB (agreed with mockups; Ali chose the **light shell** over bundling mongosh): badge **Mg** #13aa52, port 27017,
  password optional; Compass-like collection tabs (Documents / Aggregations / Schema / Indexes / Validation); title bar
  shows **Shell** and **Aggregation**, Overview on the right. Kerberos not supported; LDAP via PLAIN.
- Multi-database UI (agreed with mockups): engine colours #d0473a Oracle, #3b74c4 PostgreSQL, #e48e2a MySQL,
  #0f80cc SQLite, #c9a800 ClickHouse. Home-list badges show the connection's **initials from its name**
  (`Lookup.initials`: "Ali Oracle DB" → AO, "Billing" → Bi) on its database colour, on the home list and the rail (tooltip = type); the engine
  badges (Oc / Pg / My / Sq / Ch / Rd / Mg) stay on the choose-database cards and Type chips. The Type row shows
  only for a new connection (editing a saved one can't switch its type); SQLite form = file + Open file… / New file… +
  read-only (no password prompt); ClickHouse form = host/port (8123 ↔ 8443 with HTTPS)/database/user; **+ New** shows choose-database cards, then the form; a **Type**
  row in the form switches engine; PG/MySQL forms: Host, Port, SSL (prefer default), Database, Fields/URL.
  Status bar shows engine + version (MariaDB named as such); PG title shows `database · schema`.
- Query tab: row limit default **500**, options 100/500/1000/5000/**No limit (last)**; results panel
  hidden until a run and closable; Beautify = **Ctrl+B** (also Ctrl+I), silent on unparsable SQL.
- Transactions: manual commit, **Ctrl+S** commits; no commit/rollback buttons in the title bar or
  tile menu; status bar shows "Uncommitted transaction" only while one is open.
- Stop: send **one** break, show "Cancelling…", plain "Query cancelled"; after 10 s offer Keep waiting
  / Close session. Never auto-disconnect or retry (avoid extra DB load).
- Lost connection: red status + Reconnect (**Ctrl+R / Ctrl+Shift+R**); gear settings for connect
  timeout, keep-alive and idle health check, all in **seconds**. Connecting has a Cancel button.
- Zoom: Ctrl +/−/0 zooms only the SQL editor when it has focus, else the window; no zoom toasts.
- Gear menu = app-styled pop-up (not native): memory (submenu: per process kind, rows per connection, Free unused
  memory), dark theme / follow system, timings submenus, GPU, separate-process and separate-graphics-process
  toggles (off by default to save RAM).
- Import/export connections in **Oracle SQL Developer** format (XML + JSON import, XML export).
  Export can include passwords sealed with a file password (AES-256-GCM, scrypt); SQL Developer then
  imports without passwords. Sample file: `test/fixtures/sqldeveloper-connections-test.xml` (6 import incl. its
  MySQL one, 1 TNS alias skipped on purpose).
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

## Multi-database status

Done: phase 1 (engine layer, Oracle unchanged), phase 2 (PostgreSQL), phase 3 (MySQL / MariaDB), then
SQLite and ClickHouse at the same level —
connect, browse, Structure (read-only), DDL, read-only table data with filters/sort/count, queries
(row limit, Stop, Explain, Beautify, transactions with "Uncommitted transaction" from the server's
real state via `txOpen`), export, databases menu (PG), lost connections, SQL Developer file carries
PG/MySQL connections (`LookupEngine` fields).

Redis: done (key browser, key tabs for string / hash / list / set / zset / stream / JSON, Workbench, Shell,
Overview), including Redis Cluster, and delete by pattern (folder menu / trash icon: `countMatching` then
`deleteMatching` in 1.5 s steps with a cursor, SCAN COUNT 5000 + UNLINK in 500s; `*` alone is refused; the window
asks with the exact count and, on Production, makes you type the pattern, then sends `confirmed: true`).
Not yet: Sentinel, SSH tunnel, key export.

MongoDB: done (form, tree, Documents with edits, Aggregations, Schema, Indexes, Validation, light Shell, Overview,
Stop, read-only / Production). Tested on FerretDB only (no real mongod here). Not yet: Kerberos, SSH tunnel,
import from file, GridFS, real mongosh JavaScript, change streams.

Next: **phase 4** — grid edits by primary key for PG/MySQL (`tableData` already returns
`keyColumns`; show a "no primary key → read-only" note), editable Structure; **phase 5** — create /
alter / truncate / drop table for PG/MySQL (needs their own sqlgen; note MySQL DDL auto-commits).
Turn on the matching `features` in each engine's `profile.js` (SQLite too; ClickHouse stays read-only).
