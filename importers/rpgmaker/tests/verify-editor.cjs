#!/usr/bin/env node
/* Real CLI integration. Usage: node verify-editor.cjs /absolute/devcel /new/evidence-dir */
'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
const cli=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]);
fs.mkdirSync(root,{recursive:true});assert.strictEqual(fs.readdirSync(root).length,0,'Use a new empty evidence directory');
const log=[];
function command(...args){const run=cp.spawnSync(cli,args.map(String),{encoding:'utf8',timeout:120000});const result=JSON.parse(run.stdout);log.push({args,code:run.status,result});assert.strictEqual(run.status,0,run.stdout+run.stderr);assert.strictEqual(result.ok,true);return result.data;}
const title=path.join(root,'Game with spaces 日本語');fs.mkdirSync(title);
const packageRoot=path.join(title,'js/plugins/devcel');fs.mkdirSync(packageRoot,{recursive:true});
for(const file of ['editor.js','importer.html','importer-ui.js','tag-filters.js'])fs.copyFileSync(path.resolve(__dirname,'../js/plugins/devcel',file),path.join(packageRoot,file));
fs.copyFileSync(path.resolve(__dirname,'../js/plugins/Devcel.js'),path.join(title,'js/plugins/Devcel.js'));
const rid=({linux:'linux',win32:'win',darwin:'osx'})[process.platform]+'-'+process.arch;
const binaryName=rid+'/devcel'+(process.platform==='win32'?'.exe':'');
const binary=path.join(packageRoot,'bin',binaryName);fs.mkdirSync(path.dirname(binary),{recursive:true});fs.copyFileSync(cli,binary);if(process.platform!=='win32')fs.chmodSync(binary,0o600);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const manifest={schema_version:1,version:require('../../../devcel-studio/package.json').version,supportedPlatforms:[rid],binaries:{[rid]:{path:binaryName,sha256:sha(fs.readFileSync(binary))}}};
fs.writeFileSync(path.join(packageRoot,'bin/manifest.json'),JSON.stringify(manifest));
const a=command('init','SourceA','--dir',root).project_path;
const table=command('--mode','local','--project',a,'table','create','Items').table_uuid;
command('--mode','local','--project',a,'column','add','Items','name','String');command('--mode','local','--project',a,'column','add','Items','hp','I32');
const id='11111111-1111-4111-8111-111111111111';command('--mode','local','--project',a,'record','add','Items','--uuid',id);command('--mode','local','--project',a,'cell','set','Items',id,'name','日本語,"quote"\nnext');command('--mode','local','--project',a,'cell','set','Items',id,'hp','7');
const bDir=path.join(root,'SourceB');fs.cpSync(path.dirname(a),bDir,{recursive:true});const b=path.join(bDir,path.basename(a));command('--mode','local','--project',b,'cell','set','Items',id,'hp','99');
const source=(id,project,ns,version)=>({id,project:path.relative(title,project).split(path.sep).join('/'),namespace:ns,class_name:id==='base'?'BaseData':'EventData',version,runtime_out:'data/devcel/'+id+'.json',mode:'full'});
const settings={schema_version:1,sources:[source('base',a,'Game.Base',0),source('event',b,'Game.Event',null)]};
const editor=require(path.join(packageRoot,'editor.js')).create(title,'data/devcel/index.json');
(async()=>{
    assert.strictEqual(editor.config().sources.length,0);
    await editor.save(settings);settings.sources.forEach((source,index)=>Object.keys(source).forEach(key=>assert.deepStrictEqual(editor.config().sources[index][key],source[key])));
    await editor.pull();
    const index=JSON.parse(fs.readFileSync(path.join(title,'data/devcel/index.json')));assert.strictEqual(index.sources.length,2);assert.strictEqual(index.sources[0].class_name,'BaseData');assert.strictEqual(index.sources[0].namespace,'Game.Base');
    const data=()=>JSON.parse(fs.readFileSync(path.join(title,'data/devcel/base.json')));assert.strictEqual(data().manifest.content_version,0);
    assert.strictEqual(data().tables[0].records[0].values.hp,'7');
    const baseBefore=fs.readFileSync(path.join(title,'data/devcel/base.json'));
    command('--mode','local','--project',b,'cell','set','Items',id,'hp','123');await editor.pull('event');assert.deepStrictEqual(fs.readFileSync(path.join(title,'data/devcel/base.json')),baseBefore);
    const state=await editor.status();assert(state.data.sources.every(s=>s.status==='ready'));
    const configBefore=fs.readFileSync(path.join(title,'devcel.import.json'));
    const bad=JSON.parse(JSON.stringify(settings));bad.sources[0].runtime_out='data/Actors.json';await assert.rejects(editor.save(bad),/data\/devcel/);assert.deepStrictEqual(fs.readFileSync(path.join(title,'devcel.import.json')),configBefore);
    const duplicate=JSON.parse(JSON.stringify(settings));duplicate.sources[1].namespace='game.base';await assert.rejects(editor.save(duplicate),/collision/);
    const old=JSON.parse(JSON.stringify(settings));old.sources[0].project=a;await assert.rejects(editor.save(old),/relative/);
    const invalidClass=JSON.parse(JSON.stringify(settings));invalidClass.sources[0].class_name='class';await assert.rejects(editor.save(invalidClass));assert.deepStrictEqual(fs.readFileSync(path.join(title,'devcel.import.json')),configBefore);
    // A modified generated index and a modified CLI are detected before replacement/execution.
    const indexPath=path.join(title,'data/devcel/index.json'),indexOriginal=fs.readFileSync(indexPath);fs.appendFileSync(indexPath,' ');await assert.rejects(editor.pull('base'),/manually edited/);fs.writeFileSync(indexPath,indexOriginal);
    const originalManifest=fs.readFileSync(path.join(packageRoot,'bin/manifest.json'));manifest.binaries[rid].sha256='0'.repeat(64);fs.writeFileSync(path.join(packageRoot,'bin/manifest.json'),JSON.stringify(manifest));await assert.rejects(editor.status(),/SHA256/);fs.writeFileSync(path.join(packageRoot,'bin/manifest.json'),originalManifest);
    await editor.pull();
    let opened=0,focused=0,callbacks=[],handlers={};
    const mockWindow={focus(){focused++;},on(event,fn){handlers[event]=fn;},window:{Event:function(name){this.type=name;},dispatchEvent(){}}};
    global.nw={Window:{open(url,options,callback){opened++;callbacks.push(callback);}}};
    editor.openWindow();editor.openWindow();assert.strictEqual(opened,1);
    callbacks.shift()(mockWindow);handlers.loaded();assert.strictEqual(mockWindow.window.DevcelImporter,editor);
    editor.openWindow();assert.strictEqual(focused,1);handlers.closed();editor.openWindow();assert.strictEqual(opened,2);
    callbacks.shift()(mockWindow);handlers.closed();delete global.nw;
    fs.writeFileSync(path.join(root,'commands.json'),JSON.stringify(log,null,2));fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({ok:true,sourceIsolation:true,configPreserved:true,nativeMvMz:false},null,2));
    console.log(JSON.stringify({ok:true,commands:log.length,evidence:root,native_mv_mz:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});
