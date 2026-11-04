'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {pull,saveConfig,tagPresets}=require('./cli.cjs');
class Importer {
  constructor({packageRoot,configPath,onImported=async()=>{},validateConfig=()=>{}}){this.packageRoot=path.resolve(packageRoot);this.configPath=path.resolve(configPath);this.onImported=onImported;this.validateConfig=validateConfig;this.busy=false;this.timer=null;this.closed=true;this.watchGeneration=0;this.lastError='';}
  async configState(){
    try{const raw=await fs.readFile(this.configPath);return {config:JSON.parse(raw.toString('utf8')),revision:createHash('sha256').update(raw).digest('hex')};}
    catch(error){if(error.code==='ENOENT')return {config:{schema_version:1,sources:[]},revision:'missing'};throw error;}
  }
  async config(){return (await this.configState()).config;}
  async tagPresets(project){
    if(typeof project!=='string'||path.isAbsolute(project)||!project.endsWith('.devcelproj.toml'))throw new Error('Choose a project path relative to the configuration folder');
    return tagPresets(this.packageRoot,path.resolve(path.dirname(this.configPath),project));
  }
  async save(config,expectedRevision){
    if(this.busy)throw new Error('Import is running; wait before changing settings');
    this.busy=true;
    try{
      this.validateConfig(config);
      // Rust owns validation, import locking and atomic configuration persistence.
      await saveConfig(this.packageRoot,this.configPath,config,expectedRevision);
      return this.config();
    }finally{this.busy=false;}
  }
  async supportFiles(){
    const files=['devcel-runtime.js','devcel-runtime.d.ts'];
    if(await fs.stat(path.join(this.packageRoot,'runtime','DevcelCocos.ts')).then(()=>true,()=>false))files.push('DevcelCocos.ts');
    return files;
  }
  async checkSupportCollisions(config){
    const base=path.dirname(this.configPath);
    // Resolve existing ancestors too, so symlink aliases cannot conceal a collision.
    const identity=async target=>{let current=path.resolve(base,target),suffix=[];for(;;){try{return path.join(await fs.realpath(current),...suffix).toLowerCase();}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(current);if(parent===current)throw error;suffix.unshift(path.basename(current));current=parent;}}};
    const outputs=new Set(await Promise.all([this.configPath,...config.sources.flatMap(s=>[s.code_out,s.runtime_out].filter(Boolean))].map(identity)));
    const files=await this.supportFiles();
    for(const source of config.sources){if(!source.code_out)continue;const directory=path.dirname(path.resolve(base,source.code_out));for(const file of files){const support=path.join(directory,file);if(outputs.has(await identity(support)))throw new Error(`Generated output collides with runtime support file: ${support}`);}}
  }
  async installRuntime(source,checkOnly=false){
    if(!source.code_out)return;
    const directory=path.dirname(path.resolve(path.dirname(this.configPath),source.code_out));
    const runtimeRoot=path.join(this.packageRoot,'runtime');
    const files=await this.supportFiles();
    for(const file of files){
      const bytes=await fs.readFile(path.join(runtimeRoot,file));const destination=path.join(directory,file);
      const existing=await fs.lstat(destination).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if(existing){if(existing.isSymbolicLink()||!existing.isFile()||!bytes.equals(await fs.readFile(destination)))throw new Error(`Existing runtime is not the packaged version; preserve it and choose another code directory: ${destination}`);continue;}
      // CLI validates output locations before this helper is called; only add support files after successful pull.
      if(!checkOnly)await fs.writeFile(destination,bytes,{flag:'wx'});
    }
  }
  async import(sourceId='',status=false){
    if(this.busy)throw new Error('Another import is running');this.busy=true;
    try{
      const config=await this.config();this.validateConfig(config);const selected=config.sources.filter(s=>!sourceId||s.id===sourceId);
      if(!status){await this.checkSupportCollisions(config);for(const s of selected)await this.installRuntime(s,true);}
      let result;
      try{result=await pull(this.packageRoot,this.configPath,sourceId,status);}catch(error){
        if(!status&&error.response?.data?.sources)for(const s of selected){if(error.response.data.sources.some(result=>result.id===s.id&&result.status==='pulled')){await this.installRuntime(s);await this.onImported(s,error.response);}}
        throw error;
      }
      if(!status)for(const s of selected){await this.installRuntime(s);await this.onImported(s,result);}
      this.lastError='';return result;
    }catch(e){this.lastError=e.message;throw e;}finally{this.busy=false;}
  }
  /** Poll the Rust-owned saved-file fingerprint; no timestamp-only heuristics. */
  watch(onStatus=()=>{},intervalMs=2000){
    this.stopWatch();this.closed=false;const generation=this.watchGeneration;
    const tick=async()=>{
      try{
        if(!this.busy){let result;try{result=await this.import('',true);}catch(error){if(!error.response?.data?.sources)throw error;result=error.response;}onStatus(result);for(const s of result.data.sources??[]){if(this.closed||generation!==this.watchGeneration)break;if(s.status==='needs_pull'||s.status==='error'){try{await this.import(s.id);onStatus({source:s.id,status:'pulled'});}catch(error){onStatus({source:s.id,error:error.message});}}}}
      }catch(error){onStatus({error:error.message});}
      finally{if(!this.closed&&generation===this.watchGeneration)this.timer=setTimeout(tick,intervalMs);}
    };
    void tick();return ()=>this.stopWatch();
  }
  stopWatch(){this.closed=true;this.watchGeneration++;clearTimeout(this.timer);this.timer=null;}
}
module.exports={Importer};
