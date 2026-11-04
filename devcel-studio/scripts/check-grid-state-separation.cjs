#!/usr/bin/env node
'use strict';
// Focused contract regression. No timings or native performance conclusions.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { build } = require('esbuild');
const project = path.resolve(__dirname, '..');

(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://grid-state-separation.invalid' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const result = await build({ absWorkingDir: project, stdin: { resolveDir: project, loader: 'ts', contents: `
    export { createGridDisplayModel, shareDisplayValue } from './src/app/pages/main_window/project_view/table_view/components/gridDisplayModel';
    export { useCalculatedColumns, useColumnViewport } from './src/lib/react-data-grid/hooks/useCalculatedColumns';
    export { useRowGeometry } from './src/lib/react-data-grid/hooks/useRowGeometry';
    export { useViewportRows } from './src/lib/react-data-grid/hooks/useViewportRows';
    export { createPhysicalBodyWindow } from './src/lib/react-data-grid/utils/physicalBodyWindow';
  ` }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false,
    tsconfig: path.join(project, 'tsconfig.json'), loader: { '.css': 'empty' },
    // This harness evaluates production modules outside Vite; supply its production env contract.
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [{ name: 'css-boundary', setup(builder) {
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'linaria', namespace: 'boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({ contents: 'export const css = () => "synthetic-css";', loader: 'js' }));
    } }]
  });
  const compiled = new Module(path.join(project, 'grid-state-separation-check.cjs'));
  compiled.paths = Module._nodeModulePaths(project);
  compiled._compile(result.outputFiles[0].text, path.join(project, 'grid-state-separation-check.cjs'));
  const { createGridDisplayModel, shareDisplayValue, useCalculatedColumns, useRowGeometry, useViewportRows, createPhysicalBodyWindow } = compiled.exports;
  const clone = value => JSON.parse(JSON.stringify(value));
  const originalShape = { keep: { value: 1 }, removed: { value: 2 } };
  const deletion = shareDisplayValue(originalShape, { keep: { value: 1 } });
  assert.notEqual(deletion, originalShape); assert.equal(deletion.keep, originalShape.keep);
  assert.equal(Object.hasOwn(deletion, 'removed'), false, 'removed fields cannot survive sharing');
  const unknown = shareDisplayValue(originalShape, { ...originalShape, future: { nested: ['new'] } });
  assert.deepEqual(unknown.future, { nested: ['new'] }, 'unknown future DTO fields are preserved');
  assert.equal(unknown.keep, originalShape.keep);
  assert.deepEqual(shareDisplayValue([1, 2], [2, 1]), [2, 1], 'array order is semantic');
  assert.equal(shareDisplayValue(new Array(2), new Array(1)).length, 1, 'array length is compared independently');
  const prototypeKey = JSON.parse('{"__proto__":{"safe":true}}');
  assert(Object.hasOwn(shareDisplayValue({}, prototypeKey), '__proto__'), 'JSON map keys remain own data fields');

  const definition = (uuid, type = 'String') => ({ uuid, display_name: uuid, data_name: uuid, data_type: type,
    min_version: 0, tooltip: '', tags: [], read_only: false, default_value: '', style: { width: 100, color: '#fff', font_size: 12 }, memo_text: '', reference_config: null });
  const record = uuid => ({ uuid, parent_uuid: '', label: uuid, min_version: 0, tags: [], values: { a: 'stored', b: '' }, interface_values: {}, memo_texts: {} });
  const table = { description: '', metadata: { initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, uuid: 'table-A' }, schema: { columns: [definition('a'), definition('b', 'Boolean')] },
    records: [record('row-1'), record('row-2')], interface_implementations: {}, interface_order: [] };
  const cell = { raw_value: 'stored', display_value: 'display', style: {}, issues: [], formula_error: null, hint: '' };
  const presentation = { table_uuid: 'table-A', revision: 'r1', cells: { 'row-1': { a: cell, b: { ...cell, display_value: 'false' } } }, definition_issues: [], issue_count: 0 };
  const first = createGridDisplayModel(undefined, table, presentation, 'session-A');
  let shared = createGridDisplayModel(first, clone(table), { ...clone(presentation), revision: 'r2' }, 'session-A');
  assert.equal(shared.rows, first.rows, 'new authoritative identities/revision preserve equal display rows');
  assert.equal(shared.columns, first.columns, 'complete equal schema shares identity');
  assert.equal(shared.rows[0].cellPresentations.a, first.rows[0].cellPresentations.a);

  for (const [name, update] of [
    ['raw', next => { next.cells['row-1'].a.raw_value = ''; }],
    ['hint', next => { next.cells['row-1'].a.hint = 'new hint'; }],
    ['formula error', next => { next.cells['row-1'].a.formula_error = 'new formula error'; }],
    ['style', next => { next.cells['row-1'].a.style = { text_color: '#123456', background_color: '#654321', bold: false }; }],
    ['issue', next => { next.cells['row-1'].a.issues = [{ diagnostic: { kind: 'text', text: 'warn' }, mode: 'warn', peers: ['p'], raw_value: 'stored', effective_value: 'display' }]; }],
  ]) {
    const next = clone(presentation); update(next);
    const changed = createGridDisplayModel(first, clone(table), next, 'session-A');
    assert.notEqual(changed.rows[0], first.rows[0], `${name} must invalidate its row`);
    assert.equal(changed.rows[1], first.rows[1], `${name} must preserve other rows`);
    assert.equal(changed.rows[0].cellPresentations.b, first.rows[0].cellPresentations.b, `${name} preserves other cells`);
    assert.deepEqual(changed.rows[0].cellPresentations.a, next.cells['row-1'].a, `${name} remains authoritative`);
  }
  for (const [name, update] of [
    ['stored input', next => { next.records[0].values.a = 'changed'; }],
    ['label', next => { next.records[0].label = 'changed'; }],
    ['minimum version', next => { next.records[0].min_version = 7; }],
    ['memo', next => { next.records[0].memo_texts.a = 'changed'; }],
    ['tags', next => { next.records[0].tags.push('changed'); }],
    ['interface value', next => { next.records[0].interface_values.a = 'changed'; }],
  ]) {
    const next = clone(table); update(next);
    const changed = createGridDisplayModel(first, next, clone(presentation), 'session-A');
    assert.notEqual(changed.rows[0], first.rows[0], name);
    assert.equal(changed.rows[1], first.rows[1], `${name} must not recreate unrelated rows`);
    assert.deepEqual(changed.rows[0].tableRecord, next.records[0]);
  }
  const schemaChange = clone(table); schemaChange.schema.columns[0].default_value = 'new default';
  schemaChange.schema.columns[0].reference_config = { target_table_uuid: 'other', display_column_uuid: 'name' };
  shared = createGridDisplayModel(first, schemaChange, presentation, 'session-A');
  assert.notEqual(shared.columns[0], first.columns[0]); assert.equal(shared.columns[1], first.columns[1]);
  assert.deepEqual(shared.rows[0].columnDefs, schemaChange.schema.columns);
  const reversed = { ...table, records: [...table.records].reverse() };
  shared = createGridDisplayModel(first, reversed, presentation, 'session-A');
  assert.equal(shared.rows[0].rowId, 'row-2'); assert.equal(shared.rows[0].rowIndex, 0);
  assert.equal(shared.rows[0].tableRecord, first.rows[1].tableRecord);
  assert.notEqual(createGridDisplayModel(first, table, presentation, 'session-B').rows, first.rows);
  assert.equal(createGridDisplayModel(first, { ...table, records: [] }, presentation, 'session-A').rows.length, 0);

  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let latest;
  const keyGetter = row => row.id;
  const rowHeight = row => row.height;
  const getColumnWidth = column => column.width;
  function Probe(props) {
    const columns = useCalculatedColumns({ rawColumns: props.columns, rowIndicator: props.indicator,
      defaultColumnOptions: props.defaults, getColumnWidth: props.getWidth || getColumnWidth, dataTypeStyles: props.dataTypeStyles });
    const geometry = useRowGeometry(props.rows, props.height || rowHeight, keyGetter);
    const rows = useViewportRows({ rows: props.rows, rowHeight: props.height || rowHeight,
      geometry, clientHeight: 100, scrollTop: 0, enableVirtualization: true });
    latest = { ...columns, rowGeometry: geometry, rowLayout: rows };
    return null;
  }
  const render = async props => { await React.act(async () => { root.render(React.createElement(Probe, props)); }); return latest; };
  let props = { columns: [{ key: 'a', name: 'A', width: 100 }, { key: 'b', name: 'B', width: 120 }], rows: [{ id: 'r1', height: 30, value: 'old' }, { id: 'r2', height: 40 }] };
  const initial = await render(props);
  props = { ...props, columns: props.columns.map(column => ({ ...column, name: 'new header', editable: false, renderCell: () => 'new runtime' })), rows: props.rows.map(row => ({ ...row, value: 'new' })) };
  const runtime = await render(props);
  assert.equal(runtime.columnGeometry, initial.columnGeometry, 'runtime column props do not invalidate geometry');
  assert.equal(runtime.columnMetrics, initial.columnMetrics, 'metrics are key-based and stable');
  assert.equal(runtime.columnMetrics.get(runtime.columns[1]).left, 100, 'new runtime columns resolve current metrics');
  assert.equal(runtime.columns[0].renderCell({}), 'new runtime', 'content is never frozen');
  assert.equal(runtime.rowGeometry, initial.rowGeometry, 'equal measured heights/order preserve row geometry');
  assert.equal(runtime.rowLayout.getRowTop, initial.rowLayout.getRowTop, 'row layout callbacks remain stable');
  const width = await render({ ...props, columns: [{ ...props.columns[0], width: 150 }, props.columns[1]] });
  assert.notEqual(width.columnGeometry, runtime.columnGeometry); assert.equal(width.columnMetrics.get(width.columns[1]).left, 150);
  assert.equal(width.columns[1], runtime.columns[1], 'unchanged calculated columns are shared');
  const indicator = await render({ ...props, indicator: { width: 60, headerContent: 'one' } });
  const indicatorRuntime = await render({ ...props, indicator: { width: 60, headerContent: 'two', renderIndicator: () => 'row runtime' } });
  assert.equal(indicatorRuntime.columnGeometry, indicator.columnGeometry);
  assert.equal(indicatorRuntime.totalFrozenColumnWidth, 60);
  assert.notEqual((await render({ ...props, indicator: { width: 80 } })).columnGeometry, indicator.columnGeometry);
  const height = await render({ ...props, rows: [{ ...props.rows[0], height: 50 }, props.rows[1]] });
  assert.notEqual(height.rowGeometry, runtime.rowGeometry); assert.equal(height.rowLayout.getRowTop(1), 50);
  const sameHeightCallback = await render({ ...props, height: row => row.height });
  assert.deepEqual(sameHeightCallback.rowGeometry.heights, [30, 40]);
  const sameHeights = await render({ ...props, height: row => row.height });
  assert.equal(sameHeights.rowGeometry, sameHeightCallback.rowGeometry, 'callback identity alone is not geometry');
  const order = await render({ ...props, rows: [...props.rows].reverse() });
  assert.notEqual(order.rowGeometry, sameHeights.rowGeometry); assert.equal(order.rowLayout.getRowTop(1), 40);
  const numeric = await render({ ...props, height: 35 });
  const numericValue = await render({ ...props, height: 35, rows: props.rows.map(row => ({ ...row, value: 'again' })) });
  assert.equal(numericValue.rowGeometry, numeric.rowGeometry);
  const grouped = await render({ ...props, columns: [{ name: 'Group', children: props.columns }] });
  assert.equal(grouped.headerRowsCount, 2); assert.notEqual(grouped.columnGeometry, runtime.columnGeometry);
  const span = () => 2;
  const spanning = await render({ ...props, columns: [{ ...props.columns[0], colSpan: span }, props.columns[1]] });
  const newSpan = await render({ ...props, columns: [{ ...props.columns[0], colSpan: () => 1 }, props.columns[1]] });
  assert.notEqual(newSpan.columnGeometry, spanning.columnGeometry);
  const intrinsic = await render({ ...props, columns: [{ ...props.columns[0], width: 'auto' }] });
  const minWidth = await render({ ...props, columns: [{ ...props.columns[0], width: 'auto', minWidth: 80 }] });
  assert.notEqual(minWidth.columnGeometry, intrinsic.columnGeometry); assert.equal(minWidth.columnMetrics.get(minWidth.columns[0]).width, 80);
  const windowed = createPhysicalBodyWindow(runtime.columnGeometry, runtime.columnMetrics, runtime.templateColumns, 0, 1, 300, 1);
  assert.equal(windowed.logicalWidth, 220);
  await React.act(async () => root.unmount());
  await window.happyDOM.close();
  console.log('PASS complete display semantics, keyed column metrics, runtime isolation, row-height/order, groups/spans, intrinsic sizing');
})().catch(error => { console.error(error); process.exitCode = 1; });
