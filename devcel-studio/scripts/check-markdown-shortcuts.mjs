import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const window = new Window({url:'http://markdown-shortcuts.invalid'});
for (const name of ['window','document','navigator','HTMLElement','Element','Node','Text','Event','KeyboardEvent','MutationObserver','DOMParser','DOMRect','getSelection']) Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?window:typeof window[name]==='function'&&name==='getSelection'?window[name].bind(window):window[name]});
for(const name of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])globalThis[name]=window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let saves=0, content='hello';
const snapshot={content:'hello',isLoading:false,isSaving:false,isDirty:false,loadError:null,saveError:null};
globalThis.__markdownKeys={snapshot,update:value=>{content=value;},flush:async()=>{saves++;}};
const temp=await mkdtemp(resolve('.markdown-keys-'));let root;
try {
 const mocks={
  '@/app/i18n':`export const t=k=>k; export const useI18n=()=>({t}); export const localizeError=String; export const subscribeLocale=()=>()=>{};`,
  '@/app/utils/markdownSaveLifecycle':`const b=globalThis.__markdownKeys; const doc={snapshot:b.snapshot,subscribe:()=>()=>{},load:async()=>{},update:b.update,flush:b.flush,setCaptureError:e=>{throw e}}; export const markdownSaveCoordinator={open:()=>doc,release:()=>{}};`,
  '@/lib/markdown-slash-command':`import {Extension} from '@tiptap/core';export const slashCommand=Extension.create({name:'testSlashBoundary'});`,
  '@/lib/markdown-bubble-menu':`export const MarkdownBubbleMenu=()=>null;`
 };
 const result=await build({entryPoints:['src/app/pages/main_window/project_view/table_view/components/MarkdownView.tsx'],bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',write:false,alias:{'@':resolve('src')},plugins:[{name:'native-save-boundary',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js',resolveDir:process.cwd()}));}}]});
 const file=resolve(temp,'view.mjs');await writeFile(file,result.outputFiles[0].text);
 const {MarkdownView}=await import(pathToFileURL(file));const React=await import('react');const {createRoot}=await import('react-dom/client');const {act}=React;
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);
 await act(async()=>{root.render(React.createElement(MarkdownView,{filePath:'a.md',fileName:'a',expectedProjectSession:'qa'}));await new Promise(r=>setTimeout(r,40));});
 const editor=host.querySelector('.tiptap');assert(editor,'real Tiptap mounted');
 const press=async(target,options)=>{let e;await act(async()=>{e=new window.KeyboardEvent('keydown',{bubbles:true,cancelable:true,...options});target.dispatchEvent(e);});return e;};
 await act(async()=>editor.editor.commands.selectAll());
 await press(editor,{key:'s',ctrlKey:true,shiftKey:true});assert.equal(saves,0,'strike is not intercepted by save');assert.equal(editor.editor.isActive('strike'),true,'real Tiptap strike command applied');
 for(const [key,mark] of [['b','bold'],['i','italic'],['u','underline'],['e','code']]) { await press(editor,{key,ctrlKey:true});assert.equal(editor.editor.isActive(mark),true,mark);await press(editor,{key,ctrlKey:true});assert.equal(editor.editor.isActive(mark),false,mark+' toggles off'); }
 await press(editor,{key:'s',ctrlKey:true});assert.equal(saves,1);
 const input=document.createElement('input');host.append(input);const e=await press(input,{key:'a',ctrlKey:true});assert.equal(e.defaultPrevented,false,'native input select all remains native');
 const modal=document.createElement('div');modal.setAttribute('role','dialog');host.append(modal);await press(modal,{key:'s',ctrlKey:true});assert.equal(saves,1,'no background save from modal');
 await press(editor,{key:'s',ctrlKey:true,isComposing:true});assert.equal(saves,1);
 console.log('PASS real MarkdownView + Tiptap save/strike routing, native input Ctrl+A, modal and IME; slash and bubble controls excluded');
} finally {if(root){const {act}=await import('react');await act(async()=>root.unmount());}await rm(temp,{recursive:true,force:true});window.happyDOM.abort();}
