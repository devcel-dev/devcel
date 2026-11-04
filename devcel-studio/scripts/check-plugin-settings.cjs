// Integration probe: production settings consumer, bridge queue, manager and package transactions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const studio = path.resolve(__dirname, '..');
const esbuild = require(path.join(studio, 'node_modules/esbuild'));
const { Window } = require(path.join(studio, 'node_modules/happy-dom'));
const dom = new Window({ url: 'http://plugin-settings.invalid/' });
for (const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLSelectElement','Element','Node','Event','CustomEvent','KeyboardEvent','MouseEvent','PointerEvent','MutationObserver','ResizeObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key) ? dom[key].bind(dom) : dom[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-plugin-settings-'));
const file = path.join(work, 'plugin-settings.cjs');
const storage = new Map(), watchers = new Set(), localeWatchers = new Set(), events = new Map();
const calls = [], log = [];
global.__notifications = [];
let packages = [], nextRevision = 1, onStart = async () => {}, listGate, installCandidate;
const history = new Map(), removed = new Map();
const timers = new Map();
const realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
let timerId = 0;
global.setInterval = (callback, interval) => { assert.equal(interval, 10_000); const id = ++timerId; timers.set(id, callback); return id; };
global.clearInterval = id => timers.delete(id);
global.__settings = { appVersion: '0.1.0', generation: 'generation-1', revision: 'r1', bundle: {
  pluginStates: { 'csv-exporter': false },
  pluginSettings: { 'csv-exporter': { settings: { defaultDelimiter: ',', defaultEncoding: 'utf-8' } } }
}};
global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
global.__watchLocale = callback => { localeWatchers.add(callback); return () => localeWatchers.delete(callback); };
global.__watchSettings = callback => { watchers.add(callback); return () => watchers.delete(callback); };
global.__listen = async (name, callback) => { const set = events.get(name) || new Set(); set.add(callback); events.set(name, set); return () => set.delete(callback); };
global.__emit = async (name, payload) => { for (const callback of events.get(name) || []) await callback({ payload }); };
global.__pluginLog = log;
global.__startHook = async id => onStart(id);
const metadata = (id, dependencies = {}) => ({ id, name: id, version: '1.0.0', apiVersion: '2.0.0', devcelVersion: '>=' + require('../src-tauri/tauri.conf.json').version, author: 'Probe', description: 'Probe', dependencies });
const item = (id, dependencies = {}, approved = true, enabled = true, digest = id + '-1') => ({ metadata: metadata(id, dependencies), permissions: ['full-app-access'], digest, approved, enabled, canRollback: false, rollbackDigest: null });
const code = entry => `globalThis.__pluginLog.push('evaluate:${entry.metadata.id}:${entry.digest}'); module.exports = {metadata:${JSON.stringify(entry.metadata)},hooks:{onInstall:async()=>{globalThis.__pluginLog.push('install:${entry.metadata.id}')}},activate:async()=>{globalThis.__pluginLog.push('start:${entry.metadata.id}');await globalThis.__startHook('${entry.metadata.id}')},deactivate:async()=>{globalThis.__pluginLog.push('stop:${entry.metadata.id}')}};`;
global.__invoke = async (name, args = {}) => {
  calls.push({ name, args: structuredClone(args) });
  if (name === 'list_installed_plugin_packages') { if (listGate) await listGate(); return structuredClone(packages); }
  if (name === 'list_removed_plugin_packages') return structuredClone([...removed.values()]);
  if (name === 'preview_plugin_package') return { ...structuredClone(installCandidate), compatible: true, conflict: 'update' };
  if (name === 'install_plugin_package') {
    assert.equal(args.expectedDigest, installCandidate.digest);
    const index = packages.findIndex(value => value.metadata.id === installCandidate.metadata.id);
    if (index >= 0) history.set(installCandidate.metadata.id, structuredClone(packages[index]));
    const next = { ...structuredClone(installCandidate), approved: false, enabled: false, canRollback: index >= 0, rollbackDigest: history.get(installCandidate.metadata.id)?.digest ?? null };
    if (index >= 0) packages[index] = next; else packages.push(next);
    return structuredClone(next);
  }
  if (name === 'rollback_plugin_package') {
    const index = packages.findIndex(value => value.metadata.id === args.pluginId);
    assert.equal(args.expectedDigest, index >= 0 ? packages[index].digest : null);
    const old = index >= 0 ? history.get(args.pluginId) : removed.get(args.pluginId);
    assert(old); assert.equal(args.expectedRestoreDigest, old.digest);
    const current = index >= 0 ? structuredClone(packages[index]) : undefined;
    const restored = { ...old, enabled: false, canRollback: !!current, rollbackDigest: current?.digest ?? null };
    if (index >= 0) { history.set(args.pluginId, current); packages[index] = restored; }
    else { packages.push(restored); removed.delete(args.pluginId); }
    return structuredClone(restored);
  }
  if (name === 'remove_plugin_package') {
    const index = packages.findIndex(value => value.metadata.id === args.pluginId);
    assert(index >= 0); assert.equal(args.expectedDigest, packages[index].digest);
    removed.set(args.pluginId, structuredClone(packages[index])); packages.splice(index, 1); return;
  }
  const current = packages.find(value => value.metadata.id === args.pluginId);
  if (name === 'get_installed_plugin_source') {
    assert(current?.approved && current.enabled, 'source must be approved and armed');
    assert.equal(args.expectedDigest, current.digest);
    return { metadata: current.metadata, code: code(current), digest: current.digest, trusted: true };
  }
  if (name === 'set_plugin_package_enabled') {
    assert(current); assert.equal(args.expectedDigest, current.digest, 'permission mutation is digest-bound');
    if (args.enabled) assert(current.approved, 'permission cannot grant approval');
    current.enabled = args.enabled; return;
  }
  if (name === 'approve_plugin_package') {
    assert(current); assert.equal(args.digest, current.digest); assert.equal(args.allowFullAppAccess, true);
    current.approved = true; return structuredClone(current);
  }
  throw new Error('Unexpected native command ' + name);
};
function select(values) {
  global.__settings = { ...global.__settings, revision: 'r' + ++nextRevision,
    bundle: { ...global.__settings.bundle, pluginStates: { ...global.__settings.bundle.pluginStates, ...values } } };
  for (const fn of watchers) fn();
}
const defer = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
(async () => {
  await esbuild.build({ stdin: { contents: `export {MenuBar} from './src/app/components/common/MenuBar'; export * as React from 'react'; export {createRoot} from 'react-dom/client'; export {collectPluginExtensions} from './src/app/contexts/PluginContext'; export {PluginManager} from './src/app/services/PluginManager'; export {PluginBridge} from './src/app/services/PluginBridge'; export {pluginRuntimePlan} from './src/app/services/pluginRuntimePlan'; export {pluginSettings,scopedPluginSettings} from './src/app/settings/pluginSettings';`, resolveDir: studio },
    bundle: true, platform: 'node', format: 'cjs', outfile: file, tsconfig: path.join(studio, 'tsconfig.json'), plugins: [{ name: 'native-boundary', setup(build) {
      const modules = {
        '@/app/settings': `export const getSettingsSnapshot=()=>globalThis.__settings;export const subscribeSettings=callback=>globalThis.__watchSettings(callback);export const initializeAppSettings=async()=>{};export const refreshAppSettings=async()=>{};`,
        '@/app/i18n': `export const t=k=>k;export const message=(key,args)=>({key,args});export const localizeError=e=>e?.text??e?.message??JSON.stringify(e);export const toAppError=e=>e?.kind?e:({kind:'text',text:localizeError(e)});export const appErrorException=e=>Object.assign(new Error(localizeError(e)),{appError:e});export const localizedError=e=>new Error(e.key);export const getLocale=()=>"en";export const subscribeLocale=callback=>globalThis.__watchLocale(callback);export const useI18n=()=>({locale:"en"});export const registerPluginMessages=()=>()=>{};export const translatePluginMessage=(_,key)=>key;`,
        '@tauri-apps/plugin-dialog': `export const message=async(value,options)=>globalThis.__notifications.push({value,options});export const ask=async()=>false;export const open=async()=>null;export const save=async()=>null;`,
        '@/app/services/appDialogs': `export const message=async(value,options)=>globalThis.__notifications.push({value,options});export const ask=async()=>false;export const open=async()=>null;export const save=async()=>null;export const appAlert=message;export const appConfirm=ask;export const appPrompt=async(...args)=>globalThis.prompt?.(...args)??null;`,
        '@tauri-apps/api/core': `export const invoke=(...args)=>globalThis.__invoke(...args);export class Resource{};export class Channel{};`,
        '@tauri-apps/api/event': `export const listen=(...args)=>globalThis.__listen(...args);export const emit=(...args)=>globalThis.__emit(...args);export const emitTo=(_,name,payload)=>globalThis.__emit(name,payload);`,
        '@tauri-apps/api/webviewWindow': `export const getCurrentWebviewWindow=()=>({label:'main'});export class WebviewWindow{};`,
        '@/app/applicationMode': `export const isSettingsEditor=()=>false;`,
        '@/components/ui/dialog': `export const Dialog=()=>null,DialogContent=()=>null,DialogHeader=()=>null,DialogTitle=()=>null;`,
        '@/app/utils/options': `export const showOptions=async()=>{};`,
      };
      build.onResolve({ filter: /.*/ }, args => modules[args.path] ? { path: args.path, namespace: 'probe' } : undefined);
      build.onResolve({ filter: /AdvancedCSVExportDialog$/ }, () => ({ path: 'csv-modal', namespace: 'probe' }));
      build.onResolve({ filter: /\.\/PluginLifecycle$/ }, () => ({ path: 'lifecycle', namespace: 'probe' }));
      build.onLoad({ filter: /.*/, namespace: 'probe' }, args => ({ contents: modules[args.path] || (args.path === 'csv-modal' ? 'export const AdvancedCSVExportDialog=()=>null;' : 'export class PluginLifecycle{async start(){} stop(){}}'), loader: 'js' }));
    }}] });
  const { MenuBar, React, createRoot, collectPluginExtensions, PluginManager, PluginBridge, pluginRuntimePlan, pluginSettings: unscopedSettings, scopedPluginSettings } = require(file);
  const pluginSettings = scopedPluginSettings('csv-exporter');
  const coded = (code, params) => error => { assert.deepEqual(error.appError, { kind: 'code', code, params }); return true; };
  assert.throws(() => unscopedSettings.get('settings.defaultDelimiter'), coded('plugin.settings.error.ownerRequired', {}));
  const bridge = PluginBridge.getInstance(), manager = PluginManager.getInstance();
  const settle = async () => { await Promise.resolve(); await bridge.request('reconcileSettings'); };
  await bridge.connect();
  assert.equal(manager.getActivePlugins().size, 0);
  assert.equal(pluginSettings.get('settings.defaultDelimiter'), ',');
  assert.equal(manager.getPlugin('hello-world'), undefined, 'the retired sample is not registered');
  assert.throws(() => pluginSettings.get('hello.greeting'), coded('plugin.settings.error.key', {owner:'csv-exporter',key:'hello.greeting'}), 'the retired sample settings are not exposed');
  assert.equal('set' in pluginSettings, false);
  assert.deepEqual(scopedPluginSettings('csv-exporter').getAll(), {'settings.defaultDelimiter':',', 'settings.defaultEncoding':'utf-8'});
  assert.deepEqual(scopedPluginSettings('unknown').getAll(), {});
  global.__settings.bundle.pluginSettings['fixture-a'] = { preferences: { title: 'Alpha', count: 1 } };
  global.__settings.bundle.pluginSettings['fixture-b'] = { preferences: { title: 'Beta', count: 2 } };
  const ownerA = scopedPluginSettings('fixture-a'), ownerB = scopedPluginSettings('fixture-b');
  assert.equal(ownerA.get('preferences.title'), 'Alpha'); assert.equal(ownerB.get('preferences.title'), 'Beta');
  assert.equal(Object.isFrozen(ownerA.getTable('preferences')), true);
  assert.throws(() => ownerA.getTable('fixture-b'), coded('plugin.settings.error.singletonTable', {owner:'fixture-a',table:'fixture-b'}));
  assert.throws(() => ownerA.getTable('__proto__'), coded('plugin.settings.error.singletonTable', {owner:'fixture-a',table:'__proto__'}));
  assert.throws(() => scopedPluginSettings('__proto__').getTable('preferences'), coded('plugin.settings.error.singletonTable', {owner:'__proto__',table:'preferences'}));
  global.__settings.bundle.pluginSettings['fixture-a'].profiles = [{ id:'profile-one',values:{name:'One',enabled:true} }];
  assert.deepEqual(ownerA.getRows('profiles'),[{ id:'profile-one',values:{name:'One',enabled:true} }]);
  assert.equal(Object.isFrozen(ownerA.getRows('profiles')[0].values),true);
  assert.throws(()=>ownerA.getTable('profiles'), coded('plugin.settings.error.singletonTable', {owner:'fixture-a',table:'profiles'}));
  assert.throws(()=>ownerA.getRows('preferences'), coded('plugin.settings.error.rowsTable', {owner:'fixture-a',table:'preferences'}));
  const rowChanges=[];const stopRows=ownerA.watchRows('profiles',rows=>rowChanges.push(rows));
  global.__settings.bundle.pluginSettings['fixture-a'].profiles.push({id:'profile-two',values:{name:'Two',enabled:false}});select({});
  assert.equal(rowChanges[0].length,2);stopRows();
  const tableChanges=[]; const stopTable=ownerA.watchTable('preferences',value=>tableChanges.push(value));
  global.__settings.bundle.pluginSettings['fixture-a'].preferences.title='Edited'; select({});
  assert.deepEqual(tableChanges,[{title:'Edited',count:1}]);stopTable();
  assert.equal(ownerB.get('preferences.title'),'Beta');

  assert.throws(() => scopedPluginSettings('csv-exporter').get('hello.greeting'), coded('plugin.settings.error.key', {owner:'csv-exporter',key:'hello.greeting'}));
  assert.throws(() => scopedPluginSettings('unknown').watch('settings.defaultDelimiter', () => {}), coded('plugin.settings.error.key', {owner:'unknown',key:'settings.defaultDelimiter'}));
  assert.throws(() => pluginSettings.get('unknown.plugin.key'), coded('plugin.settings.error.key', {owner:'csv-exporter',key:'unknown.plugin.key'}));
  let watched = []; const off = pluginSettings.watch('settings.defaultDelimiter', value => watched.push(value));
  global.__settings.bundle.pluginSettings['csv-exporter'].settings.defaultDelimiter = ';'; select({}); await settle();
  assert.deepEqual(watched, [';']); off();
  // A test-only menu exercises managed callbacks without shipping a demo plugin.
  const settingsFixture = manager.getPlugin('csv-exporter').plugin;
  let settingsApi = null;
  settingsFixture.extensions = { menus: { 'settings-probe': { groups: [{ id: 'settings', actions: [{
    label: 'Current delimiter', onClick: () => settingsApi?.ui.executeCommand('probe.currentDelimiter')
  }] }] } } };
  settingsFixture.hooks = { onActivate: async api => api.ui.registerCommand('probe.currentDelimiter', () =>
    api.ui.showNotification(api.settings.get('settings.defaultDelimiter'), 'info')) };
  settingsFixture.activate = async api => { settingsApi = api; };
  settingsFixture.deactivate = async () => { settingsApi = null; };
  select({ 'csv-exporter': true }); await settle();
  const settingsAction = collectPluginExtensions(manager.getPlugins()).menus.get('csv-exporter:settings-probe').groups[0].actions[0];
  await settingsAction.onClick();
  assert.equal(global.__notifications.at(-1).value, ';');
  global.__settings.bundle.pluginSettings['csv-exporter'].settings.defaultDelimiter = '|';
  select({});
  await settingsAction.onClick();
  assert.equal(global.__notifications.at(-1).value, '|', 'already-rendered menu reads the new cell value without reactivation');
  const beforeDisabledSetting = global.__notifications.length;
  select({ 'csv-exporter': false });
  await assert.rejects(settingsAction.onClick(), /inactive/);
  assert.equal(global.__notifications.length, beforeDisabledSetting);
  await settle();
  const afterStopSetting = global.__notifications.length;
  await settingsFixture.extensions.menus['settings-probe'].groups[0].actions[0].onClick();
  assert.equal(global.__notifications.length, afterStopSetting, 'deactivation clears the retained API');
  const meta = new Map([['a', metadata('a', { b: '*' })], ['b', metadata('b')]]);
  assert.deepEqual(pluginRuntimePlan(meta, id => id === 'a', () => true).order, []);
  assert.deepEqual(pluginRuntimePlan(meta, () => true, () => true).order, ['b', 'a']);

  packages = [item('b'), item('a', { b: '*' })];
  select({ a: true, b: false }); await settle();
  assert.equal(log.length, 0, 'disabled dependency blocks even source evaluation');
  select({ b: true }); await settle();
  assert.deepEqual(log.filter(x => x.startsWith('start:')), ['start:b', 'start:a']);
  const permissionWrites = () => calls.filter(x => x.name === 'set_plugin_package_enabled').length;
  assert.equal(permissionWrites(), 0, 'ordinary activation does not arm packages');
  select({ b: false }); await settle();
  assert.deepEqual(log.filter(x => x.startsWith('stop:')), ['stop:a', 'stop:b']);
  assert(packages.every(x => x.enabled), 'ordinary false preserves installation latches');
  assert.equal(global.__settings.bundle.pluginStates.a, true, 'dependent selection is retained');
  select({ b: true }); await settle(); assert.equal(manager.getActivePlugins().size, 2);
  assert.equal(permissionWrites(), 0);

  // Replacement/rollback-style state: a still-true table cannot rearm an installation.
  packages[1] = item('a', { b: '*' }, true, false, 'a-restored');
  await settle(); assert.notEqual(manager.getPlugin('a')?.status, 'active');
  assert(!log.includes('evaluate:a:a-restored'));
  select({ a: false }); await settle();
  await bridge.request('packageActivate', { id: 'a', digest: 'a-restored', allowFullAppAccess: false });
  assert(packages[1].enabled); assert(!log.includes('evaluate:a:a-restored'), 'explicit permission does not override false');
  select({ a: true }); await settle(); assert.equal(manager.getPlugin('a').status, 'active');
  assert(log.includes('evaluate:a:a-restored'));

  packages.push(item('untrusted', {}, false, false)); select({ untrusted: true }); await settle();
  assert(!calls.some(x => x.name === 'approve_plugin_package'));
  assert(!calls.some(x => x.name === 'get_installed_plugin_source' && x.args.pluginId === 'untrusted'));
  await assert.rejects(bridge.request('packageActivate', { id: 'untrusted' }), /approvalRequired/);
  await bridge.request('packageActivate', { id: 'untrusted', digest: 'untrusted-1', allowFullAppAccess: true });
  assert.equal(manager.getPlugin('untrusted').status, 'active');
  await bridge.request('packageDeactivate', { id: 'untrusted' });
  assert.equal(global.__settings.bundle.pluginStates.untrusted, true);
  assert.equal(packages[2].enabled, false);
  assert.notEqual(manager.getPlugin('untrusted').status, 'active');

  packages.push(item('switch')); select({ switch: true }); await settle();
  assert.equal(manager.getPlugin('switch').status, 'active');
  installCandidate = item('switch', {}, false, false, 'switch-2');
  await bridge.request('packageInstall', { path: '/fixture/plugin.zip', expectedDigest: 'switch-2', conflictPolicy: 'replace' });
  assert.equal(global.__settings.bundle.pluginStates.switch, true);
  assert.equal(packages.find(p => p.metadata.id === 'switch').enabled, false);
  assert(!log.includes('evaluate:switch:switch-2'), 'install cannot run replacement from an old true selection');
  await bridge.request('packageActivate', { id: 'switch', digest: 'switch-2', allowFullAppAccess: true });
  assert.equal(manager.getPlugin('switch').status, 'active');
  const startsBeforeRollback = log.filter(value => value === 'start:switch').length;
  await bridge.request('packageRollback', { id: 'switch', expectedDigest: 'switch-2', expectedRestoreDigest: 'switch-1' });
  assert.equal(packages.find(p => p.metadata.id === 'switch').digest, 'switch-1');
  assert.equal(packages.find(p => p.metadata.id === 'switch').enabled, false);
  assert.equal(log.filter(value => value === 'start:switch').length, startsBeforeRollback, 'rollback does not run an old true selection');
  assert.equal(global.__settings.bundle.pluginStates.switch, true);

  // Failed candidate recovery is bound to both the candidate and the recorded restore content.
  packages.push(item('failed-update')); select({ 'failed-update': true }); await settle();
  installCandidate = item('failed-update', {}, false, false, 'failed-update-2');
  await bridge.request('packageInstall', { path: '/fixture/failed.zip', expectedDigest: 'failed-update-2', conflictPolicy: 'replace' });
  let failCandidate = true;
  onStart = async id => { if (id === 'failed-update' && failCandidate) { failCandidate = false; throw Error('candidate failure'); } };
  await assert.rejects(bridge.request('packageActivate', { id: 'failed-update', digest: 'failed-update-2', allowFullAppAccess: true }), /activationReverted/);
  assert.deepEqual(calls.filter(call => call.name === 'rollback_plugin_package').at(-1).args,
    { pluginId:'failed-update', expectedDigest:'failed-update-2', expectedRestoreDigest:'failed-update-1' });
  assert.equal(packages.find(item => item.metadata.id === 'failed-update').digest, 'failed-update-1');
  onStart = async () => {};

  // UI-confirmed identities are checked before stop/uninstall hooks, then forwarded to native CAS.
  packages.push({ ...item('cas'), canRollback: true, rollbackDigest: 'cas-old' });
  history.set('cas', item('cas', {}, true, false, 'cas-old'));
  select({ cas: true }); await settle();
  const beforeStale = log.length, beforeNative = calls.length;
  await assert.rejects(bridge.request('packageRemove', { id: 'cas', expectedDigest: 'cas-wrong' }), /packageChanged/);
  await assert.rejects(bridge.request('packageRollback', { id: 'cas', expectedDigest: 'cas-wrong', expectedRestoreDigest: 'cas-old' }), /packageChanged/);
  await assert.rejects(bridge.request('packageRollback', { id: 'cas', expectedDigest: 'cas-1', expectedRestoreDigest: 'wrong-history' }), /packageChanged/);
  await assert.rejects(bridge.request('uninstall', { id: 'cas' }), /packageChanged/);
  assert.equal(log.length, beforeStale, 'stale confirmation cannot run stop/uninstall hooks');
  assert(!calls.slice(beforeNative).some(call => ['remove_plugin_package','rollback_plugin_package'].includes(call.name)));
  await bridge.request('packageRemove', { id: 'cas', expectedDigest: 'cas-1' });
  assert(!packages.some(item => item.metadata.id === 'cas'));
  const beforeRestore = log.length;
  await assert.rejects(bridge.request('packageRollback', { id: 'cas', expectedDigest: null, expectedRestoreDigest: 'wrong-removed' }), /packageChanged/);
  await bridge.request('packageRollback', { id: 'cas', expectedDigest: null, expectedRestoreDigest: 'cas-1' });
  assert.equal(packages.find(item => item.metadata.id === 'cas').enabled, false);
  assert.equal(log.length, beforeRestore, 'restoring removed content does not execute an old true selection');

  // Real managed callback registrations remain blocked before the native list read resolves.
  const callbackLog = [];
  const hit = name => (...args) => { callbackLog.push(name); return name === 'getOptions' ? [] : true; };
  const fixture = manager.getPlugin('csv-exporter').plugin;
  fixture.hooks = { onProjectOpen: hit('hook') };
  fixture.extensions = { exporters: [{ id: 'probe', getOptions: hit('getOptions'), export: hit('export') }],
    toolbarButtons: [{ id: 'probe', isVisible: hit('isVisible'), isEnabled: hit('isEnabled'), onClick: hit('onClick') }] };
  fixture.activate = async api => {
    api.events.on('probe-lifecycle', hit('event'));
    api.events.once('probe-once', hit('once'));
    api.settings.watch('settings.defaultDelimiter', hit('watch'));
    api.i18n.subscribe(hit('locale'));
    api.ui.registerCommand('probe.command', hit('command'));
  };
  fixture.deactivate = async () => {};
  select({ 'csv-exporter': true }); await settle(); await bridge.refreshRunning;
  const extensions = collectPluginExtensions(manager.getPlugins());
  const exporter = extensions.exporters.find(item => item.id === 'csv-exporter:probe');
  const button = extensions.toolbarButtons.find(item => item.id === 'csv-exporter:probe');
  await bridge.request('snapshot');
  assert.deepEqual(callbackLog.sort(), ['getOptions', 'isEnabled', 'isVisible']); callbackLog.length = 0;
  const callbackReadStarted = defer(), callbackReadResume = defer();
  listGate = async () => { callbackReadStarted.resolve(); await callbackReadResume.promise; };
  global.__settings.bundle.pluginSettings['csv-exporter'].settings.defaultDelimiter = ',';
  select({ 'csv-exporter': false }); await callbackReadStarted.promise;
  assert.equal(manager.getPlugin('csv-exporter').status, 'active', 'reconciliation is still waiting');
  assert.equal(manager.canRun('csv-exporter'), false);
  const blockedSnapshot = await bridge.request('snapshot');
  const blockedExtensions = blockedSnapshot.plugins.find(item => item.id === 'csv-exporter').extensions;
  assert.deepEqual(blockedExtensions.exporters[0].optionValues, []);
  assert.equal(blockedExtensions.toolbarButtons[0].isVisibleValue, false);
  assert.equal(blockedExtensions.toolbarButtons[0].isEnabledValue, false);
  assert.deepEqual(exporter.getOptions(), []);
  assert.equal(button.isVisible(), false); assert.equal(button.isEnabled(), false);
  await assert.rejects(exporter.export({}), /inactive/);
  await assert.rejects(button.onClick(), /inactive/);
  await assert.rejects(manager.getAPI().ui.executeCommand('probe.command'), /inactive/);
  const token = blockedExtensions.exporters[0].export.__pluginCallback;
  await assert.rejects(bridge.request('callback', { token, values: [{}] }), /inactive/);
  await manager.dispatchLifecycle('onProjectOpen', 'probe-lifecycle', {});
  manager.getAPI().events.emit('probe-once');
  for (const fn of localeWatchers) fn();
  assert.deepEqual(callbackLog, [], 'no managed callback begins after false while native reconciliation is waiting');
  // Resume before stopping: the blocked event did not consume once. No change is replayed.
  select({ 'csv-exporter': true });
  manager.getAPI().events.emit('probe-once'); manager.getAPI().events.emit('probe-once');
  assert.deepEqual(callbackLog, ['once']);
  global.__settings.bundle.pluginSettings['csv-exporter'].settings.defaultDelimiter = ';'; select({});
  for (const fn of localeWatchers) fn();
  await manager.dispatchLifecycle('onProjectOpen', 'probe-lifecycle', {});
  await manager.getAPI().ui.executeCommand('probe.command');
  assert.deepEqual(callbackLog, ['once', 'watch', 'locale', 'event', 'hook', 'command']);
  listGate = undefined; callbackReadResume.resolve(); await bridge.refreshRunning; await settle();
  select({ 'csv-exporter': false }); await settle();
  const afterStop = callbackLog.length;
  manager.getAPI().events.emit('probe-lifecycle'); manager.getAPI().events.emit('probe-once');
  for (const fn of localeWatchers) fn();
  assert.equal(callbackLog.length, afterStop, 'stopped subscriptions are released');

  const started = defer(), resume = defer();
  onStart = async id => { if (id === 'slow') { started.resolve(); await resume.promise; } };
  packages.push(item('slow')); select({ slow: true });
  const inFlight = settle(); await started.promise;
  select({ slow: false }); resume.resolve(); await inFlight; await settle();
  assert.notEqual(manager.getPlugin('slow').status, 'active', 'late activation cannot restore disabled state');
  assert.equal(packages.find(p => p.metadata.id === 'slow').enabled, true);
  await bridge.refreshRunning;
  assert.equal(timers.size, 1, 'one cross-process permission timer');
  const readStarted = defer(), readResume = defer();
  listGate = async () => { readStarted.resolve(); await readResume.promise; };
  const reads = () => calls.filter(call => call.name === 'list_installed_plugin_packages').length;
  const beforeReads = reads();
  const tick = [...timers.values()][0]; tick(); await readStarted.promise;
  for (let count = 0; count < 20; count++) tick();
  assert.equal(reads(), beforeReads + 1, 'refreshes do not accumulate native calls behind a blocked read');
  listGate = undefined; readResume.resolve(); await bridge.refreshRunning;
  assert.equal(reads(), beforeReads + 2, 'twenty timer ticks coalesce to one pending refresh');
  // Permission polling reads every time, but unchanged values do not replace registry/menu state.
  packages.push(item('poll-metadata', {}, true, true));
  await settle(); await bridge.refreshRunning;
  let notices = 0, menuEntries;
  const offNotices = bridge.subscribe(() => { notices++; });
  const initialEntries = manager.getPlugins();
  const identities = new Map([...initialEntries].map(([id, entry]) => [id, { entry, settings: entry.settings, error: entry.error }]));
  function PollMenu() {
    const [entries, setEntries] = React.useState(initialEntries);
    React.useEffect(() => bridge.subscribe(() => setEntries(manager.getPlugins())), []);
    menuEntries = entries;
    const config = React.useMemo(() => ({ groups: [{ id:'plugins', label:'Plugins', actions: [...entries].map(([id]) => ({ label:id, onClick:()=>{} })) }] }), [entries]);
    return React.createElement(MenuBar, { menuConfig:config, textColor:'#000', hoverBgClass:'' });
  }
  const menuHost = document.createElement('div'); document.body.append(menuHost);
  const menuRoot = createRoot(menuHost);
  await React.act(async () => { menuRoot.render(React.createElement(PollMenu)); });
  await React.act(async () => {
    menuHost.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  const openMenu = document.querySelector('[role="menu"]'); assert(openMenu, 'production menu is open');
  const beforePollReads = reads();
  // Native list order/object-key order is not a semantic change.
  packages = packages.reverse().map(item => Object.fromEntries(Object.entries(item).reverse()));
  for (let count=0; count<5; count++) await React.act(async () => { tick(); await bridge.refreshRunning; });
  assert.equal(reads(), beforePollReads + 5, 'safety reads are never skipped');
  assert.equal(notices, 0, 'unchanged polls emit no UI notifications');
  assert.equal(menuEntries, initialEntries, 'subscribed registry snapshot identity is retained');
  assert.equal(document.querySelector('[role="menu"]'), openMenu, 'open production menu keeps DOM identity');
  for (const [id, prior] of identities) {
    assert.equal(manager.getPlugin(id), prior.entry);
    assert.equal(manager.getPlugin(id).settings, prior.settings);
    assert.equal(manager.getPlugin(id).error, prior.error);
  }
  packages.find(item => item.metadata.id === 'poll-metadata').digest = 'poll-metadata-2';
  await React.act(async () => { tick(); await bridge.refreshRunning; });
  assert.equal(notices, 1, 'changed digest notifies even for a table-disabled package');
  packages.find(item => item.metadata.id === 'poll-metadata').enabled = false;
  await React.act(async () => { tick(); await bridge.refreshRunning; });
  assert.equal(notices, 2, 'changed permission latch notifies in the observing poll');
  await React.act(async () => { tick(); await bridge.refreshRunning; });
  assert.equal(notices, 2, 'new stable values are silent again');
  offNotices(); await React.act(async () => menuRoot.unmount()); menuHost.remove();
  console.log('PASS: unchanged permission polls retain subscribed registry/settings/error and open production menu DOM identity; native safety reads continue; digest/latch changes notify immediately. Synthetic DOM.');

  const closeReadStarted = defer(), closeReadResume = defer();
  listGate = async () => { closeReadStarted.resolve(); await closeReadResume.promise; };
  tick(); await closeReadStarted.promise;
  const closingRefresh = bridge.refreshRunning, beforeWrites = permissionWrites(), beforeCloseLog = log.length;
  bridge.dispose(); assert.equal(timers.size, 0, 'dispose cancels permission polling');
  listGate = undefined; closeReadResume.resolve(); await closingRefresh;
  while (manager.cleaningUp) await new Promise(resolve => setImmediate(resolve));
  assert.equal(permissionWrites(), beforeWrites, 'cleanup does not change permission or preferences');
  assert.equal(manager.getPlugins().size, 0, 'in-flight permission read cannot repopulate a closed manager');
  assert(log.slice(beforeCloseLog).every(value => value.startsWith('stop:')), 'cleanup cannot restart or evaluate code');
  const closedReads = reads(); tick(); await Promise.resolve(); assert.equal(reads(), closedReads, 'disposed callbacks are inert');
  assert([...storage.keys()].every(key => key === 'devcel.plugins.installed:0.1.0'), 'no preference localStorage writers remain');
  console.log('PASS: typed project settings, serialized runtime reconciliation, disabled dependencies, approval/latch separation, replacement safety, digest-bound remove/rollback, callback races and late activation');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { global.setInterval = realSetInterval; global.clearInterval = realClearInterval; fs.rmSync(work, { recursive: true, force: true }); await dom.happyDOM.abort(); process.exit(process.exitCode || 0); });
