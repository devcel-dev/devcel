/** Real CLI + authenticated standalone server: filter persistence, registry isolation, fingerprint watch. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,cp,link} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{start}=require('../editor/server.cjs'),{platform}=require('../editor/cli.cjs');
const cli=process.argv[2],evidence=process.argv[3];if(!cli||!evidence)throw Error('Usage: node tests/tag-filters.mjs /absolute/devcel /new/evidence-dir');
await mkdir(evidence,{recursive:false});
function command(...args){const p=spawnSync(cli,args,{encoding:'utf8',timeout:90000});assert.equal(p.status,0,p.stdout+p.stderr);return JSON.parse(p.stdout).data;}
const project=command('init','Authoring','--dir',evidence).project_path;
command('--mode','local','--project',project,'table','create','Items');
command('--mode','local','--project',project,'column','add','Items','hp','I32');
command('--mode','local','--project',project,'record','add','Items','--uuid','11111111-1111-4111-8111-111111111111');
let metadata=await readFile(project,'utf8');metadata=metadata.replace(/^tag_presets\s*=.*$/m,'tag_presets = ["release", "mobile"]');if(!metadata.includes('tag_presets'))metadata+='\ntag_presets = ["release", "mobile"]\n';await writeFile(project,metadata);
const other=path.join(evidence,'Other.devcelproj.toml');await writeFile(other,metadata.replace('["release", "mobile"]','["other"]'));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),sdk=path.join(evidence,'sdk'),target=platform(),filename=process.platform==='win32'?'devcel.exe':'devcel';
await mkdir(path.join(sdk,'bin',target),{recursive:true});await cp(path.join(root,'runtime'),path.join(sdk,'runtime'),{recursive:true});await link(cli,path.join(sdk,'bin',target,filename)).catch(error=>{if(error.code!=='EXDEV')throw error;return copyFile(cli,path.join(sdk,'bin',target,filename));});
await writeFile(path.join(sdk,'bin/manifest.json'),JSON.stringify({schema_version:1,version:require('../package.json').version,supportedPlatforms:[target],binaries:{[target]:{path:`${target}/${filename}`,sha256:createHash('sha256').update(await readFile(cli)).digest('hex')}}}));
const game=path.join(evidence,'game');await mkdir(game);const configPath=path.join(game,'devcel.import.json');
const started=await start({configPath,packageRoot:sdk});const url=new URL(started.url),token=new URLSearchParams(url.hash.slice(1)).get('token');url.hash='';
async function api(action,data={}){const response=await fetch(new URL('/api',url),{method:'POST',headers:{'Content-Type':'application/json','X-Devcel-Token':token},body:JSON.stringify({action,...data})});return {status:response.status,value:await response.json()};}
try{
 assert.equal((await fetch(new URL('/tag-filters.js',url))).status,200);
 assert.deepEqual((await api('tags',{project:path.relative(game,project)})).value.presets,['release','mobile']);
 assert.deepEqual((await api('tags',{project:path.relative(game,other)})).value.presets,['other']);
 assert.equal((await api('tags',{project})).status,400);
 assert.equal((await api('tags',{project:'../missing.devcelproj.toml'})).status,400);
 const filterKeys=['row_include_tags','row_exclude_tags','column_include_tags','column_exclude_tags'];
 const source={id:'base',project:path.relative(game,project),namespace:'Game.Base',runtime_out:'data/base.json',mode:'full',row_include_tags:['release'],row_exclude_tags:['mobile'],column_include_tags:['release'],column_exclude_tags:['mobile']};
 let config={schema_version:1,sources:[source]},state=(await api('config')).value;
 let saved=await api('save',{config,revision:state.revision});assert.equal(saved.status,200,JSON.stringify(saved.value));
 state=(await api('config')).value;for(const key of filterKeys)assert.deepEqual(state.config.sources[0][key],source[key]);
 assert.equal((await api('import')).status,200);
 const output=async()=>JSON.parse(await readFile(path.join(game,'data/base.json'),'utf8'));
 assert.equal((await output()).tables[0].records.length,0);assert.equal((await output()).tables[0].columns.length,0);
 // VCS-origin unknown values must survive reload and allow a legal repair without adding unknown slots.
 config=state.config;config.sources[0].row_include_tags=['merged'];await writeFile(configPath,JSON.stringify(config));state=(await api('config')).value;
 assert.deepEqual(state.config.sources[0].row_include_tags,['merged']);state.config.sources[0].row_include_tags=['repaired'];
 saved=await api('save',{config:state.config,revision:state.revision});assert.equal(saved.status,200,JSON.stringify(saved.value));
 assert.deepEqual((await api('config')).value.config.sources[0].row_include_tags,['repaired']);
 state=(await api('config')).value;for(const key of filterKeys)state.config.sources[0][key]=[];
 assert.equal((await api('save',{config:state.config,revision:state.revision})).status,200);
 assert.equal((await api('status')).value.data.sources[0].status,'needs_pull');
 const updates=[];const stop=started.importer.watch(value=>updates.push(value),50);const deadline=Date.now()+15000;
 while(Date.now()<deadline&&(await output()).tables[0].records.length!==1)await new Promise(r=>setTimeout(r,50));stop();
 while(started.importer.busy)await new Promise(r=>setTimeout(r,20));
 assert.equal((await output()).tables[0].records.length,1);assert.equal((await output()).tables[0].columns.length,1);
 assert.equal((await api('status')).value.data.sources[0].status,'ready');
 await writeFile(project,metadata.replace('["release", "mobile"]','["release", "mobile", "new"]'));
 assert.equal((await api('status')).value.data.sources[0].status,'needs_pull');
 assert.equal((await api('import')).status,200);
 const before=await readFile(path.join(game,'data/base.json'));state=(await api('config')).value;state.config.sources[0].row_include_tags=['not-registered'];
 assert.equal((await api('save',{config:state.config,revision:state.revision})).status,400);
 assert.deepEqual(await readFile(path.join(game,'data/base.json')),before);
 const result={ok:true,registryIsolation:true,relativeProjects:true,fourArraysPersist:true,unknownEditRecovery:true,fingerprintStatus:true,registryFingerprint:true,watchReimportsFilters:true,rejectedNewUnknownPreservesOutput:true};await writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{started.importer.stopWatch();await new Promise(r=>started.server.close(r));}
