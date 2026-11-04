// Real ProjectView, TableTabView, FileBrowserView, FileTree and selection hooks.
// Synthetic DOM and native IPC/dialog/editor boundaries; native QA is separate.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { IntlMessageFormat } from 'intl-messageformat';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.tab-selection-check-'));
const before = process.env.TAB_SELECTION_BEFORE;
const reports = [], calls = [], dialogs = [], pluginSelections = [];
const messages = JSON.parse(await readFile(resolve(project, 'src/app/i18n/generated/catalog.json'), 'utf8')).messages.ja;
const t = (key, values) => { assert(Object.hasOwn(messages, key), key); return String(new IntlMessageFormat(messages[key], 'ja', undefined, { ignoreTag: true }).format(values)); };
const window = new Window({ url: 'http://tab-selection.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLSelectElement', 'HTMLOptionElement', 'DocumentFragment', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver', 'CSS', 'localStorage', 'sessionStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
Object.defineProperties(window.HTMLElement.prototype, { offsetWidth:{configurable:true,get:()=>900},clientWidth:{configurable:true,get:()=>900},offsetHeight:{configurable:true,get:()=>400},clientHeight:{configurable:true,get:()=>400} });
window.HTMLElement.prototype.scrollIntoView=function(){};
window.HTMLElement.prototype.getBoundingClientRect = function() { return new window.DOMRect(0,0,900,400); };
const files = ['equipment', 'quests', 'jobs'].map(uuid => ({id:`${uuid}.table.toml`,path:`${uuid}.table.toml`,name:`${uuid}.table.toml`,type:'table',uuid}));
files.push({id:'readme.md',path:'readme.md',name:'readme.md',type:'markdown'});
files.push({id:'nested',path:'nested',name:'nested',type:'folder'},{id:'nested/notes.md',path:'nested/notes.md',name:'notes.md',type:'markdown'});
let session='session-A', failFlush=false, nextFlush=null, pathLookup=null, catalogLookup=null;
const snapshotDelays=new Map(), snapshotFailures=new Set(), cancellationDelays=new Map(), parseFailures=new Set();
let rejectStringClose=false;
const tables=Object.fromEntries(files.filter(f=>f.type==='table').map(f=>[f.uuid,{uuid:f.uuid,display_name:'',description:'',metadata:{initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, data_name:f.uuid},schema:{columns:[]},records:[]}]));
const invoke=async(command,args={})=>{
  calls.push({command,args}); assert.equal(args.expectedProjectSession,session,`session-bound IPC: ${command}`);
  switch(command){case 'get_table_catalog':return catalogLookup ? catalogLookup.promise : files.filter(f=>f.type==='table').map(f=>({path:f.path,uuid:f.uuid,data_name:tables[f.uuid].metadata.data_name}));case 'prepare_table_rule_snapshot':return `evaluation-${calls.length}`;case 'cancel_table_rule_snapshot':return cancellationDelays.has(args.tableUuid)?cancellationDelays.get(args.tableUuid).promise:true;case 'initialize_empty_table':parseFailures.delete(files.find(file=>file.path===args.path)?.uuid);return 'ok';case 'save_project':return 'ok';case 'get_table_rule_snapshot':if(parseFailures.has(args.tableUuid))throw {kind:'code',code:'error.emptyTable'};if(snapshotFailures.has(args.tableUuid))throw Error('snapshot failed');if(snapshotDelays.has(args.tableUuid))await snapshotDelays.get(args.tableUuid).promise;return {kind:'snapshot',snapshot_token:null,retained_bytes:1024,table:tables[args.tableUuid],presentation:{table_uuid:args.tableUuid,revision:'revision',cells:{},definition_issues:[],issue_count:0}};case 'get_table_list':return files;case 'get_table_data':return tables[args.uuid];case 'check_and_apply_interface_updates':return 'ok';case 'get_table_path_by_uuid':return pathLookup?pathLookup.promise:`${args.tableUuid}.table.toml`;default:throw Error(`Unexpected IPC ${command}`);}
};
const boundary=globalThis.__tabSelectionTest={t,invoke,dialogs,files,tables,pluginSelections,displayNames:{},loadedTables:[],get session(){return session;},async flush(){if(failFlush)throw Error('save blocked');const pending=nextFlush;nextFlush=null;if(pending)await pending.promise;},viewProps:null,settingsEditor:false,get rejectStringClose(){return rejectStringClose;}};
const mocks={
  '@/app/settings':`export const getSettingsSnapshot=()=>({bundle:{pluginLabels:{},themes:[],localization:{locales:{}}}});export const useAppSettings=getSettingsSnapshot;`,
  '@/app/applicationMode':`export const isSettingsEditor=()=>globalThis.__tabSelectionTest.settingsEditor;`,
  '@/app/i18n':`const b=globalThis.__tabSelectionTest;export const t=b.t;export const getLocale=()=> 'ja';export const formatDateTime=(value,options)=>new Intl.DateTimeFormat('ja',options).format(new Date(value));export const getLocaleName=code=>code;export const translatePluginMessage=()=>{throw Error('Unexpected CSV translation in navigation fixture');};export const useI18n=()=>({t,locale:getLocale()});export const localizeError=v=>String(v||'');export const localizedError=localizeError;export const message=(key,values)=>({key,values});export const toAppError=v=>v?.kind==='code'?v:({kind:'text',text:String(v)});`,
  '@tauri-apps/api/core':`export const isTauri=()=>false;export const invoke=(...args)=>globalThis.__tabSelectionTest.invoke(...args);`,
  '@tauri-apps/api/event':`export const listen=async()=>()=>{};export const emit=async()=>{};`,
  '@tauri-apps/plugin-dialog':`export const message=async(...args)=>globalThis.__tabSelectionTest.dialogs.push(args);`,
  '@/app/services/appDialogs': `export const message=async(...args)=>globalThis.__tabSelectionTest.dialogs.push(args);export const ask=async()=>false;export const appAlert=message;export const appConfirm=ask;export const appPrompt=async(...args)=>globalThis.prompt?.(...args)??null;`,
  'react-dnd':`const connector=()=>{};export const useDrag=()=>[{},connector,connector];export const useDrop=()=>[{},connector];export const useDragLayer=()=>({isDragging:false});`,
  '@/app/commands/tableCommands':`const b=globalThis.__tabSelectionTest;export const loadTable=async()=> 'ok';export const getLoadedTables=async()=>b.loadedTables;export const getTableDisplayCatalog=async()=>b.files.filter(f=>f.type==='table').map(f=>({path:'/fixtures/Tables/'+f.path,uuid:f.uuid,display_name:b.displayNames[f.uuid]??'Friendly '+f.uuid}));export const renameTableDisplayName=async()=>{throw Error('unexpected rename')};export const isTableLoadingSessionCurrent=id=>id===b.session;`,
  '@/app/commands/projectCommands':`export const getProjectEntries=async()=>globalThis.__tabSelectionTest.files.map(f=>({path:f.path,entry_type:f.type==='folder'?'Directory':f.type==='table'?'Table':'Markdown',uuid:f.uuid}));`,
  '@/app/utils/string_editor_window':`export const requestCloseStringEditor=async()=>!globalThis.__tabSelectionTest.rejectStringClose;export const showStringEditor=async()=>{};export const registerMainWindowCloseBlocker=()=>()=>{};`,
  '@/app/utils/markdownSaveLifecycle':`export const flushMarkdownEdits=(...args)=>globalThis.__tabSelectionTest.flush(...args);`,
  '@/app/services/PluginManager':`export class PluginManager {static getInstance(){return {setActiveTable(value){globalThis.__tabSelectionTest.pluginSelections.push(value);}}}}`,
  './components/FileHeader':`import React from 'react';export const getDisplayTitle=item=>item.name;export const FileHeader=({currentItem})=>React.createElement('h2',{'data-test-header':currentItem.id},currentItem.name);`,
  './components/FileViewRegistry':`import React from 'react';export const FileViewRenderer=props=>{globalThis.__tabSelectionTest.viewProps=props;return React.createElement('article',{'data-view-id':props.currentItem.id,'data-view-session':props.projectSessionId},props.currentItem.name);};`,
  './hooks/useFileOperations':`export const useFileOperations=()=>({});`,
  './components/FileTypeDialog':`export const FileTypeDialog=()=>null;`,
  '@/app/components/StatusBar':`export const StatusBar=()=>null;`,
  '@/app/components/P2PToast':`export const P2PToastContainer=()=>null;`,
  '/properties_panel/PropertiesPanel':`import React from 'react';export const PropertiesPanel=({selectedItem})=>React.createElement('aside',{'data-properties-id':selectedItem?.id||''});`,
  '@/app/components/interface/DuplicateInterfaceDetector':`export const DuplicateInterfaceDetector=()=>null;`,
};
let root,React;
try{
  const result=await build({absWorkingDir:project,stdin:{contents:`export {default as ProjectView} from './src/app/pages/main_window/project_view/ProjectView'; export * as InteractionScope from './src/app/services/tableInteractionScope'; export * as SelectUI from './src/components/ui/select';`,resolveDir:project,loader:'ts'},bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',write:false,define:{'import.meta.env.DEV':'false'},alias:{'@':resolve(project,'src')},plugins:[{name:'boundaries',setup(builder){
    builder.onResolve({filter:/.*/},args=>{const key=Object.keys(mocks).find(key=>args.path===key||key.startsWith('/')&&args.path.endsWith(key));if(key)return{path:key,namespace:'boundary'};if(args.path.endsWith('.css'))return{path:args.path,namespace:'css'};});
    builder.onLoad({filter:/.*/,namespace:'boundary'},args=>({contents:mocks[args.path],loader:'js',resolveDir:project}));builder.onLoad({filter:/.*/,namespace:'css'},()=>({contents:'',loader:'js'}));
    if(before)builder.onLoad({filter:/(ProjectView|TableTabView|FileBrowserView)\.tsx$/},async args=>({contents:await readFile(resolve(before,'devcel-studio',args.path.slice(project.length+1)),'utf8'),loader:'tsx'}));
  }}]});
  const modulePath=resolve(temporary,'app.mjs');await writeFile(modulePath,result.outputFiles[0].text);const {ProjectView,InteractionScope,SelectUI}=await import(pathToFileURL(modulePath));
  React=await import('react');const{createRoot}=await import('react-dom/client');const host=document.createElement('div');document.body.append(host);root=createRoot(host);const act=React.act;
  const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15));});};
  const mount=async()=>{await act(async()=>root.render(React.createElement(ProjectView,{key:session,projectSession:{id:session,path:'/fixtures/main.devcel'}})));await settle();await act(async()=>window.dispatchEvent(new window.Event('devcel-toggle-properties-panel')));};
  const file=id=>files.find(f=>f.uuid===id||f.id===id);
  const sidebarRow=id=>host.querySelector(`[data-file-id="${file(id).id}"] span[title="${file(id).name}"]`).closest(".group");
  const sidebar=async id=>{await act(async()=>sidebarRow(id).click());await settle();};
  const tab=id=>[...host.querySelectorAll('.border-b-2')].find(node=>node.querySelector('span')?.textContent===file(id).name);
  const clickTab=async id=>{assert(tab(id),`tab ${id} exists`);await act(async()=>tab(id).click());await settle();};
  const close=async id=>{assert(tab(id));await act(async()=>tab(id).querySelector('button').click());await settle();};
  const active=id=>{
    const target=id?file(id):null;
    assert.equal(host.querySelector('[data-test-header]')?.getAttribute('data-test-header')??null,target?.id??null,'displayed table');
    assert.equal(host.querySelector('.border-b-2.border-primary')?.querySelector('span').textContent??null,target?.name??null,'active tab');
    const selected=[...host.querySelectorAll('[data-file-id]')].filter(node=>node.querySelector('.bg-secondary')).map(node=>node.getAttribute('data-file-id'));
    for(const node of [...host.querySelectorAll('[data-file-id]')].filter(node=>node.querySelector('.bg-secondary'))) assert([...node.querySelectorAll('*')].every(child=>![...child.classList].some(name=>/^text-white(?:\/|$)/.test(name))), 'Neutral selected file rows keep readable child text and icons');
    assert.deepEqual(selected,target?[target.id]:[],'sidebar selection matches active tab');
    assert.equal(host.querySelector('[data-properties-id]')?.getAttribute('data-properties-id'),target?.id??'','properties selection');
    assert.deepEqual(pluginSelections.at(-1),target?.type==='table'?{uuid:target.uuid,projectSession:session}:null,'plugin active table/session');
  };
  const check=async(name,action)=>{await action();reports.push(name);console.log('PASS',name);};
  const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
  await mount();assert.equal(host.querySelector('[data-view-id]'),null,'standard projects never auto-select a table');
  await check('Real sidebar owns Select All and Escape while text input retains native selection', async()=>{
    const tree=host.querySelector('[data-file-browser]');assert(tree);
    const selected=()=>[...host.querySelectorAll('[data-file-id]')].filter(node=>node.querySelector('.bg-secondary')).length;
    await act(async()=>tree.focus());
    await act(async()=>tree.dispatchEvent(new window.KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true})));await settle();
    assert.equal(selected(),host.querySelectorAll('[data-file-id]').length);
    const input=document.createElement('input');tree.append(input);input.focus();
    const native=new window.KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true});
    input.dispatchEvent(native);assert.equal(native.defaultPrevented,false);input.remove();
    await act(async()=>{tree.focus();tree.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));});await settle();assert.equal(selected(),0);
  });
  await check('Unloaded tables show metadata display names before selection without loaded styling or record fetches', async()=>{
    for(const id of ['equipment','quests','jobs']) {
      const row=sidebarRow(id);
      assert(row.querySelector(`[title="Friendly ${id}"]`),'display name appears before table selection');
      const fileName=row.querySelector(`span[title="${file(id).name}"]`);
      assert(!fileName.classList.contains('text-emerald-700')&&!fileName.classList.contains('font-semibold'),'metadata is not a loaded-table badge');
    }
    assert.equal(calls.filter(call=>call.command==='prepare_table_rule_snapshot'||call.command==='get_table_data').length,0,'metadata labels do not acquire records');
  });
  await check('Authoritative custom display names refresh the real sidebar without being replaced by stale loaded badges', async()=>{
    boundary.loadedTables=[{path:'/fixtures/Tables/equipment.table.toml',uuid:'equipment',display_name:'Friendly equipment'}];
    await act(async()=>window.dispatchEvent(new window.CustomEvent('devcel-table-loaded')));await settle();
    boundary.displayNames.equipment='Native App Settings';
    await act(async()=>{window.dispatchEvent(new window.CustomEvent('devcel-table-catalog-invalidated'));await new Promise(resolve=>setTimeout(resolve,130));});await settle();
    assert(sidebarRow('equipment').querySelector('[title="Native App Settings"]'),'committed metadata label renders');
    assert(!sidebarRow('equipment').querySelector('[title="Friendly equipment"]'),'stale loaded label cannot replace authoritative metadata');
    const loadedName=sidebarRow('equipment').querySelector('span[title="equipment.table.toml"]');assert(!loadedName.classList.contains('font-semibold')&&!loadedName.classList.contains('text-emerald-700'),'loaded but unselected files retain neutral styling');
    boundary.loadedTables=[];delete boundary.displayNames.equipment;
    await act(async()=>{window.dispatchEvent(new window.CustomEvent('devcel-table-loaded'));window.dispatchEvent(new window.CustomEvent('devcel-table-catalog-invalidated'));await new Promise(resolve=>setTimeout(resolve,130));});await settle();
  });

  await sidebar('equipment');await sidebar('quests');await sidebar('jobs');
  await check('Selection reserves and acquires before replacing the old authoritative grid; a newer target retires the late response',async()=>{
    const late=deferred();snapshotDelays.set('equipment',late);
    const beforeRaw=calls.filter(call=>call.command==='get_table_data').length;
    await sidebar('equipment');
    assert.equal(boundary.viewProps.tableData.uuid,'jobs','old displayed table remains during acquisition');
    assert.equal(InteractionScope.isTableInteractionAllowed(session,'jobs'),false,'old table write authority closes synchronously');
    assert(calls.some(call=>call.command==='prepare_table_rule_snapshot'&&call.args.tableUuid==='equipment'));
    assert(calls.some(call=>call.command==='check_and_apply_interface_updates'&&call.args.uuid==='equipment'));
    assert.equal(calls.filter(call=>call.command==='get_table_data').length,beforeRaw,'activation uses only its authoritative snapshot');
    await sidebar('quests');active('quests');
    snapshotDelays.delete('equipment');await act(async()=>late.resolve());await settle();active('quests');
    await clickTab('jobs');active('jobs');
  });
  await check('A held inactive tab keeps its DOM through a parent snapshot and accepts the click',async()=>{
    const pressed=tab('equipment');assert(pressed?.isConnected);
    await act(async()=>pressed.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,button:0})));
    await act(async()=>boundary.viewProps.onDataChange(structuredClone(tables.jobs)));await settle();
    assert(tab('equipment')===pressed,'snapshot must retain the pressed tab DOM');assert(pressed.isConnected);
    await act(async()=>pressed.dispatchEvent(new window.MouseEvent('mouseup',{bubbles:true,button:0})));
    await act(async()=>pressed.click());await settle();active('equipment');await clickTab('jobs');active('jobs');
  });
  await check('A held inactive close button survives a parent snapshot and closes on its first click',async()=>{
    const pressed=tab('equipment').querySelector('button');assert(pressed?.isConnected);
    await act(async()=>pressed.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,button:0})));
    await act(async()=>boundary.viewProps.onDataChange(structuredClone(tables.jobs)));await settle();
    assert(tab('equipment').querySelector('button')===pressed,'snapshot must retain the pressed close button');assert(pressed.isConnected);
    await act(async()=>pressed.dispatchEvent(new window.MouseEvent('mouseup',{bubbles:true,button:0})));
    await act(async()=>pressed.click());await settle();assert(!tab('equipment'));active('jobs');
    await sidebar('equipment');await sidebar('quests');await sidebar('jobs');active('jobs');
  });
  await check('Existing quests tab activation synchronizes real sidebar, properties and plugin table',async()=>{await clickTab('quests');active('quests');});
  await check('Closing active middle tab synchronizes the adjacent table',async()=>{await close('quests');active('jobs');});
  await check('Closing an inactive tab before the active tab preserves active identity',async()=>{await sidebar('quests');await clickTab('equipment');await close('quests');active('equipment');});
  await check('Closing an inactive tab after the active tab preserves active identity',async()=>{await clickTab('jobs');await close('equipment');active('jobs');});
  await check('Closing the final tab clears sidebar, properties and plugin state',async()=>{await close('jobs');active(null);});
  await check('Markdown activation clears plugin table and ordinary table activation restores it',async()=>{await sidebar('equipment');await sidebar('readme.md');active('readme.md');await clickTab('equipment');active('equipment');});
  await check('Failed tab save preserves the active table and all selections',async()=>{failFlush=true;await clickTab('readme.md');failFlush=false;active('equipment');assert(dialogs.at(-1)[0].includes('save blocked'));});
  await check('Failed close save preserves tab and all selections',async()=>{failFlush=true;await close('equipment');failFlush=false;active('equipment');assert(tab('equipment'));});
  await check('A newer tab click wins over an older pending save',async()=>{await sidebar('jobs');const pending=nextFlush=deferred();await clickTab('equipment');await clickTab('readme.md');active('readme.md');await act(async()=>pending.resolve());await settle();active('readme.md');});
  await check('Double-click waits for save and cannot split sidebar/properties from the active grid',async()=>{await clickTab('readme.md');const first=nextFlush=deferred();await clickTab('equipment');const second=nextFlush=deferred();await clickTab('equipment');await act(async()=>tab('equipment').dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true})));active('readme.md');await act(async()=>{first.resolve();second.resolve();});await settle();active('equipment');});
  await check('Failed double-click save cannot bypass the existing active selection',async()=>{failFlush=true;await clickTab('readme.md');await clickTab('readme.md');await act(async()=>tab('readme.md').dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true})));failFlush=false;active('equipment');});
  await check('A newer sidebar selection wins over an older pending tab save',async()=>{const pending=nextFlush=deferred();await clickTab('equipment');await sidebar('jobs');active('jobs');await act(async()=>pending.resolve());await settle();active('jobs');});
  await check('A newer sidebar selection cancels an older pending close',async()=>{const pending=nextFlush=deferred();await close('equipment');await sidebar('jobs');await act(async()=>pending.resolve());await settle();active('jobs');assert(tab('equipment'));});
  await check('Reference navigation to an existing tab synchronizes without cancelling its request',async()=>{await act(async()=>boundary.viewProps.onOpenReference('equipment','equipment-111'));await settle();active('equipment');assert.equal(boundary.viewProps.referenceNavigation.recordUuid,'equipment-111');const request=boundary.viewProps.referenceNavigation;await act(async()=>boundary.viewProps.onReferenceNavigationHandled(request));await settle();assert.equal(boundary.viewProps.referenceNavigation,undefined);});
  await check('Hiding and reopening the sidebar restores the active file selection',async()=>{await act(async()=>window.dispatchEvent(new window.Event('devcel-toggle-file-browser')));await clickTab('jobs');await act(async()=>window.dispatchEvent(new window.Event('devcel-toggle-file-browser')));await settle();active('jobs');});
  await check('Clicking the already-active tab restores an independently cleared sidebar selection',async()=>{const tree=host.querySelector('[data-file-tree-row-count]');await act(async()=>tree.parentElement.click());assert(!sidebarRow('jobs').classList.contains('bg-secondary'));await clickTab('jobs');active('jobs');});
  await check('Sidebar Ctrl-click keeps its multi-selection until an explicit tab activation',async()=>{await sidebar('equipment');await act(async()=>sidebarRow('jobs').dispatchEvent(new window.MouseEvent('click',{bubbles:true,ctrlKey:true})));await settle();assert(sidebarRow('jobs').classList.contains('bg-secondary'));assert(sidebarRow('equipment').classList.contains('bg-secondary'));await clickTab('equipment');active('equipment');});
  await check('Newer tab activation cancels a pending reference lookup without replay',async()=>{const pending=pathLookup=deferred();await act(async()=>{void boundary.viewProps.onOpenReference('quests','quests-111');});await clickTab('jobs');pathLookup=null;await act(async()=>pending.resolve('quests.table.toml'));await settle();active('jobs');assert.equal(boundary.viewProps.referenceNavigation,undefined);});
  await check('Reopening the sidebar reveals an active file after its collapsed parent tree loads',async()=>{await sidebar('nested');await sidebar('nested/notes.md');await sidebar('jobs');await sidebar('nested');await act(async()=>window.dispatchEvent(new window.Event('devcel-toggle-file-browser')));await clickTab('nested/notes.md');await act(async()=>window.dispatchEvent(new window.Event('devcel-toggle-file-browser')));await settle();active('nested/notes.md');assert(sidebarRow('nested/notes.md'));});
  await check('Replacing a project session clears old table state and rejects pending activation',async()=>{const pending=nextFlush=deferred();await clickTab('equipment');session='session-B';await mount();active(null);await sidebar('quests');active('quests');await act(async()=>pending.resolve());await settle();active('quests');assert.equal(host.querySelector('[data-view-session]').getAttribute('data-view-session'),session);});
  assert(!calls.some(c=>/mutate|save|set_record|delete_record/.test(c.command)),'selection does not write record data');
  await check('Closing the last displayed tab synchronously retires its plugin target and write scope',async()=>{
    await close('quests');active(null);await sidebar('equipment');active('equipment');await close('equipment');active(null);
    assert.equal(InteractionScope.isTableInteractionAllowed(session,'equipment'),false);
    assert.equal(pluginSelections.at(-1),null);
  });
  await check('Unmounting the project clears plugin selection immediately',async()=>{await act(async()=>root.render(null));assert.equal(pluginSelections.at(-1),null);});
  boundary.settingsEditor=true;
  tables.equipment.metadata.data_name='UserSettings';
  await check('Settings editor discovers UserSettings by live catalog name/path/UUID and activates exactly once under StrictMode',async()=>{
    session='settings-session';const before=calls.length;const pluginCount=pluginSelections.length;
    await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(ProjectView,{key:session,projectSession:{id:session,path:'/fixtures/main.devcel'}}))));await settle();
    assert.equal(host.querySelector('[data-view-id]')?.getAttribute('data-view-id'),'equipment.table.toml');
    assert.equal(calls.slice(before).filter(call=>call.command==='get_table_catalog').length,1);
    assert.equal(calls.slice(before).filter(call=>call.command==='prepare_table_rule_snapshot'&&call.args.tableUuid==='equipment').length,1);
    assert.equal(InteractionScope.isTableInteractionAllowed(session,'equipment'),true);
    assert.equal(pluginSelections.length,pluginCount,'settings selection cannot initialize plugins');
    await act(async()=>root.render(null));
  });
  await check('Missing UserSettings leaves a repairable ordinary tree without choosing an unrelated table',async()=>{
    tables.equipment.metadata.data_name='RenamedSettings';session='settings-missing';await mount();
    assert.equal(host.querySelector('[data-view-id]'),null);assert(sidebarRow('equipment'));
    await sidebar('equipment');assert.equal(host.querySelector('[data-view-id]')?.getAttribute('data-view-id'),'equipment.table.toml');
    await act(async()=>root.render(null));tables.equipment.metadata.data_name='UserSettings';
  });
  await check('User selection wins over a delayed settings catalog, without a later automatic activation',async()=>{
    const pending=catalogLookup=deferred();session='settings-delayed';await mount();await sidebar('jobs');
    catalogLookup=null;await act(async()=>pending.resolve([{path:'equipment.table.toml',uuid:'equipment',data_name:'UserSettings'}]));await settle();
    assert.equal(host.querySelector('[data-view-id]')?.getAttribute('data-view-id'),'jobs.table.toml');
    await act(async()=>root.render(null));
  });
  await check('Unmount cancels pending settings initial selection and never opens a late tab',async()=>{
    const pending=catalogLookup=deferred();session='settings-unmounted';await mount();await act(async()=>root.render(null));const before=calls.length;
    catalogLookup=null;await act(async()=>pending.resolve([{path:'equipment.table.toml',uuid:'equipment',data_name:'UserSettings'}]));await settle();
    assert.equal(calls.slice(before).filter(call=>call.command==='prepare_table_rule_snapshot').length,0);assert.equal(host.children.length,0);
  });
  await check('Settings initial activation uses the ordinary save guard and remains repairable on failure',async()=>{
    failFlush=true;session='settings-save-guard';await mount();assert.equal(host.querySelector('[data-view-id]'),null);assert(sidebarRow('equipment'));
    failFlush=false;await sidebar('equipment');assert.equal(host.querySelector('[data-view-id]')?.getAttribute('data-view-id'),'equipment.table.toml');
  });
  boundary.settingsEditor=false;
  let historySession=0;
  const resetHistory=async()=>{session=`history-${++historySession}`;await mount();await sidebar('equipment');await sidebar('quests');await sidebar('jobs');};
  const historyButton=direction=>host.querySelector(`[data-navigation-history="${direction}"]`);
  const traverse=async direction=>{assert(historyButton(direction));await act(async()=>historyButton(direction).click());await settle();};
  await check('History follows successful display commits, supports Back/Forward, and truncates Forward on fresh navigation',async()=>{
    await resetHistory();assert(historyButton('forward').disabled);await traverse('back');active('quests');await traverse('back');active('equipment');
    assert(historyButton('back').disabled);await traverse('forward');active('quests');await sidebar('readme.md');active('readme.md');
    assert(historyButton('forward').disabled);await traverse('back');active('quests');
  });
  await check('History reopens a closed tab and the last closed display without losing sidebar or properties identity',async()=>{
    await resetHistory();await close('quests');assert(!tab('quests'));await traverse('back');active('quests');assert(tab('quests'));
    await close('equipment');await close('jobs');await close('quests');active(null);
    await traverse('back');active('quests');assert(tab('quests'));
  });
  await check('Failed save, rejected String close, and failed snapshot Back leave the cursor and current display unchanged',async()=>{
    await resetHistory();failFlush=true;await traverse('back');failFlush=false;active('jobs');assert(historyButton('forward').disabled);
    rejectStringClose=true;await traverse('back');rejectStringClose=false;active('jobs');assert(historyButton('forward').disabled);
    snapshotFailures.add('quests');await traverse('back');snapshotFailures.clear();active('jobs');assert(historyButton('forward').disabled);
    const retry=host.querySelector('[role="alert"] button');assert(retry);await act(async()=>retry.click());await settle();active('quests');
    assert(!historyButton('forward').disabled,'retry preserves the original history traversal');await traverse('forward');active('jobs');
  });
  await check('A newer tab wins over a late history snapshot, and the discarded target never enters history',async()=>{
    await resetHistory();const delayed=deferred();snapshotDelays.set('quests',delayed);await traverse('back');
    assert.equal(boundary.viewProps.tableData.uuid,'jobs');await clickTab('equipment');active('equipment');
    snapshotDelays.delete('quests');await act(async()=>delayed.resolve());await settle();active('equipment');assert(historyButton('forward').disabled);
    await traverse('back');active('jobs');
  });
  await check('A late cancellation error from retired history cannot overlay a newer successful table',async()=>{
    await resetHistory();const snapshot=deferred(), cancel=deferred();snapshotDelays.set('quests',snapshot);cancellationDelays.set('quests',cancel);
    await traverse('back');await clickTab('equipment');active('equipment');
    await act(async()=>cancel.reject(Error('late cancel failure')));await settle();active('equipment');assert.equal(host.querySelector('[role="alert"]'),null);
    cancellationDelays.delete('quests');snapshotDelays.delete('quests');await act(async()=>snapshot.resolve());await settle();active('equipment');
  });
  await check('Cancel during Back discards the pending snapshot without moving the history cursor',async()=>{
    await resetHistory();const delayed=deferred();snapshotDelays.set('quests',delayed);await traverse('back');
    const cancel=host.querySelector('[role="status"] button');assert(cancel);await act(async()=>cancel.click());await settle();active('jobs');
    snapshotDelays.delete('quests');await act(async()=>delayed.resolve());await settle();active('jobs');assert(historyButton('forward').disabled);
    await traverse('back');active('quests');
  });
  await check('A newer tab wins over a pending history catalog lookup without recording its requested target',async()=>{
    await resetHistory();const delayed=catalogLookup=deferred();await traverse('back');await clickTab('equipment');active('equipment');
    catalogLookup=null;await act(async()=>delayed.resolve(files.filter(item=>item.type==='table')));await settle();active('equipment');
    await traverse('back');active('jobs');
  });
  await check('Async editor guards retain old table authority, reject canceled history, and let the latest activation win',async()=>{
    await resetHistory();let guardCalls=0;const delayed=deferred();
    const release=InteractionScope.registerTableNavigationBlocker(()=>++guardCalls===1?delayed.promise:true);
    await traverse('back');assert.equal(InteractionScope.isTableInteractionAllowed(session,'jobs'),true,'save still owns the displayed table');
    await clickTab('equipment');active('equipment');await act(async()=>delayed.resolve(true));await settle();active('equipment');release();
    await traverse('back');active('jobs');
    const reject=InteractionScope.registerTableNavigationBlocker(async()=>false);await close('jobs');active('jobs');assert(tab('jobs'));reject();
  });
  await check('Real Radix Select portal owns Ctrl+A and Alt arrows without moving background history or focus',async()=>{
    await resetHistory(); const popupHost=document.createElement('div');host.append(popupHost);const popupRoot=createRoot(popupHost);
    const {Select,SelectTrigger,SelectContent,SelectItem,SelectValue}=SelectUI;
    await act(async()=>popupRoot.render(React.createElement(Select,{defaultValue:'one',defaultOpen:true},React.createElement(SelectTrigger,null,React.createElement(SelectValue)),React.createElement(SelectContent,null,...['one','two'].map(value=>React.createElement(SelectItem,{key:value,value},value))))));await settle();
    const option=document.querySelector('[role="option"]');assert(option);option.focus();
    for(const options of [{key:'a',ctrlKey:true},{key:'ArrowLeft',altKey:true},{key:'ArrowRight',altKey:true}]) {
      await act(async()=>option.dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,cancelable:true,...options})));await settle();active('jobs');assert.equal(document.activeElement,option);
    }
    await act(async()=>popupRoot.unmount());popupHost.remove();await settle();
  });
  await check('Rapid tab keys follow displayed order, including alternating directions',async()=>{
    const key=async direction=>{await act(async()=>window.dispatchEvent(new window.KeyboardEvent('keydown',{key:direction,altKey:true,bubbles:true,cancelable:true})));await settle();};
    for (const second of ['ArrowRight','ArrowLeft']) {
      await resetHistory();const delayed=deferred();snapshotDelays.set('quests',delayed);
      await key('ArrowRight');await key(second);assert.equal(host.querySelector('[data-test-header]').getAttribute('data-test-header'),file('jobs').id);
      snapshotDelays.delete('quests');await act(async()=>delayed.resolve());await settle();
      active(second==='ArrowRight'?'equipment':'jobs');
    }
  });
  await check('Alt arrows follow displayed tab order, not visitation history, and stop at the edge',async()=>{
    await resetHistory();await clickTab('equipment');
    const key=async options=>{await act(async()=>window.dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,cancelable:true,...options})));await settle();};
    await key({key:'ArrowRight',altKey:true});active('equipment');
    await key({key:'ArrowLeft',altKey:true});active('quests');
    await key({key:'PageUp',ctrlKey:true});active('jobs');
    await key({key:'Tab',ctrlKey:true});active('quests');
    host.querySelector('[data-document-tabs]').style.direction='rtl';
    await key({key:'ArrowRight',altKey:true});active('jobs');
    host.querySelector('[data-document-tabs]').style.direction='ltr';
  });
  await check('Tab shortcuts work outside editors and never consume text-editing or composing arrows',async()=>{
    await resetHistory();await act(async()=>window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true,cancelable:true})));await settle();active('quests');
    const input=document.createElement('input');host.append(input);await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true,cancelable:true})));await settle();active('quests');input.remove();
    await act(async()=>window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,isComposing:true,bubbles:true,cancelable:true})));await settle();active('quests');
    await act(async()=>window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true,cancelable:true})));await settle();active('jobs');
  });
  await check('History resolves renamed tables by live UUID, rejects deleted paths, and resets for a different project',async()=>{
    await resetHistory();const quests=file('quests'), old={...quests};Object.assign(quests,{id:'renamed.table.toml',path:'renamed.table.toml',name:'renamed.table.toml'});
    await traverse('back');active('quests');assert.equal(host.querySelectorAll('.border-b-2').length,3,'rename retargets instead of duplicating an open tab');
    await traverse('forward');active('jobs');Object.assign(quests,old);
    const index=files.indexOf(quests);files.splice(index,1);await traverse('back');active('equipment');files.splice(index,0,quests);
    session='history-reset';await mount();active(null);assert(historyButton('back').disabled);assert(historyButton('forward').disabled);
    await resetHistory();const delayed=deferred();snapshotDelays.set('quests',delayed);await traverse('back');session='history-pending-reset';await mount();
    snapshotDelays.delete('quests');await act(async()=>delayed.resolve());await settle();active(null);assert(historyButton('back').disabled);assert(historyButton('forward').disabled);
  });
  let initializationSession = 0;
  const openInitialization = async () => {
    parseFailures.clear(); session = `initialization-${++initializationSession}`; await mount(); await sidebar('jobs');
    parseFailures.add('quests'); await sidebar('quests'); await settle();
    assert(document.querySelector('[role="alertdialog"]'), 'Initialization uses the shared focus-trapped dialog');
  };
  const dialogButton = label => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === label);
  await check('Initialization Cancel, X, Escape and outside dismissal never initialize or save', async () => {
    for (const route of ['cancel', 'close', 'escape', 'outside']) {
      await openInitialization(); const start = calls.length;
      assert.equal(document.activeElement.textContent, t('common.cancel'), 'Safe default focus is Cancel');
      await act(async () => {
        if (route === 'cancel' || route === 'close') dialogButton(t(`common.${route}`)).click();
        else if (route === 'escape') document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else { const overlay = [...document.querySelectorAll('[data-state="open"].bg-black\\/40')].at(-1); overlay.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })); overlay.click(); }
      }); await settle();
      assert.equal(document.querySelector('[role="alertdialog"]'), null);
      assert.equal(calls.slice(start).filter(call => ['initialize_empty_table', 'save_project'].includes(call.command)).length, 0);
      assert.equal(boundary.viewProps.tableData.uuid, 'jobs');
    }
    parseFailures.clear();
  });
  await check('Only positive initialization writes its captured target, and repeated clicks submit once', async () => {
    await openInitialization(); const start = calls.length; const approve = dialogButton(t('file.initialize'));
    await act(async () => { approve.click(); approve.click(); }); await settle();
    const changes = calls.slice(start).filter(call => ['initialize_empty_table', 'save_project'].includes(call.command));
    assert.deepEqual(changes.map(call => call.command), ['initialize_empty_table', 'save_project']);
    assert.deepEqual(changes[0].args, { path: 'quests.table.toml', expectedProjectSession: session });
    assert.equal(document.querySelector('[role="alertdialog"]'), null); active('quests');
  });
  await check('Newer navigation and project replacement retire an old initialization decision', async () => {
    await openInitialization(); let approve = dialogButton(t('file.initialize')); let start = calls.length;
    await sidebar('equipment'); assert.equal(document.querySelector('[role="alertdialog"]'), null);
    await act(async () => approve.click()); await settle();
    assert.equal(calls.slice(start).filter(call => call.command === 'initialize_empty_table').length, 0); active('equipment');
    await openInitialization(); approve = dialogButton(t('file.initialize')); start = calls.length;
    session = 'initialization-replaced'; await mount(); await act(async () => approve.click()); await settle();
    assert.equal(calls.slice(start).filter(call => call.command === 'initialize_empty_table').length, 0); active(null); parseFailures.clear();
  });
  const report={passed:reports.length,checks:reports,ipcCalls:calls.length,scope:'Real ProjectView/TableTabView/FileBrowserView/FileTree/FileNodeComponent and hooks; synthetic DOM, native IPC/dialogs, unrelated editor leaves mocked. Native WebKit QA remains separate.'};
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(root)await React.act(()=>root.unmount());await window.happyDOM.close();await rm(temporary,{recursive:true,force:true});delete globalThis.__tabSelectionTest;}
