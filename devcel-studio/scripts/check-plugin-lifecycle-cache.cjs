// Integration check for the production lifecycle coordinator with a controlled native boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const studio = path.resolve(__dirname, '..');
const esbuild = require(path.join(studio, 'node_modules/esbuild'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-plugin-lifecycle-'));
const bundle = path.join(work, 'lifecycle.cjs');
const nativeListeners = new Map();
const timers = new Map();
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
let nextTimer = 0;
let project, rows, calls, failList, dataInterceptor;

const makeProject = sessionId => ({ sessionId, path: '/project', name: 'Project', description: '', headerColor: '' });
const makeTable = (id, description = id) => ({
  description,
  uuid: id, display_name: id, metadata: { interface_order: [],  initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, parent_uuid: '', data_name: id.toLowerCase() },
  interface_implementations: {}, schema: { columns: [{ min_version: 0, uuid: `${id}-column`, display_name: 'Value', data_name: 'value', data_type: 'String', tooltip: '', tags: [], read_only: false, default_value: '', style: { color: '#FFFFFF', font_size: 12, width: 100 }, memo_text: '', reference_config: null }] },
  records: [{ uuid: `${id}-record`, parent_uuid: '', label: 'One', min_version: 0, tags: [], values: { value: '日本語' }, interface_values: {}, memo_texts: {} }]
});
const entry = (id, data = makeTable(id)) => ({ uuid: id, path: `${id}.table.toml`, raw: JSON.stringify(data) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const setWorld = entries => { project = makeProject('session-A'); rows = new Map(entries.map(value => [value.uuid, value])); calls = []; failList = false; dataInterceptor = undefined; };
const emitNative = (event, payload = {}) => { for (const listener of nativeListeners.get(event) || []) listener({ payload }); };

global.__listen = async (event, handler) => {
  if (!nativeListeners.has(event)) nativeListeners.set(event, new Set());
  nativeListeners.get(event).add(handler);
  return () => nativeListeners.get(event).delete(handler);
};
global.__invoke = async (name, args = {}) => {
  calls.push({ name, args });
  if (name === 'get_plugin_projects') return project ? [{ ...project }] : [];
  assert.equal(args.expectedProjectSession, project.sessionId);
  if (name === 'get_table_list') {
    if (failList) { failList = false; throw new Error('list unavailable'); }
    return [...rows.values()].map(({ uuid, path }) => ({ uuid, path, display_name: uuid, data_name: uuid.toLowerCase() }));
  }
  if (name === 'get_plugin_table_snapshot') {
    const raw = rows.get(args.uuid)?.raw;
    if (dataInterceptor) await dataInterceptor(args.uuid);
    if (raw === undefined) throw new Error('table not found');
    const revision = require('node:crypto').createHash('sha256').update(raw).digest('hex');
    if (args.knownRevision === revision) return null;
    return { revision, data: raw };
  }
  throw new Error(`Unexpected native call ${name}`);
};
class ManagerBoundary {
  dispatched = [];
  handlers = new Map();
  hooks = new Map();
  activeTable = null;
  setHasProject(value) { this.hasProject = value; }
  setActiveTable(value) { this.activeTable = value; }
  getAPI() { return { app: { getState: () => ({ activeTable: this.activeTable }) } }; }
  on(event, handler) { this.handlers.set(event, handler); return () => this.handlers.delete(event); }
  async dispatchLifecycle(hook, event, payload) {
    this.dispatched.push({ hook, event, payload });
    this.handlers.get(event)?.(payload);
    await this.hooks.get(hook)?.(payload);
  }
  tableEvents() { return this.dispatched.filter(item => item.event.startsWith('table-')); }
}
function assertCache(lifecycle) {
  for (const value of lifecycle.tables.values()) {
    assert(!Object.hasOwn(value, 'data'), 'Parsed table graphs must not be retained in the lifecycle cache');
    assert.equal(typeof value.fingerprint, 'string');
    assert.equal(typeof value.revision, 'string');
  }
}
async function countParses(action) {
  const original = JSON.parse;
  let count = 0;
  JSON.parse = function (...args) { count++; return original(...args); };
  try { await action(); } finally { JSON.parse = original; }
  return count;
}

(async () => {
  await esbuild.build({ stdin: { contents: "export { PluginLifecycle } from './src/app/services/PluginLifecycle';", resolveDir: studio }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, tsconfig: path.join(studio, 'tsconfig.json'), plugins: [{ name: 'native-boundary', setup(build) {
    build.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, ({ path: name }) => ({ path: name.endsWith('/core') ? 'core' : 'event', namespace: 'native' }));
    build.onLoad({ filter: /.*/, namespace: 'native' }, ({ path: name }) => ({ contents: name === 'core' ? 'export const invoke = (...args) => globalThis.__invoke(...args);' : 'export const listen = (...args) => globalThis.__listen(...args);', loader: 'js' }));
  } }] });
  global.setInterval = fn => { const id = ++nextTimer; timers.set(id, fn); return id; };
  global.clearInterval = id => timers.delete(id);
  const { PluginLifecycle } = require(bundle);
  const makeLifecycle = async () => { const manager = new ManagerBoundary(); const lifecycle = new PluginLifecycle(manager); await lifecycle.start(); return { manager, lifecycle }; };

  setWorld([entry('A'), entry('B')]);
  const { manager, lifecycle } = await makeLifecycle();
  assert.equal(manager.tableEvents().length, 0, 'The initial/project-open baseline must not create tables');
  assertCache(lifecycle);
  const initialRevision = lifecycle.tables.get('A').revision;
  assert.equal(await countParses(() => lifecycle.refresh()), 0, 'Exact native/canonical equality must skip all table parsing');

  assert.equal(calls.at(-2).args.knownRevision, initialRevision, 'Unchanged polls send the accepted revision');

  const changedA = makeTable('A', 'updated');
  rows.get('A').raw = JSON.stringify(changedA);
  const previous = lifecycle.tables;
  manager.hooks.set('onTableUpdate', async () => {
    assert.equal(previous.size, 0, 'After commit, replaced old snapshots must be released before awaiting hooks');
    assertCache(lifecycle);
  });
  const startCalls = calls.length;
  await lifecycle.refresh('A');
  assert.deepEqual(calls.slice(startCalls).filter(call => call.name === 'get_plugin_table_snapshot').map(call => call.args.uuid), ['A']);
  assert.equal(manager.tableEvents().length, 1);
  assert.deepEqual(manager.tableEvents()[0].payload.data, changedA);
  assert.equal(manager.tableEvents()[0].payload.fingerprint, JSON.stringify(changedA));
  assert.equal(manager.tableEvents()[0].payload.projectSession, project.sessionId);
  assert(!Object.hasOwn(manager.tableEvents()[0].payload, 'revision'), 'Internal revision must not change event payload');
  assert.equal(manager.tableEvents()[0].payload.display_name, 'A');
  assert.equal(manager.tableEvents()[0].payload.data_name, 'a');
  manager.hooks.clear();
  await lifecycle.refresh();
  assert.equal(manager.tableEvents().length, 1, 'Duplicate save notifications must not duplicate hooks');

  rows.set('C', entry('C'));
  await lifecycle.refresh();
  assert.equal(manager.tableEvents().at(-1).event, 'table-created');
  assert.deepEqual(manager.tableEvents().at(-1).payload.data, makeTable('C'));
  rows.get('B').path = 'renamed.table.toml';
  await lifecycle.refresh('B');
  assert.equal(manager.tableEvents().at(-1).event, 'table-updated');
  assert.equal(manager.tableEvents().at(-1).payload.path, 'renamed.table.toml');

  // Differing native bytes still use the original JSON.parse/stringify equivalence.
  const normalized = makeTable('C', 'あ');
  normalized.schema.columns[0].constraints = { min_value: 1 };
  rows.get('C').raw = JSON.stringify(normalized);
  await lifecycle.refresh('C');
  const eventCount = manager.tableEvents().length;
  rows.get('C').raw = rows.get('C').raw.replace('"あ"', '"\\u3042"').replace('"min_value":1', '"min_value":1.0');
  assert.notEqual(rows.get('C').raw, lifecycle.tables.get('C').fingerprint);
  assert.equal(await countParses(() => lifecycle.refresh('C')), 1);
  assert.equal(manager.tableEvents().length, eventCount, 'Native escape/number spellings must not change semantic equality');
  assert.equal(lifecycle.tables.get('C').fingerprint, JSON.stringify(normalized));

  // A failed list must not consume any part of the prior baseline.
  const intact = lifecycle.tables;
  const beforeFailure = [...intact.entries()];
  failList = true;
  await assert.rejects(lifecycle.refresh(), /list unavailable/);
  assert.strictEqual(lifecycle.tables, intact);
  assert.deepEqual([...lifecycle.tables.entries()], beforeFailure);

  // Partial data-fetch failures and invalid JSON retain the exact last known snapshot.
  const oldB = lifecycle.tables.get('B').fingerprint;
  rows.get('A').raw = JSON.stringify(makeTable('A', 'changed before B failed'));
  dataInterceptor = async id => { if (id === 'B') throw new Error('transient read failure'); };
  await lifecycle.refresh();
  assert.equal(lifecycle.tables.get('B').fingerprint, oldB);
  dataInterceptor = undefined;
  const oldRevisionB = lifecycle.tables.get('B').revision;
  const validB = rows.get('B').raw;
  rows.get('B').raw = '{invalid JSON';
  await lifecycle.refresh('B');
  assert.equal(lifecycle.tables.get('B').fingerprint, oldB);
  assert.equal(lifecycle.tables.get('B').revision, oldRevisionB, 'Failed JSON parse must preserve the previous revision/fingerprint pair');
  rows.get('B').raw = validB;

  // No table subscribers existed when B was cached. Activate a delete subscriber
  // and delete immediately, before another fetch can establish a new baseline.
  let lateEvent, lateHook;
  manager.on('table-deleted', payload => { lateEvent = payload; });
  manager.hooks.set('onTableDelete', async payload => { lateHook = payload; });
  manager.activeTable = { uuid: 'B', projectSession: project.sessionId };
  rows.delete('B');
  await lifecycle.refresh();
  assert.deepEqual(lateEvent.data, JSON.parse(oldB));
  assert.deepEqual(lateHook.data, JSON.parse(oldB));
  assert.equal(lateEvent.fingerprint, oldB);
  assert.equal(lateEvent.path, 'renamed.table.toml');
  assert.equal(manager.activeTable, null);
  assert(!lifecycle.tables.has('B'));
  assertCache(lifecycle);
  lifecycle.stop();

  // Coalesce multiple refresh requests while a native read is in flight.
  setWorld([entry('A')]);
  const coalesced = await makeLifecycle();
  rows.get('A').raw = JSON.stringify(makeTable('A', 'coalesced'));
  const entered = deferred(), release = deferred();
  dataInterceptor = async () => { entered.resolve(); await release.promise; };
  const inFlight = coalesced.lifecycle.refresh('A');
  await entered.promise;
  void coalesced.lifecycle.refresh('A');
  void coalesced.lifecycle.refresh('A');
  release.resolve();
  await inFlight;
  assert.equal(coalesced.manager.tableEvents().length, 1);
  coalesced.lifecycle.stop();

  // Stop after a partial collection: the committed baseline must remain intact.
  setWorld([entry('A'), entry('B')]);
  const interrupted = await makeLifecycle();
  const originalCache = interrupted.lifecycle.tables;
  const originalEntries = [...originalCache.entries()];
  rows.get('A').raw = JSON.stringify(makeTable('A', 'must not commit'));
  const waiting = deferred(), unblock = deferred();
  dataInterceptor = async id => { if (id === 'B') { waiting.resolve(); await unblock.promise; } };
  const interruptedRead = interrupted.lifecycle.refresh();
  await waiting.promise;
  interrupted.lifecycle.stop();
  unblock.resolve();
  await interruptedRead;
  assert.strictEqual(interrupted.lifecycle.tables, originalCache);
  assert.deepEqual([...originalCache.entries()], originalEntries);
  assert.equal(interrupted.manager.tableEvents().length, 0);

  // Close/reopen while collecting table B: never publish a partial old-session
  // snapshot or lose the new session's subsequent deletion payload.
  setWorld([entry('A'), entry('B')]);
  const switched = await makeLifecycle();
  rows.get('A').raw = JSON.stringify(makeTable('A', 'obsolete session'));
  const switching = deferred(), resumed = deferred();
  dataInterceptor = async id => { if (id === 'B') { switching.resolve(); await resumed.promise; } };
  const switchingRead = switched.lifecycle.refresh();
  await switching.promise;
  project = makeProject('session-B');
  rows = new Map([['D', entry('D')]]);
  emitNative('project-opened');
  resumed.resolve();
  await switchingRead;
  assert.deepEqual([...switched.lifecycle.tables.keys()], ['D']);
  assert.equal(switched.manager.tableEvents().length, 0);
  assert.equal(switched.manager.dispatched.filter(item => item.event === 'project-closed').length, 1);
  assert.equal(switched.manager.dispatched.filter(item => item.event === 'project-opened').length, 2);
  rows.clear();
  await switched.lifecycle.refresh();
  const deletedD = switched.manager.tableEvents().at(-1);
  assert.equal(deletedD.event, 'table-deleted');
  assert.equal(deletedD.payload.projectSession, 'session-B');
  assert.deepEqual(deletedD.payload.data, makeTable('D'));
  switched.lifecycle.stop();
  assert.equal(timers.size, 0);
  assert.equal([...nativeListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0);
  console.log('PASS: canonical-only lifecycle cache, exact no-op fast path, complete create/update/delete payloads, late delete subscribers, coalescing, fetch/list failure, stop and project/session interruption');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
  fs.rmSync(work, { recursive: true, force: true });
});
