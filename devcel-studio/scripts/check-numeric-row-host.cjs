'use strict';

// Production Row/Cell integration in a synthetic DOM. This checks host identity,
// committed-cache behavior and events, not native layout or rendering performance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { compileModule } = require('./compile-module.cjs');
const root = path.resolve(__dirname, '..');

(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://numeric-row-host.invalid' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'Event', 'MouseEvent', 'FocusEvent', 'MutationObserver']) {
    Object.defineProperty(globalThis, name, {
      configurable: true, value: name === 'window' ? window : window[name]
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const modules = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = new Module(filename);
    module.paths = Module._nodeModulePaths(root);
    modules.set(filename, module);
    module.require = id => {
      if (id === '@linaria/core') return { css: () => 'synthetic-grid-style' };
      if (id.endsWith('.css')) return {};
      if (id.startsWith('.') || id.startsWith('@/')) {
        const target = id.startsWith('@/') ? path.join(root, 'src', id.slice(2))
          : path.resolve(path.dirname(filename), id);
        for (const suffix of ['', '.tsx', '.ts', '/index.ts']) {
          if (fs.existsSync(target + suffix) && fs.statSync(target + suffix).isFile()) return load(target + suffix);
        }
        throw Error(`Cannot resolve ${id} from ${filename}`);
      }
      return require(id);
    };
    module._compile(compileModule(fs.readFileSync(filename, 'utf8'), filename), filename);
    return module.exports;
  }

  const Row = load('src/lib/react-data-grid/Row.tsx').default;
  const { defaultRenderCell, shallowEqualCellProps } = load('src/lib/react-data-grid/Cell.tsx');
  const { DataGridDefaultRenderersContext } = load('src/lib/react-data-grid/DataGridDefaultRenderersContext.ts');
  const defaultRenderers = { renderCell: defaultRenderCell };
  const noop = () => {};
  const textCalls = [];
  const genericCalls = [];
  const styleCalls = [];
  const callbacks = [];
  const selections = [];
  const tooltipEvents = [];
  const rowContextMenus = [];
  const backgroundCalls = [];
  const makeTooltip = name => Object.fromEntries(['onFocus', 'onBlur', 'onMouseEnter', 'onMouseLeave', 'onClick']
    .map(type => [type, event => tooltipEvents.push({ name, type, host: event.currentTarget })]));
  const tooltip = makeTooltip('initial');
  const column = (key, idx) => ({
    key, idx, name: key, frozen: false, editable: true, renderEditCell: noop,
    cellClass: 'rdg-cell-type-number rdg-cell-plain-display',
    renderTextCell: row => { textCalls.push({ key, uuid: row.uuid }); return row[key]; },
    renderCell: ({ row }) => { genericCalls.push(key); return row[key]; },
    styleResolver: (_value, row) => { styleCalls.push({ key, uuid: row.uuid }); return row.cellStyle; },
    cellDescription: row => row.error ? { title: row.error, description: row.error, invalid: true }
      : row.hint ? { title: row.hint, description: row.hint } : undefined
  });
  const amount = column('amount', 0);
  const bonus = column('bonus', 1);
  const columns = [amount, bonus];
  const originalRow = { uuid: 'record-committed', amount: '9007199254740993', bonus: '1.25' };
  const selectCell = (position, options) => selections.push({ position, options });
  const recordCallback = (args, event) => callbacks.push({
    type: event.type, host: event.currentTarget, row: args.row,
    column: args.column, rowIdx: args.rowIdx, button: event.button
  });
  const getBackground = (row, col, state) => {
    backgroundCalls.push({ row, column: col, ...state });
    return state.isSelected ? '#123456' : state.isHovered ? '#abcdef' : '#ffffff';
  };
  const initialProps = {
    row: originalRow, rowIdx: 4, gridRowStart: 6, viewportColumns: columns,
    physicalRowTop: 120, physicalRowHeight: 30,
    selectedCellIdx: undefined, isCurrentRowSelected: false,
    isRowSelected: false, isRowSelectionDisabled: false, lastFrozenColumnIndex: -1,
    sharedTooltip: tooltip, selectCell, onRowChange: noop, getCellBackgroundColor: getBackground,
    onCellMouseDown: recordCallback, onCellClick: recordCallback,
    onCellDoubleClick: recordCallback, onCellContextMenu: recordCallback,
    onRowContextMenu: (row, event) => rowContextMenus.push({ row, host: event.currentTarget })
  };
  let props = initialProps;
  const host = document.createElement('div');
  document.body.append(host);
  const mounted = createRoot(host);
  let pendingAttempts = 0;
  const never = new Promise(() => {});
  function Suspender({ pending }) {
    if (pending) { pendingAttempts++; throw never; }
    return null;
  }
  function tree(value, renderers = defaultRenderers, pending = false) {
    return React.createElement(DataGridDefaultRenderersContext, { value: renderers },
      React.createElement(React.Suspense, { fallback: React.createElement('p', { 'data-suspended': '' }, 'pending') },
        React.createElement(Row, value), React.createElement(Suspender, { pending })));
  }
  async function draw(extra = {}, renderers = defaultRenderers) {
    props = { ...props, ...extra };
    await React.act(async () => mounted.render(tree(props, renderers)));
  }
  const cell = (idx = 0) => host.querySelector(`[role="gridcell"][data-column-index="${idx}"]`);
  async function mouse(type, options = {}, target = cell()) {
    assert(target, `Missing cell for ${type}`);
    await React.act(async () => target.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, ...options
    })));
  }
  // happy-dom normalizes CSS-variable shorthands differently from a browser.
  const outline = width => {
    const probe = document.createElement('div');
    probe.style.outline = `${width}px solid var(--rdg-selection-color)`;
    return probe.style.outline;
  };
  const countText = uuid => textCalls.filter(call => call.uuid === uuid).length;
  function assertSelection(position, options) {
    assert.deepEqual(selections.at(-1), { position, options });
  }

  try {
    await draw();
    const originalHost = cell();
    const originalBonusHost = cell(1);
    assert.equal(host.querySelectorAll('[role="gridcell"]').length, 2);
    assert.equal(originalHost.firstElementChild, null, 'numeric text uses the semantic host itself');
    assert.equal(originalHost.textContent, originalRow.amount, '64-bit display is never parsed through Number');
    assert.equal(originalHost.tabIndex, -1);
    assert.equal(originalHost.getAttribute('aria-colindex'), '1');
    assert.equal(originalHost.getAttribute('data-row-index'), '4');
    assert.equal(genericCalls.length, 0, 'default provider selects the direct numeric path');

    // Row-only changes reuse all cached elements. Selecting one column recomputes
    // only that column, and never swaps either existing DOM host.
    const beforeUnrelated = textCalls.length;
    await draw({ className: 'unrelated-row-change', gridRowStart: 7 });
    assert.equal(textCalls.length, beforeUnrelated);
    const beforeOverlapStyles = styleCalls.length;
    await draw({ physicalRowTop: 150 });
    assert.equal(textCalls.length, beforeUnrelated, 'overlap scrolling reuses numeric text');
    assert.equal(styleCalls.length, beforeOverlapStyles, 'overlap scrolling reuses resolved styles');
    assert.equal(cell(), originalHost);
    assert.equal(cell(1), originalBonusHost);
    assert.equal(host.querySelector('[role="row"]').style.top, '150px');
    await draw({ selectedCellIdx: 0, isCurrentRowSelected: true });
    assert.equal(textCalls.length, beforeUnrelated + 1);
    assert.equal(cell(), originalHost);
    assert.equal(cell(1), originalBonusHost);
    assert.equal(cell().tabIndex, 0);
    assert.equal(cell().getAttribute('aria-selected'), 'true');
    assert.equal(cell().style.outline, outline(2));
    await React.act(async () => cell().focus());
    assert.equal(document.activeElement, originalHost);
    assert.equal(tooltipEvents.at(-1).host, originalHost);
    assert.equal(tooltipEvents.at(-1).type, 'onFocus');
    await draw({ selectedCellIdx: 1 });
    assert.equal(cell(), originalHost);
    assert.equal(cell(1), originalBonusHost);
    assert.equal(cell().tabIndex, -1);
    assert.equal(cell(1).tabIndex, 0);
    await draw({ selectedCellIdx: undefined, isCurrentRowSelected: false });
    assert.equal(cell(), originalHost);
    assert.equal(cell().getAttribute('aria-selected'), 'false');
    assert.equal(cell().style.outline, '');

    // Callbacks receive the cell host, the canonical record identity and the
    // matching column, including right-click mousedown/contextmenu.
    for (const [type, options] of [
      ['mousedown', { shiftKey: true }], ['click', {}], ['dblclick', {}],
      ['mousedown', { button: 2 }], ['contextmenu', { button: 2 }]
    ]) {
      const previous = selections.length;
      await mouse(type, options);
      assert.deepEqual(callbacks.at(-1), {
        type, host: originalHost, row: originalRow, column: amount, rowIdx: 4, button: options.button ?? 0
      });
      if (type === 'mousedown') assertSelection({ rowIdx: 4, idx: 0 }, { enableEditor: false, isShiftPressed: !!options.shiftKey });
      else if (type === 'dblclick') assertSelection({ rowIdx: 4, idx: 0 }, { enableEditor: true, isShiftPressed: undefined });
      else assert.equal(selections.length, previous, `${type} does not introduce a selection`);
    }
    assert.equal(rowContextMenus.at(-1).row, originalRow);
    assert.equal(rowContextMenus.at(-1).host, host.querySelector('[role="row"]'));
    assert(tooltipEvents.some(event => event.type === 'onClick' && event.host === originalHost));
    const prevent = (args, event) => {
      recordCallback(args, event);
      assert.equal(event.isGridDefaultPrevented(), false);
      event.preventGridDefault();
      assert.equal(event.isGridDefaultPrevented(), true);
    };
    await draw({ onCellMouseDown: prevent, onCellDoubleClick: prevent });
    const beforePrevented = selections.length;
    await mouse('mousedown');
    await mouse('dblclick');
    assert.equal(selections.length, beforePrevented, 'preventGridDefault suppresses selection and editing');
    await draw({ onCellMouseDown: recordCallback, onCellDoubleClick: recordCallback, transientLock: true });
    await mouse('dblclick');
    assertSelection({ rowIdx: 4, idx: 0 }, { enableEditor: false, isShiftPressed: undefined });
    assert.equal(cell().getAttribute('aria-readonly'), 'true');
    await draw({ onCellClick: (args, event) => { recordCallback(args, event); args.selectCell(true, true); } });
    await mouse('click');
    assertSelection({ rowIdx: 4, idx: 0 }, { enableEditor: false, isShiftPressed: true });
    await draw({ transientLock: false, onCellClick: recordCallback });
    assert.equal(cell().hasAttribute('aria-readonly'), false);

    // Every presentation dependency is represented by a new props value. No
    // numeric shortcut may leave text, accessibility metadata or styles stale.
    const diagnosticRow = { ...originalRow, amount: '#DIV/0!', error: 'Division by zero',
      cellStyle: { color: '#b91c1c', fontWeight: 700, boxShadow: 'inset 0 -2px #dc2626' } };
    await draw({ row: diagnosticRow });
    assert.equal(cell(), originalHost);
    assert.equal(cell().textContent, '#DIV/0!');
    assert.equal(cell().title, 'Division by zero');
    assert.equal(cell().getAttribute('aria-description'), 'Division by zero');
    assert.equal(cell().getAttribute('aria-invalid'), 'true');
    assert.equal(cell().style.color, '#b91c1c');
    assert.equal(cell().style.fontWeight, '700');
    assert.equal(cell().style.boxShadow, 'inset 0 -2px #dc2626');
    await draw({ row: { ...originalRow, hint: 'Canonical numeric input' } });
    assert.equal(cell().title, 'Canonical numeric input');
    assert.equal(cell().hasAttribute('aria-invalid'), false);
    assert.equal(cell().style.color, '');
    assert.equal(cell().style.fontWeight, '');
    assert.equal(cell().style.boxShadow, '');
    await draw({ row: originalRow });
    assert.equal(cell().hasAttribute('title'), false);
    assert.equal(cell().hasAttribute('aria-description'), false);
    const restyled = { ...amount, cellClass: 'changed-numeric-class', customStyles: { fontSize: 18, textAlign: 'right' } };
    await draw({ viewportColumns: [restyled, bonus] });
    assert.equal(cell(), originalHost);
    assert(cell().classList.contains('changed-numeric-class'));
    assert.equal(cell().style.fontSize, '18px');
    assert.equal(cell().style.textAlign, 'right');
    await mouse('click');
    assert.equal(callbacks.at(-1).column, restyled);
    await draw({ viewportColumns: columns, rangeStartIdx: 0, rangeEndIdx: 1 });
    assert.equal(cell().style.fontSize, '');
    assert.equal(cell().style.textAlign, '');
    for (const node of [cell(), cell(1)]) {
      assert.equal(node.getAttribute('aria-selected'), 'true');
      assert.equal(node.style.outline, outline(1));
      assert.equal(node.style.backgroundColor, '#ffffff', 'range keeps the canonical background');
    }
    await draw({ rangeStartIdx: undefined, rangeEndIdx: undefined, isHovered: true });
    assert.equal(cell().style.outline, '');
    assert.equal(cell().style.backgroundColor, '#abcdef');
    await draw({ isHovered: false, isRowSelected: true });
    assert.equal(cell().style.backgroundColor, '#123456');
    await draw({ isRowSelected: false, draggedOverCellIdx: 0 });
    assert(cell().classList.contains('rdg-cell-dragged-over'));
    assert(!cell(1).classList.contains('rdg-cell-dragged-over'));
    await draw({ draggedOverCellIdx: undefined, getCellBackgroundColor: () => '#fedcba' });
    assert(!cell().classList.contains('rdg-cell-dragged-over'));
    assert.equal(cell().style.backgroundColor, '#fedcba');
    const replacementRow = { ...originalRow, uuid: 'record-replacement', amount: '42' };
    await draw({ row: replacementRow, rowIdx: 9, getCellBackgroundColor: getBackground });
    assert.equal(cell().getAttribute('data-row-index'), '9');
    assert.equal(backgroundCalls.at(-1).isEvenRow, false);
    await mouse('mousedown', {}, cell(1));
    assert.equal(callbacks.at(-1).row.uuid, 'record-replacement');
    assert.equal(callbacks.at(-1).host, originalBonusHost);
    assertSelection({ rowIdx: 9, idx: 1 }, { enableEditor: false, isShiftPressed: false });
    const replacementSelections = [];
    const replacementTooltip = makeTooltip('replacement');
    await draw({ sharedTooltip: replacementTooltip,
      selectCell: (...args) => replacementSelections.push(args) });
    await mouse('mousedown');
    assert.deepEqual(replacementSelections.at(-1), [{ rowIdx: 9, idx: 0 }, { enableEditor: false, isShiftPressed: false }]);
    await mouse('mouseover');
    await mouse('mouseout', { relatedTarget: document.body });
    await mouse('click');
    await React.act(async () => { cell().blur(); cell().focus(); cell().blur(); });
    for (const type of ['onMouseEnter', 'onMouseLeave', 'onClick', 'onFocus', 'onBlur']) {
      assert(tooltipEvents.some(event => event.name === 'replacement' && event.type === type && event.host === originalHost), type);
    }

    // A custom grid renderer, ordinary column, spanning cell, missing shared
    // controller and editor retain the generic route and renderer contracts.
    let customCalls = 0;
    await draw({}, { renderCell: (key, value) => { customCalls++; return defaultRenderCell(key, value); } });
    assert.equal(customCalls, 2);
    assert.equal(genericCalls.length, 2, 'a custom renderer is not bypassed');
    await draw({ viewportColumns: [{ ...amount, renderTextCell: undefined }, bonus] });
    assert.equal(genericCalls.at(-1), 'amount');
    await draw({ viewportColumns: [{ ...amount, colSpan: 2 }, bonus] });
    assert.equal(host.querySelectorAll('[role="gridcell"]').length, 1);
    assert.equal(cell().getAttribute('aria-colspan'), '2');
    const beforeStandalone = genericCalls.length;
    await draw({ viewportColumns: columns, sharedTooltip: undefined });
    assert.equal(genericCalls.length, beforeStandalone + 2);
    await draw({ sharedTooltip: tooltip, selectedCellIdx: 0,
      selectedCellEditor: React.createElement('input', { key: 'amount', 'data-editor': '' }) });
    assert(host.querySelector('[data-editor]'));
    assert.equal(cell(), null);
    await draw({ selectedCellIdx: undefined, selectedCellEditor: undefined });
    assert.equal(cell().textContent, replacementRow.amount);

    // Suspense renders Row first, then interrupts the same tree. Its speculative
    // text must never replace the committed cache or latest event callback.
    props = { ...initialProps, className: 'committed-before-interruption' };
    await draw();
    const committedHost = cell();
    const committedCount = countText(originalRow.uuid);
    const speculativeRow = { ...originalRow, uuid: 'record-speculative', amount: '999' };
    await React.act(async () => {
      React.startTransition(() => mounted.render(tree({ ...props, row: speculativeRow }, defaultRenderers, true)));
    });
    assert(pendingAttempts > 0, 'the transition reached the suspending sibling');
    assert(countText(speculativeRow.uuid) > 0, 'the speculative Row really rendered');
    assert.equal(host.querySelector('[data-suspended]'), null, 'transition preserves the committed view');
    assert.equal(cell(), committedHost);
    assert.equal(cell().textContent, originalRow.amount);
    await mouse('click');
    assert.equal(callbacks.at(-1).row, originalRow, 'suspended render cannot publish event closures');
    assert.equal(callbacks.at(-1).host, committedHost);
    await draw({ className: 'committed-after-interruption' });
    assert.equal(countText(originalRow.uuid), committedCount,
      'aborted render must not evict committed entries and force recomputation');
    assert.equal(cell(), committedHost);

    // The cache comparator must include every own prop, not a value/selection
    // whitelist, and retain Object.is semantics for present/absent keys.
    const comparison = { row: originalRow, column: amount, rowIdx: 4, sharedTooltip: tooltip,
      isCellSelected: false, isRowSelected: false, isHovered: false, isInRange: false,
      isDraggedOver: false, transientLock: false, colSpan: undefined, tooltipUsesCellHost: false,
      getCellBackgroundColor: getBackground, selectCell, onRowChange: noop,
      onCellMouseDown: recordCallback, onCellClick: recordCallback,
      onCellDoubleClick: recordCallback, onCellContextMenu: recordCallback };
    assert(shallowEqualCellProps(comparison, { ...comparison }));
    for (const key of Object.keys(comparison)) {
      assert.equal(shallowEqualCellProps(comparison, { ...comparison, [key]: Symbol(key) }), false, key);
    }
    assert.equal(shallowEqualCellProps({ value: undefined }, {}), false);
    assert.equal(shallowEqualCellProps({ value: NaN }, { value: NaN }), true);
    assert.equal(shallowEqualCellProps({ value: 0 }, { value: -0 }), false);
    console.log('PASS numeric Row host: stable selected DOM and overlap-scroll cache reuse; UUID/currentTarget and prevented/right/double-click events; lock, styles, diagnostics, tooltip/range/cache invalidation; generic fallbacks; interrupted Suspense cache isolation');
  } finally {
    await React.act(async () => mounted.unmount());
    host.remove();
    await window.happyDOM.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
