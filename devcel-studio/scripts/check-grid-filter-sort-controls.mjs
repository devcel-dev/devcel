// Actual React controls, Radix dismissal, and local view-state workflows.
// Geometry is synthetic; native WebKit appearance and hit targets require separate QA.
import assert from 'node:assert/strict';
import {writeFile, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
const project=resolve(import.meta.dirname,'..');
const temporary=await mkdtemp(resolve(project,'.grid-filter-sort-controls-check-'));
let root, React;
const window=new Window({url:'http://editor.invalid'});
for(const name of ['window','document','navigator','HTMLElement','HTMLButtonElement','HTMLInputElement','HTMLSelectElement','HTMLDivElement','Element','Node','NodeFilter','Event','CustomEvent','MouseEvent','PointerEvent','KeyboardEvent','InputEvent','FocusEvent','MutationObserver','CSS','localStorage','sessionStorage']) Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?window:window[name]});
for(const name of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])globalThis[name]=window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=window.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
try {
const boundary={'@tauri-apps/api/core':`export const invoke=async()=>[];export const isTauri=()=>false;`,'@/app/commands/tableCommands':`export const getTableCatalog=async()=>[];`};
const bundle=await build({absWorkingDir:project,stdin:{contents:`export {GridColumnFilterButton,GridSortDialog} from './src/app/pages/main_window/project_view/table_view/components/GridFilterSortControls'; export {t} from './src/app/i18n';`,resolveDir:project,loader:'ts'},bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',write:false,alias:{'@':resolve(project,'src')},plugins:[{name:'fixture',setup(b){b.onResolve({filter:/.*/},args=>Object.hasOwn(boundary,args.path)?{path:args.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:boundary[args.path],loader:'js'}));b.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));}}]});
const file=resolve(temporary,'controls.mjs');await writeFile(file,bundle.outputFiles[0].text);
const {GridColumnFilterButton,GridSortDialog,t}=await import(pathToFileURL(file));
React=await import('react');const {createRoot}=await import('react-dom/client');const {act}=React;
const host=document.createElement('div');document.body.append(host);const outside=document.createElement('button');outside.textContent='outside';document.body.append(outside);root=createRoot(host);
const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,10));});
const col=(id,type='String')=>({ min_version: 0,uuid:id,display_name:id,data_name:id,data_type:type,tooltip:'',tags:[],read_only: false, default_value:'',style:{color:'',font_size:14,width:100},memo_text:'',reference_config:null});
let props,changes=[],sortChanges=[],opens=0;
const render=async()=>{await act(async()=>root.render(React.createElement(GridColumnFilterButton,props)));await settle();};
const mount=async(extra={})=>{await act(async()=>root.render(null));await settle();changes=[];sortChanges=[];opens=0;props={column:col('name'),rows:['sword','bow','staff'].map((name,i)=>({rowId:String(i),rowIndex:i,rowLabel:'',name})),sorts:[],onFilterChange:f=>changes.push(f),onSortChange:s=>sortChanges.push(s),onOpenSort:()=>opens++,...extra};await render();};
const clickEl=async el=>{assert(el,'element exists');await act(async()=>{el.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}));el.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true}));el.click();});await settle();};
const btn=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text);
const click=text=>clickEl(btn(text));
const open=()=>clickEl(document.querySelector('.grid-fs-trigger'));
const edit=async(el,value)=>{await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new window.InputEvent('input',{bubbles:true}));});await settle();};
const select=async(el,value)=>{await act(async()=>{el.value=value;el.dispatchEvent(new window.Event('change',{bubbles:true}));});await settle();};
const key=async(el,key)=>{await act(async()=>el.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})));await settle();};
const check=async(name,fn)=>{await fn();console.log('PASS',name)};
await check('Open, choose checkbox, one outside click cancels draft',async()=>{await mount();await open();assert(document.querySelector('.grid-fs-popover'));await clickEl(document.querySelector('.grid-fs-value-row input'));assert(document.querySelector('.grid-fs-select-all input').indeterminate);await clickEl(outside);assert(!document.querySelector('.grid-fs-popover'));assert.equal(changes.length,0);await open();assert([...document.querySelectorAll('.grid-fs-value-row input')].every(e=>e.checked));});
await check('Search applies only matching values without toggling a checkbox',async()=>{await edit(document.querySelector('input[type=search]'),'bow');await click(t('grid.filterSort.apply'));assert.deepEqual(changes.at(-1).values,['bow']);});
await check('An explicit empty selection remains a zero-row filter',async()=>{await mount();await open();await clickEl(document.querySelector('.grid-fs-select-all input'));await click(t('grid.filterSort.apply'));assert.deepEqual(changes.at(-1).values,[]);});
await check('Escape dismisses without applying',async()=>{await mount();await open();await clickEl(document.querySelector('.grid-fs-value-row input'));await key(document.activeElement,'Escape');assert(!document.querySelector('.grid-fs-popover'));assert.equal(changes.length,0);});
await check('10,000 values mount a bounded slice and keyboard End reaches the last',async()=>{await mount({rows:Array.from({length:10000},(_,i)=>({rowId:String(i),rowIndex:i,rowLabel:'',name:`name${String(i).padStart(5,'0')}`}))});await open();assert(document.querySelectorAll('.grid-fs-value-row').length<=12);await key(document.querySelector('.grid-fs-value-row input'),'End');assert.equal(document.activeElement.dataset.valueIndex,'9999');});
await check('Two conditions, OR, exact number input, and invalid apply guarding',async()=>{await mount({column:col('name','U64'),rows:[]});await open();await click(t('grid.filterSort.numberFilter'));await click(t('grid.filterSort.greaterThan'));assert(document.querySelector('.grid-fs-condition-dialog'));assert(btn(t('grid.filterSort.apply')).disabled);await edit(document.querySelector('.grid-fs-condition-inputs input'),'18446744073709551614');assert(!btn(t('grid.filterSort.apply')).disabled);await select(document.querySelectorAll('.grid-fs-condition-row select')[1],'less_than');assert(btn(t('grid.filterSort.apply')).disabled);await edit(document.querySelectorAll('.grid-fs-condition-inputs input')[1],'10');await clickEl(document.querySelector('input[value=or]'));await click(t('grid.filterSort.apply'));assert.equal(changes.at(-1).join,'or');assert.equal(changes.at(-1).conditions[0].value,'18446744073709551614');assert.equal(changes.at(-1).conditions.length,2);});
await check('Sort ascending and clear only this column',async()=>{await mount();await open();await click(t('grid.filterSort.sortAscending'));assert.deepEqual(sortChanges.at(-1),[{columnUuid:'name',dataType:'String',direction:'asc'}]);await mount({sorts:[{columnUuid:'name',dataType:'String',direction:'asc'},{columnUuid:'other',dataType:'U64',direction:'desc'}]});await open();await click(t('grid.filterSort.clearColumnSort'));assert.deepEqual(sortChanges.at(-1),[{columnUuid:'other',dataType:'U64',direction:'desc'}]);});
await check('Sort dialog add/delete/reorder and cancel do not leak draft state',async()=>{await act(async()=>root.render(null));await settle();let applies=[],closed=[];const columns=[col('kind'),col('price','U64'),col('name')],sorts=[{columnUuid:'kind',dataType:'String',direction:'asc'},{columnUuid:'price',dataType:'U64',direction:'desc'}];const renderSort=async()=>{await act(async()=>root.render(React.createElement(GridSortDialog,{open:true,columns,sorts,onOpenChange:v=>closed.push(v),onApply:v=>applies.push(v)})));await settle();};await renderSort();await click(t('grid.filterSort.addLevel'));assert.equal(document.querySelectorAll('.grid-fs-sort-level').length,3);await click(t('grid.filterSort.moveUp'));assert.equal(document.querySelectorAll('.grid-fs-sort-level select')[2].value,'name');await click(t('grid.filterSort.deleteLevel'));assert.equal(document.querySelectorAll('.grid-fs-sort-level').length,2);await click(t('grid.filterSort.cancel'));assert.equal(applies.length,0);assert.deepEqual(closed,[false]);assert.deepEqual(sorts.map(s=>s.columnUuid),['kind','price']);});
await check('Submenu Escape returns to the column menu; condition Cancel discards draft and restores focus',async()=>{
  await mount();await open();await click(t('grid.filterSort.textFilter'));assert(document.querySelector('.grid-fs-submenu'));
  await key(document.activeElement,'Escape');assert(!document.querySelector('.grid-fs-submenu'));assert(document.querySelector('.grid-fs-popover'));
  await click(t('grid.filterSort.textFilter'));await click(t('grid.filterSort.contains'));await edit(document.querySelector('.grid-fs-condition-inputs input'),'sword');
  await click(t('grid.filterSort.cancel'));assert.equal(changes.length,0);assert.equal(document.activeElement,document.querySelector('.grid-fs-trigger'));
  await open();await click(t('grid.filterSort.textFilter'));await click(t('grid.filterSort.customFilter'));
  assert.equal(document.querySelector('.grid-fs-condition-inputs input').value,'');await key(document.activeElement,'Escape');assert(!document.querySelector('.grid-fs-condition-dialog'));
});
await check('Sort dialog Cancel returns focus to its opener',async()=>{
  await act(async()=>root.render(null));await settle();
  function Harness(){const[open,setOpen]=React.useState(false);return React.createElement(React.Fragment,null,
    React.createElement('button',{id:'sort-opener',onClick:()=>setOpen(true)},'Open sort'),
    React.createElement(GridSortDialog,{open,onOpenChange:setOpen,columns:[col('name')],sorts:[],onApply:()=>{}}));}
  await act(async()=>root.render(React.createElement(Harness)));await settle();const opener=document.querySelector('#sort-opener');opener.focus();
  await clickEl(opener);assert(document.querySelector('.grid-fs-dialog'));await click(t('grid.filterSort.cancel'));assert(!document.querySelector('.grid-fs-dialog'));assert.equal(document.activeElement,opener);
});
console.log('All 10 actual React controls integration checks passed. Geometry is synthetic; native rendering is verified separately.');
}finally{if(root)await React.act(async()=>root.unmount());await window.happyDOM.close();await rm(temporary,{recursive:true,force:true});}
