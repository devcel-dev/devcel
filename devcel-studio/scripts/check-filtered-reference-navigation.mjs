import { installPhysicalGridGeometry } from './physical-grid-geometry.mjs';
// Production ProjectView -> TableTabView -> FileViewRegistry -> DataGridView ->
// ReferenceCellRenderer/DataGrid, with real React effects and synthetic DOM geometry.
// IPC, unrelated editors and sidebar rendering are boundary fixtures, not native QA.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { IntlMessageFormat } from 'intl-messageformat';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.reference-navigation-check-'));
const reports = [], calls = [], dialogs = [], scrolls = [];
const messages = JSON.parse(await readFile(resolve(project, 'src/app/i18n/generated/catalog.json'), 'utf8')).messages.ja;
const t = (key, values) => { assert(Object.hasOwn(messages, key), key); return String(new IntlMessageFormat(messages[key], 'ja', undefined, { ignoreTag: true }).format(values)); };
const notice = (key, values) => ({ key, values });
const resolveMessage = value => typeof value === 'string' ? value : t(value.key, value.values);
const window = new Window({ url: 'http://reference-navigation.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver', 'CSS', 'localStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = window.ResizeObserver = class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} unobserve() {} };
Object.defineProperties(window.HTMLElement.prototype, {
  offsetWidth: { configurable: true, get() { return 900; } },
  clientWidth: { configurable: true, get() { return 900; } },
  offsetHeight: { configurable: true, get() { return this.classList.contains('rdg') ? Number.parseFloat(this.style.height) || 400 : 400; } },
  clientHeight: { configurable: true, get() { return this.offsetHeight; } }
});
const scrollerOf = element => { for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.style.overflow === 'auto') return parent; return null; };
window.HTMLElement.prototype.getBoundingClientRect = function() { return new window.DOMRect(0, this.classList.contains('rdg') ? -(scrollerOf(this)?.scrollTop || 0) : 0, this.offsetWidth, this.offsetHeight); };
window.HTMLElement.prototype.scrollIntoView = () => { throw Error('Grid navigation must scroll its physical owner'); };
const { ownerOf: physicalOwner } = installPhysicalGridGeometry(window, { width: 900, height: 400, scrolls });
const column = (name, type = 'String', target) => ({ min_version: 0, uuid: name, data_name: name, display_name: name, data_type: type, read_only: false, default_value: '', tags: [], tooltip: '', memo_text: '', reference_config: target ? { target_table_uuid: target, display_column_uuid: 'name' } : null, style: { width: 220, color: '#ffffff', font_size: 12 } });
const makeTable = (id, count, columns) => ({ uuid: id, display_name: id , metadata: { interface_order: [],  initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, data_name: id }, schema: { columns }, records: Array.from({ length: count }, (_, index) => ({ uuid: `${id}-${index + 1}`, label: `${id} ${index + 1}`, values: { name: `${id} ${index + 1}` }, interface_values: {}, min_version: 1, tags: [] })), interface_implementations: {}, });
const tables = {
  quests: makeTable('quests', 12668, [column('name'), column('target_equipment', 'Reference', 'equipment')]),
  equipment: makeTable('equipment', 1200, [column('name'), column('next_equipment', 'Reference', 'equipment')])
};
tables.quests.records[12].label = 'Marsh Artisan';
tables.quests.records[12].values = { name: 'Marsh Artisan', target_equipment: 'equipment-111' };
tables.equipment.records[110].label = 'Marsh Sling';
tables.equipment.records[110].values = { name: 'Marsh Sling', next_equipment: 'equipment-900' };
tables.equipment.records[899].values.next_equipment = 'equipment-111';
const files = Object.keys(tables).map(id => ({ id: `${id}.table.toml`, path: `${id}.table.toml`, name: `${id}.table.toml`, type: 'table', uuid: id }));
let evaluationSequence = 0;
const evaluations = new Map();
let session = 'session-A', delayedPath, delayedLoad, failFlush = false;
const snapshot = id => ({ table: tables[id], presentation: { table_uuid: id, revision: 'revision', definition_issues: [], issue_count: 0, cells: {} } });
const invoke = async (command, args = {}) => {
  calls.push({ command, args });
  assert.equal(args.expectedProjectSession, session, `session-bound IPC: ${command}`);
  switch (command) {
    case 'get_table_path_by_uuid': if (delayedPath) return delayedPath.promise; return tables[args.tableUuid] ? `${args.tableUuid}.table.toml` : '';
    case 'get_table_list': return files;
    case 'get_table_data': if (delayedLoad && args.uuid === 'equipment') await delayedLoad.promise; return tables[args.uuid];
    case 'prepare_table_rule_snapshot': {
      assert(tables[args.tableUuid], 'snapshot registration table exists');
      const id = `reference-evaluation-${++evaluationSequence}`;
      evaluations.set(id, { tableUuid: args.tableUuid, session: args.expectedProjectSession });
      return id;
    }
    case 'cancel_table_rule_snapshot': {
      const evaluation = evaluations.get(args.evaluationId);
      if (!evaluation) return false;
      assert.deepEqual(evaluation, { tableUuid: args.tableUuid, session: args.expectedProjectSession });
      evaluations.delete(args.evaluationId);
      return true;
    }
    case 'get_table_rule_snapshot': {
      assert.deepEqual(evaluations.get(args.evaluationId),
        { tableUuid: args.tableUuid, session: args.expectedProjectSession }, 'registered evaluation identity');
      evaluations.delete(args.evaluationId);
      return { kind: 'snapshot', snapshot_token: null, retained_bytes: 1024, ...snapshot(args.tableUuid) };
    }
    case 'check_and_apply_interface_updates': return 'ok';
    case 'get_interfaces': return '[]';
    default: throw Error(`Unexpected IPC ${command}`);
  }
};
const boundary = globalThis.__referenceNavigationTest = { t, notice, resolveMessage, invoke, dialogs, files, tables, get session() { return session; }, flush: async () => { if (failFlush) throw Error('save blocked'); }, sidebarSelection: null, sidebarProps: null };
const mocks = {
  '@/app/i18n': `export { appErrorException, applyPluginTranslationTables, getLocaleName, translatePluginMessage } from ${JSON.stringify(resolve(project, 'src/app/i18n/index.ts'))}; const b=globalThis.__referenceNavigationTest; export const t=b.t; export const getLocale=()=> 'ja'; export const useI18n=()=>({t,locale:getLocale()}); export const message=b.notice; export const resolveMessage=b.resolveMessage; export const localizeError=v=>v?.key?b.resolveMessage(v):String(v||''); export const localizedError=localizeError; export const toAppError=v=>({kind:'text',text:String(v)}); export const formatNumber=v=>String(v); export const getLocaleDirection=()=> 'ltr'; export const matchLocale=()=> 'ja'; export const applyRuntimeLocalization=()=>{};`,
  '@tauri-apps/api/core': `export const invoke=(...args)=>globalThis.__referenceNavigationTest.invoke(...args); export const isTauri=()=>false;`,
  '@tauri-apps/api/event': `export const listen=async()=>()=>{}; export const emit=async()=>{}; export const emitTo=async()=>{};`,
  '@tauri-apps/plugin-dialog': `export const message=async(...args)=>globalThis.__referenceNavigationTest.dialogs.push(args);`,
  '@/app/services/appDialogs': `export const message=async(...args)=>globalThis.__referenceNavigationTest.dialogs.push(args);export const ask=async()=>false;export const appAlert=message;export const appConfirm=ask;export const appPrompt=async(...args)=>globalThis.prompt?.(...args)??null;`,
  'react-dnd': `export const useDrag=()=>[{},()=>{},()=>{}]; export const useDrop=()=>[{},()=>{}];`,
  '@/app/commands/tableCommands': `export const publishTableDisplayName=()=>{}; export const getTableCatalog=async()=>globalThis.__referenceNavigationTest.files; export const loadTable=async()=> 'ok'; export const isTableLoadingSessionCurrent=id=>id===globalThis.__referenceNavigationTest.session;`,
  '@/app/utils/string_editor_window':`export const requestCloseStringEditor=async()=>true;export const showStringEditor=async()=>{};export const registerMainWindowCloseBlocker=()=>()=>{};`,
  '@/app/utils/markdownSaveLifecycle': `export const flushMarkdownEdits=(...args)=>globalThis.__referenceNavigationTest.flush(...args);`,
  '@/app/services/PluginManager': `export class PluginManager { static getInstance(){return {setActiveTable(){}}} }`,
  './components/FileHeader': `import React from 'react'; export const getDisplayTitle=item=>item.name; export const FileHeader=({currentItem})=>React.createElement('h2',{'data-test-header':true},currentItem.name);`,
  '/file_browser_view/FileBrowserView': `import React from 'react'; const b=globalThis.__referenceNavigationTest; export const FileBrowserView=React.forwardRef((props,ref)=>{ b.sidebarProps=props; const [selected,setSelected]=React.useState(null); React.useImperativeHandle(ref,()=>({selectFileInTree(id){b.sidebarSelection=id;setSelected(id);}})); return React.createElement('nav',{},b.files.map(file=>React.createElement('button',{key:file.id,'data-file':file.uuid,'aria-pressed':selected===file.id,onClick:()=>{props.onNavigate();setSelected(file.id);props.onFileSelect(file);}},file.name))); });`,
  '@/app/components/StatusBar': `export const StatusBar=()=>null;`,
  '@/app/components/P2PToast': `export const P2PToastContainer=()=>null;`,
  '/properties_panel/PropertiesPanel': `export const PropertiesPanel=()=>null;`,
  '@/app/components/interface/DuplicateInterfaceDetector': `export const DuplicateInterfaceDetector=()=>null;`,
  './MarkdownView': `export const MarkdownView=()=>null;`,
  './InterfaceView': `export const InterfaceView=()=>null;`,
  '@/app/components/column-editor/ColumnEditor': `export const ColumnEditor=()=>null;`,
  '@/app/components/interface/InterfaceDialog': `export const InterfaceDialog=()=>null;`,
  './DataGridContextMenu': `export const DataGridContextMenu=()=>null;`,
  './DataGridInlineDialogs': `export const InlineEditDialog=()=>null;`,
  './DataGridAdvancedCells': `export { InsertionHeader, interfaceOriginLabel } from ${JSON.stringify(resolve(project, 'src/app/pages/main_window/project_view/table_view/components/DataGridAdvancedCells.tsx'))}; import React from 'react'; export const createAdvancedHeaderCell=p=>React.createElement('span',{},p.column?.name); export const createAdvancedRowCell=p=>React.createElement('span',{},p.rowIndex+1);`,
  './useDataGridColumnWidth': `const width=(id,fallback)=>fallback; const noop=()=>{}; export const useDataGridColumnWidth=()=>({getColumnWidth:width,queueColumnWidth:noop,flushColumnWidths:noop});`,
  './useTableMutation': `const noop=()=>{}; export const useTableMutation=()=>({busy:false,error:null,clearError:noop,isBusy:()=>false,run:noop,runExclusive:noop});`,
  './useReferenceOptions': `export const useReferenceOptions=({column})=>{const table=globalThis.__referenceNavigationTest.tables[column.reference_config?.target_table_uuid];const options=(table?.records||[]).map(r=>({uuid:r.uuid,display_value:r.label}));return {data:{options,byUuid:new Map(options.map((option,index)=>[option.uuid,{option,index}]))},loading:false,failed:false,refreshing:false,refresh(){}}};`,
  '@linaria/core': `export const css=()=> 'synthetic-css';`
};
let root, React;
try {
  const result = await build({ absWorkingDir: project, stdin: { contents: `export { default as ProjectView } from './src/app/pages/main_window/project_view/ProjectView'; export { default as DataGridView } from './src/app/pages/main_window/project_view/table_view/components/DataGridView'; export { default as ScrollToCell } from './src/lib/react-data-grid/ScrollToCell'; export { DataGridViewportContext } from './src/lib/react-data-grid/DataGridViewportContext';`, resolveDir: project, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false, define: { 'import.meta.env.DEV': 'false' }, alias: { '@': resolve(project,'src') }, plugins: [{ name:'boundaries',setup(builder) {
    builder.onResolve({filter:/.*/}, args => { const key=Object.keys(mocks).find(key=>args.path===key || key.startsWith('/')&&args.path.endsWith(key)); if(key)return {path:key,namespace:'boundary'}; if(args.path.endsWith('.css'))return {path:args.path,namespace:'css'}; });
    builder.onLoad({filter:/.*/,namespace:'boundary'},args=>({contents:mocks[args.path],loader:'js',resolveDir:project}));
    builder.onLoad({filter:/.*/,namespace:'css'},()=>({contents:'',loader:'js'}));
  }}] });
  const modulePath=resolve(temporary,'app.mjs'); await writeFile(modulePath,result.outputFiles[0].text);
  const { ProjectView, DataGridView, ScrollToCell, DataGridViewportContext }=await import(pathToFileURL(modulePath));
  React=await import('react'); const { createRoot }=await import('react-dom/client');
  const host=document.createElement('div'); document.body.append(host); root=createRoot(host);
  const act=React.act;
  const settle=async()=>{ await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));}); };
  const mount=async()=>{await act(async()=>root.render(React.createElement(ProjectView,{key:session,projectSession:{id:session,path:'/fixtures/main.devcel'}})));await settle();};
  const sidebar=async id=>{await act(async()=>host.querySelector(`[data-file="${id}"]`).click());await settle();};
  const search=()=>host.querySelector(`input[placeholder="${t('grid.searchTable')}"]`);
  const filter=async value=>{await act(async()=>{ const input=search(); assert(input);Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}));});await settle();};
  const clickReference=async()=>{const link=host.querySelector(`[title="${t('reference.openTarget')}"]`);assert(link,'reference link visible');await act(async()=>link.click());await settle();};
  const selected=number=>host.querySelector(`[role="row"][aria-rowindex="${number+1}"] [aria-selected="true"]`);
  const assertNavigationScroll = number => {
    const grid=host.querySelector('.rdg'), owner=physicalOwner(grid);
    assert(owner, 'reference navigation has one physical scroll owner');
    const q=Number(grid.style.getPropertyValue('--rdg-physical-scale'));
    const rowIdx=number-1, previousTop=rowIdx===0?0:35+(rowIdx-1)*30;
    const expected=Math.max(0,Math.min((previousTop-5-35)*q,owner.scrollHeight-owner.clientHeight));
    assert(scrolls.some(s=>s.kind==='physical-owner'&&s.owner===owner&&Math.abs(s.top-expected)<1e-7),`physical target ${number} request`);
    assert(Math.abs(owner.scrollTop-expected)<1e-7,'physical owner reaches target');
    assert.equal(grid.scrollTop,0,'root is not a second owner');
    const row=grid.querySelector(`[role="row"][aria-rowindex="${number+1}"]`);
    assert(row,'target row mounted');
    const targetTop=grid.getBoundingClientRect().top+Number(row.dataset.physicalRowTop);
    assert(targetTop>=35*q-1e-7&&targetTop+30*q<=owner.clientHeight+1e-7,'target inside body viewport');
    const neighbor=number>1?number-1:number+1;
    assert(grid.querySelector(`[role="row"][aria-rowindex="${neighbor+1}"] [role="gridcell"]`),'nonselected neighbor mounted near viewport');
  };
  const check=(name,action)=>Promise.resolve().then(action).then(()=>{reports.push(name);console.log('PASS',name);});
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
  await mount();
  // Pre-open the target: this reproduces reuse of the active grid and retained search.
  await sidebar('equipment'); await sidebar('quests');
  await check('Filtered 12,668-row source reaches equipment row 111, clears query and synchronizes sidebar',async()=>{
    await filter('Marsh Artisan'); assert.equal(host.querySelector('.rdg').getAttribute('aria-rowcount'),'2');
    await clickReference();
    assert.equal(host.querySelector('[data-test-header]').textContent,'equipment.table.toml');
    assert.equal(search().value,''); assert(selected(111),'record 111 is selected'); assert(host.textContent.includes('Marsh Sling'));
    assertNavigationScroll(111);
    assert.equal(host.querySelector('[data-file="equipment"]').getAttribute('aria-pressed'),'true');
  });
  await check('Same-table filtered reference reaches offscreen row 900 and can repeat the same target',async()=>{
    await filter('Marsh Sling'); await clickReference(); assert.equal(search().value,''); assert(selected(900)); assertNavigationScroll(900);
    await filter('equipment 900'); await clickReference(); assert(selected(111)); assertNavigationScroll(111);
    await filter('Marsh Sling'); await clickReference(); assert(selected(900)); assertNavigationScroll(900);
  });
  await check('Consumed request does not clear a later user search or replay on refresh',async()=>{
    await filter('equipment 22'); assert.equal(search().value,'equipment 22'); await settle(); assert.equal(search().value,'equipment 22');
  });
  await check('Ordinary table navigation clears the previous table query even when the view is reused',async()=>{
    await sidebar('quests'); assert.equal(search().value,''); await filter('Marsh Artisan'); await sidebar('equipment'); assert.equal(search().value,'');
  });
  await check('Slow target load beyond the former timeout still focuses row 111',async()=>{
    session='session-B'; await mount(); await sidebar('quests'); await filter('Marsh Artisan'); delayedLoad=deferred(); await clickReference();
    await act(async()=>{await new Promise(r=>setTimeout(r,1600));}); const pending=delayedLoad; delayedLoad=null;
    await act(async()=>pending.resolve()); await settle(); assert.equal(search().value,''); assert(selected(111));
  });
  await check('Newer sidebar navigation cancels an unresolved reference lookup',async()=>{
    await sidebar('quests'); await filter('Marsh Artisan'); delayedPath=deferred(); await clickReference(); await sidebar('quests'); const pending=delayedPath;delayedPath=null;await act(async()=>pending.resolve('equipment.table.toml'));await settle();assert.equal(host.querySelector('[data-test-header]').textContent,'quests.table.toml');
  });
  await check('Save failure keeps source filter and never applies a destination focus',async()=>{
    await filter('Marsh Artisan'); failFlush=true;await clickReference();failFlush=false;assert.equal(search().value,'Marsh Artisan');assert.equal(host.querySelector('[data-test-header]').textContent,'quests.table.toml');assert(dialogs.some(([text])=>text.includes('save blocked')));
  });
  await check('Missing target table reports a native localized error and preserves the source',async()=>{
    const config=tables.quests.schema.columns[1].reference_config;
    config.target_table_uuid='absent-table'; await filter('Marsh Artisan'); await clickReference();
    config.target_table_uuid='equipment';
    assert(dialogs.some(([text])=>text===t('grid.loading.referenceNotFound')));
    assert.equal(host.querySelector('[data-test-header]').textContent,'quests.table.toml'); assert.equal(search().value,'Marsh Artisan');
  });
  await check('A pending lookup cannot reopen a table after project-session replacement',async()=>{
    delayedPath=deferred(); await clickReference(); session='session-C'; await mount(); await sidebar('quests');
    const pending=delayedPath;delayedPath=null;await act(async()=>pending.resolve('equipment.table.toml'));await settle();
    assert.equal(host.querySelector('[data-test-header]').textContent,'quests.table.toml');assert.equal(search().value,'');
  });
  await check('Missing target record clears hiding filter and shows a localized diagnostic',async()=>{
    const props={projectSessionId:session,tableName:'equipment',tableData:tables.equipment};
    await act(async()=>root.render(React.createElement(DataGridView,props)));await settle();await filter('no match');
    await act(async()=>root.render(React.createElement(DataGridView,{...props,referenceNavigation:{id:100,projectSessionId:session,tableUuid:'equipment',recordUuid:'missing-record'}})));await settle();
    assert.equal(search().value,'');assert(host.querySelector('[role="alert"]').textContent.includes(t('reference.missing')));assert(host.querySelector('[role="alert"]').textContent.includes('missing-record'));
  });
  await check('A request from another project session cannot clear the current filter',async()=>{
    await filter('equipment 22'); await act(async()=>root.render(React.createElement(DataGridView,{projectSessionId:session,tableName:'equipment',tableData:tables.equipment,referenceNavigation:{id:101,projectSessionId:'old-session',tableUuid:'equipment',recordUuid:'equipment-111'}})));await settle();assert.equal(search().value,'equipment 22');
  });
  await check('Table-only reference navigation also clears the current query without a missing-record alert',async()=>{
    await act(async()=>root.render(React.createElement(DataGridView,{projectSessionId:session,tableName:'equipment',tableData:tables.equipment,referenceNavigation:{id:102,projectSessionId:session,tableUuid:'equipment',recordUuid:''}})));await settle();assert.equal(search().value,'');assert.equal(host.querySelector('[role="alert"]'),null);
  });
  await check('Physical scroll requests wait for layout, use the latest target and retry on a new layout',async()=>{
    let consumed=0, resolved=false;
    const requests=[];
    const viewport={ownerRef:{current:host},scale:1,layout:'physical-rows',direction:'ltr',
      scrollToPosition:position=>{requests.push(position);return resolved;},
      scrollToElement:()=>false,requestFocus:()=>()=>{}};
    const setScrollToCellPosition=()=>consumed++;
    let layoutVersion={};
    const renderRequest=(position,layoutReady)=>act(async()=>root.render(
      React.createElement(DataGridViewportContext,{value:{...viewport,layoutReady,layoutVersion}},
        React.createElement(ScrollToCell,{scrollToPosition:position,setScrollToCellPosition}))));
    const first={rowIdx:110,idx:0,scrollPosition:'top-left'};
    const latest={rowIdx:899,idx:0,scrollPosition:'top-left'};
    await renderRequest(first,false);await renderRequest(latest,false);
    assert.equal(requests.length,0);assert.equal(consumed,0);
    resolved=true;await renderRequest(latest,true);
    assert.deepEqual(requests,[latest]);assert.equal(consumed,1,'only the current request is consumed');
    await renderRequest({...latest},true);
    assert.equal(requests.length,2);assert.equal(consumed,2,'repeated coordinates are a new request');
    resolved=false;await renderRequest(first,true);
    assert.equal(consumed,2,'an unavailable owner cannot consume the request');
    resolved=true;layoutVersion={};await renderRequest(first,true);
    assert.equal(requests.length,4);assert.equal(consumed,3,'a new committed layout retries the pending target');
    await renderRequest(latest,false);await act(async()=>root.render(null));
    assert.equal(requests.length,4);assert.equal(consumed,3,'unmount discards a pending request');
  });
  assert(calls.some(c=>c.command==='get_table_rule_snapshot'),'real full snapshot reader is exercised');
  assert(!calls.some(c=>/mutate|save|set_record|delete_record/.test(c.command)),'navigation does not mutate records');
  const report={passed:reports.length,checks:reports,ipcCalls:calls.length,scope:'Real component chain, grid, reference renderer and presentation reader; synthetic DOM, IPC/sidebar/editor boundaries. Native WebKit QA remains separate.'};
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {if(root)await React.act(()=>root.unmount());await window.happyDOM.close();await rm(temporary,{recursive:true,force:true});delete globalThis.__referenceNavigationTest;}
