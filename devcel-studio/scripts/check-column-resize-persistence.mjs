// Run from devcel-studio: node scripts/check-column-resize-persistence.mjs
// DOM geometry is synthetic; this checks persistence/lifecycle behavior, not layout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.column-resize-check-'));
const window = new Window({ url: 'http://column-resize.test' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'CSS']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const values = new Map();
let writes = 0;
let failWrite = false;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { if (failWrite) throw new Error('Storage unavailable'); writes++; values.set(key, value); }
} });
const key = `devcel-datagrid-column-widths:${JSON.parse(readFileSync(resolve(project, 'src-tauri/tauri.conf.json'), 'utf8')).version}`;
const stored = () => JSON.parse(values.get(key) || '{}');
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 120; } });
window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 120, 30);
window.HTMLElement.prototype.setPointerCapture = () => {};
let root;

try {
  const bundled = await build({
    absWorkingDir: project,
    stdin: { contents: `export { useDataGridColumnWidth } from './src/app/pages/main_window/project_view/table_view/components/useDataGridColumnWidth';\nexport { default as HeaderCell } from './src/lib/react-data-grid/HeaderCell';`, resolveDir: project, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'static-css-for-dom-check', setup(builder) {
      builder.onResolve({ filter: /^@\/app\/settings$/ }, () => ({ path: 'settings', namespace: 'settings-boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'settings-boundary' }, () => ({ contents: `export const getSettingsSnapshot=()=>({appVersion:${JSON.stringify(JSON.parse(readFileSync(resolve(project, 'src-tauri/tauri.conf.json'), 'utf8')).version)}});` }));
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'linaria', namespace: 'test-css' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-css' }, () => ({ contents: `export const css = () => 'test-css';` }));
    } }]
  });
  const modulePath = resolve(temporary, 'hooks.mjs');
  await writeFile(modulePath, bundled.outputFiles[0].text);
  const { useDataGridColumnWidth, HeaderCell } = await import(pathToFileURL(modulePath));
  let api;
  let renders = 0;
  let resizeEnds = 0;
  let liveWidths = [];
  const column = { key: 'a', idx: 0, name: 'A', minWidth: 40, maxWidth: 500, width: 120, resizable: true, renderHeaderCell: () => 'A' };
  function Harness({ table = 'table-a', session = 'session-1', header = false, direction = 'ltr' }) {
    renders++;
    api = useDataGridColumnWidth(table, session);
    return React.createElement('div', { className: 'rdg' },
      React.createElement('div', { 'data-measuring-cell-key': 'a' }),
      header && React.createElement(HeaderCell, {
        column, columns: [column], rowIdx: 1, isCellSelected: false, direction,
        selectCell() {}, setDraggedColumnKey() {},
        onColumnResize(current, width) {
          liveWidths.push(width);
          api.queueColumnWidth(current.key, width === 'max-content' ? 321 : width);
        },
        onColumnResizeEnd() { resizeEnds++; api.flushColumnWidths(); }
      })
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = props => act(() => root.render(React.createElement(Harness, props)));
  await render({});
  const beforeMoves = renders;
  for (let width = 121; width <= 220; width++) api.queueColumnWidth('a', width);
  api.queueColumnWidth('b', 333);
  assert.equal(writes, 0, 'moving writes no storage');
  assert.equal(renders, beforeMoves, 'moving does not render the hook owner');
  assert.equal(api.getColumnWidth('a', 120), 120, 'the grid owns live drag widths');
  await act(() => api.flushColumnWidths());
  assert.equal(writes, 1, '100 moves and another column coalesce into one write');
  assert.deepEqual(stored()['table-a'], { a: 220, b: 333 });
  assert.equal(api.getColumnWidth('a', 120), 220);
  await act(() => api.flushColumnWidths());
  assert.equal(writes, 1, 'duplicate end events do not save twice');

  // A different table may have completed a resize since this hook loaded.
  values.set(key, JSON.stringify({ ...stored(), other: { x: 456 } }));
  api.queueColumnWidth('a', 240);
  await act(() => api.flushColumnWidths());
  assert.deepEqual(stored().other, { x: 456 }, 'flush merges other tables');
  const stale = api;
  api.queueColumnWidth('a', 250);
  await render({ table: 'table-b' });
  assert.equal(stored()['table-a'].a, 250, 'table switch flushes old identity');
  assert.equal(api.getColumnWidth('a', 120), 120, 'new table does not inherit old widths');
  stale.queueColumnWidth('a', 999);
  await act(() => stale.flushColumnWidths());
  assert.equal(stored()['table-a'].a, 250, 'stale callbacks are inert');
  api.queueColumnWidth('a', 260);
  const staleSession = api;
  await render({ table: 'table-b', session: 'session-2' });
  assert.equal(stored()['table-b'].a, 260, 'session switch flushes existing UUID scope');
  staleSession.queueColumnWidth('a', 999);
  await act(() => staleSession.flushColumnWidths());
  assert.equal(api.getColumnWidth('a', 120), 260);
  api.queueColumnWidth('a', 270);
  await act(() => window.dispatchEvent(new window.Event('pagehide')));
  assert.equal(stored()['table-b'].a, 270, 'reload during drag persists final width');
  api.queueColumnWidth('a', 280);
  await act(() => api.clearColumnWidths());
  await act(() => api.flushColumnWidths());
  assert.equal(stored()['table-b'], undefined, 'reset removes pending drag');
  assert.equal(api.getColumnWidth('a', 120), 120);
  await act(() => api.saveColumnWidth('a', 290));
  assert.equal(stored()['table-b'].a, 290, 'immediate save API is preserved');
  for (const invalid of [NaN, Infinity, -10, 0]) api.queueColumnWidth('a', invalid);
  await act(() => api.flushColumnWidths());
  assert.equal(stored()['table-b'].a, 290, 'invalid widths are ignored');

  // Unavailable storage must not interrupt the live width or lose a retry.
  failWrite = true;
  const originalError = console.error;
  console.error = () => {};
  api.queueColumnWidth('a', 300);
  try { await act(() => api.flushColumnWidths()); } finally { console.error = originalError; }
  assert.equal(api.getColumnWidth('a', 120), 300);
  failWrite = false;
  await act(() => api.flushColumnWidths());
  assert.equal(stored()['table-b'].a, 300, 'a later flush retries a failed save');

  await render({ table: 'headers', header: true });
  const handle = () => container.querySelector('.rdg-cell-resizer-right');
  const pointer = async (type, x, pointerId = 1, buttons = 1) => {
    await act(() => handle().dispatchEvent(new window.PointerEvent(type, {
      bubbles: true, pointerId, pointerType: 'mouse', buttons, clientX: x
    })));
  };
  const dragStartWrites = writes;
  await pointer('pointerdown', 100);
  await pointer('pointermove', 150);
  await pointer('pointermove', 170);
  assert.equal(writes, dragStartWrites, 'header drag remains live without a save');
  assert.deepEqual(liveWidths, [170, 190], 'header emits each live width');
  await pointer('pointerup', 180, 1, 0);
  assert.equal(stored().headers.a, 200, 'pointerup includes the last position');
  assert.equal(writes, dragStartWrites + 1);
  await pointer('lostpointercapture', 180, 1, 0);
  assert.equal(resizeEnds, 1, 'lost capture after up does not end twice');
  await pointer('pointerdown', 100);
  await pointer('pointermove', 160);
  await pointer('pointercancel', 0, 1, 0);
  assert.equal(stored().headers.a, 180, 'cancel commits last visible width, not cancel coordinates');
  await pointer('pointerdown', 100);
  await pointer('pointermove', 175);
  await pointer('lostpointercapture', 0, 1, 0);
  assert.equal(stored().headers.a, 195, 'lost capture commits the visible width');
  await pointer('pointerdown', 100);
  await pointer('pointermove', 190);
  await render({ table: 'headers', header: false });
  assert.equal(stored().headers.a, 210, 'header virtualization/unmount ends pending drag');
  await render({ table: 'headers', header: true });
  await act(() => handle().dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
  assert.equal(liveWidths.at(-1), 'max-content');
  assert.equal(stored().headers.a, 321, 'auto-fit emits a completion');
  await act(() => container.querySelector('[role=columnheader]').dispatchEvent(new window.KeyboardEvent('keydown', {
    bubbles: true, ctrlKey: true, key: 'ArrowRight'
  })));
  assert.equal(stored().headers.a, 130, 'keyboard resize emits a completion');
  await render({ table: 'headers', header: true, direction: 'rtl' });
  await pointer('pointerdown', 100);
  await pointer('pointermove', 80);
  await pointer('pointerup', 70, 1, 0);
  assert.equal(stored().headers.a, 150, 'RTL drag keeps its direction');
  api.queueColumnWidth('a', 310);
  await act(() => root.unmount());
  root = undefined;
  assert.equal(stored().headers.a, 310, 'view unmount flushes pending final width');

  // A fresh mount reloads the saved final width.
  root = createRoot(container);
  await render({ table: 'headers' });
  assert.equal(api.getColumnWidth('a', 120), 310);
  console.log('PASS: coalesced widths; no move renders/writes; drag/cancel/lost capture; keyboard/auto-fit; table/session/unmount/pagehide; reset/reload/storage retry.');
} finally {
  if (root) await act(() => root.unmount());
  await window.happyDOM.close();
  await rm(temporary, { recursive: true, force: true });
}
