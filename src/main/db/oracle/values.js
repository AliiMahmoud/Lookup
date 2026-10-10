// Oracle: converting fetched values and node-oracledb column metadata for the UI.
const { kindOf } = require('./sqlgen');
const { ser: serValue } = require('../common/values');

const withMs = (meta) => !!meta && /TIMESTAMP/.test(meta.dbTypeName || '');

const ser = (v, meta, full) => serValue(v, withMs(meta), full);

function columnsFromMeta(metaData) {
  return (metaData || []).map((m) => ({
    name: m.name,
    type: m.dbTypeName,
    nullable: m.nullable,
    precision: m.precision,
    scale: m.scale,
    kind: kindOf(m.dbTypeName),
  }));
}

// Converts values in place: large results are not copied a second time.
function serializeRows(rows, metaData, full) {
  for (const r of rows) for (let i = 0; i < r.length; i++) r[i] = ser(r[i], metaData[i], full);
  return rows;
}

module.exports = { ser, columnsFromMeta, serializeRows };
