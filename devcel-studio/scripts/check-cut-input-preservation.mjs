// Actual DataGridView, DataGrid, localization, useTableMutation and useTablePresentation.
// Only native IPC/events and browser clipboard are boundary fixtures. DOM geometry
// and Linaria's build-time CSS extraction are synthetic; this is not native WebKit QA.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.cut-input-check-'));
// Point at a repository snapshot to run identical assertions against the old UI.
const before = process.env.CUT_INPUT_BEFORE;
const reports = [], calls = [], writes = [], expandedRequests = [];
let nextEvaluationId = 0;
const evaluations = new Map();
const formula = '=LOOKUP("materials","key","marsh_hide_t01","value")*2+rarity';
const encodedFormula = '"' + formula.replaceAll('"', '""') + '"';
const window = new Window({ url: 'http://cut-input.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'NodeFilter', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver', 'CSS', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = window.IntersectionObserver = class { observe() {} disconnect() {} };
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
let omittedCells = new Set();
let rejectMutation = false;
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
const snapshot = () => ({ table: clone(table), presentation: {
  table_uuid: table.uuid, revision: String(revision), definition_issues: [], issue_count: 0,
  cells: Object.fromEntries(table.records.map(record => [record.uuid, Object.fromEntries(table.schema.columns.map(col => [col.uuid, {
    ...(!omittedRaw.has(`${record.uuid}:${col.uuid}`) ? { raw_value: raw(record, col) } : {}),
    display_value: display(record, col), style: {}, issues: [], formula_error: null, hint: ''
  }]).filter(([uuid]) => !omittedCells.has(`${record.uuid}:${uuid}`)))]))
} });
const mutationCalls = () => calls.filter(call => call.command === 'apply_table_mutation');
const invoke = async (command, args = {}) => {
  calls.push({ command, args: clone(args) });
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
      assert.deepEqual(evaluations.get(args.evaluationId), { tableUuid: args.tableUuid, session: args.expectedProjectSession }, 'snapshot uses its registered table/session request');
      evaluations.delete(args.evaluationId);
      return args.knownSnapshotToken === `${session}:${revision}`
        ? { kind: 'unchanged', snapshot_token: args.knownSnapshotToken, retained_bytes: 1024 }
        : { kind: 'snapshot', snapshot_token: `${session}:${revision}`, retained_bytes: 1024, ...snapshot() };
    }
    case 'prepare_record_draft': return {table_uuid:table.uuid,record_uuid:`new-record-${calls.length}`,revision:String(revision),values:[],columns:table.schema.columns};
    case 'apply_table_mutation': {
      if (rejectMutation) throw Error('fixture rejects entire bulk write');
      const request = args.request;
      assert.equal(request.table_uuid, table.uuid);
      if (request.expected_revision !== String(revision)) throw Error('fixture revision changed; stale mutation rejected');
      const previous = clone(table);
      table.records = table.records.filter(record => !request.delete_record_uuids.includes(record.uuid));
      for (const created of request.create_records) {
        const index = created.before_record_uuid ? table.records.findIndex(record=>record.uuid===created.before_record_uuid) : table.records.length;
        assert(index>=0);
        table.records.splice(index,0,{uuid:created.record_uuid,label:'',values:{},interface_values:{},min_version:0,tags:[],parent_uuid:'',memo_texts:{}});
      }
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
      if (JSON.stringify(previous) !== JSON.stringify(table)) { history.push(previous); redoHistory = []; revision++; }
      return snapshot();
    }
    case 'get_table_history_status': return { canUndo: history.length > 0, canRedo: redoHistory.length > 0 };
    case 'undo_command': assert(history.length, 'real prior mutation available for undo'); redoHistory.push(clone(table)); table = history.pop(); revision++; return 'ok';
    case 'redo_command': assert(redoHistory.length, 'real undone mutation available for redo'); history.push(clone(table)); table = redoHistory.pop(); revision++; return 'ok';
    case 'save_project': return 'ok';
    default: throw Error(`Unexpected IPC: ${command}`);
  }
};
Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: {
  async writeText(text) { writes.push(text); if (clipboardFailure) throw Error('clipboard unavailable'); if (clipboardDelay) await clipboardDelay.promise; clipboard = text; },
  async readText() { throw Error('Bulk paste must use native clipboardData, not asynchronous readText'); }
} });
globalThis.__cutInputCheck = { invoke, openStringEditor: request => expandedRequests.push(clone(request)) };
const boundaries = {
  '@tauri-apps/api/core': `export const invoke=(...args)=>globalThis.__cutInputCheck.invoke(...args); export const isTauri=()=>false;`,
  '@tauri-apps/api/event': `export const listen=async()=>()=>{}; export const emit=async()=>{}; export const emitTo=async()=>{};`,
};
let root, React;
try {
  const bundled = await build({ absWorkingDir: project,
    stdin: { contents: `export {default as DataGridView} from './src/app/pages/main_window/project_view/table_view/components/DataGridView'; export {t} from './src/app/i18n'; export {flushProjectSaveParticipants} from './src/app/utils/projectSaveParticipants'; export {parseClipboardTsv, serializeClipboardTsv} from './src/app/pages/main_window/project_view/table_view/components/gridClipboard';`, resolveDir: project, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    define: { 'import.meta.env.DEV': 'false' }, alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'native-boundaries-and-static-css', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path.endsWith('/string_editor_window')) return { path: args.path, namespace: 'string-window' };
        if (Object.hasOwn(boundaries, args.path)) return { path: args.path, namespace: 'boundary' };
        if (args.path === '@linaria/core') return { path: args.path, namespace: 'static-css' };
        if (args.path.endsWith('.css')) return { path: args.path, namespace: 'empty-css' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'string-window' }, () => ({ contents: `export const showStringEditor=async(request)=>globalThis.__cutInputCheck.openStringEditor(request); export const registerMainWindowCloseBlocker=()=>()=>{};`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: boundaries[args.path], loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'static-css' }, () => ({ contents: `export const css=()=> 'synthetic-css';`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'js' }));
      if (before) builder.onLoad({ filter: /DataGridView\.tsx$/ }, async args => ({ contents: await readFile(resolve(before, 'devcel-studio', args.path.slice(project.length + 1)), 'utf8'), loader: 'tsx' }));
    } }]
  });
  const modulePath = resolve(temporary, 'app.mjs'); await writeFile(modulePath, bundled.outputFiles[0].text);
  const { DataGridView, t, parseClipboardTsv, serializeClipboardTsv, flushProjectSaveParticipants } = await import(pathToFileURL(modulePath));
  React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { DndProvider } = await import('react-dnd'); const { HTML5Backend } = await import('react-dnd-html5-backend');
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const act = React.act;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
  let mountId = 0, incoming;
  const render = async () => { await act(async () => root.render(React.createElement(DndProvider, { backend: HTML5Backend }, React.createElement(DataGridView, { key: mountId, projectSessionId: session, tableName: 'equipment', tableData: incoming })))); await settle(); };
  const reset = async (edit = () => {}) => {
    rejectMutation = false; table = makeTable(); revision = 1; history = []; redoHistory = []; omittedCells = new Set(); expandedRequests.length = 0; omittedRaw = new Set(); clipboard = 'original clipboard'; clipboardFailure = false; clipboardDelay = null; session = `session-${++mountId}`;
    edit(table); incoming = clone(table); await render();
    assert(!host.querySelector('[role="alert"]'), host.querySelector('[role="alert"]')?.textContent);
    assert.equal(host.querySelectorAll('[role="row"]').length, table.metadata.initial_transposed ? table.schema.columns.length + 1 : 5, 'real grid renders visible axis');
  };
  const cell = (row, name) => {
    const index = table.schema.columns.findIndex(col => col.data_name === name);
    const result = host.querySelector(`[role="row"][aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="${index + 2}"]`);
    assert(result, `visible cell ${row}:${name}`); return result;
  };
  const select = async (row, name, shiftKey = false) => { await act(async () => cell(row, name).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, shiftKey }))); await settle(); };
  const selected = () => host.querySelector('[role="gridcell"][tabindex="0"]') || host.querySelector('.rdg');
  const key = async (letter, target = selected(), options = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: letter, ctrlKey: true, bubbles: true, cancelable: true, ...options });
    await act(async () => target.dispatchEvent(event)); await settle(); return event;
  };
  const paste = async (text = clipboard, target = selected(), html = '') => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: format => format === 'text/plain' ? text : format === 'text/html' ? html : '' } });
    await act(async () => target.dispatchEvent(event)); await settle(); return event;
  };
  const filter = async value => {
    const input = host.querySelector(`input[placeholder="${t('grid.searchTable')}"]`); assert(input);
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); await settle();
  };
  const source = () => table.records.find(record => record.uuid === 'record-source');
  const target = () => table.records.find(record => record.uuid === 'record-target');
  const check = async (name, action) => { await action(); reports.push(name); console.log('PASS', name); };
  const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

  await check('Select All from header and neutral chrome matches cell selection without changing data', async () => {
    await reset(); await select(1, 'power'); await key('a'); await key('c'); const all = clipboard;
    assert(all.includes('hidden') && all.includes('last'), 'all displayed records selected');
    for (const place of ['header', 'neutral']) {
      await select(1, 'power');
      const header = host.querySelector('[role="columnheader"]');
      await act(async()=>header.dispatchEvent(new window.PointerEvent('pointerdown', {bubbles:true})));
      const neutral = document.createElement('button'); document.body.append(neutral);
      const target = place === 'header' ? header : neutral;
      await act(async()=>target.dispatchEvent(new window.KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true})));
      await settle(); await key('c'); assert.equal(clipboard, all, place); neutral.remove();
    }
    assert.equal(mutationCalls().length, 0, 'selection never mutates cells');
  });
  await check('Select All retains current cell and scroll; Enter continues from current row',async()=>{
    await reset();await select(2,'power');const activeCell=selected();const grid=host.querySelector('.rdg');const top=grid.scrollTop,left=grid.scrollLeft;
    await key('a');assert.ok(selected()===activeCell, "active cell retained");assert.equal(grid.scrollTop,top);assert.equal(grid.scrollLeft,left);
    await key('Enter',selected(),{ctrlKey:false});assert.ok(selected()===cell(3,'power'), 'Enter advances from retained current row');
  });
  await check('End mode consumes one arrow and cancels on Escape, focus and pointer actions',async()=>{
    await reset();await select(0,'rarity');
    await key('End',selected(),{ctrlKey:false});assert(host.querySelector('[data-end-mode]'));
    await key('ArrowDown',selected(),{ctrlKey:false});assert.ok(selected()===cell(3,'rarity'));assert(!host.querySelector('[data-end-mode]'));
    await key('ArrowUp',selected(),{ctrlKey:false});assert.ok(selected()===cell(2,'rarity'));
    await key('End',selected(),{ctrlKey:false});await key('Escape',selected(),{ctrlKey:false});assert(!host.querySelector('[data-end-mode]'));
    await key('End',selected(),{ctrlKey:false});
    await act(async()=>host.querySelector('input').focus());assert(!host.querySelector('[data-end-mode]'));
    await select(1,'rarity');await key('End',selected(),{ctrlKey:false});
    await act(async()=>document.body.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));assert(!host.querySelector('[data-end-mode]'));
    await key('End',selected(),{ctrlKey:false});
    const modal=document.createElement('div');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
    await act(async()=>{document.body.append(modal);await new Promise(resolve=>setTimeout(resolve,10));});assert(!host.querySelector('[data-end-mode]'));
    modal.remove();await key('End',selected(),{ctrlKey:false});assert(host.querySelector('[data-end-mode]'));
    await key('a');assert(!host.querySelector('[data-end-mode]'));
    await key('End',selected(),{ctrlKey:false});await reset();assert(!host.querySelector('[data-end-mode]'));
  });
  await check('End Shift Arrow and Shift End Arrow extend selection in actual key order',async()=>{
    for(const shiftFirst of [false,true]) {
      await reset();await select(0,'rarity');
      if(shiftFirst)await key('Shift',selected(),{ctrlKey:false,shiftKey:true});
      await key('End',selected(),{ctrlKey:false,shiftKey:shiftFirst});
      if(!shiftFirst)await key('Shift',selected(),{ctrlKey:false,shiftKey:true});
      assert(host.querySelector('[data-end-mode]'));
      await key('ArrowDown',selected(),{ctrlKey:false,shiftKey:true});assert(!host.querySelector('[data-end-mode]'));
      await key('c');assert.equal(clipboard,'1\n5\n9\n12');
    }
  });
  await check('IME legacy keyCode 229 blocks outer D/R/X/Z without changes',async()=>{
    await reset();await select(1,'power');await select(2,'power',true);const previous=clone(table), count=mutationCalls().length,copied=writes.length;
    for(const value of ['d','r','x','z'])await key(value,selected(),{isComposing:false,keyCode:229});
    assert.deepEqual(table,previous);assert.equal(history.length,0);assert.equal(mutationCalls().length,count);assert.equal(writes.length,copied);
  });
  await check('Ctrl+Enter applies current raw value to the range in one undoable transaction',async()=>{
    await reset();await select(2,'power');await select(1,'power',true);
    await key('Enter');assert.equal(target().values.power,formula);assert.equal(history.length,1);
    assert.equal(mutationCalls().at(-1).args.request.cells.length,2);
    await key('z');assert.equal(target().values.power,'');assert.equal(source().values.power,formula);
    await reset(value=>{value.schema.columns.find(c=>c.data_name==='power').read_only=true;});
    await select(2,'power');await select(1,'power',true);await key('Enter');assert.equal(history.length,0);
  });
  await check('Edited Ctrl+Enter fills the retained range from the draft with a single commit',async()=>{
    await reset();await select(2,'note');await select(1,'note',true);
    await key('F2',selected(),{ctrlKey:false});
    const input=host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea');assert(input);
    await act(async()=>{Object.getOwnPropertyDescriptor(input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,'value').set.call(input,'bulk draft');input.dispatchEvent(new window.Event('input',{bubbles:true}));});await settle();
    await key('Enter',input);assert.equal(source().values.note,'bulk draft');assert.equal(target().values.note,'bulk draft');assert.equal(history.length,1);assert(!host.querySelector('.rdg-editor-container'));
    await key('z');assert.equal(source().values.note,'source note');assert.equal(target().values.note,'target note');
  });
  await check('Rejected edited bulk input keeps draft and all prior values without history',async()=>{
    await reset();await select(2,'note');await select(1,'note',true);await key('F2',selected(),{ctrlKey:false});
    const input=host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea');assert(input);
    await act(async()=>{Object.getOwnPropertyDescriptor(input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,'value').set.call(input,'rejected draft');input.dispatchEvent(new window.Event('input',{bubbles:true}));});await settle();
    rejectMutation=true;await key('Enter',input);
    assert.equal(source().values.note,'source note');assert.equal(target().values.note,'target note');assert.equal(history.length,0);
    const retained=host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea');assert(retained);assert.equal(retained.value,'rejected draft');
    rejectMutation=false;await key('Enter',retained);assert.equal(target().values.note,'rejected draft');assert.equal(history.length,1);
  });
  await check('Explicit save flushes one inline draft and rejected flush preserves it',async()=>{
    await reset();await select(1,'note');await key('F2',selected(),{ctrlKey:false});
    const input=host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea');assert(input);
    await act(async()=>{Object.getOwnPropertyDescriptor(input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,'value').set.call(input,'save draft');input.dispatchEvent(new window.Event('input',{bubbles:true}));});await settle();
    rejectMutation=true;let saved;await act(async()=>{saved=await flushProjectSaveParticipants(session);});await settle();assert.equal(saved,false);assert.equal(history.length,0);
    assert.equal(host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea')?.value,'save draft');
    rejectMutation=false;await act(async()=>{saved=await flushProjectSaveParticipants(session);});await settle();assert.equal(saved,true);assert.equal(source().values.note,'save draft');assert.equal(history.length,1);assert(!host.querySelector('.rdg-editor-container'));
  });
  await check('Structural shortcuts require explicit axis and row operations commit atomically',async()=>{
    await reset();await select(1,'power');await key('-');assert.equal(history.length,0,'ordinary rectangle never implies row deletion');
    await key(' ',selected(),{ctrlKey:false,shiftKey:true});await key('+',selected(),{shiftKey:true});
    assert.equal(table.records.length,5);assert.equal(table.records[2].uuid,'record-source');assert.equal(history.length,1);
    await key('z');assert.equal(table.records.length,4);
    await select(1,'power');await key(' ',selected(),{ctrlKey:false,shiftKey:true});await key('-');
    assert.equal(table.records.length,3);assert(!table.records.some(record=>record.uuid==='record-source'));assert.equal(history.length,1);
    await key('z');assert.equal(table.records.length,4);
    await reset(value=>{value.metadata.edit_permissions.delete_rows=false;});await select(1,'power');await key(' ',selected(),{ctrlKey:false,shiftKey:true});await key('-');assert.equal(history.length,0);
  });
  await check('Ctrl+F targets this table search; input Ctrl+A remains native; Menu opens current cell actions',async()=>{
    await reset();await select(1,'power');await key('f');
    const input=host.querySelector('[data-table-search]');assert.ok(document.activeElement===input);
    const native=await key('a',input);assert.equal(native.defaultPrevented,false);
    await select(1,'power');const menu=await key('F10',selected(),{ctrlKey:false,shiftKey:true});assert(menu.defaultPrevented);assert(host.querySelector('[role="menu"]'));
    await key('Escape',host.querySelector('[role="menu"]'),{ctrlKey:false});assert(!host.querySelector('[role="menu"]'));
  });
  await check('Ctrl+D fills raw formulas in one undoable transaction; Ctrl+R fills from left',async()=>{
    await reset();await select(1,'power');await select(2,'power',true);await key('d');assert.equal(target().values.power,formula);assert.equal(history.length,1);
    await key('z');assert.equal(target().values.power,'');await key('y');assert.equal(target().values.power,formula);
    await reset();await select(1,'rarity');await select(1,'power',true);await key('r');assert.equal(source().values.power,'5');assert.equal(history.length,1);
    await reset(value=>{value.metadata.edit_permissions.edit_cells=false;});await select(1,'power');await select(2,'power',true);await key('d');assert.equal(target().values.power,'');assert.equal(history.length,0);
  });
  await check('F4 repeats successful semantic input on fresh selection; failed operations and IME do not replace it',async()=>{
    await reset();await select(2,'note');await select(1,'note',true);await key('Enter');assert.equal(history.length,1);
    await select(0,'note');await key('F4',selected(),{ctrlKey:false});assert.equal(table.records[0].values.note,'source note');assert.equal(history.length,2);
    rejectMutation=true;await select(1,'rarity');await key('Enter');rejectMutation=false;
    await select(3,'note');const before=history.length;
    await key('F4',selected(),{ctrlKey:false,keyCode:229});assert.equal(history.length,before);
    await key('F4',selected(),{ctrlKey:false});assert.equal(table.records[3].values.note,'source note');
    await key('z');const afterUndo=clone(table);await select(0,'power');await key('F4',selected(),{ctrlKey:false});assert.deepEqual(table,afterUndo,'Undo invalidates repeat');
    await reset();await select(2,'note');await key('F4',selected(),{ctrlKey:false});assert.equal(history.length,0,'remount clears repeat descriptor');
  });
  await check('Successful ordinary edit replaces older destructive F4 with its raw input',async()=>{
    await reset();await select(1,'note');await key('Delete',selected(),{ctrlKey:false});assert.equal(source().values.note,undefined);
    await select(2,'note');await key('F2',selected(),{ctrlKey:false});const input=host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea');assert(input);
    await act(async()=>{Object.getOwnPropertyDescriptor(input instanceof window.HTMLTextAreaElement?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype,'value').set.call(input,'ordinary edit');input.dispatchEvent(new window.Event('input',{bubbles:true}));});await settle();
    await key('Enter',input,{ctrlKey:false});assert.equal(target().values.note,'ordinary edit');
    await select(0,'note');await key('F4',selected(),{ctrlKey:false});assert.equal(table.records[0].values.note,'ordinary edit');assert.equal(source().values.note,undefined);
  });
  await check('Column filter keys open the selected column and never escape native input or IME',async()=>{
    await reset();await select(1,'power');
    const trigger=host.querySelector('[data-filter-column="column-power"]');assert(trigger);
    let opens=0;trigger.addEventListener('click',()=>opens++);
    await key('l',selected(),{shiftKey:true});assert.equal(opens,1);
    const popup=document.querySelector('[role="dialog"]');if(popup)await key('Escape',popup,{ctrlKey:false});await settle();
    await select(1,'power');await key('ArrowDown',selected(),{ctrlKey:false,altKey:true});assert.equal(opens,2);
    const nextPopup=document.querySelector('[role="dialog"]');if(nextPopup)await key('Escape',nextPopup,{ctrlKey:false});await settle();
    await select(1,'power');await key('l',selected(),{shiftKey:true,keyCode:229});assert.equal(opens,2);
    const input=host.querySelector('[data-table-search]');await act(async()=>input.focus());await key('ArrowDown',input,{ctrlKey:false,altKey:true});assert.equal(opens,2);
  });
  await check('Command dialogs retain IME drafts on Escape and never submit composition Enter',async()=>{
    for(const command of ['g','h','v']) {
      await reset();await select(1,'note');await key(command,selected(),command==='v'?{altKey:true}:{});
      const dialog=document.querySelector('[role="dialog"]');assert(dialog);const input=dialog.querySelector('input,textarea');assert(input);
      for(const flags of [{isComposing:true},{keyCode:229}]) {
        await key('Escape',input,{ctrlKey:false,...flags});assert(document.querySelector('[role="dialog"]'),'composition escape remains open');
        const event=await key('Enter',input,{ctrlKey:false,...flags});assert(event.defaultPrevented);assert.equal(history.length,0);
      }
      await act(async()=>input.dispatchEvent(new window.Event('compositionstart',{bubbles:true})));
      await act(async()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
      assert(document.querySelector('[role="dialog"]'));assert.equal(history.length,0);
      await key('Escape',input,{ctrlKey:false});assert(document.querySelector('[role="dialog"]'));
      await act(async()=>input.dispatchEvent(new window.Event('compositionend',{bubbles:true})));
      await key('Escape',input,{ctrlKey:false});assert(!document.querySelector('[role="dialog"]'));
    }
  });
  await check('Current region and corner cycling preserve selection and current-cell reveal is nonmutating',async()=>{
    await reset();await select(1,'note');const original=selected();
    await key('*',selected(),{shiftKey:true});assert.equal(selected(),original);
    const selectedCount=host.querySelectorAll('[aria-selected="true"]').length;assert(selectedCount>1);
    const positions=[];for(let i=0;i<4;i++){await key('.');positions.push([selected().getAttribute('aria-colindex'),selected().closest('[role="row"]').getAttribute('aria-rowindex')].join(':'));}
    assert.equal(new Set(positions).size,4);assert.equal(host.querySelectorAll('[aria-selected="true"]').length,selectedCount);
    const before=clone(table);await key('Backspace');assert.deepEqual(table,before);assert.equal(history.length,0);
    await key('*',selected(),{shiftKey:true,keyCode:229});assert.deepEqual(table,before);
  });
  await check('Corner cycling preserves parent copy and mutation targets with one undo',async()=>{
    for (const turns of [1,2,3,4]) {
      await reset();await select(1,'rarity');await select(2,'power',true);
      const before=clone(table);await key('c');const expectedClipboard=clipboard;
      const expectedTargets=['record-source:column-rarity','record-source:column-power',
        'record-target:column-rarity','record-target:column-power'].sort();
      for(let i=0;i<turns;i++)await key('.');
      await key('c');assert.equal(clipboard,expectedClipboard,`corner ${turns} copy rectangle`);
      await key('Delete',selected(),{ctrlKey:false});
      assert.deepEqual(mutationCalls().at(-1).args.request.cells.map(c=>`${c.record_uuid}:${c.column_uuid}`).sort(),expectedTargets);
      assert.equal(history.length,1);await key('z');assert.deepEqual(table,before);
    }
  });
  await check('Current region stops at empty rows/columns and preserves sparse holes in either orientation',async()=>{
    for(const transposed of [false,true]) {
      await reset(data=>{
        data.metadata.initial_transposed=transposed;
        data.schema.columns=data.schema.columns.map(c=>({...c,data_type:'String',default_value:'',interface_origin:undefined}));
        for(const record of data.records){record.values={};record.interface_values={};}
        data.records[0].values={name:'a'};
        data.records[1].values={name:'b',rarity:'c'};
        data.records[3].values={name:'isolated after blank row',note:'isolated after blank column'};
      });
      const start=host.querySelector('[role="row"][aria-rowindex="2"] [role="gridcell"][aria-colindex="2"]');assert(start);
      await act(async()=>start.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,buttons:1})));await settle();
      const mutationsBefore=mutationCalls().length;
      await key('*',selected(),{shiftKey:true});await key('c');
      assert.deepEqual(parseClipboardTsv(clipboard),transposed?[['a','b'],['','c']]:[['a',''],['b','c']]);
      assert.equal(mutationCalls().length,mutationsBefore);
    }
  });
  await check('Go To uses visible coordinates; replace previews selected raw cells and commits one undo',async()=>{
    await reset();await select(1,'power');await key('g');
    let dialog=document.querySelector('[role="dialog"]');assert(dialog);
    const inputs=dialog.querySelectorAll('input');assert.equal(inputs.length,2);
    const inputValue=async(input,value)=>{await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}));});await settle();};
    await inputValue(inputs[0],'3');await inputValue(inputs[1],'2');
    await act(async()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await settle();
    assert(!document.querySelector('[role="dialog"]'));assert.equal(selected().getAttribute('aria-colindex'),'3');
    await select(2,'note');await select(1,'note',true);await key('h');dialog=document.querySelector('[role="dialog"]');assert(dialog);
    const replaceInputs=dialog.querySelectorAll('input');await inputValue(replaceInputs[0],'note');await inputValue(replaceInputs[1],'memo');
    assert.match(dialog.textContent,/2/);
    await act(async()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await settle();
    assert.equal(source().values.note,'source memo');assert.equal(target().values.note,'target memo');assert.equal(history.length,1);
    await key('z');assert.equal(source().values.note,'source note');assert.equal(target().values.note,'target note');
  });
  await check('Paste Special uses actual clipboard formats; rejects overflow and supports same-type copied values',async()=>{
    await reset();await select(2,'power');await key('v',selected(),{altKey:true});
    let dialog=document.querySelector('[role="dialog"]');assert(dialog);
    await paste('15',dialog.querySelector('textarea'));assert.equal(dialog.querySelectorAll('input[type="radio"]').length,1);
    await act(async()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await settle();
    assert.equal(target().values.power,'15');assert.equal(history.length,1);await key('z');
    await select(2,'power');await key('v',selected(),{altKey:true});dialog=document.querySelector('[role="dialog"]');
    const payload={text:'=7+8',cells:[[{raw:'=7+8',value:'15',type:'I32'}]]};
    const html='<!--devcel-cells-v1:'+Buffer.from(JSON.stringify(payload)).toString('base64')+'-->';
    await paste(payload.text,dialog.querySelector('textarea'),html);assert.equal(dialog.querySelectorAll('input[type="radio"]').length,2);
    await act(async()=>dialog.querySelectorAll('input[type="radio"]')[1].click());
    await act(async()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await settle();
    assert.equal(target().values.power,'15');assert.equal(history.length,1);
  });
  await check('Replace visible scope excludes filtered rows and native refusal preserves the whole batch',async()=>{
    await reset();await filter('target');await select(0,'note');await key('h');let dialog=document.querySelector('[role="dialog"]');assert(dialog);
    const inputs=dialog.querySelectorAll('input');
    for(const [input,value] of [[inputs[0],'note'],[inputs[1],'changed']]){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}));});await settle();}
    await act(async()=>{const select=dialog.querySelector('select');select.value='visible';select.dispatchEvent(new window.Event('change',{bubbles:true}));});
    rejectMutation=true;const before=clone(table);await act(async()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await settle();assert.deepEqual(table,before);assert.equal(history.length,0);assert(document.querySelector('[role="dialog"]'));
    rejectMutation=false;await act(async()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));await settle();
    assert.equal(target().values.note,'target changed');assert.equal(source().values.note,'source note');assert.equal(history.length,1);
  });
  await check('Sparse plain String presentation opens exact raw input by button and Ctrl+Shift+Enter', async () => {
    await reset(() => { omittedCells.add('record-source:column-note'); });
    await select(1, 'note'); await key('Enter',selected(),{shiftKey:true});
    assert.equal(expandedRequests.length, 1); assert.equal(expandedRequests[0].target.value, 'source note');
    assert.equal(expandedRequests[0].target.recordUuid, 'record-source'); assert.equal(expandedRequests[0].target.columnUuid, 'column-note');
    assert.equal(expandedRequests[0].target.revision, '1'); assert.equal(expandedRequests[0].projectSessionId, session);
    await act(async () => cell(1, 'note').querySelector('.rdg-string-expand').click()); await settle(); assert.equal(expandedRequests.length, 2);
    await reset(data => { data.schema.columns.find(c => c.data_name === 'note').default_value = 'inherited\ntext'; data.records[1].values.note = ''; omittedCells.add('record-source:column-note'); });
    await select(1, 'note'); await key('Enter',selected(),{shiftKey:true}); assert.equal(expandedRequests[0].target.value, '', 'inherited defaults are not materialized');
    await reset(data => { const definition = data.schema.columns.find(c => c.data_name === 'note'); definition.interface_origin = 'stats'; data.records[1].interface_values[definition.uuid] = 'interface\r\nraw'; omittedCells.add('record-source:column-note'); });
    await select(1, 'note'); await key('Enter',selected(),{shiftKey:true}); assert.equal(expandedRequests[0].target.value, 'interface\r\nraw');
  });
  await check('Delete and Backspace reset selected overrides to inherit in one undoable request', async () => {
    for (const keyName of ['Delete', 'Backspace']) {
      await reset(data => { data.records[1].parent_uuid = data.records[0].uuid; });
      const original = clone(table); await select(1, 'note'); await select(2, 'note', true);
      const count = mutationCalls().length; await key(keyName, selected(), {ctrlKey:false});
      assert.equal(mutationCalls().length, count + 1);
      assert.deepEqual(mutationCalls().at(-1).args.request.cells, [
        {record_uuid:'record-source',column_uuid:'column-note',value:''},
        {record_uuid:'record-target',column_uuid:'column-note',value:''}]);
      assert.equal(source().values.note, undefined); assert.equal(source().values.note, undefined);
      await key('z'); assert.deepEqual(table, original); await key('y'); assert.equal(source().values.note, undefined);
    }
  });
  await check('Cut and quoted empty paste both remove the override', async () => {
    await reset(data => {data.records[1].parent_uuid=data.records[0].uuid; data.records[1].values.note='';});
    await select(1,'note'); await key('x'); assert.equal(clipboard,''); assert.equal(source().values.note, undefined); assert.equal(source().values.note,undefined);
    await paste('""'); assert.equal(source().values.note,undefined);
  });
  await check('Ctrl+C preserves the formula; Copy values keeps the displayed result', async () => {
    await reset(); await select(1, 'power'); assert.equal(cell(1, 'power').textContent, '75'); const count = mutationCalls().length;
    await key('c'); assert.equal(clipboard, encodedFormula); assert.equal(mutationCalls().length, count); assert.equal(source().values.power, formula);
    await act(async () => cell(1, 'power').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })));
    const inheritMenu = [...document.querySelectorAll('[role=menuitem]')].find(button => button.textContent === t('metadata.empty')); assert(inheritMenu); assert.equal(inheritMenu.disabled, false, 'parentless records can clear their override');
    const copyValues = [...document.querySelectorAll('[role=menuitem]')].find(button => button.textContent === t('metadata.copyValues')); assert(copyValues);
    await act(async () => copyValues.click()); assert.equal(clipboard, '75');
  });
  await check('Ctrl+X and native paste preserve explicit LOOKUP expression and row-relative rarity', async () => {
    await reset(); await select(1, 'power'); await key('x'); assert.equal(clipboard, encodedFormula); assert.equal(source().values.power, undefined);
    await select(2, 'power'); await paste(); assert.equal(target().values.power, formula); assert.equal(cell(2, 'power').textContent, '79');
    await select(2, 'rarity'); await paste('11'); assert.equal(target().values.power, formula); assert.equal(cell(2, 'power').textContent, '81');
  });
  await check('Undo/Redo restores actual cut and paste snapshots without materializing formulas', async () => {
    await reset(); await select(1, 'power'); await key('x'); await select(2, 'power'); await paste();
    await key('z'); assert.equal(source().values.power, undefined); assert.equal(target().values.power, '');
    await key('z'); assert.equal(source().values.power, formula); assert.equal(target().values.power, '');
    await key('y'); assert.equal(source().values.power, undefined); await key('y'); assert.equal(target().values.power, formula); assert.equal(cell(2, 'power').textContent, '79');
  });
  await check('Filtered cut/paste uses record UUIDs rather than unfiltered row indexes', async () => {
    await reset(); await filter('source'); assert.equal(host.querySelector('.rdg').getAttribute('aria-rowcount'), '2');
    await select(0, 'power'); await key('x'); assert.equal(clipboard, encodedFormula); assert.equal(source().values.power, undefined); assert.equal(table.records[0].values.power, '');
    await filter('target'); await select(0, 'power'); await paste(); assert.equal(target().values.power, formula); assert.equal(cell(0, 'power').textContent, '79');
    assert.deepEqual(mutationCalls().at(-2).args.request.cells, [{ record_uuid: 'record-source', column_uuid: 'column-power', value: '' }]);
  });
  await check('Ordinary raw-value fallback reads values by data_name when presentation raw is absent', async () => {
    await reset(() => { omittedRaw.add('record-source:column-power'); });
    await select(1, 'power'); assert.equal(cell(1, 'power').textContent, '75'); await key('x'); assert.equal(clipboard, encodedFormula); assert.equal(source().values.power, undefined);
    await select(2, 'power'); await paste(); assert.equal(target().values.power, formula); assert.equal(cell(2, 'power').textContent, '79');
  });
  await check('Interface raw-value fallback reads interface_values by column UUID', async () => {
    await reset(() => { omittedRaw.add('record-source:column-interface_power'); });
    await select(1, 'interface_power'); assert.equal(cell(1, 'interface_power').textContent, '75'); await key('x'); assert.equal(clipboard, encodedFormula); assert.equal(source().interface_values['column-interface_power'], undefined);
    await select(2, 'interface_power'); await paste(); assert.equal(target().interface_values['column-interface_power'], formula); assert.equal(cell(2, 'interface_power').textContent, '79');
  });
  await check('Empty raw input never materializes a default formula; empty paste remains no-op', async () => {
    await reset(); const original = clone(table), beforeCut = mutationCalls().length; await select(1, 'default_power'); assert.equal(cell(1, 'default_power').textContent, '15');
    await key('x'); assert.equal(clipboard, ''); assert.equal(mutationCalls().length, beforeCut + 1); assert.equal(source().values.default_power, undefined); assert.equal(source().values.default_power, undefined); assert.equal(history.length, 1); const cleared = clone(table);
    const count = mutationCalls().length; await select(2, 'default_power'); await paste(); assert.equal(mutationCalls().length, count); assert.deepEqual(table, cleared);
  });
  await check('Clipboard write failure never clears the selected input', async () => {
    await reset(); await select(1, 'power'); clipboardFailure = true; const count = mutationCalls().length; await key('x'); clipboardFailure = false;
    assert.equal(mutationCalls().length, count); assert.equal(source().values.power, formula); assert.equal(clipboard, 'original clipboard'); assert(host.querySelector('[role="alert"]').textContent.includes('clipboard unavailable'));
  });
  await check('Pending clipboard completion cannot mutate a replacement project session', async () => {
    await reset(); await select(1, 'power'); clipboardDelay = deferred(); const pending = clipboardDelay; const count = mutationCalls().length; await key('x');
    session += '-replaced'; incoming = clone(table); await render(); clipboardDelay = null; await act(async () => pending.resolve()); await settle();
    assert.equal(mutationCalls().length, count); assert.equal(source().values.power, formula);
  });
  await check('A revision change during clipboard I/O rejects the stale clear without rebasing', async () => {
    await reset(); await select(1, 'power'); clipboardDelay = deferred(); const pending = clipboardDelay; const count = mutationCalls().length, displayedRevision = String(revision); await key('x');
    // Simulate another editor committing after the clipboard operation started.
    table.records[0].values.note = 'concurrent edit'; revision++;
    clipboardDelay = null; await act(async () => pending.resolve()); await settle();
    assert.equal(mutationCalls().length, count + 1); assert.equal(mutationCalls().at(-1).args.request.expected_revision, displayedRevision);
    assert.equal(clipboard, encodedFormula); assert.equal(source().values.power, formula); assert.equal(table.records[0].values.note, 'concurrent edit'); assert.equal(history.length, 0);
    assert(host.querySelector('[role="alert"]').textContent.includes('stale mutation rejected'));
  });
  await check('Selection changes during clipboard I/O retain the original cut snapshot', async () => {
    await reset(); await select(1, 'power'); clipboardDelay = deferred(); const pending = clipboardDelay; await key('x'); await select(2, 'note');
    clipboardDelay = null; await act(async () => pending.resolve()); await settle();
    assert.equal(clipboard, encodedFormula); assert.equal(source().values.power, undefined); assert.equal(target().values.note, 'target note');
    assert.deepEqual(mutationCalls().at(-1).args.request.cells, [{ record_uuid: 'record-source', column_uuid: 'column-power', value: '' }]);
  });
  await check('Quoted TSV parser preserves delimiters, quotes, blank records and exact embedded line endings', async () => {
    assert.deepEqual(parseClipboardTsv(''), []);
    assert.deepEqual(parseClipboardTsv('a\tb\r\nc\td\r\n'), [['a', 'b'], ['c', 'd']]);
    assert.deepEqual(parseClipboardTsv('a\tb\rc\td\r'), [['a', 'b'], ['c', 'd']]);
    assert.deepEqual(parseClipboardTsv('"a\r\nb\rc\nd"\t"two\tfields"\r\n'), [['a\r\nb\rc\nd', 'two\tfields']]);
    assert.deepEqual(parseClipboardTsv('""\t""\n""\t""\n'), [['', ''], ['', '']]);
    assert.deepEqual(parseClipboardTsv('\n\n'), [[''], ['']]);
    assert.deepEqual(parseClipboardTsv('a\t'), [['a', '']]);
    assert.deepEqual(parseClipboardTsv(formula), [[formula]], 'existing unquoted formulas keep their quotes');
    assert.deepEqual(parseClipboardTsv('say "hello"'), [['say "hello"']], 'ordinary embedded quotes stay literal');
    assert.deepEqual(parseClipboardTsv('"""literal"""'), [['"literal"']]);
    assert.deepEqual(parseClipboardTsv('"=rarity*3"'), [['=rarity*3']], 'TSV quoting does not introduce a literal formula escape');
    for (const invalid of ['"unfinished', '"a"tail', '"a" ', '"a""', 'a\tb\nc', 'a\nb\tc']) assert.equal(parseClipboardTsv(invalid), null, invalid);
    // Exercise the real codec with short delimiter-heavy inputs; only the selected
    // rectangle is serialized, and no application dataset is involved.
    let strings = [''];
    for (let length = 0; length < 4; length++) strings = strings.concat(strings.filter(s => s.length === length).flatMap(s => ['a', '"', '\t', '\r', '\n'].map(c => s + c)));
    for (const value of strings) {
      const matrix = [[value, ''], ['"quoted"', value]];
      assert.deepEqual(parseClipboardTsv(serializeClipboardTsv(matrix)), matrix);
    }
    assert.deepEqual(parseClipboardTsv(serializeClipboardTsv([['first'], ['']])), [['first'], ['']]);
    assert.equal(serializeClipboardTsv([['']]), '', 'single empty copy retains the existing no-op contract');
  });
  for (const [label, input, expected] of [
    ['tab', 'two\tfields', '"two\tfields"'], ['LF', 'two\nlines', '"two\nlines"'],
    ['CR', 'two\rlines', '"two\rlines"'], ['CRLF', 'two\r\nlines', '"two\r\nlines"'],
    ['quotes', '"hello"', '"""hello"""'], ['trailing LF', 'last line\n', '"last line\n"']
  ]) {
    await check(`${label} input copy/cut/paste preserves a single cell and supports Undo/Redo`, async () => {
      await reset(table => { table.records[1].values.note = input; }); await select(1, 'note'); const count = mutationCalls().length;
      await key('c'); assert.equal(clipboard, expected); assert.equal(mutationCalls().length, count); assert.equal(source().values.note, input);
      await select(2, 'note'); await paste(); assert.equal(target().values.note, input); assert.equal(table.records[3].values.note, 'last note');
      await key('z'); assert.equal(target().values.note, 'target note');
      await select(1, 'note'); await key('x'); assert.equal(clipboard, expected); assert.equal(source().values.note, undefined);
      await select(2, 'note'); await paste(); assert.equal(target().values.note, input);
      await key('z'); assert.equal(target().values.note, 'target note'); await key('z'); assert.equal(source().values.note, input);
      await key('y'); assert.equal(source().values.note, undefined); await key('y'); assert.equal(target().values.note, input);
    });
  }
  await check('Quoted mixed multiline rectangle preserves order, UUIDs, empty cells and literal equals semantics', async () => {
    const matrix = [['first\r\nsecond', '"literal"\twith tab'], ['=rarity*3', '']];
    await reset(table => {
      table.schema.columns[1].data_type = 'String';
      table.records[1].values.name = matrix[0][0]; table.records[1].values.rarity = matrix[0][1];
      table.records[2].values.name = matrix[1][0]; table.records[2].values.rarity = matrix[1][1];
    });
    await select(2, 'rarity'); await select(1, 'name', true); await key('x');
    assert.equal(clipboard, '"first\r\nsecond"\t"""literal""\twith tab"\n=rarity*3\t');
    await select(2, 'name'); await paste();
    assert.deepEqual([target(), table.records[3]].map(r => [r.values.name, r.values.rarity]), matrix.map(row => row.map(value => value === '' ? undefined : value)));
    assert.deepEqual(mutationCalls().at(-1).args.request.cells.map(c => [c.record_uuid, c.column_uuid]), [
      ['record-target', 'column-name'], ['record-target', 'column-rarity'], ['record-last', 'column-name'], ['record-last', 'column-rarity']
    ]);
  });
  await check('Malformed quotes and ragged TSV never alter data, clipboard, history or partially submit a patch', async () => {
    for (const invalid of ['"unfinished', '"valid"tail', '"valid" ', '"a""', 'a\tb\nc', 'a\nb\tc']) {
      await reset(); await select(1, 'name'); const original = clone(table), count = mutationCalls().length, copied = writes.length;
      await paste(invalid); assert.deepEqual(table, original); assert.equal(mutationCalls().length, count); assert.equal(writes.length, copied); assert.equal(clipboard, 'original clipboard'); assert.equal(history.length, 0);
      assert.notEqual(t('grid.invalidClipboardText'), '[grid.invalidClipboardText]');
      assert(host.querySelector('[role="alert"]').textContent.includes(t('grid.invalidClipboardText')));
    }
  });
  await check('Multiline paste beyond visible rows or columns rejects the entire patch', async () => {
    for (const [row, text, error] of [[3, '"two\nlines"\nsecond', 'grid.pasteExceedsRows'], [1, '"two\nlines"\tsecond', 'grid.pasteExceedsColumns']]) {
      await reset(); await select(row, 'note'); const original = clone(table), count = mutationCalls().length;
      await paste(text); assert.deepEqual(table, original); assert.equal(mutationCalls().length, count); assert.equal(history.length, 0);
      assert(host.querySelector('[role="alert"]').textContent.includes(t(error)));
    }
  });
  await check('Explicit quoted empty paste clears one input while a plain empty clipboard stays a no-op', async () => {
    await reset(); await select(1, 'note'); const count = mutationCalls().length;
    await paste(''); assert.equal(mutationCalls().length, count); assert.equal(source().values.note, 'source note');
    await paste('""'); assert.equal(source().values.note, undefined); assert.equal(mutationCalls().length, count + 1);
  });
  await check('Copy of a final empty displayed row preserves the same rectangle on paste', async () => {
    await reset(table => { table.records[1].values.note = 'one\ncell'; table.records[2].values.note = ''; });
    await select(1, 'note'); await select(2, 'note', true); await key('c'); assert.equal(clipboard, '"one\ncell"\n\n');
    await select(2, 'note'); await paste(); assert.equal(target().values.note, 'one\ncell'); assert.equal(table.records[3].values.note, undefined);
  });
  await check('A two-column rectangle preserves formula order, ownership and empty final cells', async () => {
    await reset(table => { table.records[3].values.power = '777'; table.records[3].interface_values['column-interface_power'] = '888'; });
    await select(1, 'power'); await select(2, 'interface_power', true); await key('x');
    assert.equal(clipboard, encodedFormula + '\t' + encodedFormula + '\n\t');
    assert.deepEqual(mutationCalls().at(-1).args.request.cells.map(patch => [patch.record_uuid, patch.column_uuid]), [
      ['record-source', 'column-power'], ['record-source', 'column-interface_power'],
      ['record-target', 'column-power'], ['record-target', 'column-interface_power']
    ]);
    await select(2, 'power'); await paste();
    assert.equal(target().values.power, formula); assert.equal(target().interface_values['column-interface_power'], formula);
    assert.equal(table.records[3].values.power, undefined); assert.equal(table.records[3].interface_values['column-interface_power'], undefined);
  });
  await check('A reversed multirow cut preserves the final empty row when pasted', async () => {
    await reset(table => { table.records[1].values.note = formula; table.records[2].values.note = ''; table.records[3].values.note = 'stale destination'; });
    await select(2, 'note'); await select(1, 'note', true); await key('x');
    assert.equal(clipboard, encodedFormula + '\n\n', 'extra line terminator preserves the final empty raw row');
    assert.deepEqual(mutationCalls().at(-1).args.request.cells, [
      { record_uuid: 'record-source', column_uuid: 'column-note', value: '' },
      { record_uuid: 'record-target', column_uuid: 'column-note', value: '' }
    ]);
    await select(2, 'note'); await paste();
    assert.equal(target().values.note, formula); assert.equal(table.records[3].values.note, undefined);
    assert.equal(cell(2, 'note').textContent, '79');
    assert.deepEqual(mutationCalls().at(-1).args.request.cells, [
      { record_uuid: 'record-target', column_uuid: 'column-note', value: formula },
      { record_uuid: 'record-last', column_uuid: 'column-note', value: '' }
    ]);
  });
  await check('Native cell-editor text input owns Ctrl+X without clearing the grid', async () => {
    await reset(); await select(1, 'note'); await act(async () => cell(1, 'note').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }))); await settle();
    const input = host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea'); assert(input, 'actual grid text editor opened'); const count = mutationCalls().length, copied = writes.length;
    const event = await key('x', input); assert.equal(event.defaultPrevented, false); assert.equal(mutationCalls().length, count); assert.equal(writes.length, copied); assert.equal(source().values.note, 'source note');
  });
  await check('Native cell-editor owns multiline paste without running grid clipboard decoding', async () => {
    await reset(); await select(1, 'note'); await act(async () => cell(1, 'note').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }))); await settle();
    const input = host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea'); assert(input);
    const original = clone(table), count = mutationCalls().length, copied = writes.length;
    const event = await paste('first\nsecond\tthird\r\n"quoted"', input);
    assert.equal(event.defaultPrevented, false, 'native editor paste is not intercepted');
    assert.deepEqual(table, original); assert.equal(mutationCalls().length, count); assert.equal(writes.length, copied);
    assert(!host.querySelector('[role="alert"]'));
  });
  await check('Mutation gate drops a second cut while the first clipboard write is pending', async () => {
    await reset(); await select(1, 'power'); clipboardDelay = deferred(); const pending = clipboardDelay; const count = mutationCalls().length, copied = writes.length;
    await key('x'); await key('x'); assert.equal(writes.length, copied + 1); assert.equal(mutationCalls().length, count);
    clipboardDelay = null; await act(async () => pending.resolve()); await settle(); assert.equal(mutationCalls().length, count + 1); assert.equal(clipboard, encodedFormula); assert.equal(source().values.power, undefined);
  });
  const report = { passed: reports.length, checks: reports, mutationCalls: mutationCalls().length, clipboardWrites: writes.length, scope: 'Real DataGridView/DataGrid, toolbar, localization and mutation/presentation hooks. Native IPC/history and formula presentations are explicit fixtures, browser clipboard and layout are synthetic; Rust evaluation and native WebKit are separate checks.' };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (root) await React.act(() => root.unmount());
  await window.happyDOM.close(); await rm(temporary, { recursive: true, force: true }); delete globalThis.__cutInputCheck;
}
