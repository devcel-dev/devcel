// Portable regression for the real CSV exporters, commands, and export dialogs.
// Uses a synthetic table and native I/O boundaries. Native WebKit QA is separate.
// Run: npm run check:csv-encoding -- [optional-report.json]
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { Window } from 'happy-dom';
const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
(async () => {
    const window = new Window({ url: 'http://csv-encoding.invalid' });
    for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'DOMRect', 'DocumentFragment', 'HTMLButtonElement', 'SVGElement', 'PointerEvent', 'FocusEvent'])
        Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
    for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
        globalThis[name] = window[name].bind(window);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = window.ResizeObserver = class {
        observe() { }
        disconnect() { }
        unobserve() { }
    };
    const column = (data_name, data_type = 'String') => ({ min_version: 0,
        uuid: `column-${data_name}`, display_name: data_name, data_name, data_type,
        tooltip: '', tags: [], read_only: false, default_value: '', memo_text: '', reference_config: null,
        style: { color: '#FFFFFF', font_size: 12, width: 100 }
    });
    const table = {
        description: '',
        uuid: 'table-csv', display_name: 'CSV fixture', metadata: { interface_order: [],  initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, parent_uuid: '', data_name: 'csv_fixture' },
        interface_implementations: {}, schema: { columns: [column('key'), column('name'), column('target_count', 'I64'), column('gold', 'I64'), column('power', 'I64'), column('objective'), column('target_equipment', 'Reference')] },
        records: [{ uuid: 'record-csv', parent_uuid: '', label: '', min_version: 0, tags: [],
                values: { key: 'craft_staff', name: '森の安全を守る, "Artisan"', target_count: '1', gold: '30', objective: 'craft', target_equipment: '8d592471-a0ce-4e16-aca7-247075c7ff0e' },
                interface_values: {}, memo_texts: {} }]
    };
    const messages = JSON.parse(fs.readFileSync(path.join(studio, 'src/app/i18n/generated/catalog.json'), 'utf8')).messages.ja;
    const pluginMessages = JSON.parse(fs.readFileSync(path.join(studio, 'src/app/settings/generated/catalog.json'), 'utf8')).pluginTranslations['csv-exporter'].ja;
    const bridge = globalThis.__csvCheck = { table, messages, pluginMessages, writes: [], dialogs: [], saves: [], closed: [], commands: new Map(), options: {}, defaultEncoding: 'utf-8', exporters: [] };
    const mocks = {
        '@/app/i18n': `const b=globalThis.__csvCheck;export const t=(key,args)=>{if(!b.messages[key])throw Error('Missing '+key);return b.messages[key].replace(/\\{(\\w+)\\}/g,(_,x)=>String(args?.[x]??'{'+x+'}'));};export const translatePluginMessage=(_,key,args)=>{const text=b.pluginMessages[key];if(!text)throw Error('Missing plugin '+key);return text.replace(/\\{(\\w+)\\}/g,(_,x)=>String(args?.[x]??'{'+x+'}'));};export const useI18n=()=>({t,locale:'ja'});export const message=(key,args)=>({key,args});export const localizedError=d=>new Error(t(d.key,d.args));export const localizeError=e=>e.message||String(e);export const toAppError=e=>e;`,
        '@/app/contexts/PluginContext': `export const useExporters=()=>globalThis.__csvCheck.exporters;export const usePlugins=()=>({dialogs:[],themes:[],importers:[],dataProcessors:[]});export const useToolbarButtons=()=>[];export const useContextMenus=()=>[];export const useSidePanels=()=>[];`,
        '@/app/services/PluginManager': `export class PluginManager{static getInstance(){return {getAPI(){return {}}}}}`,
        '@tauri-apps/api/core': `export const invoke=async(name,args)=>{const b=globalThis.__csvCheck;if(args.expectedProjectSession!=='session-encoding-test')throw Error('Bad session');if(name==='lint_project_export')return [];if(name==='get_table_data'){if(args.uuid!==b.table.uuid)throw Error('Bad UUID');return b.table;}throw Error('Unexpected '+name)};`,
        '@tauri-apps/plugin-fs': `export const writeTextFile=async(path,content)=>globalThis.__csvCheck.writes.push({path,content});export const writeFile=writeTextFile;export const readFile=async()=>{throw Error('unexpected read')};`,
        '@tauri-apps/plugin-dialog': `export const save=async options=>{globalThis.__csvCheck.saves.push(options);return '/fixture/existing.csv'};export const message=async(...args)=>globalThis.__csvCheck.dialogs.push(args);export const ask=async()=>true;export const open=async()=>null;`,
        '@/app/services/appDialogs': `export const save=async options=>{globalThis.__csvCheck.saves.push(options);return '/fixture/existing.csv'};export const message=async(...args)=>globalThis.__csvCheck.dialogs.push(args);export const ask=async()=>true;export const open=async()=>null;export const appAlert=message;export const appConfirm=ask;export const appPrompt=async(...args)=>globalThis.prompt?.(...args)??null;`,
        '@tauri-apps/api/webviewWindow': `export const getCurrentWebviewWindow=()=>({close:async()=>globalThis.__csvCheck.closed.push(true)});`,
        'react-router-dom': `export const useSearchParams=()=>[new URLSearchParams({uuid:globalThis.__csvCheck.table.uuid,expectedProjectSession:'session-encoding-test'})];`
    };
    const build = await esbuild.build({ stdin: { contents: `export {default as csv} from './src/app/plugins/examples/CSVExporterPlugin';export {default as ExportDialog} from './src/app/pages/export_dialog/ExportDialog';export {AdvancedCSVExportDialog} from './src/app/plugins/examples/components/AdvancedCSVExportDialog';export * as React from 'react';export {createRoot} from 'react-dom/client';`, resolveDir: studio, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, tsconfig: path.join(studio, 'tsconfig.json'), plugins: [{ name: 'native-boundaries', setup(b) { b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : null); b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js', resolveDir: studio })); } }] });
    const module = { exports: {} };
    new Function('module', 'exports', 'require', build.outputFiles[0].text)(module, module.exports, require);
    const { csv, ExportDialog, AdvancedCSVExportDialog, React, createRoot } = module.exports;
    bridge.exporters = csv.extensions.exporters;
    const results = [];
    const check = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name); };
    const expected = 'key,name,target_count,gold,power,objective,target_equipment\ncraft_staff,"森の安全を守る, ""Artisan""",1,30,,craft,8d592471-a0ce-4e16-aca7-247075c7ff0e';
    await check('Both exporters retain Japanese/quoted UTF-8 output and reject all explicit unsupported encodings', async () => {
        for (const exporter of bridge.exporters) {
            assert.match(await exporter.export(table), /森の安全を守る/);
            assert.match(await exporter.export(table, { encoding: 'utf-8' }), /森の安全を守る/);
            for (const encoding of ['shift-jis', 'euc-jp', 'utf-16', 'UTF-8', '', null, 0])
                await assert.rejects(exporter.export(table, { encoding }), /UTF-8/);
        }
        assert.equal(await bridge.exporters[0].export(table, { encoding: 'utf-8' }), expected);
    });
    await check('CSV resolves parent cells, raw values, and parentless column defaults', async () => {
        const sample = structuredClone(table);
        sample.schema.columns = [{ ...column('value'), default_value: 'column default' }];
        const base = sample.records[0];
        sample.records = [
            { ...base, uuid: 'parent', values: { value: 'parent text' }, },
            { ...base, uuid: 'child', parent_uuid: 'parent', values: {}, },
            { ...base, uuid: 'empty', parent_uuid: 'parent', values: { value: '' }, },
            { ...base, uuid: 'default', parent_uuid: '', values: {} }
        ];
        for (const exporter of bridge.exporters)
            assert.equal(await exporter.export(sample, { includeHeaders: false }), 'parent text\nparent text\nparent text\ncolumn default');
    });
    await check('Both exporters reuse one scoped resolver for 20,000-row deep chains and 100 columns', async () => {
        const columns = Array.from({ length:100 }, (_, i) => column(`field${i}`));
        const rootValues = Object.fromEntries(columns.map(c => [c.data_name, 'value']));
        let reads = 0;
        const records = Array.from({ length:20000 }, (_, i) => ({ uuid:`row${i}`, parent_uuid:i ? `row${i-1}` : '', interface_values:{}, get values() { reads++; return i ? {} : rootValues; } })).reverse();
        const sample = { ...table, schema:{columns}, records };
        for(const exporter of bridge.exporters) {
            reads=0; const output=await exporter.export(sample,{includeHeaders:false});
            assert.equal(output.split('\n').length,20000); assert(reads <= 20000*100*2, `Nonlinear cell reads: ${reads}`);
        }
        rootValues.field0='updated';
        assert((await bridge.exporters[0].export(sample,{includeHeaders:false})).startsWith('updated,'),'A later export rebuilds its resolver after parent edits');
    });
    await check('CSV retains exact signed/unsigned 64-bit integers in every number format', async () => {
        for (const [kind, value] of [['U64', '18446744073709551615'], ['I64', '-9223372036854775808'], ['I64', '9007199254740993']]) {
            const sample = structuredClone(table);
            sample.schema.columns = [column('value', kind)];
            sample.records[0].values = { value };
            for (const exporter of bridge.exporters) for (const numberFormat of ['auto', 'decimal-dot', 'decimal-comma'])
                assert.equal(await exporter.export(sample, { includeHeaders: false, numberFormat }), value);
        }
    });
    await check('Custom CSV quote characters are escaped literally, including regex metacharacters', async () => {
        for (const quoteChar of ['[', '.', '*', '$', '\\']) {
            const sample = structuredClone(table);
            sample.schema.columns = [column('value')];
            sample.records[0].values = { value: `a${quoteChar}b,cd` };
            assert.equal(await bridge.exporters[1].export(sample, { includeHeaders: false, quoteChar, escapeChar: '!' }), `${quoteChar}a!${quoteChar}b,cd${quoteChar}`);
        }
    });
    await check('Both exporters quote CR, LF and CRLF in headers and cell inputs without normalization', async () => {
        for (const newline of ['\r', '\n', '\r\n']) {
            const sample = structuredClone(table);
            sample.schema.columns = [{ ...column('value'), display_name: `header${newline}end` }];
            sample.records[0].values = { value: `first${newline}last` };
            for (const exporter of bridge.exporters) {
                assert.equal(await exporter.export(sample), `"header${newline}end"\n"first${newline}last"`);
            }
        }
    });
    await check('Basic schema declares only UTF-8', async () => { assert.deepEqual(bridge.exporters[0].getOptions().find(x => x.name === 'encoding').options, [{ value: 'utf-8', label: 'UTF-8' }]); });
    const api = { app: { getState: () => ({ activeTable: { uuid: table.uuid, projectSession: 'session-encoding-test' } }) }, data: { getTable: async (uuid, session) => { assert.equal(uuid, table.uuid); assert.equal(session, 'session-encoding-test'); return table; } }, settings: { getTable: id => { assert.equal(id,'settings'); return { defaultDelimiter:',', defaultEncoding:bridge.defaultEncoding }; } }, ui: { registerCommand: (id, fn) => bridge.commands.set(id, fn), showSaveDialog: async () => { bridge.saves.push('command'); return '/fixture/existing.csv'; }, showNotification: () => { }, showModal: async () => bridge.options }, fs: { writeFile: async (path, content) => bridge.writes.push({ path, content }) } };
    await csv.hooks.onActivate(api);
    await check('Basic command rejects stale saved encoding without opening save or touching existing output', async () => {
        bridge.defaultEncoding = 'shift-jis';
        const count = bridge.writes.length, saves = bridge.saves.length;
        await assert.rejects(bridge.commands.get('csv.exportBasic')(), /UTF-8/);
        assert.equal(bridge.writes.length, count);
        assert.equal(bridge.saves.length, saves);
        bridge.defaultEncoding = 'utf-8';
        await bridge.commands.get('csv.exportBasic')();
        assert.equal(bridge.writes.at(-1).content, expected);
    });
    await check('Advanced command rejects stale/manual options before save and retries successfully', async () => {
        bridge.options = { encoding: 'euc-jp' };
        const count = bridge.writes.length, saves = bridge.saves.length;
        await assert.rejects(bridge.commands.get('csv.exportAdvanced')(), /UTF-8/);
        assert.equal(bridge.writes.length, count);
        assert.equal(bridge.saves.length, saves);
        bridge.options = { encoding: 'utf-8' };
        await bridge.commands.get('csv.exportAdvanced')();
        assert.match(bridge.writes.at(-1).content, /森の安全を守る/);
    });
    const host = document.createElement('div');
    document.body.append(host);
    const componentRoot = createRoot(host);
    const settle = async () => React.act(async () => { await new Promise(r => setTimeout(r, 20)); });
    await check('Actual AdvancedCSVExportDialog offers only UTF-8 and confirms UTF-8', async () => {
        let confirmed;
        await React.act(async () => componentRoot.render(React.createElement(AdvancedCSVExportDialog, { onConfirm: x => confirmed = x })));
        const encoding = host.querySelector('#encoding');
        assert(encoding);
        assert.equal(encoding.textContent, 'UTF-8');
        await React.act(async () => encoding.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
        await settle();
        const optionTexts = [...document.querySelectorAll('[role="option"]')].map(x => x.textContent);
        assert.deepEqual(optionTexts, ['UTF-8']);
        await React.act(async () => document.querySelector('[role="option"]').click());
        await settle();
        await React.act(async () => [...host.querySelectorAll('button')].find(x => x.textContent === messages['export.action']).click());
        assert.equal(confirmed.encoding, 'utf-8');
    });
    await React.act(async () => componentRoot.render(React.createElement(ExportDialog)));
    await settle();
    const change = async (select, value) => React.act(async () => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await check('Actual ExportDialog handles UTF-8, stale option failure, then corrected retry without losing protection', async () => {
        await change(host.querySelector('select'), 'csv-basic');
        const radios = [...host.querySelectorAll('input[type="radio"]')];
        assert(radios.length === 2);
        await React.act(async () => radios[1].click());
        let encoding = [...host.querySelectorAll('select')].find(x => [...x.options].some(o => o.text === 'UTF-8'));
        assert.deepEqual([...encoding.options].map(x => x.value), ['utf-8']);
        // Simulate stale/manual state through the actual input event, while keeping the product schema unchanged.
        const injected = document.createElement('option');
        injected.value = 'shift-jis';
        injected.textContent = 'stale';
        encoding.append(injected);
        await change(encoding, 'shift-jis');
        const before = bridge.writes.length;
        let button = [...host.querySelectorAll('button')].find(x => x.textContent.includes(messages['export.action']));
        assert(button);
        await React.act(async () => button.click());
        await settle();
        assert.equal(bridge.writes.length, before);
        assert.match(bridge.dialogs.at(-1)[0], /UTF-8/);
        assert(!button.disabled);
        // Existing format switching clears stale options and permits default UTF-8.
        await change(host.querySelector('select'), 'csv-advanced');
        await React.act(async () => button.click());
        await settle();
        assert.equal(bridge.writes.length, before + 1);
        assert.match(bridge.writes.at(-1).content, /森の安全を守る/);
        await change(host.querySelector('select'), 'csv-basic');
        encoding = [...host.querySelectorAll('select')].find(x => [...x.options].some(o => o.text === 'UTF-8'));
        await change(encoding, 'utf-8');
        await React.act(async () => button.click());
        await settle();
        assert.equal(bridge.writes.length, before + 2);
        assert.equal(bridge.writes.at(-1).content, expected);
        assert(bridge.closed.length > 0);
    });
    await React.act(async () => componentRoot.unmount());
    await window.happyDOM.close();
    const report = { passed: results.length, tests: results, skipped: 0, scope: 'Real CSVExporterPlugin, AdvancedCSVExportDialog, ExportDialog, and PluginOptions; synthetic table, DOM, and native I/O. Native WebKit QA remains separate.' };
    if (process.argv[2])
        fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    delete globalThis.__csvCheck;
    esbuild.stop();
    // Radix animation timers remain after the synthetic DOM has closed.
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
