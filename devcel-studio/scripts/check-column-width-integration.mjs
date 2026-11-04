// Run from devcel-studio: node scripts/check-column-width-integration.mjs [report.json]
// Integration probe, not a browser layout test: the actual DataGrid, HeaderCell,
// useColumnWidths and useDataGridColumnWidth run unchanged. Only CSS extraction,
// DOM geometry, pointer capture and localStorage are replaced in this synthetic DOM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.column-width-integration-'));
const window = new Window({ url: 'http://column-width-integration.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver', 'CSS']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  globalThis[name] = window[name].bind(window);
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.ResizeObserver = globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const values = new Map();
const writes = [];
const storageKey = `devcel-datagrid-column-widths:${JSON.parse(readFileSync(resolve(project, 'src-tauri/tauri.conf.json'), 'utf8')).version}`;
const storage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { writes.push({ key, value }); values.set(key, value); }
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
const stored = () => JSON.parse(values.get(storageKey) || '{}');
const maxContentWidths = [328, 246];
let zoom = 1;
let maxContentMeasurements = 0;
let pointerCaptureCalls = 0;

// Supply an explicit layout oracle for happy-dom, which has no layout engine.
// Numeric widths are read from the real DataGrid's current inline grid tracks.
// Auto-fit measurements only become available when useColumnWidths actually
// changes a track to max-content; they are never injected into resize callbacks.
function trackWidth(element) {
  const grid = element.closest('.rdg');
  const index = Number(element.getAttribute('aria-colindex') || element.style.gridColumnStart) - 1;
  if (!grid || index < 0 || !Number.isInteger(index)) return undefined;
  const token = grid.style.gridTemplateColumns.split(/\s+/)[index];
  if (token === 'max-content') {
    if (element.hasAttribute('data-measuring-cell-key')) maxContentMeasurements++;
    return maxContentWidths[index];
  }
  const width = Number.parseFloat(token);
  assert(Number.isFinite(width), `unsupported synthetic grid track ${token}`);
  return width;
}
Object.defineProperties(window.HTMLElement.prototype, {
  offsetWidth: { configurable: true, get() { return trackWidth(this) ?? 800; } },
  clientWidth: { configurable: true, get() { return this.offsetWidth; } },
  offsetHeight: { configurable: true, get() { return this.classList.contains('rdg') ? 400 : 30; } },
  clientHeight: { configurable: true, get() { return this.offsetHeight; } }
});
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return new window.DOMRect(0, 0, this.offsetWidth * zoom, this.offsetHeight * zoom);
};
window.HTMLElement.prototype.setPointerCapture = () => { pointerCaptureCalls++; };

const reports = [];
const failures = [];
let root;
let act;
try {
  const bundled = await build({
    absWorkingDir: project,
    stdin: {
      contents: `export { DataGrid } from './src/lib/react-data-grid/DataGrid';\nexport { useDataGridColumnWidth } from './src/app/pages/main_window/project_view/table_view/components/useDataGridColumnWidth';`,
      resolveDir: project, loader: 'ts'
    },
    bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'static-css-for-dom-check', setup(builder) {
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'linaria', namespace: 'synthetic-css' }));
      builder.onLoad({ filter: /.*/, namespace: 'synthetic-css' }, () => ({ contents: `export const css = () => 'synthetic-css';` }));
    } }]
  });
  const modulePath = resolve(temporary, 'grid.mjs');
  await writeFile(modulePath, bundled.outputFiles[0].text);
  const { DataGrid, useDataGridColumnWidth } = await import(pathToFileURL(modulePath));
  const React = await import('react');
  ({ act } = React);
  const { createRoot } = await import('react-dom/client');
  const rows = [{ id: 'row-1', a: 'Alpha', b: 'Beta' }];
  const renderHeaderCell = ({ column }) => column.name;
  let api;
  let renders = 0;
  let resizeEnds = 0;
  let callbackWidths = [];
  function Harness({ table }) {
    renders++;
    api = useDataGridColumnWidth(table, 'integration-session');
    const columns = React.useMemo(() => [
      { key: 'a', name: 'Alpha', width: api.getColumnWidth('a', 120), minWidth: 40, maxWidth: 500, resizable: true, renderHeaderCell },
      { key: 'b', name: 'Beta', width: api.getColumnWidth('b', 180), minWidth: 40, maxWidth: 500, resizable: true, renderHeaderCell }
    ], [api.getColumnWidth]);
    return React.createElement(DataGrid, {
      columns, rows, rowKeyGetter: row => row.id, enableVirtualization: false,
      onColumnResize(column, width) {
        callbackWidths.push({ key: column.key, width });
        api.queueColumnWidth(column.key, width);
      },
      onColumnResizeEnd() { resizeEnds++; api.flushColumnWidths(); }
    });
  }
  const container = document.createElement('div');
  document.body.append(container);
  const grid = () => container.querySelector('.rdg');
  const header = (index = 0) => container.querySelectorAll('[role=columnheader]')[index];
  const handle = (index = 0, side = 'right') => header(index).querySelector(`.rdg-cell-resizer-${side}`);
  const width = (index = 0) => Number.parseFloat(grid().style.gridTemplateColumns.split(/\s+/)[index]);
  const pointer = (type, x, { index = 0, side = 'right', pointerId = 1 } = {}) => act(() => handle(index, side).dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, pointerId, pointerType: 'mouse', buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, clientX: x
  })));
  const key = (keyName, index = 0) => act(() => header(index).dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: keyName })));
  const autoFit = (index = 0) => act(() => handle(index).dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
  async function mount(table, scale = 1) {
    if (root) await act(() => root.unmount());
    zoom = scale;
    callbackWidths = [];
    root = createRoot(container);
    await act(() => root.render(React.createElement(Harness, { table })));
    assert.equal(container.querySelectorAll('[data-measuring-cell-key]').length, 2);
    assert.equal(container.querySelectorAll('[role=columnheader]').length, 2);
  }
  async function check(name, fn) {
    try { const result = await fn(); reports.push({ name, status: 'pass', ...result }); console.log(`PASS: ${name}`); }
    catch (error) { failures.push({ name, error: error.message, actual: error.actual, expected: error.expected }); console.error(`FAIL: ${name}: ${error.message}`); }
  }

  await check('pointermove updates the real grid, pointerup saves the last coordinate once', async () => {
    await mount('pointer');
    const startWrites = writes.length, startRenders = renders, startEnds = resizeEnds;
    await pointer('pointerdown', 100);
    for (let x = 101; x <= 200; x++) await pointer('pointermove', x);
    assert.equal(width(), 220);
    assert.equal(writes.length, startWrites, 'move writes no storage');
    assert.equal(renders, startRenders, 'move does not rerender the persistence owner');
    assert.equal(api.getColumnWidth('a', 120), 120, 'uncommitted width remains grid-local');
    assert.equal(callbackWidths.length, 100, 'all live moves traverse DataGrid onColumnResize');
    await pointer('pointerup', 215);
    assert.equal(width(), 235);
    assert.equal(stored().pointer.a, 235);
    assert.equal(api.getColumnWidth('a', 120), 235);
    assert.equal(writes.length, startWrites + 1);
    await pointer('lostpointercapture', 215);
    assert.equal(resizeEnds, startEnds + 1);
    assert.equal(writes.length, startWrites + 1);
    await mount('pointer');
    assert.equal(width(), 235, 'remount reuses persisted final width');
    return { moveCount: 100, finalLogicalWidth: 235, moveStorageWrites: 0, endStorageWrites: 1, moveOwnerRenders: 0 };
  });
  await check('keyboard resize traverses useColumnWidths and saves each completed step', async () => {
    await mount('keyboard');
    const before = writes.length;
    await key('ArrowRight');
    assert.equal(width(), 130);
    assert.equal(stored().keyboard.a, 130);
    await key('ArrowLeft');
    assert.equal(width(), 120);
    assert.equal(stored().keyboard.a, 120);
    assert.equal(writes.length, before + 2);
    assert.deepEqual(callbackWidths, [{ key: 'a', width: 130 }, { key: 'a', width: 120 }]);
    return { finalLogicalWidth: 120, writes: 2 };
  });
  await check('auto-fit measures max-content through the real useColumnWidths hook', async () => {
    await mount('auto-fit');
    const before = writes.length, measurements = maxContentMeasurements;
    await autoFit();
    assert(maxContentMeasurements > measurements, 'max-content DOM measurement occurred');
    assert.equal(width(), 328);
    assert.equal(stored()['auto-fit'].a, 328);
    assert.deepEqual(callbackWidths, [{ key: 'a', width: 328 }]);
    assert.equal(writes.length, before + 1);
    await autoFit();
    assert.equal(writes.length, before + 1, 'unchanged auto-fit does not save again');
    return { measuredLogicalWidth: 328, writes: 1 };
  });
  await check('70% zoom pointer end and auto-fit retain unscaled logical widths', async () => {
    await mount('zoom-pointer', 0.7);
    const before = writes.length;
    await pointer('pointerdown', 100);
    await pointer('pointermove', 128);
    assert.equal(width(), 160);
    assert.equal(writes.length, before);
    await pointer('pointerup', 149);
    assert.equal(width(), 190);
    assert.equal(stored()['zoom-pointer'].a, 190);
    assert.equal(writes.length, before + 1);
    await autoFit();
    assert.equal(width(), 328);
    assert.equal(stored()['zoom-pointer'].a, 328, 'auto-fit must not save 229.6 visual pixels');
    await mount('zoom-pointer', 0.7);
    assert.equal(width(), 328);
    assert.equal(header().getBoundingClientRect().width, 328 * 0.7);
    return { zoom: 0.7, pointerFinalLogicalWidth: 190, autoFitFinalLogicalWidth: 328, reloadLogicalWidth: 328 };
  });
  await check('200% zoom pointer resize, auto-fit and reload retain logical widths', async () => {
    await mount('zoom-200', 2);
    const before = writes.length;
    await pointer('pointerdown', 100);
    await pointer('pointermove', 180);
    assert.equal(width(), 160);
    await pointer('pointerup', 240);
    assert.equal(width(), 190);
    assert.equal(stored()['zoom-200'].a, 190);
    assert.equal(writes.length, before + 1);
    await autoFit();
    assert.equal(width(), 328);
    assert.equal(stored()['zoom-200'].a, 328, 'do not persist doubled visual pixels');
    await mount('zoom-200', 2);
    assert.equal(header().getBoundingClientRect().width, 656);
    await key('ArrowRight');
    assert.equal(width(), 338); assert.equal(stored()['zoom-200'].a, 338);
    return { zoom: 2, pointerFinalLogicalWidth: 190, autoFitLogicalWidth: 328, keyboardLogicalWidth: 338 };
  });
  await check('left handle uses the previous column current width', async () => {
    await mount('left-handle', 0.7);
    await pointer('pointerdown', 100, { index: 1, side: 'left' });
    await pointer('pointermove', 121, { index: 1, side: 'left' });
    await pointer('pointerup', 135, { index: 1, side: 'left' });
    assert.equal(width(), 170);
    assert.equal(width(1), 180);
    assert.deepEqual(stored()['left-handle'], { a: 170 });
    return { firstColumnWidth: 170, secondColumnWidth: 180, zoom: 0.7 };
  });
  await check('cancel and capture-loss save the last live width through DataGrid', async () => {
    await mount('cancel');
    const before = writes.length;
    await pointer('pointerdown', 100);
    await pointer('pointermove', 145);
    await pointer('pointercancel', 0);
    assert.equal(width(), 165);
    assert.equal(stored().cancel.a, 165);
    await pointer('pointerdown', 100);
    await pointer('pointermove', 125);
    await pointer('lostpointercapture', 0);
    assert.equal(width(), 190);
    assert.equal(stored().cancel.a, 190);
    assert.equal(writes.length, before + 2);
    return { cancelLogicalWidth: 165, captureLossLogicalWidth: 190, writes: 2 };
  });
  await check('unmount and pagehide flush the actual pending grid width', async () => {
    await mount('interrupted');
    const before = writes.length;
    await pointer('pointerdown', 100);
    await pointer('pointermove', 145);
    assert.equal(width(), 165);
    assert.equal(writes.length, before);
    await act(() => window.dispatchEvent(new window.Event('pagehide')));
    assert.equal(stored().interrupted.a, 165);
    assert.equal(writes.length, before + 1);
    await pointer('pointermove', 170);
    assert.equal(width(), 190);
    await mount('interrupted');
    assert.equal(stored().interrupted.a, 190);
    assert.equal(width(), 190);
    assert.equal(writes.length, before + 2);
    return { pagehideLogicalWidth: 165, unmountAndReloadLogicalWidth: 190, writes: 2 };
  });
  await check('70% zoom keyboard resize uses logical width', async () => {
    await mount('zoom-keyboard', 0.7);
    await key('ArrowRight');
    assert.equal(stored()['zoom-keyboard'].a, width(), 'completed keyboard width is actually persisted');
    assert.equal(width(), 130, 'Ctrl+Right should increase logical 120px by 10px at any zoom');
    assert.equal(stored()['zoom-keyboard'].a, 130);
    return { zoom: 0.7, finalLogicalWidth: 130 };
  });
  const result = {
    mode: 'Synthetic DOM integration using unmodified DataGrid, HeaderCell, useColumnWidths and persistence hook; no browser layout/paint/native pointer-capture guarantee',
    reports, failures, pointerCaptureCalls, maxContentMeasurements
  };
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  if (root && act) await act(() => root.unmount());
  await window.happyDOM.close();
  await rm(temporary, { recursive: true, force: true });
}
