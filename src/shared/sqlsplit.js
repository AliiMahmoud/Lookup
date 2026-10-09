/* global self -- this file runs in the browser (self) and in Node (module) */
/*
 * Splits an Oracle SQL script into statements.
 * - Plain SQL ends at ';' (the ';' is dropped).
 * - PL/SQL (DECLARE/BEGIN, CREATE PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE)
 *   keeps its semicolons and ends at a line containing only '/' (or end of text).
 * - Strings, q'[...]' quotes, "identifiers" and comments are respected.
 * Works in Node (require) and in the browser (window.SqlSplit).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SqlSplit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PLSQL_START = /^(create\s+(or\s+replace\s+)?((editionable|noneditionable)\s+)?(procedure|function|package|trigger|type|library)\b|declare\b|begin\b)/i;
  const Q_CLOSE = { '[': ']', '{': '}', '(': ')', '<': '>' };

  function isIdentChar(ch) {
    return !!ch && /[A-Za-z0-9_$#]/.test(ch);
  }

  function split(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    let start = -1;
    let plsql = false;

    const skipLine = (j) => {
      const e = text.indexOf('\n', j);
      return e < 0 ? n : e + 1;
    };
    const skipBlock = (j) => {
      const e = text.indexOf('*/', j + 2);
      return e < 0 ? n : e + 2;
    };
    const skipQuote = (j, q) => {
      let k = j + 1;
      while (k < n) {
        if (text[k] === q) {
          if (text[k + 1] === q) { k += 2; continue; }
          return k + 1;
        }
        k++;
      }
      return n;
    };
    const lineIsSlash = (j) => {
      let a = j - 1;
      while (a >= 0 && text[a] !== '\n') { if (!/[ \t\r]/.test(text[a])) return false; a--; }
      let b = j + 1;
      while (b < n && text[b] !== '\n') { if (!/[ \t\r]/.test(text[b])) return false; b++; }
      return true;
    };
    const emit = (s, e, termEnd) => {
      const body = text.slice(s, e).replace(/\s+$/, '');
      if (body.length) out.push({ text: body, start: s, end: termEnd, plsql });
    };

    while (i < n) {
      const c = text[i];
      const c2 = text[i + 1];

      if (start < 0) {
        if (/\s/.test(c)) { i++; continue; }
        if (c === '-' && c2 === '-') { i = skipLine(i); continue; }
        if (c === '/' && c2 === '*') { i = skipBlock(i); continue; }
        if (c === '/' && lineIsSlash(i)) { i++; continue; }
        start = i;
        plsql = PLSQL_START.test(text.slice(i, i + 160));
      }

      if (c === '-' && c2 === '-') { i = skipLine(i); continue; }
      if (c === '/' && c2 === '*') { i = skipBlock(i); continue; }
      if ((c === 'q' || c === 'Q') && c2 === "'" && !isIdentChar(text[i - 1])) {
        const open = text[i + 2];
        const close = Q_CLOSE[open] || open;
        const j = text.indexOf(close + "'", i + 3);
        i = j < 0 ? n : j + 2;
        continue;
      }
      if (c === "'") { i = skipQuote(i, "'"); continue; }
      if (c === '"') { i = skipQuote(i, '"'); continue; }
      if (c === '/' && lineIsSlash(i)) {
        emit(start, i, i + 1);
        start = -1; i++; continue;
      }
      if (c === ';' && !plsql) {
        emit(start, i, i + 1);
        start = -1; i++; continue;
      }
      i++;
    }
    if (start >= 0) emit(start, n, n);
    return out;
  }

  /** Statement containing the cursor, or the closest one before it. */
  function statementAt(text, pos) {
    const list = split(text);
    if (!list.length) return null;
    let best = null;
    for (const s of list) {
      if (pos >= s.start && pos <= s.end) return s;
      if (s.start <= pos) best = s;
    }
    return best || list[0];
  }

  return { split, statementAt };
});
