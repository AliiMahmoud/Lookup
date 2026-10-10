// MongoDB values between the main process and the window: canonical Extended JSON (plain JSON that
// keeps every BSON type: Int32 vs Double vs Long, Decimal128, ObjectId, dates, binary …), so nothing is
// rounded or changed on the way. shared/mongo-lit.js prints and parses the same format.
const { mongo } = require('./connect');
const { print } = require('../../../shared/mongo-lit');

const EJSON = () => mongo().BSON.EJSON;

/** BSON value (from the driver, read with promoteValues: false) -> canonical Extended JSON. */
const toWire = (v) => EJSON().serialize(v, { relaxed: false });

/** Canonical Extended JSON from the window -> BSON value for the driver. */
const fromWire = (v) => (v === undefined ? undefined : EJSON().deserialize(v, { relaxed: false }));

/** Short mongosh text of a wire value, for the SQL log. */
const text = (v) => (v === undefined || v === null ? '{}' : print(v, { width: 200 }).replace(/\s*\n\s*/g, ' '));

/** Read options: keep exact BSON number types (Int32 / Double / Long) and regexes as written. */
const READ = { promoteValues: false, promoteLongs: false, bsonRegExp: true };

module.exports = { toWire, fromWire, text, READ };
