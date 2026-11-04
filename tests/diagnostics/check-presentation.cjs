// Focused external verification. Reads/transpiles product sources in memory only.
// Run by the source owner: node check-presentation.cjs
// Snapshot contract: every non-null native snapshot is delivered exactly once, including
// initial equal-content snapshots. Native null is the only unchanged-read signal.
// Initial non-null snapshots count as one delivery.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const studio = path.resolve(__dirname, '../../devcel-studio');
const req = createRequire(path.join(studio, 'package.json'));
const { compileModule } = require('../../devcel-studio/scripts/compile-module.cjs');
const { Window } = req('happy-dom');
const window = new Window({ url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent']) {
  Object.defineProperty(global, key, { configurable: true, writable: true,
    value: key === 'window' ? window : key === 'document' ? window.document : window[key] });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = req('react');
const { act } = React;
const { createRoot } = req('react-dom/client');
const componentDir = 'src/app/pages/main_window/project_view/table_view/components/';
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await tick(); });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const uuid = '11111111-1111-4111-8111-111111111111';
const table = mark => ({ metadata: { uuid, display_name: mark, data_name: 'T' }, schema: { columns: [] }, records: [{ uuid: 'row', values: { cell: mark } }] });
const snapshot = (mark, revision = mark) => ({ table: table(mark), presentation: { table_uuid: uuid, revision, cells: {}, definition_issues: [], issue_count: 0 } });
const hashes = {};
function compile(relative, override) {
  const file = path.join(studio, relative);
  const source = fs.readFileSync(file, 'utf8');
  hashes[relative] = require('node:crypto').createHash('sha256').update(source).digest('hex');
  const output = compileModule(source, file);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(override, module, module.exports);
  return module.exports;
}
async function harness() {
  const calls = [], deliveries = [], renders = [];
  let api, setParent;
  const invoke = (command, args) => { const d = deferred(); calls.push({ command, args, ...d }); return d.promise; };
  const hook = compile(componentDir + 'useTablePresentation.ts', id => {
    if (id === '@tauri-apps/api/core') return { invoke };
    if (id === '@/app/i18n') return { useI18n() {}, message: value => value };
    if (id === './gridErrorNotice') return { gridErrorNotice: (m, e) => `${m}: ${String(e)}`, resolveGridError: e => e ? String(e) : '' };
    return req(id);
  }).useTablePresentation;
  function Child({ incoming, session, publish }) {
    // Mirror DataGridView's local table plus TableTabView's same-object echo.
    const [displayed, setDisplayed] = React.useState(incoming);
    React.useEffect(() => { setDisplayed(incoming); }, [incoming]);
    api = hook(displayed, session, result => {
      deliveries.push({ session, result });
      setDisplayed(result.table);
      publish(result.table);
    });
    renders.push({ session, displayed, revision: api.presentation?.revision });
    return React.createElement('output', null, api.presentation?.revision || 'pending');
  }
  function Parent() {
    const [state, setState] = React.useState({ session: 'A', incoming: table('A') });
    setParent = setState;
    return React.createElement(Child, { ...state, publish: incoming => setState(s => ({ ...s, incoming })) });
  }
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Parent))); await flush();
  return { calls, deliveries, renders, get api() { return api; },
    async resolve(call, value) { assert(call, 'expected native call'); await act(async () => call.resolve(value)); await flush(); },
    async reject(call, error) { assert(call); await act(async () => call.reject(error)); await flush(); },
    async start(fn) { let promise; await act(async () => { promise = fn(); await tick(); }); await flush(); return { promise }; },
    async switchSession(session) { await act(async () => setParent({ session, incoming: table(session) })); await flush(); },
    async publish(incoming) { await act(async () => setParent(s => ({ ...s, incoming }))); await flush(); },
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}
const reports = [];
async function test(name, body) {
  try { await body(); reports.push({ name, status: 'PASS' }); }
  catch (error) { reports.push({ name, status: 'FAIL', error: String(error), stack: error.stack }); }
  console.log(JSON.stringify(reports.at(-1)));
}
async function withHarness(body) { const h = await harness(); try { await body(h); } finally { await h.unmount(); } }
(async () => {
  await test('equal_content_initial_snapshot_parent_echo_once_then_native_null', () => withHarness(async h => {
    const first = snapshot('A', 'r1');
    assert.notEqual(first.table, h.renders.at(-1).displayed);
    assert.deepEqual(first.table, h.renders.at(-1).displayed);
    await h.resolve(h.calls[0], first);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.renders.at(-1).displayed, first.table);
    assert.equal(h.api.presentation, first.presentation);
    assert.equal(h.api.getCurrent(), first.presentation);
    await flush(); await flush();
    assert.equal(h.calls.length, 1, 'local adopt plus parent echo must not reload');
    const refresh = await h.start(() => h.api.refresh());
    assert.equal(h.api.presentation, null); assert.equal(h.api.getCurrent(), null);
    assert.equal(h.calls[1].args.knownRevision, 'r1');
    await h.resolve(h.calls[1], null);
    assert.equal(await refresh.promise, first.presentation);
    assert.equal(h.api.getCurrent(), first.presentation);
    assert.equal(h.deliveries.length, 1, 'null must not redeliver');
    assert.equal(h.calls.length, 2);
  }));
  await test('same_uuid_session_switch_rejects_late_full_reply', () => withHarness(async h => {
    const oldRefresh = h.api.refresh;
    await h.switchSession('B');
    await h.resolve(h.calls[0], snapshot('OLD_A', 'a1'));
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].args.expectedProjectSession, 'B');
    assert.equal(h.calls[1].args.knownRevision, undefined);
    const next = snapshot('B', 'b1'); await h.resolve(h.calls[1], next);
    assert.equal(h.deliveries.length, 1); assert.equal(h.deliveries[0].session, 'B');
    assert.equal(h.api.getCurrent(), next.presentation);
    const stale = await h.start(() => oldRefresh());
    assert.equal(await stale.promise, null); assert.equal(h.calls.length, 2);
    assert.equal(h.api.getCurrent(), next.presentation);
  }));
  await test('late_null_after_same_uuid_session_switch_is_ignored', () => withHarness(async h => {
    await h.resolve(h.calls[0], snapshot('A', 'a1'));
    const pending = await h.start(() => h.api.refresh());
    assert.equal(h.calls[1].args.knownRevision, 'a1');
    await h.switchSession('B'); await h.resolve(h.calls[1], null);
    assert.equal(h.api.getCurrent(), null); assert.equal(h.deliveries.length, 1);
    assert.equal(h.calls[2].args.expectedProjectSession, 'B');
    assert.equal(h.calls[2].args.knownRevision, undefined);
    const next = snapshot('B', 'b1'); await h.resolve(h.calls[2], next);
    assert.equal(await pending.promise, next.presentation);
    assert.equal(h.api.getCurrent(), next.presentation); assert.equal(h.deliveries.length, 2);
  }));
  await test('pause_defers_read_then_uses_committed_basis_revision', () => withHarness(async h => {
    await h.resolve(h.calls[0], snapshot('A', 'r1'));
    await act(async () => h.api.setPaused(true));
    const paused = await h.start(() => h.api.refresh());
    assert.equal(await paused.promise, null); assert.equal(h.calls.length, 1);
    const committed = snapshot('EDITED', 'r2');
    await act(async () => h.api.accept(committed.presentation, committed.table));
    await h.publish(committed.table);
    let hadDeferred; await act(async () => { hadDeferred = h.api.setPaused(false); });
    assert.equal(hadDeferred, true);
    const refresh = await h.start(() => h.api.refresh());
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].args.knownRevision, 'r2');
    await h.resolve(h.calls[1], null);
    assert.equal(await refresh.promise, committed.presentation);
    assert.equal(h.api.getCurrent(), committed.presentation);
    assert.equal(h.deliveries.length, 1, 'accept and null are not snapshot deliveries');
  }));
  await test('continuous_notifications_coalesce_one_trailing_read', () => withHarness(async h => {
    const first = snapshot('A', 'r1'); await h.resolve(h.calls[0], first);
    const a = await h.start(() => h.api.refresh());
    const b = await h.start(() => h.api.refresh());
    const c = await h.start(() => h.api.refresh());
    assert.equal(h.calls.length, 2);
    await h.resolve(h.calls[1], null);
    assert.equal(h.api.getCurrent(), null); assert.equal(h.calls.length, 3);
    assert.equal(h.calls[2].args.knownRevision, 'r1');
    await h.resolve(h.calls[2], null);
    for (const op of [a, b, c]) assert.equal(await op.promise, first.presentation);
    assert.equal(h.api.getCurrent(), first.presentation);
    assert.equal(h.calls.length, 3); assert.equal(h.deliveries.length, 1);
  }));
  await test('old_read_cannot_overwrite_accepted_mutation', () => withHarness(async h => {
    await h.resolve(h.calls[0], snapshot('A', 'r1'));
    const pending = await h.start(() => h.api.refresh());
    const committed = snapshot('EDITED', 'r2');
    await act(async () => h.api.accept(committed.presentation, committed.table));
    await h.publish(committed.table);
    await h.resolve(h.calls[1], snapshot('OLD', 'r1'));
    assert.equal(await pending.promise, null);
    assert.equal(h.api.getCurrent(), committed.presentation);
    assert.equal(h.deliveries.length, 1); assert.equal(h.calls.length, 2);
  }));
  await test('null_without_known_revision_is_error', () => withHarness(async h => {
    assert.equal(h.calls[0].args.knownRevision, undefined);
    await h.resolve(h.calls[0], null);
    assert.equal(h.api.presentation, null); assert.equal(h.api.getCurrent(), null);
    assert.ok(h.api.error); assert.equal(h.deliveries.length, 0);
  }));
  await test('boolean_disabled_is_renderer_prop_and_busy_not_row_dependency', async () => {
    // AST checks the actual source, not a hand-copied Boolean component.
    const file = path.join(studio, componentDir + 'DataGridView.tsx');
    const source = fs.readFileSync(file, 'utf8');
    hashes[componentDir + 'DataGridView.tsx'] = require('node:crypto').createHash('sha256').update(source).digest('hex');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let booleanDeclaration, rowsDeclaration, columnsDeclaration;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (node.name.text === 'BooleanCellRenderer') booleanDeclaration = node;
        if (node.name.text === 'rows' && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useMemo') rowsDeclaration = node;
        if (node.name.text === 'columns' && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useMemo') columnsDeclaration = node;
      }
      ts.forEachChild(node, visit);
    }
    visit(ast); assert(booleanDeclaration && rowsDeclaration && columnsDeclaration);
    const rowDeps = rowsDeclaration.initializer.arguments[1].getText(ast);
    assert(!rowDeps.includes('mutation.busy'));
    assert(rowDeps.includes('tableData') && rowDeps.includes('presentationState.presentation'));
    const colDeps = columnsDeclaration.initializer.arguments[1].getText(ast);
    assert(colDeps.includes('mutation.busy') && colDeps.includes('snapshotReady'));
    assert(columnsDeclaration.getText(ast).includes('disabled={mutation.busy || !snapshotReady}'));
    assert(!rowsDeclaration.getText(ast).includes('mutationPending'));
    const snippet = 'export ' + booleanDeclaration.parent.parent.getText(ast);
    const compiled = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } });
    const m = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputText)(req, m, m.exports);
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container), row = { flag: 'true' }, column = { key: 'flag' };
    try {
      for (const disabled of [false, true, false]) {
        await act(async () => root.render(React.createElement(m.exports.BooleanCellRenderer, { row, column, tabIndex: 0, onRowChange() {}, disabled })));
        const input = container.querySelector('input');
        assert.equal(input.disabled, disabled); assert.equal(input.checked, true);
      }
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
  const summary = { total: reports.length, pass: reports.filter(r => r.status === 'PASS').length, fail: reports.filter(r => r.status === 'FAIL').length };
  console.log('PRESENTATION_FOCUSED_SUMMARY ' + JSON.stringify({ ...summary, react: req('react/package.json').version, hashes }));
  if (summary.fail) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
