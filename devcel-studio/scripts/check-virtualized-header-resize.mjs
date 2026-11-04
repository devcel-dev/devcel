// Real DataGrid/HeaderRow/HeaderCell regression with synthetic DOM geometry.
// Exercises sidebar-sized viewports, sparse global indexes and resize targets.
// This is not a native WebKit layout or ColumnEditor IPC test.
import assert from 'node:assert/strict';
import { installPhysicalGridGeometry } from './physical-grid-geometry.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.virtualized-header-check-'));
const window = new Window({ url: 'http://virtualized-header.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver', 'CSS']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let viewportWidth = 3000;
const observers = new Set();
window.ResizeObserver = globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; this.elements = new Set(); }
  observe(element) { this.elements.add(element); observers.add(this); }
  unobserve(element) { this.elements.delete(element); if (!this.elements.size) observers.delete(this); }
  disconnect() { this.elements.clear(); observers.delete(this); }
};
function trackWidth(element) {
  const grid = element.closest('.rdg');
  const index = Number(element.getAttribute('aria-colindex') || element.style.gridColumnStart) - 1;
  if (!grid || index < 0) return undefined;
  const token = grid.style.gridTemplateColumns.split(/\s+/)[index];
  return token === 'max-content' ? 246 : Number.parseFloat(token);
}
Object.defineProperties(window.HTMLElement.prototype, {
  offsetWidth: { configurable: true, get() { return trackWidth(this) ?? viewportWidth; } },
  clientWidth: { configurable: true, get() { return this.offsetWidth; } },
  offsetHeight: { configurable: true, get() { return this.classList.contains('rdg') ? 400 : 30; } },
  clientHeight: { configurable: true, get() { return this.offsetHeight; } }
});
window.HTMLElement.prototype.getBoundingClientRect = function () { return new window.DOMRect(0, 0, this.offsetWidth, this.offsetHeight); };
window.HTMLElement.prototype.setPointerCapture = () => {};
let root;
let act;
try {
  const bundled = await build({
    absWorkingDir: project,
    stdin: { contents: `
      export { DataGrid } from './src/lib/react-data-grid/DataGrid';
      import { createElement, useLayoutEffect, useRef } from 'react';
      import { usePhysicalViewport } from './src/lib/react-data-grid/DataGridViewportContext';
      // Per-column renderers retain the real stationary layout and focus context.
      export function PendingViewportCell() {
        const viewport = usePhysicalViewport(), ref = useRef(null);
        useLayoutEffect(() => { globalThis.__pendingViewportProbe?.(viewport, ref.current); });
        return createElement('span', { ref, tabIndex: -1 }, 'probe');
      }`, resolveDir: project, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' }, alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'static-css', setup(builder) {
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'linaria', namespace: 'synthetic-css' }));
      builder.onLoad({ filter: /.*/, namespace: 'synthetic-css' }, () => ({ contents: `export const css = () => 'synthetic-css';` }));
    } }]
  });
  const modulePath = resolve(temporary, 'grid.mjs');
  await writeFile(modulePath, bundled.outputFiles[0].text);
  const { DataGrid, PendingViewportCell } = await import(pathToFileURL(modulePath));
  const React = await import('react');
  ({ act } = React);
  const { createRoot } = await import('react-dom/client');
  const resizeCalls = [];
  let resizeEnds = 0;
  let openedColumn;
  const columns = Array.from({ length: 18 }, (_, i) => ({
    key: `column-${i}`, name: i === 8 ? 'material' : `column ${i}`, width: 120,
    minWidth: 40, maxWidth: 500, resizable: true, frozen: i === 0,
    renderHeaderCell: ({ column }) => column.name,
    onHeaderDoubleClick: () => { openedColumn = i; }
  }));
  const rows = [{ id: 'row-1' }];
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = props => act(() => root.render(React.createElement(DataGrid, {
    columns, rows, rowKeyGetter: row => row.id, enableVirtualization: true,
    onColumnResize(column, width) { resizeCalls.push({ key: column.key, width }); },
    onColumnResizeEnd() { resizeEnds++; }, ...props
  })));
  const grid = () => container.querySelector('.rdg');
  const header = index => container.querySelector(`[role=columnheader][aria-colindex="${index + 1}"]`);
  const resizeViewport = async width => {
    viewportWidth = width;
    await act(() => { for (const observer of [...observers]) observer.callback([{ contentBoxSize: [{ inlineSize: width, blockSize: 400 }] }]); });
  };
  const scroll = async left => { await act(() => { grid().scrollLeft = left; grid().dispatchEvent(new window.Event('scroll', { bubbles: true })); }); };
  const pointer = async (index, side, type, x) => act(() => header(index).querySelector(`.rdg-cell-resizer-${side}`).dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: type === 'pointerup' ? 0 : 1, clientX: x
  })));

  await render();
  assert.equal(container.querySelectorAll('[role=columnheader]').length, 18);
  await act(() => header(8).dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
  assert.equal(openedColumn, 8, 'material header still invokes the editor opener');
  await resizeViewport(480);
  await scroll(840);
  assert(header(8), 'material remains rendered in the horizontally scrolled viewport');
  assert(header(0), 'frozen column remains rendered');
  assert.equal(header(2), null, 'the column list is actually virtualized and sparse');
  console.log('PASS: header open followed by narrow, horizontally scrolled viewport does not crash');

  await pointer(8, 'left', 'pointerdown', 100);
  await pointer(8, 'left', 'pointerup', 135);
  assert.deepEqual(resizeCalls.at(-1), { key: 'column-7', width: 155 }, 'left handle resolves the global predecessor, not viewport array position');
  assert.equal(resizeEnds, 1);
  await pointer(8, 'right', 'pointerdown', 100);
  await pointer(8, 'right', 'pointerup', 145);
  assert.deepEqual(resizeCalls.at(-1), { key: 'column-8', width: 165 });
  assert.equal(resizeEnds, 2);
  console.log('PASS: left/right resize callbacks identify the intended global column');

  const firstUnfrozen = [...container.querySelectorAll('[role=columnheader]')].map(cell => Number(cell.getAttribute('aria-colindex')) - 1).find(index => index > 0);
  assert(firstUnfrozen > 1);
  assert.equal(header(firstUnfrozen - 1), null, 'previous column is outside viewport');
  await pointer(firstUnfrozen, 'left', 'pointerdown', 100);
  await pointer(firstUnfrozen, 'left', 'pointerup', 125);
  assert.deepEqual(resizeCalls.at(-1), { key: `column-${firstUnfrozen - 1}`, width: 145 });
  console.log('PASS: offscreen predecessor uses the full column list and current grid track');

  await resizeViewport(3000);
  await scroll(0);
  await resizeViewport(480);
  await scroll(1680);
  assert(header(17));
  await act(() => header(17).querySelector('.rdg-cell-resizer-left').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
  assert.deepEqual(resizeCalls.at(-1), { key: 'column-16', width: 246 });
  console.log('PASS: repeated widen/narrow/end-of-table traversal and left auto-fit preserve identity');

  // Regression: equal row/column identities retain readiness; actual dimension
  // changes still gate focus without expanding compatible stationary paint.
  await act(() => root.unmount());
  root = undefined;
  installPhysicalGridGeometry(window, { width: 480, height: 400 });
  let owner = document.createElement('div');
  const extent = document.createElement('div');
  extent.className = 'rdg-physical-extent';
  owner.append(extent); document.body.append(owner);
  let ownerRef = { current: owner };
  const extentRef = { current: extent };
  let scale = 0.1, phase = 'mount', physicalRowHeight = 30;
  let originRectReads = 0;
  const readOriginRect = extent.getBoundingClientRect.bind(extent);
  extent.getBoundingClientRect = () => { originRectReads++; return readOriginRect(); };
  let physicalRows = [{ id: 'pending-row' }];
  let physicalColumns = Array.from({ length: 120 }, (_, i) => ({
    key: `pending-${i}`, name: String(i), width: 100, frozen: i === 0,
    tooltip: i % 2 ? 'header tooltip' : undefined, headerMemoText: 'header description',
    ...(i === 0 ? { renderCell: PendingViewportCell } : {})
  }));
  const commits = [];
  let deferredFocusChecks = 0;
  globalThis.__pendingViewportProbe = (viewport, target) => {
    assert(viewport, 'the probe consumes the real physical viewport context');
    const panes = [...extent.querySelectorAll('[data-row-pane="body"]')];
    commits.push({ phase, ready: viewport.layoutReady, viewport, target,
      bounded: panes.map(pane => pane.hasAttribute('data-rdg-bounded-body')),
      fallbacks: panes.map(pane => pane.getAttribute('data-rdg-body-fallback')),
      nodes: [...extent.querySelectorAll('[role="columnheader"], [role="gridcell"]')]
    });
    if (['width', 'row-height'].includes(phase) && !viewport.layoutReady) {
      const focused = document.activeElement;
      assert(target?.isConnected);
      const cancel = viewport.requestFocus(target);
      assert.equal(document.activeElement, focused, 'pending paint must not authorize focus');
      cancel();
      deferredFocusChecks++;
    }
  };
  root = createRoot(extent);
  const renderPhysical = async nextPhase => {
    phase = nextPhase;
    await act(() => root.render(React.createElement(DataGrid, {
      columns: physicalColumns, rows: physicalRows, rowKeyGetter: row => row.id,
      enableVirtualization: true, rowHeight: physicalRowHeight, headerRowHeight: 30,
      externalScrollRef: ownerRef, externalViewportExtentRef: extentRef,
      externalViewportLayout: 'stationary-rows', externalZoom: scale
    })));
    // The production physical CSS only rebases direct grid children. A display:contents
    // wrapper still breaks that DOM contract and previously shifted headers one track.
    const headers = [...extent.querySelectorAll('[role="columnheader"]')];
    assert(headers.length > 0);
    for (const cell of headers) {
      assert(cell.parentElement.classList.contains('rdg-physical-row-logical-grid'),
        'header with/without tooltip and description remains a direct grid child');
      const body = [...extent.querySelectorAll('[role="gridcell"]')]
        .find(candidate => candidate.getAttribute('aria-colindex') === cell.getAttribute('aria-colindex'));
      if (body) {
        assert.equal(cell.style.gridColumnStart, body.style.gridColumnStart);
        assert.equal(cell.style.getPropertyValue('--rdg-global-column-start'),
          body.style.getPropertyValue('--rdg-global-column-start'));
      }
    }
  };
  await renderPhysical('mount');
  assert(commits.at(-1).ready);
  const mountedNodes = commits.at(-1).nodes;
  const mountedLayoutVersion = commits.at(-1).viewport.layoutVersion;
  const readsBeforeClone = originRectReads;
  physicalRows = [...physicalRows]; physicalColumns = [...physicalColumns];
  await renderPhysical('identity');
  const identityCommits = commits.filter(commit => commit.phase === 'identity');
  // Memo is allowed to skip the probe entirely for equal inputs.
  assert(identityCommits.every(commit => commit.ready), 'reference-only clones never produce a pending layout');
  assert(commits.at(-1).ready);
  assert.equal(commits.at(-1).viewport.layoutVersion, mountedLayoutVersion, 'equal geometry retains layout version');
  assert.equal(originRectReads, readsBeforeClone, 'equal geometry does not reread the persistent origin');
  const clonedNodes = [...extent.querySelectorAll('[role="columnheader"], [role="gridcell"]')];
  assert(clonedNodes.every((node, index) => node === mountedNodes[index]), 'equal geometry preserves cell hosts');

  for (const nextPhase of ['width', 'row-height']) {
    if (nextPhase === 'width') {
      // Resize an offscreen track so the visible node budget stays identical.
      physicalColumns = physicalColumns.map((column, index) => index === physicalColumns.length - 1
        ? { ...column, width: column.width + 20 } : column);
    } else physicalRowHeight = 45;
    const readsBeforeChange = originRectReads;
    await renderPhysical(nextPhase);
    const pending = commits.filter(commit => commit.phase === nextPhase && !commit.ready);
    assert(pending.length > 0, `${nextPhase}: observe the actual pending layout commit`);
    for (const commit of pending) {
      assert(commit.bounded.length > 0 && commit.bounded.every(Boolean), 'same-coordinate pending paint stays bounded');
      assert.equal(commit.nodes.length, mountedNodes.length);
      assert(commit.nodes.every((node, index) => node === mountedNodes[index]), 'dimension validation retains compatible cell nodes');
    }
    assert(originRectReads > readsBeforeChange, `${nextPhase}: real geometry is revalidated`);
    assert(commits.at(-1).ready, `${nextPhase}: measurement restores readiness`);
  }
  assert(deferredFocusChecks >= 2, 'width and row-height pending states both defer real focus');
  const readyProbe = commits.at(-1);
  await act(() => { readyProbe.viewport.requestFocus(readyProbe.target); });
  assert.equal(document.activeElement, readyProbe.target, 'the same real focus path succeeds after readiness');
  for (const nextPhase of ['zoom', 'owner']) {
    if (nextPhase === 'zoom') scale = 0.7;
    else {
      const previousOwner = owner;
      owner = document.createElement('div'); document.body.append(owner);
      owner.append(extent); previousOwner.remove();
      ownerRef = { current: owner };
    }
    await renderPhysical(nextPhase);
    const pending = commits.filter(commit => commit.phase === nextPhase && !commit.ready);
    assert(pending.length > 0);
    assert(pending.every(commit => commit.fallbacks.length > 0
      && commit.fallbacks.every(reason => reason === 'viewport-not-ready')),
      `${nextPhase} changes must retain the original pending viewport fallback`);
    assert(commits.at(-1).ready);
  }
  console.log('PASS: equal geometry retains readiness; real width/height changes gate focus and retain bounded paint; zoom/owner changes retain fallback');

  // Real React contract regression, independent of native scrollbar heuristics:
  // stationary extent styles describe content only; its CSS 100% minimum owns
  // viewport fill. The display root and virtualization still follow the owner.
  await act(() => root.unmount());
  root = undefined;
  delete globalThis.__pendingViewportProbe;
  const extentOwner = document.createElement('div');
  const contentExtent = document.createElement('div');
  contentExtent.className = 'rdg-physical-extent';
  Object.assign(contentExtent.style, { position: 'relative', overflow: 'clip', minWidth: '100%', minHeight: '100%' });
  extentOwner.append(contentExtent); document.body.append(extentOwner);
  const extentOwnerRef = { current: extentOwner }, contentExtentRef = { current: contentExtent };
  let ownerWidth = 880, ownerHeight = 633;
  Object.defineProperties(extentOwner, {
    clientWidth: { configurable: true, get: () => ownerWidth },
    clientHeight: { configurable: true, get: () => ownerHeight }
  });
  let extentColumns = Array.from({ length: 8 }, (_, i) => ({ key: `extent-${i}`, name: String(i), width: 100 }));
  let extentRows = Array.from({ length: 8 }, (_, i) => ({ id: `extent-row-${i}` }));
  let extentLayout = 'stationary-rows';
  root = createRoot(contentExtent);
  const renderExtent = () => act(() => root.render(React.createElement(DataGrid, {
    columns: extentColumns, rows: extentRows, rowKeyGetter: row => row.id,
    rowHeight: 30, headerRowHeight: 30, enableVirtualization: true,
    externalScrollRef: extentOwnerRef, externalViewportExtentRef: contentExtentRef,
    externalViewportPadding: { inlineEnd: 40, blockEnd: 10 },
    externalViewportLayout: extentLayout, externalZoom: 0.1
  })));
  const extentStyles = () => [contentExtent.style.width, contentExtent.style.height];
  const displayRoot = () => contentExtent.querySelector('.rdg');
  const displaySize = () => [Number.parseFloat(displayRoot().style.width), Number.parseFloat(displayRoot().style.height)];
  const renderedRows = () => contentExtent.querySelectorAll('.rdg-stationary-rowgroup > [role="row"]').length;
  const renderedHeaders = () => contentExtent.querySelectorAll('[role="columnheader"]').length;
  const resizeExtentOwner = async (width, height) => {
    ownerWidth = width; ownerHeight = height;
    await act(() => {
      for (const observer of [...observers]) if (observer.elements.has(extentOwner)) {
        observer.callback([{ target: extentOwner, contentBoxSize: [{ inlineSize: width, blockSize: height }] }]);
      }
    });
    assert.deepEqual(displaySize(), [width, height], 'stationary display root follows the current owner');
  };
  await renderExtent();
  assert(displayRoot().classList.contains('rdg-stationary-rows-viewport'));
  assert.deepEqual(extentStyles(), ['84px', '28px'], 'small-table track includes only scaled content and padding');
  assert.deepEqual(displaySize(), [880, 633]);
  // These alternate measured sizes can represent scrollbar appearance/removal;
  // no native scrollbar simulation is needed to assert absence of feedback.
  for (const size of [[865, 618], [880, 633], [280, 180], [880, 633]]) {
    await resizeExtentOwner(...size);
    assert.deepEqual(extentStyles(), ['84px', '28px'], 'owner resize never rewrites content-only extent styles');
  }
  extentColumns = extentColumns.map((column, index) => index === 0 ? { ...column, width: 120 } : column);
  extentRows = [...extentRows, { id: 'extent-row-8' }];
  await renderExtent();
  assert.deepEqual(extentStyles(), ['86px', '31px'], 'column width and row count update the real content extent');
  assert.deepEqual(displaySize(), [880, 633]);
  extentColumns = Array.from({ length: 120 }, (_, i) => ({ key: `extent-${i}`, name: String(i), width: 100 }));
  extentRows = Array.from({ length: 2000 }, (_, i) => ({ id: `extent-row-${i}` }));
  await renderExtent();
  const largeExtentStyles = extentStyles();
  assert.deepEqual(largeExtentStyles, ['1204px', '6004px']);
  const wideRows = renderedRows(), wideHeaders = renderedHeaders();
  assert(wideRows > 0 && wideRows < extentRows.length, 'large data retains row virtualization');
  assert(wideHeaders > 0 && wideHeaders < extentColumns.length, 'large data retains column virtualization');
  await resizeExtentOwner(280, 180);
  assert.deepEqual(extentStyles(), largeExtentStyles);
  assert(renderedRows() > 0 && renderedRows() < wideRows, 'owner height still determines the row window');
  assert(renderedHeaders() > 0 && renderedHeaders() < wideHeaders, 'owner width still determines the column window');
  await resizeExtentOwner(880, 633);
  assert.equal(renderedRows(), wideRows, 'restoring owner height restores the row window');
  assert.equal(renderedHeaders(), wideHeaders, 'restoring owner width restores the column window');
  assert.deepEqual(extentStyles(), largeExtentStyles);
  // Unsupported/generic physical consumers retain their previous owner minimum.
  extentColumns = extentColumns.slice(0, 8); extentRows = extentRows.slice(0, 8);
  extentLayout = 'physical-rows';
  await renderExtent();
  assert(!displayRoot().classList.contains('rdg-stationary-rows-viewport'));
  assert.deepEqual(extentStyles(), ['880px', '633px'], 'generic physical fallback keeps its previous extent contract');
  console.log('PASS: stationary extent is content-only across owner resizing; content geometry updates it; display root and both virtualization axes follow owner; generic fallback retains owner minimum');

} finally {
  delete globalThis.__pendingViewportProbe;
  if (root) await act(() => root.unmount());
  await window.happyDOM.close();
  await rm(temporary, { recursive: true, force: true });
}
