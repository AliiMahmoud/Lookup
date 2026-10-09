// SQL beautifier for the query editor. Formats each SQL statement in place and
// leaves everything between statements (comments, ';', '/') untouched.
// PL/SQL blocks (BEGIN/DECLARE/CREATE PROCEDURE…) are kept exactly as written.
const { format } = require('sql-formatter');
const { split } = require('../shared/sqlsplit');

const OPTIONS = {
  language: 'plsql',
  tabWidth: 2,
  keywordCase: 'upper',
  functionCase: 'upper',
  dataTypeCase: 'upper',
  identifierCase: 'preserve',
  linesBetweenQueries: 1,
  paramTypes: { named: [':'] },
};

function formatScript(text, options = {}) {
  const opts = { ...OPTIONS, ...options };
  const stmts = split(text);
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
