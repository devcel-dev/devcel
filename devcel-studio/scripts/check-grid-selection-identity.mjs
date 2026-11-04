// Focused integration check for selection identity across visible table projections.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { gridSelectionSource } from './test-file-filters.cjs';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.grid-selection-check-'));
const window = new Window({ url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDivElement', 'Element', 'Node',
  'Event', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = key === 'window' ? window : ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key)
    ? window[key].bind(window) : window[key];
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
globalThis.addEventListener = window.addEventListener.bind(window);
globalThis.removeEventListener = window.removeEventListener.bind(window);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
Object.defineProperties(window.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 900 }, clientHeight: { configurable: true, get: () => 600 },
  offsetWidth: { configurable: true, get: () => 900 }, offsetHeight: { configurable: true, get: () => 600 }
});
window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 900, 600);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const trace = globalThis.__keySelectionCheck = { cell: [], range: [], writes: [], pastes: [], resolutions: 0, intervals: 0, parentSelection: null };
let root;
let instrumentationLoads = 0;
try {
  const result = await build({ absWorkingDir: project, stdin: {
    contents: `export { DataGrid } from './src/lib/react-data-grid/DataGrid'; export { TreeDataGrid } from './src/lib/react-data-grid/TreeDataGrid';`, resolveDir: project, loader: 'tsx'
  }, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    alias: { '@': resolve(project, 'src') }, plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onLoad({ filter: gridSelectionSource }, async args => { instrumentationLoads++; return { loader: 'tsx',
        contents: (await readFile(args.path, 'utf8'))
          .replace('  if (index < 0 || index >= previous.length) return -1;', '  globalThis.__keySelectionCheck.resolutions++; if (index < 0 || index >= previous.length) return -1;')
          .replace('  const oldMin = Math.min(previousStart, previousEnd)', '  globalThis.__keySelectionCheck.intervals++; const oldMin = Math.min(previousStart, previousEnd)') }; });
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'linaria', namespace: 'boundary' }));
      builder.onResolve({ filter: /^@\/app\/i18n$/ }, () => ({ path: 'i18n', namespace: 'boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ loader: 'js', contents: args.path === 'linaria'
        ? `let next=0;export const css=()=> 'test-style-'+next++;` : `export const t=key=>key;export const useI18n=()=>({t,locale:'ja'});export const formatNumber=String;export const localizeError=String;export const message=(key,values)=>({key,values});export const localizedError=descriptor=>Object.assign(new Error(descriptor.key),descriptor);` }));
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'css' }));
      builder.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ loader: 'js', contents: '' }));
    }}]
  });
  assert.equal(instrumentationLoads, 1, 'selection counters must instrument the actual DataGrid source');
  const modulePath = resolve(temporary, 'fixture.mjs');
  await writeFile(modulePath, result.outputFiles[0].text);
  const { DataGrid, TreeDataGrid } = await import(pathToFileURL(modulePath));
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const mount = document.createElement('section'); document.body.append(mount); root = createRoot(mount);
  const gridRef = React.createRef();
  const baseRows = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({ id, first: index, second: index * 10, third: index * 100 }));
  const Editor = ({ row, column, onRowChange }) => React.createElement('input', { 'data-test-editor': '', defaultValue: row[column.key],
    onKeyDown: event => { if (event.key === 'Enter') { event.stopPropagation(); onRowChange({ ...row, [column.key]: Number(event.currentTarget.value) }, true); } } });
  const baseColumns = ['first', 'second', 'third'].map(key => ({ key, name: key, width: 150, editable: true, renderEditCell: Editor }));
  const rowKeyGetter = row => row.id;
  let rows = baseRows, columns = baseColumns, locked = false, sortAfterWrite = false, instance = 0;
  const renderNow = () => root.render(React.createElement(React.StrictMode, null, React.createElement(DataGrid, {
    key: instance, ref: gridRef, rows, columns, rowKeyGetter, transientLock: locked,
    enableRangeSelection: true, enableVirtualization: false,
    onSelectedCellChange: args => { trace.cell.push({ rowIdx: args.rowIdx, id: args.row?.id, key: args.column?.key });
      trace.parentSelection = args.row ? { start: { rowIdx: args.rowIdx, idx: args.column.idx }, end: { rowIdx: args.rowIdx, idx: args.column.idx } } : null; },
    onSelectedRangeChange: range => { trace.range.push(range); trace.parentSelection = range; },
    onCellPaste: ({ row, column }) => ({ ...row, [column.key]: 'pasted' }),
    onRangePaste: args => { trace.pastes.push({ ids: args.rows.map(row => row.id), keys: args.columns.map(column => column.key) }); },
    onRowsChange: (updated, data) => { trace.writes.push({ id: updated[data.indexes[0]].id, column: data.column.key });
      rows = sortAfterWrite ? updated.toSorted((a, b) => b.first - a.first) : updated; renderNow(); }
  })));
  const render = async () => { await act(async () => renderNow()); };
  const reset = async () => { instance++; rows = baseRows; columns = baseColumns; locked = false; sortAfterWrite = false;
    trace.cell.length = 0; trace.range.length = 0; trace.writes.length = 0; trace.pastes.length = 0; trace.parentSelection = null; await render(); };
  const select = async (rowIdx, idx = 0, options) => { await act(async () => gridRef.current.selectCell({ rowIdx, idx }, options)); };
  const selected = () => [...mount.querySelectorAll('[role="gridcell"][aria-selected="true"]')].map(cell => ({
    rowIdx: Number(cell.dataset.rowIndex), idx: Number(cell.dataset.columnIndex)
  }));
  const paste = async () => { const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'pasted' } });
    await act(async () => mount.querySelector('[role="grid"]').dispatchEvent(event)); };
  const point = (rowIdx, idx = 0) => ({ rowIdx, idx });
  const range = (start, end) => ({ start, end });
  const check = async (name, action) => { await reset(); await action(); console.log('PASS', name); };

  await check('single cell follows its row UUID and column key, with fresh parent coordinates', async () => {
    await select(1, 1); rows = [baseRows[4], baseRows[0], baseRows[2], baseRows[3], baseRows[1]]; await render();
    assert.deepEqual(selected(), [point(4, 1)]); assert.deepEqual(trace.cell.at(-1), { rowIdx: 4, id: 'b', key: 'second' });
    columns = [baseColumns[2], baseColumns[0], baseColumns[1]]; await render();
    assert.deepEqual(selected(), [point(4, 2)]); assert.deepEqual(trace.parentSelection, range(point(4, 2), point(4, 2)));
  });
  await check('hidden active record clears grid and parent selection, and cannot accept an edit', async () => {
    await select(1); rows = baseRows.filter(row => row.id !== 'b'); await render();
    assert.deepEqual(selected(), []); assert.equal(trace.cell.at(-1).rowIdx, -1); assert.equal(trace.parentSelection, null);
    await act(async () => mount.querySelector('[role="grid"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x', bubbles: true })));
    assert.equal(mount.querySelector('[data-test-editor]'), null); assert.equal(trace.writes.length, 0);
  });
  await check('hidden active column in transposed projection clears identity and parent', async () => {
    await select(1, 1); columns = [baseColumns[0], baseColumns[2]]; await render();
    assert.deepEqual(selected(), []); assert.equal(trace.parentSelection, null);
  });
  await check('contiguous rectangle follows movement and reversed endpoints', async () => {
    await select(1, 0); await select(2, 1, { isShiftPressed: true });
    rows = [baseRows[4], baseRows[0], baseRows[2], baseRows[1], baseRows[3]]; await render();
    assert.deepEqual(trace.range.at(-1), range(point(3, 0), point(2, 1)));
    assert.deepEqual(trace.parentSelection, range(point(3, 0), point(2, 1)));
    columns = [baseColumns[1], baseColumns[0], baseColumns[2]]; await render();
    assert.deepEqual(trace.parentSelection, range(point(3, 1), point(2, 0)));
    await paste(); assert.deepEqual(trace.pastes.at(-1), { ids: ['c', 'b'], keys: ['second', 'first'] });
  });
  await check('noncontiguous rectangle shrinks to its visible active cell without including a new record', async () => {
    await select(0); await select(2, 1, { isShiftPressed: true });
    rows = [baseRows[0], baseRows[3], baseRows[1], baseRows[2], baseRows[4]]; await render();
    assert.equal(trace.range.at(-1), null); assert.deepEqual(selected(), [point(3, 1)]);
    assert.deepEqual(trace.parentSelection, range(point(3, 1), point(3, 1)));
    await paste(); assert.deepEqual(trace.writes, [{ id: 'c', column: 'second' }]);
  });
  await check('filtering an interior range member is safe even when its endpoints survive', async () => {
    await select(0); await select(2, 1, { isShiftPressed: true });
    rows = baseRows.filter(row => row.id !== 'b'); await render();
    assert.equal(trace.range.at(-1), null); assert.deepEqual(trace.parentSelection, range(point(1, 1), point(1, 1)));
  });
  await check('unchanged endpoints cannot hide an interior member replacement', async () => {
    await select(0); await select(2, 1, { isShiftPressed: true });
    rows = [baseRows[0], baseRows[3], baseRows[2], baseRows[1], baseRows[4]]; await render();
    assert.equal(trace.range.at(-1), null); assert.deepEqual(trace.parentSelection, range(point(2, 1), point(2, 1)));
  });
  await check('filtering the active range endpoint clears both selection states', async () => {
    await select(0); await select(2, 1, { isShiftPressed: true });
    rows = baseRows.filter(row => row.id !== 'c'); await render();
    assert.equal(trace.range.at(-1), null); assert.deepEqual(selected(), []); assert.equal(trace.parentSelection, null);
    await paste(); assert.equal(trace.writes.length, 0); assert.equal(trace.pastes.length, 0);
  });
  await check('pointer range anchors cannot outlive a row-order change', async () => {
    await select(0);
    const cell = (rowIdx, idx) => mount.querySelector(`[data-row-index="${rowIdx}"][data-column-index="${idx}"]`);
    await act(async () => cell(0, 0).dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, buttons: 1, bubbles: true })));
    rows = [baseRows[4], ...baseRows.slice(0, 4)]; await render(); const notifications = trace.range.length;
    await act(async () => cell(2, 1).dispatchEvent(new window.PointerEvent('pointermove', { buttons: 1, bubbles: true })));
    assert.equal(trace.range.length, notifications); assert.deepEqual(selected(), [point(1)]);
  });
  await check('column-range interleaving does not silently select an unselected column', async () => {
    await select(0, 0); await select(1, 1, { isShiftPressed: true });
    columns = [baseColumns[0], baseColumns[2], baseColumns[1]]; await render();
    assert.equal(trace.range.at(-1), null); assert.deepEqual(trace.parentSelection, range(point(1, 2), point(1, 2)));
  });
  await check('value-only immutable snapshots do not resolve keys or rescan selected ranges', async () => {
    await select(0); await select(4, 2, { isShiftPressed: true });
    trace.resolutions = 0; trace.intervals = 0; const notifications = trace.cell.length;
    rows = baseRows.map(row => ({ ...row, first: row.first + 100 })); columns = baseColumns.map(column => ({ ...column })); await render();
    assert.equal(trace.resolutions, 0); assert.equal(trace.intervals, 0); assert.equal(trace.cell.length, notifications);
    assert.deepEqual(trace.parentSelection, range(point(0), point(4, 2)));
  });
  await check('snapshot reordering cancels stale editors rather than writing to the new occupant', async () => {
    await select(1, 0, { enableEditor: true }); assert(mount.querySelector('[data-test-editor]'));
    rows = [baseRows[1], baseRows[0], ...baseRows.slice(2)]; await render();
    assert.equal(mount.querySelector('[data-test-editor]'), null); assert.deepEqual(selected(), [point(0)]); assert.equal(trace.writes.length, 0);
  });
  await check('transient mutation lock closes editor and retains selection through sorting', async () => {
    await select(1, 0, { enableEditor: true }); locked = true; await render();
    assert.equal(mount.querySelector('[data-test-editor]'), null);
    rows = [baseRows[1], baseRows[0], ...baseRows.slice(2)]; await render(); locked = false; await render();
    assert.deepEqual(selected(), [point(0)]); assert.equal(trace.writes.length, 0);
  });
  await check('committed edit follows its UUID after immediate sort, exactly one write', async () => {
    await select(1, 0, { enableEditor: true }); sortAfterWrite = true;
    const input = mount.querySelector('[data-test-editor]'); input.value = '100';
    await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.deepEqual(trace.writes, [{ id: 'b', column: 'first' }]); assert.equal(rows[0].id, 'b');
    assert.equal(mount.querySelector('[data-test-editor]'), null); assert.deepEqual(selected(), [point(0)]);
    assert.equal(trace.cell.at(-1).id, 'b');
  });
  await check('every generic grid preserves identity without an opt-in', async () => {
    await select(1);
    rows = [baseRows[1], baseRows[0], ...baseRows.slice(2)]; await render(); assert.deepEqual(selected(), [point(0)]);
  });
  await check('internal owners reveal logical cells without DOM scrolling or observers', async () => {
    const scrolls = [];
    const originalScroll = window.HTMLElement.prototype.scrollTo;
    const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = () => { throw Error('DOM scrolling must not be used'); };
    window.HTMLElement.prototype.scrollTo = function ({ left, top }) {
      this.scrollLeft = left; this.scrollTop = Math.max(0, top); scrolls.push({ owner: this, left: this.scrollLeft, top: this.scrollTop });
    };
    try {
      rows = Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}` }));
      columns = Array.from({ length: 12 }, (_, i) => ({ key: `column-${i}`, name: `Column ${i}`, width: 150 }));
      await render();
      await act(async () => gridRef.current.scrollToCell({ rowIdx: 39, idx: 11 }));
      assert.equal(scrolls.at(-1).owner, gridRef.current.element);
      assert.deepEqual({ left: scrolls.at(-1).left, top: scrolls.at(-1).top }, { left: 900, top: 835 });
      await act(async () => gridRef.current.scrollToCell({ rowIdx: 2 }));
      assert.deepEqual({ left: scrolls.at(-1).left, top: scrolls.at(-1).top }, { left: 900, top: 70 });
      await select(39, 11, { shouldFocusCell: true });
      assert.deepEqual({ left: scrolls.at(-1).left, top: scrolls.at(-1).top }, { left: 900, top: 835 });
    } finally {
      window.HTMLElement.prototype.scrollTo = originalScroll;
      window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
  await check('tree group and record keys cannot collide, and public row selection retains raw keys', async () => {
    const records = [{ id: 'same', group: 'same', value: 'first' }, { id: 'other', group: 'same', value: 'second' }];
    let treeRows = records, rawSelection = new Set(['same']);
    const treeColumns = [{ key: 'group', name: 'Group', width: 150 }, { key: 'value', name: 'Value', width: 150 }];
    const groupBy = ['group'], expandedGroupIds = new Set(['same']);
    const rowGrouper = input => ({ same: input });
    // Preserve the mounted tree while its visible projection changes.
    const treeInstance = ++instance;
    const renderTree = () => root.render(React.createElement(TreeDataGrid, {
      key: treeInstance, ref: gridRef, rows: treeRows, columns: treeColumns, rowKeyGetter,
      groupBy, rowGrouper, expandedGroupIds, onExpandedGroupIdsChange() {},
      selectedRows: rawSelection, onSelectedRowsChange: value => { rawSelection = value; },
      enableVirtualization: false
    }));
    await act(async () => renderTree());
    await select(1, 1);
    treeRows = [records[1], records[0]];
    await act(async () => renderTree());
    assert.deepEqual(selected(), [point(2, 1)], 'record selection follows its key rather than the same-named group');
    const groupRow = mount.querySelector('[role="row"][data-row-index="0"]');
    assert.equal(groupRow.getAttribute('aria-selected'), 'false');
    for (const prop of ['sharedTooltip', 'transientLock', 'onRowContextMenu', 'physicalRowTop',
      'physicalRowHeight', 'physicalBodyWindow', 'physicalBodyFallback']) {
      assert(!groupRow.hasAttribute(prop.toLowerCase()), `${prop} remains a component prop, not a DOM attribute`);
    }
    assert.equal(mount.querySelector('[role="row"][data-row-index="2"]').getAttribute('aria-selected'), 'true');
    const cell = mount.querySelector('[role="gridcell"][data-row-index="2"][data-column-index="1"]');
    await act(async () => cell.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true })));
    assert.deepEqual([...rawSelection], [], 'row toggle returns the original record key domain');
  });
  console.log('All keyed grid selection integration checks passed.');
} finally {
  if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
  await rm(temporary, { recursive: true, force: true }); await window.happyDOM.close();
}
