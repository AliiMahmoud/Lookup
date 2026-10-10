// Loads the screens of non-SQL databases (Redis, MongoDB) only when a connection needs them, so a window that never
// opens one never parses or keeps their code and styles (memory first; see README "Memory").
(function () {
  const Lookup = window.Lookup;

  // Files per feature, in load order. MongoDB reuses the Redis layout styles (sidebar rows, cards, terminal).
  const FEATURES = {
    redis: {
      css: ['styles/redis.css'],
      js: ['../shared/redis-cli.js', '../shared/redis-commands.js', 'js/app/redis.js', 'js/app/redis-key.js', 'js/app/redis-cli.js', 'js/app/redis-overview.js'],
    },
    mongodb: {
      css: ['styles/redis.css', 'styles/mongo.css'],
      js: ['../shared/mongo-lit.js', '../shared/mongo-shell.js', 'js/app/mongo.js', 'js/app/mongo-coll.js', 'js/app/mongo-shell.js'],
    },
  };
  const loading = new Map(); // feature -> Promise
  const added = new Set(); // file paths already in the page

  const addCss = (href) => new Promise((resolve) => {
    if (added.has(href)) return resolve();
    added.add(href);
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = l.onerror = () => resolve();
    document.head.appendChild(l);
  });
  const addJs = (src) => new Promise((resolve, reject) => {
    if (added.has(src)) return resolve();
    added.add(src);
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.body.appendChild(s);
  });

  /** Loads a feature's styles and scripts once; resolves when they have run. Unknown names resolve at once. */
  function loadFeature(name) {
    const f = FEATURES[name];
    if (!f) return Promise.resolve();
    if (!loading.has(name)) {
      loading.set(name, (async () => {
        await Promise.all(f.css.map(addCss));
        for (const src of f.js) await addJs(src); // in order: later files use earlier ones
      })().catch((e) => { loading.delete(name); throw e; }));
    }
    return loading.get(name);
  }

  /** Runs fn once the page's own scripts have all run (at once if a feature is loaded later). */
  function whenLoaded(fn) {
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  const featureLoaded = (name) => loading.has(name);

  Object.assign(Lookup, { loadFeature, whenLoaded, featureLoaded, FEATURES });
})();
