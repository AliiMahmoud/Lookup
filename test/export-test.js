// Exporter tests (no database needed). Run with: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { createWriter, sqlLiteral, exactNumber } = require('../src/main/export');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-test-'));
const cols = [{ name: 'ID', type: 'NUMBER' }, { name: 'NAME', type: 'VARCHAR2' }, { name: 'AT', type: 'DATE' }, { name: 'RAW1', type: 'RAW' }];
const rows = [
  ['1', 'a,b "q"', '2026-01-02 03:04:05', { $bin: 'ABCD', len: 2 }],
  ['12345678901234567890', null, null, null],
];

async function write(fmt, opts) {
  const f = path.join(tmp, 'out.' + fmt);
  const w = createWriter(fmt, f, cols, opts);
  await w.rows(rows);
  await w.close();
  return f;
}

(async () => {
  const csv = fs.readFileSync(await write('csv', {}), 'utf8');
  t('CSV quotes and escapes', () => assert.strictEqual(csv,
    '﻿ID,NAME,AT,RAW1\r\n1,"a,b ""q""",2026-01-02 03:04:05,ABCD\r\n12345678901234567890,,,\r\n'));

  const semi = fs.readFileSync(await write('csv', { delimiter: ';', nullAs: 'NULL', header: false }), 'utf8');
  t('CSV delimiter, NULL text, no header', () => assert.ok(semi.startsWith('﻿1;"a,b ""q""";') && semi.includes(';NULL;NULL;NULL')));

  const json = JSON.parse(fs.readFileSync(await write('json', {}), 'utf8'));
  t('JSON keeps big numbers as strings', () => {
    assert.strictEqual(json[0].ID, 1);
    assert.strictEqual(json[1].ID, '12345678901234567890');
    assert.strictEqual(json[1].NAME, null);
  });

  const jl = fs.readFileSync(await write('json', { jsonStyle: 'lines' }), 'utf8').trim().split('\n');
  t('JSON lines', () => assert.strictEqual(JSON.parse(jl[1]).ID, '12345678901234567890'));

  const sql = fs.readFileSync(await write('sql', { target: '"HR"."T"', commitEvery: 1 }), 'utf8');
  t('SQL inserts', () => {
    assert.ok(sql.includes(`INSERT INTO "HR"."T" ("ID", "NAME", "AT", "RAW1") VALUES (1, 'a,b "q"', TO_DATE('2026-01-02 03:04:05', 'YYYY-MM-DD HH24:MI:SS'), HEXTORAW('ABCD'));\nCOMMIT;`));
    assert.ok(sql.includes('VALUES (12345678901234567890, NULL, NULL, NULL);'));
  });
  t('long strings become CLOB chunks', () => assert.ok(sqlLiteral('x'.repeat(5000), 'CLOB').startsWith("TO_CLOB('")));
  t('exact number conversion', () => {
    assert.strictEqual(exactNumber('0.5'), 0.5);
    assert.strictEqual(exactNumber('.5'), 0.5);
    assert.strictEqual(exactNumber('1.10'), 1.1);
    assert.strictEqual(exactNumber('9007199254740993'), null);
  });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(await write('xlsx', { sheetName: 'T' }));
  const ws = wb.getWorksheet('T');
  t('Excel cell types', () => {
    assert.strictEqual(ws.getCell('A1').value, 'ID');
    assert.strictEqual(ws.getCell('A2').value, 1);
    assert.ok(ws.getCell('C2').value instanceof Date);
    assert.strictEqual(ws.getCell('C2').value.toISOString(), '2026-01-02T03:04:05.000Z');
    assert.strictEqual(ws.getCell('A3').value, '12345678901234567890');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} export tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
