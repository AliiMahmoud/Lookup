// Shared state and constants for the connection workspace (window.Lookup).
(function () {
  const Lookup = (window.Lookup = window.Lookup || {});

  const ENVS = {
    none: { label: 'None', color: 'var(--env-none)' },
    local: { label: 'Local', color: 'var(--env-local)' },
    dev: { label: 'Dev', color: 'var(--env-dev)' },
    staging: { label: 'Staging', color: 'var(--env-staging)' },
    prod: { label: 'Production', color: 'var(--env-prod)' },
  };
  const TYPE_ICON = {
    TABLE: 'table', VIEW: 'view', 'MATERIALIZED VIEW': 'mview', SEQUENCE: 'sequence', PROCEDURE: 'procedure',
    FUNCTION: 'function', PACKAGE: 'package', TRIGGER: 'trigger', SYNONYM: 'synonym', TYPE: 'type',
  };
  const SECTIONS = [
    ['TABLE', 'Tables'], ['VIEW', 'Views'], ['MATERIALIZED VIEW', 'Materialized Views'], ['SEQUENCE', 'Sequences'],
    ['PACKAGE', 'Packages'], ['PROCEDURE', 'Procedures'], ['FUNCTION', 'Functions'], ['TRIGGER', 'Triggers'],
    ['TYPE', 'Types'], ['SYNONYM', 'Synonyms'],
  ];
  const params = new URLSearchParams(location.search);
  const EMBEDDED = params.get('embedded') === '1'; // hosted as a connection tab inside a window
  const S = {
    platform: 'win32',
    connections: [],
    current: null,
    info: null,
    schema: null,
    schemas: [],
    objects: [],
    objCache: new Map(),
    colCache: new Map(),
    tabs: [],
    active: null,
    autoCommit: false,
    txPending: false,
    collapsed: new Set(['SEQUENCE', 'TRIGGER', 'TYPE', 'SYNONYM']),
    filter: '',
  };

  Object.assign(Lookup, { ENVS, TYPE_ICON, SECTIONS, params, EMBEDDED, S });
})();
