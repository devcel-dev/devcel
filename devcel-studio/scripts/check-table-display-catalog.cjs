#!/usr/bin/env node
'use strict';
// Real table commands and demand loader, synthetic IPC/events only. No content preloading.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const studio = path.resolve(__dirname, '..');
const esbuild = require(path.join(studio, 'node_modules/esbuild'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-display-catalog-'));
const out = path.join(work, 'catalog.cjs');
const listeners = new Map();
const calls = [];
const domEvents = [];
const deferred = () => { let resolve; let reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const bridge = globalThis.__displayCatalog = { next: null, invoke: async (command,args) => {
  calls.push({command,args});
  if (command === 'get_table_display_catalog' || command === 'get_table_catalog') return bridge.next ? bridge.next.promise : [{uuid:'id',path:'Tables/Nested/file.table.toml',display_name:'Friendly table'}];
  if (command === 'get_loaded_tables') return [];
  throw Error(`Unexpected content load or command: ${command}`);
}, listen: async (event,callback)=>{listeners.set(event,callback);return ()=>listeners.delete(event);} };
globalThis.window = {dispatchEvent:event=>domEvents.push(event.type)};
globalThis.CustomEvent = class {constructor(type){this.type=type;}};
(async()=>{
  await esbuild.build({entryPoints:[path.join(studio,'src/app/commands/tableCommands.ts')],bundle:true,platform:'node',format:'cjs',outfile:out,tsconfig:path.join(studio,'tsconfig.json'),plugins:[{name:'boundaries',setup(b){
    b.onResolve({filter:/^@tauri-apps\/api\/(core|event)$/},a=>({path:a.path.endsWith('core')?'core':'event',namespace:'boundary'}));
    b.onResolve({filter:/^@\/app\/i18n$/},()=>({path:'i18n',namespace:'boundary'}));
    b.onLoad({filter:/.*/,namespace:'boundary'},a=>({loader:'js',contents:{core:'export const invoke=(...a)=>globalThis.__displayCatalog.invoke(...a);',event:'export const listen=(...a)=>globalThis.__displayCatalog.listen(...a);',i18n:'export const message=key=>({key});export const localizedError=value=>new Error(value.key);'}[a.path]}));
  }}]});
  const api=require(out);
  api.setTableLoadingSession({id:'one',path:'/project/project.toml'});
  const [first,second]=await Promise.all([api.getTableDisplayCatalog('one'),api.getTableDisplayCatalog('one')]);
  assert.equal(first,second); assert.equal(first[0].display_name,'Friendly table');
  assert.equal(calls.filter(c=>c.command==='get_table_display_catalog').length,1,'concurrent tree reads coalesce');
  const realNow=Date.now; Date.now=()=>realNow()+60000;
  try { await api.getLoadedTables('one'); await api.getTableDisplayCatalog('one'); } finally {Date.now=realNow;}
  assert.equal(calls.filter(c=>c.command==='get_table_display_catalog').length,1,'five-second badge polling cannot rescan catalog');
  assert.equal(calls.filter(c=>c.command==='get_table_catalog').length,0,'display discovery never invokes strict reference catalog');
  const scansBeforeRename=calls.filter(c=>c.command==='get_table_display_catalog').length;
  api.publishTableDisplayName('id','Native App Settings','one');
  assert.equal((await api.getTableDisplayCatalog('one'))[0].display_name,'Native App Settings','authoritative custom labels replace cached labels immediately');
  assert.equal(calls.filter(c=>c.command==='get_table_display_catalog').length,scansBeforeRename,'local metadata edits patch cached metadata without rescanning files');
  api.publishTableDisplayName('id','Late old-project edit','retired-session');
  assert.equal((await api.getTableDisplayCatalog('one'))[0].display_name,'Native App Settings','late project responses cannot change current labels');
  for(const event of ['project-modified','table-updated','settings-project-data-changed','p2p-data-changed','tauri://focus']){
    assert(listeners.has(event)); const before=calls.length; listeners.get(event)({payload:{}}); await api.getTableDisplayCatalog('one'); assert.equal(calls.length,before+1,event);
  }
  await api.getTableCatalog('one'); assert.equal(calls.at(-1).command,'get_table_catalog','integrity readers keep the strict catalog');
  bridge.next=deferred();api.invalidateTableCatalog();const initial=api.getTableDisplayCatalog('one');
  for(let i=0;i<4;i++)await Promise.resolve();
  api.publishTableDisplayName('id','Renamed while metadata was loading','one');
  bridge.next.resolve([{uuid:'id',path:'Tables/Nested/file.table.toml',display_name:'Stale disk label'}]);
  await initial;bridge.next=null;
  assert.equal((await api.getTableDisplayCatalog('one'))[0].display_name,'Renamed while metadata was loading','a pending metadata response cannot replace a committed name');

  bridge.next=deferred(); api.invalidateTableCatalog(); const old=api.getTableDisplayCatalog('one');
  for(let i=0;i<4;i++)await Promise.resolve();
  api.setTableLoadingSession({id:'two',path:'/other/project.toml'});bridge.next.resolve([{uuid:'old',path:'old',display_name:'Old'}]);
  await assert.rejects(old,/sessionChanged/); bridge.next=null;
  assert.equal((await api.getTableDisplayCatalog('two'))[0].uuid,'id');
  bridge.next=deferred();api.invalidateTableCatalog();const rejected=api.getTableDisplayCatalog('two');for(let i=0;i<4;i++)await Promise.resolve();bridge.next.reject(Error('temporary read failure'));await assert.rejects(rejected,/temporary/);bridge.next=null;
  assert.equal((await api.getTableDisplayCatalog('two'))[0].display_name,'Friendly table','failed reads remain retryable');
  assert(calls.every(c=>c.command!=='load_table'),'metadata never loads table contents');
  assert(domEvents.includes('devcel-table-catalog-invalidated'));
  console.log('PASS table display catalog: coalescing, event invalidation, badge polling isolation, session fencing, retry and strict-catalog separation');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(work,{recursive:true,force:true}));
