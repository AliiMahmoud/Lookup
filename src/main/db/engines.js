// The database engines Lookup can talk to. Each engine folder exports the same set of functions (see
// oracle/index.js for the list; Redis adds its own `ops`); an engine is loaded on first use.

const LOADERS = {
  oracle: () => require('./oracle'),
  postgres: () => require('./postgres'),
  mysql: () => require('./mysql'),
  sqlite: () => require('./sqlite'),
  clickhouse: () => require('./clickhouse'),
  redis: () => require('./redis'),
  mongodb: () => require('./mongodb'),
};

const loaded = new Map();

/** Engine module by id; saved connections from before multi-database support have no engine and are Oracle. */
function engine(id) {
  const key = id || 'oracle';
  if (!LOADERS[key]) throw new Error(`Unknown database type: ${key}`);
  if (!loaded.has(key)) loaded.set(key, LOADERS[key]());
  return loaded.get(key);
}

const engineFor = (cfg) => engine(cfg && cfg.engine);

module.exports = { engine, engineFor, ids: Object.keys(LOADERS) };
