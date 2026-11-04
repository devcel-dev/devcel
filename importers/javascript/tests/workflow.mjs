/** Integration workflow over full/minimal canonical fixtures and actual local HTTP UI. */
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,mkdir,rm,chmod,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
import {DevcelDatabase,DevcelCurve,DevcelProjectSet} from '../runtime/devcel-runtime.js';
const require=createRequire(import.meta.url);const {start}=require('../editor/server.cjs');const {prepareCli,platform}=require('../editor/cli.cjs');const {Importer}=require('../editor/importer.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const text=await readFile(path.join(root,'samples/master.full.json'),'utf8');const minimal=await readFile(path.join(root,'samples/master.minimal.json'),'utf8');
for(const content of [text,minimal]){
 const db=DevcelDatabase.fromJson(content),hero=db.table('Heroes').byId('hero-1');
 assert.equal(hero.getNumber('hp'),100);assert.equal(hero.getI64('wide'),9007199254740993n);assert.equal(hero.getU64('huge'),18446744073709551615n);
 assert.equal(hero.getBoolean('active'),true);assert.equal(hero.getColor32('color32').a,0);assert.equal(hero.getColorFloat('color_float').r,-.25);assert.equal(hero.getColorFloat('color_float').g,2);
 assert.equal(hero.reference('item','Items').getString('label'),'回復薬');assert.equal(hero.tableReference('drops','loot-interface').name,'Items');assert.equal(hero.tableReference('drops','wrong'),undefined);
 assert.equal(hero.getCurve('growth').sample(.75),5);assert.equal(hero.getCurve('empty_curve').sample(0),2);assert.equal(hero.getCurve('empty_curve').sample(1),4);assert.equal(hero.index,0);
 const replacement=JSON.parse(text);replacement.tables[0].records[0].values.hp='200';replacement.tables[1].records[0].values.label='新版';let notifications=0;db.subscribe(()=>notifications++);
 assert.equal(db.loadJson(JSON.stringify(replacement)),true);assert.equal(db.table('Heroes').byId('hero-1').getNumber('hp'),200);assert.equal(hero.getNumber('hp'),100);assert.equal(hero.reference('item','Items').getString('label'),'回復薬');assert.equal(notifications,1);
 const previous=db.table('Heroes');assert.throws(()=>db.loadJson('{'));assert.equal(db.table('Heroes').byId('hero-1').getNumber('hp'),200);assert.equal(previous.count,2);
 for(const corrupt of [b=>b.manifest.schema_version=9,b=>b.tables.push(b.tables[0]),b=>b.tables[0].records[0].values.wide='9223372036854775808',b=>b.tables[0].records[0].values.huge='18446744073709551616',b=>b.tables[0].records[0].values.color32='[0,0,0,-0]',b=>b.tables[0].records[0].values.color_float='[0,0,0,2]',b=>b.tables[0].records[0].values.speed='1e100',b=>b.tables[0].records[0].values.hp=123,b=>b.tables[0].columns[0].data_type='Unknown',b=>b.tables[0].records[0].values.unknown_column='bad']){const invalid=JSON.parse(text);corrupt(invalid);assert.throws(()=>db.loadJson(JSON.stringify(invalid)));assert.equal(db.table('Heroes').byId('hero-1').getNumber('hp'),200);}
}
// Private parsed containers may be frozen directly; all public nested values stay immutable.
{
 const source=JSON.parse(text);source.manifest.extra={nested:[1,2]};source.tables[0].columns[0].extra={nested:[3]};
 const db=new DevcelDatabase(JSON.stringify(source)),row=db.table('Heroes').at(0);
 assert.ok(Object.isFrozen(db.manifest.extra.nested));
 assert.throws(()=>{db.manifest.extra.nested[0]=9;});
 assert.throws(()=>{row.columnInfo('name').extra.nested.push(4);});
 assert.throws(()=>{row.getCurve('growth').points.push({x:2,y:0,mode:'auto'});});
 const config={start_value:2,end_value:4},curve=new DevcelCurve('',config);config.end_value=99;
 assert.equal(curve.sample(1),4);assert.equal(Object.isFrozen(config),false);
 assert.equal(row.getBoolean('active'),true);
}
// Saturating a candidate-local cache must not skip validation or survive a schema reload.
{
 const data=JSON.parse(text),table=data.tables[0];
 table.records=Array.from({length:300},(_,i)=>({id:`cache-${i}`,values:{hp:String(i),active:' TRUE '}}));
 const db=new DevcelDatabase(JSON.stringify(data)),old=db.table(table.name).byId('cache-299');
 assert.equal(old.getNumber('hp'),299);assert.equal(old.getBoolean('active'),true);
 assert.equal(old.getString('name'),table.columns[0].default_value);
 assert.ok(Object.isFrozen(old.getColorFloat('color_float')));assert.throws(()=>{old.getColorFloat('color_float').g=999;});
 assert.ok(Object.isFrozen(old.getCurve('growth').points[0]));assert.throws(()=>{old.getCurve('growth').points[0].y=999;});
 assert.equal(db.table(table.name).byId('cache-0').getColorFloat('color_float').g,2);
 table.records[299].values.hp='2147483648';
 assert.throws(()=>db.loadJson(JSON.stringify(data)));assert.equal(db.table(table.name).byId('cache-299').getNumber('hp'),299);
 table.records[299].values.hp='42';table.columns.find(c=>c.name==='hp').data_type='String';
 db.loadJson(JSON.stringify(data));assert.equal(db.table(table.name).byId('cache-299').getString('hp'),'42');assert.equal(old.getNumber('hp'),299);
 table.records[0].values.active='invalid';assert.throws(()=>db.loadJson(JSON.stringify(data)));
}
const vectors=JSON.parse(await readFile(path.join(root,'samples/curve-vectors.json'),'utf8'));let samples=0;
for(const fixture of vectors.curves){const curve=new DevcelCurve(JSON.stringify(fixture.data));for(const sample of fixture.samples){assert.ok(Math.abs(curve.sample(sample.x)-sample.y)<1e-7,fixture.name);samples++;}}
const a=new DevcelDatabase(text),b=new DevcelDatabase(text),set=new DevcelProjectSet();set.register('base','Game.Base',a);set.register('event','Game.Event',b);assert.throws(()=>set.register('bad','Game.Base.More',a));assert.equal(set.get('event'),b);
let resolve;const delayed=new Promise(r=>resolve=r);const first=a.reload(()=>delayed);const second=a.reload(()=>{throw Error('Overlapping reader must coalesce');});resolve(text);assert.equal(await first,false);assert.equal(await second,false);
const temp=await mkdtemp(path.join(tmpdir(),'devcel-js-workflow-'));let server;
try{
 const configPath=path.join(temp,'devcel.import.json');const started=await start({configPath,packageRoot:root});server=started.server;const url=new URL(started.url),token=new URLSearchParams(url.hash.slice(1)).get('token');url.hash='';
 assert.equal((await fetch(url)).status,200);assert.equal((await fetch(new URL('/api',url),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 async function api(action,data={}){const response=await fetch(new URL('/api',url),{method:'POST',headers:{'Content-Type':'application/json','X-Devcel-Token':token},body:JSON.stringify({action,...data})});return {status:response.status,json:await response.json()};}
 const config={schema_version:1,sources:[{id:'base',project:'../author/Game.devcelproj.toml',namespace:'Game.Base',class_name:'BaseData',version:0,runtime_out:'data/base.json',code_out:'generated/base/BaseData.ts',code_target:'typescript',mode:'full'},{id:'event',project:'../event/Game.devcelproj.toml',namespace:'Game.Event',class_name:'EventData',runtime_out:'data/event.json',mode:'full'}]};
 await writeFile(configPath,JSON.stringify(config));assert.deepEqual((await api('config')).json.config,config);
 const importer=new Importer({packageRoot:root,configPath});
 const collision=structuredClone(config);collision.sources[0].code_out='generated/base/devcel-runtime.d.ts';await writeFile(configPath,JSON.stringify(collision));await assert.rejects(()=>importer.import('base'),/collides with runtime support/);
 const cross=structuredClone(config);cross.sources[1].code_out='generated/base/devcel-runtime.d.ts';cross.sources[1].code_target='typescript';await writeFile(configPath,JSON.stringify(cross));await assert.rejects(()=>importer.import('base'),/collides with runtime support/);
 await mkdir(path.join(temp,'generated/base'),{recursive:true});await symlink(path.join(temp,'generated/base'),path.join(temp,'alias'),process.platform==='win32'?'junction':'dir');cross.sources[1].code_out='alias/devcel-runtime.d.ts';await writeFile(configPath,JSON.stringify(cross));await assert.rejects(()=>importer.import('base'),/collides with runtime support/);await writeFile(configPath,JSON.stringify(config));
 const before=await readFile(configPath,'utf8');const invalid=structuredClone(config);invalid.sources[0].version=-1;assert.equal((await api('save',{config:invalid})).status,400);assert.equal(await readFile(configPath,'utf8'),before);
 // Verify bundled executable hash and execute-bit restoration without launching an arbitrary binary.
 const bundle=path.join(temp,'sdk'),target=platform(),filename=process.platform==='win32'?'devcel.exe':'devcel';await mkdir(path.join(bundle,'bin',target),{recursive:true});const binary=path.join(bundle,'bin',target,filename),bytes=Buffer.from('fixture, never launched');await writeFile(binary,bytes);await chmod(binary,0o600);
 const manifest={schema_version:1,version:require('../package.json').version,supportedPlatforms:[target],binaries:{[target]:{path:`${target}/${filename}`,sha256:createHash('sha256').update(bytes).digest('hex')}}};await writeFile(path.join(bundle,'bin/manifest.json'),JSON.stringify(manifest));assert.equal(await prepareCli(bundle),binary);if(process.platform!=='win32')assert.ok((await stat(binary)).mode&0o100);
 await writeFile(binary,'tampered');await assert.rejects(()=>prepareCli(bundle),/SHA256/);await rm(binary);
 if(process.platform==='win32'){
   const external=path.join(temp,'external-directory');await mkdir(external);await writeFile(path.join(external,filename),bytes);
   await rm(path.dirname(binary),{recursive:true});await symlink(external,path.dirname(binary),'junction');
 }else{await writeFile(path.join(temp,'external'),bytes);await symlink(path.join(temp,'external'),binary);}
 await assert.rejects(()=>prepareCli(bundle),/Symlink/);
}finally{if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
console.log(JSON.stringify({ok:true,fullMinimal:true,snapshotReload:true,typedValues:true,curveSamples:samples,sourceIsolation:true,localUiAuth:true,configReadAndErrorPreservation:true,binaryManifest:true,supportOutputCollision:true}));
