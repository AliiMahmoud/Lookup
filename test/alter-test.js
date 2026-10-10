// ALTER TABLE plans from the Structure tab. Run with: npm test
const assert = require('assert');
const { buildAlterTable } = require('../src/main/db/oracle/sqlgen');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };
const sqls = (plan) => buildAlterTable(plan).map((x) => x.sql);

const orig = (name, type, extra = {}) => ({ name, type, nullable: true, default: null, comment: null, ...extra });
const keep = (o, changes = {}) => ({ orig: o, name: o.name, type: o.type, nullable: o.nullable, default: o.default, comment: o.comment, ...changes });

t('no changes, no statements', () => {
  const id = orig('ID', 'NUMBER', { nullable: false, identity: true, default: '"SYSTEM"."ISEQ$$_74275".nextval' });
  assert.deepStrictEqual(sqls({ owner: 'SYSTEM', table: 'MY_TABLE', columns: [keep(id), keep(orig('USERNAME', 'VARCHAR2(100)'))] }), []);
});

t('rename, modify type/default/nullability, add, drop, comment — in a safe order', () => {
  const plan = {
    owner: 'SYSTEM', table: 'MY_TABLE',
    columns: [
      keep(orig('ID', 'NUMBER', { nullable: false, identity: true })),
      keep(orig('USERNAME', 'VARCHAR2(100)'), { name: 'user_name', type: 'VARCHAR2(200)', nullable: false, default: "'guest'" }),
      keep(orig('OLD', 'DATE'), { drop: true }),
      keep(orig('NOTE', 'VARCHAR2(10)', { default: "'x'" }), { default: '', comment: 'Free text' }),
      { orig: null, name: 'created_at', type: 'DATE', nullable: false, default: 'SYSDATE', comment: 'When' },
      { orig: null, name: '', type: '' },
    ],
    dropConstraints: ['SYS_C008774'],
    addConstraints: [{ kind: 'UNIQUE', columns: ['user_name'] }],
    tableComment: { from: null, to: "Users' table" },
  };
  assert.deepStrictEqual(sqls(plan), [
    'ALTER TABLE "SYSTEM"."MY_TABLE" DROP CONSTRAINT "SYS_C008774"',
    'ALTER TABLE "SYSTEM"."MY_TABLE" DROP COLUMN "OLD"',
    'ALTER TABLE "SYSTEM"."MY_TABLE" RENAME COLUMN "USERNAME" TO user_name',
    `ALTER TABLE "SYSTEM"."MY_TABLE" MODIFY (user_name VARCHAR2(200) DEFAULT 'guest' NOT NULL)`,
    'ALTER TABLE "SYSTEM"."MY_TABLE" MODIFY ("NOTE" DEFAULT NULL)',
    'ALTER TABLE "SYSTEM"."MY_TABLE" ADD (created_at DATE DEFAULT SYSDATE NOT NULL)',
    'ALTER TABLE "SYSTEM"."MY_TABLE" ADD CONSTRAINT "MY_TABLE_UK1" UNIQUE (user_name)',
    `COMMENT ON TABLE "SYSTEM"."MY_TABLE" IS 'Users'' table'`,
    `COMMENT ON COLUMN "SYSTEM"."MY_TABLE"."NOTE" IS 'Free text'`,
    `COMMENT ON COLUMN "SYSTEM"."MY_TABLE".created_at IS 'When'`,
  ]);
});

t('type comparison ignores case, spaces and BYTE', () => {
  const c = keep(orig('NAME', 'VARCHAR2(100)'), { type: 'varchar2( 100 BYTE )' });
  assert.deepStrictEqual(sqls({ owner: 'HR', table: 'T', columns: [c] }), []);
});

t('identity columns: type and default are left alone, nullability still applies', () => {
  const c = keep(orig('ID', 'NUMBER', { identity: true, nullable: false, default: 'ISEQ' }), { type: 'NUMBER(10)', default: '5' });
  assert.deepStrictEqual(sqls({ owner: 'HR', table: 'T', columns: [c] }), []);
});

t('primary key, foreign key, check, enable/disable, indexes', () => {
  const plan = {
    owner: 'HR', table: 'ORDERS',
    columns: [keep(orig('ID', 'NUMBER')), keep(orig('CUSTOMER_ID', 'NUMBER')), keep(orig('QTY', 'NUMBER'))],
    addConstraints: [
      { kind: 'PRIMARY KEY', columns: ['ID'] },
      { kind: 'FOREIGN KEY', name: 'orders_customer_fk', columns: ['CUSTOMER_ID'], refTable: 'customers', refColumns: ['customer_id'], onDelete: 'CASCADE' },
      { kind: 'FOREIGN KEY', columns: ['CUSTOMER_ID'], refTable: 'CRM.CLIENTS', onDelete: 'SET NULL' },
      { kind: 'CHECK', check: 'QTY > 0' },
    ],
    toggleConstraints: [{ name: 'SYS_C1', enable: false }],
    dropIndexes: ['OLD_IX'],
    addIndexes: [{ columns: ['CUSTOMER_ID', 'QTY'] }, { name: 'orders_qty_ux', unique: true, columns: ['QTY'] }],
  };
  assert.deepStrictEqual(sqls(plan), [
    'DROP INDEX "HR"."OLD_IX"',
    'ALTER TABLE "HR"."ORDERS" ADD CONSTRAINT "ORDERS_PK" PRIMARY KEY ("ID")',
    'ALTER TABLE "HR"."ORDERS" ADD CONSTRAINT orders_customer_fk FOREIGN KEY ("CUSTOMER_ID") REFERENCES "HR".customers (customer_id) ON DELETE CASCADE',
    'ALTER TABLE "HR"."ORDERS" ADD CONSTRAINT "ORDERS_FK2" FOREIGN KEY ("CUSTOMER_ID") REFERENCES CRM.CLIENTS ON DELETE SET NULL',
    'ALTER TABLE "HR"."ORDERS" ADD CONSTRAINT "ORDERS_CK1" CHECK (QTY > 0)',
    'ALTER TABLE "HR"."ORDERS" DISABLE CONSTRAINT "SYS_C1"',
    'CREATE INDEX "HR"."ORDERS_IX1" ON "HR"."ORDERS" ("CUSTOMER_ID", "QTY")',
    'CREATE UNIQUE INDEX "HR".orders_qty_ux ON "HR"."ORDERS" ("QTY")',
  ]);
});

t('validation', () => {
  assert.throws(() => buildAlterTable({ owner: 'HR', table: 'T', columns: [{ orig: null, name: 'x', type: '' }] }), /needs a data type/);
  assert.throws(() => buildAlterTable({ owner: 'HR', table: 'T', columns: [keep(orig('A', 'NUMBER'), { drop: true })] }), /at least one column/);
  assert.throws(() => buildAlterTable({ owner: 'HR', table: 'T', columns: [keep(orig('A', 'NUMBER')), { orig: null, name: 'a', type: 'DATE' }] }), /listed twice/);
  assert.throws(() => buildAlterTable({ owner: 'HR', table: 'T', columns: [keep(orig('A', 'NUMBER'))], addConstraints: [{ kind: 'FOREIGN KEY', columns: ['A'] }] }), /referenced table/);
});

console.log(`\n${passed} alter tests passed`);
