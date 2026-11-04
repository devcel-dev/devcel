import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const w=new Window({url:'http://picker.invalid'});
for(const name of ['document','navigator','HTMLElement','HTMLInputElement','Element','Node','Event','KeyboardEvent','CompositionEvent','MutationObserver','DOMRect','CustomEvent','NodeFilter']) Object.defineProperty(globalThis,name,{configurable:true,value:w[name]});
globalThis.window=w;
for(const name of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) globalThis[name]=w[name].bind(w);
globalThis.ResizeObserver=class {observe(){}unobserve(){}disconnect(){}};
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const temp=await mkdtemp(resolve('.reference-keyboard-'));let root;
try {
 const output=await build({stdin:{resolveDir:process.cwd(),contents:"export {ReferenceSelectPopover} from './src/components/ui/reference-select-popover';",loader:'tsx'},bundle:true,packages:'external',platform:'node',format:'esm',jsx:'automatic',write:false,alias:{'@':resolve('src')},plugins:[{name:'i18n',setup(b){b.onResolve({filter:/^@\/app\/i18n$/},()=>({path:'i18n',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const t=k=>k;export const useI18n=()=>({t});',loader:'js'}));}}]});
 const file=resolve(temp,'picker.mjs');await writeFile(file,output.outputFiles[0].text);
 const {ReferenceSelectPopover}=await import(pathToFileURL(file));
 const React=await import('react');const {act}=React;const {createRoot}=await import('react-dom/client');
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);let selected=[],closed=[];
 const options=[{value:'first',label:'Same'},{value:'disabled',label:'Same',disabled:true},{value:'second',label:'Same'}];
 async function mount(){await act(async()=>{root.render(React.createElement(ReferenceSelectPopover,{open:true,value:'first',options,onValueChange:v=>selected.push(v),onOpenChange:v=>closed.push(v)}));await new Promise(r=>setTimeout(r,10));});}
 async function key(input,key,extra={}){await act(async()=>{input.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));});}
 await mount();let input=document.querySelector('input[role="combobox"]');assert.ok(input,'real portal input');
 await key(input,'ArrowDown');await key(input,'Enter');assert.deepEqual(selected,['second']);
 await act(async()=>root.unmount());root=createRoot(host);selected=[];closed=[];await mount();input=document.querySelector('input[role="combobox"]');
 await key(input,'ArrowUp');const none=document.getElementById(input.getAttribute('aria-activedescendant'));assert.ok(none?.id.endsWith('-null'));assert.ok(none.classList.contains('bg-accent'),'None uses active highlight before acceptance');await key(input,'Enter');assert.deepEqual(selected,['__NULL__']);
 await act(async()=>root.unmount());root=createRoot(host);selected=[];closed=[];await mount();input=document.querySelector('input[role="combobox"]');
 await act(async()=>input.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true,data:'n'})));
 await key(input,'Enter');await key(input,'Escape');assert.deepEqual(selected,[]);assert.deepEqual(closed,[]);
 await act(async()=>input.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true,data:'n'})));
 await key(input,'Enter',{keyCode:229});assert.deepEqual(selected,[]);
 await key(input,'Escape',{keyCode:229});assert.deepEqual(closed,[]);
 await key(input,'Escape');assert.deepEqual(closed,[false]);
 console.log('PASS real reference picker duplicate labels, disabled option, composition and legacy229 Enter/Escape');
}finally{if(root){const {act}=await import('react');await act(async()=>root.unmount());}await rm(temp,{recursive:true,force:true});w.happyDOM.abort();}
