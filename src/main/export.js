// Streaming exporters. Rows arrive in batches of plain values:
//   null | string | number | { $bin: 'HEX', len }    (dates are 'YYYY-MM-DD HH:MM:SS[.fff]' strings)
// columns = [{ name, type }]   (type = the database's type name, e.g. NUMBER, DATE, VARCHAR2)
// options.dialect = the engine's dialect (kindOf, qi, sqlLiteral, scriptStart, commit): see db/<engine>/dialect.js
const fs = require('fs');

const FORMATS = {
  csv: { ext: 'csv', label: 'CSV' },
  xlsx: { ext: 'xlsx', label: 'Excel workbook' },
  json: { ext: 'json', label: 'JSON' },
  sql: { ext: 'sql', label: 'SQL INSERT statements' },
};

function textOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v.$bin !== undefined) return v.$bin;
  return String(v);
}

// Numbers come from the database as strings to avoid precision loss; convert only when exact.
function exactNumber(s) {
  if (typeof s === 'number') return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const canon = String(s).replace(/^(-?)0+(\d)/, '$1$2').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^(-?)\./, '$10.').replace(/^-0$/, '0');
  return String(n) === canon ? n : null;
}

function parseLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?/.exec(String(s));
  if (!m) return null;
  // Excel stores wall-clock time; build it in UTC so no time-zone shift is applied.
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), m[7] ? +m[7].slice(0, 3).padEnd(3, '0') : 0));
}

class FileOut {
  constructor(path) {
    this.stream = fs.createWriteStream(path, { encoding: 'utf8' });
    this.failed = null;
    this.stream.on('error', (e) => { this.failed = e; });
  }
  write(s) {
    if (this.failed) throw this.failed;
    if (!this.stream.write(s)) return new Promise((r) => this.stream.once('drain', r));
    return null;
  }
  end() {
    return new Promise((resolve, reject) => {
      if (this.failed) { reject(this.failed); return; }
      this.stream.end((e) => (e ? reject(e) : resolve()));
    });
  }
}

// ---------- CSV ----------
class CsvWriter {
  constructor(path, columns, o) {
    this.out = new FileOut(path);
    this.d = o.delimiter || ',';
    this.nullText = o.nullAs === 'NULL' ? 'NULL' : '';
    this.quoteAll = !!o.quoteAll;
    this.out.write('﻿'); // lets Excel detect UTF-8
    if (o.header !== false) this.line(columns.map((c) => c.name));
  }
  cell(v) {
    if (v === null || v === undefined) return this.nullText;
    const s = textOf(v);
    const needs = this.quoteAll || s.includes(this.d) || /["\r\n]/.test(s) || /^\s|\s$/.test(s);
    return needs ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  line(cells) { return this.out.write(cells.map((c) => this.cell(c)).join(this.d) + '\r\n'); }
  async rows(batch) { for (const r of batch) { const p = this.line(r); if (p) await p; } }
  close() { return this.out.end(); }
}

// ---------- JSON ----------
class JsonWriter {
  constructor(path, columns, o) {
    this.out = new FileOut(path);
    this.columns = columns;
    this.kinds = columns.map((c) => o.dialect.kindOf(c.type));
    this.lines = o.jsonStyle === 'lines';
    this.first = true;
    if (!this.lines) this.out.write('[\n');
  }
  obj(r) {
    const o = {};
    this.columns.forEach((c, i) => {
      let v = r[i];
      if (v !== null && v !== undefined) {
        if (typeof v === 'object' && v.$bin !== undefined) v = v.$bin;
        else if (this.kinds[i] === 'number') { const n = exactNumber(v); v = n === null ? String(v) : n; }
      } else v = null;
      o[c.name] = v;
    });
    return JSON.stringify(o);
  }
  async rows(batch) {
    for (const r of batch) {
      const s = this.lines ? this.obj(r) + '\n' : (this.first ? '  ' : ',\n  ') + this.obj(r);
      this.first = false;
      const p = this.out.write(s);
      if (p) await p;
    }
  }
  async close() {
    if (!this.lines) this.out.write((this.first ? '' : '\n') + ']\n');
    return this.out.end();
  }
}

// ---------- SQL INSERT ----------
class SqlWriter {
  constructor(path, columns, o) {
    this.out = new FileOut(path);
    this.columns = columns;
    this.target = o.target || 'EXPORTED_DATA';
    this.batch = Number(o.commitEvery) || 0;
    this.n = 0;
    this.skipped = 0;
    this.d = o.dialect;
    this.head = `INSERT INTO ${this.target} (${columns.map((c) => this.d.qi(c.name)).join(', ')}) VALUES (`;
    this.out.write(`-- Exported by Lookup on ${new Date().toISOString()}\n`);
    if (o.ddl) this.out.write(o.ddl.trim() + '\n\n');
    if (this.d.scriptStart) this.out.write(this.d.scriptStart);
  }
  async rows(batch) {
    for (const r of batch) {
      const vals = [];
      for (let i = 0; i < this.columns.length; i++) {
        const lit = this.d.sqlLiteral(r[i], this.columns[i].type);
        if (lit === null) { vals.push('NULL /* binary too large */'); this.skipped++; } else vals.push(lit);
      }
      let s = this.head + vals.join(', ') + ');\n';
      this.n++;
      if (this.d.commit && this.batch && this.n % this.batch === 0) s += this.d.commit + '\n';
      const p = this.out.write(s);
      if (p) await p;
    }
  }
  async close() {
    if (this.d.commit && this.n && (!this.batch || this.n % this.batch !== 0)) this.out.write(this.d.commit + '\n');
    return this.out.end();
  }
}

// ---------- Excel ----------
const XLSX_MAX_ROWS = 1048575; // excluding header

class XlsxWriter {
  constructor(path, columns, o) {
    const ExcelJS = require('exceljs');
    this.wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useStyles: true, useSharedStrings: false });
    this.columns = columns;
    this.kinds = columns.map((c) => o.dialect.kindOf(c.type));
    this.header = o.header !== false;
    this.sheetName = (o.sheetName || 'Data').replace(/[\\/?*[\]:]/g, '_').slice(0, 28) || 'Data';
    this.sheetNo = 0;
    this.newSheet();
  }
  newSheet() {
    if (this.ws) this.ws.commit();
    this.sheetNo++;
    this.inSheet = 0;
    const name = this.sheetNo === 1 ? this.sheetName : `${this.sheetName} ${this.sheetNo}`;
    this.ws = this.wb.addWorksheet(name, { views: this.header ? [{ state: 'frozen', ySplit: 1 }] : [] });
    this.ws.columns = this.columns.map((c, i) => ({
      key: 'c' + i,
      width: Math.min(Math.max(c.name.length + 2, this.kinds[i] === 'date' ? 20 : this.kinds[i] === 'timestamp' ? 24 : 12), 50),
      style: this.kinds[i] === 'date' ? { numFmt: 'yyyy-mm-dd hh:mm:ss' } : this.kinds[i] === 'timestamp' ? { numFmt: 'yyyy-mm-dd hh:mm:ss.000' } : {},
    }));
    if (this.header) {
      const row = this.ws.addRow(this.columns.map((c) => c.name));
      row.font = { bold: true };
      row.commit();
    }
  }
  value(v, i) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && v.$bin !== undefined) return '0x' + v.$bin;
    const k = this.kinds[i];
    if (k === 'number') { const n = exactNumber(v); return n === null ? String(v) : n; }
    if (k === 'date' || k === 'timestamp') return parseLocalDate(v) || String(v);
    const s = String(v);
    return s.length > 32767 ? s.slice(0, 32767) : s; // Excel cell limit
  }
  async rows(batch) {
    for (const r of batch) {
      if (this.inSheet >= XLSX_MAX_ROWS) this.newSheet();
      this.ws.addRow(r.map((v, i) => this.value(v, i))).commit();
      this.inSheet++;
    }
  }
  async close() {
    this.ws.commit();
    await this.wb.commit();
  }
}

function createWriter(format, path, columns, options = {}) {
  if (!options.dialect) throw new Error('Export needs the database dialect');
  if (format === 'csv') return new CsvWriter(path, columns, options);
  if (format === 'json') return new JsonWriter(path, columns, options);
  if (format === 'sql') return new SqlWriter(path, columns, options);
  if (format === 'xlsx') return new XlsxWriter(path, columns, options);
  throw new Error('Unknown export format ' + format);
}

module.exports = { FORMATS, createWriter, exactNumber, parseLocalDate };
