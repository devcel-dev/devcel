// Production hooks/controls regression for explicit lint dependencies.
// IPC and DOM geometry are synthetic; this does not assert native rendering.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(project, '.table-lint-behavior-'));
const window = new Window({ url: 'http://table-lint.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'SVGElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'FocusEvent', 'InputEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'MutationObserver', 'ResizeObserver', 'DocumentFragment', 'DOMRect', 'CSS', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pending = [];
globalThis.__tableLintInvoke = (command, args) => {
  assert.equal(command, 'get_reference_options_command');
  const request = { command, args, ...deferred() };
  pending.push(request);
  return request.promise;
};
let root, React;
try {
  const boundaries = {
    '@tauri-apps/api/core': 'export const invoke=(...args)=>globalThis.__tableLintInvoke(...args); export const isTauri=()=>false;',
    '@tauri-apps/api/event': 'export const listen=async()=>()=>{}; export const emit=async()=>{}; export const emitTo=async()=>{};',
    '@/app/commands/tableCommands': 'export const getTableCatalog=async()=>[];',
    '@/app/applicationMode': 'export const isSettingsEditor=()=>true;',
  };
  const result = await build({
    absWorkingDir: project,
    stdin: { resolveDir: project, loader: 'ts', contents: `
      export { useGridSortLabels } from './src/app/pages/main_window/project_view/table_view/components/useGridSortLabels';
      export { useTableMutation } from './src/app/pages/main_window/project_view/table_view/components/useTableMutation';
      export { CurveEditor } from './src/app/pages/main_window/project_view/table_view/components/CurveEditor';
      export { VersionBadge } from './src/app/pages/main_window/project_view/table_view/components/VersionControls';
      export { GridColumnFilterButton } from './src/app/pages/main_window/project_view/table_view/components/GridFilterSortControls';
      export { shareDisplayValue } from './src/app/pages/main_window/project_view/table_view/components/gridDisplayModel';
      export { applyRuntimeLocalization, t } from './src/app/i18n';
    ` },
    bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' }, alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'table-lint-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'boundary' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: boundaries[args.path], loader: 'js' }));
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
    } }],
  });
  const file = resolve(temporary, 'table-lint.mjs');
  await writeFile(file, result.outputFiles[0].text);
  const { useGridSortLabels, useTableMutation, CurveEditor, VersionBadge, GridColumnFilterButton, shareDisplayValue, applyRuntimeLocalization, t } = await import(pathToFileURL(file));
  React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act, createElement: h } = React;
  const host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  const render = node => act(async () => root.render(node));
  const click = node => act(async () => { assert(node, 'click target'); node.click(); });
  const key = (node, value) => act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
  const input = (node, value) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const check = async (name, run) => { await run(); await render(null); console.log('PASS', name); };
  const column = { uuid: 'ref', data_type: 'Reference', reference_config: { target_table_uuid: 'target', display_column_uuid: 'name' } };

  await check('Sort-label scope invalidates snapshots, session and refresh; stale reads cannot restore old labels', async () => {
    let labels;
    const observations = [];
    function Harness(props) {
      labels = useGridSortLabels(props.table, props.session, props.sorts, props.refresh);
      observations.push(labels);
      return null;
    }
    let props = { table: { metadata: { uuid: 'table' }, schema: { columns: [column] } }, session: 'session-a', sorts: [{ columnUuid: 'ref', dataType: 'Reference' }], refresh: 0 };
    await render(h(Harness, props));
    assert.equal(pending.length, 1);
    await act(() => pending[0].resolve([{ uuid: 'record', display_value: 'first' }]));
    assert.equal(labels.get('ref').get('record'), 'first');
    const settled = labels;
    await render(h(Harness, props));
    assert.equal(labels, settled); assert.equal(pending.length, 1, 'unchanged inputs never refetch');
    props = { ...props, refresh: 1 };
    const beforeRefresh = observations.length;
    await render(h(Harness, props));
    assert.equal(observations[beforeRefresh], settled, 'same-scope verification keeps settled labels instead of sorting by raw UUIDs');
    props = { ...props, session: 'session-b' };
    await render(h(Harness, props));
    await act(() => pending[1].resolve([{ uuid: 'record', display_value: 'obsolete' }]));
    assert.equal(labels.size, 0);
    await act(() => pending[2].resolve([{ uuid: 'record', display_value: 'current' }]));
    assert.equal(labels.get('ref').get('record'), 'current');
    props = { ...props, table: { ...props.table } };
    await render(h(Harness, props));
    assert.equal(labels.get('ref').get('record'), 'current'); assert.equal(pending.length, 4, 'same-scope refresh retains display but still verifies labels');
    props = { ...props, sorts: [] };
    await render(h(Harness, props));
    await act(() => pending[3].resolve([{ uuid: 'record', display_value: 'removed sort' }]));
    assert.equal(labels.size, 0); assert.equal(pending.length, 4);
  });

  await check('Mutation action callbacks remain stable across error, busy and ordinary owner rerenders', async () => {
    let api;
    function Harness() { api = useTableMutation('table', 'session', () => {}); return null; }
    await render(h(Harness));
    const first = api;
    await render(h(Harness));
    for (const name of ['clearError', 'run', 'runExclusive', 'isBusy']) assert.equal(api[name], first[name]);
    await act(async () => { assert.equal(await api.run(async () => { throw Error('expected test rejection'); }), false); });
    assert(api.error.includes('expected test rejection'));
    for (const name of ['clearError', 'run', 'runExclusive', 'isBusy']) assert.equal(api[name], first[name]);
    await act(() => api.clearError()); assert.equal(api.error, '');
    const finish = deferred(); let running;
    await act(() => { running = api.run(async () => { await finish.promise; return null; }); });
    assert(api.busy); assert(api.isBusy());
    for (const name of ['clearError', 'run', 'runExclusive', 'isBusy']) assert.equal(api[name], first[name]);
    await act(async () => { finish.resolve(); await running; });
    assert.equal(api.busy, false); assert.equal(api.isBusy(), false);
  });

  await check('Sparse display arrays keep holes distinct from explicit undefined and preserve unchanged nested identities', async () => {
    const nested = { label: 'same' };
    const before = []; before.length = 5; before[1] = nested; before[4] = 'old';
    const after = []; after.length = 5; after[1] = { ...nested }; after[4] = 'new';
    const shared = shareDisplayValue(before, after);
    assert.equal(shared.length, 5); assert.equal(shared[1], nested);
    assert.deepEqual(Object.keys(shared), ['1', '4']); assert.equal(shared[4], 'new');
    const explicit = shareDisplayValue(shared, [undefined, nested]);
    assert.equal(explicit.length, 2); assert(Object.hasOwn(explicit, '0'));
  });

  await check('Curve drag freezes the range and releasing the same points recomputes it', async () => {
    let data = { points: [{ x: 0, y: 0, mode: 'auto' }, { x: 0.5, y: 0.5, mode: 'auto' }, { x: 1, y: 1, mode: 'auto' }] };
    const props = () => ({ data, startValue: 0, endValue: 1, onChange: () => {} });
    await render(h(CurveEditor, props()));
    const svg = host.querySelector('svg');
    svg.setPointerCapture = () => {}; svg.hasPointerCapture = () => false;
    const axis = () => [...svg.querySelectorAll('g text')].map(node => node.textContent);
    const initial = axis();
    await act(() => svg.querySelector('circle.cursor-move').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 })));
    data = { points: data.points.map((point, index) => index === 1 ? { ...point, y: 10 } : point) };
    await render(h(CurveEditor, props())); assert.deepEqual(axis(), initial);
    await act(() => svg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })));
    assert.notDeepEqual(axis(), initial, 'drag end invalidates even with unchanged points identity');
  });

  await check('Version input strict lifecycle still commits exactly once and unmount blurs the connected current node', async () => {
    const commits = [];
    const badge = h(React.StrictMode, null, h(VersionBadge, { value: 0, label: 'Version', messages: { invalid: 'invalid', saveFailed: 'failed' }, onCommit: async value => { commits.push(value); return true; } }));
    await render(badge); await click(host.querySelector('.version-badge'));
    await input(host.querySelector('input'), '7'); await key(host.querySelector('input'), 'Enter');
    assert.deepEqual(commits, [7]); assert.equal(host.querySelector('input'), null);
    await click(host.querySelector('.version-badge')); await input(host.querySelector('input'), '8');
    const field = host.querySelector('input'); const blur = field.blur.bind(field); let connected;
    field.blur = () => { connected = field.isConnected; blur(); };
    await render(null); assert.equal(connected, true); assert.deepEqual(commits, [7], 'unmount does not commit');
  });

  await check('Filter labels relocalize with stable rows, column and translator identities', async () => {
    const catalog = JSON.parse(await readFile(resolve(project, 'src/app/i18n/generated/catalog.json'), 'utf8'));
    const setLocale = locale => act(() => applyRuntimeLocalization(catalog, { locale, preference: locale, revision: locale, availableLocales: ['en', 'ja'] }));
    await setLocale('en'); const translator = t;
    const uuid = 'c898d96c-dbd2-5c77-8b94-576c70fc4834';
    const definition = { uuid, data_name: 'delimiter', display_name: 'Delimiter', data_type: 'String', select_options: [',', ';'], min_version: 0, tags: [], style: {}, tooltip: '', default_value: '' };
    const rows = [{ rowId: 'one', [uuid]: ',' }, { rowId: 'empty', [uuid]: '' }];
    const props = { column: definition, rows, sorts: [], onFilterChange() {}, onSortChange() {}, onOpenSort() {} };
    await render(h(GridColumnFilterButton, props)); await click(host.querySelector('.grid-fs-trigger'));
    const labels = () => [...document.querySelectorAll('.grid-fs-value-row')].map(node => node.textContent);
    const english = labels(); assert(english.length > 0);
    await setLocale('ja'); assert.equal(t, translator);
    assert.notDeepEqual(labels(), english, 'locale invalidates memoized labels without changing the translator');
  });
  console.log('Table lint behavior regressions passed. Native paint/layout and IPC are not asserted.');
} finally {
  if (root) await React.act(() => root.unmount());
  await window.happyDOM.close();
  await rm(temporary, { recursive: true, force: true });
  delete globalThis.__tableLintInvoke;
}
