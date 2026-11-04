// Synthetic current-contract fixture for real production React components.
// No native IPC, layout, paint, or disk-save performance is measured here.
import React, { useState, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
const P: any = { marks: [], commits: [], calls: {}, requests: [], deliveries: [], runs: [], rowRenders: 0, cellRenders: 0, cellBackgrounds: {} };
(window as any).__profile = P;
let snapshot: any;
let setIncoming: any;
let setSession: any;
let root: any;
function fixture(n: number) { const cols = Array.from({ length: 30 }, (_, i) => ({ min_version: 0, uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, data_name: `C${i}`, display_name: `C${i}`, data_type: 'I32', tooltip: '', tags: [], read_only: false, default_value: '0', style: { color: '#ffffff', font_size: 12, width: 100 }, memo_text: '', reference_config: null })); const cells: any = {}; const records = Array.from({ length: n }, (_, r) => { const uuid = `10000000-0000-4000-8000-${String(r + 1).padStart(12, '0')}`; const values: any = {}; cells[uuid] = {}; for (const [i, c] of cols.entries()) {
    const v = String(r * 30 + i);
    values[c.data_name] = v;
    cells[uuid][c.uuid] = { raw_value: v, display_value: v, style: {}, issues: [], formula_error: null, hint: '' };
} return { uuid, parent_uuid: '', label: `Row ${r + 1}`, min_version: 0, tags: [], values, interface_values: {}, memo_texts: {} }; }); const table = { uuid: '20000000-0000-4000-8000-000000000001', description: 'Synthetic profile', metadata: { initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, parent_uuid: '', display_name: 'Profile', data_name: 'Profile', tooltip: '' }, interface_implementations: {}, interface_order: [], schema: { columns: cols }, records }; return { table, presentation: { table_uuid: table.uuid, revision: 'r0', cells, definition_issues: [], issue_count: 0 } }; }
// This is an IPC mock, not the native Rust history, persistence, or validation.
let activeSession = 'profile';
let revision = 0;
let undoSnapshots: any[] = [];
let redoSnapshots: any[] = [];
type DeferredResponse = { pending: boolean; response?: any; promise: Promise<void>; release: () => void };
const deferredResponses = new Map<string, DeferredResponse>();
function deferNext(command: string) {
    if (deferredResponses.has(command)) throw new Error(`Already delaying ${command}`);
    let release!: () => void;
    const gate: DeferredResponse = { pending: false, promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
    deferredResponses.set(command, gate);
    return gate;
}
function nextRevision(next: any) {
    return { ...next, presentation: { ...next.presentation, revision: `r${++revision}` } };
}
function mockCommand(command: string, args: any) {
    if (['get_table_rule_snapshot', 'apply_table_mutation', 'undo_command', 'redo_command', 'get_table_history_status', 'save_project'].includes(command)
        && args.expectedProjectSession !== activeSession) throw new Error('Mock rejected stale project session');
    if (command === 'get_table_history_status') return { canUndo: undoSnapshots.length > 0, canRedo: redoSnapshots.length > 0 };
    if (command === 'get_interfaces') return '[]';
    if (command === 'get_table_rule_snapshot')
        return args.knownSnapshotToken === `${activeSession}:${snapshot.presentation.revision}`
          ? { kind: 'unchanged', snapshot_token: args.knownSnapshotToken, retained_bytes: 1024 }
          : { kind: 'snapshot', snapshot_token: `${activeSession}:${snapshot.presentation.revision}`, retained_bytes: 1024, ...snapshot };
    if (command === 'apply_table_mutation') {
        if (args.request.table_uuid !== snapshot.table.uuid
            || args.request.expected_revision !== snapshot.presentation.revision) throw new Error('Mock rejected stale mutation identity/revision');
        const start = performance.now();
        const next = JSON.parse(JSON.stringify(snapshot));
        P.marks.push({ kind: 'mock-clone-not-native', ms: performance.now() - start });
        for (const p of args.request.cells) {
            const r = next.table.records.find((r: any) => r.uuid === p.record_uuid);
            const c = next.table.schema.columns.find((c: any) => c.uuid === p.column_uuid);
            if (!r || !c) throw new Error('Mock received unknown cell UUID');
            r.values[c.data_name] = p.value;
            next.presentation.cells[p.record_uuid][p.column_uuid].raw_value = p.value;
            next.presentation.cells[p.record_uuid][p.column_uuid].display_value = p.value;
        }
        undoSnapshots.push(snapshot);
        redoSnapshots = [];
        snapshot = nextRevision(next);
        return snapshot;
    }
    if (command === 'undo_command' || command === 'redo_command') {
        if (args.tableUuid !== snapshot.table.uuid) throw new Error('Mock received wrong history table UUID');
        const source = command === 'undo_command' ? undoSnapshots : redoSnapshots;
        const destination = command === 'undo_command' ? redoSnapshots : undoSnapshots;
        const previous = source.pop();
        if (!previous) throw new Error(`Mock has no ${command} entry`);
        destination.push(snapshot);
        snapshot = nextRevision(previous);
        return 'ok';
    }
    if (command === 'save_project') return 'ok';
    if (command.includes('listen')) return 1;
    if (command.includes('emit')) return;
    return null;
}
(window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'profile' }, currentWebview: { label: 'profile' } },
    transformCallback: () => 1, unregisterCallback: () => { },
    invoke: async (command: string, args: any) => {
        P.calls[command] = (P.calls[command] || 0) + 1;
        P.requests.push({ command, args: JSON.parse(JSON.stringify(args ?? {})) });
        // Capture the old response before waiting, just like an in-flight IPC.
        const result = mockCommand(command, args);
        const gate = deferredResponses.get(command);
        if (gate) {
            deferredResponses.delete(command);
            gate.response = result;
            gate.pending = true;
            await gate.promise;
        }
        return result;
    }
};
const { default: Grid } = await import('@/app/pages/main_window/project_view/table_view/components/DataGridView');
function App() { const [session, changeSession] = useState("profile"); setSession = changeSession; const [table, setTable] = useState(snapshot.table); setIncoming = setTable; return <Profiler id="grid" onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => P.commits.push({ phase, actualDuration, baseDuration, startTime, commitTime })}><Grid projectSessionId={session} tableData={table} tableName="Synthetic" onDataChange={next => { P.deliveries.push({ session, observedValue: next.records[0]?.values.C1 }); setTable(next); }}/></Profiler>; }
const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
function out() { (document.querySelector('#result') as HTMLElement).textContent = JSON.stringify({ environment: { ua: navigator.userAgent, viewport: [innerWidth, innerHeight], build: 'production React profiling, synthetic mocked IPC' }, rows: snapshot?.table.records.length, renderedRows: document.querySelectorAll('.rdg-row').length, renderedCells: document.querySelectorAll('[role="gridcell"]').length, rowRenders: P.rowRenders, cellRenders: P.cellRenders, marks: P.marks, commits: P.commits, calls: P.calls, runs: P.runs }, null, 2); fetch('/metrics', { method: 'POST', body: (document.querySelector('#result') as HTMLElement).textContent }); }
async function load(n: number) { if (root)
    root.unmount(); activeSession = 'profile'; revision = 0; undoSnapshots = []; redoSnapshots = []; deferredResponses.clear(); snapshot = fixture(n); P.marks = []; P.commits = []; P.calls = {}; P.requests = []; P.deliveries = []; const t = performance.now(); root = createRoot(document.querySelector('#grid')!); root.render(<App />); await new Promise(r => setTimeout(r, 500)); await settle(); P.runs.push({ kind: 'load-settle-includes-500ms-wait', ms: performance.now() - t }); out(); }
async function run() { P.marks = []; P.commits = []; P.runs = []; P.rowRenders = 0; P.cellRenders = 0; const grid = document.querySelector('.rdg')!; const scroll = grid.classList.contains('rdg-physical-rows-viewport') ? grid.closest('.rdg-physical-extent')!.parentElement! : grid.closest('.datagrid-zoom-content')!.parentElement!.parentElement!; for (let i = 0; i < 12; i++) {
    const before = { rows: P.rowRenders, cells: P.cellRenders, commits: P.commits.length };
    const t = performance.now();
    scroll.scrollTop = i % 2 ? 0 : Math.max(0, scroll.scrollHeight - 780);
    scroll.dispatchEvent(new Event('scroll'));
    await settle();
    await new Promise(r => setTimeout(r, 25));
    P.runs.push({ kind: 'scroll-two-raf', ms: performance.now() - t, rows: P.rowRenders - before.rows, cells: P.cellRenders - before.cells, commits: P.commits.slice(before.commits) });
} for (let i = 0; i < 12; i++) {
    const cells = [...document.querySelectorAll('[role="gridcell"]')];
    const el = cells[(i % 10) + 2];
    const before = { rows: P.rowRenders, cells: P.cellRenders, commits: P.commits.length };
    const t = performance.now();
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await settle();
    await new Promise(r => setTimeout(r, 25));
    P.runs.push({ kind: 'selection-two-raf', ms: performance.now() - t, rows: P.rowRenders - before.rows, cells: P.cellRenders - before.cells, commits: P.commits.slice(before.commits) });
} const json = JSON.stringify(snapshot); for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const next = JSON.parse(json);
    P.runs.push({ kind: 'json-parse', ms: performance.now() - t, bytes: new TextEncoder().encode(json).length });
    const u = performance.now();
    snapshot = next;
    setIncoming(next.table);
    await settle();
    await new Promise(r => setTimeout(r, 50));
    P.runs.push({ kind: 'full-snapshot-two-raf', ms: performance.now() - u });
} out(); }
document.querySelector('#root')!.innerHTML = '<div style="height:45px"><button id="small">Load 83</button> <button id="large">Load 10000</button> <button id="run">Run profile</button> <button id="out">Read metrics</button></div><div id="grid" style="height:820px"></div><pre id="result" style="white-space:pre-wrap;font-size:12px"></pre>';
document.querySelector('#small')!.addEventListener('click', () => load(83));
document.querySelector('#large')!.addEventListener('click', () => load(10000));
document.querySelector('#run')!.addEventListener('click', run);
document.querySelector('#out')!.addEventListener('click', out);
(window as any).__harness = {
    load, deferNext,
    setSession: (session: string, next = snapshot) => {
        activeSession = session;
        snapshot = next;
        undoSnapshots = []; redoSnapshots = [];
        setSession(session); setIncoming(next.table);
    },
    getSnapshot: () => snapshot,
    replace: (next: any) => { snapshot = next; setIncoming(next.table); }
};
