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
const temporary = await mkdtemp(resolve(project, '.filter-sort-integration-'));
// Point at a repository snapshot to run identical assertions against the old UI.
const before = process.env.CUT_INPUT_BEFORE;
const reports = [], calls = [], writes = [], expandedRequests = [];
const metrics = {};
let nextEvaluationId = 0;
const evaluations = new Map();
const formula = '=LOOKUP("materials","key","marsh_hide_t01","value")*2+rarity';
const encodedFormula = '"' + formula.replaceAll('"', '""') + '"';
const window = new Window({ url: 'http://cut-input.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'HTMLButtonElement', 'SVGElement', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver', 'CSS', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
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
      assert.deepEqual(evaluations.get(args.evaluationId), { tableUuid: args.tableUuid, session: args.expectedProjectSession }, 'snapshot uses its registered table/session request');
      evaluations.delete(args.evaluationId);
      return args.knownSnapshotToken === `${session}:${revision}`
        ? { kind: 'unchanged', snapshot_token: args.knownSnapshotToken, retained_bytes: 1024 }
        : { kind: 'snapshot', snapshot_token: `${session}:${revision}`, retained_bytes: 1024, ...snapshot() };
    }
    case 'apply_table_mutation': {
      const request = args.request;
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
    stdin: { contents: `export {default as DataGridView} from './src/app/pages/main_window/project_view/table_view/components/DataGridView'; export {t} from './src/app/i18n'; export {parseClipboardTsv, serializeClipboardTsv} from './src/app/pages/main_window/project_view/table_view/components/gridClipboard';`, resolveDir: project, loader: 'ts' },
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
  const { DataGridView, t, parseClipboardTsv, serializeClipboardTsv } = await import(pathToFileURL(modulePath));
  React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { DndProvider } = await import('react-dnd'); const { HTML5Backend } = await import('react-dnd-html5-backend');
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const act = React.act;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
  let mountId = 0, incoming, renderProps = {};
  const render = async () => { await act(async () => root.render(React.createElement(DndProvider, { backend: HTML5Backend }, React.createElement(DataGridView, { key: mountId, projectSessionId: session, tableName: 'equipment', tableData: incoming, ...renderProps })))); await settle(); };
  const reset = async (edit = () => {}) => {
    renderProps = {}; table = makeTable(); revision = 1; history = []; redoHistory = []; omittedCells = new Set(); expandedRequests.length = 0; omittedRaw = new Set(); clipboard = 'original clipboard'; clipboardFailure = false; clipboardDelay = null; session = `session-${++mountId}`;
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
  await check('Transpose 3 records x 2 fields becomes 2 x 3 and ON/OFF is JSON-byte invariant with zero native writes',async()=>{
    await reset(mini); const original=JSON.stringify(table), count=quietCount(); const beforeCommands=calls.length;
    assert.equal(host.querySelector('.rdg').getAttribute('aria-rowcount'),'4'); assert.equal(host.querySelector('.rdg').getAttribute('aria-colcount'),'3');
    await transpose(); assert(isTransposed()); assert.equal(host.querySelector('.rdg').getAttribute('aria-rowcount'),'3'); assert.equal(host.querySelector('.rdg').getAttribute('aria-colcount'),'4');
    assert.equal(viewCell(0,1).textContent,'source'); assert.equal(viewCell(1,2).textContent,'9');
    await transpose(); assert(!isTransposed()); await transpose(); await transpose(); assert.equal(JSON.stringify(table),original); assert.equal(quietCount(),count); assert.equal(calls.length,beforeCommands);
  });
  await check('Transposed normal text and formula editor commit the canonical record/column UUID and preserve raw input',async()=>{
    await reset(); await transpose(); let input=await vedit(5,1); assert.equal(input.value,'source note'); await inputValue(input,'edited note'); await key('Enter',input,{ctrlKey:false});
    assert.deepEqual(lastCells(),[{record_uuid:'record-source',column_uuid:'column-note',value:'edited note'}]); assert.equal(source().values.note,'edited note');
    input=await vedit(2,1); assert.equal(input.value,formula,'editor receives raw formula rather than computed 75'); await inputValue(input,'=rarity*3'); await key('Enter',input,{ctrlKey:false});
    assert.deepEqual(lastCells(),[{record_uuid:'record-source',column_uuid:'column-power',value:'=rarity*3'}]); assert.equal(viewCell(2,1).textContent,'15');
    await vselect(5,1); await key('Enter', selected(), {shiftKey:true}); assert.equal(expandedRequests.at(-1).target.recordUuid,'record-source'); assert.equal(expandedRequests.at(-1).target.columnUuid,'column-note'); assert.equal(expandedRequests.at(-1).target.value,'edited note');
  });
  await check('Boolean checkbox keeps original UUID orientation',async()=>{
    await reset(data=>{data.schema.columns[0].data_type='Boolean';data.records.forEach(r=>r.values.name='false');}); await transpose(); const check=viewCell(0,2).querySelector('input[type="checkbox"]'); assert(check); await act(async()=>check.click()); await settle();
    assert.deepEqual(lastCells(),[{record_uuid:'record-target',column_uuid:'column-name',value:'true'}]); assert.equal(table.records[2].values.name,'true'); assert.equal(table.records[0].values.name,'false');
  });
  await check('Reversed rectangular copy serializes display row direction and preserves formula inputs',async()=>{
    await reset(); await transpose(); const count=quietCount(); await vselect(2,2); await vselect(1,1,true); await key('c');
    assert.equal(clipboard,'5\t9\n'+encodedFormula+'\t'); assert.equal(quietCount(),count); assert.equal(source().values.power,formula);
  });
  await check('Rectangular paste and delete inverse-project every visible coordinate exactly once',async()=>{
    await reset(); await transpose(); await vselect(1,1); await paste('11\t12\n21\t22'); assert.deepEqual(lastCells(),[
      {record_uuid:'record-source',column_uuid:'column-rarity',value:'11'}, {record_uuid:'record-target',column_uuid:'column-rarity',value:'12'},
      {record_uuid:'record-source',column_uuid:'column-power',value:'21'}, {record_uuid:'record-target',column_uuid:'column-power',value:'22'}]);
    await vselect(2,2); await vselect(1,1,true); await key('Delete',selected(),{ctrlKey:false}); assert.equal(lastCells().length,4); assert(lastCells().every(p=>p.value==='' && !('mode' in p))); assert.equal(source().values.rarity,undefined); assert.equal(target().values.power,undefined);
  });
  await check('Cut uses displayed TSV orientation but raw formula values; undo and redo retain native commands/session',async()=>{
    await reset(); await transpose(); await vselect(2,1); await vselect(3,2,true); await key('x'); assert.equal(clipboard,encodedFormula+'\t\n'+encodedFormula+'\t');
    assert.deepEqual(lastCells().map(c=>[c.record_uuid,c.column_uuid]),[['record-source','column-power'],['record-target','column-power'],['record-source','column-interface_power'],['record-target','column-interface_power']]);
    await vselect(2,2); await paste(); assert.equal(target().values.power,formula); assert.equal(target().interface_values['column-interface_power'],formula);
    const historyStart = calls.length;
    await key('z'); assert.equal(target().values.power,undefined); await key('z'); assert.equal(source().values.power,formula);
    await key('y'); await key('y'); assert.equal(target().values.power,formula); assert(calls.filter(c=>['undo_command','redo_command'].includes(c.command)).every(c=>c.args.tableUuid==='equipment'&&c.args.expectedProjectSession===session));
    const timeline = calls.slice(historyStart).filter(c => ['undo_command', 'redo_command', 'save_project', 'prepare_table_rule_snapshot', 'get_table_rule_snapshot'].includes(c.command));
    metrics.historyTimeline = timeline.map(({ command, at, utc }) => ({ command, at, utc }));
    console.log('HISTORY_TIMELINE', JSON.stringify(metrics.historyTimeline));
    assert.equal(timeline.filter(c => c.command === 'save_project').length, 0, 'native history already atomically persists its shared-table batch; refresh must not wait for an unrelated project save');
    assert.equal(timeline.filter(c => c.command === 'get_table_rule_snapshot').length, 4, 'each completed history operation receives one authoritative refreshed display');
    assert.equal(viewCell(2, 2).textContent.trim(), '79', 'Redo commits the authoritative formula display, not only the mock stored value');
  });
  await check('Transposed bounds overflow in either dimension and malformed TSV reject atomically',async()=>{
    for(const [row,col,text] of [[5,1,'one\ntwo'],[1,3,'one\ttwo'],[1,1,'a\tb\nc']]){
      await reset(); await transpose(); await vselect(row,col); const original=JSON.stringify(table),count=quietCount(); await paste(text); assert.equal(JSON.stringify(table),original); assert.equal(quietCount(),count); assert.equal(history.length,0); assert(host.querySelector('[role="alert"]'));
    }
  });
  await check('Search remaps horizontal records by UUID before cut/paste',async()=>{
    await reset(); await transpose(); await filter('source'); assert.equal(host.querySelector('.rdg').getAttribute('aria-colcount'),'2'); await vselect(2,0); await key('x'); assert.equal(clipboard,encodedFormula); assert.equal(source().values.power,undefined);
    await filter('target'); await vselect(2,0); await paste(); assert.equal(target().values.power,formula); assert.deepEqual(lastCells(),[{record_uuid:'record-target',column_uuid:'column-power',value:formula}]);
  });
  await check('Transpose toggle preserves blocked raw editor draft and becomes available after Escape',async()=>{
    await reset(data=>{data.records[1].values.note='first\r\nsecond';}); await transpose(); const input=await vedit(5,1); await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,'uncommitted'); input.dispatchEvent(new window.InputEvent('input',{bubbles:true,inputType:'historyUndo'}));}); await settle(); assert.equal(input.getAttribute('data-rdg-editor-blocked'),'true'); const count=quietCount(); await transpose(); assert(isTransposed()); assert.equal(host.querySelector('.rdg-editor-container textarea').value,'uncommitted'); assert.equal(quietCount(),count);
    await key('Escape',input,{ctrlKey:false}); await transpose(); assert(!isTransposed()); assert.equal(source().values.note,'first\r\nsecond');
  });
  await check('Pending cut blocks toggling; delayed completion keeps captured UUID and replacement session cancels it',async()=>{
    await reset(); await transpose(); await vselect(2,1); clipboardDelay=deferred(); let pending=clipboardDelay; await key('x'); await transpose(); assert(isTransposed()); clipboardDelay=null; await act(async()=>pending.resolve()); await settle(); assert.equal(source().values.power,undefined); await transpose(); assert(!isTransposed());
    await reset(); await transpose(); await vselect(2,1); clipboardDelay=deferred(); pending=clipboardDelay; const count=quietCount(); await key('x'); session+='-replaced'; incoming=clone(table); await render(); clipboardDelay=null; await act(async()=>pending.resolve()); await settle(); assert.equal(quietCount(),count); assert.equal(source().values.power,formula);
  });
  await check('Concurrent revision during transposed cut is rejected without rebasing or partial mutation',async()=>{
    await reset(); await transpose(); await vselect(2,1); clipboardDelay=deferred(); const pending=clipboardDelay; const expected=String(revision); await key('x'); table.records[0].values.note='external'; revision++; clipboardDelay=null; await act(async()=>pending.resolve()); await settle(); assert.equal(source().values.power,formula); assert.equal(table.records[0].values.note,'external'); assert.equal(mutationCalls().at(-1).args.request.expected_revision,expected); assert.equal(history.length,0); assert(host.querySelector('[role="alert"]'));
  });
  await check('External snapshot while transposed editor has draft never applies it to another cell',async()=>{
    await reset(); await transpose(); const input=await vedit(5,1); await inputValue(input,'stale draft'); const count=quietCount(); table.records.reverse(); table.records.find(r=>r.uuid==='record-source').values.note='external update'; revision++; incoming=clone(table); await render(); assert(!host.querySelector('.rdg-editor-container'), 'snapshot replacement discarded the original draft'); await key('Enter',host.querySelector('.rdg-editor-container input, .rdg-editor-container textarea')||selected(),{ctrlKey:false}); assert.equal(quietCount(),count); assert.equal(source().values.note,'external update'); assert(!table.records.some(r=>Object.values(r.values).includes('stale draft')));
  });
  await check('Version badges in opposite axes submit original UUIDs; preview follows original fields',async()=>{
    await reset(data=>{data.schema.columns[1].min_version=3; data.records[1].min_version=3;}); renderProps={versionEditMode:true,versionPreview:true,releaseVersion:2}; await render(); await transpose();
    const badge=(fragment)=>[...host.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')?.includes(fragment)); let b=badge('rarity'); assert(b); await act(async()=>b.click()); await settle(); let input=host.querySelector('input[aria-label*="rarity"]'); assert(input); await inputValue(input,'4'); await key('Enter',input,{ctrlKey:false}); assert.deepEqual(mutationCalls().at(-1).args.request.column_versions,[{column_uuid:'column-rarity',min_version:'4'}]);
    b=badge('行 2'); assert(b); await act(async()=>b.click()); await settle(); input=host.querySelector('input[aria-label*="行 2"]'); assert(input); await inputValue(input,'4'); await key('Enter',input,{ctrlKey:false}); assert.deepEqual(mutationCalls().at(-1).args.request.versions,[{record_uuid:'record-source',min_version:'4'}]);
    assert(host.querySelector('[data-row-id="column-rarity"].rdg-version-excluded')); assert(viewCell(1,0).className.includes('rdg-version-excluded'));
  });
  await check('Reference navigation clears search and selects target record column exactly once',async()=>{
    await reset(); await transpose(); await filter('source'); const handled=[]; renderProps={referenceNavigation:{projectSessionId:session,tableUuid:'equipment',recordUuid:'record-target',requestId:'nav-1'},onReferenceNavigationHandled:r=>handled.push(r)}; await render(); assert.equal(host.querySelector(`input[placeholder="${t('grid.searchTable')}"]`).value,''); assert.equal(viewCell(0,2).getAttribute('aria-selected'),'true'); assert.equal(handled.length,1); await render(); assert.equal(handled.length,1);
  });
  await check('Zero records and zero schema columns transpose safely without writes',async()=>{
    for(const kind of ['records','columns','both']){ await reset(data=>{if(kind!=='columns') data.records=[]; if(kind!=='records') data.schema.columns=[];}); const original=JSON.stringify(table),count=quietCount(); await transpose(); await transpose(); assert.equal(JSON.stringify(table),original); assert.equal(quietCount(),count); assert(!host.querySelector('[role="alert"]')); }
  });
  await check('Wide transposed records and tall transposed fields keep DataGrid virtualization enabled',async()=>{
    await reset(data=>{const template=data.records[0];data.records=Array.from({length:1200},(_,i)=>({...clone(template),uuid:`record-${i}`,label:`r${i}`}));}); await transpose(); assert.equal(host.querySelector('.rdg').getAttribute('aria-colcount'),'1201'); const cells=host.querySelectorAll('[role="gridcell"]').length; assert(cells<300,`rendered cells bounded: ${cells}`); metrics.wide={sourceRecords:1200,sourceColumns:6,renderedGridcells:cells};
    await reset(data=>{data.schema.columns=Array.from({length:1000},(_,i)=>column(`field${i}`));}); await transpose(); assert.equal(host.querySelector('.rdg').getAttribute('aria-rowcount'),'1001'); const rows=host.querySelectorAll('[role="row"]').length; assert(rows<100,`rendered rows bounded: ${rows}`); metrics.tall={sourceRecords:4,sourceColumns:1000,renderedRowsIncludingHeader:rows};
  });
  await check('Transposed raw fallbacks preserve data_name, interface UUID and inherited default without materializing',async()=>{
    for(const field of ['power','interface_power']){ await reset(()=>omittedRaw.add(`record-source:column-${field}`)); await transpose(); await vselect(field==='power'?2:3,1); await key('x'); assert.equal(clipboard,encodedFormula); assert.equal(lastCells()[0].column_uuid,`column-${field}`); await vselect(field==='power'?2:3,2); await paste(); assert.equal(field==='power'?target().values.power:target().interface_values['column-interface_power'],formula); }
    await reset(); await transpose(); await vselect(4,1); const original=JSON.stringify(table),count=quietCount(); await key('x'); assert.equal(clipboard,''); assert.equal(quietCount(),count+1); assert.equal(source().values.default_power, undefined); assert.equal(source().values.default_power,undefined);
  });
  await check('Orientation change drops the old rectangle and retains only the canonical focused cell', async () => {
    await reset(); await vselect(1, 2); await vselect(2, 3, true);
    const focused = selected();
    const record = table.records[Number(focused.closest('[role="row"]').getAttribute('aria-rowindex')) - 2];
    const column = table.schema.columns[Number(focused.getAttribute('aria-colindex')) - 2];
    assert(record && column, 'focus has canonical record and field identities before transpose');
    const count = quietCount(); await transpose(); await key('Delete', host.querySelector('.rdg'), { ctrlKey: false });
    assert.equal(quietCount(), count + 1);
    assert.deepEqual(lastCells().map(cell => [cell.record_uuid, cell.column_uuid]), [[record.uuid, column.uuid]],
      'Delete clears only the remapped focus, never the stale rectangle or a new coordinate');
  });
  await check('Opening view controls commits a valid raw draft before transpose with the original UUID',async()=>{
    await reset(); await transpose(); const input = await vedit(5, 1); await inputValue(input, 'valid blur draft');
    const count = quietCount();
    // Programmatic activation has no preceding pointer event to commit the edit.
    // Radix's actual passive autofocus must transfer focus without recursive flushing.
    await act(async () => host.querySelector('.version-view-button').click()); await settle();
    const popover = toggleButton()?.closest('[role="dialog"]'); assert(popover);
    assert(popover.contains(document.activeElement), 'view controls retain autofocus after the edit commits');
    assert.equal(quietCount(), count + 1, 'autofocus commits the draft exactly once');
    await transpose(); assert(!isTransposed()); assert.equal(source().values.note, 'valid blur draft');
    assert.deepEqual(lastCells(), [{ record_uuid: 'record-source', column_uuid: 'column-note', value: 'valid blur draft' }]);
    assert.equal(quietCount(), count + 1, 'transpose does not repeat the blur commit');
  });

  const clickText = async (key, scope = document) => {
    const button = [...scope.querySelectorAll('button')].find(element => element.textContent === t(key));
    assert(button, `button ${key}`); await act(async () => button.click()); await settle();
  };
  const openColumn = async name => {
    const label = t('grid.filterSort.openColumn', { column: name });
    const button = [...host.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label);
    assert(button, `column menu ${name}`); await act(async () => button.click()); await settle();
    assert(document.querySelector('.grid-fs-popover'), 'column filter popover');
  };
  const sortBy = async (name, descending = false) => { await openColumn(name); await clickText(descending ? 'grid.filterSort.sortDescending' : 'grid.filterSort.sortAscending'); };
  const chooseValues = async (name, values) => {
    await openColumn(name);
    const all = document.querySelector('.grid-fs-select-all input');
    if (all.checked || all.indeterminate) { await act(async () => all.click()); await settle(); }
    for (const value of values) {
      const label = [...document.querySelectorAll('.grid-fs-value-row')].find(element => element.textContent === value);
      assert(label, `candidate ${value}`); await act(async () => label.querySelector('input').click()); await settle();
    }
    await clickText('grid.filterSort.apply', document.querySelector('.grid-fs-popover'));
  };
  const changeSelect = async (select, value) => { assert(select); await act(async () => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); }); await settle(); };
  const visibleNames = () => [...host.querySelectorAll('[role="row"] [role="gridcell"][aria-colindex="2"]')].map(element => element.textContent);
  await check('Column sort is display-only and selection follows the record UUID', async () => {
    await reset(); await select(1, 'name'); const original = JSON.stringify(table), count = quietCount();
    await sortBy('rarity', true); assert.deepEqual(visibleNames(), ['last', 'target', 'source', 'hidden']);
    assert.equal(cell(2, 'name').getAttribute('aria-selected'), 'true'); await key('c'); assert.equal(clipboard, 'source');
    assert.equal(JSON.stringify(table), original); assert.equal(quietCount(), count);
    await clickText('grid.filterSort.clearAll', host); assert.deepEqual(visibleNames(), ['hidden', 'source', 'target', 'last']);
    assert.equal(cell(1, 'name').getAttribute('aria-selected'), 'true');
  });
  await check('Candidate checks use OR, search composes with filters, and hidden targets cannot receive paste', async () => {
    await reset(); await chooseValues('name', ['source', 'target']); assert.deepEqual(visibleNames(), ['source', 'target']);
    await select(0, 'rarity'); await paste('20\n30'); assert.deepEqual(lastCells().map(patch => patch.record_uuid), ['record-source', 'record-target']);
    assert.equal(table.records[0].values.rarity, '1'); assert.equal(table.records[3].values.rarity, '12');
    await filter('source'); assert.deepEqual(visibleNames(), ['source']); await filter(''); assert.deepEqual(visibleNames(), ['source', 'target']);
    await chooseValues('rarity', ['30']); assert.deepEqual(visibleNames(), ['target']);
    await clickText('grid.filterSort.clearAll', host); assert.equal(visibleNames().length, 4);
  });
  await check('Candidate search applies only matching checked results, empty selection produces no rows', async () => {
    await reset(); await openColumn('name'); await inputValue(document.querySelector('.grid-fs-value-search input'), 'source');
    await clickText('grid.filterSort.apply', document.querySelector('.grid-fs-popover')); assert.deepEqual(visibleNames(), ['source']);
    await clickText('grid.filterSort.clearAll', host); await chooseValues('name', []); assert.deepEqual(visibleNames(), []);
    await clickText('grid.filterSort.clearAll', host); assert.equal(visibleNames().length, 4);
  });
  await check('Numeric range dialog validates input and combines two conditions with OR', async () => {
    await reset(); await openColumn('rarity'); await clickText('grid.filterSort.numberFilter'); await clickText('grid.filterSort.between');
    let dialog = document.querySelector('.grid-fs-condition-dialog'); assert(dialog);
    assert([...dialog.querySelectorAll('button')].find(b => b.textContent === t('grid.filterSort.apply')).disabled);
    await inputValue(dialog.querySelector('input[aria-label="条件 1: 値"]'), '5');
    await inputValue(dialog.querySelector('input[aria-label="条件 1: 上限"]'), '9');
    await changeSelect(dialog.querySelectorAll('select')[1], 'equals');
    await inputValue(dialog.querySelector('input[aria-label="条件 2: 値"]'), '12');
    await act(async () => dialog.querySelector('input[value="or"]').click()); await settle();
    await clickText('grid.filterSort.apply', dialog); assert.deepEqual(visibleNames(), ['source', 'target', 'last']);
  });
  await check('Sorted editing reapplies after commit; undo and redo preserve view sorting', async () => {
    await reset(); await sortBy('rarity'); let input = await vedit(1, 1); await inputValue(input, '40'); await key('Enter', input, { ctrlKey: false });
    assert.deepEqual(lastCells(), [{ record_uuid: 'record-source', column_uuid: 'column-rarity', value: '40' }]);
    assert.deepEqual(visibleNames(), ['hidden', 'target', 'last', 'source']);
    await key('z'); assert.deepEqual(visibleNames(), ['hidden', 'source', 'target', 'last']);
    await key('y'); assert.deepEqual(visibleNames(), ['hidden', 'target', 'last', 'source']);
  });
  await check('Filtered sorted bulk paste captures visible UUIDs before any value can reorder them', async () => {
    await reset(); await chooseValues('name', ['source', 'target']); await sortBy('rarity', true);
    await select(0, 'rarity'); await paste('2\n20');
    assert.deepEqual(lastCells(), [{ record_uuid: 'record-target', column_uuid: 'column-rarity', value: '2' }, { record_uuid: 'record-source', column_uuid: 'column-rarity', value: '20' }]);
    assert.deepEqual(visibleNames(), ['source', 'target']); assert.equal(table.records[0].values.rarity, '1');
  });
  await check('Transpose projects sorted filtered records horizontally and paste retains original targets', async () => {
    await reset(); await chooseValues('name', ['source', 'target']); await sortBy('rarity', true); await transpose();
    assert.equal(viewCell(0, 0).textContent, 'target'); assert.equal(viewCell(0, 1).textContent, 'source');
    await vselect(1, 0); await paste('2\t20');
    assert.deepEqual(lastCells().map(patch => patch.record_uuid), ['record-target', 'record-source']);
    assert.equal(viewCell(0, 0).textContent, 'source'); assert.equal(viewCell(0, 1).textContent, 'target');
  });
  await check('Table view state survives remount, schema type changes remove stale filters and sorts', async () => {
    await reset(); await chooseValues('rarity', ['5']); await sortBy('rarity', true); assert.deepEqual(visibleNames(), ['source']);
    mountId++; await render(); assert.deepEqual(visibleNames(), ['source']);
    table.schema.columns[1].data_type = 'String'; revision++; incoming = clone(table); await render();
    assert.deepEqual(visibleNames(), ['hidden', 'source', 'target', 'last']); assert(!host.querySelector('.grid-fs-trigger.is-filtered'));
  });
  await check('Clear all preserves a blocked raw editor draft and leaves sorting unchanged', async () => {
    await reset(data => { data.records[1].values.note = 'first\r\nsecond'; }); await sortBy('rarity', true);
    const input = await vedit(2, 5);
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, 'uncommitted'); input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'historyUndo' })); }); await settle();
    assert.equal(input.getAttribute('data-rdg-editor-blocked'), 'true');
    await clickText('grid.filterSort.clearAll', host);
    assert.equal(host.querySelector('.rdg-editor-container textarea').value, 'uncommitted');
    assert.deepEqual(visibleNames(), ['last', 'target', 'source', 'hidden']);
    await key('Escape', input, { ctrlKey: false }); await clickText('grid.filterSort.clearAll', host);
    assert.deepEqual(visibleNames(), ['hidden', 'source', 'target', 'last']);
  });
  await check('Reference navigation clears column filters but preserves sorting and resolves UUID once', async () => {
    await reset(); await chooseValues('name', ['source']); await sortBy('rarity', true); const handled = [];
    renderProps = { referenceNavigation: { projectSessionId: session, tableUuid: 'equipment', recordUuid: 'record-target', requestId: 'filter-nav' }, onReferenceNavigationHandled: request => handled.push(request) };
    await render(); assert.deepEqual(visibleNames(), ['last', 'target', 'source', 'hidden']); assert.equal(handled.length, 1);
    await render(); assert.equal(handled.length, 1); assert(!host.querySelector('.grid-fs-trigger.is-filtered'));
  });
  await check('Multi-column dialog adds, reorders, removes and cancels draft levels without writes', async () => {
    await reset(data => data.records.forEach((record, index) => record.values.note = index % 2 ? 'B' : 'A')); const count = quietCount();
    await openColumn('name'); await clickText('grid.filterSort.multipleSort'); let dialog = document.querySelector('.grid-fs-dialog');
    await changeSelect(dialog.querySelectorAll('.grid-fs-sort-level select')[0], 'column-note');
    await clickText('grid.filterSort.addLevel', dialog);
    await changeSelect(dialog.querySelectorAll('.grid-fs-sort-level select')[2], 'column-rarity');
    await changeSelect(dialog.querySelectorAll('.grid-fs-sort-level select')[3], 'desc');
    await clickText('grid.filterSort.apply', dialog); assert.deepEqual(visibleNames(), ['target', 'hidden', 'last', 'source']);
    await openColumn('name'); await clickText('grid.filterSort.multipleSort'); dialog = document.querySelector('.grid-fs-dialog');
    await act(async () => dialog.querySelectorAll('.grid-fs-sort-level')[1].click()); await settle();
    await act(async () => dialog.querySelector(`button[aria-label="${t('grid.filterSort.moveUp')}"]`).click()); await settle();
    await clickText('grid.filterSort.apply', dialog); assert.deepEqual(visibleNames(), ['last', 'target', 'source', 'hidden']);
    await openColumn('name'); await clickText('grid.filterSort.multipleSort'); dialog = document.querySelector('.grid-fs-dialog');
    await clickText('grid.filterSort.deleteLevel', dialog); await clickText('grid.filterSort.cancel', dialog);
    assert.deepEqual(visibleNames(), ['last', 'target', 'source', 'hidden']); assert.equal(quietCount(), count);
  });
  const report={metrics,runtimeDiagnostics:runtimeDiagnostics.length,passed:reports.length,checks:reports,mutationCalls:mutationCalls().length,clipboardWrites:writes.length,scope:'Real DataGridView/DataGrid, toolbar, localization, mutation/presentation hooks. Tauri IPC/history/formula values are explicit synthetic fixtures; DOM geometry and browser clipboard are synthetic. Native WebKit, Rust evaluation/persistence and OS clipboard are not asserted by this report.'};
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
