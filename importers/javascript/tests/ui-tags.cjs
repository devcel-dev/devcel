'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.events={};this.dataset={};this.value='';}
 set textContent(value){this.text=value;this.children=[];}get textContent(){return (this.text||'')+this.children.map(n=>n.textContent).join('');}
 append(...nodes){this.children.push(...nodes);}appendChild(n){this.append(n);return n;}replaceChildren(){this.children=[];}
 setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,f){this.events[k]=f;}
 querySelectorAll(selector){return all(this).slice(1).filter(n=>selector.split(',').includes(n.tagName));}
 fire(event){this['on'+event]?.({target:this});this.events[event]?.({target:this});}
}
function all(n){return [n,...n.children.flatMap(all)];}
const ids={};for(const id of ['result','details','raw','sources','add','save','all','status','watch','location'])ids[id]=new Element(id==='sources'?'div':'button');
const document={createElement:tag=>new Element(tag),querySelector:selector=>ids[selector.slice(1)],querySelectorAll:selector=>Object.values(ids).flatMap(all).filter(n=>selector.split(',').includes(n.tagName))};
let saved,revision=0;const calls=[];const initial={schema_version:1,sources:[{id:'base',project:'../A.devcelproj.toml',namespace:'Game.Base',runtime_out:'data/base.json',mode:'full',row_include_tags:['orphan'],column_exclude_tags:['mobile']}]};
const context={document,URLSearchParams,location:{hash:'#token=test'},fetch:async(_,options)=>{
 const body=JSON.parse(options.body);calls.push(body);let value;
 if(body.action==='config')value={config:initial,revision:String(revision),path:'game/devcel.import.json'};
 else if(body.action==='tags')value={presets:body.project.includes('/B.')?['other']:['release','mobile']};
 else if(body.action==='save'){saved=structuredClone(body.config);value={config:saved,revision:String(++revision)};}
 else value={data:{sources:[]}};
 return {ok:true,json:async()=>value};
}};
vm.createContext(context);const editor=path.resolve(__dirname,'../editor');vm.runInContext(fs.readFileSync(path.join(editor,'tag-filters.js'),'utf8'),context);
const html=fs.readFileSync(path.join(editor,'ui.html'),'utf8');vm.runInContext(html.match(/<script>\s*([\s\S]*?)<\/script>/)[1],context);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function field(label){const found=all(ids.sources).find(n=>n.attributes['aria-label']===label);assert(found,label);return found;}
(async()=>{
 await flush();await flush();assert.equal(field('Include rows tag 1').tagName,'input');
 const unknown=field('Include rows tag 1');unknown.value='release';unknown.fire('input');unknown.fire('change');assert.equal(field('Include rows tag 1').tagName,'select');
 for(const [label,value]of [['Add exclude rows tag','mobile'],['Add include columns tag','release']]){const input=field(label);input.value=value;input.fire('change');}
 ids.save.fire('click');await flush();await flush();
 assert.deepEqual(saved.sources[0].row_include_tags,['release']);assert.deepEqual(saved.sources[0].row_exclude_tags,['mobile']);assert.deepEqual(saved.sources[0].column_include_tags,['release']);assert.deepEqual(saved.sources[0].column_exclude_tags,['mobile']);
 const project=all(ids.sources).find(n=>n.dataset.key==='project');project.value='../B.devcelproj.toml';project.fire('input');project.fire('change');await flush();
 assert.equal(field('Include rows tag 1').tagName,'input');assert.equal(field('Include rows tag 1').value,'release');
 assert.deepEqual(field('Add include rows tag').children.map(n=>n.value),['','other']);
 ids.save.fire('click');await flush();assert.deepEqual(saved.sources[0].row_include_tags,['release']);
 assert(calls.filter(c=>c.action==='tags').every(c=>!path.isAbsolute(c.project)));
 console.log(JSON.stringify({ok:true,standaloneUiWiring:true,fourArraysPersist:true,unknownRecovery:true,projectSwitchPreservesFilters:true,domOnly:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
