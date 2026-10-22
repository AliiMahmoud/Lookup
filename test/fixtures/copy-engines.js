// Tables with awkward values on every SQL engine, shared by copy-sql-test.js and duplicate-row-test.js:
// connection, schema setup, CREATE TABLE for the source and copy, and three source rows.
// Servers from test/docker (docker compose -f test/docker/docker-compose.yml up -d).
const LONG = 'x'.repeat(4500) + ' end'; // over Oracle's 4000-byte literal limit: CLOB chunks
const NAMES = ["O'Brien & Co \\ path", 'line1\nline2 — عربي', 'plain'];

const ENGINES = {
  oracle: {
    cfg: { engine: 'oracle', host: '127.0.0.1', port: 1522, service: 'FREEPDB1', user: 'lookup', password: 'lookup', autoCommit: true },
    owner: 'LOOKUP',
    src: 'COPY_SRC', dst: 'COPY_DST',
    drop: (t) => `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${t} PURGE'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    create: (t) => `CREATE TABLE ${t} (ID NUMBER PRIMARY KEY, NAME VARCHAR2(200), AMOUNT NUMBER(12,2), CREATED DATE,
      TS TIMESTAMP(6), NOTE CLOB, "Mixed Col" VARCHAR2(20), BIN RAW(16))`,
    rows: [
      `INSERT INTO COPY_SRC VALUES (1, 'O''Brien ' || CHR(38) || ' Co \\ path', 1234.5, DATE '2024-05-01', TIMESTAMP '2024-05-01 10:20:30.123456', NULL, 'a', HEXTORAW('DEADBEEF'))`,
      `INSERT INTO COPY_SRC VALUES (2, 'line1' || CHR(10) || 'line2 — عربي', -0.01, DATE '1999-12-31', TIMESTAMP '1999-12-31 23:59:59', TO_CLOB(RPAD('x', 4000, 'x')) || TO_CLOB(RPAD('x', 500, 'x') || ' end'), NULL, NULL)`,
      `INSERT INTO COPY_SRC VALUES (3, 'plain', NULL, NULL, NULL, 'short', 'b', HEXTORAW('00'))`,
    ],
    truncate: (t) => `TRUNCATE TABLE ${t}`,
  },
  postgres: {
    cfg: { engine: 'postgres', host: '127.0.0.1', port: 5432, database: 'shop', user: 'lookup', password: 'lookup', ssl: 'prefer', autoCommit: true },
    owner: 'lookup_copy',
    setup: ['DROP SCHEMA IF EXISTS lookup_copy CASCADE', 'CREATE SCHEMA lookup_copy'],
    src: 'copy_src', dst: 'copy_dst',
    create: (t) => `CREATE TABLE lookup_copy.${t} (id int PRIMARY KEY, name text, amount numeric(12,2), created date, ts timestamp,
      flag boolean, note text, "Mixed Col" varchar(20), bin bytea, js jsonb, uid uuid, tags text[])`,
    rows: [
      `INSERT INTO lookup_copy.copy_src VALUES (1, E'O\\'Brien & Co \\\\ path', 1234.5, '2024-05-01', '2024-05-01 10:20:30.123456', true, NULL, 'a', '\\xdeadbeef', '{"a": [1, "x''y"]}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{one,"two, three"}')`,
      `INSERT INTO lookup_copy.copy_src VALUES (2, E'line1\\nline2 — عربي', -0.01, '1999-12-31', '1999-12-31 23:59:59', false, '${LONG}', NULL, NULL, NULL, NULL, NULL)`,
      `INSERT INTO lookup_copy.copy_src VALUES (3, 'plain', NULL, NULL, NULL, NULL, 'short', 'b', '\\x00', '[]', NULL, '{}')`,
    ],
    truncate: (t) => `TRUNCATE TABLE lookup_copy.${t}`,
  },
  mysql: {
    cfg: { engine: 'mysql', host: '127.0.0.1', port: 3306, database: 'shop', user: 'root', password: 'lookup', ssl: 'prefer', autoCommit: true },
    owner: 'lookup_copy',
    setup: ['DROP DATABASE IF EXISTS lookup_copy', 'CREATE DATABASE lookup_copy CHARACTER SET utf8mb4'],
    src: 'copy_src', dst: 'copy_dst',
    create: (t) => `CREATE TABLE lookup_copy.${t} (id int PRIMARY KEY, name varchar(200), amount decimal(12,2), created date, ts datetime(3),
      flag tinyint(1), note text, \`Mixed Col\` varchar(20), bin varbinary(16), js json, big bigint)`,
    rows: [
      `INSERT INTO lookup_copy.copy_src VALUES (1, 'O\\'Brien & Co \\\\ path', 1234.5, '2024-05-01', '2024-05-01 10:20:30.123', 1, NULL, 'a', 0xDEADBEEF, '{"a": [1, "x\\'y"]}', 9007199254740993)`,
      `INSERT INTO lookup_copy.copy_src VALUES (2, 'line1\\nline2 — عربي', -0.01, '1999-12-31', '1999-12-31 23:59:59', 0, '${LONG}', NULL, NULL, NULL, -1)`,
      `INSERT INTO lookup_copy.copy_src VALUES (3, 'plain', NULL, NULL, NULL, NULL, 'short', 'b', 0x00, '[]', NULL)`,
    ],
    truncate: (t) => `TRUNCATE TABLE lookup_copy.${t}`,
  },
  sqlite: {
    cfg: null, // a new file, made below
    owner: 'main',
    src: 'copy_src', dst: 'copy_dst',
    drop: (t) => `DROP TABLE IF EXISTS ${t}`,
    create: (t) => `CREATE TABLE ${t} (id integer PRIMARY KEY, name text, amount real, created text, note text, "Mixed Col" text, bin blob, big integer)`,
    rows: [
      `INSERT INTO copy_src VALUES (1, 'O''Brien & Co \\ path', 1234.5, '2024-05-01', NULL, 'a', X'DEADBEEF', 9007199254740993)`,
      `INSERT INTO copy_src VALUES (2, 'line1' || char(10) || 'line2 — عربي', -0.01, '1999-12-31 23:59:59', '${LONG}', NULL, NULL, -1)`,
      `INSERT INTO copy_src VALUES (3, 'plain', NULL, NULL, 'short', 'b', X'00', NULL)`,
    ],
    truncate: (t) => `DELETE FROM ${t}`,
  },
  clickhouse: {
    cfg: { engine: 'clickhouse', host: '127.0.0.1', port: 8123, database: 'default', user: 'lookup', password: 'lookup', ssl: 'disable' },
    owner: 'lookup_copy',
    setup: ['DROP DATABASE IF EXISTS lookup_copy', 'CREATE DATABASE lookup_copy'],
    src: 'copy_src', dst: 'copy_dst',
    create: (t) => `CREATE TABLE lookup_copy.${t} (id UInt32, name String, amount Nullable(Decimal(12,2)), created Nullable(Date), ts Nullable(DateTime64(3)),
      flag Nullable(Bool), note Nullable(String), \`Mixed Col\` Nullable(String), tags Array(String), m Map(String, UInt8), big Int64) ENGINE = MergeTree ORDER BY id`,
    rows: [
      `INSERT INTO lookup_copy.copy_src VALUES (1, 'O\\'Brien & Co \\\\ path', 1234.5, '2024-05-01', '2024-05-01 10:20:30.123', true, NULL, 'a', ['one', 'two, \\'three\\''], {'k': 1}, 9007199254740993)`,
      `INSERT INTO lookup_copy.copy_src VALUES (2, 'line1\\nline2 — عربي', -0.01, '1999-12-31', '1999-12-31 23:59:59', false, '${LONG}', NULL, [], {}, -1)`,
      `INSERT INTO lookup_copy.copy_src VALUES (3, 'plain', NULL, NULL, NULL, NULL, 'short', 'b', ['x'], {'a': 2, 'b': 3}, 0)`,
    ],
    truncate: (t) => `TRUNCATE TABLE lookup_copy.${t}`,
  },
};

module.exports = { ENGINES, NAMES, LONG };
