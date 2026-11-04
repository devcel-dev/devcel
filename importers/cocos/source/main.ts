const path=require('path');
const {Importer}=require('../editor/importer.cjs');
let importer:any;
let lastWatch:unknown=null;
function getImporter():any {
  if(!importer)importer=new Importer({packageRoot:path.resolve(__dirname,'..'),configPath:path.join(Editor.Project.path,'devcel.import.json'),validateConfig:validateCocos,onImported:async(source:any)=>{
    for(const output of [source.runtime_out,source.code_out].filter(Boolean)){
      const relative=path.relative(path.join(Editor.Project.path,'assets'),path.resolve(Editor.Project.path,output));
      if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Cocos output must be under assets');
      await Editor.Message.request('asset-db','refresh-asset','db://assets/'+relative.split(path.sep).join('/'));
    }
    if(source.code_out){const directory=path.relative(path.join(Editor.Project.path,'assets'),path.dirname(path.resolve(Editor.Project.path,source.code_out))).split(path.sep).join('/');await Editor.Message.request('asset-db','refresh-asset','db://assets/'+directory);}
    Editor.Message.broadcast('devcel-importer:imported',{sourceId:source.id,runtime:source.runtime_out});
  }});
  return importer;
}
function validateCocos(config:any):void {
  for(const source of config.sources??[]){
    for(const [field,base] of [['runtime_out','assets/resources'],['code_out','assets']] as const){
      if(!source[field])continue;const relative=path.relative(path.resolve(Editor.Project.path,base),path.resolve(Editor.Project.path,source[field]));
      if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error(`${field} must be inside ${base}`);
    }
  }
}
export const methods={
  openPanel(){Editor.Panel.open('devcel-importer');},
  async tagPresets(project:string){return getImporter().tagPresets(project);},
  async config(){return {...(await getImporter().configState()),path:getImporter().configPath,watch:lastWatch};},
  async save(config:any,revision?:string){validateCocos(config);await getImporter().save(config,revision);return getImporter().configState();},
  async importSource(id=''){validateCocos(await getImporter().config());return getImporter().import(id);},
  async status(){return {result:await getImporter().import('',true),watch:lastWatch};},
  watch(enabled:boolean){if(enabled)getImporter().watch((value:unknown)=>{lastWatch=value;});else getImporter().stopWatch();return {watching:enabled};},
  async chooseProject(){const result=await Editor.Dialog.select({title:'Select a source project',filters:[{name:'Devcel project',extensions:['toml']}],multi:false});return result.canceled||!result.filePaths.length?'':path.relative(Editor.Project.path,result.filePaths[0]).split(path.sep).join('/');}
};
export function load(){}
export function unload(){if(importer)importer.stopWatch();importer=undefined;}
