// Production hook/toolbar/mutation-gate integration. IPC is controlled; native paint is separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { compileModule } = require('./compile-module.cjs');
const rootDir = path.resolve(__dirname, '..');
const base = 'src/app/pages/main_window/project_view/table_view/components/';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
function loadSource(source, name, mocks) {
  const filename=path.join(rootDir,name); const mod=new Module(filename);
  mod.paths=Module._nodeModulePaths(rootDir);
  mod.require=id=>Object.hasOwn(mocks,id)?mocks[id]:id.endsWith('.css')?{}:require(id);
  mod._compile(compileModule(source,filename),filename); return mod.exports;
}
const load=(name,mocks)=>loadSource(fs.readFileSync(path.join(rootDir,name),'utf8'),name,mocks);
(async()=>{
  const {Window}=await import('happy-dom'); const w=new Window();
  for(const name of ['document','navigator','HTMLElement','HTMLInputElement','Element','Node','Event','MouseEvent','KeyboardEvent']) Object.defineProperty(globalThis,name,{configurable:true,value:w[name]});
  globalThis.window=w; globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const React=require('react'); const {act}=React; const {createRoot}=require('react-dom/client');
  const host=document.createElement('div');document.body.append(host); const root=createRoot(host);
  const pending=[]; let actual; let renders=[]; let mutation; let undoClicks=0,redoClicks=0;
  const noop=()=>{}; const Wrapper=({children})=>React.createElement(React.Fragment,null,children);
  const i18n={useI18n:()=>({t:k=>k}),formatNumber:String,message:k=>k,localizeError:e=>typeof e==='string'?e:JSON.stringify(e)};
  const {useTableHistory}=load(base+'useTableHistory.ts',{'@tauri-apps/api/core':{invoke:(name,args)=>{assert.equal(name,'get_table_history_status');const d=deferred();pending.push({...d,args});return d.promise;}}});
  const {DataGridToolbar}=load(base+'DataGridToolbar.tsx',{'@/app/i18n':i18n,'./TableActionIcons':{AddRowIcon:noop,AddColumnIcon:noop,TableSettingsIcon:noop},'./VersionControls':{VersionViewControls:noop},'./TableSearchBar':{TableSearchBar:noop},'@/components/ui/context-menu':{ContextMenu:Wrapper,ContextMenuTrigger:Wrapper,ContextMenuContent:noop,ContextMenuItem:noop}});
  const {useTableMutation}=load(base+'useTableMutation.ts',{'@/app/settings/settingsApply':{beginSettingsSave:noop},'@/app/services/tableSnapshotInvalidation':{getTableSnapshotInvalidationVersion:()=>0},'@/app/services/tableInteractionScope':{captureTableInteractionScope:()=>1,isTableInteractionScopeCurrent:()=>true,subscribeTableInteractionScope:()=>noop},'@/app/i18n':i18n,'./gridErrorNotice':{gridErrorNotice:(m,e)=>e,resolveGridError:e=>e?JSON.stringify(e):''},'@tauri-apps/api/core':{invoke:()=>{throw Error('Unexpected write');}},'@/app/utils/table_rule_dialogs':{confirmInputWarnings:noop},'@/app/types/tableRules':{inputValidationReport:()=>null}});
  function Harness(props){actual=useTableHistory(props.table,props.session,props.basis,props.enabled);renders.push({...actual});return React.createElement(DataGridToolbar,{...actual,isUpdating:!props.enabled,undo:()=>undoClicks++,redo:()=>redoClicks++,addRowsAllowed:false,addColumnsAllowed:false,searchQuery:'',isSearching:false,rowCount:1,columnCount:1,pendingChangesCount:0,isSaving:false,addRow:noop,addRows:noop,addColumn:noop});}
  function Gate(){mutation=useTableMutation('a','session',noop);return null;}
  const render=async props=>act(async()=>root.render(React.createElement(Harness,props)));
  const answer=async(d,value)=>act(async()=>{d.resolve(value);await d.promise;});
  const undo=()=>document.querySelector('[title="grid.undoShortcut"]'); const redo=()=>document.querySelector('[title="grid.redoShortcut"]');
  const click=async b=>act(async()=>b.click());
  const props={table:'a',session:'session',basis:{table_uuid:'a',revision:'0'},enabled:true};
  const oldWarn=console.warn;
  try {
    await render(props); assert.deepEqual(actual,{canUndo:false,canRedo:false});
    assert(undo().disabled&&redo().disabled);
    await answer(pending.shift(),{canUndo:false,canRedo:false}); await click(undo()); await click(redo());assert.equal(undoClicks+redoClicks,0);
    await render({...props,basis:{...props.basis,revision:'1'}});await answer(pending.shift(),{canUndo:true,canRedo:false});
    assert(!undo().disabled&&redo().disabled);await click(undo());assert.equal(undoClicks,1);
    await render({...props,basis:{...props.basis,revision:'2'}});await answer(pending.shift(),{canUndo:false,canRedo:true});
    assert(undo().disabled&&!redo().disabled);await click(redo());assert.equal(redoClicks,1);
    await render({...props,basis:{...props.basis,revision:'3'}});await answer(pending.shift(),{canUndo:true,canRedo:false});
    assert(!undo().disabled&&redo().disabled);
    await render({...props,enabled:false});assert(undo().disabled&&redo().disabled);await click(undo());assert.equal(undoClicks,1);
    console.log('PASS history empty/edit/undo/redo and busy: actual hook flags and button disabled/click states');

    await render(props);const old=pending.shift();const replacement={...props,table:'b',basis:{table_uuid:'b',revision:'0'}};
    await render(replacement);const newer=pending.shift();await answer(newer,{canUndo:false,canRedo:true});await answer(old,{canUndo:true,canRedo:false});
    assert.deepEqual(actual,{canUndo:false,canRedo:true});
    renders=[];await render({...replacement,table:'c'});assert.deepEqual(renders[0],{canUndo:false,canRedo:false},'even reused basis cannot leak old table flags');const crossTable=pending.shift();
    await render({...replacement,table:'c',session:'new-session'});const crossSession=pending.shift();await answer(crossTable,{canUndo:true,canRedo:true});assert.deepEqual(actual,{canUndo:false,canRedo:false});await answer(crossSession,{canUndo:false,canRedo:false});
    await render({...replacement,session:'failure'});const failure=pending.shift();console.warn=()=>{};await act(async()=>{failure.reject({kind:'code',code:'error.io'});await Promise.resolve();});console.warn=oldWarn;assert(undo().disabled&&redo().disabled);
    console.log('PASS late responses, same-basis table switch, session switch and status read failure fail closed');

    await act(async()=>root.render(React.createElement(Gate)));
    const source=fs.readFileSync(path.join(rootDir,base+'DataGridView.tsx'),'utf8');
    const start=source.indexOf('  const changeHistory = useCallback(');const end=source.indexOf('  useEffect(() => {',start);
    assert(start>=0&&end>start);
    const {wire}=loadSource(`export function wire(deps) { const {useCallback,runExclusiveMutation,invoke,tableData,projectSessionId,refreshData,getCurrentPresentation,canUndo,canRedo}=deps;${source.slice(start,end)} return {undo,redo}; }`,base+'history-fixture.ts',{});
    let calls=0,refreshes=0;let reply='ok';let rejection=null;let waiting=null;
    const bindings=(canUndo=true,canRedo=true)=>wire({useCallback:f=>f,runExclusiveMutation:mutation.runExclusive,invoke:async()=>{calls++;if(waiting)await waiting.promise;if(rejection)throw rejection;return reply;},tableData:{uuid:'a'},projectSessionId:'session',refreshData:async()=>refreshes++,getCurrentPresentation:()=>({}),canUndo,canRedo});
    await act(async()=>{await bindings(false,false).undo();await bindings(false,false).redo();});assert.equal(calls,0,'shortcut handlers share availability guard');
    reply='empty';await act(async()=>{await bindings().undo();});assert.equal(refreshes,0);assert.equal(mutation.error,'');
    rejection={kind:'code',code:'error.io',params:{details:'disk failure'}};await act(async()=>{await bindings().undo();});assert.match(mutation.error,/error.io/);
    rejection={kind:'code',code:'error.historyUnavailable',params:{}};await act(async()=>{await bindings().redo();});assert.match(mutation.error,/historyUnavailable/,'unsafe restoration is not confused with empty');
    rejection=null;reply='ok';await act(async()=>{await bindings().redo();});assert.equal(refreshes,1);assert.equal(mutation.error,'');
    waiting=deferred();const before=calls;let first;await act(async()=>{first=bindings().undo();await bindings().undo();});assert.equal(calls,before+1,'second click cannot queue behind an in-flight history operation');await act(async()=>{waiting.resolve();await first;});assert.equal(refreshes,2);
    console.log('PASS actual history callbacks + mutation gate: shortcuts, empty no-op, true I/O/unsafe-history errors, successful refresh, repeated-click exclusion');
  } finally {console.warn=oldWarn;await act(async()=>root.unmount());w.happyDOM.abort();}
})().catch(error=>{console.error(error);process.exitCode=1;});
