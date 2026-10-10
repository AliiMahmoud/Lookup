// SQL beautifier for the query editor. Formats each SQL statement in place and
// leaves everything between statements (comments, ';', '/') untouched.
// Procedural blocks (PL/SQL, function bodies…) are kept exactly as written.
// The dialect (db/<engine>/dialect.js) picks the formatter language and the script splitter.
const { format } = require('sql-formatter');
const { split } = require('../shared/sqlsplit');

const OPTIONS = {
  tabWidth: 2,
  keywordCase: 'upper',
  functionCase: 'upper',
  dataTypeCase: 'upper',
  identifierCase: 'preserve',
  linesBetweenQueries: 1,
};

function formatScript(text, dialect = {}, options = {}) {
  const opts = { ...OPTIONS, language: dialect.formatLanguage || 'sql', ...(dialect.formatOptions || {}), ...options };
  const stmts = split(text, dialect.splitDialect);
  let out = text;
  let formatted = 0;
  let skipped = 0;
  let plsql = 0;
  // Replace from the end so earlier offsets stay valid.
  for (let i = stmts.length - 1; i >= 0; i--) {
    const st = stmts[i];
    if (st.plsql) { plsql++; continue; }
    let pretty;
    try {
      pretty = format(st.text, opts).trim();
    } catch {
      skipped++;
      continue;
    }
    out = out.slice(0, st.start) + pretty + out.slice(st.start + st.text.length);
    formatted++;
  }
  return { text: out, formatted, skipped, plsql };
}

module.exports = { formatScript, OPTIONS };
