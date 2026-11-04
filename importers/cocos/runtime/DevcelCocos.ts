import {resources,JsonAsset} from 'cc';
import {DevcelDatabase} from './devcel-runtime.js';
/** One source, one DB. Only the dedicated Devcel JSON cache is released. */
export class CocosDevcelSource {
  readonly database=new DevcelDatabase();
  private pending:Promise<boolean>|undefined;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private stopped=true;
  private watchGeneration=0;
  constructor(readonly resourcePath:string){}
  async reload():Promise<boolean>{
    if(this.pending)return this.pending;
    this.pending=new Promise<boolean>((resolve,reject)=>{
      const existing=resources.get(this.resourcePath,JsonAsset);
      if(existing)resources.release(this.resourcePath,JsonAsset);
      resources.load(this.resourcePath,JsonAsset,(error:Error|null,asset:JsonAsset)=>{
        if(error){reject(error);return;}
        try{resolve(this.database.loadJson(JSON.stringify(asset.json)));}catch(e){reject(e);}
      });
    });
    try{return await this.pending;}finally{this.pending=undefined;}
  }
  /** Development preview: refresh JSON after Editor reimports it. Stop when the owner is destroyed. */
  watch(intervalMs=1000,onError:(error:unknown)=>void=console.error):()=>void{
    if(!Number.isFinite(intervalMs)||intervalMs<100)throw new Error('intervalMs must be >=100');
    this.stop();this.stopped=false;const generation=this.watchGeneration;
    const tick=async()=>{try{await this.reload();}catch(e){onError(e);}finally{if(!this.stopped&&generation===this.watchGeneration)this.timer=setTimeout(tick,intervalMs);}};
    void tick();return ()=>this.stop();
  }
  stop():void{this.stopped=true;this.watchGeneration++;if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
}
