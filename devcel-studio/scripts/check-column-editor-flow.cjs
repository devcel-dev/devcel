// Focused production-component integration checks. Native IPC is stubbed; native layout is separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { compileModule } = require('./compile-module.cjs');
const { IntlMessageFormat } = require('intl-messageformat');
const root = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/app/i18n/generated/catalog.json'))).messages.ja;
const t = (key, values) => {
  assert(Object.hasOwn(catalog, key), `Missing Japanese message ${key}`);
  return String(new IntlMessageFormat(catalog[key], 'ja', undefined, { ignoreTag: true }).format(values));
};
const i18n = { t, formatNumber: value => String(value), getLocaleDirection: () => 'ltr', useI18n: () => ({ t, locale: 'ja' }), localizeError: value => typeof value === 'object' && value?.key ? t(value.key, value.values) : String(value || ''), message: (key, values) => ({ key, values }), resolveMessage: value => typeof value === 'string' ? value : t(value.key, value.values) };
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
  const filename = path.join(root, relative); const mod = new Module(filename);
  mod.paths = Module._nodeModulePaths(root);
  mod.require = id => Object.hasOwn(mocks, id) ? mocks[id] :
    id.startsWith('@/app/components/formula/') || id.startsWith('@/app/utils/formula') ? formulaModule(id.replace('@/', 'src/') + (id.includes('/components/') ? '.tsx' : '.ts')) :
    relative.includes('/formula/') && id.startsWith('./') ? formulaModule(path.posix.join(path.posix.dirname(relative), id + '.tsx')) :
    id === './formulaTokens' ? formulaModule('src/app/utils/formulaTokens.ts') : id === '@/app/types/tableTypes' ? load('src/app/types/tableTypes.ts') : id === '@/app/utils/useSettingsCloseGuard' ? load('src/app/utils/useSettingsCloseGuard.ts') : id === './DescriptionEditor' ? load('src/app/pages/main_window/project_view/table_view/components/DescriptionEditor.tsx', mocks) : id === './GridInsertIcon' ? load('src/app/pages/main_window/project_view/table_view/components/GridInsertIcon.tsx') : id === './previewDisplayLabels' ? load('src/app/components/column-editor/previewDisplayLabels.ts') : id === '@/app/utils/errorRecovery' ? load('src/app/utils/errorRecovery.ts') : id === '@/app/utils/validation' ? load('src/app/utils/validation.ts') : id === '@/app/i18n' ? i18n : id === '@/app/settings/displayLabels' ? load('src/app/settings/displayLabels.ts', { '@/app/applicationMode': { isSettingsEditor: () => false } }) : id === '@/app/settings' ? { getSettingsSnapshot: () => ({ bundle: { values: { color32Display: 'srgb', colorFloatDisplay: 'linear' } } }), subscribeSettings: () => () => {} } : id.endsWith('.css') || id.startsWith('@/') ? {} : require(id);
  mod._compile(compileModule(fs.readFileSync(filename, 'utf8'), filename), filename);
  return mod.exports;
}
const recovery = load('src/app/utils/errorRecovery.ts');
for (const code of ['error.io','error.parse','error.tableMissing','error.columnMissing','grid.loading.sessionChanged','error.historyUnavailable','column.validation.emptyName']) {
  assert.equal(recovery.canReloadDefinition({kind:'code',code,params:{}}), false, code);
  assert.equal(recovery.canRefreshGridError({kind:'code',code,params:{}}), false, code);
}
assert(recovery.canReloadDefinition({kind:'diagnostics',diagnostics:[{kind:'code',code:'error.staleData'}]}));
assert(recovery.canReloadDefinition({key:'column.staleNotice'}));
assert(!recovery.canReloadDefinition('error.staleData'));
assert(!recovery.canReloadDefinition({kind:'code',code:'error.io',params:{details:{kind:'code',code:'error.staleData'}}}));
assert(!recovery.canReloadDefinition({kind:'diagnostics',diagnostics:[{kind:'code',code:'error.staleData'},{kind:'code',code:'error.io'}]}));
assert(recovery.canRefreshGridError({kind:'grid-error-notice',summary:{key:'grid.committedDisplayFailed'},cause:{kind:'code',code:'error.io'}}));
assert(!recovery.canRefreshGridError({kind:'grid-error-notice',summary:{key:'grid.copyFailed'},cause:{kind:'code',code:'error.staleData'}}));
const reports = [];
async function check(name, fn) { await fn(); reports.push(name); }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
(async () => {
  // Test real in-app presentation/session ownership and cancellation ordering.
  let calls = [], result = null, presentation, createPending;
  const native = load('src/app/utils/column_type_dialog.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'create_column_type_session') { if (createPending) await createPending.promise; return `session-${calls.length}`; }
      return result;
    } },
  });
  const target = { mode: 'table', target_uuid: 'table', column_uuid: 'column' };
  const show = (signal, present = value => { presentation = value; }) => native.showColumnTypeDialog(target, 'project', 'revision', 'I32', signal, present);
  await check('In-app chooser preserves target/session/revision and returns only server-held selection', async () => {
    result = 'U16'; const pending = show(new AbortController().signal); await tick();
    assert.deepEqual(calls[0].args, { target, expectedProjectSession: 'project', expectedRevision: 'revision', value: 'I32' });
    assert.match(presentation.sessionId, /^session-/); presentation.finish(); assert.equal(await pending, 'U16');
    assert.equal(calls.at(-1).command, 'take_column_type_result');
  });
  await check('Cancel consumes the intent without changing the draft', async () => { result = null; const pending = show(new AbortController().signal); await tick(); presentation.finish(); assert.equal(await pending, null); });
  await check('Abort during session creation consumes the late session without displaying it', async () => {
    result = 'I64'; createPending = deferred(); const controller = new AbortController(); let shown = false;
    const pending = show(controller.signal, () => { shown = true; }); controller.abort(); createPending.resolve(); assert.equal(await pending, null); createPending = null;
    assert.equal(shown, false); assert.equal(calls.at(-1).command, 'take_column_type_result');
  });
  await check('Abort after presentation rejects even a resolved selection and late finish is harmless', async () => {
    result = 'I64'; const controller = new AbortController(); const pending = show(controller.signal); await tick(); const shown = presentation;
    controller.abort(); assert.equal(await pending, null); const count = calls.length; shown.finish(); await tick(); assert.equal(calls.length, count);
  });
  await check('Failed presentation consumes its session and surfaces the error', async () => { await assert.rejects(show(new AbortController().signal, () => { throw Error('presentation failed'); }), /presentation failed/); assert.equal(calls.at(-1).command, 'take_column_type_result'); });
  await check('Pre-aborted requests never create a session', async () => { const count = calls.length; const controller = new AbortController(); controller.abort(); assert.equal(await show(controller.signal), null); assert.equal(calls.length, count); });

  const { Window } = await import('happy-dom'); const window = new Window({ url: 'http://column-flow.invalid' });
  for (const name of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLButtonElement','Element','Node','NodeFilter','DOMRect','CustomEvent','Event','MouseEvent','KeyboardEvent','MutationObserver']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  window.HTMLElement.prototype.scrollIntoView = function () {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react'); const { createRoot } = require('react-dom/client');
  const host = document.createElement('div'); document.body.append(host); let mountedRoot;
  const render = async component => React.act(async () => { if (!mountedRoot) mountedRoot = createRoot(host); mountedRoot.render(component); });
  const unmount = async () => React.act(async () => { mountedRoot.unmount(); mountedRoot = null; });
  const click = async button => React.act(async () => { assert(button, 'Expected button'); button.click(); await tick(); });
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
  const input = async (element, value) => React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event('input', { bubbles: true })); });
  const types = load('src/app/utils/columnTypes.ts');
  const Button = React.forwardRef(({ variant, size, ...props }, ref) => React.createElement('button', { ...props, ref }));
  const Input = React.forwardRef((props, ref) => React.createElement('input', { ...props, ref }));
  let pendingSelection, pickerCalls = [], selections = [];
  const picker = load('src/app/components/column-editor/ColumnTypePicker.tsx', {
    '@/app/utils/columnTypes': types, '@/components/ui/button': { Button },
    '@/app/utils/column_type_dialog': { showColumnTypeDialog: (...args) => { pickerCalls.push(args); pendingSelection = deferred(); return pendingSelection.promise; } },
  });
  const pickerRef = React.createRef();
  const pickerElement = (overrides = {}) => React.createElement(picker.ColumnTypePicker, { ref: pickerRef, target, expectedProjectSession: 'project', expectedRevision: 'revision', value: 'I32', onChange: value => selections.push(value), ...overrides });
  await check('Sidebar renders only a compact in-app trigger; repeated clicks cannot duplicate a dialog', async () => { await render(pickerElement()); assert.equal(host.querySelectorAll('button').length, 1); assert.equal(host.querySelector('section'), null); await click(host.querySelector('button')); await click(host.querySelector('button')); assert.equal(pickerCalls.length, 1); assert.equal(host.querySelector('button').getAttribute('aria-expanded'), 'true'); await React.act(async () => pendingSelection.resolve(null)); await unmount(); });
  await check('In-app selection changes only the current draft and restores trigger focus', async () => { await render(pickerElement()); await click(host.querySelector('button')); await React.act(async () => pendingSelection.resolve('U16')); assert.deepEqual(selections, ['U16']); assert(document.activeElement === host.querySelector('button'), 'Picker trigger must regain focus'); await unmount(); });
  await check('Nested Escape cancellation is consumed once without changing the draft', async () => { await render(pickerElement()); await click(host.querySelector('button')); const signal = pickerCalls.at(-1)[4]; await React.act(async () => { assert.equal(pickerRef.current.cancel(), true); assert.equal(pickerRef.current.cancel(), false); pendingSelection.resolve('I64'); }); assert(signal.aborted); assert.deepEqual(selections, ['U16']); await unmount(); });
  await check('Changed project, revision, or target aborts stale chooser results', async () => {
    for (const override of [{ expectedProjectSession: 'other' }, { expectedRevision: 'new-revision' }, { target: { ...target, column_uuid: 'other-column' } }]) {
      await render(pickerElement()); await click(host.querySelector('button')); const signal = pickerCalls.at(-1)[4]; const stale = pendingSelection;
      await render(pickerElement(override)); assert(signal.aborted); await React.act(async () => stale.resolve('I64')); await unmount();
    }
    assert.deepEqual(selections, ['U16']);
  });
  await check('Unmount and busy state abort the in-app chooser without applying a result', async () => { await render(pickerElement()); await click(host.querySelector('button')); const signal = pickerCalls.at(-1)[4]; await render(pickerElement({ disabled: true })); assert(signal.aborted); await React.act(async () => pendingSelection.resolve('I64')); assert.deepEqual(selections, ['U16']); await unmount(); });

  await check('Unmount consumes an unresolved in-app chooser without touching another editor', async () => { await render(pickerElement()); await click(host.querySelector('button')); const signal = pickerCalls.at(-1)[4]; const stale = pendingSelection; await unmount(); assert(signal.aborted); await React.act(async () => stale.resolve('I64')); assert.deepEqual(selections, ['U16']); });
  await check('A failed chooser can be reopened, keeping the current type and draft intact', async () => { await render(pickerElement()); await click(host.querySelector('button')); await React.act(async () => pendingSelection.reject(Error('stale column'))); assert(host.querySelector('[role=alert]').textContent.includes('stale column')); assert.equal(host.querySelector('button').getAttribute('aria-expanded'), 'false'); await click(host.querySelector('button')); await React.act(async () => pendingSelection.resolve(null)); assert.deepEqual(selections, ['U16']); await unmount(); });

  const panel = load('src/app/components/column-editor/ColumnTypePickerPanel.tsx', { '@/app/utils/columnTypes': types, '@/components/ui/button': { Button }, '@/components/ui/input': { Input }, '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') } });
  await check('In-app type search supports precise U16 selection; Cancel and IME Escape remain local', async () => {
    let selected = null, cancelled = 0; await render(React.createElement(panel.ColumnTypePickerPanel, { value: 'I32', allowSelect: false, onSelect: value => { selected = value; }, onCancel: () => { cancelled++; } }));
    assert(document.activeElement === host.querySelector('input[type=search]'), 'Search must initially receive focus'); await input(host.querySelector('input[type=search]'), 'U16');
    await click(host.querySelector('input[type=radio]')); await click(button(t('column.typePicker.select'))); assert.equal(selected, 'U16');
    await React.act(async () => host.querySelector('input[type=search]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))); assert.equal(cancelled, 0);
    await React.act(async () => host.querySelector('input[type=search]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); assert.equal(cancelled, 1); await unmount();
  });

  await check('Existing Select columns can return to Select after an unsaved type change and picker reopen', async () => {
    let draft = 'Select';
    const open = () => render(React.createElement(panel.ColumnTypePickerPanel, { value: draft, allowSelect: true, onSelect: value => { draft = value; }, onCancel: () => {} }));
    await open(); await input(host.querySelector('input[type=search]'), 'I32'); await click(host.querySelector('input[type=radio]')); await click(button(t('column.typePicker.select')));
    assert.equal(draft, 'I32'); await unmount();
    await open(); await input(host.querySelector('input[type=search]'), 'Select'); const select = host.querySelector('input[type=radio][value=select]'); assert(select, 'Saved Select eligibility survives draft changes');
    await click(select); await click(button(t('column.typePicker.select'))); assert.equal(draft, 'Select'); await unmount();
  });
  await check('Color families and canonical types appear last', async () => { assert.equal(types.COLUMN_TYPE_FAMILIES.at(-1).id, 'color'); assert.deepEqual(types.COLUMN_TYPE_OPTIONS.slice(-2).map(item => item.value), ['Color32', 'ColorFloat']); });
  await check('Color type details retain the type/value format without color-space explanation', async () => {
    for (const value of ['Color32', 'ColorFloat']) {
      await render(React.createElement(panel.ColumnTypePickerPanel, { value, allowSelect: false, onSelect: () => {}, onCancel: () => {} }));
      assert(host.textContent.includes(value)); assert(host.textContent.includes(types.columnTypeDetails(value).range));
      assert(!host.textContent.includes(t('column.type.colorNote'))); assert.equal(types.columnTypeDetails(value).note, undefined); await unmount();
    }
  });
  await check('New and non-Select columns never offer Select, even if draft input is Select', async () => {
    await render(React.createElement(panel.ColumnTypePickerPanel, { value: 'Select', allowSelect: false, onSelect: () => { throw Error('Unexpected selection'); }, onCancel: () => {} }));
    await input(host.querySelector('input[type=search]'), 'Select'); assert.equal(host.querySelector('input[type=radio][value=select]'), null); assert(button(t('column.typePicker.select')).disabled); await unmount();
  });

  const dialogUi = load('src/components/ui/dialog.tsx', { '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') } });
  let dialogCalls = [], dialogClosed = 0, dialogLoadError = false, delayedResolve;
  const dialog = load('src/app/pages/column_type_dialog/ColumnTypeDialog.tsx', {
    '@/components/ui/dialog': dialogUi,
    '@/app/components/column-editor/ColumnTypePickerPanel': { ColumnTypePickerPanel: ({ allowSelect, onSelect, onCancel }) => { assert.equal(allowSelect, true, 'Native eligibility is forwarded to the picker'); return React.createElement('div', null, React.createElement('button', { onClick: onCancel }, 'dialog-cancel'), React.createElement('button', { onClick: () => onSelect('U16') }, 'dialog-select')); } },
    '@tauri-apps/api/core': { invoke: async (command, args) => { dialogCalls.push({ command, args }); if (command === 'get_column_type_session') { if (dialogLoadError) throw Error('expired session'); return { value: 'I32', allow_select: true }; } if (command === 'resolve_column_type_session' && delayedResolve) return delayedResolve.promise; } },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ onCloseRequested: async () => () => {}, close: async () => { dialogClosed++; }, setTitle: async () => {} }) },
  });
  await check('In-app dialog Cancel closes without a round-trip validation or saving selection', async () => { await render(React.createElement(dialog.default, { sessionId: 'session', onClose: () => { dialogClosed++; } })); await click(button('dialog-cancel')); assert.equal(dialogClosed, 1); assert.equal(dialogCalls.filter(call => call.command === 'resolve_column_type_session').length, 0); await unmount(); });
  await check('Expired in-app dialog still closes with Escape instead of trapping the user', async () => { dialogLoadError = true; await render(React.createElement(dialog.default, { sessionId: 'session', onClose: () => { dialogClosed++; } })); assert(document.querySelector('[role=alert]')); await React.act(async () => document.querySelector('[role=dialog]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); assert.equal(dialogClosed, 2); assert.equal(dialogCalls.filter(call => call.command === 'resolve_column_type_session').length, 0); await unmount(); dialogLoadError = false; });
  await check('In-app dialog resolves selection at most once, then closes only after the server accepts', async () => { delayedResolve = deferred(); await render(React.createElement(dialog.default, { sessionId: 'session', onClose: () => { dialogClosed++; } })); await click(button('dialog-select')); await click(button('dialog-select')); assert.equal(dialogCalls.filter(call => call.command === 'resolve_column_type_session').length, 1); assert.equal(dialogClosed, 2); await React.act(async () => delayedResolve.resolve()); assert.equal(dialogClosed, 3); await unmount(); });

  const integratedDialog = load('src/app/pages/column_type_dialog/ColumnTypeDialog.tsx', {
    '@/components/ui/dialog': dialogUi,
    '@/app/components/column-editor/ColumnTypePickerPanel': panel,
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'get_column_type_session') return { value: 'I32', allow_select: false };
      if (command === 'resolve_column_type_session') { result = args.value; return; }
      throw Error(command);
    } },
  });
  const integratedPicker = load('src/app/components/column-editor/ColumnTypePicker.tsx', {
    '@/app/utils/columnTypes': types, '@/components/ui/button': { Button },
    '@/app/utils/column_type_dialog': native,
    '@/app/pages/column_type_dialog/ColumnTypeDialog': { __esModule: true, default: integratedDialog.default },
  });
  await check('Real nested dialog searches, preserves integer precision, commits only selection and restores focus', async () => {
    result = null; const chosen = []; const before = calls.length;
    function LivePicker() { const [value, setValue] = React.useState('I32'); return React.createElement(integratedPicker.ColumnTypePicker, { target, value, expectedProjectSession: 'project', expectedRevision: 'revision', onChange: value => { chosen.push(value); setValue(value); } }); }
    await render(React.createElement(LivePicker));
    const trigger = host.querySelector('button'); await click(trigger);
    assert.equal(document.querySelectorAll('[role=dialog]').length, 1);
    const search = document.querySelector('input[type=search]'); assert(document.activeElement === search, 'In-app search should receive focus');
    await input(search, 'U64'); await click(document.querySelector('input[type=radio]')); await click(button(t('column.typePicker.select'))); await React.act(async () => { await tick(); await tick(); });
    assert.deepEqual(chosen, ['U64']); assert.equal(document.querySelector('[role=dialog]'), null); assert(document.activeElement === trigger, 'Trigger should regain focus');
    assert.deepEqual(calls.slice(before).map(item => item.command), ['create_column_type_session', 'get_column_type_session', 'resolve_column_type_session', 'take_column_type_result']); await unmount();
  });
  await check('Real nested dialog Escape cancels once without closing or changing the owning column', async () => {
    result = null; const chosen = []; const before = calls.length;
    await render(React.createElement(integratedPicker.ColumnTypePicker, { target, value: 'I32', expectedProjectSession: 'project', expectedRevision: 'revision', onChange: value => chosen.push(value) }));
    const trigger = host.querySelector('button'); await click(trigger);
    await React.act(async () => document.querySelector('input[type=search]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await React.act(async () => { await tick(); await tick(); });
    assert.equal(document.querySelector('[role=dialog]'), null); assert(host.querySelector('button')); assert.deepEqual(chosen, []); assert(document.activeElement === trigger, 'Trigger should regain focus');
    assert.equal(calls.slice(before).filter(item => item.command === 'take_column_type_result').length, 1); await unmount();
  });

  const memory = new Map(); const store = { read: key => memory.get(key) ?? null, write: (key, value) => memory.set(key, value), remove: key => memory.delete(key) };
  const originalColumn = { read_only: false, uuid: 'column', data_name: 'attack', display_name: 'attack', data_type: 'I32', min_version: 0 };
  let ipc = [], closed = 0, warningApproved = false, warnings = 0, pendingPreview, currentPreview, interfaceOwned = false, saveFailure = false, previewFailure = null;
  const preview = () => ({ type_changed: false, total_values: 2, error_count: 0, changed_count: 0, empty_count: 0, errors: [], input_reports: [], samples: [], presentation_samples: [] });
  const interactionScope = load('src/app/services/tableInteractionScope.ts');
  const columnsByTarget = new Map();
  let delayedColorDefault = null;
  const colorField = { ColorField: ({ label, value, type, disabled, onChange, columnSwatches }) => React.createElement('button', {
    type: 'button', disabled, 'data-color-field': label, 'data-color-value': value,
    'data-color-candidates': JSON.stringify(columnSwatches ?? []),
    onClick: () => onChange(type === 'ColorFloat' ? '[-2.0,4.0,0.5,0.0]' : '[128,64,32,0]'),
  }, `color-field:${label}`) };
  const swatchEditor = load('src/app/components/column-editor/ColumnColorSwatches.tsx', {
    '@/app/utils/color_picker_window': { colorPickerId: () => require('node:crypto').randomUUID() },
    '@/app/components/color/ColorField': colorField,
    '@/app/components/color/colorDisplay': load('src/app/components/color/colorDisplay.ts'),
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      ipc.push({ command, args }); assert.equal(command, 'preview_color');
      assert.equal(args.exposure, 0); assert.equal(args.input, ''); assert(['srgb','linear'].includes(args.interpretation));
      if (delayedColorDefault) return delayedColorDefault.promise;
      return { canonical: args.colorType === 'ColorFloat' ? '[1.0,1.0,1.0,1.0]' : '[255,255,255,255]' };
    } },
  });
  const editor = load('src/app/components/column-editor/ColumnEditor.tsx', {
    '@/components/ui/switch': { Switch: ({ checked, onCheckedChange, ...props }) => React.createElement('input', { ...props, type: 'checkbox', role: 'switch', checked, onChange: event => onCheckedChange(event.target.checked) }) },
    '@/app/components/tags/TagSelector': { TagSelector: ({value,onChange,disabled}) => React.createElement('input', {id:'fixture-tags',value:value.join(', '),disabled,onChange:event=>onChange(event.target.value.split(',').map(tag=>tag.trim()))}) }, './ColumnColorSwatches': swatchEditor,
    '@/app/components/color/ColorField': colorField,
    '@/app/components/color/colorDisplay': load('src/app/components/color/colorDisplay.ts'),
    '@/app/services/tableInteractionScope': interactionScope,
    '@/app/utils/string_editor_window': { registerMainWindowCloseBlocker: () => () => {} },
    '@/app/utils/columnDraftLifecycle': { columnDraftStore: store },
    '@/app/utils/table_rule_dialogs': { confirmInputWarnings: async () => { warnings++; return warningApproved; } },
    '@/app/types/tableRules': { inputValidationReport: () => null },
    '@tauri-apps/api/core': { invoke: async (command, args) => { ipc.push({ command, args }); if (command === 'load_column_editor') return { target: args.target, column: columnsByTarget.get(args.target.target_uuid) ?? originalColumn, name: 'balance', revision: 'revision', interface_owned: interfaceOwned }; if (command === 'preview_column_editor') { if (previewFailure) throw previewFailure; return pendingPreview ? pendingPreview.promise : currentPreview; } if (command === 'save_column_editor') { if (saveFailure) throw Error('save failed'); return { column_uuid: 'column' }; } throw Error(command); } },
    '@tauri-apps/api/event': { emit: async () => {} },
    '@tauri-apps/api/webviewWindow': { getCurrentWebviewWindow: () => ({ onCloseRequested: async () => () => {}, close: async () => {} }) },
    './ColumnTypePicker': { ColumnTypePicker: React.forwardRef(({ onChange }, ref) => { React.useImperativeHandle(ref, () => ({ cancel: () => false })); return React.createElement('button', { onClick: () => onChange('U16') }, 'set-type'); }) },
    './InputValidationEditor': { InputValidationEditor: () => null, SchemaConstraints: () => null }, './ConditionalFormattingEditor': { ConditionalFormattingEditor: () => null }, './RulePreview': { RulePreview: () => null },
  });
  const mountEditor = async (targetOverrides = {}) => { ipc = []; closed = 0; warnings = 0; warningApproved = false; currentPreview = preview(); pendingPreview = null; memory.clear(); await render(React.createElement(editor.ColumnEditor, { target: { ...target, ...targetOverrides }, expectedProjectSession: 'project', onClose: () => { closed++; } })); };
  const changeName = () => input(host.querySelector('input[id$="-name"]'), 'attack_new');
  const saved = () => ipc.filter(entry => entry.command === 'save_column_editor');
  await check('Invalid field names from Display return to Basic inline without reload or native writes', async () => {
    await mountEditor({ column_uuid: null });
    await input(host.querySelector('input[id$="-display-label"]'), 'Keep this label');
    await click(button(t('column.displayFormat')));
    await click(button(t('common.add')));
    assert.equal(host.querySelector('[role="tab"][aria-selected="true"]').textContent, t('column.basic'));
    const name = host.querySelector('input[id$="-name"]');
    assert.equal(name.getAttribute('aria-invalid'), 'true');
    assert.equal(document.activeElement, name);
    assert.equal(host.querySelector('input[id$="-display-label"]').value, 'Keep this label');
    assert(!button(t('column.reloadDiscard')));
    assert.equal(ipc.filter(x => x.command === 'preview_column_editor').length, 0);
    assert.equal(saved().length, 0);
    await input(name, 'valid_name');
    assert.equal(name.getAttribute('aria-invalid'), 'false');
    await click(button(t('common.add')));
    assert.equal(saved().length, 1);
    assert.equal(saved()[0].args.request.draft.display_name, 'Keep this label');
    await unmount();
  });
  await check('Save failures retain edits and only typed stale conflicts offer reload/discard', async () => {
    await mountEditor(); await changeName();
    saveFailure = true; await click(button(t('common.save')));
    assert(host.querySelector('[role="alert"]'));
    assert(!button(t('column.reloadDiscard')));
    assert.equal(host.querySelector('input[id$="-name"]').value, 'attack_new');
    saveFailure = false; await unmount();
    await mountEditor(); await changeName();
    previewFailure = {kind:'diagnostics',diagnostics:[{kind:'code',code:'error.staleData',params:{}}]};
    await click(button(t('common.save')));
    assert(button(t('column.reloadDiscard')));
    assert.equal(host.querySelector('input[id$="-name"]').value, 'attack_new');
    await unmount(); previewFailure = null;
  });
  await check('Interface display label edits independently from its internal field name', async () => {
    originalColumn.display_name = '攻撃 / Attack';
    await mountEditor({ mode: 'interface' });
    assert.equal(host.querySelector('input[id$="-name"]').value, 'attack');
    assert.equal(host.querySelector('input[id$="-display-label"]').value, '攻撃 / Attack');
    await input(host.querySelector('input[id$="-display-label"]'), 'Damage points');
    await click(button(t('common.save')));
    assert.equal(saved().length, 1);
    assert.equal(saved()[0].args.request.draft.name, 'attack');
    assert.equal(saved()[0].args.request.draft.display_name, 'Damage points');
    await unmount(); originalColumn.display_name = 'attack';
  });
  await check('Column write prohibition stays in the ordinary draft and saves atomically with definition edits', async () => {
    await mountEditor();
    const toggle = host.querySelector('[role="switch"][id$="-read-only"]');
    assert(toggle); assert.equal(toggle.checked, false);
    await click(toggle); await changeName();
    assert.equal(saved().length, 0); assert.equal(originalColumn.read_only, false);
    await click(button(t('common.save')));
    assert.equal(saved().length, 1); assert.equal(saved()[0].args.request.draft.read_only, true);
    assert.equal(saved()[0].args.request.draft.name, 'attack_new'); await unmount();
  });
  await check('Creation Cancel discards column write prohibition and inherited table columns retain a local toggle', async () => {
    await mountEditor({ column_uuid: null }); await click(host.querySelector('[role="switch"][id$="-read-only"]'));
    await click(button(t('common.cancel'))); await click(button(t('column.discardAndClose')));
    assert.equal(saved().length, 0); await unmount();
    interfaceOwned = true; await mountEditor();
    assert.equal(host.querySelector('[role="switch"][id$="-read-only"]').disabled, false);
    await unmount(); interfaceOwned = false;
    await mountEditor({ mode: 'interface' }); assert.equal(host.querySelector('[id$="-read-only"]').disabled, true); await unmount();
  });
  await check('Table and interface forms keep variable/display/type/default/protection/tags/tooltip/description order', async () => {
    for (const mode of ['table','interface']) for (const column_uuid of [null,'column']) {
      await mountEditor({mode,column_uuid});
      const fields = ['[id$="-name"]','[id$="-display-label"]', null, '[id$="-default"]','[id$="-read-only"]','#fixture-tags','[id$="-tooltip"]','[id$="-description"]']
        .map(selector => selector ? host.querySelector(selector) : button('set-type'));
      assert(fields.every(Boolean), 'every requested field is present');
      assert(host.textContent.includes(t('column.identityHint')), 'display/code distinction is explained');
      for (let i=1;i<fields.length;i++) assert(fields[i-1].compareDocumentPosition(fields[i]) & window.Node.DOCUMENT_POSITION_FOLLOWING);
      assert.equal(host.querySelector('#fixture-tags').disabled, mode === 'interface');
      assert.equal(host.querySelector('[id$="-read-only"]').disabled, mode === 'interface');
      assert.equal(host.querySelector('[id$="-min-version"]'), null);
      await unmount();
    }
  });
  const switches = { Switch: ({ checked, onCheckedChange, ...props }) => React.createElement('input', { ...props, type: 'checkbox', role: 'switch', checked, onChange: event => onCheckedChange(event.target.checked) }) };
  const inlineDialogUi = {
    Dialog: ({ children, open }) => open === false ? null : children,
    DialogContent: ({ children, onPointerDownOutside, ...props }) => React.createElement('div', { ...props, role: 'dialog' }, children),
    DialogTitle: ({ children, ...props }) => React.createElement('h2', props, children),
    DialogFooter: ({ children, ...props }) => React.createElement('footer', props, children),
  };
  const settingsLifecycle = load('src/app/utils/settingsDraftLifecycle.ts');
  const settingsDialog = load('src/app/pages/main_window/project_view/table_view/components/TableEditSettingsDialog.tsx', {
    '@/components/ui/switch': switches,
    '@/components/ui/dialog': inlineDialogUi,
    '@/app/utils/settingsDraftLifecycle': settingsLifecycle,
    '@/app/services/tableInteractionScope': interactionScope,
    '@/app/utils/string_editor_window': { registerMainWindowCloseBlocker: () => () => {} },
    '@radix-ui/react-dialog': {
      Root: ({ children }) => children, Portal: ({ children }) => children,
      Overlay: () => null, Title: ({ children, ...props }) => React.createElement('h2', props, children),
      Content: ({ children, onPointerDownOutside, ...props }) => React.createElement('div', { ...props, role: 'dialog' }, children),
    },
  });
  const permissions = { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true };
  const owner = { revision: 'settings-revision', table: { description: '', uuid: 'settings-table', display_name: 'Settings', metadata: { interface_order: [],  initial_transposed: false, edit_permissions: permissions  } } };
  const metadataTypes = load('src/app/types/tableTypes.ts');
  let parentEligibilityCalls = 0;
  const metadataDialog = load('src/app/pages/main_window/project_view/table_view/components/MetadataEditDialog.tsx', {
    '@/components/ui/dialog': inlineDialogUi,
    '@/app/utils/recordDisplayLabel': load('src/app/utils/recordDisplayLabel.ts'),
    '@/app/components/tags/TagSelector': { TagSelector: ({value,onChange,disabled}) => React.createElement('input', {id:'fixture-tags',value:value.join(', '),disabled,onChange:event=>onChange(event.target.value.split(',').map(tag=>tag.trim()))}) },
    '@/app/types/tableTypes': { ...metadataTypes, eligibleParentRecords: (...args) => { parentEligibilityCalls++; return metadataTypes.eligibleParentRecords(...args); } },
    '@/app/services/tableInteractionScope': interactionScope,
    '@/app/utils/string_editor_window': { registerMainWindowCloseBlocker: () => () => {} },
    '@radix-ui/react-dialog': {
      Root: ({ children }) => children, Portal: ({ children }) => children, Overlay: () => null,
      Title: ({ children, ...props }) => React.createElement('h2', props, children),
      Content: ({ children, onPointerDownOutside, ...props }) => React.createElement('div', { ...props, role: 'dialog' }, children),
    },
  });
  const textarea = async (element, value) => React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(element,value); element.dispatchEvent(new window.Event('input',{bubbles:true})); });
  const metadataOwner = { kind:'memo', recordUuid:'child', columnUuid:'column-id', revision:'metadata-revision', table: { records:[
    { uuid:'parent',parent_uuid:'',label:'Parent',tags:[],memo_texts:{} },
    { uuid:'child',parent_uuid:'parent',label:'Child',tags:['release'],memo_texts:{'column-id':'Original'} },
    { uuid:'descendant',parent_uuid:'child',label:'Descendant',tags:[],memo_texts:{} },
  ] } };
  await check('Cell memo draft cancels safely and repeated Save submits once', async()=>{
    const values=[]; let closed=0; const pending=deferred();
    await render(React.createElement(metadataDialog.MetadataEditDialog,{owner:metadataOwner,busy:false,error:'',onClose:()=>closed++,onSave:async value=>{values.push(value);return pending.promise;}}));
    assert.equal(host.querySelector('textarea').value,'Original');
    await textarea(host.querySelector('textarea'),'Updated\nMemo'); await click(button(t('common.cancel')));
    assert.equal(closed,0); assert(host.textContent.includes(t('column.unsavedChanges'))); assert.equal(parentEligibilityCalls,0,'Memo typing does not calculate parent eligibility');
    await click(button(t('common.save'))); await click(button(t('common.save'))); assert.deepEqual(values,['Updated\nMemo']);
    await React.act(async()=>pending.resolve(true)); assert.equal(closed,1); await unmount();
  });
  await check('Row tag typing never computes parent eligibility',async()=>{
    await render(React.createElement(metadataDialog.MetadataEditDialog,{owner:{...metadataOwner,kind:'tags'},busy:false,error:'',onClose:()=>{},onSave:async()=>true}));
    await input(host.querySelector('#fixture-tags'),'release, reviewed');
    assert.equal(parentEligibilityCalls,0); assert.equal(host.querySelector('#fixture-tags').value,'release, reviewed'); await unmount();
  });
  await check('Row tag save blocks newly invalid names while retaining legacy values',async()=>{
    const writes=[];const legacy={...metadataOwner,kind:'tags',table:{records:metadataOwner.table.records.map(row=>row.uuid==='child'?{...row,tags:['legacy/name']}:row)}};
    await render(React.createElement(metadataDialog.MetadataEditDialog,{owner:legacy,busy:false,error:'',onClose:()=>{},onSave:async(value,tags)=>{writes.push(tags);return true;}}));
    await input(host.querySelector('#fixture-tags'),'legacy/name, bad new');assert(button(t('common.save')).disabled);assert.equal(host.querySelector('#fixture-tags').value,'legacy/name, bad new');
    await click(button(t('common.save')));assert.equal(writes.length,0);
    await input(host.querySelector('#fixture-tags'),'legacy/name, valid_new');assert(!button(t('common.save')).disabled);await click(button(t('common.save')));assert.deepEqual(writes,[['legacy/name','valid_new']]);await unmount();
  });
  await check('Parent picker excludes self and descendants and preserves detach as an explicit choice',async()=>{
    const values=[]; await render(React.createElement(metadataDialog.MetadataEditDialog,{owner:{...metadataOwner,kind:'parent'},busy:false,error:'',onClose:()=>{},onSave:async value=>{values.push(value);return true;}}));
    assert.deepEqual([...host.querySelectorAll('option')].map(option=>option.value),['','parent']);
    await React.act(async()=>{const select=host.querySelector('select'); select.value='';select.dispatchEvent(new window.Event('change',{bubbles:true}));});
    await click(button(t('common.save'))); assert.deepEqual(values,['']); assert.equal(parentEligibilityCalls,1,'Changing parent selection reuses memoized candidates'); await unmount();
  });
  await check('Table settings edit the display name without a second description draft',async()=>{
    const values=[]; await render(React.createElement(settingsDialog.TableEditSettingsDialog,{owner,busy:false,error:'',onClose:()=>{},onSave:async value=>{values.push(value);return true;}}));
    assert.equal(host.querySelector('textarea'),null); await input(host.querySelector('input:not([type])'),'Table display name'); assert.equal(host.querySelector('input[id$="-tooltip"]'),null);
    assert.equal(owner.table.description,''); assert.equal(values.length,0); await click(button(t('common.close')));
    assert.equal(values[0].display_name,'Table display name'); assert.equal(values[0].description,owner.table.description);assert(!Object.hasOwn(values[0],'tooltip'));  await unmount();
  });
  await check('Column Save blocks newly invalid tags and keeps the draft editable',async()=>{
    await mountEditor();await input(host.querySelector('#fixture-tags'),'new/name');assert(button(t('common.save')).disabled);assert.equal(host.querySelector('#fixture-tags').value,'new/name');await click(button(t('common.save')));assert.equal(saved().length,0);
    await input(host.querySelector('#fixture-tags'),'new_name');assert(!button(t('common.save')).disabled);await click(button(t('common.save')));assert.deepEqual(saved()[0].args.request.draft.tags,['new_name']);await unmount();
  });
  await check('Removed font size control preserves the stored size while column tags apply',async()=>{
    originalColumn.style = { font_size: 18 };
    await mountEditor(); await input(host.querySelector('#fixture-tags'),'release, reviewed');
    await click(button(t('column.displayFormat'))); assert.equal(host.querySelector('input[id$="-font-size"]'),null);
    await click(button(t('common.save')));
    assert.deepEqual(saved()[0].args.request.draft.tags,['release','reviewed']); assert.equal(saved()[0].args.request.draft.font_size,18); await unmount();
    delete originalColumn.style;
  });
  await check('Interfaces applies settings once and preserves the displayed draft', async () => {
    let opened = 0; const values = [];
    const props = { owner, busy: false, error: '', onClose: () => {}, onSave: async value => { values.push(value); return true; }, onOpenInterfaces: () => opened++ };
    await render(React.createElement(settingsDialog.TableEditSettingsDialog, props));
    await input(host.querySelector('input:not([type])'), 'Keep my draft');
    await click(host.querySelector('[id$="-add_rows"]'));
    await click(host.querySelectorAll('input[type="radio"]')[1]);
    await click(button(t('grid.interfaces'))); assert.equal(opened, 1); assert.equal(values.length, 1);
    await render(React.createElement(settingsDialog.TableEditSettingsDialog, { ...props, open: false }));
    await render(React.createElement(settingsDialog.TableEditSettingsDialog, { ...props, open: true }));
    assert.equal(host.querySelector('input:not([type])').value, 'Keep my draft');
    assert.equal(host.querySelector('[id$="-add_rows"]').checked, false);
    assert.equal(host.querySelectorAll('input[type="radio"]')[1].checked, true);
    await click(button(t('common.close'))); assert.equal(values.length, 1); assert.equal(values[0].display_name, 'Keep my draft');
    await unmount();
  });
  await check('Real Radix settings applies before child navigation and returns with draft and focus', async () => {
    const realSettings = load('src/app/pages/main_window/project_view/table_view/components/TableEditSettingsDialog.tsx', {
      '@/components/ui/switch': switches,
    '@/components/ui/dialog': dialogUi,
    '@/app/utils/settingsDraftLifecycle': settingsLifecycle,
      '@/app/services/tableInteractionScope': interactionScope,
      '@/app/utils/string_editor_window': { registerMainWindowCloseBlocker: () => () => {} },
    });
    let opened = 0, closed = 0;
    const props = { owner, busy: false, error: '', onClose: () => closed++, onSave: async () => true, onOpenInterfaces: () => opened++ };
    await render(React.createElement(realSettings.TableEditSettingsDialog, props));
    const dialog = () => document.querySelector('[role="dialog"]');
    await input(dialog().querySelector('input:not([type])'), 'Retained in Radix');
    await click(button(t('grid.interfaces'))); assert.equal(opened, 1);
    await render(React.createElement(realSettings.TableEditSettingsDialog, { ...props, open: false }));
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
    await render(React.createElement(realSettings.TableEditSettingsDialog, props));
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(dialog().querySelector('input:not([type])').value, 'Retained in Radix');
    assert(dialog().contains(document.activeElement), 'Focus returns inside settings');
    await click(button(t('common.close'))); assert.equal(closed, 1);
    await unmount();
  });
  await check('Real Radix row context menu supports mouse and keyboard without single-row addition', async () => {
    const bootstrapSource = fs.readFileSync(path.join(root, 'src/app/main.tsx'), 'utf8');
    const captureBody = bootstrapSource.split("document.addEventListener('contextmenu', (e) => {")[1].split('}, true);')[0].replace(' as HTMLElement', '');
    const nativeContextCapture = new Function('e', captureBody);
    document.addEventListener('contextmenu', nativeContextCapture, true);
    const contextMenu = load('src/components/ui/context-menu.tsx', { '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') } });
    const toolbar = load('src/app/pages/main_window/project_view/table_view/components/DataGridToolbar.tsx', {
      '@/components/ui/context-menu': contextMenu,
      './TableActionIcons': load('src/app/pages/main_window/project_view/table_view/components/TableActionIcons.tsx'),
      './TableSearchBar': { TableSearchBar: () => null }, './VersionControls': { VersionViewControls: () => null },
    });
    let singles = 0, bulk = 0;
    const props = { addRowsAllowed: true, addColumnsAllowed: true, addRow: () => singles++, addRows: () => bulk++, addColumn: () => {}, isUpdating: false, rowCount: 1, columnCount: 1, searchQuery: '', filteredRowCount: 1 };
    for (const mode of ['mouse', 'ContextMenu', 'F10']) {
      await render(React.createElement(toolbar.DataGridToolbar, props));
      const trigger = host.querySelector('button[title="' + t('grid.addRow') + '"]');
      await React.act(async () => { trigger.focus(); trigger.dispatchEvent(mode === 'mouse'
        ? new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
        : new window.KeyboardEvent('keydown', { bubbles: true, key: mode, shiftKey: mode === 'F10' })); await tick(); });
      const item = document.querySelector('[role="menuitem"]'); assert(item); assert.equal(item.textContent, t('grid.bulk.add'));
      await click(item); assert.equal(singles, 0);
      await unmount();
    }
    document.removeEventListener('contextmenu', nativeContextCapture, true);
    assert.equal(bulk, 3);
  });
  await check('Table switches are independent and absent orientation callback uses the closing draft', async () => {
    const settingsSaved = []; let settingsClosed = 0;
    await render(React.createElement(settingsDialog.TableEditSettingsDialog, { owner, busy: false, error: '', onClose: () => settingsClosed++, onSave: async draft => { settingsSaved.push(draft); return true; } }));
    assert.equal(host.querySelectorAll('[role="switch"]').length, 5);
    await click(host.querySelector('[id$="-add_rows"]')); await click(host.querySelectorAll('input[type="radio"]')[1]);
    assert.equal(settingsSaved.length, 0); assert.equal(permissions.add_rows, true);
    await click(button(t('common.close'))); assert.equal(settingsSaved.length, 1); assert.equal(settingsClosed, 1);
    assert.deepEqual(settingsSaved[0], { display_name: 'Settings', initial_transposed: true, description: '', edit_permissions: { ...permissions, add_rows: false } }); await unmount();
  });
  await check('Table settings repeated Close submits once and waits for success', async () => {
    let count = 0, settingsClosed = 0; const pending = deferred();
    await render(React.createElement(settingsDialog.TableEditSettingsDialog, { owner, busy: false, error: '', onClose: () => settingsClosed++, onSave: async () => { count++; return pending.promise; } }));
    await click(host.querySelector('[id$="-delete_columns"]')); await click(button(t('common.close')));
    await click(button(t('common.saving'))); assert.equal(count, 1); assert.equal(settingsClosed, 0);
    await React.act(async () => pending.resolve(true)); assert.equal(settingsClosed, 1); await unmount();
  });
  await check('Existing editor footer offers explicit Save and Cancel with one-line status', async () => { await mountEditor(); const footer = host.querySelector('footer'); assert(![...footer.querySelectorAll('button')].some(b => [t('column.check'), t('common.reset')].includes(b.textContent))); assert(button(t('common.save'))); assert.equal(footer.querySelector('[role=status]').className, 'editor-status'); await unmount(); });
  await check('Save always performs Rust preview before persistence and ignores rapid duplicate clicks', async () => { await mountEditor(); await changeName(); pendingPreview = deferred(); await click(button(t('common.save'))); await click(button(t('common.save'))); assert.equal(ipc.filter(i => i.command === 'preview_column_editor').length, 1); assert.equal(saved().length, 0); await React.act(async () => pendingPreview.resolve(preview())); assert.equal(saved().length, 1); assert.equal(closed, 1); assert.equal(memory.size, 0); await unmount(); });
  await check('Type change is reviewed through Save, then revalidated by a second Save', async () => { await mountEditor(); await click(button('set-type')); await click(button(t('common.save'))); assert.equal(saved().length, 0); assert(host.textContent.includes(t('column.typeChangeReady'))); assert(host.querySelector('[role=tabpanel]').id.endsWith('basic')); await click(button(t('common.save'))); assert.equal(ipc.filter(i => i.command === 'preview_column_editor').length, 2); assert.equal(saved().length, 1); assert.equal(saved()[0].args.expectedProjectSession, 'project'); assert.equal(saved()[0].args.request.expected_revision, 'revision'); await unmount(); });
  await check('Preview errors never persist; edits clear the previous review', async () => { await mountEditor(); await click(button('set-type')); await click(button(t('common.save'))); await changeName(); await click(button(t('common.save'))); assert.equal(saved().length, 0); currentPreview = { ...preview(), error_count: 1, errors: ['bad conversion'] }; await click(button(t('common.save'))); assert.equal(saved().length, 0); assert(host.querySelector('[role=alert]')); await unmount(); });
  await check('Reject rules block Close; warning cancel preserves the draft and later approval uses fresh preview acknowledgement', async () => { await mountEditor(); await changeName(); const issue = { mode: 'reject', column_name: 'attack', record_uuid: 'row' }; currentPreview = { ...preview(), input_reports: [{ table_uuid: 'table', report: { issues: [issue], acknowledgement: 'fresh-token' } }] }; await click(button(t('common.save'))); assert.equal(saved().length, 0); assert.equal(warnings, 0); issue.mode = 'warn'; await click(button(t('common.save'))); assert.equal(saved().length, 0); assert.equal(warnings, 1); assert(memory.size); warningApproved = true; await click(button(t('common.save'))); assert.equal(saved().length, 1); assert.equal(saved()[0].args.request.acknowledgement, 'fresh-token'); await unmount(); });
  await check('Creation Cancel then keep-editing preserves data; discard removes the draft', async () => { await mountEditor({ column_uuid: null }); await changeName(); await click(button(t('common.cancel'))); assert(memory.size); await click(button(t('column.keepEditing'))); assert.equal(host.querySelector('input[id$="-name"]').value, 'attack_new'); assert.equal(closed, 0); await click(button(t('common.cancel'))); await click(button(t('column.discardAndClose'))); assert.equal(closed, 1); assert.equal(memory.size, 0); await unmount(); await mountEditor(); assert.equal(host.querySelector('input[id$="-name"]').value, 'attack'); await unmount(); });
  await check('Leaving the editor during validation cannot persist the old request', async () => { await mountEditor(); await changeName(); pendingPreview = deferred(); const delayed = pendingPreview; await click(button(t('common.save'))); await unmount(); await React.act(async () => delayed.resolve(preview())); assert.equal(saved().length, 0); assert.equal(closed, 0); assert(memory.size); });
  const rulePreview = load('src/app/components/column-editor/RulePreview.tsx');
  await check('Rule preview has no independent Check button or empty instructional panel', async () => {
    await render(React.createElement(rulePreview.RulePreview, { preview: null, kind: 'rules', columnName: 'Value' }));
    assert.equal(host.textContent, '');
    await render(React.createElement(rulePreview.RulePreview, { preview: preview(), kind: 'rules', columnName: 'Value' }));
    assert.equal(host.querySelectorAll('button').length, 0); assert(host.querySelector('[aria-live=polite]'));
    await unmount();
  });

  await check('Input rule toggle appears only with conditions and disabling preserves them', async () => {
    const rules = load('src/app/components/column-editor/InputValidationEditor.tsx', { './RuleEditorDialog': { RuleEditorDialog: () => null } });
    let latest;
    function LiveRules() {
      const [value,setValue] = React.useState(null);
      return React.createElement(rules.InputValidationEditor, { value, onChange: next => { latest=next;setValue(next); }, disabled:false, inherited:false, columnType:'String', constraintColumn:originalColumn, showSchemaConstraints:false });
    }
    await render(React.createElement(LiveRules));
    const toggle = () => host.querySelector('input[id$="-enabled"]');
    assert.equal(toggle(),null); await click(button(t('rules.add')));
    assert(toggle().checked); assert.equal(latest.rules.length,1); await click(toggle());
    assert.equal(latest.enabled,false); assert.equal(latest.rules.length,1);
    await click(host.querySelector('[aria-label="'+t('rules.deleteNthInput',{index:1})+'"]'));
    assert.equal(toggle(),null); assert.equal(latest.rules.length,0); assert.equal(latest.enabled,false);
    await click(button(t('rules.add'))); assert.equal(toggle().checked,false); assert.equal(latest.rules.length,1);
    await unmount();
  });
  const versionField = () => host.querySelector('input[id$="-min-version"]');
  await check('Regular table/interface editors never edit content version', async () => {
    originalColumn.min_version=3;
    for(const mode of ['table','interface']) {
      await mountEditor({mode}); assert.equal(versionField(),null); await changeName();
      await click(button(t('common.save'))); assert.equal(saved().at(-1).args.request.draft.min_version,'3'); await unmount();
    }
    originalColumn.min_version=0;
  });
  await check('Restored drafts cannot overwrite the current content version', async () => {
    originalColumn.min_version=7; await mountEditor(); await changeName(); await unmount();
    const [cacheKey,serialized]=[...memory.entries()][0]; const cached=JSON.parse(serialized);
    cached.draft.min_version='999'; memory.set(cacheKey,JSON.stringify(cached));
    await render(React.createElement(editor.ColumnEditor,{target,expectedProjectSession:'project',onClose:()=>{closed++;}}));
    assert.equal(versionField(),null); await click(button(t('common.save')));
    assert.equal(saved().at(-1).args.request.draft.min_version,'7'); await unmount(); originalColumn.min_version=0;
  });
  await check('New columns hide version input and preserve the backend default on Add', async () => {
    originalColumn.min_version = 3;
    for (const mode of ['table', 'interface']) {
      await mountEditor({ mode, column_uuid: null }); assert.equal(versionField(), null);
      await changeName(); await click(button(t('common.add')));
      assert.equal(saved().at(-1).args.request.draft.min_version, '3'); await unmount();
    }
    originalColumn.min_version = 0;
  });
  await check('Cancel and Escape discard existing-column names and nested type drafts without persistence', async () => {
    for (const escape of [false, true]) {
      await mountEditor(); await changeName(); await click(button('set-type'));
      if (escape) await React.act(async () => host.querySelector('aside').dispatchEvent(new window.KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })));
      else await click(button(t('common.cancel')));
      await React.act(async () => { await tick(); await tick(); });
      assert.equal(saved().length, 0); assert.equal(ipc.filter(x => x.command === 'preview_column_editor').length, 0);
      assert.equal(closed, 1); assert.equal(memory.size, 0); assert.equal(originalColumn.data_name, 'attack'); await unmount();
    }
  });
  await check('Table display label edits preserve the internal name and local columns hide interface tabs', async () => {
    await mountEditor(); assert.equal(button(t('column.originTargets')), undefined);
    await input(host.querySelector('input[id$="-display-label"]'), 'Readable label');
    await click(button(t('common.save')));
    assert.equal(saved().at(-1).args.request.draft.name, 'attack');
    assert.equal(saved().at(-1).args.request.draft.display_name, 'Readable label'); await unmount();
  });
  await check('Inherited table/interface versions are locked and retain the existing owner route', async () => {
    interfaceOwned = true; originalColumn.min_version = 4; originalColumn.interface_origin = 'owner';
    for (const mode of ['table', 'interface']) {
      await mountEditor({ mode }); assert.equal(versionField(), null);
      await click(button(t('column.originTargets'))); assert(host.querySelector('[role=tabpanel]').id.endsWith('origin')); assert(button(t('column.openOrigin'))); await unmount();
    }
    interfaceOwned = false; originalColumn.min_version = 0; delete originalColumn.interface_origin;
  });
  await check('A cache missing the mandatory version is rejected without restoring other edits', async () => {
    originalColumn.min_version = 7; await mountEditor(); await changeName(); await unmount();
    const [cacheKey, serialized] = [...memory.entries()][0]; const cached = JSON.parse(serialized); delete cached.draft.min_version; memory.set(cacheKey, JSON.stringify(cached));
    await render(React.createElement(editor.ColumnEditor, { target, expectedProjectSession: 'project', onClose: () => { closed++; } }));
    assert(host.textContent.includes(t('column.unsupportedDraft'))); assert.equal(versionField(), null);
    assert.equal(saved().length, 0); await unmount(); originalColumn.min_version = 0;
  });
  await check('An invalid numeric version cache is rejected rather than silently changing its meaning', async () => {
    await mountEditor(); await changeName(); await unmount(); const [cacheKey, serialized] = [...memory.entries()][0];
    const cached = JSON.parse(serialized); cached.draft.min_version = 8; memory.set(cacheKey, JSON.stringify(cached));
    await render(React.createElement(editor.ColumnEditor, { target, expectedProjectSession: 'project', onClose: () => {} }));
    assert(host.textContent.includes(t('column.unsupportedDraft'))); assert.equal(versionField(), null); await unmount();
  });

  const swatchRows = () => [...host.querySelectorAll('[data-swatch-id]')];
  const swatchName = index => swatchRows()[index]?.querySelector('input');
  const swatchButton = (index, key) => [...swatchRows()[index].querySelectorAll('button')].find(b => b.getAttribute('aria-label') === t(key, { name: swatchName(index).value }));
  await check('Column swatches add canonical white, preserve HDR alpha and IDs through rename/reorder/delete, and save only with the column', async () => {
    originalColumn.data_type = 'ColorFloat'; originalColumn.default_value = '[1.0,1.0,1.0,1.0]';
    await mountEditor(); assert.equal(swatchRows().length, 0); await click(button(t('column.swatches.add')));
    assert.equal(swatchRows().length, 1); assert.equal(saved().length, 0);
    assert.equal(swatchRows()[0].querySelector('[data-color-value]').dataset.colorValue, '[1.0,1.0,1.0,1.0]');
    const firstId = swatchRows()[0].dataset.swatchId; assert.match(firstId, /^[0-9a-f-]{36}$/);
    await input(swatchName(0), 'HDR transparent'); await click(swatchRows()[0].querySelector('[data-color-field]'));
    assert.equal(swatchRows()[0].dataset.swatchId, firstId);
    await click(button(t('column.swatches.add'))); await input(swatchName(1), 'White'); const secondId = swatchRows()[1].dataset.swatchId;
    await click(swatchButton(1, 'column.swatches.moveUp')); assert.equal(swatchRows()[0].dataset.swatchId, secondId);
    await click(swatchButton(0, 'column.swatches.remove')); assert.equal(swatchRows().length, 1);
    await click(button(t('common.save'))); assert.equal(saved().length, 1);
    assert.deepEqual(saved()[0].args.request.draft.color_swatches, [{ id:firstId, name:'HDR transparent', data_type:'ColorFloat', value:'[-2.0,4.0,0.5,0.0]' }]);
    assert.equal(ipc.filter(entry => entry.command.includes('user_color')).length, 0); await unmount();
  });
  await check('Mismatched swatches stay disabled without coercion and metadata survives switching to a non-color type', async () => {
    originalColumn.color_swatches = [{ id:'11111111-1111-4111-8111-111111111111', name:'Byte', data_type:'Color32', value:'[128,64,32,0]' }];
    await mountEditor(); assert(swatchRows()[0].querySelector('[data-color-field]').disabled);
    assert(host.textContent.includes(t('column.swatches.mismatch', { type:'Color32' })));
    await input(swatchName(0), 'Keep byte'); await click(button('set-type')); assert.equal(host.querySelector('[data-column-swatches]'), null);
    await click(button(t('common.save'))); await click(button(t('common.save')));
    assert.deepEqual(saved().at(-1).args.request.draft.color_swatches, [{ ...originalColumn.color_swatches[0], name:'Keep byte' }]);
    await unmount(); delete originalColumn.color_swatches;
  });
  await check('New-column Cancel discards swatches and Add commits them', async () => {
    originalColumn.data_type = 'Color32'; originalColumn.default_value = '[255,255,255,255]';
    await mountEditor({ column_uuid: null }); await click(button(t('column.swatches.add'))); await click(button(t('common.cancel')));
    await click(button(t('column.discardAndClose'))); assert.equal(saved().length, 0); assert.equal(memory.size, 0); await unmount();
    await mountEditor(); assert.equal(swatchRows().length, 0); await unmount();
    await mountEditor({ column_uuid:null }); await input(host.querySelector('input[id$="-name"]'), 'new_color');
    await click(button(t('column.swatches.add'))); assert.equal(saved().length, 0); await click(button(t('common.add')));
    assert.equal(saved().length, 1); assert.equal(saved()[0].args.request.creation_uuid, 'column');
    assert.equal(saved()[0].args.request.draft.color_swatches.length, 1); await unmount();
  });
  await check('Inherited table and child-interface palettes are locked and retain the owner route', async () => {
    originalColumn.color_swatches = [{ id:'11111111-1111-4111-8111-111111111111', name:'Inherited', data_type:'Color32', value:'[128,64,32,0]' }];
    interfaceOwned = true; originalColumn.interface_origin = 'owner';
    for (const mode of ['table','interface']) {
      await mountEditor({ mode }); assert(swatchName(0).disabled);
      assert([...host.querySelector('[data-column-swatches]').querySelectorAll('button')].every(b => b.disabled));
      assert(!button(t('common.save')).disabled); assert.equal(saved().length, 0); await click(button(t('column.originTargets'))); assert(button(t('column.openOrigin'))); await unmount();
    }
    interfaceOwned = false; delete originalColumn.interface_origin; delete originalColumn.color_swatches;
  });
  await check('Delayed add cannot duplicate candidates or apply after a type change or unmount', async () => {
    await mountEditor(); delayedColorDefault = deferred(); await click(button(t('column.swatches.add'))); await click(button(t('column.swatches.add')));
    assert.equal(ipc.filter(entry => entry.command === 'preview_color').length, 1); await click(button('set-type'));
    await React.act(async () => delayedColorDefault.resolve({ canonical:'[255,255,255,255]' }));
    await click(button(t('common.save'))); await click(button(t('common.save')));
    assert.deepEqual(saved().at(-1).args.request.draft.color_swatches, []); await unmount();
    await mountEditor(); delayedColorDefault = deferred(); await click(button(t('column.swatches.add'))); const late = delayedColorDefault;
    await unmount(); await React.act(async () => late.resolve({ canonical:'[255,255,255,255]' })); assert.equal(saved().length, 0); delayedColorDefault = null;
  });
  await check('Draft caches missing current swatch metadata are rejected without clearing persisted candidates', async () => {
    await mountEditor(); await changeName(); await unmount(); const [cacheKey, serialized] = [...memory.entries()][0];
    const cache = JSON.parse(serialized); delete cache.draft.color_swatches; memory.set(cacheKey, JSON.stringify(cache));
    await render(React.createElement(editor.ColumnEditor, { target, expectedProjectSession:'project', onClose:()=>{} }));
    assert(host.textContent.includes(t('column.unsupportedDraft'))); assert.equal(host.querySelector('[data-column-swatches]'), null); await unmount();
    originalColumn.data_type = 'I32'; delete originalColumn.default_value;
  });

  await check('Same-name columns in distinct tables keep separate candidates and draft caches within one project', async () => {
    const a = { id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name:'Table A red', data_type:'Color32', value:'[255,0,0,128]' };
    const b = { id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name:'Table B blue', data_type:'Color32', value:'[0,0,255,64]' };
    const common = { ...originalColumn, data_name:'tint', display_name:'tint', data_type:'Color32', read_only: false, default_value:'[255,255,255,255]' };
    columnsByTarget.set('table-A', { ...common, color_swatches:[a] });
    columnsByTarget.set('table-B', { ...common, color_swatches:[b] });
    memory.clear(); ipc = []; currentPreview = preview();
    const open = async table => render(React.createElement(editor.ColumnEditor, {
      target:{ ...target, target_uuid:table }, expectedProjectSession:'project', onClose:()=>{},
    }));
    await open('table-A'); assert.equal(swatchName(0).value, a.name); await input(swatchName(0), 'A draft');
    await click(button(t('column.swatches.add'))); assert.equal(swatchRows().length, 2); await unmount();
    await open('table-B'); assert.equal(swatchRows().length, 1); assert.equal(swatchName(0).value, b.name);
    assert.deepEqual(JSON.parse(host.querySelector('[data-color-candidates]').dataset.colorCandidates), [b]);
    await input(swatchName(0), 'B draft'); await unmount();
    assert.equal(memory.size, 2);
    await open('table-A'); assert.equal(swatchName(0).value, 'A draft'); assert.equal(swatchRows().length, 2);
    await click(button(t('common.save'))); const savedA = saved().at(-1).args.request;
    assert.equal(savedA.target.target_uuid, 'table-A'); assert.equal(savedA.draft.color_swatches[0].id, a.id);
    assert.equal(savedA.draft.color_swatches[0].value, a.value); assert.equal(memory.size, 1); await unmount();
    await open('table-B'); assert.equal(swatchName(0).value, 'B draft'); assert.equal(swatchRows().length, 1);
    await click(button(t('common.save'))); const savedB = saved().at(-1).args.request;
    assert.equal(savedB.target.target_uuid, 'table-B'); assert.deepEqual(savedB.draft.color_swatches, [{ ...b, name:'B draft' }]);
    assert.equal(memory.size, 0); await unmount(); columnsByTarget.clear();
  });

  const headers = load('src/app/pages/main_window/project_view/table_view/components/DataGridAdvancedCells.tsx', {
    './RowResizeHandle': { RowResizeHandle: () => null },
  });
  await check('Interface header keeps provenance separate and exposes the actual identifier on hover', async () => {
    const column = { uuid:'score', data_name:'score_value', display_name:'得点 / Score', data_type:'I32', interface_origin:'stats' };
    await render(headers.createAdvancedHeaderCell({ column, columnIndex:0, tableUuid:'table', onInsertLeft:()=>{}, onInsertRight:()=>{}, isUpdating:false, interfaceMap:{stats:'Stats'}, filterButton:React.createElement('button',null,'filter') }));
    assert.equal(host.querySelector('.rdg-interface-origin-label').textContent, 'Stats');
    assert.equal(host.querySelector('.rdg-field-display-label').textContent, '得点 / Score');
    assert.equal(host.querySelector('.rdg-header-labels').title, column.display_name + ' (score_value)');
    assert.equal(host.querySelector('.rdg-header-labels').style.paddingInlineEnd, '', 'idle labels reserve no pencil/menu width');
    assert.equal(host.querySelector('.rdg-column-edit-control'), null);
    const headerCss = fs.readFileSync(path.join(root, 'src/app/pages/main_window/project_view/table_view/components/DataGridView.css'), 'utf8');
    assert.match(headerCss, /\.rdg-header-labels \{[^}]*align-self: stretch;[^}]*justify-content: center;/);
    assert.match(headerCss, /\.rdg-interface-origin-label \{[^}]*position: absolute;[^}]*font-size: 8px; line-height: 8px;/);
    assert.match(headerCss, /\.rdg-transpose-field-label \{[^}]*position: relative;[^}]*justify-content: center;/);
    assert.match(headerCss, /\.rdg-transpose-field-label \.rdg-interface-origin-label \{ inset-inline-start: 0; inset-inline-end: 0; \}/);
    assert.match(headerCss, /\.rdg-interface-origin-label \+ \.rdg-field-display-label \{ position: relative; top: 2px; \}/);

    assert.equal(headers.interfaceOriginLabel({...column,interface_origin_name_fallback:'Old Stats'},{}),t('grid.deletedInterface',{name:'Old Stats'}));
    await unmount();
  });
  const interfaceWrites = [];
  const interfaceApi = load('src/api/interface.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => { interfaceWrites.push({ command, args }); return 'ok'; } },
    '@/app/types/tableRules': { inputValidationReport: () => null },
    '@/app/utils/table_rule_dialogs': { confirmInputWarnings: async () => false },
  });
  await check('Interface version mutations encode camelCase API inputs to the exact Rust wire variant', async () => {
    for (const minVersion of [0, 4294967295]) {
      await interfaceApi.updateInterface('interface', [{ type: 'ChangeMinVersion', columnName: 'attack', minVersion }], 'project');
      const write = interfaceWrites.at(-1); assert.equal(write.command, 'update_interface');
      assert.equal(write.args.expectedProjectSession, 'project'); assert.equal(write.args.interfaceUuid, 'interface');
      assert.deepEqual(write.args.changes, [{ ChangeMinVersion: { column_name: 'attack', min_version: minVersion } }]);
    }
  });
  await check('Interface AddColumn preserves every explicit content version', async () => {
    for (const minVersion of [0, 8, 4294967295]) {
      await interfaceApi.updateInterface('interface', [{ type: 'AddColumn', column: { name: 'attack', dataType: 'I32', required: false, minVersion } }], 'project');
      assert.equal(interfaceWrites.at(-1).args.changes[0].AddColumn.column.min_version, minVersion);
      assert.equal(interfaceWrites.at(-1).args.changes[0].AddColumn.column.style.width, 0, 'new interface fields request automatic initial width');
    }
  });
  await check('Interface API encodes swatches in both AddColumn and ChangeColorSwatches', async () => {
    const swatches = [{ id:'11111111-1111-4111-8111-111111111111', name:'HDR', data_type:'ColorFloat', value:'[-2.0,4.0,0.5,0.0]' }];
    await interfaceApi.updateInterface('interface', [{ type:'AddColumn', column:{ name:'tint', dataType:'ColorFloat', minVersion:0, required:false, colorSwatches:swatches } }], 'project');
    assert.deepEqual(interfaceWrites.at(-1).args.changes[0].AddColumn.column.color_swatches, swatches);
    await interfaceApi.updateInterface('interface', [{ type:'ChangeColorSwatches', columnName:'tint', swatches }], 'project');
    assert.deepEqual(interfaceWrites.at(-1).args.changes, [{ ChangeColorSwatches:{column_name:'tint',swatches} }]);
  });
  await check('Interface description API preserves the revision and sends only metadata', async () => {
    await interfaceApi.updateInterface('interface', [{type:'ChangeDescription',newDescription:'Updated description'}], 'project', undefined, 'description', 'version-1');
    assert.equal(interfaceWrites.at(-1).args.expectedVersionId,'version-1');
    assert.deepEqual(interfaceWrites.at(-1).args.changes,[{ChangeDescription:{new_description:'Updated description'}}]);
  });
  let details={name:'Combatant',description:'Original contract',columns:[],current_version:{id:'version-1',timestamp:'',changes:[]},implementing_tables:[]};
  const descriptionWrites=[];let descriptionFailure=null, descriptionReadGate=null, descriptionWriteGate=null;
  let descriptionNavigation, descriptionWindowClose;
  const descriptionCache=new Map();
  const descriptionStore={read:key=>descriptionCache.get(key),write:(key,value)=>descriptionCache.set(key,value),remove:key=>descriptionCache.delete(key)};
  const Container=({children})=>React.createElement('div',null,children);
  const interfaceView=load('src/app/pages/main_window/project_view/table_view/components/InterfaceView.tsx',{
    '@/app/utils/columnDraftLifecycle':{columnDraftStore:descriptionStore},
    '@/app/services/tableInteractionScope':{registerTableNavigationBlocker:guard=>{descriptionNavigation=guard;return()=>{descriptionNavigation=null;};}},
    '@/app/utils/string_editor_window':{registerMainWindowCloseBlocker:guard=>{descriptionWindowClose=guard;return()=>{descriptionWindowClose=null;};}},
    '@tauri-apps/api/core':{invoke:async(command)=>{assert.equal(command,'get_interface_details');if(descriptionReadGate)await descriptionReadGate.promise;return structuredClone(details);}},
    '@tauri-apps/api/event':{listen:async()=>()=>{}},
    '@/components/ui/button':{Button},
    '@/components/ui/alert-dialog':{AlertDialog:()=>null,AlertDialogAction:Container,AlertDialogCancel:Container,AlertDialogContent:Container,AlertDialogDescription:Container,AlertDialogFooter:Container,AlertDialogHeader:Container,AlertDialogTitle:Container},
    '@/api/interface':{updateInterface:async(...args)=>{descriptionWrites.push(args);if(descriptionWriteGate)await descriptionWriteGate.promise;if(descriptionFailure)throw descriptionFailure;assert.equal(args[5],details.current_version.id);details={...details,description:args[1][0].newDescription,current_version:{...details.current_version,id:'version-2'}};return 'ok';}},
  });
  const view=(overrides={})=>React.createElement(interfaceView.InterfaceView,{expectedProjectSession:'project',interfaceUuid:'interface',fileName:'Combatant.interface.toml',filePath:'Combatant.interface.toml',...overrides});
  const openDescription=()=>click(host.querySelector(`button[aria-label="${t('interface.description')} ${t('common.edit')}"]`));
  const typeDescription=async(value)=>React.act(async()=>{const field=host.querySelector('textarea');Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(field,value);field.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await check('Interface description supports explicit edit, cancel, save and reload without field changes',async()=>{
    await render(view());await openDescription();assert.equal(host.querySelector('textarea').value,'Original contract');
    await typeDescription('Cancelled');await click(button(t('common.cancel')));assert.equal(descriptionWrites.length,0);assert(host.textContent.includes('Original contract'));
    await openDescription();await typeDescription('Saved contract');await click(button(t('common.save')));
    assert.equal(descriptionWrites.length,1);assert.deepEqual(descriptionWrites[0][1],[{type:'ChangeDescription',newDescription:'Saved contract'}]);
    assert.equal(descriptionWrites[0][2],'project');assert.equal(descriptionWrites[0][5],'version-1');assert.equal(host.querySelector('textarea'),null);
    await unmount();await render(view());assert(host.textContent.includes('Saved contract'));assert.equal(details.columns.length,0);await unmount();
  });
  await check('Interface description failures preserve drafts; empty descriptions remain editable',async()=>{
    await render(view());await openDescription();await typeDescription('Keep draft');descriptionFailure=Error('revision conflict');
    await click(button(t('common.save')));assert.equal(host.querySelector('textarea').value,'Keep draft');assert(host.querySelector('[role="alert"]').textContent.includes('revision conflict'));
    assert.equal(details.description,'Saved contract');descriptionFailure=null;await click(button(t('common.cancel')));
    await openDescription();await typeDescription('');await click(button(t('common.save')));assert.equal(details.description,'');assert(host.querySelector(`button[aria-label="${t('interface.description')} ${t('common.edit')}"]`));await unmount();
  });
  await check('Dirty interface descriptions block navigation and window close and survive remount',async()=>{
    await render(view());await openDescription();await typeDescription('Protected description');
    await React.act(async()=>assert.equal(await descriptionNavigation(),false));
    assert(host.textContent.includes(t('column.unsavedChanges')));
    await click(button(t('column.keepEditing')));
    await React.act(async()=>assert.equal(await descriptionWindowClose(),false));
    assert.equal(host.querySelector('textarea').value,'Protected description');
    assert.equal(descriptionCache.size,1);
    assert([...descriptionCache.keys()][0].startsWith('project:devcel:text-draft:'));
    await render(view({interfaceUuid:'other-interface'}));assert.equal(host.querySelector('textarea'),null);
    await render(view({expectedProjectSession:'other-project'}));assert.equal(host.querySelector('textarea'),null);
    await render(view());assert.equal(host.querySelector('textarea').value,'Protected description');
    await unmount();await render(view());assert.equal(host.querySelector('textarea').value,'Protected description');
    await React.act(async()=>assert.equal(await descriptionNavigation(),false));
    await click(button(t('column.discardAndClose')));assert.equal(descriptionCache.size,0);
    await React.act(async()=>assert.equal(await descriptionNavigation(),true));await unmount();
  });
  await check('Description conflicts compare the latest value and retry only against the explicitly reviewed revision',async()=>{
    details={...details,description:'Original for conflict',current_version:{...details.current_version,id:'before-conflict'}};
    await render(view());await openDescription();await typeDescription('My description');
    details={...details,description:'Other writer',current_version:{...details.current_version,id:'other-writer'}};
    descriptionFailure={kind:'code',code:'error.staleData',params:{}};
    await click(button(t('common.save')));descriptionFailure=null;
    assert.equal(descriptionWrites.at(-1)[5],'before-conflict');assert.equal(host.querySelector('textarea').value,'My description');
    const writes=descriptionWrites.length;
    await click(button(t('common.reload')));
    assert.equal(descriptionWrites.length,writes);assert.equal(host.querySelector('[data-description-latest]').textContent,'Other writer');
    assert.equal(host.querySelector('textarea').value,'My description');assert(button(t('common.save')).disabled);
    await click(button(t('common.retry')));assert.equal(descriptionWrites.at(-1)[5],'other-writer');assert.equal(details.description,'My description');
    assert.equal(descriptionCache.size,0);await unmount();
  });
  await check('Cancelling description conflict comparison does not write or keep a rebased draft',async()=>{
    await render(view());await openDescription();await typeDescription('Cancelled conflict');
    descriptionFailure={kind:'code',code:'error.staleData',params:{}};
    await click(button(t('common.save')));descriptionFailure=null;
    await click(button(t('common.reload')));const writes=descriptionWrites.length;
    await click(button(t('common.cancel')));
    assert.equal(descriptionWrites.length,writes);assert.equal(descriptionCache.size,0);assert.equal(host.querySelector('textarea'),null);
    await unmount();
  });
  await check('Shared description editor clears uncached identity state and releases the parent editing flag',async()=>{
    const flags=[];
    const shared=load('src/app/pages/main_window/project_view/table_view/components/DescriptionEditor.tsx',{
      '@/components/ui/button':{Button},'@/app/utils/columnDraftLifecycle':{columnDraftStore:descriptionStore},
      '@/app/services/tableInteractionScope':{registerTableNavigationBlocker:()=>()=>{}},
      '@/app/utils/string_editor_window':{registerMainWindowCloseBlocker:()=>()=>{}},
    });
    const changed=value=>flags.push(value);
    const sharedView=key=>React.createElement(shared.DescriptionEditor,{draftKey:key,value:'Saved',revision:'1',label:t('common.description'),onRead:async()=>({value:'Saved',revision:'1'}),onSave:async()=>{},onEditingChange:changed});
    await render(sharedView('shared-one'));await click(button(t('common.edit')));await typeDescription('Private draft');
    await render(sharedView('shared-two'));assert.equal(host.querySelector('textarea'),null);assert.equal(flags.at(-1),false);
    await render(sharedView('shared-one'));assert.equal(host.querySelector('textarea').value,'Private draft');
    await unmount();assert.equal(flags.at(-1),false);descriptionCache.clear();
  });
  for (const fails of [false,true]) await check(`Pending description save prevents confirmation dismissal (${fails?'failure':'success'})`,async()=>{
    await render(view());await openDescription();await typeDescription(fails?'Pending failed write':'Pending guarded write');
    await React.act(async()=>assert.equal(await descriptionNavigation(),false));
    const field=host.querySelector('textarea'),gate=deferred(),previous=details.description;
    descriptionWriteGate=gate;
    await click(button(t('common.save')));
    await click(button(t('column.discardAndClose')));
    assert(host.querySelector('textarea')===field,'discard must not remove an in-flight draft');
    assert.equal(descriptionCache.size,1);assert.equal(details.description,previous);
    assert(button(t('column.discardAndClose')).disabled);assert(button(t('column.keepEditing')).disabled);
    await click(button(t('column.keepEditing')));
    assert(button(t('column.discardAndClose')),'keep editing must not dismiss a busy confirmation');
    await React.act(async()=>assert.equal(await descriptionWindowClose(),false));
    descriptionFailure=fails?Error('save failed'):null;descriptionWriteGate=null;
    await React.act(async()=>{gate.resolve();await tick();});descriptionFailure=null;
    if(fails){
      assert.equal(host.querySelector('textarea'),field);assert.equal(descriptionCache.size,1);
      assert.equal(details.description,previous);assert(!button(t('column.discardAndClose')).disabled);
      await click(button(t('column.discardAndClose')));
    }else assert.equal(details.description,'Pending guarded write');
    assert.equal(host.querySelector('textarea'),null);assert.equal(descriptionCache.size,0);await unmount();
  });
  await check('A delayed post-save interface refresh keeps the editor mounted and removes the confirmed draft',async()=>{
    await render(view());await openDescription();await typeDescription('Saved before delayed refresh');
    const field=host.querySelector('textarea');const gate=deferred();descriptionReadGate=gate;
    await click(button(t('common.save')));
    assert.equal(details.description,'Saved before delayed refresh','the write has committed before reload finishes');
    assert.equal(host.querySelector('textarea'),field,'loading a new snapshot must not unmount the existing editor');
    assert(field.disabled);assert.equal(descriptionCache.size,1);
    await React.act(async()=>assert.equal(await descriptionNavigation(),false));
    descriptionReadGate=null;await React.act(async()=>{gate.resolve();await tick();});
    assert.equal(host.querySelector('textarea'),null);assert.equal(descriptionCache.size,0);
    await unmount();await render(view());assert.equal(host.querySelector('textarea'),null);assert(host.textContent.includes('Saved before delayed refresh'));await unmount();
  });
  await check('Delayed background interface refresh retains the conflict comparison and unsaved textarea',async()=>{
    await render(view());await openDescription();await typeDescription('Keep pending comparison');
    descriptionFailure={kind:'code',code:'error.staleData',params:{}};await click(button(t('common.save')));descriptionFailure=null;
    details={...details,description:'Other writer latest',current_version:{...details.current_version,id:'background-revision'}};
    await click(button(t('common.reload')));const field=host.querySelector('textarea'),comparison=host.querySelector('[data-description-latest]');
    const gate=deferred();descriptionReadGate=gate;
    await click(host.querySelector(`button[aria-label="${t('interface.refresh')}"]`));
    assert.equal(host.querySelector('textarea'),field);assert.equal(host.querySelector('[data-description-latest]'),comparison);
    descriptionReadGate=null;await React.act(async()=>{gate.resolve();await tick();});
    assert.equal(host.querySelector('textarea'),field);assert.equal(field.value,'Keep pending comparison');
    assert.equal(host.querySelector('[data-description-latest]'),comparison);assert.equal(comparison.textContent,'Other writer latest');
    await click(button(t('common.cancel')));assert.equal(descriptionCache.size,0);await unmount();
  });
  const report = { passed: reports.length, checks: reports, scope: 'Production React components, Radix dialogs and owner-bound intent sessions with mocked IPC; native layout, Rust authorization and session validation require native checks' };
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

