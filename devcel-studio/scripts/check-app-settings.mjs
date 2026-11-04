// Production settings-project consumer integration. Synthetic DOM/native IPC fixtures.
// Does not establish native window paint, filesystem transactions or backend CAS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import './check-settings-migration-notice.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { catalogChunks } from './catalog-chunks.mjs';
import { Window } from 'happy-dom';
const require = createRequire(import.meta.url);
const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-app-settings-'));
// Exercise the build-time catalog wrappers with the same production consumer fixture.
const catalogFixturePlugins = [];
if (process.argv.includes('--catalog-chunks')) {
  const catalogPlugin = catalogChunks(studio);
  catalogPlugin.buildStart.call({ addWatchFile() {} });
  catalogFixturePlugins.push({ name: 'production-catalog-fixture', setup(b) {
    b.onResolve({ filter: /catalog\.json$/ }, async args => {
      const absolute = path.resolve(path.dirname(args.importer), args.path);
      const id = await catalogPlugin.resolveId.call({ resolve: async () => ({ id: absolute }) }, args.path, args.importer);
      return id ? { path: id, namespace: 'catalog-fixture' } : undefined;
    });
    b.onResolve({ filter: /^\0devcel-catalog:/ }, args => ({ path: args.path, namespace: 'catalog-fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'catalog-fixture' }, args => ({ contents: catalogPlugin.load(args.path), loader: 'js' }));
  } });
}
const checks = [];
const check = async (name, run) => { await run(); checks.push(name); console.log(`PASS ${name}`); };
const window = new Window({ url: 'http://settings.invalid/' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'Event', 'CustomEvent', 'StorageEvent', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__native = true;
globalThis.__themes = [];
globalThis.__nativeListeners = new Map();
globalThis.__nativeOrder = [];
globalThis.__onListen = undefined;
globalThis.__invoke = async name => { throw Error(`Unexpected native invoke: ${name}`); };
const mediaListeners = new Set();
const media = { matches: false, addEventListener: (_, cb) => mediaListeners.add(cb), removeEventListener: (_, cb) => mediaListeners.delete(cb) };
window.matchMedia = () => media;
const emitNative = payload => { for (const cb of globalThis.__nativeListeners.get('devcel-app-settings-changed') ?? []) cb({ payload }); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const read = relative => fs.readFileSync(path.join(studio, relative), 'utf8');
try {
  const outfile = path.join(temp, 'settings.cjs');
  await build({ absWorkingDir: studio, stdin: { resolveDir: studio, loader: 'tsx', contents: `
    export * as settings from './src/app/settings';
    export * as i18n from './src/app/i18n';
    export {isPluginRequested} from './src/app/settings/pluginSettings';
    export * as color from './src/app/components/color/colorDisplay';
    export * as updater from './src/app/utils/updater';
    export {showOptions} from './src/app/utils/options';
    export {AppTheme} from './src/app/settings/AppTheme';
    export {ReferenceCellRenderer} from './src/app/pages/main_window/project_view/table_view/components/ReferenceCell';
    export {TableRefCellRenderer} from './src/app/pages/main_window/project_view/table_view/components/TableRefCell';
    export {CurveCellRenderer} from './src/app/pages/main_window/project_view/table_view/components/CurveCell';
    export {SelectCellRenderer} from './src/app/pages/main_window/project_view/table_view/components/SelectCell';
    export {initializeApplicationMode} from './src/app/applicationMode';
    export * as React from 'react'; export {createRoot} from 'react-dom/client';
  ` }, outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', define: { 'import.meta.env.DEV': 'false' }, alias: { '@': path.join(studio, 'src') }, plugins: [...catalogFixturePlugins, { name: 'controlled-boundaries', setup(b) {
    b.onResolve({ filter: /^@tauri-apps\/(?:api\/|plugin-)/ }, args => ({ path: args.path, namespace: 'native' }));
    b.onLoad({ filter: /.*/, namespace: 'native' }, ({ path: name }) => ({ contents:
      name.endsWith('/core') ? 'export const isTauri=()=>globalThis.__native; export const invoke=(...args)=>{globalThis.__nativeOrder.push(args[0]);return globalThis.__invoke(...args)}; export class Resource {constructor(rid){this.rid=rid}async close(){globalThis.__resourceClosed?.(this.rid)}}' :
      name.endsWith('/event') ? `export const listen=async (name,cb)=>{globalThis.__nativeOrder.push('listen:'+name);let set=globalThis.__nativeListeners.get(name);if(!set){set=new Set();globalThis.__nativeListeners.set(name,set)}set.add(cb);globalThis.__onListen?.(name,cb);return()=>set.delete(cb)};` :
      name.includes('plugin-updater') ? 'export const check=(...args)=>globalThis.__checkUpdate(...args);' :
      name.includes('plugin-process') ? 'export const relaunch=(...args)=>globalThis.__relaunch(...args);' :
      'const window={close:async()=>{},setTitle:async()=>{},onCloseRequested:async()=>()=>{}}; export const getCurrentWindow=()=>window; export const getCurrentWebviewWindow=()=>window; export class WebviewWindow {static async getByLabel(){return null} constructor(){throw Error("Unexpected native window")}}'
    }));
    // Only data lookup and editor-only dependencies are controlled; renderer JSX is production code.
    b.onResolve({ filter: /(?:\/useReferenceOptions|\/CurveEditor|\/FileSelectTreeView|\/reference-select-popover|^@\/app\/commands\/tableCommands)$/ }, args => ({ path: args.path, namespace: 'renderer-boundary' }));
    b.onLoad({ filter: /.*/, namespace: 'renderer-boundary' }, ({ path: name }) => ({ contents:
      name.endsWith('/useReferenceOptions') ? `export const useReferenceOptions=()=>({ data:{options:[],byUuid:new Map([['target-id',{option:{uuid:'target-id',display_value:'Target record'},index:0}]])},loading:false,failed:false });` :
      name.endsWith('/tableCommands') ? `export const getTableCatalog=async()=>[{uuid:'target-id',display_name:'Target table'}];` :
      'export const CurveEditor=()=>null; export const FileSelectTreeView=()=>null; export const ReferenceSelectPopover=()=>null;'
    }));
    b.onResolve({ filter: /^@\/app\/contexts\/PluginContext$/ }, () => ({ path: 'plugins', namespace: 'plugins' }));
    b.onLoad({ filter: /.*/, namespace: 'plugins' }, () => ({ contents: 'export const useThemes=()=>globalThis.__themes;' }));
  } }] });
  const { settings: s, i18n, isPluginRequested, color, updater, showOptions, AppTheme, ReferenceCellRenderer, TableRefCellRenderer, CurveCellRenderer, SelectCellRenderer, initializeApplicationMode, React, createRoot } = require(outfile);
  const { act } = React;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let generation = 0;
  const snapshot = (values = {}, extra = {}) => ({ revision: `revision:${++generation}`, generation: `generation:${generation}`, bundle: { ...structuredClone(s.catalog), values: { ...s.catalog.values, ...values } }, warning: null, migrationFailed: false, appVersion: '0.1.0', source: 'project', projectPath: '/settings/settings.devcelproj.toml', resolvedLocale: values.locale === 'ja' ? 'ja' : 'en', availableLocales: ['ja', 'en', 'en-XA'], ...extra });
  let server;
  const serve = () => { globalThis.__invoke = async name => { assert.equal(name, 'get_app_settings'); return server; }; };
  const publish = async (values = {}, extra = {}) => { server = snapshot(values, extra); serve(); await act(async () => s.refreshAppSettings()); return server; };
  function Consumer() {
    const settings = s.useAppSettings(); const { t } = i18n.useI18n();
    const interpretation = color.useColorInterpretation('ColorFloat');
    const [draft, setDraft] = React.useState('unchanged');
    return React.createElement('section', null,
      React.createElement('input', { value: draft, onChange: event => setDraft(event.target.value) }),
      React.createElement('span', { 'data-label': true }, t('common.save')),
      React.createElement('output', { 'data-warning': true }, settings.warning?.map(error => i18n.localizeError(error)).join('\n') ?? ''),
      React.createElement('output', { 'data-settings': true }, JSON.stringify({ interpretation, automatic: updater.getAutomaticUpdateCheck(), warning: settings.warning, source: settings.source })));
  }
  const render = () => root.render(React.createElement(React.Fragment, null, React.createElement(AppTheme), React.createElement(Consumer)));
  await check('Native initialization subscribes before reading, is idempotent and rejects an older event read', async () => {
    const pending = [];
    globalThis.__invoke = name => { assert.equal(name, 'get_app_settings'); return new Promise(resolve => pending.push(resolve)); };
    globalThis.__onListen = (_name, callback) => callback({ payload: { revision: 'not-a-snapshot' } });
    const first = s.initializeAppSettings(), second = s.initializeAppSettings();
    assert.equal(first, second); await tick();
    assert.deepEqual(globalThis.__nativeOrder, ['listen:devcel-app-settings-changed', 'get_app_settings', 'get_app_settings']);
    const newest = snapshot({ locale: 'en' }, { revision: 'aaaa:newest' });
    pending[1](newest); await first; pending[0](snapshot({ locale: 'ja' }, { revision: 'zzzz:stale' })); await tick();
    assert.equal(s.getSettingsSnapshot(), newest); assert.equal(i18n.getLocale(), 'en');
    await s.initializeAppSettings(); assert.equal(pending.length, 2); globalThis.__onListen = undefined;
  });
  await check('New snapshot and CSS publish before synchronous locale callbacks, then settings subscribers (including same-locale refresh)', async () => {
    await publish({ locale: 'en' });
    assert.equal(isPluginRequested('csv-exporter'), true);
    const seen = [];
    const observe = phase => seen.push({ phase, snapshot: s.getSettingsSnapshot(),
      requested: isPluginRequested('csv-exporter'), locale: i18n.getLocale(),
      css: document.querySelector('#devcel-settings-theme').textContent });
    const offLocale = i18n.subscribeLocale(() => observe('locale'));
    const offSettings = s.subscribeSettings(() => observe('settings'));
    try {
      for (const locale of ['en', 'ja']) {
        const bundle = structuredClone(s.getSettingsSnapshot().bundle);
        bundle.values.locale = locale;
        bundle.pluginStates['csv-exporter'] = false;
        bundle.themeCss = `:root { --locale-order-probe: ${locale}; }`;
        const next = await publish({ locale }, { bundle });
        assert.deepEqual(seen.map(item => item.phase), ['locale', 'settings']);
        for (const item of seen) {
          assert.equal(item.snapshot, next, `${item.phase} observes the newly published bundle`);
          assert.equal(item.requested, false, `${item.phase} cannot see the previous enabled state`);
          assert.equal(item.css, next.bundle.themeCss, `${item.phase} observes the new CSS`);
          assert.equal(item.locale, locale);
        }
        seen.length = 0;
      }
    } finally { offLocale(); offSettings(); }
  });
  await check('One validated bundle drives locale, theme CSS, both color formats and updater without reading unrelated local storage', async () => {
    const unrelated = { 'other-app.locale': 'ja', 'other-app.theme': 'dark', 'other-app.updater': 'true', 'other-app.color32': 'linear', 'other-app.colorFloat': 'srgb', 'unrelated.preference': 'keep' };
    for (const [key, value] of Object.entries(unrelated)) localStorage.setItem(key, value);
    await publish({ locale: 'en', theme: 'light', automaticUpdateChecks: false, color32Display: 'srgb', colorFloatDisplay: 'linear' });
    await act(render);
    assert.equal(i18n.getLocale(), 'en'); assert.equal(document.documentElement.lang, 'en');
    assert.equal(color.getColorInterpretation('Color32'), 'srgb'); assert.equal(color.getColorInterpretation('ColorFloat'), 'linear'); assert.equal(color.getColorInterpretation('UiColor'), 'srgb');
    assert.equal(updater.getAutomaticUpdateCheck(), false);
    const calls = globalThis.__nativeOrder.length; await updater.checkForUpdatesOnStartup(); assert.equal(globalThis.__nativeOrder.length, calls, 'disabled preference does not even read updater configuration');
    assert.equal(document.querySelector('#devcel-settings-theme').textContent, server.bundle.themeCss);
    assert.equal(document.querySelectorAll('#devcel-settings-theme').length, 1);
    for (const [key, value] of Object.entries(unrelated)) assert.equal(localStorage.getItem(key), value);
    for (const file of ['src/app/settings/index.ts', 'src/app/i18n/index.ts', 'src/app/components/color/colorDisplay.ts', 'src/app/utils/updater.ts']) assert.doesNotMatch(read(file), /localStorage\.setItem|set_app_setting|set_locale_preference|localOwners|themeSelection/);
    assert.equal('updateAppSetting' in s, false); assert.equal('setColorInterpretation' in color, false); assert.equal('setLocalePreference' in i18n, false);
  });
  await check('Hot snapshots update mounted consumers and locale labels while preserving draft, focus and element identity', async () => {
    const input = host.querySelector('input'); input.focus(); input.setSelectionRange(2, 4);
    const label = host.querySelector('[data-label]').textContent;
    await publish({ locale: 'ja', theme: 'dark', automaticUpdateChecks: true, color32Display: 'linear', colorFloatDisplay: 'srgb' });
    assert.equal(host.querySelector('input'), input); assert.equal(input.value, 'unchanged'); assert.equal(document.activeElement, input); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 4);
    assert.notEqual(host.querySelector('[data-label]').textContent, label); assert.equal(document.documentElement.lang, 'ja');
    assert.equal(color.getColorInterpretation('Color32'), 'linear'); assert.equal(color.getColorInterpretation('ColorFloat'), 'srgb'); assert.equal(updater.getAutomaticUpdateCheck(), true);
    assert.deepEqual(JSON.parse(host.querySelector('[data-settings]').textContent), { interpretation: 'srgb', automatic: true, warning: null, source: 'project' });
  });
  await check('Editing translation rows at the same locale clears compiled ICU caches and replaces theme CSS atomically', async () => {
    await publish({ locale: 'en' });
    assert.equal(i18n.t('common.save'), s.catalog.localization.messages.en['common.save']);
    i18n.t('column.managedBy', { name: 'Owner' });
    const bundle = structuredClone(server.bundle);
    bundle.localization.messages.en['common.save'] = 'Saved from the settings table';
    bundle.localization.messages.en['column.managedBy'] = 'Runtime owner: {name}';
    bundle.themeCss = ':root { --fixture-runtime-token: 7; }';
    await publish({ locale: 'en' }, { bundle });
    assert.equal(i18n.t('common.save'), 'Saved from the settings table'); assert.equal(i18n.t('column.managedBy', { name: 'Owner' }), 'Runtime owner: Owner');
    assert.equal(host.querySelector('[data-label]').textContent, 'Saved from the settings table');
    assert.equal(document.querySelector('#devcel-settings-theme').textContent, bundle.themeCss); assert.equal(document.querySelectorAll('#devcel-settings-theme').length, 1);
  });
  await check('Event and focus are invalidations, ignore payload state, and latest requests win regardless of revision ordering', async () => {
    const pending = []; globalThis.__invoke = name => { assert.equal(name, 'get_app_settings'); return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
    const previous = s.getSettingsSnapshot(); emitNative(snapshot({ locale: 'ja' })); assert.equal(s.getSettingsSnapshot(), previous);
    window.dispatchEvent(new Event('focus')); assert.equal(pending.length, 2);
    await act(async () => { pending[1].resolve(snapshot({ locale: 'en' }, { revision: '000:focus' })); await tick(); pending[0].resolve(snapshot({ locale: 'ja' }, { revision: 'zzz:stale' })); await tick(); });
    assert.equal(s.getSettingsSnapshot().revision, '000:focus'); assert.equal(i18n.getLocale(), 'en');
    window.dispatchEvent(new Event('focus')); emitNative({ malformed: true });
    await act(async () => { pending[3].resolve(snapshot({ locale: 'ja' }, { revision: '000:event' })); await tick(); pending[2].reject(Error('stale failure')); await tick(); });
    assert.equal(s.getSettingsSnapshot().revision, '000:event'); assert.equal(s.getSettingsSnapshot().warning, null);
    let notified = 0; const remove = s.subscribeSettings(() => notified++); await publish({ locale: 'en' }); assert.equal(notified, 1); remove(); await publish({ locale: 'ja' }); assert.equal(notified, 1);
  });
  await check('Native migration status and app version publish together and clear after recovery', async () => {
    await publish({ locale: 'en' }, { migrationFailed: true, appVersion: '0.2.0', source: 'embedded' });
    assert.equal(s.getSettingsSnapshot().migrationFailed, true);
    assert.equal(s.getSettingsSnapshot().appVersion, '0.2.0');
    assert.equal(document.querySelector('#devcel-settings-theme').textContent, s.catalog.themeCss, 'migration fallback still publishes complete theme CSS');
    assert.deepEqual(s.getSettingsSnapshot().bundle.values, { ...s.catalog.values, locale: 'en' });
    await publish({ locale: 'en' }, { migrationFailed: false, appVersion: '0.2.0' });
    assert.equal(s.getSettingsSnapshot().migrationFailed, false);
    assert.equal(s.getSettingsSnapshot().appVersion, '0.2.0');
  });
  await check('Successful version migration copies layout once without changing the prior version', async () => {
    localStorage.setItem('devcel-datagrid-column-widths:0.1.0', JSON.stringify({ table: { column: 215 } }));
    localStorage.setItem('dataGridRowHeight_:0.1.0:table_row', '47');
    await publish({}, { appVersion: '0.4.0', migratedFromVersion: '0.1.0' });
    assert.equal(JSON.parse(localStorage.getItem('devcel-datagrid-column-widths:0.4.0')).table.column, 215);
    assert.equal(localStorage.getItem('dataGridRowHeight_:0.4.0:table_row'), '47');
    localStorage.setItem('devcel-datagrid-column-widths:0.4.0', JSON.stringify({ table: { column: 300 } }));
    await publish({}, { appVersion: '0.4.0', migratedFromVersion: '0.1.0' });
    assert.equal(JSON.parse(localStorage.getItem('devcel-datagrid-column-widths:0.4.0')).table.column, 300);
    assert.equal(JSON.parse(localStorage.getItem('devcel-datagrid-column-widths:0.1.0')).table.column, 215);
  });
  await check('Last-valid and embedded fallback warnings remain visible; IPC failure preserves values and recovers on focus', async () => {
    for (const source of ['lastValid', 'embedded']) {
      await publish({ locale: 'en', theme: 'dark', colorFloatDisplay: 'srgb' }, { source, warning: [{kind:'code',code:'error.settingsSingleton',params:{}}] });
      assert.equal(s.getSettingsSnapshot().source, source); assert.equal(i18n.getLocale(), 'en'); assert.equal(color.getColorInterpretation('ColorFloat'), 'srgb');
      const shown = JSON.parse(host.querySelector('[data-settings]').textContent); assert.deepEqual(shown.warning, [{kind:'code',code:'error.settingsSingleton',params:{}}]); assert.equal(host.querySelector('[data-warning]').textContent, i18n.t('error.settingsSingleton')); assert.equal(shown.source, source);
    }
    const previous = s.getSettingsSnapshot(); globalThis.__invoke = async () => { throw { kind: 'text', text: 'temporary IPC failure' }; };
    await act(async () => s.refreshAppSettings());
    assert.equal(s.getSettingsSnapshot().bundle, previous.bundle); assert.equal(s.getSettingsSnapshot().revision, previous.revision); assert.deepEqual(s.getSettingsSnapshot().warning, [{kind:'text',text:'temporary IPC failure'}]);
    server = snapshot({ locale: 'ja' }); serve(); await act(async () => { window.dispatchEvent(new Event('focus')); await tick(); });
    assert.equal(s.getSettingsSnapshot(), server); assert.equal(s.getSettingsSnapshot().warning, null);
  });
  await check('Typed warning identity survives IPC failure and live locale changes without rewriting values or user text', async () => {
    const error = {kind:'diagnostics',diagnostics:[{kind:'code',code:'error.settingsSingleton',params:{}},{kind:'text',text:'Keep Name cannot be empty. exactly'}]};
    await publish({locale:'ja',theme:'dark'});
    const before = s.getSettingsSnapshot();
    globalThis.__invoke = async () => { throw error; };
    await act(async () => s.refreshAppSettings());
    assert.equal(s.getSettingsSnapshot().warning[0], error);
    assert.equal(s.getSettingsSnapshot().bundle, before.bundle);
    assert.equal(host.querySelector('[data-warning]').textContent, i18n.t('error.settingsSingleton') + '\nKeep Name cannot be empty. exactly');
    const japanese = host.querySelector('[data-warning]').textContent;
    await act(async () => i18n.applyRuntimeLocalization(before.bundle.localization, {preference:'en',locale:'en',revision:'locale-only',availableLocales:['ja','en']}));
    assert.equal(s.getSettingsSnapshot().warning[0], error);
    assert.equal(s.getSettingsSnapshot().bundle, before.bundle);
    assert.equal(host.querySelector('[data-warning]').textContent, i18n.t('error.settingsSingleton') + '\nKeep Name cannot be empty. exactly');
    assert.notEqual(host.querySelector('[data-warning]').textContent, japanese);
    assert.ok(!host.querySelector('[data-warning]').textContent.includes('Validation error:'));
    serve();
  });
  await check('Malformed singleton warnings retain selectable repair paths and explicit fallback status until source recovery', async () => {
    const path='/settings with spaces/Tables/UserSettings.table.toml';
    const diagnostic={kind:'diagnostics',diagnostics:[{kind:'code',code:'settings.schema.singleton',params:{table:'UserSettings',count:2}}]};
    for(const locale of ['ja','en']) {
      const rendered=[];
      for(const source of ['lastValid','embedded']) {
        const repair={kind:'code',code:'settings.singletonRepair',params:{path,source}};
        await publish({locale,theme:'dark'},{source,warning:[diagnostic,repair]});
        const text=host.querySelector('[data-warning]').textContent;
        assert(text.includes(path));assert(!text.includes('[settings.singletonRepair]'));assert(!text.includes('Validation error:'));
        assert.equal(s.getSettingsSnapshot().bundle.values.theme,'dark');
        assert.equal(s.getSettingsSnapshot().warning[0],diagnostic);
        rendered.push(i18n.localizeError(repair));
      }
      assert.notEqual(rendered[0],rendered[1],'the current last-valid or embedded fallback is explicit');
    }
    await publish({locale:'ja',theme:'dark'});
    assert.equal(host.querySelector('[data-warning]').textContent,'');
  });
  await check('Failed subscribers cannot block later settings subscribers on success or IPC warning paths', async () => {
    let received = 0; const warnings = [], previousWarn = console.warn;
    const broken = s.subscribeSettings(() => { throw Error('fixture subscriber'); });
    const healthy = s.subscribeSettings(() => received++);
    console.warn = (...args) => warnings.push(args);
    try {
      await publish({ locale: 'en' }); assert.equal(received, 1);
      globalThis.__invoke = async () => { throw Error('fixture IPC failure'); };
      await act(async () => s.refreshAppSettings()); assert.equal(received, 2);
      assert.deepEqual(s.getSettingsSnapshot().warning, [{kind:'text',text:'fixture IPC failure'}]); assert.equal(warnings.length, 2);
    } finally { broken(); healthy(); console.warn = previousWarn; }
    const main = read('src/app/pages/main_window/MainWindow.tsx');
    assert.match(main, /\(settings\.migrationFailed \|\| settings\.warning\) && <p role="alert"[\s\S]*?settings\.migrationFailed \? t\(\x27settings\.migrationFailed\x27\) : settings\.warning\?\.map/);
  });
  await check('Updater install and restart hold the native settings-update lease until success or failure settles', async () => {
    const config = { currentVersion: '1.0', platform: 'linux-x86_64', supported: true, configurationStatus: 'ready' };
    const rawJson = { version: '2.0', url: 'https://updates.invalid/devcel.tar.gz', signature: 'fixture-signature' };
    for (const operation of ['install', 'restart']) {
      for (const failure of [false, true]) {
        const events = []; let finish, fail;
        globalThis.__invoke = async name => { assert.equal(name, 'acquire_settings_update_lease'); events.push('acquire'); return 72; };
        globalThis.__resourceClosed = rid => { assert.equal(rid, 72); events.push('close'); };
        const action = () => { events.push(operation); return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); };
        globalThis.__checkUpdate = async () => ({ rawJson, version: '2.0', currentVersion: '1.0', download: async () => {}, install: action, close: async () => {} });
        globalThis.__relaunch = action;
        const release = await updater.nativeUpdaterTransport.check(config);
        const running = operation === 'install' ? release.install() : updater.nativeUpdaterTransport.restart();
        await tick(); assert.deepEqual(events, ['acquire', operation], 'lease remains open while native work is pending');
        if (failure) { fail(Error('native action failed')); await assert.rejects(running, /native action failed/); }
        else { finish(); await running; }
        assert.deepEqual(events, ['acquire', operation, 'close']);
      }
      let actions = 0;
      globalThis.__invoke = async name => { assert.equal(name, 'acquire_settings_update_lease'); throw Error('settings editor is running'); };
      globalThis.__checkUpdate = async () => ({ rawJson, version: '2.0', currentVersion: '1.0', install: async () => { actions++; }, close: async () => {} });
      globalThis.__relaunch = async () => { actions++; };
      const release = await updater.nativeUpdaterTransport.check(config);
      await assert.rejects(operation === 'install' ? release.install() : updater.nativeUpdaterTransport.restart(), /settings editor is running/);
      assert.equal(actions, 0, 'an unavailable lease prevents the action itself');
    }
    globalThis.__resourceClosed = undefined;
  });
  await check('System and explicit themes respond correctly to live OS changes', async () => {
    await publish({ theme: 'system' });
    await act(async () => { media.matches = true; for (const cb of mediaListeners) cb(); });
    assert.ok(document.documentElement.classList.contains('dark')); assert.equal(document.documentElement.style.colorScheme, 'dark');
    await publish({ theme: 'light' }); assert.equal(document.documentElement.classList.contains('dark'), false);
    await act(async () => { media.matches = false; for (const cb of mediaListeners) cb(); });
    await publish({ theme: 'dark' }); assert.equal(document.documentElement.classList.contains('dark'), true);
    await publish({ theme: 'system' }); assert.equal(document.documentElement.classList.contains('dark'), false);
  });
  await check('Theme identity is independent from editable light/dark appearance', async () => {
    for (const key of ['light', 'dark']) {
      const bundle = structuredClone(s.catalog);
      bundle.values = { ...bundle.values, theme: key, pluginTheme: '' };
      bundle.themes.find(theme => theme.key === key).isDark = key === 'light';
      await publish({}, { bundle });
      assert.equal(document.documentElement.dataset.devcelTheme, key);
      assert.equal(document.documentElement.classList.contains('dark'), key === 'light');
      assert.equal(document.documentElement.style.colorScheme, key === 'light' ? 'dark' : 'light');
    }
  });
  await check('Project plugin-theme selection has precedence, survives absence and unrelated changes, and cleans variables', async () => {
    const colors = Object.fromEntries(Object.keys(server.bundle.themes[0].tokens).map(key => [key, '160 50% 50%']));
    document.documentElement.style.setProperty('--primary', 'existing-value');
    globalThis.__themes = [{ id: 'fixture:theme', type: 'dark', name: 'Fixture', colors, cssVariables: { '--plugin-only': '42px' } }];
    await publish({ theme: 'light', pluginTheme: 'fixture:theme' });
    assert.equal(document.documentElement.dataset.devcelTheme, 'fixture:theme'); assert.equal(document.documentElement.style.getPropertyValue('--plugin-only'), '42px'); assert.ok(document.documentElement.classList.contains('dark'));
    await publish({ locale: 'ja', theme: 'light', pluginTheme: 'fixture:theme' }); assert.equal(document.documentElement.dataset.devcelTheme, 'fixture:theme');
    globalThis.__themes = []; await act(render);
    assert.equal(s.getSettingsSnapshot().bundle.values.pluginTheme, 'fixture:theme'); assert.equal(document.documentElement.dataset.devcelTheme, 'light'); assert.equal(document.documentElement.style.getPropertyValue('--plugin-only'), ''); assert.equal(document.documentElement.style.getPropertyValue('--primary'), 'existing-value');
    globalThis.__themes = [{ id: 'fixture:theme', type: 'auto', name: 'Fixture', colors }]; await act(render);
    await act(async () => { media.matches = true; for (const cb of mediaListeners) cb(); }); assert.ok(document.documentElement.classList.contains('dark'));
    await act(async () => root.render(null)); assert.equal(mediaListeners.size, 0); assert.equal(document.documentElement.style.getPropertyValue('--primary'), 'existing-value');
    await act(render); assert.equal(document.documentElement.dataset.devcelTheme, 'fixture:theme');
    await publish({ theme: 'light', pluginTheme: '' }); assert.equal(document.documentElement.dataset.devcelTheme, 'light'); assert.equal(document.documentElement.style.getPropertyValue('--primary'), 'existing-value');
    assert.equal(document.documentElement.style.getPropertyValue('--primary-ink'), ''); assert.equal(document.documentElement.style.getPropertyValue('--primary-foreground'), ''); document.documentElement.style.removeProperty('--primary');
  });
  await check('Reset passes the current generation, refreshes authoritative data and preserves state on rejection', async () => {
    const before = s.getSettingsSnapshot(), calls = [], reset = snapshot({ locale: 'ja' });
    globalThis.__invoke = async (name, args) => { calls.push([name, args]); if (name === 'reset_settings_project') return; assert.equal(name, 'get_app_settings'); return reset; };
    await act(async () => s.resetSettingsProject());
    assert.deepEqual(calls[0], ['reset_settings_project', { expectedGeneration: before.generation }]); assert.equal(calls[1][0], 'get_app_settings'); assert.equal(s.getSettingsSnapshot(), reset);
    globalThis.__invoke = async name => { assert.equal(name, 'reset_settings_project'); throw Error('stale generation'); };
    await assert.rejects(s.resetSettingsProject(), /stale generation/); assert.equal(s.getSettingsSnapshot(), reset);
  });
  await check('Options opens the real editor command, coalesces concurrent launches and allows retry after failure', async () => {
    const calls = []; let resolve, reject;
    globalThis.__invoke = name => { calls.push(name); assert.equal(name, 'open_settings_editor'); return new Promise((yes, no) => { resolve = yes; reject = no; }); };
    const first = showOptions(), second = showOptions(); assert.equal(first, second); assert.deepEqual(calls, ['open_settings_editor']); resolve(); await first;
    const failed = showOptions(); reject(Error('launch failed')); await assert.rejects(failed, /launch failed/);
    const retry = showOptions(); resolve(); await retry; assert.equal(calls.length, 3);
    const failedMigration = snapshot({}, { migrationFailed:true, source:'embedded' });
    globalThis.__invoke = async name => {
      if (name === 'open_settings_editor') throw { kind:'code', code:'settings.migrationFailed', params:{} };
      assert.equal(name, 'get_app_settings'); return failedMigration;
    };
    await act(async () => showOptions()); // Resolves: the menu's modal error handler must not run.
    assert.equal(s.getSettingsSnapshot().migrationFailed, true);
    const recovered = snapshot();
    globalThis.__invoke = async name => name === 'get_app_settings' ? recovered : undefined;
    await act(async () => { await s.resetSettingsProject(); await showOptions(); });
    assert.equal(s.getSettingsSnapshot().migrationFailed, false);
    assert.equal(fs.existsSync(path.join(studio, 'src/app/pages/options/OptionsPage.tsx')), false); assert.doesNotMatch(read('src/app/routes/routes.tsx'), /\/options|OptionsPage/);
  });
  await check('Every window instance independently subscribes to global invalidation and focus refresh', async () => {
    delete require.cache[require.resolve(outfile)]; const second = require(outfile).settings;
    server = snapshot({ locale: 'en' }); serve(); await second.initializeAppSettings();
    assert.equal(globalThis.__nativeListeners.get('devcel-app-settings-changed').size, 2);
    for (const notify of [() => emitNative({ revision: 'payload-must-be-ignored' }), () => window.dispatchEvent(new Event('focus'))]) {
      server = snapshot({ locale: 'ja', colorFloatDisplay: 'srgb' }); const before = globalThis.__nativeOrder.length;
      await act(async () => { notify(); await tick(); });
      assert.equal(globalThis.__nativeOrder.length - before, 2); assert.equal(s.getSettingsSnapshot(), server); assert.equal(second.getSettingsSnapshot(), server);
    }
  });
  await check('Shared theme owner and fail-closed mode bootstrap cover main and detached routes', async () => {
    const entry = read('src/app/main.tsx');
    assert.equal((entry.match(/<AppTheme\s*\/>/g) ?? []).length, 1);
    assert.match(entry, /<PluginProvider>[\s\S]*<AppTheme\s*\/>[\s\S]*<RouterProvider[\s\S]*<\/PluginProvider>/);
    assert.ok(entry.indexOf('await initializeApplicationMode()') < entry.indexOf('ReactDOM.createRoot'));
    assert.ok(entry.indexOf('isApplicationRouteAllowed(window.location.pathname)') < entry.indexOf('ReactDOM.createRoot'));
    assert.match(entry, /bootstrap\(\)\.catch/); assert.match(entry, /setAttribute\('role', 'alert'\)/);
    const routes = read('src/app/routes/routes.tsx'); for (const route of ['/project_create_wizard', '/export_dialog']) assert.ok(routes.includes(`'${route}'`));
    const provider = read('src/app/contexts/PluginContext.tsx');
    assert.match(provider, /return isSettingsEditor\(\)[\s\S]*value=\{emptyPluginContext\}[\s\S]*<StandardPluginProvider>/);
    const menus = read('src/app/config/menuConfigs.ts'); assert.match(menus, /if \(isSettingsEditor\(\)\) return getSettingsEditorMenuConfig\(props\)/);
    const { compileModule } = require('./compile-module.cjs'); const modeSource = compileModule(read('src/app/applicationMode.ts'), 'applicationMode.ts');
    const loadMode = invoke => { const module = { exports: {} }; vm.runInNewContext(modeSource, { module, exports: module.exports, require: () => ({ invoke, isTauri: () => true }), Set, Promise, Error }); return module.exports; };
    for (const outcome of ['bad-mode', new Error('mode IPC failed')]) {
      const mode = loadMode(async () => { if (outcome instanceof Error) throw outcome; return outcome; });
      const first = mode.initializeApplicationMode(); assert.equal(mode.initializeApplicationMode(), first); await assert.rejects(first); assert.equal(mode.isSettingsEditor(), false);
    }
    let calls = 0; const mode = loadMode(async name => { assert.equal(name, 'get_application_mode'); calls++; return 'settings-editor'; });
    await mode.initializeApplicationMode(); await mode.initializeApplicationMode(); assert.equal(calls, 1); assert.equal(mode.isSettingsEditor(), true);
    for (const route of ['/', '/bulk_row_dialog', '/table_rule_dialog']) assert.equal(mode.isApplicationRouteAllowed(route), true);
    for (const route of ['/color_picker', '/string_editor', '/column_type_dialog', '/options', '/plugin_manager', '/plugin_packages', '/app_updater', '/project_create_wizard', '/project_edit_dialog', '/export_dialog', '/unknown']) assert.equal(mode.isApplicationRouteAllowed(route), false);
  });
  await check('Reference, table-reference and curve renderers preserve grid-owned backgrounds and explicit data ink', async () => {
    const cellHost = document.createElement('div'); document.body.append(cellHost);
    const cellRoot = createRoot(cellHost);
    const cases = [
      { name: 'theme default', custom: undefined, presentation: undefined, linkInk: true },
      { name: 'explicit column background', custom: { backgroundColor: '#ffffff' }, presentation: undefined, linkInk: false },
      { name: 'conditional background', custom: undefined, presentation: { background_color: '#ffffff' }, linkInk: false },
      { name: 'conditional text', custom: undefined, presentation: { text_color: '#123456' }, linkInk: false },
      { name: 'conditional background and text', custom: undefined, presentation: { background_color: '#ffffff', text_color: '#123456' }, linkInk: false },
    ];
    try {
      for (const [name, Renderer] of [['reference', ReferenceCellRenderer], ['table-reference', TableRefCellRenderer], ['curve', CurveCellRenderer]]) {
        for (const test of cases) {
          const props = {
            column: { key: 'value', idx: 0, customStyles: test.custom },
            // The persisted white style must never paint a nested overlay over the grid's theme tint.
            columnData: { uuid: 'column-id', read_only: false, default_value: '', style: { color: '#ffffff' }, reference_config: { target_table_uuid: 'target-table' } },
            row: { rowId: 'row-id', value: name === 'curve' ? '' : 'target-id', cellPresentations: test.presentation ? { value: { style: test.presentation } } : undefined },
            rowIdx: 0, tableUuid: 'source-table', expectedProjectSession: 'session-test',
            onReferenceClick: () => {}, onOpenTable: () => {},
          };
          const before = JSON.stringify(props);
          const background = test.custom?.backgroundColor ?? test.presentation?.background_color ?? '#263238';
          const color = test.presentation?.text_color ?? (background === '#ffffff' ? '#242a30' : '#eef0f2');
          await act(async () => cellRoot.render(React.createElement('div', { 'data-grid-owned': true, style: { backgroundColor: background, color } }, React.createElement(Renderer, props))));
          const parent = cellHost.querySelector('[data-grid-owned]');
          const surface = parent.firstElementChild;
          assert.equal(surface.style.backgroundColor, '', `${name}: ${test.name} cannot overlay the grid background`);
          assert.equal(surface.style.background, '', `${name}: ${test.name} cannot use a background shorthand overlay`);
          for (const child of surface.querySelectorAll('[style]')) {
            assert.equal(child.style.backgroundColor, '', `${name}: descendant cannot overlay the grid background`);
            assert.equal(child.style.background, '', `${name}: descendant cannot use a background shorthand overlay`);
          }
          assert.equal(surface.style.color, '', `${name}: renderer must inherit grid ink`);
          if (name !== 'curve') {
            const link = surface.querySelector('span');
            assert.ok(link.className.includes('cursor-pointer'), `${name}: the loaded link remains interactive`);
            assert.equal(link.style.color, test.linkInk ? 'hsl(var(--primary-ink))' : '', `${name}: ${test.name} selects semantic or inherited ink`);
          }
          assert.equal(JSON.stringify(props), before, `${name}: rendering never mutates explicit data colors`);
          const expectedStyle = document.createElement('div').style;
          expectedStyle.backgroundColor = background; expectedStyle.color = color;
          assert.equal(parent.style.backgroundColor, expectedStyle.backgroundColor);
          assert.equal(parent.style.color, expectedStyle.color);
        }
      }
    } finally { await act(async () => cellRoot.unmount()); cellHost.remove(); }
  });
  await check('Settings Select candidates refresh in the mounted cell without changing the stored ID or focus', async () => {
    globalThis.__invoke = async name => { assert.equal(name, 'get_application_mode'); return 'settings-editor'; };
    await initializeApplicationMode();
    const cellHost = document.createElement('div'); document.body.append(cellHost);
    const cellRoot = createRoot(cellHost);
    let changed;
    const props = { column: { key: 'value', idx: 0 }, row: { value: 'system' }, rowIdx: 0,
      columnData: { uuid: 'af3c91ac-5b4d-5d65-89d3-41102912eb8b', display_name: 'Theme', select_config: { options: [{ value: 'system', label: 'System' }] } },
      readOnly: false, tabIndex: 0, onRowChange: row => { changed = row; }, onEdit: () => {} };
    try {
      await publish({ locale: 'en' });
      await act(async () => cellRoot.render(React.createElement(SelectCellRenderer, props)));
      const select = cellHost.querySelector('select'); select.focus();
      const bundle = structuredClone(s.getSettingsSnapshot().bundle);
      bundle.themes.push({ ...bundle.themes[0], key: 'custom-live', labelKey: 'common.save' });
      await publish({}, { bundle });
      assert.equal(cellHost.querySelector('select'), select);
      assert.equal(document.activeElement, select);
      assert.equal(select.value, 'system');
      assert.equal([...select.options].find(option => option.value === 'custom-live').textContent, i18n.t('common.save'));
      await act(async () => { select.value = 'custom-live'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      assert.equal(changed.value, 'custom-live');
      await act(async () => cellRoot.render(React.createElement(SelectCellRenderer, { ...props, row: changed })));
      const removed = structuredClone(bundle); removed.themes = removed.themes.filter(theme => theme.key !== 'custom-live');
      await publish({}, { bundle: removed });
      assert.equal(select.value, 'custom-live');
      assert.equal([...select.options].find(option => option.value === 'custom-live').disabled, true);
      assert.equal(changed.value, 'custom-live');
    } finally { await act(async () => cellRoot.unmount()); cellHost.remove(); }
  });
  await act(async () => root.unmount()); assert.equal(mediaListeners.size, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, scope: 'Production settings snapshot, i18n, AppTheme, color/updater consumers, settings editor launch and 3 renderers × 5 color states. Synthetic DOM/native IPC fixtures; mode bootstrap/provider/menu coverage includes structural assertions, not native window paint.' }, null, 2));
} finally { await window.happyDOM.abort(); fs.rmSync(temp, { recursive: true, force: true }); }
// React scheduler may retain a Node MessagePort after the synthetic window closes.
execFileSync(process.execPath, [path.join(studio, 'scripts/check-settings-apply.cjs')], { stdio: 'inherit' });
process.exit(0);
