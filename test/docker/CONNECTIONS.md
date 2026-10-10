# Docker test databases for Lookup

Six database servers with the same sample data, for trying Lookup by hand.
Every user name and password is **`lookup`**. Ports are open on `127.0.0.1` only.

## Start / stop

```bash
docker compose -f test/docker/docker-compose.yml up -d         # start; the first run also loads the data (~1 min)
docker compose -f test/docker/docker-compose.yml logs -f seed  # watch the data being loaded
docker compose -f test/docker/docker-compose.yml stop          # stop, keep the data
docker compose -f test/docker/docker-compose.yml down -v       # remove the containers and all data
```

Load the data again (drops and recreates the sample databases), or only one engine:

```bash
docker compose -f test/docker/docker-compose.yml run --rm seed node test/docker/seed.js --force
docker compose -f test/docker/docker-compose.yml run --rm seed node test/docker/seed.js mysql --force
docker compose -f test/docker/docker-compose.yml run --rm seed node test/docker/seed.js --check    # row counts
```

## Add the connections to Lookup

Home screen → **Import** → choose `test/docker/lookup-connections.xml` → file password **`lookup`**.
That adds the nine connections below (tagged *Local*) with their passwords.

## Connections

| Engine | Host | Port | User | Password | Database | Notes |
|---|---|---|---|---|---|---|
| Oracle | 127.0.0.1 | **1522** | `lookup` | `lookup` | service `FREEPDB1` | DBA; schemas `SHOP` and `HR` |
| Oracle | 127.0.0.1 | **1522** | `lookup` | `lookup` | service `ANALYTICSPDB` | second PDB; schema `ANALYTICS` |
| Oracle | 127.0.0.1 | **1522** | `system` | `lookup` | service `FREE` | CDB root, sees both PDBs (`sys` / `lookup` as SYSDBA also works) |
| PostgreSQL | 127.0.0.1 | 5432 | `lookup` | `lookup` | `shop` (also `hr`, `analytics`) | superuser; SSL: prefer |
| MySQL 8.4 | 127.0.0.1 | 3306 | `lookup` | `lookup` | `shop` (also `hr`, `analytics`) | all privileges; `root` / `lookup` too |
| ClickHouse | 127.0.0.1 | 8123 | `lookup` | `lookup` | `shop` (also `hr`, `analytics`) | HTTP, no TLS |
| Redis 8 | 127.0.0.1 | 6379 | `lookup` | `lookup` | db 0 (also 1, 2) | user `default` / `lookup` also works |
| Redis 8 | 127.0.0.1 | 6379 | `viewer` | `viewer` | db 0 | a server-side read-only user (writes answer NOPERM) |
| MongoDB 7 | 127.0.0.1 | 27017 | `lookup` | `lookup` | `shop` (also `hr`, `analytics`) | Authentication database: `admin` |

Oracle is on **1522** because another Oracle container (`oracle-db`) already uses 1521 on this machine.
The Oracle schema owners can log in too: `shop`, `hr` (FREEPDB1) and `analytics` (ANALYTICSPDB), password `lookup`.

URLs, for the form's URL mode or other tools:

```
postgres://lookup:lookup@127.0.0.1:5432/shop
mysql://lookup:lookup@127.0.0.1:3306/shop
http://lookup:lookup@127.0.0.1:8123/?database=shop
redis://lookup:lookup@127.0.0.1:6379/0
mongodb://lookup:lookup@127.0.0.1:27017/shop?authSource=admin
Oracle: (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=FREEPDB1)))
```

## The data

The same rows in Oracle, PostgreSQL, MySQL, ClickHouse and MongoDB: **18 tables, 390,281 rows**, in three databases.
The data is generated from a fixed seed, so every load gives the same rows.

| Database | Table / collection | Rows | Worth looking at |
|---|---|---:|---|
| **shop** | `countries` | 30 | text primary key, a number above 2 billion (`population`) |
| | `categories` | 24 | points to itself (`parent_id`) |
| | `suppliers` | 200 | |
| | `products` | 2,000 | `tags` (list), `attributes` (JSON), long `description` |
| | `customers` | 10,000 | Arabic / Japanese / accented names, many empty values |
| | `addresses` | 12,000 | decimals with 6 places |
| | `orders` | 30,000 | status list, empty dates, emoji and Arabic in `note` |
| | `order_items` | **100,000** | the big one |
| | `payments` | 30,000 | UUIDs |
| | `reviews` | 15,000 | multi-line text |
| **hr** | `departments` | 12 | |
| | `jobs` | 15 | |
| | `employees` | 5,000 | `photo` = binary data on every 10th row, manager tree |
| | `salary_history` | 15,000 | |
| | `attendance` | 50,000 | |
| **analytics** | `sessions` | 20,000 | UUIDs |
| | `page_views` | **100,000** | IP addresses |
| | `daily_stats` | 1,000 | date primary key |

Per engine:

- **Oracle** — `shop` and `hr` are the schemas `SHOP` and `HR` in `FREEPDB1`; `analytics` is the schema `ANALYTICS` in
  the PDB `ANALYTICSPDB`. `SHOP` also has 2 views, a materialized view, a sequence, a function, a procedure, a package,
  a trigger, a type and a synonym. Yes/no columns are `NUMBER(1)`, JSON is `VARCHAR2 … IS JSON`.
- **PostgreSQL** — three databases, tables in `public`; `shop` also has a `reporting` schema (a view and a materialized
  view), enum types, `jsonb`, `text[]`, `uuid`, `inet`, `bytea`, a function and a sequence.
- **MySQL** — three databases; `ENUM`, `JSON`, `BLOB`, foreign keys, views, a function and a procedure.
- **ClickHouse** — three databases, MergeTree tables; `Enum8`, `Nullable`, `LowCardinality`, `Array(String)`, `Decimal`,
  `DateTime64`, `Date32`, `UUID`, `IPv4`; views, and `analytics.page_views_per_day` filled by a materialized view.
- **MongoDB** — three databases, the tables as collections. Money is `Decimal128`, `population` is `Long`, UUIDs and
  the photo are binary. `customers` carry their `addresses` inside, `orders` carry their `items`; empty values are left
  out of the document. `orders`, `reviews` and `page_views` have an ObjectId `_id`, the others a number.
  Also: indexes, a validation rule on `products`, and the view `vip_customers`.
- **Redis** — about 107,000 keys:
  - **db0** (shop, ~79,000): `customer:<id>` hashes, `product:<id>` hashes + `product:<id>:tags` sets, `order:<id>` **JSON**,
    `customer:<id>:orders` lists, `cart:<id>` hashes and `session:<uuid>` strings with a time to live, `leaderboard:*`
    sorted sets, streams `events:orders` / `events:payments`, `stats:daily:<date>` hashes, HyperLogLogs `uv:<date>`,
    bitmaps `active-users:<date>`, binary values `cache:thumb:<n>`, and a few odd ones (`greeting:ar`, `a key with spaces`).
    200 of the sessions expire within 15 minutes of loading, so the count drops a little.
  - **db1** (hr, ~10,000): `employee:<id>` hashes, `employee:<id>:attendance` lists, `department:<id>:employees` sets, `salary:ranking`.
  - **db2** (analytics, ~18,000): `pageviews:<date>:<path>` counters, stream `events:pageviews`, `session:<id>:pages` lists.

## Memory

About 3.7 GB with everything running (Oracle alone is ~2.2 GB). To run only some of them:

```bash
docker compose -f test/docker/docker-compose.yml up -d postgres mysql
docker compose -f test/docker/docker-compose.yml run --rm --no-deps seed node test/docker/seed.js postgres mysql
```
