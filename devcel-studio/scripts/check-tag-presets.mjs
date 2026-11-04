// Real React selector and project settings. Native commands/events are fixtures.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(project, '.tag-presets-check-'));
const window = new Window({ url: 'http://tags.invalid' });
for (const name of ['window','document','navigator','HTMLElement','HTMLButtonElement','HTMLInputElement','Element','Node','NodeFilter','Event','CustomEvent','MouseEvent','PointerEvent','KeyboardEvent','InputEvent','FocusEvent','MutationObserver','CSS','localStorage','sessionStorage']) Object.defineProperty(globalThis, name, {configurable:true,value:name==='window'?window:window[name]});
for (const name of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) globalThis[name]=window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=window.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
let currentSession='s1', createdWindows=0, focusedWindows=0, emitted=[];
const windows=new Map();globalThis.__tagWindows=class { static async getByLabel(label){return windows.get(label)||null;} constructor(label,options){this.label=label;this.options=options;windows.set(label,this);createdWindows++;} async once(event,callback){if(event==='tauri://created')queueMicrotask(callback);return()=>{};} async show(){} async setFocus(){focusedWindows++;} };
window.HTMLElement.prototype.scrollIntoView=function(){};
let calls=[], held, resolveHeld, updateHeld, releaseUpdate;
let registry={presets:['dev','release','a,b'],revision:'1',project_session:'s1'};
globalThis.__tagInvoke=async(command,args)=>{calls.push({command,args}); if(command==='get_project_session')return currentSession?{id:currentSession}:null; if(command==='get_project_tags'){if(held) return held;return {...registry,project_session:args.expectedProjectSession};} if(command==='update_project_tag') { if(updateHeld) await updateHeld; return {state:{...registry,revision:'2'}}; }};
const handlers=new Map(); globalThis.__tagListen=async(event,handler)=>{handlers.set(event,handler);return()=>handlers.delete(event);};
const boundaries={ '@tauri-apps/api/core':`export const invoke=(...args)=>globalThis.__tagInvoke(...args); export const isTauri=()=>false;`, '@tauri-apps/api/event':`export const listen=(...args)=>globalThis.__tagListen(...args);export const emit=async()=>{};export const emitTo=async(...args)=>globalThis.__tagEmitTo(...args);`, '@tauri-apps/api/webviewWindow':`export const WebviewWindow=globalThis.__tagWindows;` };
globalThis.__tagEmitTo=async(...args)=>{emitted.push(args);handlers.get(args[1])?.({payload:args[2]});};
let root,React;
try {
 const bundled=await build({absWorkingDir:project,stdin:{contents:`export {TagSelector} from './src/app/components/tags/TagSelector';export {ProjectTagPresets} from './src/app/components/tags/ProjectTagPresets';export {t} from './src/app/i18n';export {validateDataName,changedTagNameError} from './src/app/utils/validation';export {InlineEditDialog} from './src/app/pages/main_window/project_view/table_view/components/DataGridInlineDialogs';export {showProjectEditDialog} from './src/app/utils/project_edit_dialog';`,resolveDir:project,loader:'ts'},bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',write:false,alias:{'@':resolve(project,'src')},plugins:[{name:'native',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(boundaries,a.path)?{path:a.path,namespace:'native'}:undefined);b.onLoad({filter:/.*/,namespace:'native'},a=>({contents:boundaries[a.path],loader:'js'}));}}]});
 const path=resolve(temporary,'tags.mjs');await writeFile(path,bundled.outputFiles[0].text);const {TagSelector,ProjectTagPresets,t,showProjectEditDialog,validateDataName,changedTagNameError,InlineEditDialog}=await import(pathToFileURL(path));React=await import('react');const {createRoot}=await import('react-dom/client');const {act}=React;
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);
 const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
 let values=['dev','orphan','a,b'],session='s1',disabled=false;
 const render=async()=>{await act(async()=>root.render(React.createElement(TagSelector,{value:values,expectedProjectSession:session,disabled,onChange:next=>{values=next;}})));await settle();};
 const edit=async(el,value)=>{await act(async()=>{el.focus();Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new window.InputEvent('input',{bubbles:true}));});await render();};
 await render();assert.deepEqual(values,['dev','orphan','a,b']);assert.equal(document.querySelectorAll('input').length,1);assert(calls.every(c=>c.command==='get_project_tags'),'opening must not scan usage');

 const originalValues=[...values];await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent===t('tags.manage')).click());await settle();assert.deepEqual(values,originalValues);assert.equal(createdWindows,1);assert(windows.get('project-edit-dialog').options.url.includes('focusTags=1'));assert(windows.get('project-edit-dialog').options.url.includes('projectSession=s1'));
 await act(async()=>showProjectEditDialog({expectedProjectSession:'s1',focusTags:true}));assert.equal(createdWindows,1);assert.equal(focusedWindows,2);assert.equal(emitted.at(-1)[2].project_session,'s1');
 currentSession='s2';await assert.rejects(showProjectEditDialog({expectedProjectSession:'s1',focusTags:true}));assert.equal(focusedWindows,2);currentSession='s1';
 registry={...registry,presets:[...registry.presets,'added']};await act(async()=>handlers.get('project-tags-changed')({payload:{project_session:'s1'}}));await render();assert.deepEqual(values,originalValues);assert.equal(document.querySelector('input').value,'orphan');console.log('PASS manager jump preserves draft, reuses window, rejects stale session, and refreshes preset candidates');
 let orphan=document.querySelector('input');await edit(orphan,'dev');assert.equal(document.querySelector('input'),orphan,'registered prefix must not destroy input');await edit(orphan,'development');assert.equal(orphan.value,'development');await act(async()=>orphan.blur());await render();assert.equal(document.querySelector('input').value,'development');
 await edit(document.querySelector('input'),'release');await act(async()=>document.querySelector('input').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));await render();assert.equal(document.querySelectorAll('input').length,0);assert.deepEqual(values,['dev','release','a,b']);assert.equal(document.activeElement.tagName,'BUTTON');console.log('PASS mixed tags, comma-preservation, prefix typing, committed known-name fallback and focus');


 values=['dev',' dev ','keep'];await render();let removal=host.querySelectorAll('[data-tag-remove-owner]')[1];await act(async()=>document.querySelector('input').focus());
 await act(async()=>{
   const down=new window.MouseEvent('mousedown',{bubbles:true,cancelable:true});removal.dispatchEvent(down);
   if(!down.defaultPrevented)removal.focus();
   removal.dispatchEvent(new window.MouseEvent('mouseup',{bubbles:true}));removal.click();
 });await render();assert.deepEqual(values,['dev','keep']);console.log('PASS pointer remove cannot retarget after orphan blur deduplication');
 values=['dev',' dev ','keep'];await render();removal=host.querySelectorAll('[data-tag-remove-owner]')[1];await act(async()=>document.querySelector('input').focus());
 await act(async()=>removal.focus());await render();assert.deepEqual(values,['dev',' dev ','keep']);await act(async()=>removal.click());await render();assert.deepEqual(values,['dev','keep']);console.log('PASS keyboard remove focus preserves target until click');
 values=['dev',' orphan ','a,b'];await render();await edit(document.querySelector('input'),' release ');await act(async()=>document.querySelector('input').blur());await render();assert.deepEqual(values,['dev','release','a,b']);assert.equal(document.querySelectorAll('input').length,0);console.log('PASS orphan blur trims before preset classification');
 values=['dev','orphan','a,b'];await render();await edit(document.querySelector('input'),' dev ');await act(async()=>document.querySelector('input').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));await render();assert.deepEqual(values,['dev','a,b']);assert.equal(document.querySelectorAll('input').length,0);assert.equal(document.activeElement.tagName,'BUTTON');console.log('PASS orphan Enter trims and deduplicates existing preset without focus loss');
 values=['dev','release','a,b'];await render();
 await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(t('tags.select'))).click());await render();assert.equal(document.querySelectorAll('input[type=checkbox]').length,4);const check=[...document.querySelectorAll('input[type=checkbox]')][0];await act(async()=>check.click());await render();assert.deepEqual(values,['release','a,b']);console.log('PASS searchable preset multi-select removal');
 disabled=true;await render();assert([...host.querySelectorAll('button')].every(b=>b.disabled));disabled=false;
 held=new Promise(r=>resolveHeld=r);session='old';await render();session='new';await render();held=null;await act(async()=>resolveHeld({presets:['wrong'],revision:'0',project_session:'old'}));await render();assert(!host.textContent.includes('wrong'));console.log('PASS disabled controls and stale session load rejection');
 await act(async()=>root.render(null));await settle();calls=[];

 window.history.replaceState(null,'','?focusTags=1&projectSession=s1');held=new Promise(r=>resolveHeld=r);
 await act(async()=>root.render(React.createElement(ProjectTagPresets,{expectedProjectSession:'s1',disabled:false,onBusyChange:()=>{}})));await settle();
 assert(host.querySelector('input').disabled);assert.notEqual(document.activeElement,host.querySelector('input'));
 await act(async()=>resolveHeld(registry));held=null;await settle();await settle();assert.equal(document.activeElement,host.querySelector('input'));window.history.replaceState(null,'','/');console.log('PASS initial URL focus waits for async registry and enabled input');

 const nameInput=host.querySelector('input');await act(async()=>{nameInput.focus();Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(nameInput,'draft retained');nameInput.dispatchEvent(new window.InputEvent('input',{bubbles:true}));});await settle();
 nameInput.blur();await act(async()=>handlers.get('project-edit-focus-tags')({payload:{project_session:'other'}}));await settle();assert.notEqual(document.activeElement,nameInput);
 await act(async()=>handlers.get('project-edit-focus-tags')({payload:{project_session:'s1'}}));await settle();assert.equal(document.activeElement,nameInput);assert.equal(nameInput.value,'draft retained');console.log('PASS matching-session manager focus preserves existing new-tag draft');
 const buttons=()=>[...host.querySelectorAll('button')];await act(async()=>buttons().find(b=>b.textContent===t('tags.rename')).click());await settle();const rename=host.querySelector('li input');await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(rename,'renamed');rename.dispatchEvent(new window.InputEvent('input',{bubbles:true}));});await settle();await act(async()=>buttons().find(b=>b.textContent===t('tags.rename')).click());await settle();assert.equal(calls.filter(c=>c.command==='update_project_tag').length,0);assert(host.querySelector('[role=alertdialog]').textContent.includes('renamed'));assert(host.querySelector('[role=alertdialog]').textContent.includes('dev'));await act(async()=>host.querySelector('[role=alertdialog] button:last-child').click());await settle();assert.equal(calls.filter(c=>c.command==='update_project_tag').length,1);assert.deepEqual(calls.find(c=>c.command==='update_project_tag').args,{operation:'rename',name:'dev',newName:'renamed',expectedRevision:'1',expectedProjectSession:'s1'});console.log('PASS explicit project-wide rename confirmation and revision/session payload');

 calls=[];updateHeld=new Promise(r=>releaseUpdate=r);
 await act(async()=>buttons().find(b=>b.textContent===t('common.delete')).click());await settle();
 const confirmation=host.querySelector('[role=alertdialog]');assert(confirmation);assert.equal(calls.length,0);
 await act(async()=>{confirmation.querySelector('button:last-child').click();confirmation.querySelector('button:last-child').click();});await settle();
 assert.equal(calls.filter(c=>c.command==='update_project_tag').length,1);
 await act(async()=>handlers.get('project-tag-progress')({payload:{project_session:'s1',phase:'scanning',scanned_tables:3,total_tables:8}}));await settle();
 assert.equal(host.querySelector('progress').value,3);assert.equal(host.querySelector('progress').max,8);
 assert([...host.querySelectorAll('button')].every(b=>b.disabled));
 await act(async()=>releaseUpdate());await settle();updateHeld=null;console.log('PASS delete confirmation, repeated click guard, progress, busy lock');

 // Shared rules, including unchanged legacy values and no new reserved words.
 for(const good of ['alpha','_','_a9','for','A'.repeat(255)])assert.equal(validateDataName(good).isValid,true,good);
 for(const bad of ['1alpha','two words','bad/name','bad-name','名前','🙂','A'.repeat(256)])assert.equal(validateDataName(bad).isValid,false,bad);
 assert.equal(changedTagNameError(['bad/name','release'],['bad/name']),undefined);
 assert.equal(changedTagNameError([' bad/name ','release'],[' bad/name ']),undefined);
 assert(changedTagNameError(['changed/name'],['bad/name']));assert(changedTagNameError(['bad/name'],[' bad/name ']));
 await act(async()=>root.render(null));await settle();values=['dev','bad/name'];session='s1';await render();
 let invalidInput=document.querySelector('input');await edit(invalidInput,'new/bad');await act(async()=>invalidInput.blur());await render();assert.equal(document.querySelector('input').value,'new/bad');assert(host.querySelector('[role=alert]'));assert(values.includes('new/bad'));await edit(document.querySelector('input'),'fixed_name');await act(async()=>document.querySelector('input').blur());await render();assert(!host.querySelector('[role=alert]'));assert(values.includes('fixed_name'));console.log('PASS shared name rules preserve typing and unchanged legacy tags; invalid correction remains editable');
 await act(async()=>root.render(null));await settle();values=[' bad/name ','dup/name','dup/name','edit/me'];await render();const legacyInputs=host.querySelectorAll('input');await edit(legacyInputs[3],'fixed_name');await act(async()=>host.querySelectorAll('input')[3].blur());await render();assert.deepEqual(values,[' bad/name ','dup/name','dup/name','fixed_name']);console.log('PASS correcting one orphan preserves unrelated raw legacy values and duplicates');
 await act(async()=>root.render(null));await settle();calls=[];
 await act(async()=>root.render(React.createElement(ProjectTagPresets,{expectedProjectSession:'s1',disabled:false,onBusyChange:()=>{}})));await settle();
 const type=async(el,value)=>{await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new window.InputEvent('input',{bubbles:true}));});await settle();};
 await type(host.querySelector('input'),'bad tag');assert(buttons().find(b=>b.textContent===t('common.add')).disabled);assert(host.querySelector('[role=alert]'));assert.equal(host.querySelector('input').value,'bad tag');
 await type(host.querySelector('input'),'valid_tag');assert(!buttons().find(b=>b.textContent===t('common.add')).disabled);
 await act(async()=>buttons().find(b=>b.textContent===t('tags.rename')).click());await settle();await type(host.querySelector('li input'),'1bad');assert(buttons().find(b=>b.textContent===t('tags.rename')).disabled);assert.equal(calls.filter(c=>c.command==='update_project_tag').length,0);console.log('PASS preset Add/Rename block invalid names before mutation while preserving text');
 await act(async()=>root.render(null));await settle();let labelSaves=[];
 const mountLabel=async initialValue=>{await act(async()=>root.render(null));await settle();await act(async()=>root.render(React.createElement(InlineEditDialog,{isOpen:true,initialValue,position:{x:20,y:20},onSave:value=>labelSaves.push(value),onCancel:()=>{}})));await settle();};
 await mountLabel('Legacy row');let labelInput=document.querySelector('input');assert(!document.querySelector('button[type=submit]').disabled);
 await type(labelInput,'new row');assert.equal(labelInput.value,'new row');assert(document.querySelector('button[type=submit]').disabled);assert(document.querySelector('[role=alert]'));
 await act(async()=>document.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));assert.deepEqual(labelSaves,[]);
 await type(labelInput,'valid_row');await act(async()=>document.querySelector('button[type=submit]').click());await settle();assert.deepEqual(labelSaves,['valid_row']);
 await type(labelInput,'');assert(!document.querySelector('button[type=submit]').disabled);await act(async()=>document.querySelector('button[type=submit]').click());await settle();assert.deepEqual(labelSaves,['valid_row','']);
 await mountLabel('');await type(document.querySelector('input'),'1bad');assert(document.querySelector('button[type=submit]').disabled);await type(document.querySelector('input'),'_row2');assert(!document.querySelector('button[type=submit]').disabled);console.log('PASS row-label new/change validation, unchanged legacy retention, draft preservation and empty clear');
 console.log('Tag preset integration passed');
}finally{if(root)await React.act(async()=>root.unmount());await window.happyDOM.close();await rm(temporary,{recursive:true,force:true});}
