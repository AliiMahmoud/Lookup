// ClickHouse: result columns (names and types come first in the JSON rows) and value conversion.
const { kindOf } = require('./sqlgen');
const { ser } = require('../common/values');

function columnsFrom(names, types) {
  return (names || []).map((name, i) => ({ name, type: types[i], kind: kindOf(types[i]) }));
}

/** Converts values in place: numbers to text (exact), arrays / maps / tuples to JSON text. */
function serializeRows(rows) {
  for (const r of rows) for (let i = 0; i < r.length; i++) r[i] = typeof r[i] === 'number' ? String(r[i]) : ser(r[i], false);
  return rows;
}

module.exports = { columnsFrom, serializeRows };
