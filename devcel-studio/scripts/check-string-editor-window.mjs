// Real React/Radix host, immutable draft coordinator, shared close guard and mutation hook.
// Only native commands/events are fixtures. Native WebKit geometry/IME are separate QA.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(project, '.string-host-check-'));
const browser = new Window({ url: 'http://editor.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLDivElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'InputEvent', 'CompositionEvent', 'FocusEvent', 'MutationObserver', 'CSS', 'localStorage', 'sessionStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? browser : browser[name] });
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = browser[name].bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const listeners = new Set(), closeHandlers = new Set(), commands = [];
let destroyed = 0, flushes = 0, guardFailure = false, guardPending, mutatePending, mutationFailure = false, mutationWarning = false, warningApproved = true, flushAction;
const native = {
  label: 'main',
  onCloseRequested: async callback => { if (guardFailure) throw Error('close registration failed'); if (guardPending) await guardPending; closeHandlers.add(callback); return () => closeHandlers.delete(callback); },
  destroy: async () => { destroyed++; },
};
async function nativeClose() {
  for (const callback of [...closeHandlers]) {
    let prevented = false;
    await callback({ preventDefault() { prevented = true; } });
    if (!prevented) destroyed++;
  }
}
globalThis.__stringHost = {
  native,
  listen: async (event, callback) => { const item = { event, callback }; listeners.add(item); return () => listeners.delete(item); },
  invoke: async (command, args) => {
    commands.push({ command, args });
    assert.equal(command, 'apply_table_mutation');
    if (mutatePending) await mutatePending;
    if (mutationFailure) throw { kind: 'text', text: 'stale revision or session' };
    if (mutationWarning && !args.request.acknowledgement) throw { kind: 'input_validation', report: { acknowledgement: 'warning-token', issues: [{ mode: 'warn', column_name: 'Text', diagnostic: { kind: 'text', text: 'review warning' } }] } };
    return { table: { metadata: { initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, uuid: args.request.table_uuid } }, presentation: { revision: 'next' } };
  },
  warning: async () => warningApproved,
};
const boundaries = {
  '@tauri-apps/api/core': `export const invoke=(...args)=>globalThis.__stringHost.invoke(...args); export const isTauri=()=>false;`,
  '@tauri-apps/api/event': `export const listen=(...args)=>globalThis.__stringHost.listen(...args); export const emit=async()=>{};`,
  '@tauri-apps/api/webviewWindow': `export const getCurrentWebviewWindow=()=>globalThis.__stringHost.native;`,
  '@tauri-apps/plugin-dialog': `export const message=async()=>{}; export const ask=async()=>true;`,
  '@/app/services/appDialogs': `export const message=async()=>{}; export const ask=async()=>true;export const appAlert=message;export const appConfirm=ask;export const appPrompt=async(...args)=>globalThis.prompt?.(...args)??null;`,
  '@/app/utils/table_rule_dialogs': `export const confirmInputWarnings=(...args)=>globalThis.__stringHost.warning(...args);`,
};
let root, guard;
try {
  const bundled = await build({ absWorkingDir: project, stdin: { contents: `export * from './src/app/utils/string_editor_window'; export {StringEditorHost} from './src/app/pages/string_editor/StringEditorHost'; export {columnDraftStore} from './src/app/utils/columnDraftLifecycle'; export {t} from './src/app/i18n'; export * from './src/app/services/tableInteractionScope'; export {useTableMutation} from './src/app/pages/main_window/project_view/table_view/components/useTableMutation';`, resolveDir: project, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false, alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'native-boundaries', setup(builder) { builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'native' } : undefined); builder.onLoad({ filter: /.*/, namespace: 'native' }, args => ({ contents: boundaries[args.path], loader: 'js', resolveDir: project })); builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' })); } }]
  });
  const modulePath = resolve(temporary, 'host.mjs'); await writeFile(modulePath, bundled.outputFiles[0].text);
  const api = await import(pathToFileURL(modulePath));
  const React = await import('react'); const { createRoot } = await import('react-dom/client'); const { act } = React;
  const { StringEditorHost, showStringEditor, requestCloseStringEditor, getStringEditorSnapshot, installMainWindowCloseGuard, registerMainWindowCloseBlocker, columnDraftStore, t, setTableInteractionTarget } = api;
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const opener = document.createElement('button'); document.body.append(opener);
  let session = 'project', sequence = 0, errors = [], ordinaryMutation;
  function Ordinary() { ordinaryMutation = api.useTableMutation('table', 'project', () => {}); return null; }
  const render = async () => { await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(StringEditorHost, { projectSessionId: session }), React.createElement(Ordinary)))); await settle(); };
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  const input = () => document.querySelector('textarea');
  const click = async label => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label); assert(button, label); await act(async () => button.click()); await settle(); };
  const key = async (key, options = {}) => { await act(async () => input().dispatchEvent(new browser.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))); await settle(); };
  const edit = async (value = 'changed', start = 0, end = input().value.length) => {
    await act(async () => { const element = input(); element.setSelectionRange(start, end); element.dispatchEvent(new browser.InputEvent('beforeinput', { inputType: 'insertText', bubbles: true })); Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new browser.InputEvent('input', { inputType: 'insertText', bubbles: true })); }); await settle();
  };
  const request = () => ({ tableUuid: 'table', projectSessionId: 'project', target: { recordUuid: `row-${++sequence}`, columnUuid: 'text', label: 'Text', value: 'first\r\nsecond\rthird\nlast', revision: 'revision' } });
  const start = async (next = request()) => { session = 'project'; setTableInteractionTarget('project', 'table'); await render(); opener.focus(); let opening; await act(async () => { opening = showStringEditor(next); }); await settle(); await opening; assert(input()); return next; };
  const close = async () => { if (!input()) return; await key('Escape'); if (input()) await click(t('column.discardAndClose')); assert.equal(getStringEditorSnapshot(), null); };
  const check = async (name, run) => { await run(); console.log('PASS', name); };
  const install = () => installMainWindowCloseGuard(async () => { flushes++; await flushAction?.(); }, error => errors.push(error));
  await render(); guard = install(); await settle();
  await check('One in-app textarea and exactly one native main close listener', async () => { await start(); assert.equal(document.querySelectorAll('textarea').length, 1); assert.equal(closeHandlers.size, 1); assert.equal(window.location.pathname, '/'); await close(); assert.equal(document.activeElement, opener); });
  await check('Repeated open keeps the same immutable cell snapshot and draft', async () => { const original = await start(); await edit(); const fixed = getStringEditorSnapshot().request; original.target.recordUuid = 'different'; await act(async () => { await showStringEditor(request()); }); assert.equal(input().value, 'changed'); assert.equal(fixed.target.recordUuid, `row-${sequence - 1}`); assert(Object.isFrozen(fixed) && Object.isFrozen(fixed.target)); await close(); });
  await check('Ctrl+Enter preserves raw line endings and exact UUID/session/revision', async () => { const original = await start(); await edit('Xfirst\nsecond\nthird\nlast', 0, 0); const before = commands.length; await key('Enter', { ctrlKey: true }); const write = commands[before]; assert.equal(write.args.expectedProjectSession, 'project'); assert.equal(write.args.request.table_uuid, 'table'); assert.equal(write.args.request.expected_revision, 'revision'); assert.deepEqual(write.args.request.cells, [{ record_uuid: original.target.recordUuid, column_uuid: 'text', value: 'Xfirst\r\nsecond\rthird\nlast' }]); assert(!input()); });
  await check('Dirty navigation Cancel resolves false and preserves recovery text', async () => { await start(); await edit(); let closing; await act(async () => { closing = requestCloseStringEditor(); }); await settle(); await click(t('common.cancel')); assert.equal(await closing, false); assert.equal(input().value, 'changed'); assert.equal(columnDraftStore.keys('project').length, 1); await close(); });
  await check('Dirty navigation Discard resolves true without a write', async () => { await start(); await edit(); const before = commands.length; let closing; await act(async () => { closing = requestCloseStringEditor(); }); await settle(); await click(t('column.discardAndClose')); assert.equal(await closing, true); assert.equal(commands.length, before); assert.equal(columnDraftStore.keys('project').length, 0); });
  await check('Dirty navigation Save remains authorized after ordinary grid scope revocation', async () => { await start(); await edit(); let closing; await act(async () => { setTableInteractionTarget('project', null, true); closing = requestCloseStringEditor(); }); await settle(); const before = commands.length; await click(t('common.save')); assert.equal(await closing, true); assert.equal(commands.length, before + 1); });
  await check('Ordinary grid mutation remains blocked by the same revoked scope', async () => { setTableInteractionTarget('project', null, true); const before = commands.length; let saved; await act(async () => { saved = await ordinaryMutation.run(async () => ({ table_uuid: 'table' })); }); assert.equal(saved, false); assert.equal(commands.length, before); });
  await check('Changed project fails closed and keeps recovery data for explicit discard', async () => { await start(); await edit(); session = 'new-project'; await render(); const before = commands.length; await key('Enter', { ctrlKey: true }); assert.equal(commands.length, before); assert(input().value === 'changed'); assert(document.querySelector('[role=alert]').textContent.includes(t('grid.stringEditorStale'))); await close(); });
  await check('Late finish from an older request cannot close a new editor', async () => { await start(); const old = getStringEditorSnapshot().request; await close(); await start(); await act(async () => api.finishStringEditor(old)); assert(input()); assert.equal(api.isStringEditorSessionActive(old), false); await close(); });
  await check('External table invalidation prevents stale saves without losing text', async () => { await start(); await edit(); await act(async () => window.dispatchEvent(new CustomEvent('table-data-changed', { detail: { projectSession: 'project', tableUuid: 'table' } }))); const before = commands.length; await key('Enter', { ctrlKey: true }); assert.equal(commands.length, before); assert.equal(input().value, 'changed'); await close(); });
  await check('Failed backend writes keep text and close decision available', async () => { await start(); await edit(); mutationFailure = true; await key('Enter', { ctrlKey: true }); assert(input()); assert(document.querySelector('[role=alert]')); mutationFailure = false; await key('Enter', { ctrlKey: true }); assert(!input()); });
  await check('Validation warnings attach only the exact acknowledgement and write once after approval', async () => { await start(); await edit(); mutationWarning = true; const before = commands.length; await key('Enter', { ctrlKey: true }); assert.equal(commands.length, before + 2); assert.equal(commands.at(-1).args.request.acknowledgement, 'warning-token'); assert(!input()); mutationWarning = false; });
  await check('Declined warning preserves the draft', async () => { await start(); await edit(); mutationWarning = true; warningApproved = false; await key('Enter', { ctrlKey: true }); assert(input()); mutationWarning = false; warningApproved = true; await close(); });
  await check('Save/close races lock input and cannot submit or discard twice', async () => { await start(); await edit(); let release; mutatePending = new Promise(resolve => { release = resolve; }); const before = commands.length; await key('Enter', { ctrlKey: true }); assert(input().readOnly); await key('Enter', { ctrlKey: true }); let closing; await act(async () => { closing = requestCloseStringEditor(); }); await settle(); await click(t('column.discardAndClose')); assert(input()); await act(async () => release()); mutatePending = null; await settle(); assert.equal(await closing, true); assert.equal(commands.length, before + 1); });
  await check('Project revocation during a rejected save unlocks the stale draft for discard', async () => {
    await start(); await edit(); let release; mutatePending = new Promise(resolve => { release = resolve; }); mutationFailure = true;
    await key('Enter', { ctrlKey: true }); assert(input().readOnly); session = 'new-project'; await render();
    await act(async () => setTableInteractionTarget('project', null)); await act(async () => release()); mutatePending = null; mutationFailure = false; await settle();
    assert(input() && !input().readOnly); assert.equal(input().value, 'changed'); await close();
  });
  await check('Main native close Cancel keeps app open; Save flushes before destroy', async () => { await start(); await edit(); const before = destroyed; await act(async () => nativeClose()); await settle(); await click(t('common.cancel')); assert.equal(destroyed, before); assert(input()); await act(async () => nativeClose()); await settle(); await click(t('common.save')); await settle(); assert.equal(destroyed, before + 1); assert(flushes > 0); });
  await check('Main blockers are checked before the draft and again after Markdown flush', async () => { await start(); await edit(); let allow = false; const release = registerMainWindowCloseBlocker(() => allow); const before = destroyed; await act(async () => nativeClose()); await settle(); assert(!document.querySelector('[role=alertdialog]')); allow = true; await close(); let finish; flushAction = () => new Promise(resolve => { finish = resolve; }); await act(async () => nativeClose()); await settle(); allow = false; await act(async () => finish()); await settle(); assert.equal(destroyed, before); flushAction = undefined; release(); });
  await check('Guard pending/failure refuses editor creation and reinstall recovers', async () => { guard(); await settle(); let ready; guardPending = new Promise(resolve => { ready = resolve; }); guard = install(); await assert.rejects(showStringEditor(request())); ready(); guardPending = undefined; await settle(); await start(); await close(); guard(); await settle(); guardFailure = true; guard = install(); await settle(); await assert.rejects(showStringEditor(request())); assert.match(String(errors.at(-1)), /close registration failed/); guard(); guardFailure = false; guard = install(); await settle(); await start(); await close(); });
  await check('Removed editor routes and utilities cannot create independent windows', async () => { const routes = await readFile(resolve(project, 'src/app/routes/routes.tsx'), 'utf8'); for (const route of ['/string_editor', '/column_type_dialog']) assert(!routes.includes(`path: '${route}'`)); const util = await readFile(resolve(project, 'src/app/utils/string_editor_window.ts'), 'utf8'); assert(!util.includes('new WebviewWindow')); const pane = await readFile(resolve(project, 'src/app/pages/main_window/project_view/table_view/components/ExpandedStringEditor.tsx'), 'utf8'); assert(!pane.includes('.onCloseRequested')); });
  guard(); guard = undefined; await act(async () => root.unmount()); root = undefined; await settle(); assert.equal(closeHandlers.size, 0); assert.equal(listeners.size, 0);
  console.log('In-app String editor coordinator integration passed. Native WebKit/IME remains separate QA.');
} finally {
  guard?.(); if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
  await browser.happyDOM.close(); await rm(temporary, { recursive: true, force: true });
}
