// Production P2P hook/toast/i18n. Native event and timer boundaries are fixtures;
// no sockets are opened and this does not establish native network behavior.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(project, '.p2p-errors-check-'));
const browser = new Window({url:'http://p2p-errors.invalid/'});
for (const name of ['window','document','navigator','HTMLElement','Element','Node','Event','CustomEvent','localStorage'])
  Object.defineProperty(globalThis, name, {configurable:true,value:name==='window'?browser:browser[name]});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__p2pListeners = new Map();
const realInterval=globalThis.setInterval, realClearInterval=globalThis.clearInterval;
const realTimeout=globalThis.setTimeout, realClearTimeout=globalThis.clearTimeout;
globalThis.setInterval=()=>({poll:true}); globalThis.clearInterval=()=>{};
globalThis.setTimeout=(callback,delay,...args)=>delay===5000?{toast:true}:realTimeout(callback,delay,...args);
globalThis.clearTimeout=timer=>{if(!timer?.toast)realClearTimeout(timer);};
const captured=[]; window.addEventListener('p2p-toast',event=>captured.push(event.detail));
const checks=[];let root;
try {
  const result=await build({absWorkingDir:project,stdin:{resolveDir:project,loader:'tsx',contents:`
    export {useP2P} from './src/app/hooks/useP2P';
    export {P2PToastContainer} from './src/app/components/P2PToast';
    export {isP2PUnavailable} from './src/app/api/p2p';
    export * as i18n from './src/app/i18n';
    export * as React from 'react'; export {createRoot} from 'react-dom/client';
  `},bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',write:false,
  alias:{'@':resolve(project,'src')},plugins:[{name:'p2p-boundaries',setup(b){
    b.onResolve({filter:/^(@tauri-apps\/api\/(core|event|window)|framer-motion)$/},args=>({path:args.path,namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({resolveDir:project,contents:
      path.endsWith('/core')?`export const isTauri=()=>true; export const invoke=async name=>{if(name!=='get_p2p_status')throw Error('Unexpected command '+name);return JSON.stringify({connected:false});};`:
      path.endsWith('/event')?`export const listen=async (name,callback)=>{globalThis.__p2pListeners.set(name,callback);return()=>globalThis.__p2pListeners.delete(name);};`:
      path.endsWith('/window')?`export const getCurrentWindow=()=>({setTitle:async()=>{}});`:
      `import React from 'react'; export const AnimatePresence=({children})=>children; export const motion={div:({initial,animate,exit,...props})=>React.createElement('div',props)};`
    }));
  }}]});
  const output=resolve(temporary,'test.mjs');await writeFile(output,result.outputFiles[0].text);
  const {useP2P,P2PToastContainer,isP2PUnavailable,i18n,React,createRoot}=await import(pathToFileURL(output));
  const catalog=JSON.parse(await readFile(resolve(project,'src/app/i18n/generated/catalog.json'),'utf8'));
  const host=document.createElement('div');document.body.append(host);root=createRoot(host);
  function Harness(){useP2P();return React.createElement(P2PToastContainer);}
  const locale=async value=>React.act(async()=>i18n.applyRuntimeLocalization(catalog,{preference:value,locale:value,revision:value,availableLocales:['en','ja']}));
  await React.act(async()=>root.render(React.createElement(Harness)));
  await locale('ja');
  const error={kind:'code',code:'error.invalidData',params:{details:{kind:'code',code:'error.settingsSingleton',params:{}}}};
  const original=JSON.stringify(error);
  await React.act(async()=>globalThis.__p2pListeners.get('p2p-state-changed')({payload:{state:'failed',error}}));
  assert.equal(captured.at(-1).description,error,'Event cause must stay structured, not prelocalized');
  assert.equal(JSON.stringify(error),original);checks.push('failed-state event retains exact typed nested cause');
  const japanese=i18n.localizeError(error);assert(host.textContent.includes(japanese));assert(!japanese.includes('Validation error:'));
  checks.push('production toast renders localized Japanese nested cause');
  await locale('en');const english=i18n.localizeError(error);assert.notEqual(english,japanese);assert(host.textContent.includes(english));
  assert.equal(captured.at(-1).description,error);checks.push('live locale changes rerender existing event without changing cause');
  const literal={kind:'text',text:'Connection failed: literal {value} ユーザー'};
  await React.act(async()=>globalThis.__p2pListeners.get('p2p-error')({payload:{message:literal}}));
  assert.equal(captured.at(-1).description,literal);assert(host.textContent.includes(literal.text));checks.push('foreign literal detail is not parsed or relabeled');
  const missing={kind:'code',code:'error.commandNotFound',params:{command:'get_p2p_status'}};
  for(const value of ['ja','en']){await locale(value);assert(isP2PUnavailable(missing));assert(isP2PUnavailable({appError:missing}));}
  assert(!isP2PUnavailable({kind:'text',text:'Command get_p2p_status not found'}));
  assert(!isP2PUnavailable({...missing,params:{command:'another_command'}}));checks.push('disabled capability uses command identity, never English matching');
  await React.act(async()=>root.unmount());root=null;assert.equal(globalThis.__p2pListeners.size,0);checks.push('event listeners are removed on unmount');
  console.log(JSON.stringify({passed:checks.length,checks,scope:'Production React/i18n; synthetic native events, no network'},null,2));
} finally {
  if(root){const React=await import('react');await React.act(async()=>root.unmount());}
  globalThis.setInterval=realInterval;globalThis.clearInterval=realClearInterval;
  globalThis.setTimeout=realTimeout;globalThis.clearTimeout=realClearTimeout;
  await rm(temporary,{recursive:true,force:true});await browser.happyDOM.close();
}
