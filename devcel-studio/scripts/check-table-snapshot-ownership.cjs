// Source regression scaffold. Run only after the correction commit stack is published.
// Real snapshot/cache/hook ownership, synthetic DOM and native IPC/event boundaries.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const studio = path.resolve(__dirname, '..');
const esbuild = require(path.join(studio, 'node_modules/esbuild'));
const { Window } = require(path.join(studio, 'node_modules/happy-dom'));
const work = fs.mkdtempSync(path.join(studio, '.snapshot-ownership-check-'));
const out = path.join(work, 'ownership.cjs');
const window = new Window({ url: 'http://snapshot-ownership.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const listeners = new Map();
const calls = [];
const table = { uuid: 'table-B', display_name: 'B' , metadata: { interface_order: [],  initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, data_name: 'B' }, schema: { columns: [] }, records: [] };
const presentation = text => ({ table_uuid: 'table-B', revision: 'root-r', cells: { row: { cell: { raw_value: '=dependency', display_value: text, style: {}, issues: [], formula_error: null, hint: '' } } }, definition_issues: [], issue_count: 0 });
const seed = { table, presentation: presentation('old dependency'), tableUuid: 'table-B', projectSessionId: 'session-A', snapshotToken: 'token-0', retainedBytes: 1024, invalidationVersion: 0 };
const bridge = globalThis.__snapshotOwnership = {
  seed, latest: null, injected: false, prepareDelay: null, response: null,
  sourceChange() { for (const callback of listeners.get('formula-sources-changed') || []) callback({ payload: { project_session: 'session-A' } }); },
  listen: async (event, callback) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); return () => listeners.get(event).delete(callback); },
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === 'prepare_table_rule_snapshot') return bridge.prepareDelay ? bridge.prepareDelay.promise : `evaluation-${calls.length}`;
    if (command === 'cancel_table_rule_snapshot') return true;
    if (command === 'get_table_rule_snapshot') return bridge.response ? bridge.response(args) : {
      kind: 'presentation', snapshot_token: 'token-1', retained_bytes: 1024, presentation: presentation('new dependency'),
    };
    throw new Error(`Unexpected native command ${command}`);
  },
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let root, tracker, React;
(async () => {
  await esbuild.build({ stdin: { resolveDir: studio, contents: `
    import React from 'react';
    import { useTablePresentation } from './src/app/pages/main_window/project_view/table_view/components/useTablePresentation';
    export * from './src/app/services/tableSnapshotCache';
    export * from './src/app/services/tableSnapshotInvalidation';
    export function Harness() {
      const b = globalThis.__snapshotOwnership;
      const [table, setTable] = React.useState(b.seed.table);
      const state = useTablePresentation(table, b.seed.projectSessionId, snapshot => {
        b.deliveries = [...(b.deliveries || []), snapshot]; setTable(snapshot.table);
      }, b.seed);
      b.table = table; b.setTable = setTable;
      b.latest = state;
      React.useLayoutEffect(() => {
        if (!b.injected) { b.injected = true; b.sourceChange(); b.closedImmediately = state.getCurrent() === null; }
      }, []);
      return null;
    }
  ` }, bundle: true, platform: 'node', format: 'cjs', outfile: out, external: ['react'], tsconfig: path.join(studio, 'tsconfig.json'), plugins: [{ name: 'native-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, args => ({ path: args.path.endsWith('core') ? 'core' : 'event', namespace: 'mock' }));
    builder.onResolve({ filter: /^@\/app\/i18n$/ }, () => ({ path: 'i18n', namespace: 'mock' }));
    builder.onResolve({ filter: /gridErrorNotice$/ }, () => ({ path: 'notice', namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ loader: 'js', contents: {
      core: 'export const invoke=(...args)=>globalThis.__snapshotOwnership.invoke(...args);',
      event: 'export const listen=(...args)=>globalThis.__snapshotOwnership.listen(...args);',
      i18n: 'export const useI18n=()=>({});export const message=key=>({key});export const localizedError=e=>new Error(e.key);',
      notice: 'export const gridErrorNotice=(_,error)=>error;export const resolveGridError=error=>error?.message||null;',
    }[args.path] }));
  } }] });
  const api = require(out);
  tracker = api.retainTableSnapshotInvalidation('session-A');
  await tracker.ready;
  const settingsEpoch = api.getTableSnapshotInvalidationVersion('session-A');
  for (const callback of listeners.get('settings-project-data-changed') || []) callback({ payload: { project_session: 'other-project', table_uuids: ['table-B'] } });
  assert.equal(api.getTableSnapshotInvalidationVersion('session-A'), settingsEpoch, 'settings transaction cannot invalidate another project session');
  for (const callback of listeners.get('settings-project-data-changed') || []) callback({ payload: { project_session: 'session-A', table_uuids: ['swatches32', 'swatchesFloat'] } });
  assert.equal(api.getTableSnapshotInvalidationVersion('session-A'), settingsEpoch + 1, 'a two-table settings transaction invalidates its own session once');
  React = require(path.join(studio, 'node_modules/react'));
  const { createRoot } = require(path.join(studio, 'node_modules/react-dom/client'));
  root = createRoot(document.createElement('div'));
  await React.act(async () => { root.render(React.createElement(api.Harness)); });
  for (let i = 0; i < 20 && !bridge.latest?.ready; i++) await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  assert(bridge.closedImmediately, 'a parent notification closes the seed write token before the view subscription effect');
  assert(bridge.latest.ready, 'post-subscription epoch recheck refreshes the seed');
  assert.equal(bridge.latest.presentation.cells.row.cell.display_value, 'new dependency');
  assert(calls.some(call => call.command === 'get_table_rule_snapshot'), 'render/effect notification gap requires a confirmed read');
  await React.act(async () => root.unmount()); root = null;

  bridge.response = () => ({ kind: 'snapshot', snapshot_token: 'token-full', retained_bytes: 1024, table, presentation: presentation('current') });
  const full = await api.requestTableSnapshot('table-B', 'session-A').promise;
  assert.equal(full.table.metadata.parent_uuid, '', 'snapshot normalizes omitted parent');
  const sparse = { ...table, schema: {columns:[{uuid:'c',data_name:'v',data_type:'String'}]}, records:[{uuid:'r',values:{}}] };
  const raw = JSON.stringify(sparse);
  bridge.response = () => ({kind:'snapshot',snapshot_token:'sparse',retained_bytes:1024,table:sparse,presentation:presentation('current')});
  const expanded = await api.requestTableSnapshot('table-B','session-A').promise;
  assert.equal(expanded.table.records[0].label,'');
  assert.deepEqual(expanded.table.records[0].memo_texts,{});
  assert.deepEqual(expanded.table.schema.columns[0].tags,[]);
  assert.equal(expanded.table.schema.columns[0].min_version,0);
  assert.equal(JSON.stringify(sparse),raw,'receive normalization never mutates wire payload');
  api.rememberTableSnapshot(full);
  bridge.response = () => ({ kind: 'unchanged', snapshot_token: 'token-full', retained_bytes: 1024 });
  const unchanged = await api.requestTableSnapshot('table-B', 'session-A', api.getTableSnapshot('session-A', 'table-B')).promise;
  assert.equal(unchanged.table, full.table); assert.equal(unchanged.presentation, full.presentation);
  await assert.rejects(api.requestTableSnapshot('table-B', 'session-A').promise, /grid\.snapshotInvalid/);

  // The mutation reply is authoritative but has no reusable native token.
  // A later save echo must verify dependencies without replacing equal DTOs.
  bridge.seed = { ...full, invalidationVersion: api.getTableSnapshotInvalidationVersion('session-A') };
  bridge.injected = true; bridge.deliveries = [];
  root = createRoot(document.createElement('div'));
  await React.act(async () => root.render(React.createElement(api.Harness)));
  const committedTable = { ...full.table, description: 'committed edit' };
  const committedPresentation = { ...full.presentation, revision: 'committed-revision' };
  await React.act(async () => {
    bridge.latest.accept(committedPresentation, committedTable);
    bridge.setTable(committedTable);
  });
  const echo = deferred(); bridge.response = () => echo.promise;
  await React.act(async () => bridge.sourceChange());
  assert.equal(bridge.latest.getCurrent(), null, 'watch invalidation still closes the write token immediately');
  assert(bridge.latest.backgroundRefreshing, 'automatic verification does not show a second foreground load');
  await React.act(async () => echo.resolve({ kind: 'snapshot', snapshot_token: 'after-save', retained_bytes: 1024,
    table: JSON.parse(JSON.stringify(committedTable)), presentation: JSON.parse(JSON.stringify(committedPresentation)) }));
  assert.equal(bridge.table, committedTable, 'self-save echo shares the committed table identity');
  assert.equal(bridge.latest.presentation, committedPresentation, 'self-save echo shares the committed presentation identity');
  assert(bridge.latest.ready);
  const obsolete = deferred(); bridge.response = () => obsolete.promise;
  await React.act(async () => bridge.sourceChange());
  const newerTable = { ...committedTable, description: 'rapid second edit' };
  const newerPresentation = { ...committedPresentation, revision: 'second-revision' };
  await React.act(async () => { bridge.latest.accept(newerPresentation, newerTable); bridge.setTable(newerTable); });
  await React.act(async () => obsolete.resolve({ kind: 'snapshot', snapshot_token: 'obsolete', retained_bytes: 1024,
    table: committedTable, presentation: committedPresentation }));
  assert.equal(bridge.table, newerTable, 'late pre-commit read never rolls back a rapid edit');
  const external = { ...newerTable, description: 'external edit' };
  bridge.response = () => ({ kind: 'snapshot', snapshot_token: 'external', retained_bytes: 1024,
    table: external, presentation: { ...newerPresentation, revision: 'external-revision' } });
  await React.act(async () => bridge.sourceChange());
  assert.equal(bridge.table.description, 'external edit', 'real external changes still replace the visible value');
  // Root revision may stay equal while formula/reference dependencies change.
  bridge.response = () => ({ kind: 'presentation', snapshot_token: 'dependency-change', retained_bytes: 1024,
    presentation: { ...bridge.latest.presentation, cells: presentation('changed dependency').cells } });
  await React.act(async () => bridge.sourceChange());
  assert.equal(bridge.latest.presentation.cells.row.cell.display_value, 'changed dependency');
  await React.act(async () => root.unmount()); root = null;

  const lateAck = deferred(); bridge.prepareDelay = lateAck;
  const readsBeforeCancel = calls.filter(call => call.command === 'get_table_rule_snapshot').length;
  const cancelled = api.requestTableSnapshot('table-B', 'session-A'); cancelled.cancel();
  lateAck.resolve('late-evaluation'); await assert.rejects(cancelled.promise, /cancelled/); bridge.prepareDelay = null;
  assert.equal(calls.filter(call => call.command === 'get_table_rule_snapshot').length, readsBeforeCancel);
  assert.equal(calls.filter(call => call.command === 'cancel_table_rule_snapshot' && call.args.evaluationId === 'late-evaluation').length, 1);

  const delayed = deferred(); bridge.response = () => delayed.promise;
  const inTransit = api.requestTableSnapshot('table-B', 'session-A', full);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  bridge.sourceChange(); delayed.resolve({ kind: 'unchanged', snapshot_token: 'token-full', retained_bytes: 1024 });
  const oldEpoch = await inTransit.promise;
  assert.notEqual(oldEpoch.invalidationVersion, api.getTableSnapshotInvalidationVersion('session-A'), 'in-transit dependency change remains observable to activation and seed acceptance');
  api.clearTableSnapshots('session-A');
  const forUuid = (uuid, bytes) => ({ ...full, tableUuid: uuid, table: { ...full.table, uuid }, presentation: { ...full.presentation, table_uuid: uuid }, retainedBytes: bytes });
  for (let i = 0; i < 9; i++) api.rememberTableSnapshot(forUuid(`table-${i}`, 1024));
  assert.equal(api.getTableSnapshot('session-A', 'table-0'), undefined, 'count-bound LRU retires oldest snapshot');
  api.clearTableSnapshots('session-A');
  api.rememberTableSnapshot(forUuid('large-A', 40 * 1024 * 1024));
  api.rememberTableSnapshot(forUuid('large-B', 40 * 1024 * 1024));
  assert.equal(api.getTableSnapshot('session-A', 'large-A'), undefined, 'logical retained-byte bound evicts the prior snapshot');
  console.log('PASS: notification render/effect gap, authoritative reference reuse, missing basis rejection, late ACK cancellation, in-transit epochs, bounded cache');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (root && React) await React.act(async () => root.unmount());
  tracker?.release(); await window.happyDOM.close(); fs.rmSync(work, { recursive: true, force: true }); delete globalThis.__snapshotOwnership;
});
