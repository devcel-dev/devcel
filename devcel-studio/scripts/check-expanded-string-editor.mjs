// Real React editor pane and raw-newline model; only native window/IPC are fixtures.
// Geometry is synthetic. Native WebKit rendering/IME must be reported separately.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(project, '.string-editor-check-'));
const window = new Window({ url: 'http://editor.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLDivElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'InputEvent', 'CompositionEvent', 'FocusEvent', 'MutationObserver', 'CSS', 'localStorage', 'sessionStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
let nativeCloseHandler, nativeCloseCount = 0;
globalThis.__stringEditorNative = {
  onCloseRequested: async callback => { nativeCloseHandler = callback; return () => { nativeCloseHandler = undefined; }; },
  close: async () => { nativeCloseCount++; }
};
const boundaries = {
  '@tauri-apps/api/core': `export const invoke=async(name)=>name==='get_formula_completion_schema'?{functions:['SUM'],table:{uuid:'t',data_name:'Items',columns:[]}}:undefined; export const isTauri=()=>false;`,
  '@/app/commands/tableCommands': `export const getTableCatalog=async()=>[{uuid:'t',data_name:'Items'}];`,
  '@tauri-apps/api/event': `export const listen=async()=>()=>{}; export const emit=async()=>{};`,
  '@tauri-apps/api/webviewWindow': `export const getCurrentWebviewWindow=()=>globalThis.__stringEditorNative;`
};
let root, React;
try {
  const bundled = await build({ absWorkingDir: project, stdin: { contents: `export {ExpandedStringEditor} from './src/app/pages/main_window/project_view/table_view/components/ExpandedStringEditor'; export {columnDraftStore} from './src/app/utils/columnDraftLifecycle'; export {t} from './src/app/i18n';`, resolveDir: project, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false, alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'native-boundaries', setup(builder) { builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(boundaries, args.path) ? { path: args.path, namespace: 'native' } : undefined); builder.onLoad({ filter: /.*/, namespace: 'native' }, args => ({ contents: boundaries[args.path], loader: 'js' })); builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' })); } }]
  });
  const modulePath = resolve(temporary, 'editor.mjs'); await writeFile(modulePath, bundled.outputFiles[0].text);
  const { ExpandedStringEditor, t, columnDraftStore } = await import(pathToFileURL(modulePath));
  React = await import('react'); const { createRoot } = await import('react-dom/client'); const act = React.act;
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const opener = document.createElement('button'); document.body.append(opener);
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  let props, instance = 0, closed, commits, success = true, pending;
  const render = async () => { await act(async () => root.render(closed ? null : React.createElement(ExpandedStringEditor, { ...props, key: instance }))); await settle(); };
  const mount = async (value = 'first\r\nsecond\rthird\nlast') => {
    await act(async () => root.render(null)); await settle(); opener.focus();
    nativeCloseCount = 0; closed = false; commits = []; success = true; pending = null; ++instance;
    props = { target: { recordUuid: 'r', columnUuid: 'c', label: 'Row / Text', value, revision: '1' }, tableUuid: 't', projectSessionId: `session-${instance}`, currentRevision: '1', busy: false, error: null,
      onClose: () => { closed = true; void globalThis.__stringEditorNative.close(); }, onCommit: async (value, revision) => { commits.push({ value, revision }); if (pending) await pending; return success; } };
    await render();
    assert.equal(document.querySelectorAll('textarea').length, 1); assert.equal(document.activeElement, input());
  };
  const input = () => document.querySelector('textarea');
  const click = async label => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label); assert(button, label); await act(async () => button.click()); await render(); };
  const key = async (key, options = {}) => { const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }); await act(async () => input().dispatchEvent(event)); await render(); return event; };
  const edit = async (value, start = 0, end = input().value.length, inputType = 'insertText') => {
    await act(async () => { const element = input(); element.setSelectionRange(start, end); element.dispatchEvent(new window.InputEvent('beforeinput', { inputType, bubbles: true })); Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new window.InputEvent('input', { inputType, bubbles: true })); }); await render();
  };
  const check = async (name, run) => { await run(); console.log('PASS', name); };
  await check('Completion Escape and pointer selection stay inside the real expanded dialog', async () => {
    await mount('=SU');
    await act(async () => { input().setSelectionRange(3, 3); input().dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle();
    assert(document.querySelector('[role="dialog"] [role="listbox"]'), 'popup belongs to the modal focus scope');
    await key('Escape'); assert(!closed); assert(!document.querySelector('[role="listbox"]')); assert(!document.querySelector('[role="alertdialog"]'));
    await act(async () => input().dispatchEvent(new MouseEvent('click', { bubbles: true }))); await settle();
    const option = document.querySelector('[role="option"]'); assert(option);
    await act(async () => { option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); option.click(); }); await settle();
    assert.equal(input().value, '=SUM()'); assert.equal(commits.length, 0); assert(!closed);
    await key('Enter', { ctrlKey: true }); assert(closed); assert.equal(commits[0].value, '=SUM()');
  });
  await check('Unchanged CRLF/CR/LF opens and closes with no write', async () => { await mount(); assert.equal(input().value, 'first\nsecond\nthird\nlast'); await key('Escape'); assert(closed); assert.deepEqual(commits, []); assert.equal(columnDraftStore.keys(props.projectSessionId).length, 0); });
  await check('Editing preserves untouched raw endings and commits once', async () => { await mount(); await edit('Xfirst\nsecond\nthird\nlast', 0, 0); assert.equal(columnDraftStore.keys(props.projectSessionId).length, 1); await key('Enter', { ctrlKey: true }); assert(closed); assert.deepEqual(commits, [{ value: 'Xfirst\r\nsecond\rthird\nlast', revision: '1' }]); assert.equal(columnDraftStore.keys(props.projectSessionId).length, 0); });
  await check('Ordinary Enter stays in editor; composition Enter and 229 cannot commit', async () => { await mount('a'); await edit('changed'); const enter = await key('Enter'); assert(!enter.defaultPrevented); await key('Enter', { ctrlKey: true, isComposing: true }); await key('Enter', { ctrlKey: true, keyCode: 229 }); assert(!closed); assert.equal(commits.length, 0); });
  await check('Escape dirty offers Save/Discard/Cancel; cancel preserves draft', async () => { await mount('a'); await edit('changed'); await key('Escape'); assert(document.querySelector('[role="alertdialog"]')); await click(t('common.cancel')); assert(!document.querySelector('[role="alertdialog"]')); assert.equal(input().value, 'changed'); await key('Escape'); await click(t('common.save')); assert(closed); assert.equal(commits[0].value, 'changed'); });
  await check('Close dirty discard removes recovery and does not write', async () => { await mount('a'); await edit('changed'); await click(t('common.close')); await click(t('column.discardAndClose')); assert(closed); assert.equal(commits.length, 0); assert.equal(columnDraftStore.keys(props.projectSessionId).length, 0); });
  await check('Wrap toggle keeps the same four-row textarea, selection and unlimited draft', async () => { await mount('a'); await edit('long\ntext'); const element = input(); element.setSelectionRange(2, 5); await click(t('grid.stringWrap')); assert.equal(input(), element); assert.equal(input().value, 'long\ntext'); assert.equal(input().selectionStart, 2); assert.equal(input().getAttribute('wrap'), 'off'); assert.equal(Number(input().rows), 4); assert.equal(input().maxLength, -1); });
  await check('External revision change retains draft and prevents stale save', async () => { await mount('a'); await edit('changed'); props.currentRevision = '2'; await render(); await key('Enter', { metaKey: true }); assert.equal(commits.length, 0); assert.equal(input().value, 'changed'); assert(document.querySelector('[role="alert"]').textContent.includes(t('grid.stringEditorStale'))); });
  await check('Rejected commit keeps text and recovery available', async () => { await mount('a'); await edit('changed'); success = false; await key('Enter', { ctrlKey: true }); assert(!closed); assert.equal(input().value, 'changed'); assert.equal(columnDraftStore.keys(props.projectSessionId).length, 1); });
  await check('Repeated in-app open/close mounts only one textarea and no native close listener', async () => { for (let i = 0; i < 5; i++) { await mount(`line${i}`); await key('Escape'); assert.equal(document.querySelectorAll('textarea').length, 0); } });
  await check('App close request dirty requires a decision; cancel preserves the draft', async () => { await mount('a'); await edit('changed'); props.closeRequest = 1; await render(); assert(document.querySelector('[role="alertdialog"]')); await click(t('common.cancel')); assert(!closed); assert.equal(nativeCloseCount, 0); props.closeRequest = 2; await render(); await click(t('column.discardAndClose')); assert(closed); assert.equal(nativeCloseCount, 1); });
  await check('Recovery remains tied to original revision after remount', async () => { await mount('a'); await edit('recovered'); await act(async () => root.render(null)); await settle(); ++instance; props.target = { ...props.target, value: 'external', revision: '2' }; props.currentRevision = '2'; await render(); assert.equal(input().value, 'recovered'); await key('Enter', { ctrlKey: true }); assert.equal(commits.length, 0); await click(t('common.close')); await click(t('column.discardAndClose')); });
  await check('Reverting the text clears dirty status and closes without a mutation', async () => { await mount('original'); await edit('changed'); await edit('original'); assert.equal(columnDraftStore.keys(props.projectSessionId).length, 0); await key('Escape'); assert(closed); assert.equal(commits.length, 0); });
  await check('Parent close request Cancel resolves without losing child draft', async () => { await mount('original'); await edit('changed'); let cancelled = 0; props.onCloseCancelled = () => cancelled++; props.closeRequest = 1; await render(); assert(document.querySelector('[role="alertdialog"]')); await click(t('common.cancel')); assert.equal(cancelled, 1); assert.equal(input().value, 'changed'); props.closeRequest = 2; await render(); await edit('more'); assert.equal(cancelled, 2); assert(!document.querySelector('[role="alertdialog"]')); });
  await check('Saved text is locked if native close fails; retry never repeats mutation', async () => { await mount('original'); props.onClose = () => { nativeCloseCount++; }; await render(); await edit('changed'); await key('Enter', { ctrlKey: true }); assert(!closed); assert(input().readOnly); assert.equal(commits.length, 1); await key('Enter', { ctrlKey: true }); assert.equal(commits.length, 1); assert.equal(nativeCloseCount, 2); });
  await check('Concurrent save/close/discard cannot discard or submit twice', async () => { await mount('original'); await edit('changed'); let release; pending = new Promise(resolve => { release = resolve; }); await key('Enter', { ctrlKey: true }); assert(input().readOnly, 'lock continues while native save/notification promise is pending'); assert.equal(nativeCloseHandler, undefined); await key('Enter', { ctrlKey: true }); assert.equal(commits.length, 1); props.closeRequest = 1; await render(); await click(t('column.discardAndClose')); assert(!closed); await act(async () => release()); await render(); assert(closed); assert.equal(commits.length, 1); });
  await check('Hundreds of lines and long values remain editable without truncation', async () => {
    const text = Array.from({ length: 250 }, (_, index) => `${index}: ${'x'.repeat(400)}`).join('\n');
    await mount(text); assert.equal(input().value, text); assert.equal(Number(input().rows), 4); await edit('!' + text, 0, 0); await key('Enter', { ctrlKey: true }); assert.equal(commits[0].value, '!' + text);
    const css = await readFile(resolve(project, 'src/app/pages/main_window/project_view/table_view/components/ExpandedStringEditor.css'), 'utf8');
    assert(css.includes('height: calc(6.4em + 2px)')); assert(css.includes('box-sizing: border-box')); assert(css.includes('padding: 0 10px')); assert(css.includes('font: 14px/1.6')); assert(css.includes('overflow: auto'));
  });
  console.log('Expanded String editor integration passed');
} finally {
  if (root) await React.act(async () => root.unmount());
  await window.happyDOM.close(); await rm(temporary, { recursive: true, force: true });
}
