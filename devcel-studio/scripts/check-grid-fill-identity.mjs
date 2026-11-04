// Executable library-boundary integration check: real DataGrid events and the
// production transpose helpers, with an explicit fixture onFill consumer.
// Studio does not connect onFill. Synthetic DOM geometry/pointer capture and
// Linaria CSS extraction make this neither Studio fill QA nor native UI QA.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.grid-fill-check-'));
const window = new Window({ url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDivElement', 'Element', 'Node',
  'Event', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'KeyboardEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : window[key] });
}
for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener']) {
  globalThis[key] = window[key].bind(window);
}
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
Object.defineProperties(window.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 900 }, clientHeight: { configurable: true, get: () => 600 },
  offsetWidth: { configurable: true, get: () => 900 }, offsetHeight: { configurable: true, get: () => 600 },
  clientTop: { configurable: true, get: () => 0 }
});
window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 900, 600);
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
try {
  const result = await build({ absWorkingDir: project, stdin: {
    contents: `export { DataGrid } from './src/lib/react-data-grid/DataGrid';
      export { createTransposedRows, createTransposedColumns, resolveGridViewCell, createTransposedWidthResolver }
        from './src/app/pages/main_window/project_view/table_view/components/gridTransposeView';`,
    resolveDir: project, loader: 'tsx'
  }, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    alias: { '@': resolve(project, 'src') }, plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'linaria', namespace: 'boundary' }));
      builder.onResolve({ filter: /^@\/app\/i18n$/ }, () => ({ path: 'i18n', namespace: 'boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ loader: 'js', contents: args.path === 'linaria'
        ? `let next=0;export const css=()=> 'test-style-'+next++;`
        : `export const t=key=>key;export const useI18n=()=>({t,locale:'ja'});export const formatNumber=String;export const localizeError=String;export const message=(key,values)=>({key,values});export const localizedError=descriptor=>Object.assign(new Error(descriptor.key),descriptor);` }));
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'css' }));
      builder.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ loader: 'js', contents: '' }));
    }}]
  });
  const modulePath = resolve(temporary, 'fixture.mjs');
  await writeFile(modulePath, result.outputFiles[0].text);
  const { DataGrid, createTransposedRows, createTransposedColumns, resolveGridViewCell, createTransposedWidthResolver } = await import(pathToFileURL(modulePath));
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const mount = document.createElement('section'); document.body.append(mount); root = createRoot(mount);
  const gridRef = React.createRef();
  const fieldKeys = ['field-first', 'field-second', 'field-third'];
  const makeRows = () => ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({
    rowId: `record-${id}`, rowLabel: id, height: 20 + index * 10,
    ...Object.fromEntries(fieldKeys.map(key => [key, `${id}:${key}`]))
  }));
  const Editor = () => React.createElement('input');
  const rowKeyGetter = row => row.rowId;
  let canonicalRows, sourceColumns, rows, columns, instance = 0, transposed, locked, height;
  let afterWrite, unchangedKey;
  const fills = [], writes = [];
  const maps = () => ({ rows: new Map(canonicalRows.map(row => [row.rowId, row])),
    columns: new Map(sourceColumns.map(column => [column.key, column])) });
  const projectionColumns = records => createTransposedColumns({ sourceRows: records, sourceColumns,
    getWidth: () => 150, renderHeader: record => record.rowLabel });
  const manyRecords = Array.from({ length: 10000 }, (_, i) => ({ rowId: `scale-${i}`, rowLabel: `Record ${i}`, rowIndex: i }));
  let widthCalls = 0;
  const previousContext = window.HTMLCanvasElement.prototype.getContext;
  window.HTMLCanvasElement.prototype.getContext = () => ({ font: '', measureText: text => { widthCalls++; return { width: text.length * 7 }; } });
  const scaled = createTransposedColumns({ sourceRows: manyRecords, sourceColumns: [],
    getWidth: createTransposedWidthResolver({ 'scale-0': 119 }, {}),
    renderHeader: record => record.rowLabel });
  assert.equal(widthCalls, 9999); assert.equal(scaled.length, 10000); assert.equal(scaled[0].width, 119);
  assert.equal(scaled[9999].width, Math.max(190, '10000: Record 9999'.length * 7 + 48));
  window.HTMLCanvasElement.prototype.getContext = previousContext;
  const onFill = ({ columnKey, sourceRow, targetRow }) => {
    fills.push({ columnKey, sourceRow, targetRow });
    if (targetRow.rowId === unchangedKey) return targetRow;
    const lookup = maps();
    const source = resolveGridViewCell(sourceRow, columnKey, transposed, lookup.rows, lookup.columns);
    assert(source, 'fill source resolves to an existing canonical record and field');
    return { ...targetRow, [columnKey]: source.row[source.column.key] };
  };
  const onRowsChange = (updated, data) => {
    writes.push({ updated, indexes: data.indexes, columnKey: data.column.key });
    const byId = new Map(canonicalRows.map(row => [row.rowId, row]));
    for (const index of data.indexes) {
      const row = updated[index];
      if (transposed) {
        const canonical = byId.get(data.column.key);
        byId.set(data.column.key, { ...canonical, [row.rowId]: row[data.column.key] });
      } else {
        byId.set(row.rowId, row);
      }
    }
    canonicalRows = canonicalRows.map(row => byId.get(row.rowId));
    rows = updated;
    if (afterWrite) afterWrite();
    renderNow();
  };
  const renderNow = () => root.render(React.createElement(React.StrictMode, null, React.createElement(DataGrid, {
    key: instance, ref: gridRef, rows, columns, rowKeyGetter, transientLock: locked,
    rowHeight: height, headerRowHeight: 35, enableVirtualization: false,
    onFill, onRowsChange
  })));
  const render = async () => { await act(async () => renderNow()); };
  const reset = async () => {
    instance++; canonicalRows = makeRows(); transposed = false; locked = false; height = 35;
    afterWrite = undefined; unchangedKey = undefined;
    sourceColumns = fieldKeys.map(key => ({ key, name: key, width: 150, editable: true, renderEditCell: Editor }));
    rows = canonicalRows; columns = sourceColumns; fills.length = 0; writes.length = 0;
    await render();
  };
  const select = async (rowIdx, idx = 0) => { await act(async () => gridRef.current.selectCell({ rowIdx, idx })); };
  const handle = () => mount.querySelector('.rdg-cell-drag-handle');
  const selected = () => [...mount.querySelectorAll('[role="gridcell"][aria-selected="true"]')]
    .map(cell => ({ rowIdx: Number(cell.dataset.rowIndex), idx: Number(cell.dataset.columnIndex) }));
  const pointer = async (element, type, properties = {}) => {
    assert(element, `${type} requires a rendered fill handle`);
    await act(async () => element.dispatchEvent(new window.PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, bubbles: true, ...properties
    })));
  };
  const startDrag = async rowIdx => {
    await pointer(handle(), 'pointerdown');
    const getHeight = row => typeof height === 'number' ? height : height(row);
    const clientY = 35 + rows.slice(0, rowIdx).reduce((sum, row) => sum + getHeight(row), 0) + getHeight(rows[rowIdx]) / 2;
    await pointer(handle(), 'pointermove', { clientY });
  };
  const release = async (element = handle()) => pointer(element, 'lostpointercapture');
  const doubleClick = async () => {
    assert(handle(), 'double click requires a rendered fill handle');
    await act(async () => handle().dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
  };
  const fillTargets = () => fills.map(({ columnKey, sourceRow, targetRow }) => ({
    columnKey, source: sourceRow.rowId, target: targetRow.rowId
  }));
  const check = async (name, action) => { await reset(); await action(); console.log('PASS', name); };

  await check('standard double-click fills only later rows, with exact source/target objects and one change', async () => {
    const original = rows;
    await select(1, 1); await doubleClick();
    assert.deepEqual(fillTargets(), ['c', 'd', 'e'].map(id => ({ columnKey: 'field-second', source: 'record-b', target: `record-${id}` })));
    fills.forEach((event, i) => { assert.equal(event.sourceRow, original[1]); assert.equal(event.targetRow, original[i + 2]); });
    assert.equal(writes.length, 1); assert.deepEqual(writes[0].indexes, [2, 3, 4]);
    assert.equal(rows[0], original[0]); assert.equal(rows[1], original[1]);
    for (const row of rows.slice(2)) { assert.equal(row['field-second'], original[1]['field-second']); assert.equal(row['field-first'], original.find(item => item.rowId === row.rowId)['field-first']); }
  });
  await check('downward and upward pointer fills use measured variable row heights and exclude source', async () => {
    height = row => row.height; await render(); await select(1); await startDrag(3); await release();
    assert.deepEqual(fillTargets().map(event => event.target), ['record-c', 'record-d']);
    assert.deepEqual(writes[0].indexes, [2, 3]);
    fills.length = 0; writes.length = 0;
    await select(3, 1); await startDrag(1); await release();
    assert.deepEqual(fillTargets().map(event => event.target), ['record-b', 'record-c']);
    assert.deepEqual(writes[0].indexes, [1, 2]);
  });
  await check('readonly targets and unchanged callback results are omitted from the change indexes', async () => {
    sourceColumns = sourceColumns.map(column => ({ ...column, editable: row => row.rowId !== 'record-c' }));
    columns = sourceColumns; unchangedKey = 'record-d'; await render(); await select(1); await doubleClick();
    assert.deepEqual(fillTargets().map(event => event.target), ['record-d', 'record-e']);
    assert.equal(writes.length, 1); assert.deepEqual(writes[0].indexes, [4]);
    assert.equal(rows[2]['field-first'], 'c:field-first'); assert.equal(rows[3]['field-first'], 'd:field-first');
  });
  await check('filter/sort preserves selected row key and fills only the current visible projection', async () => {
    await select(1, 1);
    rows = [canonicalRows[4], canonicalRows[1], canonicalRows[3]]; await render();
    rows = [rows[1], rows[0], rows[2]]; columns = [sourceColumns[2], sourceColumns[0], sourceColumns[1]]; await render();
    assert.deepEqual(selected(), [{ rowIdx: 0, idx: 2 }]);
    await doubleClick();
    assert.deepEqual(fillTargets(), ['e', 'd'].map(id => ({ columnKey: 'field-second', source: 'record-b', target: `record-${id}` })));
    assert.deepEqual(writes[0].indexes, [1, 2]);
    for (const id of ['a', 'c']) assert.equal(canonicalRows.find(row => row.rowId === `record-${id}`)['field-second'], `${id}:field-second`);
  });
  await check('value-only snapshots retain the drag but fill from the latest source object', async () => {
    await select(0); await startDrag(2);
    canonicalRows = canonicalRows.map(row => ({ ...row, 'field-first': `fresh:${row.rowId}` })); rows = canonicalRows; await render();
    const currentSource = rows[0]; await release();
    assert.equal(fills.length, 2); assert(fills.every(event => event.sourceRow === currentSource));
    assert.equal(rows[1]['field-first'], 'fresh:record-a'); assert.equal(rows[2]['field-first'], 'fresh:record-a');
  });
  await check('row-order change cancels an in-flight fill even when the source index survives', async () => {
    await select(0); await startDrag(2);
    rows = [canonicalRows[0], canonicalRows[3], canonicalRows[2], canonicalRows[1], canonicalRows[4]]; await render();
    await release(); assert.equal(fills.length, 0); assert.equal(writes.length, 0);
    assert.deepEqual(selected(), [{ rowIdx: 0, idx: 0 }]);
  });
  await check('filtering the drag source removes its handle and cannot fill the next occupant', async () => {
    await select(1); await startDrag(3); const oldHandle = handle();
    rows = canonicalRows.filter(row => row.rowId !== 'record-b'); await render();
    assert.equal(handle(), null); assert.deepEqual(selected(), []);
    await release(oldHandle); assert.equal(fills.length, 0); assert.equal(writes.length, 0);
  });
  await check('column reordering cancels a pending fill and the next fill uses the same column key', async () => {
    await select(0, 1); await startDrag(2);
    columns = [sourceColumns[1], sourceColumns[0], sourceColumns[2]]; await render();
    await release(); assert.equal(fills.length, 0); assert.equal(writes.length, 0);
    assert.deepEqual(selected(), [{ rowIdx: 0, idx: 0 }]);
    await doubleClick(); assert(fills.every(event => event.columnKey === 'field-second'));
  });
  await check('transient lock cancels capture, unlock cannot replay it, and a new drag still fills', async () => {
    await select(0); await startDrag(2); const oldHandle = handle(); locked = true; await render();
    assert.equal(handle(), null); await release(oldHandle); assert.equal(fills.length, 0); assert.equal(writes.length, 0);
    locked = false; await render();
    await pointer(handle(), 'pointerdown'); await release();
    assert.equal(fills.length, 0, 'a fresh click after unlock cannot commit the interrupted drag targets');
    assert.equal(writes.length, 0);
    await startDrag(2); await release();
    assert.deepEqual(fillTargets().map(event => event.target), ['record-b', 'record-c']);
    assert.equal(writes.length, 1); assert.deepEqual(writes[0].indexes, [1, 2]);
  });
  await check('post-fill sort follows the source row key after exactly one change notification', async () => {
    await select(1, 1); afterWrite = () => { rows = [...rows].reverse(); };
    await doubleClick(); assert.equal(writes.length, 1); assert.equal(fills.length, 3);
    assert.deepEqual(selected(), [{ rowIdx: 3, idx: 1 }]);
    assert.equal(rows[3].rowId, 'record-b');
  });
  await check('transposed callback carries record column key and field row keys into canonical targets', async () => {
    transposed = true; rows = createTransposedRows(sourceColumns); columns = projectionColumns(canonicalRows); await render();
    await select(0, 1); await doubleClick();
    assert.deepEqual(fillTargets(), ['field-second', 'field-third'].map(target => ({ columnKey: 'record-b', source: 'field-first', target })));
    assert.deepEqual(writes[0].indexes, [1, 2]); assert.equal(writes[0].columnKey, 'record-b');
    assert.deepEqual(fieldKeys.map(key => canonicalRows[1][key]), Array(3).fill('b:field-first'));
    for (const row of canonicalRows.filter(row => row.rowId !== 'record-b')) {
      for (const key of fieldKeys) assert.equal(row[key], `${row.rowLabel}:${key}`);
    }
  });
  await check('filtered/sorted transposed columns retain record UUID while hidden fields remain untouched', async () => {
    transposed = true; rows = createTransposedRows(sourceColumns); columns = projectionColumns(canonicalRows); await render();
    await select(0, 1);
    rows = [rows[0], rows[2]]; columns = projectionColumns([canonicalRows[1], canonicalRows[4], canonicalRows[3]]); await render();
    assert.deepEqual(selected(), [{ rowIdx: 0, idx: 0 }]); await doubleClick();
    assert.deepEqual(fillTargets(), [{ columnKey: 'record-b', source: 'field-first', target: 'field-third' }]);
    assert.equal(canonicalRows[1]['field-third'], 'b:field-first');
    assert.equal(canonicalRows[1]['field-second'], 'b:field-second');
    assert.equal(canonicalRows[4]['field-third'], 'e:field-third');
  });
  await check('transposed record filtering cancels a captured drag and cannot write to replacement column', async () => {
    transposed = true; rows = createTransposedRows(sourceColumns); columns = projectionColumns(canonicalRows); await render();
    await select(0, 1); await startDrag(2); const oldHandle = handle();
    columns = projectionColumns(canonicalRows.filter(row => row.rowId !== 'record-b')); await render();
    assert.equal(handle(), null); assert.deepEqual(selected(), []);
    await release(oldHandle); assert.equal(fills.length, 0); assert.equal(writes.length, 0);
  });
  await check('last-row double-click and same-row drag are no-ops', async () => {
    await select(rows.length - 1); await doubleClick(); await startDrag(rows.length - 1); await release();
    assert.equal(fills.length, 0); assert.equal(writes.length, 0);
  });
  console.log('All 14 keyed grid fill library-boundary integration checks passed.');
} finally {
  if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
  await rm(temporary, { recursive: true, force: true }); await window.happyDOM.close();
}
