// Lint cleanups must preserve deliberate geometry invalidation and component boundaries.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.grid-lint-check-'));
const window = new Window({ url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'HTMLDivElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'KeyboardEvent',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
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
const capture = globalThis.__gridLintCheck = {};
let root;

// Execute the actual memo expressions in a small React harness, rather than a
// copied dependency list or timing-dependent DOM measurement approximation.
const source = await readFile(resolve(project, 'src/lib/react-data-grid/DataGrid.tsx'), 'utf8');
const declarations = new Map([...source.matchAll(/const (physicalGeometryKey|physicalLayoutToken) = (useMemo\([\s\S]*?\]\));/g)]
  .map(match => [match[1], match[2]]));
assert.equal(declarations.size, 2);
const expectedDependencies = {
  physicalGeometryKey: ['columnGeometry', 'rowGeometry', 'spanRows', 'spanTopSummaryRows', 'spanBottomSummaryRows',
    'genericGeometryInputs', 'externalViewportGeometryKey', 'style', 'className', 'headerRowHeight', 'direction',
    'physicalScale', 'externalScrollRef', 'externalViewportExtentRef', 'externalViewportPadding.inlineEnd',
    'externalViewportPadding.blockEnd', 'headerRowsCount', 'summaryRowHeight', 'topSummaryRows.length',
    'bottomSummaryRows.length', 'isStationaryRows'],
  physicalLayoutToken: ['columnGeometry', 'rowGeometry', 'getRowTop', 'headerRowsHeight', 'genericGeometryInputs',
    'externalViewportGeometryKey', 'style', 'className', 'physicalScale', 'measurementRevision',
    'externalViewport.ownerClientWidth', 'externalViewport.ownerClientHeight', 'isStationaryRows']
};
const snapshotFields = {
  'externalViewportPadding.inlineEnd': 'inlineEndPadding', 'externalViewportPadding.blockEnd': 'blockEndPadding',
  'topSummaryRows.length': 'topSummaryRowsCount', 'bottomSummaryRows.length': 'bottomSummaryRowsCount',
  'externalViewport.ownerClientWidth': 'ownerClientWidth', 'externalViewport.ownerClientHeight': 'ownerClientHeight'
};
const probes = [...declarations].map(([name, expression]) => {
  const dependencyText = expression.slice(expression.lastIndexOf('[') + 1, expression.lastIndexOf(']'));
  const dependencies = dependencyText.split(',').map(value => value.trim().replaceAll('?.', '.'));
  assert.deepEqual(dependencies, expectedDependencies[name], `${name} retains every intentional invalidator`);
  const inputs = [...new Set(dependencies.map(key => key.split('.')[0]))];
  return `export function ${name}Probe(inputs) { const { ${inputs.join(', ')} } = inputs;
    const ${name} = ${expression}; globalThis.__gridLintCheck.${name} = ${name}; return null; }`;
}).join('\n');

try {
  const result = await build({ absWorkingDir: project, stdin: {
    contents: `import { useMemo } from 'react'; ${probes}
      export { DataGrid } from './src/lib/react-data-grid/DataGrid';
      export { TreeDataGrid } from './src/lib/react-data-grid/TreeDataGrid';
      export { default as Cell } from './src/lib/react-data-grid/Cell';
      export { default as ScrollToCell } from './src/lib/react-data-grid/ScrollToCell';
      export { DataGridViewportContext } from './src/lib/react-data-grid/DataGridViewportContext';
      export { getCellStyle } from './src/lib/react-data-grid/utils/styleUtils';
      export { omit } from './src/lib/react-data-grid/utils/omit';`, resolveDir: project, loader: 'tsx'
  }, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    alias: { '@': resolve(project, 'src') }, plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'linaria', namespace: 'boundary' }));
      builder.onResolve({ filter: /^@\/app\/i18n$/ }, () => ({ path: 'i18n', namespace: 'boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ loader: 'js', contents: args.path === 'linaria'
        ? `let next=0;export const css=()=> 'test-style-'+next++;`
        : `export const t=key=>key;export const useI18n=()=>({t,locale:'ja'});export const formatNumber=String;export const localizeError=String; export const message=(key,values)=>({key,values}); export const localizedError=descriptor=>Object.assign(new Error(descriptor.key),descriptor);` }));
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'css' }));
      builder.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ loader: 'js', contents: '' }));
    }}]
  });
  const modulePath = resolve(temporary, 'fixture.mjs');
  await writeFile(modulePath, result.outputFiles[0].text);
  const fixture = await import(pathToFileURL(modulePath));
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act, createElement: element } = React;
  const mount = document.createElement('section'); document.body.append(mount); root = createRoot(mount);
  const render = async component => { await act(async () => root.render(component)); };
  const check = async (name, action) => { await action(); console.log('PASS', name); };
  const baseInputs = {
    columnGeometry: [], rowGeometry: {}, spanRows: [], spanTopSummaryRows: [], spanBottomSummaryRows: [],
    genericGeometryInputs: {}, externalViewportGeometryKey: {}, style: {}, className: 'grid', headerRowHeight: 35,
    direction: 'ltr', physicalScale: 1, externalScrollRef: { current: null }, externalViewportExtentRef: { current: null },
    externalViewportPadding: { inlineEnd: 4, blockEnd: 8 }, headerRowsCount: 1, summaryRowHeight: 35,
    topSummaryRows: [], bottomSummaryRows: [], isStationaryRows: false, getRowTop: index => index * 35,
    headerRowsHeight: 35, measurementRevision: 0, externalViewport: { ownerClientWidth: 900, ownerClientHeight: 600 }
  };
  const changedValue = value => typeof value === 'number' ? value + 1 : typeof value === 'string' ? `${value}-changed`
    : typeof value === 'boolean' ? !value : typeof value === 'function' ? () => 42 : Array.isArray(value) ? [...value, {}] : { ...value };
  for (const name of Object.keys(expectedDependencies)) {
    await check(`${name}: stable identity and every individual geometry/layout invalidator`, async () => {
      const Probe = fixture[`${name}Probe`];
      for (const dependency of expectedDependencies[name]) {
        await render(element(Probe, baseInputs)); const previous = capture[name];
        await render(element(Probe, { ...baseInputs })); assert.equal(capture[name], previous, 'unchanged inputs stay stable');
        const [key, property] = dependency.split('.');
        const changed = { ...baseInputs };
        if (property) {
          changed[key] = Array.isArray(changed[key]) ? [...changed[key]] : { ...changed[key] };
          changed[key][property] = changedValue(changed[key][property]);
        } else changed[key] = changedValue(changed[key]);
        await render(element(Probe, changed));
        assert.notEqual(capture[name], previous, `${dependency} invalidates the token`);
        assert.equal(capture[name][snapshotFields[dependency] ?? key], property ? changed[key][property] : changed[key],
          `${dependency} is represented in the meaningful snapshot`);
      }
    });
  }

  await check('deferred scroll waits for readiness, retries new layouts and uses the latest callback', async () => {
    const requested = { rowIdx: 12, idx: 4 }, attempts = [], clears = [];
    const initialScroll = position => { attempts.push(['initial', position]); return false; };
    const setPosition = value => clears.push(value);
    let context = { layoutReady: false, layoutVersion: {}, scrollToPosition: initialScroll };
    const renderRequest = () => render(element(fixture.DataGridViewportContext, { value: context },
      element(fixture.ScrollToCell, { scrollToPosition: requested, setScrollToCellPosition: setPosition })));
    await renderRequest(); assert.equal(attempts.length, 0);
    context = { ...context, layoutReady: true }; await renderRequest(); assert.equal(attempts.length, 1); assert.equal(clears.length, 0);
    context = { ...context }; await renderRequest(); assert.equal(attempts.length, 1, 'unrelated context identity does not replay');
    context = { ...context, layoutVersion: {} }; await renderRequest(); assert.equal(attempts.length, 2);
    context = { ...context, scrollToPosition: position => { attempts.push(['latest', position]); return true; } };
    await renderRequest(); assert.deepEqual(attempts.at(-1), ['latest', requested]); assert.deepEqual(clears, [null]);
  });

  await check('style and DOM filtering preserve caller inputs, custom attributes and conditional backgrounds', async () => {
    const inherited = Symbol('public');
    const input = Object.freeze({ keep: 1, remove: 2, [inherited]: 3 });
    assert.deepEqual(fixture.omit(input, ['remove']), { keep: 1, [inherited]: 3 }); assert.equal(input.remove, 2);
    const customStyles = Object.freeze({ backgroundColor: 'red', color: 'green', fontSize: 14, fontWeight: 'bold', textAlign: 'right' });
    const resolvedStyles = Object.freeze({ backgroundColor: 'purple', letterSpacing: '2px' });
    const column = { key: 'value', idx: 2, name: 'Value', frozen: true, renderCell: ({ row }) => row.value,
      customStyles, styleResolver: () => resolvedStyles };
    await render(element(fixture.Cell, { column, row: { value: 'hello' }, rowIdx: 0, colSpan: 2,
      isCellSelected: false, isRowSelected: true, isDraggedOver: true, isHovered: true, isInRange: true,
      getCellBackgroundColor: (row, currentColumn, state) => {
        assert.equal(row.value, 'hello'); assert.equal(currentColumn, column); assert.equal(state.isHovered, true); return 'blue';
      }, className: 'caller-cell', style: { paddingLeft: 7 }, 'data-custom': 'preserved', selectCell() {}, onRowChange() {} }));
    const cell = mount.querySelector('[role="gridcell"]');
    assert.equal(cell.textContent, 'hello'); assert.equal(cell.style.backgroundColor, 'blue');
    assert.equal(cell.style.color, 'green'); assert.equal(cell.style.fontSize, '14px'); assert.equal(cell.style.letterSpacing, '2px');
    assert.equal(cell.style.paddingLeft, '7px'); assert(cell.classList.contains('caller-cell'));
    assert.equal(cell.getAttribute('data-custom'), 'preserved'); assert.equal(cell.getAttribute('aria-colspan'), '2');
    assert.equal(cell.getAttribute('aria-selected'), 'true'); assert.equal(cell.style.outlineOffset, '-1px');
    for (const key of ['isHovered', 'isInRange', 'getCellBackgroundColor', 'colSpan', 'isRowSelected', 'isDraggedOver']) {
      assert(!cell.hasAttribute(key.toLowerCase()), `${key} is not forwarded to the DOM`);
    }
    assert.equal(resolvedStyles.backgroundColor, 'purple'); assert.equal(customStyles.backgroundColor, 'red');
    assert.deepEqual(fixture.getCellStyle(column, 2), { gridColumnStart: 3, gridColumnEnd: 5,
      '--rdg-global-column-start': '3', '--rdg-global-column-end': '5', insetInlineStart: 'var(--rdg-frozen-left-2)' });
  });

  await check('selection reconciliation uses current callbacks without replaying an old order-change event', async () => {
    const gridRef = React.createRef(), notifications = [];
    const columns = [{ key: 'value', name: 'Value', width: 150 }], rowKeyGetter = row => row.id;
    let rows = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }, { id: 'c', value: 3 }], revision = 'initial';
    const renderGrid = () => render(element(React.StrictMode, null, element(fixture.DataGrid, {
      ref: gridRef, rows, columns, rowKeyGetter, enableVirtualization: false,
      onSelectedCellChange: args => notifications.push({ revision, id: args.row?.id, value: args.row?.value, rowIdx: args.rowIdx })
    })));
    await renderGrid(); await act(async () => gridRef.current.selectCell({ rowIdx: 1, idx: 0 }));
    revision = 'reordered'; rows = [rows[1], rows[0], rows[2]]; await renderGrid();
    assert.deepEqual(notifications.at(-1), { revision: 'reordered', id: 'b', value: 2, rowIdx: 0 });
    const count = notifications.length;
    revision = 'value-only'; rows = rows.map(row => ({ ...row, value: row.value + 10 })); await renderGrid();
    assert.equal(notifications.length, count, 'callback and value changes do not re-emit reconciliation');
    revision = 'reordered-again'; rows = [rows[1], rows[2], rows[0]]; await renderGrid();
    assert.equal(notifications.length, count + 1);
    assert.deepEqual(notifications.at(-1), { revision: 'reordered-again', id: 'b', value: 12, rowIdx: 2 });
  });

  await check('group rows keep ordinary-cell and physical-layout inputs off the DOM', async () => {
    const rows = [{ id: 'a', group: 'same', value: 1 }];
    await render(element(fixture.TreeDataGrid, { rows, columns: [{ key: 'group', name: 'Group', width: 150 }],
      rowKeyGetter: row => row.id, groupBy: ['group'], rowGrouper: data => ({ same: data }),
      expandedGroupIds: new Set(['same']), onExpandedGroupIdsChange() {}, enableVirtualization: false }));
    const row = mount.querySelector('[role="row"][data-row-index="0"]'); assert(row);
    for (const key of ['isCurrentRowSelected', 'isHovered', 'rangeStartIdx', 'rangeEndIdx', 'getCellBackgroundColor',
      'onRowHover', 'sharedTooltip', 'transientLock', 'onRowContextMenu', 'isRowSelectionDisabled', 'physicalRowTop',
      'physicalRowHeight', 'physicalBodyWindow', 'physicalBodyFallback', 'onCellMouseDown', 'onCellClick', 'onCellDoubleClick', 'onCellContextMenu']) {
      assert(!row.hasAttribute(key.toLowerCase()), `${key} remains a component input`);
    }
  });
  console.log('All focused grid lint behavior checks passed.');
} finally {
  if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
  await rm(temporary, { recursive: true, force: true }); await window.happyDOM.close();
  delete globalThis.__gridLintCheck;
}
