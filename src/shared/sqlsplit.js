/* global self -- this file runs in the browser (self) and in Node (module) */
/*
 * Splits a SQL script into statements, for one of three dialects:
 *
 * oracle (default)
 * - Plain SQL ends at ';' (the ';' is dropped).
 * - PL/SQL (DECLARE/BEGIN, CREATE PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE)
 *   keeps its semicolons and ends at a line containing only '/' (or end of text).
 * - Strings, q'[...]' quotes, "identifiers" and comments are respected.
 *
 * postgres
 * - Statements end at ';'. Function bodies are in $$ … $$ (or $tag$ … $tag$) quotes, which are
 *   respected, as are E'…' strings with backslash escapes, "identifiers" and comments.
 *
 * mysql (MySQL and MariaDB)
 * - Statements end at ';', or at the delimiter set with a DELIMITER line (DELIMITER $$ … $$).
 * - Without DELIMITER, CREATE PROCEDURE / FUNCTION / TRIGGER / EVENT bodies with BEGIN … END
 *   are kept whole (nested BEGIN / CASE … END are counted).
 * - 'strings' and "strings" with backslash escapes, `identifiers`, -- and # comments are respected.
 *
 * sqlite
 * - Statements end at ';'; CREATE TRIGGER … BEGIN … END is kept whole. 'strings', "names", `names`,
 *   [names], line and block comments are respected.
 *
 * clickhouse
 * - Statements end at ';'; 'strings' with backslash escapes, "names", `names`, --, # and block comments.
 *
 * Each statement: { text, start, end, plsql } (plsql = a procedural block kept exactly as written).
 * Works in Node (require) and in the browser (window.SqlSplit).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SqlSplit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PLSQL_START = /^(create\s+(or\s+replace\s+)?((editionable|noneditionable)\s+)?(procedure|function|package|trigger|type|library)\b|declare\b|begin\b)/i;
  const Q_CLOSE = { '[': ']', '{': '}', '(': ')', '<': '>' };
  const SQLITE_TRIGGER = /^create\s+((temp|temporary)\s+)?trigger\b/i;
  const MYSQL_ROUTINE = /^create\s+(or\s+replace\s+)?(definer\s*=\s*(`[^`]*`|'[^']*'|"[^"]*"|[^\s@]+)(@(`[^`]*`|'[^']*'|"[^"]*"|[^\s]+))?\s+)?(aggregate\s+)?(procedure|function|trigger|event)\b/i;

  function isIdentChar(ch) {
    return !!ch && /[A-Za-z0-9_$#]/.test(ch);
  }

  function split(text, dialect) {
    if (dialect === 'postgres') return splitPostgres(text);
    if (dialect === 'mysql') return splitBlocks(text, MYSQL);
    if (dialect === 'sqlite') return splitBlocks(text, SQLITE);
    if (dialect === 'clickhouse') return splitBlocks(text, CLICKHOUSE);
    return splitOracle(text);
  }

  function helpers(text) {
    const n = text.length;
    return {
      skipLine: (j) => {
        const e = text.indexOf('\n', j);
        return e < 0 ? n : e + 1;
      },
      skipBlock: (j) => {
        const e = text.indexOf('*/', j + 2);
        return e < 0 ? n : e + 2;
      },
      // Quote doubled to escape; with backslash = true, \x escapes too.
      skipQuote: (j, q, backslash) => {
        let k = j + 1;
        while (k < n) {
          if (backslash && text[k] === '\\') { k += 2; continue; }
          if (text[k] === q) {
            if (text[k + 1] === q) { k += 2; continue; }
            return k + 1;
          }
          k++;
        }
        return n;
      },
    };
  }

  function splitOracle(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    let start = -1;
    let plsql = false;
    const { skipLine, skipBlock, skipQuote } = helpers(text);
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

  function splitPostgres(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    let start = -1;
    const { skipLine, skipQuote } = helpers(text);
    // Block comments nest in PostgreSQL.
    const skipBlock = (j) => {
      let depth = 0;
      let k = j;
      while (k < n) {
        if (text[k] === '/' && text[k + 1] === '*') { depth++; k += 2; continue; }
        if (text[k] === '*' && text[k + 1] === '/') { depth--; k += 2; if (!depth) return k; continue; }
        k++;
      }
      return n;
    };
    const emit = (s, e, termEnd) => {
      const body = text.slice(s, e).replace(/\s+$/, '');
      if (body.length) out.push({ text: body, start: s, end: termEnd, plsql: /\$[A-Za-z_]*\$/.test(body) });
    };
    while (i < n) {
      const c = text[i];
      const c2 = text[i + 1];
      if (start < 0) {
        if (/\s/.test(c)) { i++; continue; }
        if (c === '-' && c2 === '-') { i = skipLine(i); continue; }
        if (c === '/' && c2 === '*') { i = skipBlock(i); continue; }
        start = i;
      }
      if (c === '-' && c2 === '-') { i = skipLine(i); continue; }
      if (c === '/' && c2 === '*') { i = skipBlock(i); continue; }
      if (c === '$' && !isIdentChar(text[i - 1])) {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
        if (m) {
          const j = text.indexOf(m[0], i + m[0].length);
          i = j < 0 ? n : j + m[0].length;
          continue;
        }
      }
      if ((c === 'e' || c === 'E') && c2 === "'" && !isIdentChar(text[i - 1])) { i = skipQuote(i + 1, "'", true); continue; }
      if (c === "'") { i = skipQuote(i, "'"); continue; }
      if (c === '"') { i = skipQuote(i, '"'); continue; }
      if (c === ';') {
        emit(start, i, i + 1);
        start = -1; i++; continue;
      }
      i++;
    }
    if (start >= 0) emit(start, n, n);
    return out;
  }

  // MySQL, SQLite and ClickHouse share one splitter with different rules.
  const MYSQL = { hash: true, dashNeedsSpace: true, backslash: true, delimiterCommand: true, routine: MYSQL_ROUTINE, brackets: false };
  const SQLITE = { hash: false, dashNeedsSpace: false, backslash: false, delimiterCommand: false, routine: SQLITE_TRIGGER, brackets: true };
  const CLICKHOUSE = { hash: true, dashNeedsSpace: false, backslash: true, delimiterCommand: false, routine: null, brackets: false };

  function splitBlocks(text, o) {
    const out = [];
    const n = text.length;
    let i = 0;
    let start = -1;
    let delim = ';';
    let routine = false; // CREATE PROCEDURE / TRIGGER … BEGIN … END (without DELIMITER)
    let depth = 0;
    const { skipLine, skipBlock, skipQuote } = helpers(text);
    const word = (j) => (isIdentChar(text[j - 1]) ? null : /^[A-Za-z_]+/.exec(text.slice(j, j + 12)));
    const emit = (s, e, termEnd, plsql) => {
      const body = text.slice(s, e).replace(/\s+$/, '');
      if (body.length) out.push({ text: body, start: s, end: termEnd, plsql });
    };
    const lineComment = (c, c2) => (o.hash && c === '#') || (c === '-' && c2 === '-' && (!o.dashNeedsSpace || /\s/.test(text[i + 2] || ' ')));
    while (i < n) {
      const c = text[i];
      const c2 = text[i + 1];
      if (start < 0) {
        if (/\s/.test(c)) { i++; continue; }
        if (lineComment(c, c2)) { i = skipLine(i); continue; }
        if (c === '/' && c2 === '*' && text[i + 2] !== '!') { i = skipBlock(i); continue; }
        // DELIMITER is a MySQL client command: it changes the terminator and is not sent to the server.
        const dm = o.delimiterCommand ? /^delimiter[ \t]+(\S+)[ \t]*(\r?\n|$)/i.exec(text.slice(i, i + 64)) : null;
        if (dm) { delim = dm[1]; i += dm[0].length; continue; }
        start = i;
        routine = !!o.routine && delim === ';' && o.routine.test(text.slice(i, i + 200));
        depth = 0;
      }
      if (lineComment(c, c2)) { i = skipLine(i); continue; }
      if (c === '/' && c2 === '*') { i = skipBlock(i); continue; }
      if (c === "'" || c === '"') { i = skipQuote(i, c, o.backslash); continue; }
      if (c === '`') { i = skipQuote(i, '`'); continue; }
      if (o.brackets && c === '[') { const j = text.indexOf(']', i + 1); i = j < 0 ? n : j + 1; continue; }
      if (routine && /[A-Za-z]/.test(c)) {
        const w = word(i);
        if (w) {
          const k = w[0].toUpperCase();
          if (k === 'BEGIN' || k === 'CASE') depth++;
          else if (k === 'END') {
            // END IF / LOOP / WHILE / REPEAT close blocks that aren't counted; END and END CASE close one.
            const next = /^\s+([A-Za-z]+)/.exec(text.slice(i + 3, i + 24));
            const after = next ? next[1].toUpperCase() : '';
            if (!['IF', 'LOOP', 'WHILE', 'REPEAT'].includes(after)) depth = Math.max(0, depth - 1);
            if (['IF', 'LOOP', 'WHILE', 'REPEAT', 'CASE'].includes(after)) { i += 3 + next[0].length; continue; }
          }
          i += w[0].length;
          continue;
        }
      }
      if (text.startsWith(delim, i) && !(routine && depth > 0)) {
        emit(start, i, i + delim.length, delim !== ';' || routine);
        start = -1; i += delim.length; continue;
      }
      i++;
    }
    if (start >= 0) emit(start, n, n, delim !== ';' || routine);
    return out;
  }

  /** Statement containing the cursor, or the closest one before it. */
  function statementAt(text, pos, dialect) {
    const list = split(text, dialect);
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
