// Real EditCell, text editors, DataGridView/DataGrid and mutation/presentation hooks.
// IPC/evaluation are explicit fixtures; DOM layout/CSS are synthetic. Native QA is separate.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { formulaRepairSource } from './test-file-filters.cjs';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.formula-repair-check-'));
// Use the identical assertions against an earlier repository snapshot.
const before = process.env.FORMULA_REPAIR_BEFORE;
const window = new Window({ url: 'http://formula-repair.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'InputEvent', 'CompositionEvent', 'DOMRect', 'MutationObserver', 'CSS', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = window.IntersectionObserver = class { observe() {} disconnect() {} };
Object.defineProperties(window.HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 1800 }, clientWidth: { configurable: true, get: () => 1800 },
  offsetHeight: { configurable: true, get() { return this.classList.contains('rdg') ? Number.parseFloat(this.style.height) || 400 : 400; } },
  clientHeight: { configurable: true, get() { return this.offsetHeight; } }
});
window.HTMLElement.prototype.getBoundingClientRect = function() { return new window.DOMRect(0, 0, this.offsetWidth, this.offsetHeight); };
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};

const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const errorInputs = ['=REDUCE(MAP(SEQUENCE(3),(x)=>10/(x-2)),0,(a,x)=>a+x)', '="前${1/0}"', '=FIRST(TABLE("Source")).missing', '=FIRST(TABLE("Source")).value'];
const diagnostic = 'TypeMismatch: invalid formula input\n' + 'MAP element index 1; source bytes 21..25; root record UUID\n'.repeat(16);
const makeTable = uuid => ({
  uuid, display_name: uuid,
  metadata: { initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, data_name: uuid }, description: '',
  schema: { columns: [{ min_version: 0, uuid: 'result', data_name: 'result', display_name: 'Result', data_type: 'String', read_only: false, default_value: '', tags: [], tooltip: '', memo_text: '', style: { width: 600, color: '#ffffff', font_size: 12 } }] },
  records: (uuid === 'Diagnostics' ? errorInputs : ['7']).map((value, index) => ({ uuid: `${uuid}-${index}`, label: `row${index}`, values: { result: value }, interface_values: {}, memo_texts: {}, min_version: 0, tags: [] })),
  interface_implementations: {}, interface_order: []
});
const tables = { Diagnostics: makeTable('Diagnostics'), Source: makeTable('Source') };
let revision = 1, session = 'formula-repair-session', nextId = 0, readGate = null;
const calls = [], listeners = new Map(), reports = [];
const snapshot = uuid => {
  const table = tables[uuid];
  return { table: clone(table), presentation: {
    table_uuid: uuid, revision: String(revision), definition_issues: [], issue_count: 0,
    cells: Object.fromEntries(table.records.map(record => [record.uuid, { result: {
      raw_value: record.values.result,
      display_value: record.values.result === '=1+2' ? '3' : record.values.result.startsWith('=') ? '#ERROR!' : record.values.result,
      formula_error: record.values.result.startsWith('=') && record.values.result !== '=1+2' ? diagnostic : null,
      style: {}, issues: [], hint: ''
    } }]))
  } };
};
const invoke = async (command, args = {}) => {
  calls.push({ command, args: clone(args) });
  if (args.expectedProjectSession !== undefined) assert.equal(args.expectedProjectSession, session, `session-bound IPC: ${command}`);
  switch (command) {
    case 'get_interfaces': return '[]';
    case 'prepare_table_rule_snapshot': return `evaluation-${++nextId}`;
    case 'cancel_table_rule_snapshot': return true;
    case 'get_table_rule_snapshot': if (readGate) await readGate.promise; return { kind: 'snapshot', snapshot_token: null, retained_bytes: 1024, ...snapshot(args.tableUuid) };
    case 'apply_table_mutation': {
      const request = args.request, table = tables[request.table_uuid];
      assert.equal(request.expected_revision, String(revision), 'mutation uses the displayed revision');
      for (const patch of request.cells) table.records.find(record => record.uuid === patch.record_uuid).values.result = patch.value;
      revision++; return snapshot(request.table_uuid);
    }
    case 'save_project': return 'ok';
    default: throw Error(`Unexpected IPC: ${command}`);
  }
};
const listen = async (name, handler) => {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(handler); return () => listeners.get(name).delete(handler);
};
const emit = (name, payload) => { for (const handler of listeners.get(name) || []) handler({ payload }); };
globalThis.__formulaRepairCheck = { invoke, listen };
let root, React;
let baselineEditorLoads = 0;
try {
  const bundled = await build({ absWorkingDir: project,
    stdin: { contents: `export {default as DataGridView} from './src/app/pages/main_window/project_view/table_view/components/DataGridView'; export {default as EditCell} from './src/lib/react-data-grid/EditCell'; export {default as textEditor} from './src/lib/react-data-grid/editors/textEditor'; export {default as validatedTextEditor} from './src/lib/react-data-grid/editors/validatedTextEditor';`, resolveDir: project, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    define: { 'import.meta.env.DEV': 'false' }, alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'native-boundaries-and-static-css', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, args => ({ path: args.path, namespace: 'native' }));
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'css', namespace: 'static-css' }));
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'empty-css' }));
      builder.onLoad({ filter: /.*/, namespace: 'native' }, args => ({ contents: args.path.endsWith('/core')
        ? `export const invoke=(...args)=>globalThis.__formulaRepairCheck.invoke(...args); export const isTauri=()=>false;`
        : `export const listen=(...args)=>globalThis.__formulaRepairCheck.listen(...args); export const emit=async()=>{}; export const emitTo=async()=>{};`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'static-css' }, () => ({ contents: `export const css=()=> 'synthetic-css';`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'js' }));
      if (before) builder.onLoad({ filter: formulaRepairSource }, async args => {
        baselineEditorLoads++;
        return { contents: await readFile(resolve(before, 'devcel-studio', args.path.slice(project.length + 1)), 'utf8'), loader: 'tsx' };
      });
    } }]
  });
  assert.equal(baselineEditorLoads, before ? 2 : 0, 'baseline mode must load both actual editor sources');
  const modulePath = resolve(temporary, 'app.mjs'); await writeFile(modulePath, bundled.outputFiles[0].text);
  const { DataGridView, EditCell, textEditor, validatedTextEditor } = await import(pathToFileURL(modulePath));
  React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { DndProvider } = await import('react-dnd'); const { HTML5Backend } = await import('react-dnd-html5-backend');
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const act = React.act;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
  const render = async element => { await act(async () => root.render(element)); await settle(); };
  const check = async (name, action) => { await action(); reports.push(name); console.log('PASS', name); };
  const inputText = async (input, value, inputType = 'insertText') => {
    await act(async () => {
      input.dispatchEvent(new window.InputEvent('beforeinput', { bubbles: true, inputType, data: value }));
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType, data: value }));
    }); await settle();
  };

  for (const [name, editor] of [['standard', textEditor], ['validated', validatedTextEditor]]) {
    await check(`${name} editor hooks remain isolated when permission/refresh removes and restores the renderer`, async () => {
      let column = { key: 'result', idx: 0, name: 'Result', dataType: 'String', renderEditCell: editor };
      const props = { row: { result: '=1/0' }, rowIdx: 0, onRowChange: () => {}, closeEditor: () => {}, navigate: () => {} };
      for (let i = 0; i < 3; i++) {
        await render(React.createElement(EditCell, { ...props, column })); assert(host.querySelector('textarea'));
        column = { ...column, renderEditCell: undefined };
        await render(React.createElement(EditCell, { ...props, column })); assert(!host.querySelector('textarea'));
        column = { ...column, renderEditCell: editor };
      }
      await render(null);
    });
  }

  for (const [name, editor] of [['standard', textEditor], ['validated', validatedTextEditor]]) {
  await check(`${name} recreated inline renderer callbacks keep draft, focus, caret and IME state`, async () => {
    let row = { result: '=1/0' }, renders = 0;
    const draw = () => React.createElement(EditCell, {
      column: { key: 'result', idx: 0, name: 'Result', dataType: 'String', renderEditCell: props => editor(props) },
      row, rowIdx: 0, onRowChange: next => { row = next; }, closeEditor: () => {}, navigate: () => {},
      'data-test-renders': ++renders
    });
    await render(draw()); const input = host.querySelector('textarea'); assert(input);
    input.setSelectionRange(0, input.value.length); await inputText(input, '途中の入力'); input.setSelectionRange(2, 2);
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true, data: '仮' })));
    await inputText(input, '途中仮の入力', 'insertCompositionText'); input.setSelectionRange(3, 3);
    await render(draw());
    assert.equal(host.querySelector('textarea'), input, 'same input DOM despite new callback identity');
    assert.equal(document.activeElement, input); assert.equal(input.value, '途中仮の入力'); assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 3);
    await inputText(input, '途中確定の入力', 'insertCompositionText');
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true, data: '確定' })));
    await render(draw()); assert.equal(host.querySelector('textarea'), input); assert.equal(input.value, '途中確定の入力');
    assert.equal(row.result, '途中確定の入力', 'composition completes with the preserved raw-input model');
    await render(null);
  });

  }

  let active = 'Diagnostics', incoming = clone(tables[active]);
  const drawGrid = () => React.createElement(DndProvider, { backend: HTML5Backend }, React.createElement(DataGridView, { projectSessionId: session, tableData: incoming, tableName: active }));
  const switchTable = async uuid => { active = uuid; incoming = clone(tables[uuid]); await render(drawGrid()); };
  const cell = row => { const found = host.querySelector(`[role="row"][aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="2"]`); assert(found, `visible result row ${row}`); return found; };
  const openEditor = async row => {
    await act(async () => { cell(row).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 })); cell(row).dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, button: 0 })); }); await settle();
    const input = host.querySelector('.rdg-editor-container textarea'); assert(input, 'real String editor is open'); return input;
  };
  const repair = async row => {
    const input = await openEditor(row); input.setSelectionRange(0, input.value.length); await inputText(input, '=1+2');
    await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))); await settle();
    assert.equal(tables.Diagnostics.records[row].values.result, '=1+2'); assert.equal(cell(row).textContent, '3');
    assert.equal(cell(row).getAttribute('title'), null, 'old diagnostic title is removed from the semantic cell; editor button help remains');
    assert.equal(cell(row).getAttribute('aria-description'), null, 'old diagnostic description is removed after repair');
    assert.equal(cell(row).getAttribute('aria-invalid'), null, 'repaired cells have no validation issues');
  };

  await check('Long diagnostic cells repair repeatedly and survive table switches without hook-count errors', async () => {
    await switchTable('Diagnostics');
    for (let round = 0; round < 2; round++) {
      for (let row = 0; row < 4; row++) {
        assert.equal(cell(row).textContent, '#ERROR!');
        assert.equal(cell(row).getAttribute('title'), diagnostic, 'full diagnostic title belongs to the semantic cell');
        assert.equal(cell(row).getAttribute('aria-description'), diagnostic, 'diagnostic supplements the cell value readout');
        assert.equal(cell(row).getAttribute('aria-invalid'), null, 'formula diagnostics without validation issues preserve the existing invalid contract');
      }
      for (let row = 0; row < 4; row++) await repair(row);
      await switchTable('Source'); assert.equal(cell(0).textContent, '7');
      await switchTable('Diagnostics'); for (let row = 0; row < 4; row++) assert.equal(cell(row).textContent, '3');
      if (round === 0) {
        tables.Diagnostics.records.forEach((record, index) => { record.values.result = errorInputs[index]; }); revision++;
        await act(async () => emit('formula-sources-changed', { project_session: session })); await settle();
      }
    }
  });

  await check('Dependency invalidation while an editor is active removes hooks safely and allows another repair', async () => {
    const input = await openEditor(0); assert.equal(input.value, '=1+2');
    readGate = deferred(); const pending = readGate;
    await act(async () => emit('formula-sources-changed', { project_session: session })); await settle();
    assert(!host.querySelector('.rdg-editor-container textarea'), 'refresh temporarily disables the default editor');
    readGate = null; await act(async () => pending.resolve()); await settle();
    await repair(0); await switchTable('Source'); await switchTable('Diagnostics'); assert.equal(cell(0).textContent, '3');
  });
  console.log(JSON.stringify({ passed: reports.length, checks: reports, mutations: calls.filter(call => call.command === 'apply_table_mutation').length, scope: 'Production React components/hooks; mocked native data/evaluation; native WebKit is verified separately.' }, null, 2));
} finally {
  if (root) await React.act(() => root.unmount());
  await window.happyDOM.close(); await rm(temporary, { recursive: true, force: true }); delete globalThis.__formulaRepairCheck;
}
