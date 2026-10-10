// Editable Structure view for tables: edit/add/drop columns, add/drop/enable/disable constraints,
// add/drop indexes and comments. Changes stay pending until Apply (Ctrl+S).
(function () {
  const { h, icon, toast, modal } = window.U;

  const KINDS = [['PRIMARY KEY', 'Primary key'], ['UNIQUE', 'Unique'], ['FOREIGN KEY', 'Foreign key'], ['CHECK', 'Check']];

  function normType(t) {
    return String(t || '').toUpperCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').replace(/ BYTE\)/g, ')').trim();
  }
  function normDef(d) {
    const v = d === null || d === undefined ? '' : String(d).trim();
    return v.toUpperCase() === 'NULL' ? '' : v;
  }

  /**
   * opts = { owner, table, data (from api.structure), tables: [names for FK], loadRef(owner, table) -> structure,
   *          onChange(count), onApply(plan), design (profile.design: comments, toggleConstraints, upperCaseNames, …) }
   */
  function structureEditor(opts) {
    const D = { comments: true, toggleConstraints: true, upperCaseNames: true, identityHint: 'Identity column: Oracle fills it from a sequence', checkExample: "e.g. QTY > 0 or STATUS IN ('A','S')", ...(opts.design || {}) };
    const lists = window.ctEnsureLists ? window.ctEnsureLists(opts.design) : { types: 'ct-types', defaults: 'ct-defaults' };
    const identityText = (x) => (D.upperCaseNames ? `IDENTITY · ${String(x).toLowerCase()}`
      : x === 'AUTO_INCREMENT' ? 'auto_increment' : x === 'ROWID' ? 'rowid' : x === 'AUTOINCREMENT' ? 'rowid · autoincrement' : `identity · ${String(x).toLowerCase()}`);
    let key = 0;
    const st = {
      comment: (() => { const t = opts.data.tableComment !== undefined ? opts.data.tableComment : opts.data.comment; return { from: t || '', to: t || '' }; })(),
      cols: opts.data.columns.map((c) => {
        const orig = { name: c.name, type: c.fullType, nullable: !!c.nullable, default: c.default, comment: c.comments || '', identity: c.identity };
        return { key: ++key, orig, name: orig.name, type: orig.type, nullable: orig.nullable, default: orig.identity ? '' : (orig.default || ''), comment: orig.comment, drop: false, pk: c.pk };
      }),
      cons: opts.data.constraints.map((c) => ({ ...c, drop: false, enable: c.status === 'ENABLED' })),
      addCons: [],
      idx: opts.data.indexes.map((i) => ({ ...i, drop: false })),
      addIdx: [],
    };
    const el = h('div', { class: 'se' });

    // ---------- change tracking ----------
    const colChanged = (c, field) => {
      if (!c.orig) return true;
      if (field === 'name') return c.name.trim() !== c.orig.name;
      if (field === 'type') return !c.orig.identity && normType(c.type) !== normType(c.orig.type);
      if (field === 'nullable') return c.nullable !== c.orig.nullable;
      if (field === 'default') return !c.orig.identity && normDef(c.default) !== normDef(c.orig.default);
      if (field === 'comment') return (c.comment || '') !== (c.orig.comment || '');
      return false;
    };
    const colDirty = (c) => c.drop ? !!c.orig : !c.orig ? !!(c.name.trim() || c.type.trim()) : ['name', 'type', 'nullable', 'default', 'comment'].some((f) => colChanged(c, f));
    function count() {
      return st.cols.filter(colDirty).length
        + st.cons.filter((c) => c.drop || c.enable !== (c.status === 'ENABLED')).length
        + st.addCons.length + st.idx.filter((i) => i.drop).length + st.addIdx.length
        + (st.comment.to !== st.comment.from ? 1 : 0);
    }
    const changed = () => { opts.onChange(count()); };

    function plan() {
      return {
        owner: opts.owner,
        table: opts.table,
        columns: st.cols.filter((c) => c.orig || c.name.trim() || c.type.trim()).map((c) => ({
          orig: c.orig, name: c.name, type: c.type, nullable: c.nullable, default: c.default, comment: c.comment, drop: c.drop,
        })),
        dropConstraints: st.cons.filter((c) => c.drop).map((c) => c.name),
        toggleConstraints: st.cons.filter((c) => !c.drop && c.enable !== (c.status === 'ENABLED')).map((c) => ({ name: c.name, enable: c.enable })),
        addConstraints: st.addCons.map((c) => ({ ...c })),
        dropIndexes: st.idx.filter((i) => i.drop).map((i) => i.name),
        addIndexes: st.addIdx.map((i) => ({ ...i })),
        tableComment: st.comment,
      };
    }

    const liveColumnNames = () => st.cols.filter((c) => !c.drop && c.name.trim()).map((c) => c.name.trim());

    // ClickHouse writes Nullable in the type: the Nullable switch rewrites the type text and the type text sets the switch.
    const unwrapT = (t) => {
      let m = /^Nullable\((.*)\)$/is.exec(t.trim());
      if (m) return m[1].trim();
      m = /^LowCardinality\(\s*Nullable\((.*)\)\s*\)$/is.exec(t.trim());
      return m ? `LowCardinality(${m[1].trim()})` : t.trim();
    };
    const wrapT = (t) => { const b = unwrapT(t); const lc = /^LowCardinality\((.*)\)$/is.exec(b); return !b ? b : lc ? `LowCardinality(Nullable(${lc[1].trim()}))` : `Nullable(${b})`; };
    const typeSaysNull = (t) => /^(Nullable\(|LowCardinality\(\s*Nullable\()/i.test(String(t || '').trim());

    // ---------- columns ----------
    function colInput(c, field, attrs = {}) {
      const input = h('input', { class: 'se-in mono', spellcheck: 'false', autocomplete: 'off', disabled: c.drop, ...attrs });
      input.value = c[field] || '';
      input.addEventListener('input', () => {
        c[field] = input.value;
        input.closest('td').classList.toggle('chg', !!c.orig && colChanged(c, field));
        if (!c.orig) input.closest('tr').classList.toggle('incomplete', !!c.name.trim() !== !!c.type.trim());
        changed();
      });
      return input;
    }

    function columnsSection() {
      const rows = st.cols.map((c, i) => {
        const nul = h('select', { class: 'se-in', disabled: c.drop || c.pk && !c.drop, title: c.pk ? (D.keyNullNote || 'Primary key columns are NOT NULL') : '' },
          h('option', { value: 'YES' }, 'YES'), h('option', { value: 'NO' }, 'NO'));
        nul.value = c.nullable ? 'YES' : 'NO';
        nul.addEventListener('change', () => {
          c.nullable = nul.value === 'YES';
          if (D.nullableInType && c.type.trim()) { c.type = c.nullable ? wrapT(c.type) : unwrapT(c.type); render(); return; }
          nul.closest('td').classList.toggle('chg', !!c.orig && colChanged(c, 'nullable'));
          changed();
        });
        const idTag = c.orig && c.orig.identity
          ? h('span', { class: 'se-identity', title: D.identityHint }, identityText(c.orig.identity))
          : null;
        const cell = (field, content) => h('td', { class: c.orig && !c.drop && colChanged(c, field) ? 'chg' : '' }, content);
        return h('tr', { class: 'se-row' + (c.drop ? ' dropped' : '') + (!c.orig ? ' added' : '') + (!c.orig && (!!c.name.trim() !== !!c.type.trim()) ? ' incomplete' : '') },
          h('td', { class: 'muted se-num' }, c.orig ? i + 1 : '+'),
          cell('name', h('div', { class: 'se-name' }, c.pk ? icon('key', 'pk') : null, colInput(c, 'name', { placeholder: 'column_name' }))),
          cell('type', c.orig && c.orig.identity ? h('span', { class: 'se-fixed mono type' }, c.orig.type) : (() => {
            const t = colInput(c, 'type', { list: lists.types, placeholder: 'data type' });
            if (D.nullableInType) t.addEventListener('input', () => { c.nullable = typeSaysNull(c.type); nul.value = c.nullable ? 'YES' : 'NO'; nul.closest('td').classList.toggle('chg', !!c.orig && colChanged(c, 'nullable')); });
            return t;
          })()),
          cell('nullable', nul),
          cell('default', idTag || colInput(c, 'default', { list: lists.defaults, placeholder: 'NULL' })),
          D.comments ? cell('comment', colInput(c, 'comment', { placeholder: '' })) : null,
          h('td', { class: 'se-act' },
            c.drop
              ? h('button', { class: 'icon-btn', title: 'Keep this column', onclick: () => { c.drop = false; render(); } }, icon('undo'))
              : h('button', {
                class: 'icon-btn', title: c.orig ? 'Drop column' : 'Remove',
                onclick: () => { if (c.orig) c.drop = true; else st.cols.splice(st.cols.indexOf(c), 1); render(); },
              }, icon('trash'))));
      });
      const addBtn = h('button', {
        class: 'btn sm ghost', onclick: () => {
          st.cols.push({ key: ++key, orig: null, name: '', type: '', nullable: D.newColumnsNullable !== false, default: '', comment: '', drop: false });
          render();
          const added = el.querySelectorAll('.se-cols tr.added');
          if (added.length) added[added.length - 1].querySelector('.se-in').focus();
        },
      }, icon('plus'), 'Column');
      return [
        h('div', { class: 'se-h' }, h('h3', null, 'Columns', h('span', { class: 'count' }, st.cols.filter((c) => !c.drop).length)), addBtn),
        h('table', { class: 'meta se-cols' },
          h('colgroup', null, (D.comments ? ['34px', '22%', '22%', '90px', '22%', 'auto', '40px'] : ['34px', '28%', '28%', '90px', 'auto', '40px']).map((w) => h('col', { style: { width: w } }))),
          h('thead', null, h('tr', null, (D.comments ? ['#', 'Name', 'Type', 'Nullable', 'Default', 'Comment', ''] : ['#', 'Name', 'Type', 'Nullable', 'Default', '']).map((x) => h('th', null, x)))),
          h('tbody', null, rows)),
      ];
    }

    // ---------- constraints ----------
    function constraintsSection() {
      const rows = st.cons.map((c) => h('tr', { class: 'se-row' + (c.drop ? ' dropped' : '') },
        h('td', { class: 'mono strong' }, c.name), h('td', null, c.type), h('td', { class: 'mono' }, c.columns || ''),
        h('td', { class: 'mono muted se-detail' }, c.detail || ''),
        h('td', { class: c.enable !== (c.status === 'ENABLED') ? 'chg' : '' }, !D.toggleConstraints ? h('span', { class: 'muted' }, String(c.status || '').toLowerCase()) : (() => {
          const sel = h('select', { class: 'se-in', disabled: c.drop }, h('option', { value: '1' }, 'enabled'), h('option', { value: '0' }, 'disabled'));
          sel.value = c.enable ? '1' : '0';
          sel.addEventListener('change', () => { c.enable = sel.value === '1'; render(); });
          return sel;
        })()),
        h('td', { class: 'se-act' }, c.drop
          ? h('button', { class: 'icon-btn', title: 'Keep', onclick: () => { c.drop = false; render(); } }, icon('undo'))
          : (D.fixedConstraints || []).includes(c.type)
            ? h('button', { class: 'icon-btn', disabled: true, title: D.fixedConstraintNote || '' }, icon('trash'))
            : h('button', { class: 'icon-btn', title: 'Drop constraint', onclick: () => { c.drop = true; render(); } }, icon('trash')))));
      st.addCons.forEach((c, i) => rows.push(h('tr', { class: 'se-row added' },
        h('td', { class: 'mono strong' }, c.name || h('span', { class: 'muted' }, 'auto')), h('td', null, c.kind),
        h('td', { class: 'mono' }, (c.columns || []).join(', ')),
        h('td', { class: 'mono muted se-detail' }, c.kind === 'CHECK' ? c.check : c.kind === 'FOREIGN KEY' ? `→ ${c.refTable}${(c.refColumns || []).length ? ` (${c.refColumns.join(', ')})` : ''}${c.onDelete ? ` on delete ${c.onDelete.toLowerCase()}` : ''}` : ''),
        h('td', { class: 'muted' }, 'new'),
        h('td', { class: 'se-act' }, h('button', { class: 'icon-btn', title: 'Remove', onclick: () => { st.addCons.splice(i, 1); render(); } }, icon('trash'))))));
      return [
        h('div', { class: 'se-h' }, h('h3', null, 'Constraints', h('span', { class: 'count' }, st.cons.filter((c) => !c.drop).length + st.addCons.length)),
          h('button', { class: 'btn sm ghost', onclick: () => constraintDialog() }, icon('plus'), 'Constraint')),
        rows.length ? h('table', { class: 'meta' },
          h('thead', null, h('tr', null, ['Name', 'Type', 'Columns', 'Detail', 'Status', ''].map((x) => h('th', null, x)))),
          h('tbody', null, rows)) : h('p', { class: 'muted' }, 'None'),
      ];
    }

    function pickColumns(initial = []) {
      // Checkbox list that remembers click order (matters for composite keys and indexes).
      const order = [...initial];
      const box = h('div', { class: 'se-pick' });
      const paint = () => {
        box.innerHTML = '';
        liveColumnNames().forEach((n) => {
          const cb = h('input', { type: 'checkbox' });
          cb.checked = order.includes(n);
          cb.addEventListener('change', () => { if (cb.checked) order.push(n); else order.splice(order.indexOf(n), 1); paint(); });
          const pos = order.indexOf(n);
          box.append(h('label', { class: 'check' }, cb, h('span', { class: 'mono' }, n), pos >= 0 && order.length > 1 ? h('span', { class: 'se-ord' }, pos + 1) : null));
        });
      };
      paint();
      return { el: box, value: () => [...order] };
    }

    function constraintDialog() {
      const hasPk = st.cons.some((c) => c.type === 'PRIMARY KEY' && !c.drop) || st.addCons.some((c) => c.kind === 'PRIMARY KEY');
      const kinds = D.constraintKinds ? KINDS.filter(([v]) => D.constraintKinds.includes(v)) : KINDS;
      const first = kinds.find(([v]) => !(v === 'PRIMARY KEY' && hasPk));
      const f = { kind: first ? first[0] : 'CHECK', name: '', check: '', refTable: '', refColumns: [], onDelete: '' };
      const body = h('div', { class: 'se-form' });
      const cols = pickColumns();
      let refPick = null;
      const paint = () => {
        body.innerHTML = '';
        const kind = h('select', { class: 'input', onchange: (e) => { f.kind = e.target.value; paint(); } },
          kinds.map(([v, l]) => h('option', { value: v, disabled: v === 'PRIMARY KEY' && hasPk }, l + (v === 'PRIMARY KEY' && hasPk ? ' (table has one)' : ''))));
        kind.value = f.kind;
        const name = h('input', { class: 'input mono', placeholder: 'leave empty for an automatic name', oninput: (e) => { f.name = e.target.value; } });
        name.value = f.name;
        body.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type'), kind),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name));
        if (f.kind === 'CHECK') {
          const cond = h('input', { class: 'input mono', placeholder: D.checkExample, oninput: (e) => { f.check = e.target.value; } });
          cond.value = f.check;
          body.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Condition'), cond));
          return;
        }
        body.append(h('div', { class: 'field' }, h('span', { class: 'field-label' }, f.kind === 'FOREIGN KEY' ? 'Columns in this table' : 'Columns'), cols.el));
        if (f.kind === 'FOREIGN KEY') {
          const listId = 'se-tables-' + key;
          const refBox = h('div', { class: 'se-pick' }, h('span', { class: 'muted' }, 'Pick a table to list its columns'));
          const ref = h('input', { class: 'input mono', list: listId, placeholder: D.upperCaseNames ? 'TABLE or OWNER.TABLE' : 'table or schema.table' });
          ref.value = f.refTable;
          const loadRef = async () => {
            f.refTable = ref.value.trim();
            if (!f.refTable) return;
            const [o, t] = f.refTable.includes('.') ? f.refTable.split('.') : [opts.owner, f.refTable];
            refBox.innerHTML = '';
            refBox.append(h('span', { class: 'muted' }, 'Loading…'));
            try {
              const s = await opts.loadRef(D.upperCaseNames ? o.toUpperCase() : o, D.upperCaseNames ? t.toUpperCase() : t);
              const pk = s.constraints.find((c) => c.type === 'PRIMARY KEY');
              const pkCols = pk ? pk.columns.split(', ') : [];
              const order = [...pkCols];
              refBox.innerHTML = '';
              s.columns.forEach((c) => {
                const cb = h('input', { type: 'checkbox' });
                cb.checked = order.includes(c.name);
                cb.addEventListener('change', () => { if (cb.checked) order.push(c.name); else order.splice(order.indexOf(c.name), 1); });
                refBox.append(h('label', { class: 'check' }, cb, h('span', { class: 'mono' }, c.name), c.pk ? icon('key', 'pk') : null));
              });
              refPick = () => [...order];
            } catch (e) {
              refBox.innerHTML = '';
              refBox.append(h('span', { class: 'err-text' }, e.message));
              refPick = null;
            }
          };
          ref.addEventListener('change', loadRef);
          const onDel = h('select', { class: 'input', onchange: (e) => { f.onDelete = e.target.value; } },
            h('option', { value: '' }, 'No action'), h('option', { value: 'CASCADE' }, 'Cascade'), h('option', { value: 'SET NULL' }, 'Set null'));
          onDel.value = f.onDelete;
          body.append(
            h('datalist', { id: listId }, opts.tables.map((t) => h('option', { value: t }))),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'References table'), ref),
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Referenced columns'), refBox),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'On delete'), onDel));
          if (f.refTable) loadRef();
        }
      };
      paint();
      modal({
        title: 'Add constraint',
        body,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Add', kind: 'primary',
            onClick: () => {
              const c = { kind: f.kind, name: f.name.trim() };
              if (f.kind === 'CHECK') {
                if (!f.check.trim()) { toast('Enter a condition', 'err'); return false; }
                c.check = f.check.trim();
              } else {
                c.columns = cols.value();
                if (!c.columns.length) { toast('Pick at least one column', 'err'); return false; }
                if (f.kind === 'FOREIGN KEY') {
                  if (!f.refTable) { toast('Pick the referenced table', 'err'); return false; }
                  c.refTable = f.refTable;
                  c.refColumns = refPick ? refPick() : [];
                  c.onDelete = f.onDelete;
                }
              }
              st.addCons.push(c);
              render();
              return true;
            },
          },
        ],
      });
    }

    // ---------- indexes ----------
    function indexesSection() {
      const rows = st.idx.map((i) => h('tr', { class: 'se-row' + (i.drop ? ' dropped' : '') },
        h('td', { class: 'mono strong' }, i.name), h('td', { class: 'mono' }, i.columns || ''), h('td', { class: 'muted' }, String(i.type || '').toLowerCase()),
        h('td', null, i.unique ? 'yes' : h('span', { class: 'muted' }, 'no')),
        h('td', { class: i.status === 'VALID' || i.status === 'N/A' ? 'muted' : 'warn' }, String(i.status || '').toLowerCase()),
        h('td', { class: 'se-act' }, i.drop
          ? h('button', { class: 'icon-btn', title: 'Keep', onclick: () => { i.drop = false; render(); } }, icon('undo'))
          : h('button', {
            class: 'icon-btn', disabled: i.constraint,
            title: i.constraint ? 'This index belongs to a constraint — drop the constraint instead' : 'Drop index',
            onclick: () => { i.drop = true; render(); },
          }, icon('trash')))));
      st.addIdx.forEach((i, n) => rows.push(h('tr', { class: 'se-row added' },
        h('td', { class: 'mono strong' }, i.name || h('span', { class: 'muted' }, 'auto')), h('td', { class: 'mono' }, i.columns.join(', ')),
        h('td', { class: 'muted' }, i.type ? `${i.type} · granularity ${i.granularity}` : 'normal'), h('td', null, i.unique ? 'yes' : h('span', { class: 'muted' }, 'no')), h('td', { class: 'muted' }, 'new'),
        h('td', { class: 'se-act' }, h('button', { class: 'icon-btn', title: 'Remove', onclick: () => { st.addIdx.splice(n, 1); render(); } }, icon('trash'))))));
      return [
        h('div', { class: 'se-h' }, h('h3', null, 'Indexes', h('span', { class: 'count' }, st.idx.filter((i) => !i.drop).length + st.addIdx.length)),
          h('button', { class: 'btn sm ghost', onclick: () => indexDialog() }, icon('plus'), 'Index')),
        rows.length ? h('table', { class: 'meta' },
          h('thead', null, h('tr', null, ['Name', 'Columns', 'Type', 'Unique', 'Status', ''].map((x) => h('th', null, x)))),
          h('tbody', null, rows)) : h('p', { class: 'muted' }, 'None'),
      ];
    }

    function indexDialog() {
      const cols = pickColumns();
      const name = h('input', { class: 'input mono', placeholder: 'leave empty for an automatic name' });
      const uniq = h('input', { type: 'checkbox' });
      // ClickHouse: data-skipping indexes have a type and a granularity instead of Unique.
      const typeList = 'se-itypes-' + key;
      const itype = D.indexTypes ? h('input', { class: 'input mono', list: typeList, spellcheck: 'false' }) : null;
      const gran = D.indexTypes ? h('input', { class: 'input mono', type: 'number', min: '1', value: '1' }) : null;
      if (itype) itype.value = D.indexTypes[0];
      modal({
        title: 'Add index',
        body: h('div', { class: 'se-form' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Columns (in order clicked)'), cols.el),
          itype ? [
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Index type'), itype, h('datalist', { id: typeList }, D.indexTypes.map((x) => h('option', { value: x })))),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Granularity (blocks of rows per index entry)'), gran),
          ] : h('label', { class: 'check' }, uniq, h('span', null, 'Unique'))),
        actions: [
          { label: 'Cancel' },
          {
            label: 'Add', kind: 'primary',
            onClick: () => {
              const c = cols.value();
              if (!c.length) { toast('Pick at least one column', 'err'); return false; }
              st.addIdx.push(itype
                ? { name: name.value.trim(), unique: false, columns: c, type: itype.value.trim() || D.indexTypes[0], granularity: Number(gran.value) || 1 }
                : { name: name.value.trim(), unique: uniq.checked, columns: c });
              render();
              return true;
            },
          },
        ],
      });
    }

    // ---------- whole view ----------
    function render() {
      const scroll = el.parentNode ? el.parentNode.scrollTop : 0;
      el.innerHTML = '';
      const comment = h('input', { class: 'se-comment' + (D.comments ? '' : ' hidden'), placeholder: 'Table comment', spellcheck: 'false' });
      comment.value = st.comment.to;
      comment.classList.toggle('chg', st.comment.to !== st.comment.from);
      comment.addEventListener('input', () => { st.comment.to = comment.value; comment.classList.toggle('chg', st.comment.to !== st.comment.from); changed(); });
      el.append(comment, ...columnsSection(), ...constraintsSection(), ...indexesSection());
      if (el.parentNode) el.parentNode.scrollTop = scroll;
      changed();
    }

    render();
    return { el, count, plan };
  }

  window.structureEditor = structureEditor;
})();
