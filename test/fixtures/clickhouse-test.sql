-- Test objects for test/clickhouse-test.js (recreated on every run, in database lookup_test).
DROP DATABASE IF EXISTS lookup_test;
CREATE DATABASE lookup_test;

CREATE TABLE lookup_test.events (
  id UInt64,
  user_id UInt32,
  kind LowCardinality(String),
  amount Decimal(12, 2),
  at DateTime64(3),
  day Date,
  tags Array(String),
  props Map(String, String),
  note Nullable(String),
  `Mixed Case` String DEFAULT 'x',
  CONSTRAINT amount_ok CHECK amount >= 0,
  INDEX kind_idx kind TYPE set(100) GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (user_id, id)
COMMENT 'Things users did';

INSERT INTO lookup_test.events (id, user_id, kind, amount, at, day, tags, props, note)
SELECT number + 1, (number % 200) + 1, ['view', 'click', 'buy'][(number % 3) + 1], round((number + 1) * 1.37, 2),
       toDateTime64('2026-01-01 08:30:00.123', 3) + number * 60, toDate('2026-01-01') + (number % 90),
       ['t' || toString(number % 5), 'x'], map('n', toString(number + 1)), if(number % 10 = 0, NULL, 'ok')
  FROM numbers(1000);

CREATE TABLE lookup_test.users (id UInt32, name String, city String) ENGINE = MergeTree ORDER BY id;
INSERT INTO lookup_test.users SELECT number + 1, 'User ' || toString(number + 1), ['Cairo', 'Giza', 'Alexandria'][(number % 3) + 1] FROM numbers(200);

CREATE VIEW lookup_test.big_events AS SELECT id, user_id, amount FROM lookup_test.events WHERE amount > 1000;

CREATE TABLE lookup_test.daily (day Date, n UInt64) ENGINE = SummingMergeTree ORDER BY day;
CREATE MATERIALIZED VIEW lookup_test.daily_mv TO lookup_test.daily AS SELECT day, count() AS n FROM lookup_test.events GROUP BY day;

CREATE DICTIONARY lookup_test.user_names (id UInt64, name String)
PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE 'users' DB 'lookup_test' USER 'lookup' PASSWORD 'lookup')) LIFETIME(0) LAYOUT(FLAT());
