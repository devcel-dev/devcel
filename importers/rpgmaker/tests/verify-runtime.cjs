#!/usr/bin/env node
/* Fixture integration of current canonical bundles, engine boot hooks and source isolation.
 * These are Node integration checks, not a claim of native MV/MZ validation. */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const plugin = path.resolve(__dirname, '../js/plugins/Devcel.js');
const Devcel = require(plugin);
const full = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/full.json'),'utf8'));
const minimal = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/minimal.json'),'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(test){test();checks++;}
// Candidate caches preserve wide integers, failures, defaults and retained rows.
{
    const data=clone(full), table=data.tables[0];
    table.records=Array.from({length:300},(_,i)=>({id:'cache-'+i,values:{hp:String(i),active:' TRUE '}}));
    const db=new Devcel.Database(data), old=db.table(table.name).byId('cache-299');
    check(()=>assert.strictEqual(old.get('hp'),299));
    check(()=>assert.strictEqual(old.get('active'),true));
    check(()=>assert.strictEqual(old.get('name'),table.columns[0].default_value));
    check(()=>assert.throws(()=>{old.get('color_float').g=999;}));
    check(()=>assert.throws(()=>{old.get('growth').points[0].y=999;}));
    check(()=>assert.strictEqual(db.table(table.name).byId('cache-0').get('color_float').g,2));
    table.records[299].values.hp='2147483648';
    check(()=>assert.throws(()=>db.load(data)));
    check(()=>assert.strictEqual(db.table(table.name).byId('cache-299').get('hp'),299));
    table.records[299].values.hp='42';table.columns.find(c=>c.name==='hp').data_type='String';
    db.load(data);
    check(()=>assert.strictEqual(db.table(table.name).byId('cache-299').get('hp'),'42'));
    check(()=>assert.strictEqual(old.get('hp'),299));
    table.records[0].values.active='invalid';check(()=>assert.throws(()=>db.load(data)));
}
// Object inputs remain caller-owned, while decoder results and row maps are immutable.
{
 const source=clone(full),db=new Devcel.Database(source),row=db.table('Heroes').at(0);
 source.tables[0].records[0].values.hp='999';
 check(()=>assert.strictEqual(row.get('hp'),100));
 check(()=>assert.strictEqual(Object.isFrozen(source.tables[0].records[0]),false));
 check(()=>assert.ok(Object.isFrozen(row.get('growth').points[0])));
 check(()=>assert.ok(Object.isFrozen(row.get('color32'))));
 check(()=>assert.ok(Object.isFrozen(row._table.records[row.id].raw)));
 check(()=>assert.ok(Object.isFrozen(row._table.records[row.id].typed)));
}
for (const bundle of [full,minimal]) {
    const db = new Devcel.Database(bundle), heroes=db.table('Heroes'), hero=heroes.byId('hero-1');
    check(()=>assert.strictEqual(hero.get('name'),'勇者'));
    check(()=>assert.strictEqual(hero.get('hp'),100));
    check(()=>assert.strictEqual(hero.get('wide'),'9007199254740993'));
    check(()=>assert.strictEqual(hero.get('huge'),'18446744073709551615'));
    check(()=>assert.throws(()=>hero.safeNumber('wide'),/precision/));
    check(()=>assert.strictEqual(hero.get('active'),true));
    check(()=>assert.deepStrictEqual(hero.get('color_float'),{r:-0.25,g:2,b:0.5,a:0}));
    check(()=>assert.deepStrictEqual(hero.get('color32'),{r:18,g:171,b:239,a:0}));
    check(()=>assert.strictEqual(hero.reference('item').get('label'),'回復薬'));
    check(()=>assert.strictEqual(hero.tableReference('drops').uuid(),'items-uuid'));
    check(()=>assert.strictEqual(hero.get('growth').sample(0.5),5));
    check(()=>assert.strictEqual(hero.get('empty_curve').sample(0.5),3));
    check(()=>assert.strictEqual(heroes.byId('hero-2').get('hp'),100));
    const changed=clone(bundle); changed.tables[0].records[0].values.hp='200';db.load(changed);
    check(()=>assert.strictEqual(db.table('Heroes').byId('hero-1').get('hp'),200));
    check(()=>assert.strictEqual(hero.get('hp'),100)); // stable old row snapshot
    const bad=clone(bundle);bad.tables[0].records[0].values.huge='18446744073709551616';
    check(()=>assert.throws(()=>db.load(bad),/range/));
    check(()=>assert.strictEqual(db.table('Heroes').byId('hero-1').get('hp'),200));
}
for(const [column,value] of [['color_float','[1,2,3,1.2]'],['color_float','[1e40,2,3,0]'],['color32','[1.0,2,3,4]'],['hp','12.5'],['active','yes'],['growth','{"points":[]}']]) {
    const broken=clone(full);broken.tables[0].records[0].values[column]=value;
    check(()=>assert.throws(()=>new Devcel.Database(broken)));
}
const tricky=clone(full);tricky.tables[0].records[0].values.name='先頭,"quote"\n次の行\r\n終わり\t\\n';
check(()=>assert.strictEqual(new Devcel.Database(tricky).table('Heroes').byId('hero-1').get('name'),tricky.tables[0].records[0].values.name));
const missing=clone(full);missing.tables[1].records=[];
check(()=>assert.strictEqual(new Devcel.Database(missing).table('Heroes').byId('hero-1').reference('item'),null));
const a=new Devcel.Database(full),copy=clone(full);copy.tables[0].records[0].values.hp='999';const b=new Devcel.Database(copy);
Devcel.replaceSources([{source:{id:'base',namespace:'Game.Base',runtime_file:'data/devcel/base.json'},database:a},{source:{id:'event',namespace:'Game.Event',class_name:'EventData',runtime_file:'data/devcel/event.json'},database:b}]);
check(()=>assert.strictEqual(Devcel.source('base').table('Heroes').at(0).get('hp'),100));
check(()=>assert.strictEqual(Devcel.source('event').table('Heroes').at(0).get('hp'),999));
check(()=>assert.strictEqual(Devcel.sourceInfo('event').class_name,'EventData'));
check(()=>assert.throws(()=>Devcel.validateIndex({schema_version:1,sources:[{id:'base',namespace:'Game',runtime_file:'data/devcel/base.json'},{id:'other',namespace:'Game.Child',runtime_file:'data/devcel/other.json'}]}),/collision/));
check(()=>assert.throws(()=>Devcel.validateIndex({schema_version:1,sources:[{namespace:'Game',runtime_file:'data/devcel/base.json'}]})));
check(()=>assert.throws(()=>Devcel.validateIndex({schema_version:1,sources:[{id:'x',namespace:'Game',runtime_file:'data/devcel/../Actors.json'}]})));
const special=clone(full);special.tables[0].name='__proto__';special.tables[0].records[0].id='constructor';
check(()=>assert.strictEqual(new Devcel.Database(special).table('__proto__').byId('constructor').get('hp'),100));
async function engineBoot(mz) {
    const commands=[],events=[],responses={'data/devcel/index.json':{schema_version:1,sources:[{id:'base',namespace:'Game.Base',runtime_file:'data/devcel/base.json'}]},'data/devcel/base.json':full};
    const context={Promise,Float32Array,console,JSON,Object,Array,Math,Error,isFinite,Number,String,RegExp};
    context.window=context;
    context.PluginManager={parameters:()=>({}),registerCommand:mz?((...args)=>commands.push(args)):undefined};
    context.DataManager={loadDatabase:()=>{},isDatabaseLoaded:()=>true};
    context.Utils={isNwjs:()=>false,isOptionValid:()=>false};
    context.Game_Interpreter=function(){};context.Game_Interpreter.prototype.pluginCommand=function(){};
    context.alert=function(){throw new Error('Unexpected alert');};context.addEventListener=(...args)=>events.push(args);
    context.XMLHttpRequest=function(){this.open=(method,url)=>{this.url=url;};this.overrideMimeType=()=>{};this.send=()=>{this.status=200;this.responseText=JSON.stringify(responses[this.url]);this.onload();};};
    // require/process are intentionally absent: published game loading must remain browser-only.
    vm.createContext(context);vm.runInContext(fs.readFileSync(plugin,'utf8'),context);
    context.DataManager.loadDatabase();assert.strictEqual(context.DataManager.isDatabaseLoaded(),false);
    await new Promise(resolve=>setImmediate(resolve));
    check(()=>assert.strictEqual(context.DataManager.isDatabaseLoaded(),true));
    check(()=>assert.strictEqual(context.Devcel.source('base').table('Heroes').at(0).get('hp'),100));
    check(()=>assert.throws(()=>context.Devcel.openImporter(),/only in desktop playtest/));
    check(()=>assert.strictEqual(commands.length,mz?2:0));
}
(async()=>{await engineBoot(false);await engineBoot(true);console.log(JSON.stringify({ok:true,checks,native_mv_mz:false}));})().catch(error=>{console.error(error);process.exitCode=1;});
