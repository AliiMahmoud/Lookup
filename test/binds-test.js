// Checks generated SQL against node-oracledb's own Thin-mode SQL parser, so every
// bind placeholder the driver sees matches a value we pass (catches NJS-098).
const assert = require('assert');
const { Statement } = require('oracledb/lib/thin/statement.js');
const { buildPageQuery, buildChanges, buildWhere } = require('../src/main/db/oracle/sqlgen');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

function parsedBinds(sql) {
  const st = new Statement();
  st._prepare(sql);
  return [...new Set(st.bindInfoList.map((b) => b.bindName))].sort();
}
function check(sql, binds) {
  assert.deepStrictEqual(parsedBinds(sql), Object.keys(binds).map((k) => k.toUpperCase()).sort(), sql);
}

const cols = [{ name: 'ID', type: 'NUMBER' }, { name: 'NAME', type: 'VARCHAR2' }, { name: 'CREATED', type: 'DATE' }];

t('table page, no filter', () => { const q = buildPageQuery({ owner: 'HR', name: 'EMP', editable: true, cols }); check(q.sql, q.binds); });
t('table page, filters + sort', () => {
  const q = buildPageQuery({
    owner: 'HR', name: 'EMP', editable: false, cols, sort: { col: 'NAME', dir: 'desc' }, offset: 300, limit: 300,
    filters: [{ col: 'NAME', op: 'CONTAINS', value: 'a' }, { col: 'ID', op: 'IN', value: '1,2,3' }, { col: 'CREATED', op: '>=', value: '2026-01-01' }, { col: 'NAME', op: 'IS NULL' }],
  });
  check(q.sql, q.binds);
});
t('count query binds', () => {
  const w = buildWhere(cols, [{ col: 'NAME', op: '=', value: 'x' }]);
  check(`SELECT COUNT(*) FROM "HR"."EMP" t${w.where}`, w.binds);
});
t('grid edit statements', () => {
  for (const st of buildChanges('HR', 'EMP', cols, {
    updates: [{ rowid: 'A', values: { NAME: 'x', CREATED: '2026-01-01', ID: null } }],
    inserts: [{ values: { ID: '1', NAME: 'y' } }],
    deletes: [{ rowid: 'B' }],
  })) check(st.sql, st.binds);
});

t('CREATE TABLE has no bind placeholders', () => {
  const { sql } = require('../src/main/db/oracle/sqlgen').buildCreateTable({ name: 't', columns: [{ name: 'a', type: 'VARCHAR2(10)', default: "':x'" }] });
  check(sql, {});
});

console.log(`\n${passed} bind tests passed`);
