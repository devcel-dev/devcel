// Focused integration checks: real draft store, MainWindow handlers and React ColumnEditor.
// Native dialogs/IPC are stubbed; this does not substitute for native UI verification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { compileModule } = require('./compile-module.cjs');
const { IntlMessageFormat } = require('intl-messageformat');
const root = path.resolve(__dirname, '..');
const reports = [];
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/app/i18n/generated/catalog.json'))).messages.ja;
const t = (key, values) => {
  assert(Object.hasOwn(catalog, key), `Missing Japanese message ${key}`);
  return String(new IntlMessageFormat(catalog[key], 'ja', undefined, { ignoreTag: true }).format(values));
};
const i18n = { t, useI18n: () => ({ t, locale: 'ja' }), localizeError: value => typeof value === 'object' && value?.key ? t(value.key, value.values) : String(value || ''), message: (key, values) => ({ key, values }), resolveMessage: value => typeof value === 'string' ? value : t(value.key, value.values) };
const formulaModules = new Map();
function formulaModule(relative) {
  if (!formulaModules.has(relative)) formulaModules.set(relative, load(relative, {
    '@tauri-apps/api/core': { invoke: async () => ({ functions: ['SUM'], table: null }) },
    '@/app/commands/tableCommands': { getTableCatalog: async () => [] },
    '@/app/services/tableSnapshotInvalidation': { retainTableSnapshotInvalidation: () => ({ ready: Promise.resolve(), release() {} }) }
  }));
  return formulaModules.get(relative);
}
function load(relative, mocks = {}) {
  const filename = path.join(root, relative);
  const module = new Module(filename);
  module.paths = Module._nodeModulePaths(root);
  module.require = id => Object.hasOwn(mocks, id) ? mocks[id] :
    id.startsWith('@/app/components/formula/') || id.startsWith('@/app/utils/formula') ? formulaModule(id.replace('@/', 'src/') + (id.includes('/components/') ? '.tsx' : '.ts')) :
    relative.includes('/formula/') && id.startsWith('./') ? formulaModule(path.posix.join(path.posix.dirname(relative), id + '.tsx')) :
    id === './formulaTokens' ? formulaModule('src/app/utils/formulaTokens.ts') :  id === '@/app/utils/useSettingsCloseGuard' ? load('src/app/utils/useSettingsCloseGuard.ts') : id === './previewDisplayLabels' ? load('src/app/components/column-editor/previewDisplayLabels.ts') : id === '@/app/utils/validation' ? load('src/app/utils/validation.ts') : id === '@/app/i18n' ? i18n : id.endsWith('.css') || id.startsWith('@/') ? {} : require(id);
  module._compile(compileModule(fs.readFileSync(filename, 'utf8'), filename), filename);
  return module.exports;
}
function storage() {
  const values = new Map();
  return { values, get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
async function check(name, action) { await action(); reports.push(name); }
(async () => {
  const disk = storage(); global.sessionStorage = disk;
  let approved = false, asks = [], session = { id: 'A', path: '/main' }, selected = '/companion', log = [];
  let askAction, openAction, closeAction, wizardAction, flushAction, stringEditorMayClose = true, markdownPending = false;
  const ask = async (text, options) => { asks.push({ text, options }); if (askAction) await askAction(); return approved; };
  const lifecycle = load('src/app/utils/columnDraftLifecycle.ts', { '@/app/services/appDialogs': { ask } });
  const store = lifecycle.columnDraftStore;
  const key = (id, mode = 'table', column = 'column') => `${id}:devcel:column-draft:${mode}:table:${column}`;
  const main = load('src/app/pages/main_window/MainWindow.tsx', {
    '@/app/applicationMode': { isSettingsEditor: () => false },
    '@/app/utils/columnDraftLifecycle': lifecycle,
    '@/app/utils/string_editor_window': { requestCloseStringEditor: async () => stringEditorMayClose },
    '@/app/utils/markdownSaveLifecycle': { flushMarkdownEdits: async id => { log.push(`flush:${id}`); if (flushAction) await flushAction(); }, hasPendingMarkdownEdits: () => markdownPending },
    '@/app/commands/projectCommands': { getProjectSession: async () => session && { ...session }, openProject: async () => { log.push('open'); if (openAction) await openAction(); else session = { id: 'B', path: '/companion' }; }, closeProject: async () => { log.push('close'); if (closeAction) await closeAction(); else session = null; } },
    '@/app/utils/project_create_wizard': { showProjectCreateWizard: async () => { log.push('wizard'); if (wizardAction) await wizardAction(); } },
    '@tauri-apps/plugin-dialog': { open: async () => selected },
    '@/app/services/appDialogs': { message: async () => {}, appAlert: async () => {} },
  });
  const props = { runProjectOperation: async action => action(), beginProjectTransition: () => log.push('unmount') };
  function reset() { markdownPending = false; stringEditorMayClose = true; approved = false; asks = []; session = { id: 'A', path: '/main' }; selected = '/companion'; log = []; askAction = openAction = closeAction = wizardAction = flushAction = undefined; for (const id of ['A', 'B', 'C']) store.discardSession(id); }
  await check('String window Cancel prevents project transition before any draft is discarded', async () => { reset(); stringEditorMayClose = false; store.write(key('A'), 'column draft'); await main.handleOpenProject(props); assert.equal(session.id, 'A'); assert.deepEqual(log, []); assert.equal(asks.length, 0); assert.equal(store.read(key('A')), 'column draft'); });
  await check('Open cancel keeps visible and hidden table/interface drafts and never unmounts', async () => { reset(); store.write(key('A'), 'visible'); store.write(key('A', 'interface'), 'hidden'); await main.handleOpenProject(props); assert.equal(asks.length, 1); assert.equal(session.id, 'A'); assert.deepEqual(log, []); assert.equal(store.keys('A').length, 2); });
  await check('Open approval unmounts before replacing project and discards only old session', async () => { reset(); approved = true; store.write(key('A'), 'main'); store.write(key('B'), 'companion'); await main.handleOpenProject(props); assert.deepEqual(log, ['flush:A', 'unmount', 'open']); assert.equal(session.id, 'B'); assert.equal(store.read(key('A')), null); assert.equal(store.read(key('B')), 'companion'); assert.equal(asks[0].options.cancelLabel, t('column.keepEditing')); });
  await check('Picker cancellation never asks or changes a draft', async () => { reset(); selected = null; store.write(key('A'), 'main'); await main.handleOpenProject(props); assert.equal(asks.length, 0); assert.deepEqual(log, []); assert.equal(store.read(key('A')), 'main'); });
  await check('Draft-free Open does not ask', async () => { reset(); await main.handleOpenProject(props); assert.equal(asks.length, 0); assert.equal(session.id, 'B'); });
  await check('Failed Open retaining current session preserves recovery', async () => { reset(); approved = true; store.write(key('A'), 'main'); openAction = async () => { throw Error('open failed'); }; await assert.rejects(main.handleOpenProject(props), /open failed/); assert.equal(session.id, 'A'); assert.equal(store.read(key('A')), 'main'); });
  await check('Backend replacement followed by failure still retires only approved old session', async () => { reset(); approved = true; store.write(key('A'), 'main'); store.write(key('B'), 'other'); openAction = async () => { session = { id: 'B' }; throw Error('P2P failed'); }; await assert.rejects(main.handleOpenProject(props), /P2P failed/); assert.equal(store.read(key('A')), null); assert.equal(store.read(key('B')), 'other'); });
  await check('Close cancel keeps draft and mounted view', async () => { reset(); store.write(key('A'), 'main'); await main.handleCloseProject(props); assert.deepEqual(log, []); assert.equal(store.read(key('A')), 'main'); });
  await check('Close approval clears old session after backend closes', async () => { reset(); approved = true; store.write(key('A'), 'main'); await main.handleCloseProject(props); assert.equal(session, null); assert.deepEqual(log, ['flush:A', 'unmount', 'close']); assert.equal(store.read(key('A')), null); });
  await check('Create cancel does not launch wizard', async () => { reset(); store.write(key('A'), 'main'); await main.handleCreateProject(props); assert.deepEqual(log, []); assert.equal(store.read(key('A')), 'main'); });
  await check('Approved Create followed by wizard cancellation preserves draft', async () => { reset(); approved = true; store.write(key('A'), 'main'); await main.handleCreateProject(props); assert.deepEqual(log, ['flush:A', 'wizard']); assert.equal(store.read(key('A')), 'main'); });
  await check('Successful Create unmounts old view before discarding draft', async () => { reset(); approved = true; store.write(key('A'), 'main'); wizardAction = async () => { session = { id: 'C' }; }; const p = { ...props, beginProjectTransition: () => { assert.equal(store.read(key('A')), 'main'); log.push('unmount'); } }; await main.handleCreateProject(p); assert.deepEqual(log, ['flush:A', 'wizard', 'unmount']); assert.equal(store.read(key('A')), null); });
  await check('Markdown flush failure never transitions or removes draft', async () => { reset(); approved = true; store.write(key('A'), 'main'); flushAction = async () => { throw Error('markdown failed'); }; await assert.rejects(main.handleOpenProject(props), /markdown failed/); assert.deepEqual(log, ['flush:A']); assert.equal(store.read(key('A')), 'main'); });
  await check('Native close re-flushes Markdown documents dirtied during the first pending write', async () => {
    reset(); let finish; let passes = 0; const firstWrite = new Promise(resolve => { finish = resolve; });
    flushAction = async () => { if (++passes === 1) await firstWrite; else markdownPending = false; };
    const closing = main.flushAllMarkdownEditsForClose(); assert.equal(passes, 1);
    markdownPending = true; finish(); await closing;
    assert.equal(passes, 2); assert.deepEqual(log, ['flush:undefined', 'flush:undefined']); assert.equal(markdownPending, false);
  });
  await check('Failure while re-flushing newly dirty Markdown stops close and keeps pending work', async () => {
    reset(); let passes = 0;
    flushAction = async () => { if (++passes === 1) markdownPending = true; else throw Error('new Markdown write failed'); };
    await assert.rejects(main.flushAllMarkdownEditsForClose(), /new Markdown write failed/);
    assert.equal(passes, 2); assert.equal(markdownPending, true); assert.deepEqual(log, ['flush:undefined', 'flush:undefined']);
  });
  await check('Session changed during confirmation cannot inherit approval', async () => { reset(); approved = true; store.write(key('A'), 'main'); askAction = async () => { session = { id: 'B' }; }; await main.handleOpenProject(props); assert(!log.includes('open')); assert(!log.includes('unmount')); assert.equal(store.read(key('A')), 'main'); });
  await check('Malformed stored caches are guarded without parsing or dropping', async () => { reset(); disk.setItem(key('A', 'interface', 'invalid'), '{bad-json'); await main.handleOpenProject(props); assert.equal(asks.length, 1); assert.equal(store.read(key('A', 'interface', 'invalid')), '{bad-json'); });
  await check('Storage unavailable still retains in-memory drafts and session guards', async () => { const memory = new lifecycle.ColumnDraftStore(() => { throw Error('storage unavailable'); }); memory.write(key('A'), 'value'); assert.equal(memory.read(key('A')), 'value'); assert.deepEqual(memory.keys('A'), [key('A')]); memory.discardSession('A'); assert.equal(memory.read(key('A')), null); });
  await check('Storage removal failure cannot resurrect explicitly discarded drafts', async () => { const flaky = storage(); flaky.setItem(key('A'), 'old'); flaky.removeItem = () => { throw Error('remove blocked'); }; const memory = new lifecycle.ColumnDraftStore(() => flaky); assert.equal(memory.keys('A').length, 1); memory.remove(key('A')); assert.equal(flaky.getItem(key('A')), 'old'); assert.equal(memory.read(key('A')), null); assert.deepEqual(memory.keys('A'), []); });
  await check('Prefix collisions and unrelated storage are preserved', async () => { const disk = storage(); const memory = new lifecycle.ColumnDraftStore(() => disk); memory.write(key('A'), 'a'); memory.write(key('AA'), 'aa'); memory.write('A:unrelated', 'ui'); memory.discardSession('A'); assert.equal(memory.read(key('AA')), 'aa'); assert.equal(memory.read('A:unrelated'), 'ui'); });
  // Mount the production editor with real React state/effects, replacing only IPC and unrelated subeditors.
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://draft-guard.invalid' });
  for (const name of ['window','document','navigator','HTMLElement','HTMLInputElement','Element','Node','Event','MouseEvent','KeyboardEvent','MutationObserver']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react'); const { createRoot } = require('react-dom/client');
  const column = { read_only: false, uuid: 'column', data_name: 'attack', display_name: 'attack', data_type: 'I64', min_version: 0 };
  const interactionScope = load('src/app/services/tableInteractionScope.ts');
  const editorCalls = [];
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const editor = load('src/app/components/column-editor/ColumnEditor.tsx', {
    '@/app/types/tableTypes': load('src/app/types/tableTypes.ts'),
    '@/app/settings/displayLabels': load('src/app/settings/displayLabels.ts', { '@/app/applicationMode': { isSettingsEditor: () => false } }),
    '@/components/ui/switch': { Switch: ({ checked, onCheckedChange, ...props }) => React.createElement('input', { ...props, type: 'checkbox', role: 'switch', checked, onChange: event => onCheckedChange(event.target.checked) }) },
    '@/app/components/color/colorDisplay': load('src/app/components/color/colorDisplay.ts'),
    '@/app/services/tableInteractionScope': interactionScope,
    '@/app/utils/string_editor_window': { registerMainWindowCloseBlocker: () => () => {} },
    '@/app/utils/columnDraftLifecycle': lifecycle,
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      editorCalls.push({ command, args });
      if (command === 'load_column_editor') return { target: args.target, column, name: 'balance', revision: 'rev1', interface_owned: false };
      if (command === 'preview_column_editor') return { errors: [], error_count: 0, input_reports: [], samples: [], total_values: 0, changed_count: 0, empty_count: 0 };
      if (command === 'save_column_editor') return { column_uuid: 'column' };
      throw Error(`Unexpected editor command: ${command}`);
    } },
    '@tauri-apps/api/event': { emit: async () => {} },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ onCloseRequested: async () => () => {}, close: async () => {} }) },
    './ColumnTypePicker': { ColumnTypePicker: () => null }, '@/app/components/tags/TagSelector': { TagSelector: () => null }, './ColumnColorSwatches': { ColumnColorSwatches: () => null }, './InputValidationEditor': { InputValidationEditor: () => null }, './ConditionalFormattingEditor': { ConditionalFormattingEditor: () => null }, './RulePreview': { RulePreview: () => null },
  });
  let mountedRoot; const host = document.createElement('div'); document.body.append(host);
  const mount = async (id, columnUuid = 'column') => { mountedRoot = createRoot(host); await React.act(async () => { mountedRoot.render(React.createElement(editor.ColumnEditor, { expectedProjectSession: id, target: { mode: 'table', target_uuid: 'table', column_uuid: columnUuid }, onClose: () => {} })); }); };
  const unmount = async () => React.act(async () => { mountedRoot.unmount(); });
  const nameInput = () => host.querySelector('input[id$="-name"]');
  await check('Real ColumnEditor writes draft on edit and keeps it after unmount', async () => { reset(); await mount('A'); assert.equal(nameInput().value, 'attack'); await React.act(async () => { const input = nameInput(); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'MainDraftOnly'); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); assert.equal(JSON.parse(store.read(key('A'))).draft.name, 'MainDraftOnly'); await unmount(); assert.equal(store.keys('A').length, 1); });
  await check('Real ColumnEditor recovers same-session draft and banner', async () => { await mount('A'); assert.equal(nameInput().value, 'MainDraftOnly'); assert(host.textContent.includes(t('column.restoreNotice'))); await unmount(); });
  await check('Real ColumnEditor with same UUIDs in different session remains isolated', async () => { await mount('B'); assert.equal(nameInput().value, 'attack'); assert(!host.textContent.includes(t('column.restoreNotice'))); await unmount(); });
  await check('Real existing-column Save persists the recovered draft exactly once and clears its cache', async () => {
    editorCalls.length = 0; await mount('A');
    await React.act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === t('common.save')).click(); await tick(); });
    assert.equal(editorCalls.filter(call => call.command === 'preview_column_editor').length, 1);
    const saved = editorCalls.filter(call => call.command === 'save_column_editor');
    assert.equal(saved.length, 1); assert.equal(saved[0].args.request.draft.name, 'MainDraftOnly');
    assert.equal(store.read(key('A')), null); await unmount();
  });
  await check('Real new-column Cancel requires explicit discard and never persists the draft', async () => {
    editorCalls.length = 0; await mount('A', null);
    const creationKey = 'A:devcel:column-draft:table:table:new:end';
    await React.act(async () => { const input = nameInput(); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'NewDraft'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    await React.act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === t('common.cancel')).click(); await tick(); });
    assert(store.read(creationKey)); assert(host.textContent.includes(t('column.discardEditor')));
    await React.act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === t('column.keepEditing')).click(); });
    assert.equal(nameInput().value, 'NewDraft'); assert(store.read(creationKey));
    await React.act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === t('common.cancel')).click(); await tick(); });
    await React.act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === t('column.discardAndClose')).click(); });
    assert.equal(store.read(creationKey), null);
    assert.equal(editorCalls.filter(call => call.command === 'save_column_editor').length, 0); await unmount();
  });
  await check('Real ColumnEditor reverted draft is no longer pending', async () => { await mount('A'); assert.equal(nameInput().value, 'attack'); for (const value of ['temporary', 'attack']) { await React.act(async () => { const input = nameInput(); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); assert.equal(store.keys('A').length, value === 'attack' ? 0 : 1); } await unmount(); });
  const report = { passed: reports.length, checks: reports, scope: 'Actual handlers/store/React effects; stub native IPC/dialogs, no native layout assertion' };
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
