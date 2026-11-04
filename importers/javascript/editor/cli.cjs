'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {spawn}=require('node:child_process');
const os=require('node:os');
function platform(){const os={win32:'win',darwin:'osx',linux:'linux'}[process.platform];const arch={x64:'x64',arm64:'arm64'}[process.arch];if(!os||!arch)throw new Error('Unsupported bundled CLI platform');return `${os}-${arch}`;}
async function noLinks(root,file){const relative=path.relative(root,file);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('CLI path escapes package');let current=root;for(const part of relative.split(path.sep)){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw new Error(`Symlink forbidden in bundled CLI: ${current}`);}}
async function prepareCli(packageRoot){
  const root=await fs.realpath(packageRoot);const target=platform();const fileName=process.platform==='win32'?'devcel.exe':'devcel';
  const manifestPath=path.join(root,'bin','manifest.json');await noLinks(root,manifestPath);
  const m=JSON.parse(await fs.readFile(manifestPath,'utf8'));const entry=m.binaries?.[target];
  if(m.schema_version!==1||!Array.isArray(m.supportedPlatforms)||!m.supportedPlatforms.includes(target)||entry?.path!==`${target}/${fileName}`||!(/^[a-f0-9]{64}$/i.test(entry?.sha256??'')))throw new Error('Bundled CLI manifest invalid; reinstall the complete SDK ZIP');
  const file=path.join(root,'bin',entry.path);await noLinks(root,file);const stat=await fs.stat(file);if(!stat.isFile())throw new Error('Bundled CLI is not a file');
  const verify=async()=>{await noLinks(root,file);const digest=createHash('sha256').update(await fs.readFile(file)).digest('hex');if(digest!==entry.sha256.toLowerCase())throw new Error('Bundled CLI SHA256 mismatch; execution stopped');};
  await verify();
  if(process.platform!=='win32'&&(stat.mode&0o100)===0)await fs.chmod(file,stat.mode|0o100);
  await verify();return file;
}
async function runCli(packageRoot,args){
  const binary=await prepareCli(packageRoot);
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const output={code:0,stdout:'',stderr:''};let bytes=0;
    // Never interrupt a publication merely for time. Bound captured output while continuing to drain.
    for(const stream of ['stdout','stderr'])child[stream].setEncoding('utf8').on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes<=16*1024*1024)output[stream]+=chunk.toString('utf8');});
    child.on('error',reject);child.on('close',code=>{output.code=code??-1;if(bytes>16*1024*1024)reject(new Error('CLI response exceeded 16 MiB; use pull --status to inspect results'));else resolve(output);});
  });
}
async function pull(packageRoot,configPath,sourceId='',status=false){
  const args=['pull','--config',path.resolve(configPath)];if(sourceId)args.push('--source',sourceId);if(status)args.push('--status');
  return invokeJson(packageRoot,args);
}
async function invokeJson(packageRoot,args){
  const result=await runCli(packageRoot,args);let response;try{response=JSON.parse(result.stdout);}catch{throw new Error(`Invalid CLI response: ${result.stderr}`);}
  if(result.code!==0||response.ok!==true){const error=new Error(JSON.stringify(response.error??response.data??response));error.response=response;throw error;}return response;
}
async function saveConfig(packageRoot,configPath,config,expectedRevision){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'devcel-config-'));
  try{const input=path.join(temp,'settings.json');await fs.writeFile(input,JSON.stringify(config));const args=['pull-config-save','--config',path.resolve(configPath),'--input',input];if(expectedRevision!==undefined)args.push('--expected-revision',expectedRevision);return await invokeJson(packageRoot,args);}
  finally{await fs.rm(temp,{recursive:true,force:true});}
}
async function tagPresets(packageRoot,projectPath){
  const response=await invokeJson(packageRoot,['tag-presets','--mode','local','--project',projectPath]);
  if(!Array.isArray(response.data?.presets)||response.data.presets.some(tag=>typeof tag!=='string'))throw new Error('Invalid project tag registry');
  return response.data.presets;
}
module.exports={tagPresets,platform,prepareCli,runCli,pull,saveConfig};
