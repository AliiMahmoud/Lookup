// Redis Overview tab: commands per second, memory, clients and hit rate (with the last few minutes
// drawn as small lines), databases, memory limit and eviction, server details, slow log. Refreshes
// every 5 seconds while the tab is showing.
(function () {
  const { h, fmtNum, fmtBytes } = window.U;
  const Lookup = window.Lookup;
  const { S } = Lookup;

  const EVERY_MS = 5000;
  const KEEP = 60; // samples drawn in each small line (5 minutes)

  function spark(values, cls) {
    const w = 160; const hgt = 30;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    svg.setAttribute('class', 'r-spark ' + cls);
    const vals = values.filter((v) => v !== null && v !== undefined);
    if (vals.length < 2) return svg;
    const min = Math.min(...vals); const max = Math.max(...vals);
    const span = max - min || 1;
    const pts = vals.map((v, i) => `${(i / (KEEP - 1)) * w},${hgt - 3 - ((v - min) / span) * (hgt - 6)}`).join(' ');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', pts);
    svg.append(line);
    return svg;
  }
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };
  const uptime = (sec) => {
    if (sec === null) return '?';
    const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
    return d ? `${d} day${d === 1 ? '' : 's'} ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`;
  };

  function openRedisOverview() {
    const existing = S.tabs.find((t) => t.kind === 'roverview');
    if (existing) { Lookup.activate(existing.id); return existing; }
    const tab = { kind: 'roverview', title: 'Overview', name: 'Overview', icon: 'gauge', el: h('div', { class: 'tabview r-overview' }), samples: [] };
    const body = h('div', { class: 'r-ov-body' }, h('div', { class: 'grid-loading' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Reading server figures…')));
    tab.el.append(body);
    let timer = null;
    let busy = false;
    async function tick() {
      if (busy || document.hidden || tab.el.classList.contains('hidden') || S.lost) return;
      busy = true;
      try {
        const o = await Lookup.rop('overview');
        tab.samples.push(o);
        if (tab.samples.length > KEEP) tab.samples.shift();
        Lookup.R.usedMemory = o.usedMemory;
        paint(o);
      } catch (e) {
        body.innerHTML = '';
        body.append(h('div', { class: 'err-text' }, e.message));
      } finally { busy = false; }
    }
    function card(title, value, sub, series, cls) {
      return h('div', { class: 'r-card' }, h('div', { class: 'r-card-title' }, title), h('div', { class: 'r-card-value' }, value),
        h('div', { class: 'r-card-sub muted' }, sub), spark(series, cls));
    }
    function table(rows) {
      return h('table', { class: 'r-kv' }, h('tbody', null, rows.filter(Boolean).map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'mono' }, v)))));
    }
    function paint(o) {
      const s = tab.samples;
      const hitPct = o.hitRate === null ? '—' : `${(o.hitRate * 100).toFixed(1)}%`;
      const limit = o.maxMemory || null;
      const pct = limit ? Math.min(100, (o.usedMemory / limit) * 100) : o.systemMemory ? Math.min(100, (o.usedMemory / o.systemMemory) * 100) : 0;
      body.innerHTML = '';
      body.append(
        h('div', { class: 'r-cards' },
          card('Commands / sec', fmtNum(o.opsPerSec), `${fmtNum(o.totalCommands)} since start · refreshes every 5 s`, s.map((x) => x.opsPerSec), 'c1'),
          card('Memory used', fmtBytes(o.usedMemory || 0), `${limit ? `of ${fmtBytes(limit)} maxmemory` : 'no maxmemory limit'} · peak ${fmtBytes(o.peakMemory || 0)}`, s.map((x) => x.usedMemory), 'c2'),
          card('Connected clients', fmtNum(o.clients), `${fmtNum(o.blocked)} blocked · ${fmtNum(o.rejected)} rejected`, s.map((x) => x.clients), 'c3'),
          card('Hit rate', hitPct, `${fmtNum(o.hits)} hits · ${fmtNum(o.misses)} misses`, s.map((x) => x.hitRate), 'c4')),
        o.nodes ? h('div', null, h('h3', { class: 'r-ov-h' }, 'Cluster nodes'),
          h('table', { class: 'r-kv r-ov-nodes' },
            h('thead', null, h('tr', null, ['Node', 'Slots', 'Keys', 'Memory', 'Ops / sec', 'Clients', 'Replicas'].map((x) => h('th', null, x)))),
            h('tbody', null, o.nodes.map((n) => h('tr', null,
              h('td', { class: 'mono' }, n.id),
              h('td', { class: 'mono', title: n.ranges.map(([f, t]) => (f === t ? f : `${f}–${t}`)).join(', ') }, `${fmtNum(n.slots)} (${n.ranges.map(([f, t]) => (f === t ? f : `${f}–${t}`)).join(', ')})`),
              n.error ? h('td', { class: 'err-text', colspan: 5 }, n.error) : [
                h('td', { class: 'num' }, fmtNum(n.keys)),
                h('td', { class: 'num' }, fmtBytes(n.usedMemory || 0)),
                h('td', { class: 'num' }, fmtNum(n.opsPerSec)),
                h('td', { class: 'num' }, fmtNum(n.clients)),
                h('td', { class: 'mono' }, n.replicas.length ? n.replicas.join(', ') : '—')]))))) : '', // not null: append() would print it as text
        h('div', { class: 'r-ov-cols' },
          h('div', null,
            h('h3', null, 'Keyspace'),
            o.keyspace.length ? table(o.keyspace.map((d) => [`db${d.index}`, `${fmtNum(d.keys)} keys · ${fmtNum(d.expires)} with expiry${d.avgTtl ? ` · avg TTL ${Lookup.fmtTtl(d.avgTtl, true)}` : ''}`])) : h('p', { class: 'muted' }, 'No keys in any database'),
            h('h3', null, 'Memory'),
            h('div', { class: 'r-membar' }, h('div', { style: { width: pct + '%' } })),
            h('p', { class: 'muted small' }, [limit ? `${pct.toFixed(0)}% of maxmemory` : o.systemMemory ? `${pct.toFixed(0)}% of the machine's ${fmtBytes(o.systemMemory)} (no maxmemory set)` : 'No maxmemory set',
              o.policy ? `eviction: ${o.policy}` : null, o.fragmentation ? `fragmentation ${o.fragmentation}` : null, o.evictedKeys ? `${fmtNum(o.evictedKeys)} evicted` : null].filter(Boolean).join(' · '))),
          h('div', null,
            h('h3', null, 'Server'),
            table([
              ['Version', `${o.product} ${o.version || ''}${o.mode ? ` (${o.mode})` : ''}`],
              ['Uptime', uptime(o.uptimeSec)],
              ['Persistence', [o.rdb.lastSave ? `RDB saved ${ago(o.rdb.lastSave * 1000)}${o.rdb.changes ? ` · ${fmtNum(o.rdb.changes)} changes since` : ''}` : 'RDB never saved', o.aof ? 'AOF on' : 'AOF off'].join(' · ')],
              ['Replication', o.nodes ? `cluster · ${o.nodes.length} masters · ${fmtNum(o.replicas)} replica${o.replicas === 1 ? '' : 's'}` : o.role === 'master' ? `primary · ${fmtNum(o.replicas)} replica${o.replicas === 1 ? '' : 's'}` : o.role ? `replica of ${o.masterHost || '?'} · link ${o.masterLink || '?'}` : '?'],
              ['Modules', o.modules.length ? o.modules.map((m) => `${m.name}${m.ver ? ' ' + m.ver : ''}`).join(', ') : 'none'],
              ['Network', `${o.netInKbps === null ? '?' : Number(o.netInKbps.toFixed(2))} KB/s in · ${o.netOutKbps === null ? '?' : Number(o.netOutKbps.toFixed(2))} KB/s out`],
            ]),
            h('h3', null, 'Slow log'),
            o.slowlog === null ? h('p', { class: 'muted' }, 'Not available for this user')
              : o.slowlog.length ? h('table', { class: 'r-kv' }, h('tbody', null, o.slowlog.map((e) => h('tr', null,
                h('td', null, e.us >= 1000 ? `${(e.us / 1000).toFixed(1)} ms` : `${e.us} µs`),
                h('td', { class: 'mono', title: e.command }, `${e.command}${e.client ? ` · ${e.client}` : ''}${e.node ? ` · on ${e.node}` : ''} · ${ago(e.at)}`)))))
                : h('p', { class: 'muted' }, 'Empty'))));
      Lookup.renderStatus();
    }
    tab.onShow = () => tick();
    tab.destroy = () => clearInterval(timer);
    timer = setInterval(tick, EVERY_MS);
    Lookup.addTab(tab);
    tick();
    return tab;
  }

  Object.assign(Lookup, { openRedisOverview });
})();
