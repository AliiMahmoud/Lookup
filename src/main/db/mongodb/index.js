// MongoDB engine (the official driver: pure JavaScript, loaded on first use). Connecting, lost
// connections, Stop and the SQL log work like the other engines; everything else is MongoDB-specific
// and reached through `ops` (db.engineOp): browsing, documents, aggregations, schema, indexes,
// validation, the light shell and the Overview.
const { open, targetKey, Op } = require('./connect');
const browse = require('./browse');
const docs = require('./docs');
const agg = require('./agg');
const { schema } = require('./schema');
const admin = require('./admin');
const shell = require('./shell');

const LOST = /MongoNetworkError|MongoServerSelectionError|MongoTopologyClosedError|MongoNotConnectedError|ECONNRESET|ECONNREFUSED|EPIPE|connection .*closed/i;
const isLostError = (e) => !!e && !isCancelError(e) && (LOST.test(String(e.name || '')) || LOST.test(String(e.message || '')));
const isCancelError = (e) => !!e && (e.name === 'AbortError' || /operation was aborted|interrupted|Stopped/i.test(String(e.message || '')) || e.code === 11601);

/** Version, topology and the connection's database; FerretDB and Atlas are named. */
async function describe(conn) {
  const a = conn.client.db('admin');
  const [build, hello] = await Promise.all([
    conn.execute(new Op('db.version()', () => a.command({ buildInfo: 1 }))),
    conn.execute(new Op('db.hello()', () => a.command({ hello: 1 }))).catch(() => ({})),
  ]);
  const atlas = /\.mongodb\.net\b/i.test(conn.cfg.mode === 'string' ? conn.cfg.connectString : conn.cfg.host || '');
  const topology = hello.msg === 'isdbgrid' ? 'sharded cluster (mongos)' : hello.setName ? `replica set ${hello.setName}` : 'standalone';
  return {
    version: build.ferretdbVersion ? `${String(build.ferretdbVersion).replace(/^v/, '')} (MongoDB ${build.version} API)` : build.version,
    ...(build.ferretdbVersion ? { product: 'FerretDB' } : {}),
    ferretdb: build.ferretdbVersion || null,
    schema: conn.dbName, dbName: conn.dbName,
    topology, atlas, setName: hello.setName || null,
  };
}

async function prepareSession() { return {}; }

const cancel = (s) => s.conn.cancelRunning();

const ops = {
  databases: browse.databases,
  collections: browse.collections,
  collStats: browse.collStats,
  find: docs.find,
  count: docs.count,
  explain: docs.explain,
  update: docs.update,
  insert: docs.insert,
  remove: docs.remove,
  exportDocs: docs.exportDocs,
  aggPreview: agg.preview,
  aggRun: agg.run,
  aggExplain: agg.explain,
  schema,
  indexes: admin.indexes,
  createIndex: admin.createIndex,
  dropIndex: admin.dropIndex,
  validation: admin.validation,
  setValidation: admin.setValidation,
  createCollection: admin.createCollection,
  dropCollection: admin.dropCollection,
  renameCollection: admin.renameCollection,
  dropDatabase: admin.dropDatabase,
  overview: admin.overview,
  stop: async (s) => { await s.conn.cancelRunning(); return { stopped: true }; },
  shellOpen: shell.shellOpen,
  shellRun: shell.shellRun,
  shellStop: shell.shellStop,
  shellClose: shell.shellClose,
};

module.exports = {
  id: 'mongodb',
  profile: require('./profile'),
  dialect: require('./dialect'),
  open, describe, prepareSession, targetKey,
  cfgForDatabase: (cfg, db) => ({ ...cfg, database: db.name }),
  isLostError, isCancelError, cancel,
  ops,
};
