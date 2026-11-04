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
const temporary = await mkdtemp(resolve(project, '.filename-rename-check-'));
const before = process.env.FILENAME_RENAME_BEFORE;
const reports = [], calls = [], dialogs = [], pluginSelections = [];
const messages = JSON.parse(await readFile(resolve(project, 'src/app/i18n/generated/catalog.json'), 'utf8')).messages.ja;
const t = (key, values) => { assert(Object.hasOwn(messages, key), key); return String(new IntlMessageFormat(messages[key], 'ja', undefined, { ignoreTag: true }).format(values)); };
const window = new Window({ url: 'http://tab-selection.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver', 'CSS', 'localStorage', 'sessionStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
Object.defineProperties(window.HTMLElement.prototype, { offsetWidth:{configurable:true,get:()=>900},clientWidth:{configurable:true,get:()=>900},offsetHeight:{configurable:true,get:()=>400},clientHeight:{configurable:true,get:()=>400} });
window.HTMLElement.prototype.getBoundingClientRect = function() { return new window.DOMRect(0,0,900,400); };
const files = ['equipment', 'quests', 'jobs'].map(uuid => { const name = uuid === 'quests' ? '013_quests.table.toml' : `${uuid}.table.toml`; return {id:name,path:name,name,type:'table',uuid}; });
files.push({id:'Combatant.interface.toml',path:'Combatant.interface.toml',name:'Combatant.interface.toml',type:'interface',uuid:'combatant'});
files.push({id:'readme.md',path:'readme.md',name:'readme.md',type:'markdown'});
files.push({id:'nested',path:'nested',name:'nested',type:'folder'},{id:'nested/notes.md',path:'nested/notes.md',name:'notes.md',type:'markdown'});
let session='session-A', failFlush=false, nextFlush=null, pathLookup=null, validationDelay=null, failRename=false, failEntries=false, moveSuffix=false;
const tableReadDelays=new Map();
const prompts=[], promptAnswers=[];globalThis.prompt=(text, value)=>{prompts.push({text,value});return promptAnswers.shift()??null;};globalThis.alert=text=>dialogs.push([text]);
const tables=Object.fromEntries(files.filter(f=>f.type==='table').map(f=>[f.uuid,{metadata:{initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, uuid:f.uuid,data_name:f.uuid},schema:{columns:[]},records:[]}]));
const invoke=async(command,args={})=>{
  calls.push({command,args});
  if(command === 'validate_file_name_command') {
    if(validationDelay) await validationDelay.promise;
    if(!args.name || /[\\/\0]/.test(args.name)) throw Error('invalid filename');
    const extension=args.fileType==='Table'?'.table.toml':'.interface.toml';
    return args.name.endsWith(extension)?args.name:`${args.name}${extension}`;
  }
  assert.equal(args.expectedProjectSession,session,`session-bound IPC: ${command}`);
  if(command === 'file_operation') {
    assert(['Rename','Move'].includes(args.operation.type));if(failRename)throw Error('destination already exists');
    const {old_path,new_name,new_path,type}=args.operation;const index=files.findIndex(file=>file.path===old_path);assert(index>=0);
    const old=files[index];const parts=old.path.split('/');parts[parts.length-1]=new_name;
    let path=type==='Move'?new_path:parts.join('/');if(type==='Move'&&moveSuffix)path=path.replace('.table.toml','_1.table.toml');
    files[index]={...old,id:path,path,name:path.split('/').pop()};
    return type==='Move'?{type:'Moved',entry:{file_type:args.operation.file_type,path,uuid:old.uuid}}:{type:'Completed'};
  }
  switch(command){case 'prepare_table_rule_snapshot':return `evaluation-${calls.length}`;case 'cancel_table_rule_snapshot':return true;case 'get_table_rule_snapshot':if(tableReadDelays.has(args.tableUuid))await tableReadDelays.get(args.tableUuid).promise;return {kind:'snapshot',snapshot_token:null,retained_bytes:1024,table:tables[args.tableUuid],presentation:{table_uuid:args.tableUuid,revision:'revision',cells:{},definition_issues:[],issue_count:0}};case 'get_table_list':return files;case 'get_table_data':if(tableReadDelays.has(args.uuid))await tableReadDelays.get(args.uuid).promise;return tables[args.uuid];case 'check_and_apply_interface_updates':return 'ok';case 'get_table_path_by_uuid':return pathLookup?pathLookup.promise:`${args.tableUuid}.table.toml`;default:throw Error(`Unexpected IPC ${command}`);}
};
const boundary=globalThis.__tabSelectionTest={t,invoke,dialogs,files,tables,pluginSelections,get session(){return session;},operations:null, getEntries(){if(failEntries)throw Error('refresh unavailable');return files.map(f=>({path:f.path,entry_type:f.type==='folder'?'Directory':f.type==='table'?'Table':f.type==='interface'?'Interface':'Markdown',uuid:f.uuid}));}, async flush(){if(failFlush)throw Error('save blocked');const pending=nextFlush;nextFlush=null;if(pending)await pending.promise;},viewProps:null};
const mocks={
  '@/app/i18n':`export {applyRuntimeLocalization, applyPluginTranslationTables, matchLocale, translatePluginMessage} from ${JSON.stringify(resolve(project,'src/app/i18n/index.ts'))};const b=globalThis.__tabSelectionTest;export const t=b.t;export const getLocale=()=> 'ja';export const getLocaleName=code=>code;export const useI18n=()=>({t,locale:getLocale()});export const localizeError=v=>String(v||'');export const localizedError=localizeError;export const message=(key,values)=>({key,values});export const toAppError=v=>({kind:'text',text:String(v)});`,
  '@tauri-apps/api/core':`export const isTauri=()=>false; export const invoke=(...args)=>globalThis.__tabSelectionTest.invoke(...args);`,
  '@tauri-apps/api/event':`export const listen=async()=>()=>{};export const emit=async()=>{};`,
  '@tauri-apps/plugin-dialog':`export const message=async(...args)=>globalThis.__tabSelectionTest.dialogs.push(args);`,
  '@/app/services/appDialogs': `export const message=async(...args)=>globalThis.__tabSelectionTest.dialogs.push(args);export const ask=async()=>false;export const appAlert=message;export const appConfirm=ask;export const appPrompt=async(...args)=>globalThis.prompt?.(...args)??null;`,
  'react-dnd':`const connector=()=>{};export const useDrag=()=>[{},connector,connector];export const useDrop=()=>[{},connector];export const useDragLayer=()=>({isDragging:false});`,
  '@/app/commands/tableCommands':`const b=globalThis.__tabSelectionTest;export const loadTable=async()=> 'ok';export const invalidateTableCatalog=()=>{};export const getTableDisplayCatalog=async()=>[];export const getLoadedTables=async()=>b.files.filter(f=>f.type==='table').map(f=>({...f,path:'/fixtures/Tables/'+f.path,display_name:f.uuid}));export const renameTableDisplayName=async()=>{throw Error('unexpected rename')};export const isTableLoadingSessionCurrent=id=>id===b.session;`,
  '@/app/commands/projectCommands':`export const getProjectEntries=async()=>globalThis.__tabSelectionTest.getEntries();`,
  '@/app/utils/string_editor_window':`export const requestCloseStringEditor=async()=>true;export const showStringEditor=async()=>{};export const registerMainWindowCloseBlocker=()=>()=>{};`,
  '@/app/utils/markdownSaveLifecycle':`export const flushMarkdownEdits=(...args)=>globalThis.__tabSelectionTest.flush(...args);`,
  '@/app/services/PluginManager':`export class PluginManager {static getInstance(){return {setActiveTable(value){globalThis.__tabSelectionTest.pluginSelections.push(value);}}}}`,
  './components/FileHeader':`import React from 'react';export const getDisplayTitle=item=>item.name;export const FileHeader=({currentItem})=>React.createElement('h2',{'data-test-header':currentItem.id},currentItem.name);`,
  './components/FileViewRegistry':`import React from 'react';export const FileViewRenderer=props=>{globalThis.__tabSelectionTest.viewProps=props;return React.createElement('article',{'data-view-id':props.currentItem.id,'data-view-session':props.projectSessionId},props.currentItem.name);};`,
  './hooks/useFileOperations':`import {useFileOperations as real} from ${JSON.stringify(resolve(project,'src/app/pages/main_window/project_view/file_browser_view/hooks/useFileOperations.ts'))};export const useFileOperations=(...args)=>{const result=real(...args);globalThis.__tabSelectionTest.operations=result;return result;};`,
  './hooks/useKeyboardShortcuts':`export const useKeyboardShortcuts=()=>{};`,
  './components/FileTypeDialog':`export const FileTypeDialog=()=>null;`,
  '@/app/components/StatusBar':`export const StatusBar=()=>null;`,
  '@/app/components/P2PToast':`export const P2PToastContainer=()=>null;`,
  '/properties_panel/PropertiesPanel':`import React from 'react';export const PropertiesPanel=({selectedItem})=>React.createElement('aside',{'data-properties-id':selectedItem?.id||''});`,
  '@/app/components/interface/DuplicateInterfaceDetector':`export const DuplicateInterfaceDetector=()=>null;`,
};
let root,React;
try{
  const result=await build({absWorkingDir:project,stdin:{contents:`export {default as ProjectView} from './src/app/pages/main_window/project_view/ProjectView';`,resolveDir:project,loader:'ts'},bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',write:false,define:{'import.meta.env.DEV':'false'},alias:{'@':resolve(project,'src')},plugins:[{name:'boundaries',setup(builder){
    builder.onResolve({filter:/.*/},args=>{const key=Object.keys(mocks).find(key=>args.path===key||key.startsWith('/')&&args.path.endsWith(key));if(key)return{path:key,namespace:'boundary'};if(args.path.endsWith('.css'))return{path:args.path,namespace:'css'};});
    builder.onLoad({filter:/.*/,namespace:'boundary'},args=>({contents:mocks[args.path],loader:'js',resolveDir:project}));builder.onLoad({filter:/.*/,namespace:'css'},()=>({contents:'',loader:'js'}));
    if(before)builder.onLoad({filter:/(ProjectView\.tsx|TableTabView\.tsx|FileBrowserView\.tsx|useFileOperations\.ts|useFileTree\.ts)$/},async args=>({contents:await readFile(resolve(before,'devcel-studio',args.path.slice(project.length+1)),'utf8'),loader:args.path.endsWith('.tsx')?'tsx':'ts'}));
  }}]});
  const modulePath=resolve(temporary,'app.mjs');await writeFile(modulePath,result.outputFiles[0].text);const {ProjectView}=await import(pathToFileURL(modulePath));
  React=await import('react');const{createRoot}=await import('react-dom/client');const host=document.createElement('div');document.body.append(host);root=createRoot(host);const act=React.act;
  const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15));});};
  const mount=async()=>{await act(async()=>root.render(React.createElement(ProjectView,{key:session,projectSession:{id:session,path:'/fixtures/main.devcel'}})));await settle();await act(async()=>window.dispatchEvent(new window.Event('devcel-toggle-properties-panel')));};
  const file=id=>files.find(f=>f.uuid===id||f.id===id);
  const sidebarRow=id=>host.querySelector(`[data-file-id="${file(id).id}"] span[title="${file(id).name}"]`).parentElement;
  const sidebar=async id=>{await act(async()=>sidebarRow(id).click());await settle();};
  const tab=id=>[...host.querySelectorAll('.border-b-2')].find(node=>node.querySelector('span')?.textContent===file(id).name);
  const clickTab=async id=>{assert(tab(id),`tab ${id} exists`);await act(async()=>tab(id).click());await settle();};
  const rename=async(id,name)=>{promptAnswers.push(name);await act(async()=>{await boundary.operations.handleRename({...file(id)});});await settle();};
  const menuRename=async(id,name)=>{
    await act(async()=>sidebarRow(id).dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,button:2,clientX:20,clientY:20})));
    await settle();const item=[...document.querySelectorAll('[role=menuitem]')].find(node=>node.textContent.trim()===t('file.rename'));
    assert(item,'actual Radix rename menu item is open');promptAnswers.push(name);await act(async()=>item.click());await settle();
  };
  const move=async(id,folder)=>{await act(async()=>{await boundary.operations.handleMove(file(id).id,folder?file(folder):null,!folder);});await settle();};
  const close=async id=>{assert(tab(id));await act(async()=>tab(id).querySelector('button').click());await settle();};
  const active=id=>{
    const target=id?file(id):null;
    assert.equal(host.querySelector('[data-test-header]')?.getAttribute('data-test-header')??null,target?.id??null,'displayed table');
    assert.equal(host.querySelector('.border-b-2.border-primary')?.querySelector('span').textContent??null,target?.name??null,'active tab');
    const selected=[...host.querySelectorAll('[data-file-id]')].filter(node=>node.querySelector('.bg-secondary')).map(node=>node.getAttribute('data-file-id'));
    assert.deepEqual(selected,target?[target.id]:[],'sidebar selection matches active tab');
    assert.equal(host.querySelector('[data-properties-id]')?.getAttribute('data-properties-id'),target?.id??'','properties selection');
    assert.deepEqual(pluginSelections.at(-1),target?.type==='table'?{uuid:target.uuid,projectSession:session}:null,'plugin active table/session');
    if(target?.type==='table')assert.equal(boundary.viewProps.tableData?.uuid,target.uuid,'rendered editor owns committed UUID');
  };
  const check=async(name,action)=>{await action();reports.push(name);console.log('PASS',name);};
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
  await mount();await sidebar('equipment');await sidebar('quests');await sidebar('jobs');
  await check('Actual context menu rename preserves another active file selection',async()=>{
    await clickTab('equipment');active('equipment');await menuRename('quests','013_quest_journal');active('equipment');
    await menuRename('quests','013_quests');active('equipment');
  });
  await check('Actual context menu rename cancellation preserves selection and performs no mutation',async()=>{
    const count=calls.filter(call=>call.command==='file_operation').length;await menuRename('quests',null);active('equipment');
    assert.equal(calls.filter(call=>call.command==='file_operation').length,count);
  });
  await check('Actual active-row context menu rename retains its sidebar selection',async()=>{
    await clickTab('quests');await menuRename('quests','013_quest_journal');active('quests');
    await menuRename('quests','013_quests');active('quests');
  });
  await check('Real sidebar background clicks still clear selection after portal filtering',async()=>{
    const tree=host.querySelector('[data-file-tree-row-count]');await act(async()=>tree.parentElement.click());
    assert.equal([...host.querySelectorAll('[data-file-id]')].filter(node=>node.querySelector('.bg-secondary')).length,0);
    await clickTab('quests');active('quests');
  });
  await check('Numeric-prefix active middle table rename preserves active identity, tab order and UUID',async()=>{
    await clickTab('quests');const before=[...host.querySelectorAll('.border-b-2 span')].map(n=>n.textContent);
    await rename('quests','013_quest_journal');active('quests');assert.equal(file('quests').path,'013_quest_journal.table.toml');
    assert.equal(prompts.at(-1).value,'013_quests');assert.deepEqual([...host.querySelectorAll('.border-b-2 span')].map(n=>n.textContent),before.map(n=>n==='013_quests.table.toml'?'013_quest_journal.table.toml':n));
    assert(calls.some(c=>c.command==='validate_file_name_command'));assert.equal(tables.quests.metadata.data_name,'quests');
  });
  await check('Explicit table extension round trip adds no duplicate extension',async()=>{await rename('quests','013_quests.table.toml');active('quests');assert.equal(file('quests').path,'013_quests.table.toml');});
  await check('A consumed request for an inactive renamed tab cannot activate it again',async()=>{
    await sidebar('jobs');await clickTab('quests');await rename('jobs','010_jobs');active('quests');
    assert.equal(host.querySelector('[data-view-id]').getAttribute('data-view-id'),file('quests').id);
    assert.equal(host.querySelector('[data-properties-id]').getAttribute('data-properties-id'),file('quests').id);
    assert.deepEqual(pluginSelections.at(-1),{uuid:'quests',projectSession:session});
    await clickTab('quests');active('quests');await rename('jobs','jobs');active('quests');
  });
  await check('Inactive move preserves active sidebar selection and does not navigate',async()=>{
    await move('jobs','nested');active('quests');await move('jobs',null);active('quests');
  });
  await check('Relocation preserves Ctrl multi-selection and retargets the selected filename only',async()=>{
    await clickTab('quests');await act(async()=>sidebarRow('jobs').dispatchEvent(new window.MouseEvent('click',{bubbles:true,ctrlKey:true})));await settle();
    const activeBeforeRename=boundary.viewProps.tableData.uuid;
    await rename('jobs','010_jobs');assert(sidebarRow('quests').classList.contains('bg-secondary'));assert(sidebarRow('jobs').classList.contains('bg-secondary'));
    assert.equal(host.querySelector('[data-view-id]').getAttribute('data-view-id'),file(activeBeforeRename).id);
    await rename('jobs','jobs');await clickTab('quests');active('quests');
  });
  await check('Newer tab navigation during filename validation keeps its sidebar selection',async()=>{
    const pending=validationDelay=deferred();promptAnswers.push('013_pending');let operation;
    await act(async()=>{operation=boundary.operations.handleRename({...file('quests')});});await clickTab('equipment');
    validationDelay=null;await act(async()=>pending.resolve());await operation;await settle();active('equipment');
    await rename('quests','013_quests');active('equipment');await clickTab('quests');active('quests');
  });
  await check('Hidden sidebar remount reveals the renamed active table identity',async()=>{
    await rename('quests','013_quest_journal');await act(async()=>window.dispatchEvent(new window.Event('devcel-toggle-file-browser')));await act(async()=>window.dispatchEvent(new window.Event('devcel-toggle-file-browser')));await settle();active('quests');
  });
  await check('Active interface filename rename and full-extension restore keep properties and UUID aligned',async()=>{
    await sidebar('combatant');await rename('combatant','001_Combatant');active('combatant');assert.equal(file('combatant').id,'001_Combatant.interface.toml');assert.equal(file('combatant').uuid,'combatant');
    await rename('combatant','Combatant.interface.toml');active('combatant');assert.equal(file('combatant').id,'Combatant.interface.toml');await clickTab('quests');active('quests');
  });
  await check('Cancel, unchanged stem and unchanged full filename make no mutation',async()=>{
    const before=calls.filter(c=>c.command==='file_operation').length;await rename('quests',null);await rename('quests','013_quest_journal');await rename('quests','013_quest_journal.table.toml');assert.equal(calls.filter(c=>c.command==='file_operation').length,before);active('quests');
  });
  await check('Invalid leaf and backend destination collision preserve the old tab identity',async()=>{
    const before=file('quests').path;await rename('quests','../escape');assert.equal(file('quests').path,before);failRename=true;await rename('quests','013_collision');failRename=false;assert.equal(file('quests').path,before);active('quests');assert(dialogs.at(-1)[0].includes('destination already exists'));
  });
  await check('Moving an active table to a folder retargets its one tab, properties and sidebar',async()=>{
    const count=host.querySelectorAll('.border-b-2').length;await move('quests','nested');active('quests');assert.equal(file('quests').id,'nested/013_quest_journal.table.toml');await sidebar('quests');active('quests');assert.equal(host.querySelectorAll('.border-b-2').length,count);
    await move('quests',null);active('quests');assert.equal(file('quests').id,'013_quest_journal.table.toml');
  });
  await check('Move collision suffix follows the backend committed path rather than the requested path',async()=>{
    moveSuffix=true;await move('quests','nested');moveSuffix=false;active('quests');assert.equal(file('quests').id,'nested/013_quest_journal_1.table.toml');await move('quests',null);await rename('quests','013_quest_journal');active('quests');
  });
  await check('Reusing a relocated path for a different table never exposes the old cached UUID',async()=>{
    await clickTab('quests');await move('quests','nested');active('quests');
    await clickTab('jobs');await rename('jobs','013_quest_journal');active('jobs');
    assert.equal(boundary.viewProps.tableData.uuid,'jobs');
    await rename('jobs','jobs');await clickTab('quests');await move('quests',null);active('quests');
    assert.equal(boundary.viewProps.tableData.uuid,'quests');
  });
  await check('A late read from a moved table cannot block or replace a new owner of its old path',async()=>{
    await close('quests');const pending=deferred();tableReadDelays.set('quests',pending);await sidebar('quests');
    await move('quests','nested');await clickTab('jobs');await rename('jobs','013_quest_journal');active('jobs');
    tableReadDelays.delete('quests');await act(async()=>pending.resolve());await settle();active('jobs');
    await rename('jobs','jobs');await sidebar('quests');await move('quests',null);active('quests');
  });
  await check('Successful rename retargets active tab even if tree refresh fails',async()=>{
    failEntries=true;await rename('quests','013_quests');failEntries=false;
    assert.equal(host.querySelector('[data-view-id]').getAttribute('data-view-id'),file('quests').id);assert.equal(host.querySelector('[data-properties-id]').getAttribute('data-properties-id'),file('quests').id);assert(dialogs.at(-1)[0].includes('refresh unavailable'));
  });
  await check('Project replacement while filename validation waits cannot rename in the replacement project',async()=>{
    const pending=validationDelay=deferred();promptAnswers.push('013_stale');let operation;await act(async()=>{operation=boundary.operations.handleRename({...file('quests')});});
    const before=calls.filter(c=>c.command==='file_operation').length;session='session-B';await mount();validationDelay=null;await act(async()=>pending.resolve());await operation;await settle();assert.equal(calls.filter(c=>c.command==='file_operation').length,before);active(null);
  });
  const report={passed:reports.length,checks:reports,ipcCalls:calls.length,scope:'Real ProjectView/TableTabView/FileBrowserView/FileTree/FileNodeComponent/useFileOperations; native filename validation and file IO mocked, backed by separate Rust integration; synthetic DOM, native IPC/dialogs, unrelated editor leaves mocked. Native WebKit QA remains separate.'};
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(root)await React.act(()=>root.unmount());await window.happyDOM.close();await rm(temporary,{recursive:true,force:true});delete globalThis.__tabSelectionTest;}
