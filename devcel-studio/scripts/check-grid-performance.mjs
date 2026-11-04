import { installPhysicalGridGeometry } from './physical-grid-geometry.mjs';
import { Window } from 'happy-dom';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
// The parent builds separately so Vite/compiler work is excluded from measurements.
const studio = path.resolve(import.meta.dirname, '..');
if (process.argv[2] !== '--worker') {
    const mode = process.argv[2] || 'regression';
    const size = process.argv[3] || '83';
    const result = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
    const cache = path.join(studio, 'node_modules/.cache');
    fs.mkdirSync(cache, { recursive: true });
    const output = fs.mkdtempSync(path.join(cache, 'devcel-grid-'));
    try {
        const env = { ...process.env, DEVCEL_GRID_TIMING: mode === 'timing' ? '1' : '0' };
        const built = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'scripts/grid-performance.config.ts', '--ssr', 'scripts/grid-performance.fixture.tsx', '--outDir', output], { cwd: studio, env, stdio: 'inherit' });
        if (built.status !== 0)
            process.exitCode = built.status || 1;
        else {
            const checked = spawnSync(process.execPath, [import.meta.filename, '--worker', mode, size, output, result || ''], { cwd: studio, env, stdio: 'inherit' });
            process.exitCode = checked.status ?? 1;
        }
    }
    finally {
        fs.rmSync(output, { recursive: true, force: true });
    }
}
else {
    const mode = process.argv[3], size = Number(process.argv[4]);
    const resultPath = process.argv[6];
    const window = new Window({ url: 'http://profile.invalid', width: 1364, height: 1024 });
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDivElement', 'Element', 'Node', 'MutationObserver', 'MouseEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'DOMRect', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
        Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : typeof window[key] === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? window[key].bind(window) : window[key] });
    globalThis.addEventListener = window.addEventListener.bind(window);
    globalThis.removeEventListener = window.removeEventListener.bind(window);
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() { } };
    window.ResizeObserver = globalThis.ResizeObserver = class {
        observe() { }
        unobserve() { }
        disconnect() { }
    };
    Object.defineProperties(window.HTMLElement.prototype, { clientWidth: { configurable: true, get() { return this.classList.contains('rdg') ? 3120 : 1180; } }, clientHeight: { configurable: true, get() { return this.classList.contains('rdg') ? parseFloat(this.style.height) || 780 : 780; } }, offsetWidth: { configurable: true, get() { return this.clientWidth; } }, offsetHeight: { configurable: true, get() { return this.clientHeight; } }, scrollHeight: { configurable: true, get() { return parseFloat(this.querySelector('.rdg')?.style.height) || this.clientHeight; } } });
    window.HTMLElement.prototype.getBoundingClientRect = function () { return new window.DOMRect(0, 0, this.clientWidth, this.clientHeight); };
    installPhysicalGridGeometry(window, { width: 1180, height: 780 });
    globalThis.innerWidth = 1364;
    globalThis.innerHeight = 1024;
    globalThis.fetch = async (url, args) => { if (url === '/metrics') {
        if (resultPath)
            fs.writeFileSync(resultPath, args.body);
        return { ok: true };
    } throw Error('network disabled in harness'); };
    document.body.innerHTML = '<div id="root"></div>';
    await import(pathToFileURL(path.join(process.argv[5], 'grid-performance.fixture.js')).href);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const assert = (v, message) => { if (!v)
        throw Error(message); };
    const settle = async () => { await sleep(70); };
    const waitFor = async (predicate, message) => {
        const deadline = performance.now() + 3000;
        while (!predicate() && performance.now() < deadline) await sleep(10);
        assert(predicate(), typeof message === "function" ? message() : message);
    };
    const H = window.__harness;
    const P = window.__profile;
    const cell = (r, c) => document.querySelector(`[role=gridcell][data-row-index="${r}"][data-column-index="${c}"]`);
    const click = async (r, c, shiftKey = false) => { cell(r, c).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, shiftKey })); document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true })); await settle(); };
    const value = (r = 0, c = 2) => cell(r, c)?.textContent.trim();
    const commandCount = command => P.calls[command] || 0;
    const key = (target, key, options = {}) => target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ...options }));
    const selected = (r, c) => cell(r, c)?.getAttribute('aria-selected') === 'true';
    const input = async (el, value) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); await settle(); };
    if (mode === 'profile') {
        await H.load(size);
        await settle();
        document.querySelector('#run').click();
        // Completion is observed via the fixture's output; waits are not timings.
        while (P.runs.filter(r => r.kind === 'full-snapshot-two-raf').length < 5)
            await sleep(50);
        await settle();
        console.log('PROFILE', size, JSON.stringify(P.runs.filter(r => r.kind === 'selection-two-raf').map(r => ({ rows: r.rows, cells: r.cells }))));
        await window.happyDOM.close();
        process.exit(0);
    }
    if (mode === 'timing') {
        const { flushSync } = await import('react-dom');
        await H.load(size);
        await settle();
        const times = [];
        for (let i = 0; i < 65; i++) {
            const el = cell(0, 2 + (i % 10));
            const start = performance.now();
            flushSync(() => { el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 })); document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true })); });
            const elapsed = performance.now() - start;
            if (i >= 5)
                times.push(elapsed);
        }
        const result = { mode: 'production uninstrumented flushSync selection JS + happy-dom mutation; excludes build, waits, fixture, native IPC and paint', rows: size, times };
        if (resultPath)
            fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
        console.log('TIMING', JSON.stringify(result));
        await window.happyDOM.close();
        process.exit(0);
    }
    const reports = [];
    await H.load(83);
    await settle();
    // Real DataGridView host integration: no plain-cell layout wrapper remains.
    const base = structuredClone(H.getSnapshot());
    let hostRevision = 0;
    const replaceDisplay = async (change) => {
        const next = structuredClone(base);
        change(next);
        next.presentation.revision = `host-${++hostRevision}`;
        H.replace(next);
        await settle(); await settle();
    };
    const definition = base.table.schema.columns[1];
    const rowId = base.table.records[0].uuid;
    const presentationOf = next => next.presentation.cells[rowId][definition.uuid];
    assert(cell(0, 2).children.length === 0 && cell(0, 2).classList.contains('rdg-cell-plain-display'), 'numeric value is direct host text');
    assert(P.pureHostBuilds > 0, 'numeric route bypasses Cell components');
    const numericHost = cell(0, 2), siblingHost = cell(0, 3);
    await click(0, 2);
    assert(cell(0, 2) === numericHost && numericHost.tabIndex === 0, 'numeric mousedown selection preserves host and tab stop');
    numericHost.focus();
    numericHost.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();
    assert(cell(0, 2) === numericHost && document.activeElement === numericHost, 'click preserves numeric host focus');
    const beforePure = P.pureHostBuilds, beforeComponents = P.cellComponentRenders;
    await click(0, 3);
    assert(cell(0, 2) === numericHost && cell(0, 3) === siblingHost && numericHost.tabIndex === -1 && siblingHost.tabIndex === 0, 'selection transfer preserves both numeric hosts and roving tab stop');
    assert(P.pureHostBuilds - beforePure === 2 && P.cellComponentRenders === beforeComponents, 'row cache updates only old/new numeric hosts with no Cell component render');
    for (let i = 0; i < 4; i++) {
        key(cell(0, 3), 'ArrowLeft'); await settle();
        key(cell(0, 2), 'ArrowRight'); await settle();
    }
    assert(cell(0, 2) === numericHost && cell(0, 3) === siblingHost, 'repeated keyboard selection keeps numeric host identities');
    const numericCases = [['U8','255'],['I8','-128'],['U16','65535'],['I16','-32768'],['U32','4294967295'],['I32','-2147483648'],['U64','18446744073709551615'],['I64','-9223372036854775808'],['F32','1.25'],['F64','-1.25']];
    for (const [type, text] of numericCases) {
        await replaceDisplay(next => { next.table.schema.columns[1].data_type = type; presentationOf(next).display_value = text; });
        await waitFor(() => value().replaceAll(',', '') === text && cell(0, 2).children.length === 0, `${type} exact direct display: ${value()} ${cell(0, 2).innerHTML}`);
    }
    await replaceDisplay(next => {
        next.table.schema.columns[1].data_type = 'String';
        presentationOf(next).display_value = 'first\nsecond';
    });
    await waitFor(() => value() === '↵ first' && cell(0, 2).children.length === 0, 'unselected multiline String is direct preview');
    await click(0, 2);
    await waitFor(() => cell(0, 2).querySelector('.rdg-string-selected-text')?.textContent === '↵ first' && cell(0, 2).querySelector('.rdg-string-expand'), 'selected String retains preview and expand control');
    await replaceDisplay(next => {
        const p = presentationOf(next); p.style = { background_color: '#dbeafe', bold: false };
        p.hint = 'rule hint'; p.formula_error = { kind: 'text', text: 'formula failure' };
        p.issues = [{ kind: 'text', text: 'validation failure', mode: 'reject' }];
    });
    await waitFor(() => cell(0, 2).style.color === '#b91c1c' && cell(0, 2).style.fontWeight === '400', 'formula error red wins over background contrast and preserves explicit nonbold');
    await waitFor(() => cell(0, 2).title.includes('formula failure') && cell(0, 2).getAttribute('aria-description').includes('rule hint') && cell(0, 2).getAttribute('aria-invalid') === 'true' && cell(0, 2).style.boxShadow.includes('#dc2626'), 'readable error value retains diagnostics, ARIA and validation underline');
    await replaceDisplay(next => { presentationOf(next).style = { background_color: '#dbeafe', text_color: '#123456' }; });
    await waitFor(() => cell(0, 2).style.color === '#123456', 'explicit foreground wins over automatic contrast');
    await replaceDisplay(next => { presentationOf(next).style = { background_color: '#dbeafe' }; });
    await waitFor(() => cell(0, 2).style.color === '#000000', 'light conditional background gets dark foreground');
    // Observe asynchronous snapshot display, including an explicitly held response.
    const delayedContrast = H.deferNext('get_table_rule_snapshot');
    await replaceDisplay(next => { presentationOf(next).style = { background_color: '#101010' }; });
    await waitFor(() => delayedContrast.pending, 'conditional snapshot request reaches the response barrier');
    assert(cell(0, 2).style.color !== '#ffffff', 'pending snapshot does not expose its new conditional foreground');
    delayedContrast.release();
    await waitFor(() => cell(0, 2).style.color === '#ffffff', 'dark conditional background gets light foreground');
    await replaceDisplay(next => { presentationOf(next).formula_error = { kind: 'text', text: 'formula failure' }; });
    await waitFor(() => cell(0, 2).style.color === '#b91c1c', 'formula error red remains without conditional background');
    await replaceDisplay(next => { next.table.records[0].values[definition.data_name] = ''; });
    await waitFor(() => cell(0, 2).style.color === '#737373', 'default gray remains without conditional background');
    await replaceDisplay(() => {});
    await waitFor(() => !cell(0, 2).style.color && !cell(0, 2).style.boxShadow && !cell(0, 2).hasAttribute('aria-description') && !cell(0, 2).hasAttribute('aria-invalid'), 'cleared rules remove host styles and metadata');
    reports.push('plain host DOM, all ten numeric types including exact 64-bit, String controls, conditional contrast and diagnostic/style removal');
    console.log('HOST DISPLAY PASS', reports[0]);
    if (mode === 'host') { await window.happyDOM.close(); process.exit(0); }
    await H.load(83); await settle();
    await click(0, 2);
    let before = { rows: P.rowRenders, cells: P.cellRenders };
    await click(0, 3);
    assert(P.rowRenders - before.rows === 1 && P.cellRenders - before.cells === 2, 'same-row selection must update one row/two cells');
    assert(!selected(0, 2) && selected(0, 3), 'single selection state');
    reports.push('single selection: one row/two cells');
    before = { rows: P.rowRenders, cells: P.cellRenders };
    await click(1, 3);
    assert(P.rowRenders - before.rows === 2 && P.cellRenders - before.cells === 2, 'cross-row selection must update two rows/two cells');
    reports.push('cross-row selection: two rows/two cells');
    await click(0, 2);
    await click(2, 4, true);
    for (let r = 0; r <= 2; r++)
        for (let c = 2; c <= 4; c++)
            assert(selected(r, c), 'shift rectangle');
    assert(!selected(3, 4) && !selected(1, 5), 'outside range remains unselected');
    reports.push('shift range outlines/aria');
    await click(0, 2);
    cell(0, 2).dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', code: 'ArrowRight' }));
    await settle();
    assert(selected(0, 3), 'keyboard navigation');
    cell(0, 3).dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', code: 'ArrowDown', shiftKey: true }));
    await settle();
    assert(selected(0, 3) && selected(1, 3), 'keyboard range');
    reports.push('keyboard navigation/range');
    await click(0, 2);
    before = { rows: P.rowRenders, cells: P.cellRenders };
    // happy-dom drops the current nested color-mix() theme colors. Inspect the
    // actual Cell callback result instead of treating an empty CSSOM value as paint.
    const oldColor = P.cellBackgrounds['1:2'];
    assert(typeof oldColor === 'string' && oldColor.length > 0, 'cell requests a real background color');
    cell(1, 2).dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    await settle();
    assert(P.rowRenders - before.rows === 1, 'hover only affected row');
    assert(P.cellBackgrounds['1:2'] !== oldColor, 'hover requests a different background');
    cell(1, 2).dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await settle();
    assert(P.cellBackgrounds['1:2'] === oldColor, 'hover leave restores the requested background');
    reports.push('hover enters/leaves one row and requests/restores its background; no native CSS paint claim');

    // Real React editor/key handlers; mutation, history, save, and reads are mock IPC.
    const initial = H.getSnapshot();
    const recordUuid = initial.table.records[0].uuid;
    // Display column 0 is the row indicator; display column 2 is schema C1.
    const columnUuid = initial.table.schema.columns[1].uuid;
    const stored = () => H.getSnapshot().table.records[0].values.C1;
    const presentation = () => H.getSnapshot().presentation.cells[recordUuid][columnUuid];
    const withValue = (text, revision) => {
        const next = structuredClone(H.getSnapshot());
        next.table.records[0].values.C1 = text;
        next.presentation.cells[recordUuid][columnUuid] = { ...next.presentation.cells[recordUuid][columnUuid], raw_value: text, display_value: text };
        next.presentation.revision = revision;
        return next;
    };
    const openEditor = async () => {
        // A displayed snapshot may commit before the mutation busy gate clears.
        await waitFor(() => cell(0, 2) && cell(0, 2).getAttribute('aria-readonly') !== 'true', 'cell becomes editable');
        cell(0, 2).dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        await waitFor(() => document.querySelector('.rdg-editor-container input'), 'numeric editor opens');
        return document.querySelector('.rdg-editor-container input');
    };
    let editor = await openEditor();
    assert(editor.value === '1', `editor starts with the authoritative raw value: ${editor.value}`);
    await input(editor, '777');
    const beforeMutation = commandCount('apply_table_mutation');
    const beforeUndo = commandCount('undo_command');
    key(editor, 'z', { ctrlKey: true });
    key(editor, 'Enter', { isComposing: true });
    await settle();
    assert(commandCount('undo_command') === beforeUndo, 'editor owns Ctrl+Z, not table history');
    assert(commandCount('apply_table_mutation') === beforeMutation && document.querySelector('.rdg-editor-container input'), 'IME Enter does not commit or close editor');
    key(editor, 'Enter');
    await waitFor(() => value() === '777' && !document.querySelector('.rdg-editor-container input'), 'edit commits and closes editor');
    assert(commandCount('apply_table_mutation') === beforeMutation + 1, 'edit commits exactly once');
    assert(stored() === '777' && presentation().raw_value === '777' && presentation().display_value === '777', 'raw stored/presentation/display values match');
    const editRequest = P.requests.findLast(r => r.command === 'apply_table_mutation').args;
    assert(editRequest.expectedProjectSession === 'profile'
        && editRequest.request.table_uuid === initial.table.uuid
        && editRequest.request.expected_revision === initial.presentation.revision
        && editRequest.request.cells.length === 1
        && editRequest.request.cells[0].record_uuid === recordUuid
        && editRequest.request.cells[0].column_uuid === columnUuid
        && editRequest.request.cells[0].value === '777', 'editor sends exact UUID/session/revision-bound draft');
    editor = await openEditor();
    assert(editor.value === '777', 'reopening editor shows new raw value');
    await input(editor, '999');
    key(editor, 'Escape');
    await settle();
    assert(commandCount('apply_table_mutation') === beforeMutation + 1 && value() === '777' && stored() === '777' && !document.querySelector('.rdg-editor-container'), 'Escape discards changed draft without mutation');
    reports.push('real numeric editor + IME Enter/Escape cancel + exact mock mutation UUID/session/revision and raw/display value');

    await click(0, 2);
    let saves = commandCount('save_project');
    let reads = commandCount('get_table_rule_snapshot');
    await waitFor(() => document.querySelector('button[title*="Ctrl+Z"]')?.disabled === false, 'Undo availability reaches the displayed snapshot');
    key(cell(0, 2), 'z', { ctrlKey: true });
    await waitFor(() => value() === '1', 'Ctrl+Z restores original displayed value');
    assert(commandCount('undo_command') === beforeUndo + 1 && commandCount('save_project') === saves && commandCount('get_table_rule_snapshot') > reads, 'Undo refreshes after the atomically persisted history ACK without a redundant project save');
    assert(stored() === '1' && presentation().raw_value === '1', 'Undo restores mock authoritative raw value');
    const undoRequest = P.requests.findLast(r => r.command === 'undo_command').args;
    assert(undoRequest.tableUuid === initial.table.uuid && undoRequest.expectedProjectSession === 'profile', 'Undo targets UUID and session');
    saves = commandCount('save_project'); reads = commandCount('get_table_rule_snapshot');
    const redos = commandCount('redo_command');
    await waitFor(() => document.querySelector('button[title*="Ctrl+Shift+Z"]')?.disabled === false, 'Redo availability reaches the displayed snapshot');
    key(cell(0, 2), 'y', { ctrlKey: true });
    await waitFor(() => value() === '777', () => 'Ctrl+Y restores edited displayed value: ' + JSON.stringify({calls:P.calls,redoDisabled:document.querySelector('button[title*="Ctrl+Shift+Z"]')?.disabled,value:value(),stored:stored(),raw:presentation()?.raw_value,alert:document.querySelector('[role=alert]')?.textContent}));
    assert(commandCount('redo_command') === redos + 1 && commandCount('save_project') === saves && commandCount('get_table_rule_snapshot') > reads, 'Redo refreshes after the atomically persisted history ACK without a redundant project save');
    assert(stored() === '777' && presentation().raw_value === '777', 'Redo restores mock authoritative raw value');
    reports.push('Ctrl+Z/Ctrl+Y: mock persisted history + refreshed snapshot restore exact values');

    // A newly enabled history control must have the same committed keyboard
    // behavior before passive effects get a later turn.
    await waitFor(() => document.querySelector('button[title*="Ctrl+Z"]')?.disabled === false, 'Undo is available before commit-boundary test');
    await settle();
    const raceUndoCount = commandCount('undo_command');
    const raceRedoCount = commandCount('redo_command');
    let redoAtCommit = false;
    const historyObserver = new window.MutationObserver(() => {
        if (redoAtCommit || value() !== '1' || document.querySelector('button[title*="Ctrl+Shift+Z"]')?.disabled !== false) return;
        redoAtCommit = true;
        key(cell(0, 2), 'y', { ctrlKey: true });
    });
    historyObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    try {
        key(cell(0, 2), 'z', { ctrlKey: true });
        await waitFor(() => redoAtCommit, () => 'Redo becomes available at the committed display: ' + JSON.stringify({calls:P.calls,value:value(),undoDisabled:document.querySelector('button[title*="Ctrl+Z"]')?.disabled,redoDisabled:document.querySelector('button[title*="Ctrl+Shift+Z"]')?.disabled}));
        await waitFor(() => value() === '777', () => 'First keyboard input at enabled Redo commit is honored: ' + JSON.stringify({ calls:P.calls, value:value(), redoAtCommit }));
        assert(commandCount('undo_command') === raceUndoCount + 1 && commandCount('redo_command') === raceRedoCount + 1,
            'commit-boundary history input is not dropped or duplicated');
        assert(stored() === '777' && presentation().raw_value === '777', 'commit-boundary redo keeps authoritative value');
    } finally { historyObserver.disconnect(); }
    reports.push('history keyboard callbacks match newly enabled controls before passive effects');


    // Hold an old-session mutation after the mock backend accepts it. The real
    // mutation hook must ignore its response and release the new session's gate.
    editor = await openEditor();
    await input(editor, '888');
    const lateMutation = H.deferNext('apply_table_mutation');
    key(editor, 'Enter');
    await waitFor(() => lateMutation.pending, 'old-session mutation is pending');
    const beforeSessionDeliveries = P.deliveries.length;
    H.setSession('second-session', withValue('222', 'second-session-r0'));
    await waitFor(() => value() === '222', 'new session snapshot displays');
    assert(!document.querySelector('[role=gridcell][aria-selected=true]') && !document.querySelector('.rdg-editor-container'), 'new session resets selection/editor state');
    lateMutation.release();
    await settle(); await settle();
    assert(value() === '222' && !P.deliveries.slice(beforeSessionDeliveries).some(r => r.observedValue === '888'), 'late old-session mutation never overwrites or notifies new session');
    editor = await openEditor();
    await input(editor, '333');
    key(editor, 'Enter');
    await waitFor(() => value() === '333', 'new session can edit after old mutation finishes');
    const newRequest = P.requests.findLast(r => r.command === 'apply_table_mutation').args;
    assert(newRequest.expectedProjectSession === 'second-session' && newRequest.request.expected_revision === 'second-session-r0', 'new mutation uses only the new session/revision');
    reports.push('same table UUID session switch resets editor/selection; late mock mutation ignored; new edit works');

    // A pending old-session read may return a complete snapshot after switching.
    // The real presentation hook must discard it and refresh the latest session.
    const lateRead = H.deferNext('get_table_rule_snapshot');
    H.replace(withValue('444', 'old-session-read'));
    await waitFor(() => lateRead.pending, 'old-session snapshot read is pending');
    const beforeReadDeliveries = P.deliveries.length;
    H.setSession('third-session', withValue('555', 'third-session-r0'));
    await settle();
    lateRead.release();
    await waitFor(() => value() === '555', 'new session displayed after stale snapshot completes');
    await settle();
    assert(!P.deliveries.slice(beforeReadDeliveries).some(r => r.observedValue === '444'), 'stale snapshot never reaches onDataChange');
    const freshRead = P.requests.findLast(r => r.command === 'get_table_rule_snapshot').args;
    assert(freshRead.expectedProjectSession === 'third-session' && freshRead.knownSnapshotToken === null, 'new session does not reuse old snapshot token');
    reports.push('late old-session mock snapshot rejected; trailing read uses new session and no old snapshot token');
    const lateUnchangedRead = H.deferNext('get_table_rule_snapshot');
    window.dispatchEvent(new window.CustomEvent('table-data-changed', { detail: { projectSession: 'third-session', tableUuid: initial.table.uuid } }));
    await waitFor(() => lateUnchangedRead.pending, 'conditional unchanged read is pending');
    assert(lateUnchangedRead.response?.kind === 'unchanged', 'mock conditional read returns unchanged for exact known snapshot token');
    const beforeNullDeliveries = P.deliveries.length;
    H.setSession('fourth-session', withValue('666', 'fourth-session-r0'));
    await settle();
    lateUnchangedRead.release();
    await waitFor(() => value() === '666' && cell(0, 2).getAttribute('aria-readonly') !== 'true', 'new session becomes editable after stale null response');
    assert(!P.deliveries.slice(beforeNullDeliveries).some(r => r.observedValue === '555'), 'stale null read never redelivers previous session');
    editor = await openEditor();
    assert(editor.value === '666', 'raw editor uses new session snapshot after stale null');
    await input(editor, '667');
    key(editor, 'Enter');
    await waitFor(() => value() === '667', 'editing works after discarded stale null');
    const afterNullRequest = P.requests.findLast(r => r.command === 'apply_table_mutation').args;
    assert(afterNullRequest.expectedProjectSession === 'fourth-session' && afterNullRequest.request.expected_revision === 'fourth-session-r0', 'stale null cannot restore old session revision');
    reports.push('late conditional null mock read rejected; new editor commits with current session/revision');
    await H.load(10000);
    await settle();
    assert(!document.querySelector('.rdg').textContent.includes('299999'), 'last cell starts offscreen');
    const search = document.querySelector('input[type=text]');
    await input(search, '299999');
    assert(document.querySelectorAll('.rdg-row').length === 1, 'all-row search finds offscreen final cell');
    assert(document.querySelector('.rdg-row').textContent.includes('Row 10000'), 'matched final row');
    assert(cell(0, 0).querySelector('span').textContent.replaceAll(',', '') === '10000', 'original row number preserved');
    await click(0, 2);
    cell(0, 2).dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', code: 'ArrowRight' }));
    await settle();
    assert(selected(0, 3), 'filtered keyboard navigation');
    reports.push('10000-row full search finds offscreen column/row; filtered navigation');
    await input(search, '');
    let next = H.getSnapshot();
    next = { ...next, table: { ...next.table, records: [...next.table.records].reverse() }, presentation: { ...next.presentation, revision: 'reordered' } };
    H.replace(next);
    await settle();
    await settle();
    assert(document.querySelector('.rdg-row').textContent.includes('Row 10000'), 'reordered snapshot first row');
    await input(search, 'Row 1');
    assert(document.querySelector('.rdg-row').textContent.includes('Row 10000'), 'filter preserves reordered snapshot order');
    await click(0, 2);
    cell(0, 2).dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', code: 'ArrowDown' }));
    await settle();
    assert(selected(1, 2), 'reordered filtered navigation');
    reports.push('reordered snapshot + filter + keyboard navigation');
    console.log('REGRESSION PASS', JSON.stringify(reports));
    await window.happyDOM.close();
    process.exit(0);
}
