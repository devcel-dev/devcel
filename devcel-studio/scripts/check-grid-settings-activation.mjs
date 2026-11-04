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
const before = process.env.SETTINGS_ACTIVATION_BEFORE;
const reports = [], calls = [], writes = [], expandedRequests = [];
const metrics = {};
let nextEvaluationId = 0;
const evaluations = new Map();
const formula = '=LOOKUP("materials","key","marsh_hide_t01","value")*2+rarity';
const encodedFormula = '"' + formula.replaceAll('"', '""') + '"';
const window = new Window({ url: 'http://cut-input.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'HTMLButtonElement', 'HTMLFormElement', 'SVGElement', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver', 'CSS', 'localStorage']) {
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
let emitMutationInvalidation = false, snapshotGate = null, snapshotFailure = null;
let mutationGate = null, mutationFailure = null, warningResult = false, warningRequests = 0;
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
      assert.equal(args.request.expected_revision, String(revision), 'settings uses the refreshed post-commit revision');
      table.description = args.request.description;
      if (args.request.display_name !== undefined) table.display_name = args.request.display_name;
      table.metadata.initial_transposed = args.request.initial_transposed;
      table.metadata.edit_permissions = args.request.edit_permissions;
      revision++;
      return snapshot();
    }
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
    stdin: { contents: `export {default as DataGridView} from './src/app/pages/main_window/project_view/table_view/components/DataGridView'; export {t} from './src/app/i18n'; export { setTableInteractionTarget } from './src/app/services/tableInteractionScope'; export {parseClipboardTsv, serializeClipboardTsv} from './src/app/pages/main_window/project_view/table_view/components/gridClipboard';`, resolveDir: project, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    define: { 'import.meta.env.DEV': 'false' }, alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'native-boundaries-and-static-css', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path.endsWith('/table_rule_dialogs')) return { path: args.path, namespace: 'warning-dialog' };
        if (args.path.endsWith('/string_editor_window')) return { path: args.path, namespace: 'string-window' };
        if (Object.hasOwn(boundaries, args.path)) return { path: args.path, namespace: 'boundary' };
        if (args.path === '@linaria/core') return { path: args.path, namespace: 'static-css' };
        if (args.path.endsWith('.css')) return { path: args.path, namespace: 'empty-css' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'warning-dialog' }, () => ({ contents: `export const confirmInputWarnings=()=>globalThis.__cutInputCheck.confirmWarnings();`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'string-window' }, () => ({ contents: `export const showStringEditor=async(request)=>globalThis.__cutInputCheck.openStringEditor(request); export const registerMainWindowCloseBlocker=()=>()=>{};`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: boundaries[args.path], loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'static-css' }, () => ({ contents: `export const css=()=> 'synthetic-css';`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'js' }));
      if (before) builder.onLoad({ filter: /[/\\](DataGridView|DataGridToolbar)\.tsx$/ }, async args => ({ contents: await readFile(resolve(before, 'devcel-studio', args.path.slice(project.length + 1)), 'utf8'), loader: 'tsx' }));
    } }]
  });
  const modulePath = resolve(temporary, 'app.mjs'); await writeFile(modulePath, bundled.outputFiles[0].text);
  const { DataGridView, t, parseClipboardTsv, serializeClipboardTsv, setTableInteractionTarget } = await import(pathToFileURL(modulePath));
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
    mutationGate = null; mutationFailure = null; warningResult = false; warningRequests = 0;
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
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === t('common.close')).click());
    await settle();
  };

  await check('A normal settings pointer activation opens on its first click', async () => {
    await reset(); const button = settings(); await down(button); await up(button); assert(settingsDialog());
    assert.equal(mutationCalls().length, 0);
  });
  await check('One settings click survives its inline commit and saves with the refreshed revision', async () => {
    await reset(); const { gate, button, count } = await editAndHold('fresh name');
    assert.equal(button.disabled, false, 'the originating enabled gesture remains clickable');
    await up(button); assert(!settingsDialog(), 'activation waits for successful IPC, not just blur');
    assert.equal(settings().disabled, true, 'ordinary controls stay locked while the mutation is pending');
    await finish(gate);
    assert(settingsDialog(), 'the original click opens settings after its commit');
    assert.equal(source().values.name, 'fresh name'); assert.equal(mutationCalls().length, count + 1);
    const dialog = settingsDialog(); await inputValue(dialog.querySelector('input:not([type])'), 'new settings');
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === t('common.close')).click());
    await settle(); assert.equal(table.display_name, 'new settings'); assert(!settingsDialog());
  });
  await check('A commit settled before pointerup still retains the original activation', async () => {
    await reset(); const { gate, button, count } = await editAndHold('fast name');
    await finish(gate); assert(!settingsDialog()); await up(button); assert(settingsDialog());
    assert.equal(mutationCalls().length, count + 1);
  });
  await check('Escape after settlement cancels the matching pointer click without disabling later activation', async () => {
    await reset(); const { gate, button } = await editAndHold('escape held');
    await finish(gate); assert.equal(button.disabled, false);
    await key('Escape', button, { ctrlKey: false }); await up(button); assert(!settingsDialog());
    await down(button); await up(button); assert(settingsDialog(), 'a fresh gesture still opens');
  });
  await check('Keyboard activation during a pending pointer gesture does not consume its commit exception', async () => {
    await reset(); const { gate, button } = await editAndHold('keyboard held');
    await act(async () => {
      button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      button.click();
    });
    await finish(gate); await up(button); assert(!settingsDialog());
    await act(async () => button.click()); await settle(); assert(settingsDialog(), 'ordinary keyboard activation works after settlement');
  });
  await check('A rejected inline mutation cancels the requested settings activation', async () => {
    await reset(); const { gate, button } = await editAndHold('rejected');
    mutationFailure = new Error('test rejected edit'); await up(button); await finish(gate);
    assert(!settingsDialog()); assert.equal(source().values.name, 'source'); assert(host.querySelector('[role="alert"]'));
    mutationFailure = null; await down(settings()); await up(settings()); assert(settingsDialog(), 'a later deliberate click still works');
  });
  await check('Canceling the native input warning never opens settings', async () => {
    await reset(); const { gate, button, count } = await editAndHold('warning');
    mutationFailure = { kind: 'input_validation', report: { acknowledgement: 'test-warning', issues: [] } };
    await up(button); await finish(gate);
    assert.equal(warningRequests, 1); assert(!settingsDialog()); assert.equal(source().values.name, 'source');
    assert.equal(mutationCalls().length, count + 1, 'warning cancellation does not resubmit');
  });
  await check('Pointer cancellation discards the activation without canceling the cell commit', async () => {
    await reset(); const { gate, button } = await editAndHold('cancelled pointer');
    await act(async () => button.dispatchEvent(new window.PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })));
    assert.equal(button.disabled, true); await finish(gate);
    assert.equal(source().values.name, 'cancelled pointer'); assert(!settingsDialog());
  });
  await check('Releasing outside the settings button does not synthesize a click', async () => {
    await reset(); const { gate, button } = await editAndHold('outside release');
    await up(button, host, false); assert.equal(button.disabled, true); await finish(gate);
    assert.equal(source().values.name, 'outside release'); assert(!settingsDialog());
  });
  await check('Unmount and project or table replacement revoke the pending activation', async () => {
    for (const change of ['unmount', 'project', 'table']) {
      await reset(); const { gate, button } = await editAndHold(`stale ${change}`); await up(button);
      if (change === 'unmount') { mountId++; await render(); }
      else if (change === 'project') { session += '-new'; incoming = clone(table); await render(); }
      else { table.uuid = 'replacement-table'; incoming = clone(table); await render(); }
      await finish(gate); assert(!settingsDialog(), `${change} cannot open the old intent`);
    }
  });
  await check('Leaving and returning to the same interaction scope revokes a pending activation', async () => {
    await reset(); const { gate, button } = await editAndHold('old scope'); await up(button);
    await act(async () => { setTableInteractionTarget(session, 'elsewhere'); setTableInteractionTarget(session, 'equipment'); });
    await finish(gate); assert(!settingsDialog());
  });
  await check('An unrelated pending mutation never makes the disabled settings button activatable', async () => {
    await reset(); const input = await vedit(1, 0); await inputValue(input, 'unrelated');
    mutationGate = deferred(); const gate = mutationGate;
    await key('Enter', input, { ctrlKey: false }); const button = settings(); assert.equal(button.disabled, true);
    await down(button); await up(button); await finish(gate); assert(!settingsDialog());
  });
  await check('An unchanged editor needs no write but still permits the original click', async () => {
    await reset(); await vedit(1, 0); const count = mutationCalls().length, button = settings();
    await down(button); await up(button); assert(settingsDialog()); assert.equal(mutationCalls().length, count);
    await cancelSettings();
  });
  await check('An unchanged held-pointer activation pairs current settings data with its current revision', async () => {
    await reset(); await vedit(1, 0); const button = settings(), count = mutationCalls().length;
    await down(button); assert.equal(mutationCalls().length, count);
    table.display_name = 'authoritative newer description'; revision++;
    incoming = clone(table); await render(); await settle(); await up(button);
    const dialog = settingsDialog(); assert(dialog);
    assert.equal(dialog.querySelector('input:not([type])').value, table.display_name, 'a new revision must never be paired with old settings data');
    await inputValue(dialog.querySelector('input:not([type])'), 'newer requested settings');
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === t('common.close')).click());
    await settle(); assert.equal(table.display_name, 'newer requested settings');
  });
  await check('An unchanged held-pointer activation honors a newly locked interaction', async () => {
    await reset(); await vedit(1, 0); const button = settings(); await down(button);
    renderProps = { interactionLocked: true }; await render(); await up(button); assert(!settingsDialog());
  });
  await check('A blocked raw draft neither opens settings nor loses its text', async () => {
    await reset(data => { data.records[1].values.note = 'first\r\nsecond'; });
    const input = await vedit(1, 5);
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, 'uncommitted');
      input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'historyUndo' })); });
    await settle(); assert.equal(input.getAttribute('data-rdg-editor-blocked'), 'true');
    const count = mutationCalls().length, button = settings(); await down(button); await up(button);
    assert(!settingsDialog()); assert.equal(host.querySelector('.rdg-editor-container textarea').value, 'uncommitted');
    assert.equal(mutationCalls().length, count);
  });
  const invalidatedCommit = async (value = 'native invalidation') => {
    await reset(); mirrorSnapshots = true; await render();
    const held = await editAndHold(value);
    emitMutationInvalidation = true;
    const readGate = deferred(); snapshotGate = readGate;
    await up(held.button); await finish(held.gate);
    assert.equal(source().values.name, value, 'row delivery is immediate and completed before refresh');
    assert(!settingsDialog(), 'the originating click waits for a coherent authoritative read');
    return { ...held, readGate };
  };
  const finishSnapshot = async gate => { snapshotGate = null; await act(async () => gate.resolve()); await settle(); };
  await check('Native-order invalidation retains the click until the same-revision authoritative replacement arrives', async () => {
    const { readGate, count } = await invalidatedCommit();
    await finishSnapshot(readGate);
    assert(settingsDialog(), 'one real-sequence click survives the native invalidation and delayed refresh');
    assert.equal(mutationCalls().length, count + 1);
    const dialog = settingsDialog(); await inputValue(dialog.querySelector('input:not([type])'), 'refreshed authoritative settings');
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === t('common.close')).click());
    await settle(); assert.equal(table.display_name, 'refreshed authoritative settings');
  });
  await check('A fast same-revision refresh replacement does not fail table object identity', async () => {
    await reset(); mirrorSnapshots = true; await render();
    const { gate, button } = await editAndHold('fast authoritative replacement');
    emitMutationInvalidation = true; await up(button); await finish(gate); assert(settingsDialog());
  });
  await check('A failed authoritative refresh cancels the pending settings intent even after retry', async () => {
    const { readGate } = await invalidatedCommit('failed refresh');
    snapshotFailure = new Error('fixture snapshot refresh failed'); await finishSnapshot(readGate);
    assert(!settingsDialog()); assert(host.querySelector('[role="alert"]'));
    snapshotFailure = null;
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === t('grid.reload'));
    assert(retry, 'actual failed-read reload control'); await act(async () => retry.click());
    await settle(); assert(!settingsDialog(), 'later recovery cannot reopen a failed intent');
  });
  await check('Canceling an explicit foreground retry never opens the old settings intent', async () => {
    const { readGate } = await invalidatedCommit('canceled refresh');
    assert(host.querySelector('.rdg'), 'background verification retains the displayed grid');
    assert(![...host.querySelectorAll('button')].some(button => button.textContent === t('common.cancel')),
      'background verification does not flash a foreground loading control');
    snapshotFailure = new Error('fixture snapshot refresh failed');
    await finishSnapshot(readGate); assert(!settingsDialog());
    snapshotFailure = null;
    const reload = [...host.querySelectorAll('button')].find(button => button.textContent === t('grid.reload'));
    assert(reload, 'actual failed-read reload control');
    const foregroundGate = deferred(); snapshotGate = foregroundGate;
    await act(async () => reload.click()); await settle();
    const cancel = [...host.querySelectorAll('button')].find(button => button.textContent === t('common.cancel'));
    assert(cancel, 'actual refresh cancellation control'); await act(async () => cancel.click());
    await finishSnapshot(foregroundGate); assert(!settingsDialog());
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === t('common.retry'));
    assert(retry, 'actual canceled-read retry control'); await act(async () => retry.click());
    await settle(); assert(!settingsDialog(), 'retry cannot resurrect the canceled settings intent');
  });
  await check('A newer authoritative revision rejects the older successful settings intent', async () => {
    const { readGate } = await invalidatedCommit('superseded revision');
    table.display_name = 'external newer revision'; revision++;
    await finishSnapshot(readGate); assert(!settingsDialog());
    const button = settings(); await down(button); await up(button);
    assert.equal(settingsDialog().querySelector('input:not([type])').value, table.display_name, 'a new deliberate click uses the newer pair');
  });
  await check('Subsequent pointer and keyboard input revoke a settings intent waiting for refresh', async () => {
    for (const kind of ['pointer', 'Escape', 'F2']) {
      const { readGate } = await invalidatedCommit(`superseded by ${kind}`);
      await act(async () => {
        if (kind === 'pointer') host.dispatchEvent(new window.PointerEvent('pointerdown', {bubbles:true,button:0,pointerId:2}));
        else host.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles:true,key:kind}));
      });
      await finishSnapshot(readGate); assert(!settingsDialog(), `${kind} cannot trigger a surprise late dialog`);
    }
  });
  await check('Window blur revokes a settings intent waiting for its authoritative refresh', async () => {
    const { readGate } = await invalidatedCommit('window blur');
    await act(async () => window.dispatchEvent(new window.Event('blur')));
    await finishSnapshot(readGate); assert(!settingsDialog(), 'returning to the app cannot open a stale queued dialog');
  });
  await check('Navigation during the authoritative refresh revokes the settings intent', async () => {
    const { readGate } = await invalidatedCommit('refresh navigation');
    await act(async () => { setTableInteractionTarget(session, 'elsewhere'); setTableInteractionTarget(session, 'equipment'); });
    await finishSnapshot(readGate); assert(!settingsDialog());
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
