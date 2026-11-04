'use strict';
// DOM/editor boundary execution only; does not launch Cocos Creator.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.value='';this.textContent='';this.disabled=false;}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
 setAttribute(){}
 querySelectorAll(query){const tags=query.split(',');return this.children.flatMap(c=>[...(tags.includes(c.tag)?[c]:[]),...c.querySelectorAll(query)]);}
}
const source={id:'base',project:'../one/Game.devcelproj.toml',namespace:'Game',runtime_out:'assets/resources/a.json',row_include_tags:['missing'],row_exclude_tags:['hidden'],column_include_tags:['mobile'],column_exclude_tags:[],future_setting:'keep'};
let config={schema_version:1,sources:[source,{...source,id:'two',project:'../two/Game.devcelproj.toml',row_include_tags:[]}]},saved;
const requests=[];let panel;
const Editor={Panel:{define:value=>value},Message:{async request(_name,action,...args){requests.push([action,...args]);if(action==='config')return {config,revision:'old',path:'/game/devcel.import.json'};if(action==='tag-presets')return args[0].includes('/one/')?['mobile','hidden','new']:['second'];if(action==='save'){saved=JSON.parse(JSON.stringify(args[0]));return {config:args[0],revision:'new'};}throw Error(action);}}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/panel.js'),'utf8'),{module:{set exports(value){panel=value;}},Editor,document:{createElement:tag=>new Element(tag)},Map});
const $=Object.fromEntries(Object.keys(panel.$).map(key=>[key,new Element('div')]));$.app.append(...Object.entries($).filter(([key])=>key!=='app').map(([,value])=>value));
const ctx={$};
const elements=()=>$.sources.querySelectorAll('button,input,select');
const click=async text=>{const b=elements().find(e=>e.textContent===text);assert(b,text);await b.onclick();};
(async()=>{
 await panel.ready.call(ctx);assert.equal(source.row_include_tags[0],'missing');
 await click('Load / refresh project tag presets');assert.deepEqual(requests.at(-1),['tag-presets','../one/Game.devcelproj.toml']);
 let unknown=elements().find(e=>e.tag==='input'&&e.value==='missing');assert(unknown&&!unknown.disabled);unknown.value='new';unknown.onchange();
 assert.equal(source.row_include_tags[0],'new');assert(elements().some(e=>e.tag==='select'&&e.value==='new'));
 const firstSection=$.sources.children[0],groups=firstSection.children.find(e=>e.tag==='fieldset').children.filter(e=>e.tag==='div');
 const add=groups[0].children.at(-1);add.value='mobile';add.onchange();assert.deepEqual(Array.from(source.row_include_tags),['new','mobile']);
 await $.save.onclick();assert.equal(saved.sources[0].future_setting,'keep');assert.equal(saved.sources[1].row_include_tags.length,0);assert.deepEqual(saved.sources[0].column_include_tags,['mobile']);
 const project=elements().find(e=>e.tag==='input'&&e.value==='../one/Game.devcelproj.toml');project.value='../two/Game.devcelproj.toml';project.oninput();project.onchange();assert(elements().some(e=>e.tag==='input'&&e.value==='new'&&e.disabled));
 await click('Load / refresh project tag presets');assert.equal(requests.at(-1)[1],'../two/Game.devcelproj.toml');assert.deepEqual(Array.from(source.row_include_tags),['new','mobile']);
 console.log(JSON.stringify({ok:true,nativeCreatorRun:false,tagPresetDOMBoundary:true,unknownRepair:true,perSourcePreservation:true,projectRegistryInvalidation:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
