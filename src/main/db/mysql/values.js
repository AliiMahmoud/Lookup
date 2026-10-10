// MySQL / MariaDB: result columns (type names from the protocol's type codes) and value conversion.
const { kindOf } = require('./sqlgen');
const { ser } = require('../common/values');

const BINARY_CHARSET = 63;
const NAMES = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 6: 'null', 7: 'timestamp', 8: 'bigint',
  9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 14: 'date', 16: 'bit', 242: 'vector', 245: 'json',
  246: 'decimal', 247: 'enum', 248: 'set', 255: 'geometry',
};

/** Type name of a result column; text and binary types share codes and differ by character set. */
function typeName(f) {
  const bin = f.characterSet === BINARY_CHARSET;
  switch (f.columnType) {
    case 15: case 253: return bin ? 'varbinary' : 'varchar';
    case 254: return bin ? 'binary' : 'char';
    case 249: case 250: case 251: case 252: return bin ? 'blob' : 'text';
    default: return NAMES[f.columnType] || 'text';
  }
}

function columnsFromFields(fields) {
  return (fields || []).map((f) => {
    const type = typeName(f);
    return { name: f.name, type, kind: kindOf(type) };
  });
}

/** Converts values in place (dates and numbers arrive as text; binaries as Buffers). */
function serializeRows(rows, full) {
  for (const r of rows) for (let i = 0; i < r.length; i++) r[i] = ser(r[i], false, full);
  return rows;
}

module.exports = { columnsFromFields, serializeRows, typeName };
