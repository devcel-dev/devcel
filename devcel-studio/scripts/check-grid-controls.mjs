// Actual DataGridView, DataGrid, localization, useTableMutation and useTablePresentation.
// Only native IPC/events and browser clipboard are boundary fixtures. DOM geometry
// and Linaria's build-time CSS extraction are synthetic; this is not native WebKit QA.
import assert from 'node:assert/strict';
import { format } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.grid-controls-'));
// Point at a repository snapshot to run identical assertions against the old UI.
const before = process.env.SETTINGS_ACTIVATION_BEFORE;
const reports = [], calls = [], writes = [], expandedRequests = [];
const metrics = {};
let nextEvaluationId = 0;
const evaluations = new Map();
const formula = '=LOOKUP("materials","key","marsh_hide_t01","value")*2+rarity';
const encodedFormula = '"' + formula.replaceAll('"', '""') + '"';
const window = new Window({ url: 'http://cut-input.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'HTMLButtonElement', 'HTMLFormElement', 'SVGElement', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver', 'CSS', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const resizeObservers = new Set();
globalThis.ResizeObserver = window.ResizeObserver = class {
  constructor(callback) { this.callback=callback; this.targets=new Set(); resizeObservers.add(this); }
  observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); resizeObservers.delete(this); }
};
Object.defineProperties(window.HTMLElement.prototype, {
  offsetWidth: { configurable: true, get() { return 1800; } },
  clientWidth: { configurable: true, get() { return 1800; } },
  offsetHeight: { configurable: true, get() { return this.classList.contains('rdg') ? Number.parseFloat(this.style.height) || 400 : 400; } },
  clientHeight: { configurable: true, get() { return this.offsetHeight; } }
});
window.HTMLElement.prototype.getBoundingClientRect = function() { return new window.DOMRect(0, 0, this.offsetWidth, this.offsetHeight); };
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};

const clone = value => JSON.parse(JSON.stringify(value));
const column = (name, options = {}) => ({ min_version: 0, uuid: `column-${name}`, data_name: name, display_name: name, data_type: 'String', read_only: false, default_value: '', tags: [], tooltip: '', memo_text: '', style: { width: 220, color: '#ffffff', font_size: 12 }, ...options });
const makeTable = () => ({
  uuid: 'equipment', display_name: 'equipment' , metadata: { interface_order: [],  initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, data_name: 'equipment' }, description: '',
  schema: { columns: [column('name'), column('rarity', { data_type: 'I32' }), column('power', { data_type: 'I32' }), column('interface_power', { data_type: 'I32', interface_origin: 'stats' }), column('default_power', { data_type: 'I32', read_only: false, default_value: '=rarity*3' }), column('note')] },
  records: ['hidden', 'source', 'target', 'last'].map((name, index) => ({ uuid: `record-${name}`, label: name, values: { name, rarity: String([1, 5, 9, 12][index]), power: name === 'source' ? formula : '', default_power: '', note: `${name} note` }, interface_values: { 'column-interface_power': name === 'source' ? formula : '' }, min_version: 1, tags: [], parent_uuid: '', memo_texts: {} })),
  interface_implementations: {}, });
let emitMutationInvalidation = false, snapshotGate = null, snapshotFailure = null;
let settingsGate = null, settingsFailure = null;
let mutationGate = null, mutationFailure = null, warningResult = false, warningRequests = 0;
let omittedCells = new Set();
let rangeBars = new Map();
let table, revision, session = 'session-A', history, redoHistory, omittedRaw, clipboard = 'original clipboard', clipboardFailure = false, clipboardDelay = null;
const raw = (record, col) => col.interface_origin ? record.interface_values[col.uuid] ?? '' : record.values[col.data_name] ?? '';
// Rust owns evaluation. These fixture presentations make raw/display disagreement
// explicit and re-evaluate two known formulas after every committed row change.
const display = (record, col) => {
  const input = raw(record, col) || col.default_value;
  if (input === formula) return String(35 * 2 + Number(record.values.rarity));
  if (input === '=rarity*3') return String(Number(record.values.rarity) * 3);
  return input;
};
// Model the core's sparse wire on every authoritative snapshot and mutation.
const sparseTable = () => {
  const wire=clone(table);
  const omit=(value,keys)=>{for(const key of keys){const v=value[key];if(v === '' || v === 0 || (Array.isArray(v)&&v.length===0) || (v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===0))delete value[key];}};
  omit(wire.metadata,['parent_uuid']);
  for(const col of wire.schema.columns)omit(col,['min_version','display_name','tooltip','memo_text','tags']);
  for(const row of wire.records)omit(row,['min_version','parent_uuid','label','tags','interface_values','memo_texts']);
  return wire;
};
const snapshot = () => ({ table: sparseTable(), presentation: {
  table_uuid: table.uuid, revision: String(revision), definition_issues: [], issue_count: 0,
  cells: Object.fromEntries(table.records.map(record => [record.uuid, Object.fromEntries(table.schema.columns.map(col => [col.uuid, {
    ...(!omittedRaw.has(`${record.uuid}:${col.uuid}`) ? { raw_value: raw(record, col) } : {}),
    display_value: display(record, col), style: {}, issues: [], formula_error: null, hint: '', range_bar: rangeBars.get(`${record.uuid}:${col.uuid}`)
  }]).filter(([uuid]) => !omittedCells.has(`${record.uuid}:${uuid}`)))]))
} });
const mutationCalls = () => calls.filter(call => call.command === 'apply_table_mutation');
const invoke = async (command, args = {}) => {
  calls.push({ command, args: clone(args), at: performance.now(), utc: new Date().toISOString() });
  if (args.expectedProjectSession !== undefined) assert.equal(args.expectedProjectSession, session, `session-bound IPC: ${command}`);
  switch (command) {
    case 'get_interfaces': return JSON.stringify([{ uuid: 'stats', name: 'Stats' }]);
    case 'prepare_table_rule_snapshot': {
      const id = `input-check-${++nextEvaluationId}`;
      evaluations.set(id, { tableUuid: args.tableUuid, session: args.expectedProjectSession });
      return id;
    }
    case 'cancel_table_rule_snapshot': return evaluations.delete(args.evaluationId);
    case 'get_table_rule_snapshot': {
      if (snapshotGate) await snapshotGate.promise;
      if (snapshotFailure) throw snapshotFailure;
      assert.deepEqual(evaluations.get(args.evaluationId), { tableUuid: args.tableUuid, session: args.expectedProjectSession }, 'snapshot uses its registered table/session request');
      evaluations.delete(args.evaluationId);
      return args.knownSnapshotToken === `${session}:${revision}`
        ? { kind: 'unchanged', snapshot_token: args.knownSnapshotToken, retained_bytes: 1024 }
        : { kind: 'snapshot', snapshot_token: `${session}:${revision}`, retained_bytes: 1024, ...snapshot() };
    }
    case 'apply_table_mutation': {
      const request = args.request;
      const origin = session;
      if (mutationGate) await mutationGate.promise;
      if (origin !== session || request.table_uuid !== table.uuid) throw Error('fixture target replaced');
      if (mutationFailure) throw mutationFailure;
      assert.equal(request.table_uuid, table.uuid);
      if (request.expected_revision !== String(revision)) throw Error('fixture revision changed; stale mutation rejected');
      assert.deepEqual(request.create_records, []); assert.deepEqual(request.delete_record_uuids, []);
      const previous = clone(table);
      for (const patch of request.cells) {
        const record = table.records.find(row => row.uuid === patch.record_uuid);
        const col = table.schema.columns.find(column => column.uuid === patch.column_uuid);
        assert(record && col, 'UUID mutation target exists');
        const values = col.interface_origin ? record.interface_values : record.values;
        const key = col.interface_origin ? col.uuid : col.data_name;
        if (patch.value === '') delete values[key];
        else values[key] = patch.value;
      }
      for (const patch of request.versions) table.records.find(row => row.uuid === patch.record_uuid).min_version = Number(patch.min_version);
      for (const patch of request.column_versions) table.schema.columns.find(col => col.uuid === patch.column_uuid).min_version = Number(patch.min_version);
      if (JSON.stringify(previous) !== JSON.stringify(table)) { history.push(previous); redoHistory = []; revision++; }
      if (emitMutationInvalidation) window.dispatchEvent(new window.CustomEvent('table-data-changed', {detail:{projectSession:session, tableUuid:table.uuid}}));
      return snapshot();
    }
    case 'get_table_history_status': return {canUndo:history.length>0,canRedo:redoHistory.length>0};
    case 'undo_command': assert(history.length, 'real prior mutation available for undo'); redoHistory.push(clone(table)); table = history.pop(); revision++; return 'ok';
    case 'redo_command': assert(redoHistory.length, 'real undone mutation available for redo'); history.push(clone(table)); table = redoHistory.pop(); revision++; return 'ok';
    case 'update_table_edit_settings': {
      if (settingsGate) await settingsGate.promise;
      if (settingsFailure) throw settingsFailure;
      assert.equal(args.request.expected_revision, String(revision), 'settings uses the refreshed post-commit revision');
      table.description = args.request.description;
      table.metadata.initial_transposed = args.request.initial_transposed;
      if (args.request.display_name !== undefined) table.display_name = args.request.display_name;
      table.metadata.edit_permissions = args.request.edit_permissions;
      revision++;
      return snapshot();
    }
    case 'set_record_label': table.records.find(row=>row.uuid===args.recordUuid).label=args.newLabel; revision++; return 'ok';
    case 'save_project': return 'ok';
    default: throw Error(`Unexpected IPC: ${command}`);
  }
};
Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: {
  async writeText(text) { writes.push(text); if (clipboardFailure) throw Error('clipboard unavailable'); if (clipboardDelay) await clipboardDelay.promise; clipboard = text; },
  async readText() { throw Error('Bulk paste must use native clipboardData, not asynchronous readText'); }
} });
globalThis.__cutInputCheck = { invoke, openStringEditor: request => expandedRequests.push(clone(request)), confirmWarnings: async () => { warningRequests++; return warningResult; } };
const boundaries = {
  '@tauri-apps/api/core': `export const invoke=(...args)=>globalThis.__cutInputCheck.invoke(...args); export const isTauri=()=>false;`,
  '@tauri-apps/api/event': `export const listen=async()=>()=>{}; export const emit=async()=>{}; export const emitTo=async()=>{};`,
};
// Runtime warnings are regressions, not informational test output. Preserve the
// diagnostic on stderr and fail rather than hiding or filtering React messages.
const runtimeDiagnostics = [];
const originalConsole = { warn: console.warn, error: console.error };
for (const level of ['warn', 'error']) console[level] = (...args) => {
  runtimeDiagnostics.push({ level, message: format(...args) });
  originalConsole[level](...args);
};
const assertRuntimeClean = () => assert.deepEqual(runtimeDiagnostics, [], 'grid runtime must not warn or error');
let root, React;
try {
  const bundled = await build({ absWorkingDir: project,
    stdin: { contents: `export { ConditionalFormattingEditor } from './src/app/components/column-editor/ConditionalFormattingEditor'; export { RulePreview } from './src/app/components/column-editor/RulePreview'; export { applyRuntimeLocalization } from './src/app/i18n'; export { PropertiesPanel } from './src/app/pages/main_window/project_view/properties_panel/PropertiesPanel'; export {default as DataGridView} from './src/app/pages/main_window/project_view/table_view/components/DataGridView'; export {t} from './src/app/i18n'; export { setTableInteractionTarget } from './src/app/services/tableInteractionScope'; export {parseClipboardTsv, serializeClipboardTsv} from './src/app/pages/main_window/project_view/table_view/components/gridClipboard';`, resolveDir: project, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    define: { 'import.meta.env.DEV': 'false' }, alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'native-boundaries-and-static-css', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path.endsWith('/ColumnEditor')) return { path: args.path, namespace: 'column-editor' };
        if (args.path.endsWith('/table_rule_dialogs')) return { path: args.path, namespace: 'warning-dialog' };
        if (args.path.endsWith('/string_editor_window')) return { path: args.path, namespace: 'string-window' };
        if (Object.hasOwn(boundaries, args.path)) return { path: args.path, namespace: 'boundary' };
        if (args.path === '@linaria/core') return { path: args.path, namespace: 'static-css' };
        if (args.path.endsWith('.css')) return { path: args.path, namespace: 'empty-css' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'column-editor' }, () => ({ resolveDir: project, contents: `import React from 'react'; export const ColumnEditor=props=>React.createElement('div',{'data-column-editor':JSON.stringify(props.target)});`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'warning-dialog' }, () => ({ contents: `export const confirmInputWarnings=()=>globalThis.__cutInputCheck.confirmWarnings();`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'string-window' }, () => ({ contents: `export const showStringEditor=async(request)=>globalThis.__cutInputCheck.openStringEditor(request); export const registerMainWindowCloseBlocker=()=>()=>{};`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: boundaries[args.path], loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'static-css' }, () => ({ contents: `export const css=()=> 'synthetic-css';`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'js' }));
      if (before) builder.onLoad({ filter: /[/\\](DataGridView|DataGridToolbar)\.tsx$/ }, async args => ({ contents: await readFile(resolve(before, 'devcel-studio', args.path.slice(project.length + 1)), 'utf8'), loader: 'tsx' }));
    } }]
  });
  const modulePath = resolve(temporary, 'app.mjs'); await writeFile(modulePath, bundled.outputFiles[0].text);
  const { ConditionalFormattingEditor, RulePreview, applyRuntimeLocalization, PropertiesPanel, DataGridView, t, parseClipboardTsv, serializeClipboardTsv, setTableInteractionTarget } = await import(pathToFileURL(modulePath));
  React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { DndProvider } = await import('react-dnd'); const { HTML5Backend } = await import('react-dnd-html5-backend');
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const act = React.act;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
  let mountId = 0, incoming, renderProps = {}, mirrorSnapshots = false;
  const ParentSnapshotOwner = () => {
    const [owned, setOwned] = React.useState(null);
    const ownedRef = React.useRef(null);
    return React.createElement(DataGridView, { projectSessionId: session, tableName: 'equipment',
      tableData: owned?.table ?? incoming, preparedSnapshot: owned ?? undefined,
      onAuthoritativeSnapshot: snapshot => {
        ownedRef.current = snapshot;
        setOwned(previous => previous?.table === snapshot.table && previous?.presentation === snapshot.presentation ? previous : snapshot);
      },
      onDataChange: table => { if (ownedRef.current?.table === table) return; ownedRef.current = null; setOwned(null); }, ...renderProps });
  };
  const render = async () => { await act(async () => root.render(React.createElement(DndProvider, { backend: HTML5Backend }, mirrorSnapshots ? React.createElement(ParentSnapshotOwner, { key: mountId }) : React.createElement(DataGridView, { key: mountId, projectSessionId: session, tableName: 'equipment', tableData: incoming, ...renderProps })))); await settle(); };
  const reset = async (edit = () => {}) => {
    mirrorSnapshots = false; emitMutationInvalidation = false; snapshotGate = null; snapshotFailure = null;
    settingsGate = null; settingsFailure = null; mutationGate = null; mutationFailure = null; warningResult = false; warningRequests = 0;
    rangeBars = new Map(); renderProps = {}; table = makeTable(); revision = 1; history = []; redoHistory = []; omittedCells = new Set(); expandedRequests.length = 0; omittedRaw = new Set(); clipboard = 'original clipboard'; clipboardFailure = false; clipboardDelay = null; session = `session-${++mountId}`;
    edit(table); incoming = clone(table); await render();
    assert(!host.querySelector('[role="alert"]'), host.querySelector('[role="alert"]')?.textContent);
    assert(host.querySelector('.rdg') || (table.records.length === 0 && table.schema.columns.length === 0), 'actual grid or empty-table view');
  };
  const cell = (row, name) => {
    const index = table.schema.columns.findIndex(col => col.data_name === name);
    const result = host.querySelector(`[role="row"][aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="${index + 2}"]`);
    assert(result, `visible cell ${row}:${name}`); return result;
  };
  const select = async (row, name, shiftKey = false) => { await act(async () => cell(row, name).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, shiftKey }))); await settle(); };
  const selected = () => host.querySelector('[role="gridcell"][aria-selected="true"]') || host.querySelector('.rdg');
  const key = async (letter, target = selected(), options = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: letter, ctrlKey: true, bubbles: true, cancelable: true, ...options });
    await act(async () => target.dispatchEvent(event)); await settle(); return event;
  };
  const paste = async (text = clipboard, target = selected()) => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: format => format === 'text/plain' ? text : '' } });
    await act(async () => target.dispatchEvent(event)); await settle(); return event;
  };
  const filter = async value => {
    const input = host.querySelector(`input[placeholder="${t('grid.searchTable')}"]`); assert(input);
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); await settle();
  };
  const source = () => table.records.find(record => record.uuid === 'record-source');
  const target = () => table.records.find(record => record.uuid === 'record-target');
  const check = async (name, action) => { await action(); assertRuntimeClean(); reports.push(name); console.log('PASS', name); };
  const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

  const toggleButton = () => [...document.querySelectorAll('button')].find(b=>b.textContent===t('grid.transpose'));
  const transpose = async () => { if(!toggleButton()){await act(async()=>host.querySelector('.version-view-button').click()); await settle();} const b=toggleButton(); assert(b, 'transpose toolbar switch'); await act(async()=>b.click()); await settle(); };
  const isTransposed = () => Boolean(host.querySelector('.rdg-transpose-field-header'));
  const viewCell = (row, col) => { const result=host.querySelector(`[role="row"][aria-rowindex="${row+2}"] [role="gridcell"][aria-colindex="${col+2}"]`); assert(result, `view cell ${row}:${col}`); return result; };
  const vselect = async (row,col,shiftKey=false) => { await act(async()=>viewCell(row,col).dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,buttons:1,shiftKey}))); await settle(); };
  const vedit = async (row,col) => { await vselect(row,col); await act(async()=>viewCell(row,col).dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true,cancelable:true}))); await settle(); const input=host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea'); assert(input,'real text editor'); return input; };
  const inputValue = async (input,value) => { await act(async()=>{ Object.getOwnPropertyDescriptor(input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new window.Event('input',{bubbles:true})); }); await settle(); };
  const lastCells = () => mutationCalls().at(-1).args.request.cells;
  const quietCount = () => mutationCalls().length;
  const mini = data => { data.records=data.records.slice(0,3); data.schema.columns=data.schema.columns.slice(0,2); };

  const settings = () => [...host.querySelectorAll('button')].find(button => button.textContent === t('table.edit.settings'));
  const settingsDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog =>
    [...dialog.querySelectorAll('h2')].some(title => title.textContent === t('table.edit.settings')));
  const down = async button => {
    await act(async () => {
      button.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse' }));
    });
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
      if (!button.disabled) button.focus();
    });
  };
  const up = async (button, target = button, click = true) => {
    await act(async () => {
      target.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
      target.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      if (click) button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    }); await settle();
  };
  const editAndHold = async value => {
    const input = await vedit(1, 0); await inputValue(input, value);
    mutationGate = deferred(); const gate = mutationGate, button = settings();
    const count = mutationCalls().length;
    await down(button);
    assert.equal(mutationCalls().length, count + 1, 'mousedown immediately delivers exactly one cell mutation');
    assert(!settingsDialog(), 'pointerdown never opens a stale settings draft');
    return { gate, button, count };
  };
  const finish = async gate => { mutationGate = null; await act(async () => gate.resolve()); await settle(); };
  const cancelSettings = async () => {
    const dialog = settingsDialog(); assert(dialog);
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === t('common.cancel')).click());
    await settle();
  };

  await check('production keyboard selection, navigation and editor isolation', async () => {
    await reset(mini);
    await vselect(1,1);
    await key('a'); await key('c');
    assert.deepEqual(parseClipboardTsv(clipboard), [['hidden','1'],['source','5'],['target','9']]);
    await vselect(1,1); await key('Home',selected(),{ctrlKey:false});
    assert.equal(selected(),viewCell(1,0));
    await key('Home'); assert.equal(selected(),viewCell(0,0));
    await key('ArrowDown'); assert.equal(selected(),viewCell(2,0));
    await key('ArrowUp',selected(),{shiftKey:true}); await key('c');
    assert.deepEqual(parseClipboardTsv(clipboard),[['hidden'],['source'],['target']]);
    await vselect(1,1); await key(' '); await key('c');
    assert.deepEqual(parseClipboardTsv(clipboard),[['1'],['5'],['9']]);
    await vselect(1,1); await key(' ',selected(),{ctrlKey:false,shiftKey:true}); await key('c');
    assert.deepEqual(parseClipboardTsv(clipboard),[['source','5']]);
    await vselect(1,0); await key('Enter',selected(),{ctrlKey:false}); assert.equal(selected(),viewCell(2,0));
    await key('Enter',selected(),{ctrlKey:false,shiftKey:true}); assert.equal(selected(),viewCell(1,0));
    const input=await vedit(1,0);
    assert.equal((await key('a',input)).defaultPrevented,false,'input owns select-all');
    await inputValue(input,'changed'); await key('Escape',input,{ctrlKey:false});
    assert.equal(source().values.name,'source','Escape cancels draft');
    await key('F2',selected(),{ctrlKey:false}); await settle();
    const edited=host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea'); assert(edited,'F2 opens production editor');
    await inputValue(edited,'saved name'); const count=quietCount();
    await key('Enter',edited,{ctrlKey:false});
    assert.equal(source().values.name,'saved name'); assert.equal(quietCount(),count+1);
    assert.equal(selected(),viewCell(2,0),'commit moves down');
    const upInput=await vedit(1,0); await inputValue(upInput,'source');
    await key('Enter',upInput,{ctrlKey:false,shiftKey:true});
    assert.equal(source().values.name,'source'); assert.equal(selected(),viewCell(0,0));
    const search=host.querySelector(`input[placeholder="${t('grid.searchTable')}"]`);
    assert.equal((await key('a',search)).defaultPrevented,false,'search owns select-all');
    await vselect(1,0);
    assert.equal((await key('a',selected(),{isComposing:true})).defaultPrevented,false,'IME owns composing keys');
    await transpose(); await vselect(0,0); await key('a'); await key('c');
    assert.deepEqual(parseClipboardTsv(clipboard),[['hidden','source','target'],['1','5','9']]);
  });

  await check('model-based selection follows filters and jumps across empty data regions',async()=>{
    await reset(data=>{mini(data);data.records[1].values.name='';});
    await vselect(0,0);await key('ArrowDown');assert.equal(selected(),viewCell(2,0),'jump over gap to next filled value');
    await key('ArrowUp');assert.equal(selected(),viewCell(0,0));
    await transpose();await vselect(0,0);await key('ArrowRight');assert.equal(selected(),viewCell(0,2),'transpose region resolves canonical values across gap');
    await key('ArrowLeft',selected(),{shiftKey:true});await key('c');assert.deepEqual(parseClipboardTsv(clipboard),[['hidden','','target']]);await transpose();
    await filter('target');await vselect(0,0);await key('a');await key('c');
    assert.deepEqual(parseClipboardTsv(clipboard),[['target','9']],'filtered hidden records excluded');
    await transpose();await vselect(0,0);await key('a');await key('c');
    assert.deepEqual(parseClipboardTsv(clipboard),[['target'],['9']]);
  });

  await check('UUID-shaped authored row labels survive normal and transpose edit-save',async()=>{
    for(const transposed of [false,true]) for(const prefixed of [false,true]) {
      await reset(data=>{mini(data);data.records[1].label=(prefixed?'record_':'')+data.records[1].uuid;});
      const expected=table.records[1].label;
      if(transposed)await transpose();
      const label=transposed?host.querySelectorAll('.rdg-transpose-record-header')[1]:host.querySelector('[role="row"][aria-rowindex="3"] [role="gridcell"][aria-colindex="1"]');
      await act(async()=>(transposed?label:label.querySelector('span[title]')).dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true,detail:2})));await settle();
      const dialog=document.querySelector('[role="dialog"]'); assert(dialog,'row-label dialog');
      assert.equal(dialog.querySelector('input').value,expected);
      assert.equal((await key('a',dialog.querySelector('input'))).defaultPrevented,false);
      await act(async()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await settle();
      assert.equal(table.records[1].label,expected);
      assert.equal(calls.filter(c=>c.command==='set_record_label').at(-1).args.newLabel,expected);
    }
  });

  await check('range presentation renders behind normal/transpose cells and follows app RTL',async()=>{
    const css=await readFile(resolve(project,'src/app/pages/main_window/project_view/table_view/components/DataGridView.css'),'utf8');
    assert.match(css,/\.rdg-cell-has-memo::after\s*\{[^}]*pointer-events: none/s);
    assert(!/\.rdg-cell-has-memo\s*\{[^}]*background/s.test(css),'memo must not resize or replace the cell background');
    const catalog=JSON.parse(await readFile(resolve(project,'src/app/i18n/generated/catalog.json'),'utf8'));
    for(const direction of ['ltr','rtl']) {
      await act(async()=>applyRuntimeLocalization({messages:catalog.messages,locales:{...catalog.locales,ja:{...catalog.locales.ja,direction}}},{preference:'ja',locale:'ja',revision:`range-${direction}`,availableLocales:['ja']}));
      await reset(data=>{mini(data);data.records[1].memo_texts={'column-rarity':'IN RANGE MEMO'};data.records[2].memo_texts={'column-rarity':'OUTSIDE MEMO'};rangeBars.set('record-source:column-rarity',{fraction:2500,color:'#2563eb',out_of_range:false});rangeBars.set('record-target:column-rarity',{fraction:10000,color:'#dc2626',out_of_range:true});});
      const bar=cell(1,'rarity'); assert(bar.classList.contains('rdg-cell-has-memo')); assert(cell(2,'rarity').classList.contains('rdg-cell-has-memo')); assert(bar.style.backgroundImage.includes(direction==='rtl'?'to left':'to right'));assert(bar.style.backgroundImage.includes('25%'));
      assert.equal(bar.textContent.trim(),'5');assert(bar.style.color);
      await select(1,'rarity');assert(cell(1,'rarity').style.backgroundImage.includes('25%'),'selected bar remains visible');
      assert.equal(cell(2,'rarity').style.backgroundImage,'none');assert.equal(cell(2,'rarity').style.backgroundColor,'#dc2626');
      await transpose();assert(viewCell(1,1).style.backgroundImage.includes(direction==='rtl'?'to left':'to right'));assert.equal(viewCell(1,1).textContent.trim(),'5'); assert(viewCell(1,1).classList.contains('rdg-cell-has-memo')); assert(viewCell(1,2).classList.contains('rdg-cell-has-memo'));
    }
    await act(async()=>applyRuntimeLocalization(catalog,{preference:'ja',locale:'ja',revision:'range-reset',availableLocales:Object.keys(catalog.locales)}));
  });
  await check('range editor exposes three colors and preview consumes authoritative bar',async()=>{
    const condition={kind:'between',min:'0',max:'100',low_color:'#93c5fd',high_color:'#2563eb',out_of_range_color:'#dc2626'};
    const rule={id:'range',enabled:true,condition,style:{},stop_if_true:false};
    let applied=null;
    await act(async()=>root.render(React.createElement(ConditionalFormattingEditor,{value:{rules:[rule]},baseValue:null,onChange:value=>{applied=value;},onNewRule:async()=>rule,disabled:false,inherited:false,canOverride:false,onOpenOrigin:()=>{}})));await settle();
    await act(async()=>host.querySelector('.format-rule-select').click());await settle();
    const dialog=document.querySelector('[role="dialog"]');assert(dialog);
    assert.equal(dialog.querySelectorAll('input[type="color"]').length,4,'three range colors plus text color, no misleading background field');
    const out=dialog.querySelector('input[id$="-range-out"]');assert.equal(out.value,'#dc2626');await inputValue(out,'#ff00ff');
    await act(async()=>dialog.querySelector('.rule-dialog-header button').click());await settle();
    assert.equal(applied.rules[0].condition.out_of_range_color,'#ff00ff');
    const presentation={raw_value:'25',display_value:'25',style:{},issues:[],formula_error:null,hint:'',range_bar:{fraction:2500,color:'#2563eb',out_of_range:false}};
    await act(async()=>root.render(React.createElement(RulePreview,{kind:'display',columnName:'Amount',preview:{population_count:1,input_issue_count:0,presentation_samples:[{table_uuid:'equipment',record_uuid:'record-source',presentation}]}})));await settle();
    assert([...host.querySelectorAll('dd')].some(el=>el.style.backgroundImage.includes('25%')),'production preview shares range rendering');
  });

  const choiceTable = data => {
    mini(data);
    data.schema.columns[1].data_type = 'Select';
    data.schema.columns[1].select_config = { options: [{ value: 'first', label: 'First label' }, { value: 'second', label: 'Second label' }] };
    data.records.forEach(record => { record.values.rarity = 'first'; });
  };
  const openChoice = async (row, col) => {
    const select = viewCell(row, col).querySelector('select');
    assert(select && !select.disabled, 'an unselected cell already exposes its native Select');
    await act(async () => select.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })));
    return select;
  };
  const choose = async (select, value) => {
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value); select.dispatchEvent(new window.Event('change', { bubbles: true })); }); await settle();
  };
  await check('Select choices display labels but commit canonical values to the normal UUID cell', async () => {
    await reset(choiceTable); assert.equal(viewCell(1, 1).querySelector('select').selectedOptions[0].textContent, 'First label');
    const input = await openChoice(1, 1); assert.deepEqual([...input.options].map(option => option.value), ['', 'first', 'second']);
    await choose(input, 'second'); assert.equal(table.records[1].values.rarity, 'second'); assert.equal(viewCell(1, 1).querySelector('select').value, 'second');
    assert.equal([...viewCell(1, 1).querySelector('select').options].find(option => option.value === 'second').textContent, 'Second label');
    assert.deepEqual(lastCells().map(cell => [cell.record_uuid, cell.column_uuid, cell.value]), [['record-source', 'column-rarity', 'second']]);
  });
  await check('Select editing in transpose commits the canonical record/column UUID pair', async () => {
    await reset(choiceTable); await transpose(); assert(isTransposed());
    const input = await openChoice(1, 2); await choose(input, 'second');
    assert.equal(table.records[2].values.rarity, 'second'); assert.equal(table.records[1].values.rarity, 'first');
    assert.deepEqual(lastCells().map(cell => [cell.record_uuid, cell.column_uuid, cell.value]), [['record-target', 'column-rarity', 'second']]);
  });
  await check('Select Escape cancels and a read-only Select has no activatable dropdown', async () => {
    await reset(choiceTable); const input = await openChoice(1, 1); const count = quietCount();
    await key('Escape', input, { ctrlKey: false }); assert(!host.querySelector('.rdg-editor-container')); assert.equal(quietCount(), count);
    await reset(data => { choiceTable(data); data.schema.columns[1].read_only = true; }); assert(viewCell(1, 1).querySelector('select').disabled);
  });
  await check('Changing orientation preserves semantic cell selection in both directions', async () => {
    await reset(mini); await vselect(2, 1); await transpose();
    assert.equal(selected(), viewCell(1, 2)); await transpose(); assert.equal(selected(), viewCell(2, 1));
  });
  await check('Same-table authoritative orientation changes immediately without reopening its tab', async () => {
    await reset(mini); await vselect(2, 1); table.metadata.initial_transposed = true; revision++; incoming = clone(table); await render();
    assert(isTransposed()); assert.equal(selected(), viewCell(1, 2));
  });
  await check('Settings orientation writes immediately, keeps the dirty display name, and close saves the fresh revision once', async () => {
    await reset(mini); await vselect(2, 1); await down(settings()); await up(settings()); const dialog = settingsDialog(); assert(dialog);
    await inputValue(dialog.querySelector('input:not([type])'), 'pending description');
    const before = calls.filter(call => call.command === 'update_table_edit_settings').length;
    await act(async () => dialog.querySelectorAll('input[type="radio"]')[1].click()); await settle();
    assert(isTransposed()); assert.equal(settingsDialog(), dialog); assert.equal(dialog.querySelector('input:not([type])').value, 'pending description');
    assert.notEqual(table.display_name, 'pending description', 'orientation must not prematurely commit dirty text');
    assert.equal(selected(), viewCell(1, 2));
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === t('common.close')).click()); await settle();
    assert(!settingsDialog()); assert.equal(table.display_name, 'pending description');
    assert.equal(calls.filter(call => call.command === 'update_table_edit_settings').length, before + 2);
  });
  await check('Table header descriptions use explicit edit/save/cancel and preserve unrelated settings', async () => {
    await reset(data=>{mini(data);data.description='Original table description';});
    const editor=()=>host.querySelector('[data-description-editor]');
    const action=label=>[...editor().querySelectorAll('button')].find(button=>button.textContent===t(label));
    const press=async label=>{await act(async()=>{assert(action(label));action(label).click();});await settle();};
    await press('common.edit');await inputValue(editor().querySelector('textarea'),'Cancelled');
    await down(settings());await up(settings());assert.equal(settingsDialog(),undefined,'description editing cannot open a second settings draft');
    await press('common.cancel');assert.equal(table.description,'Original table description');
    await press('common.edit');await inputValue(editor().querySelector('textarea'),'Saved description');
    const prior=clone(table);settingsFailure=Error('description write failed');await press('common.save');
    assert.equal(editor().querySelector('textarea').value,'Saved description');assert(editor().querySelector('[role="alert"]').textContent.includes('description write failed'));
    settingsFailure=null;await press('common.save');assert.equal(table.description,'Saved description');
    assert.deepEqual({...table,description:prior.description},prior,'only the description changes');
    assert.equal(editor().querySelector('textarea'),null);assert(editor().textContent.includes('Saved description'));
    const write=calls.filter(call=>call.command==='update_table_edit_settings').at(-1);
    assert.equal(write.args.expectedProjectSession,session);assert.equal(write.args.request.description,'Saved description');
    await down(settings());await up(settings());assert.equal(settingsDialog().querySelector('textarea'),null,'settings has no duplicate description editor');
    await act(async()=>[...settingsDialog().querySelectorAll('button')].find(button=>button.textContent===t('common.close')).click());await settle();
  });
  await check('Table description conflict compares the authoritative snapshot before explicit retry', async () => {
    await reset(data=>{mini(data);data.description='Before conflict';});
    const editor=()=>host.querySelector('[data-description-editor]');
    const press=async label=>{await act(async()=>{const button=[...editor().querySelectorAll('button')].find(button=>button.textContent===t(label));assert(button);button.click();});await settle();};
    await press('common.edit');await inputValue(editor().querySelector('textarea'),'My table description');
    settingsFailure={kind:'code',code:'error.staleData',params:{}};await press('common.save');settingsFailure=null;
    table.description='Other description';revision++;
    await press('common.reload');assert.equal(editor().querySelector('[data-description-latest]').textContent,'Other description');
    assert.equal(editor().querySelector('textarea').value,'My table description');
    const expected=String(revision);await press('common.retry');assert.equal(table.description,'My table description');
    assert.equal(calls.filter(call=>call.command==='update_table_edit_settings').at(-1).args.request.expected_revision,expected);
  });
  await check('A failed immediate orientation retains its open dialog and every pending draft', async () => {
    await reset(mini); await down(settings()); await up(settings()); const dialog = settingsDialog();
    await inputValue(dialog.querySelector('input:not([type])'), 'do not discard'); settingsFailure = Error('orientation rejected');
    await act(async () => dialog.querySelectorAll('input[type="radio"]')[1].click()); await settle();
    assert(!isTransposed()); assert(settingsDialog()); assert.equal(dialog.querySelector('input:not([type])').value, 'do not discard');
    assert.equal(dialog.querySelectorAll('input[type="radio"]')[0].checked, true); assert(dialog.querySelector('[role="alert"]'));
    settingsFailure = null;
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === t('common.close')).click()); await settle();
    assert(!settingsDialog()); assert.equal(table.display_name, 'do not discard');
  });
  await check('Repeated close during an orientation write waits and saves dirty text exactly once', async () => {
    await reset(mini); await down(settings()); await up(settings()); const dialog = settingsDialog();
    await inputValue(dialog.querySelector('input:not([type])'), 'queued close'); const before = calls.filter(call => call.command === 'update_table_edit_settings').length;
    settingsGate = deferred(); const gate = settingsGate;
    await act(async () => dialog.querySelectorAll('input[type="radio"]')[1].click()); await settle();
    const close = [...dialog.querySelectorAll('button')].find(button => button.textContent === t('common.saving')); assert(close);
    await act(async () => { close.click(); close.click(); }); await settle(); assert(settingsDialog());
    settingsGate = null; await act(async () => gate.resolve()); await settle(); await settle();
    assert(!settingsDialog()); assert(isTransposed()); assert.equal(table.display_name, 'queued close');
    assert.equal(calls.filter(call => call.command === 'update_table_edit_settings').length, before + 2);
  });
  await check('Empty row labels remain empty in normal and transposed headers without copying cell values', async () => {
    await reset(data => { mini(data); data.records[1].label = ''; });
    const sourceId = table.records[1].uuid;
    const indicator = host.querySelector('[role="row"][aria-rowindex="3"] [role="gridcell"][aria-colindex="1"]');
    assert(!indicator.textContent.includes(sourceId)); assert(!indicator.textContent.includes('source'));
    await transpose(); const header = host.querySelectorAll('.rdg-transpose-record-header')[1];
    assert(!header.textContent.includes(sourceId)); assert(!header.textContent.includes('source'));
    assert.equal(table.records[1].uuid, sourceId); assert.equal(table.records[1].label, '');
  });
  await check('Missing column display labels render internal names without writing them back', async () => {
    await reset(data => { mini(data); data.schema.columns[0].display_name=''; });
    const name=table.schema.columns[0].data_name;
    assert(host.querySelector('button.rdg-header-labels').textContent.includes(name));
    await transpose();
    assert(host.querySelector('.rdg-transpose-field-label').textContent.includes(name));
    assert.equal(table.schema.columns[0].display_name,'');
  });
  await check('Column labels edit on double click or keyboard activation without persistent pencils', async () => {
    await reset(mini);
    assert.equal(host.querySelectorAll('.rdg-column-edit-control').length, 0);
    assert.equal(host.querySelectorAll('button.rdg-header-labels').length, 2);
    assert.equal(host.querySelectorAll('.rdg-first-column-insert').length, 0);
    assert.equal(host.querySelectorAll('.rdg-column-insert-start').length, 2);
    assert.equal(host.querySelectorAll('.rdg-column-insert-end').length, 2);
    await act(async () => host.querySelector('.rdg-column-insert-start button').click()); await settle();
    assert.equal(JSON.parse(host.querySelector('[data-column-editor]').dataset.columnEditor).insert_index, 0);
    await reset(mini);
    await act(async () => host.querySelectorAll('.rdg-column-insert-end button')[0].click()); await settle();
    assert.deepEqual(JSON.parse(host.querySelector('[data-column-editor]').dataset.columnEditor), { mode: 'table', target_uuid: 'equipment', column_uuid: null, insert_index: 1 });
    await reset(mini);
    const label = host.querySelectorAll('button.rdg-header-labels')[1];
    await act(async () => label.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })));
    assert(!host.querySelector('[data-column-editor]'), 'single pointer click does not edit');
    await act(async () => label.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, detail: 2 }))); await settle();
    assert.equal(JSON.parse(host.querySelector('[data-column-editor]').dataset.columnEditor).column_uuid, 'column-rarity');
  });
  await check('Column tooltip and description stay on normal/transpose headings; cell memo stays independent', async () => {
    await reset(data => { mini(data); data.schema.columns[0].tooltip='COLUMN TIP'; data.schema.columns[0].memo_text='COLUMN DETAIL'; data.records[0].memo_texts={'column-name':'CELL MEMO'}; });
    const detail = () => [...document.querySelectorAll('[role="dialog"]')].find(el => el.getAttribute('aria-label') === 'COLUMN DETAIL');
    assert.equal(host.querySelector('.rdg-header-labels').title, 'COLUMN TIP');
    await select(0,'name'); assert(!detail(), 'body selection cannot reveal column details');
    assert(!cell(0,'name').title.includes('COLUMN TIP'));
    const header=host.querySelector('.rdg-header-labels').closest('[role="columnheader"]');
    await act(async()=>header.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,button:0,buttons:1}))); await settle();
    assert(detail(), 'selected normal header reveals column details');
    await select(0,'name'); assert(!detail(), 'moving selection to body dismisses column details');
    await transpose();
    assert.equal(host.querySelector('.rdg-transpose-field-label').title, 'COLUMN TIP');
    await vselect(0,0); assert(!detail(), 'transposed data cell cannot reveal column details');
    const field=host.querySelector('.rdg-transpose-field-label').closest('[role="gridcell"]');
    await act(async()=>field.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,button:0,buttons:1}))); await settle();
    assert(detail(), 'selected transposed field label reveals column details');
    assert.equal(table.records[0].memo_texts['column-name'],'CELL MEMO');
    assert.equal(table.schema.columns[0].memo_text,'COLUMN DETAIL');
  });
  await check('Transposed insertion targets schema column order, never record order', async () => {
    await reset(mini); await transpose();
    await act(async () => host.querySelector('.rdg-transpose-column-insert-left').click()); await settle();
    assert.equal(JSON.parse(host.querySelector('[data-column-editor]').dataset.columnEditor).insert_index, 1);
  });
  await check('Cell memo marker and selected memo remain independent in normal/transpose views', async () => {
    for(const transposeView of [false,true]) {
      await reset(data=>{mini(data); data.records[0].memo_texts={'column-name':'PERSISTENT CELL MEMO'};});
      if(transposeView) await transpose();
      await vselect(0,0); const target=viewCell(0,0);
      assert(target.classList.contains('rdg-cell-has-memo'));
      const popup=()=>[...document.querySelectorAll('[role=dialog]')].find(e=>e.getAttribute('aria-label')==='PERSISTENT CELL MEMO');
      await act(async()=>target.dispatchEvent(new window.MouseEvent('click',{bubbles:true}))); assert(popup());
      await act(async()=>target.dispatchEvent(new window.MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))); assert(popup());
      await act(async()=>popup().querySelector('button').click()); assert(!popup());
      await act(async()=>target.dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true}))); assert(!popup());
      await act(async()=>viewCell(1,0).dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true})));
      await act(async()=>target.dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true})));
      await act(async()=>new Promise(resolve=>setTimeout(resolve,2100))); assert(!popup(), 'hovering another cell without selecting it must not reopen a dismissed memo');
      await vselect(1,0); await vselect(0,0);
      await act(async()=>target.dispatchEvent(new window.MouseEvent('click',{bubbles:true}))); assert(popup());
      await vselect(1,0); assert(!popup());
    }
  });
  await check('Actual header border-box 70/71 breakpoint survives zoom and transposition', async () => {
    for(const transposeView of [false,true]) {
      await reset(mini); if(transposeView) await transpose();
      const insertion=host.querySelector('.rdg-advanced-column'); const header=insertion.closest('[role=columnheader]');
      for(const zoom of [1,2]) for(const width of [50,70,71,180]) {
        header.style.transform=`scale(${zoom})`;
        await act(async()=>{for(const observer of resizeObservers) if(observer.targets.has(header)) observer.callback([{target:header,borderBoxSize:[{inlineSize:width}]}]);});
        assert.equal(insertion.hasAttribute('data-narrow-insertion'),width<=70,`${transposeView}/${zoom}/${width}`);
      }
    }
  });
  await check('Insertion permissions remove all targets in either orientation and update live', async () => {
    for(const add_rows of [false,true]) for(const add_columns of [false,true]) {
      await reset(data=>{mini(data);data.metadata.edit_permissions.add_rows=add_rows;data.metadata.edit_permissions.add_columns=add_columns;});
      assert.equal(host.querySelectorAll('.rdg-column-insert-control').length,add_columns?4:0);
      for (const header of host.querySelectorAll('.rdg-advanced-column')) assert.equal(header.getAttribute('data-insert-allowed'),String(add_columns));
      assert.equal(!!host.querySelector('.rdg-first-row-insert'),add_rows);
      assert.equal(!!host.querySelector('.rdg-row-insert-control'),add_rows);
      await transpose();
      assert.equal(!!host.querySelector('.rdg-column-insert-control'),add_rows);
      assert.equal(!!host.querySelector('.rdg-transpose-column-insert'),add_columns);
      assert.equal(!!host.querySelector('.rdg-first-row-insert'),add_columns);
    }
  });
  await check('Permission changes remove insertion controls without remounting the table', async () => {
    await reset(mini);
    for(const enabled of [false,true,false]) {
      table.metadata.edit_permissions.add_columns=enabled; table.metadata.edit_permissions.add_rows=enabled;
      revision++; incoming=clone(table); await render();
      assert.equal(!!host.querySelector('.rdg-column-insert-control'),enabled);
      for (const header of host.querySelectorAll('.rdg-advanced-column')) assert.equal(header.getAttribute('data-insert-allowed'),String(enabled));
      assert.equal(!!host.querySelector('.rdg-row-insert-control'),enabled);
      assert.equal(!!host.querySelector('.rdg-first-row-insert'),enabled);
    }
  });
  await check('Permission-specific sort spacing uses production CSS without changing narrow or updating contracts', async () => {
    const css = document.createElement('style');
    css.textContent = await readFile(resolve(project,'src/app/pages/main_window/project_view/table_view/components/DataGridView.css'),'utf8');
    document.head.append(css);
    try {
      await reset(mini);
      for (const width of [50,70,71,180]) for (const zoom of [1,2]) for (const enabled of [true,false,true]) {
        table.metadata.edit_permissions.add_columns=enabled; revision++; incoming=clone(table); await render();
        const insertion=host.querySelector('.rdg-advanced-column');
        const header=insertion.closest('[role=columnheader]');
        header.style.transform=`scale(${zoom})`;
        await act(async()=>{for(const observer of resizeObservers) if(observer.targets.has(header)) observer.callback([{target:header,borderBoxSize:[{inlineSize:width}]}]);});
        const slot=insertion.querySelector('.rdg-column-filter-slot'); assert(slot);
        assert.equal(getComputedStyle(slot).insetInlineEnd,!enabled || width<=70?'4px':'28px');
        assert.equal(insertion.querySelectorAll('.rdg-column-insert-control').length,enabled?2:0);
        if(!enabled) {
          assert.equal(getComputedStyle(insertion.querySelector('.rdg-header-labels')).paddingInline,'8px');
          assert.equal(getComputedStyle(slot).maxWidth,width<=70?'18px':'calc(100% - 12px)');
          for(const state of ['is-sorted','is-filtered','open']) {
            const trigger=slot.querySelector('.grid-fs-trigger');
            if(state==='open')trigger.setAttribute('data-state','open');else trigger.classList.add(state);
            // Evaluate each CSS state on fresh production markup: Happy DOM's
            // descendant :has invalidation is not a substitute for native hover QA.
            const styled = insertion.cloneNode(true); document.body.append(styled);
            try {
              assert.equal(getComputedStyle(styled.querySelector('.rdg-column-filter-slot')).insetInlineEnd,'4px');
              assert.equal(getComputedStyle(styled.querySelector('.rdg-header-labels')).paddingInlineEnd,'26px',`${width}/${zoom}/${state}`);
            } finally { styled.remove(); }
            trigger.classList.remove(state);trigger.removeAttribute('data-state');
          }
        }
      }
      await reset(mini);
      const {gate}=await editAndHold('updating spacing');
      assert.equal(host.querySelector('.rdg-advanced-column').getAttribute('data-insert-allowed'),'true');
      assert.equal(getComputedStyle(host.querySelector('.rdg-column-filter-slot')).insetInlineEnd,'28px');
      await finish(gate);
    } finally { css.remove(); }
  });
  await check('View zoom accepts and applies 200 percent', async () => {
    await reset(mini); await act(async () => host.querySelector('.version-view-button').click()); await settle();
    const slider = document.querySelector('.version-zoom-slider'); assert.equal(slider.max, '200');
    await inputValue(slider, '200'); assert(host.querySelector('.version-zoom-value').textContent.includes('200'));
    assert.equal(host.querySelector('.rdg').style.getPropertyValue('--rdg-physical-scale'), '2');
    assert.equal(host.querySelector('.rdg-physical-row-utility-grid').style.transform, 'scale(2)');
  });
  await check('Properties close works with a selected file and with no selection', async () => {
    for (const selectedItem of [null, { id: 'note.md', name: 'note.md', path: 'note.md', type: 'markdown' }]) {
      let closes = 0;
      await act(async () => root.render(React.createElement(PropertiesPanel, { selectedItem, onClose: () => { closes++; } })));
      const close = host.querySelector(`button[aria-label="${t('common.close')}"]`); assert(close);
      await act(async () => close.click()); assert.equal(closes, 1);
    }
  });
  const report={metrics,runtimeDiagnostics:runtimeDiagnostics.length,passed:reports.length,checks:reports,mutationCalls:mutationCalls().length,clipboardWrites:writes.length,scope:'Real DataGridView, toolbar, editors, settings dialog and mutation gate. Native IPC and warning-dialog responses are boundary fixtures; pointer events and DOM geometry are synthetic.'};
  if (process.env.GRID_FILTER_SORT_REPORT) await writeFile(process.env.GRID_FILTER_SORT_REPORT, JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
} finally {
  try {
    if (root) await React.act(() => root.unmount());
    await window.happyDOM.close();
    assertRuntimeClean();
  } finally {
    console.warn = originalConsole.warn; console.error = originalConsole.error;
    await rm(temporary, { recursive: true, force: true }); delete globalThis.__cutInputCheck;
  }
}
