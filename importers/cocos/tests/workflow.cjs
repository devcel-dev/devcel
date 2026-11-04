'use strict';
/** Extension boundary integration: does not impersonate a native Creator launch. */
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.resolve(__dirname,'..'),js=path.resolve(root,'../javascript');
for(const file of ['devcel-runtime.js','devcel-runtime.d.ts'])for(const directory of ['runtime','assets/runtime'])assert.deepEqual(fs.readFileSync(path.join(root,directory,file)),fs.readFileSync(path.join(js,'runtime',file)));
for(const file of ['cli.cjs','importer.cjs'])assert.deepEqual(fs.readFileSync(path.join(root,'editor',file)),fs.readFileSync(path.join(js,'editor',file)));
const calls=[];let options,stopped=false;
class Importer {constructor(o){options=o;this.configPath=o.configPath;this.value={schema_version:1,sources:[]};}async config(){return this.value;}async configState(){return {config:this.value,revision:'fixture'};}async save(value){this.value=value;return value;}async import(id,status){return {id,status};}watch(callback){callback({ready:true});}stopWatch(){stopped=true;}}
const Editor={Project:{path:'/title'},Panel:{open(name){calls.push(['open',name]);},define(options){return options;}},Message:{async request(...args){calls.push(args);},broadcast(...args){calls.push(args);}},Dialog:{async select(){return {canceled:false,filePaths:['/author/Game.devcelproj.toml']};}}};
const exported={};vm.runInNewContext(fs.readFileSync(path.join(root,'dist/main.js'),'utf8'),{exports:exported,require:id=>id==='path'?path:{Importer},__dirname:path.join(root,'dist'),Editor});
(async()=>{
 exported.methods.openPanel();assert.deepEqual(calls.shift(),['open','devcel-importer']);
 await exported.methods.config();assert.equal(options.configPath,path.join('/title','devcel.import.json'));
 const source={id:'base',runtime_out:'assets/resources/devcel/base.json',code_out:'assets/devcel/base/GameData.ts'};
 await exported.methods.save({schema_version:1,sources:[source]});await options.onImported(source);
 assert.deepEqual(JSON.parse(JSON.stringify(calls.map(c=>c.slice(0,3)))),[['asset-db','refresh-asset','db://assets/resources/devcel/base.json'],['asset-db','refresh-asset','db://assets/devcel/base/GameData.ts'],['asset-db','refresh-asset','db://assets/devcel/base'],['devcel-importer:imported',{sourceId:'base',runtime:source.runtime_out}]]);
 await assert.rejects(()=>exported.methods.save({sources:[{runtime_out:'../bad.json'}]}),/assets\/resources/);
 assert.equal(await exported.methods.chooseProject(),'../author/Game.devcelproj.toml');exported.methods.watch(true);exported.unload();assert.equal(stopped,true);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));for(const message of Object.values(manifest.contributions.messages))for(const method of message.methods)assert.equal(typeof exported.methods[method],'function');
 let panel;vm.runInNewContext(fs.readFileSync(path.join(root,'dist/panel.js'),'utf8'),{module:{set exports(value){panel=value;}},Editor});assert.match(panel.template,/ContentVersion|sources/);assert.equal(typeof panel.ready,'function');
 console.log(JSON.stringify({ok:true,creatorNativeRun:false,editorApiBoundary:true,sourceScopedRefresh:true,pathGuards:true,packageParity:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
