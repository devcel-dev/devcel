type Source={id:string;project:string;namespace:string;class_name?:string;runtime_out:string;code_out?:string;code_target?:string;mode:string;version?:number;row_include_tags?:string[];row_exclude_tags?:string[];column_include_tags?:string[];column_exclude_tags?:string[]};
module.exports=Editor.Panel.define({
  template:`<div id="app"><h2>Devcel Import</h2><p>1. Add a source → 2. Configure settings → 3. Reimport</p><p id="path"></p><div id="sources"></div><button id="add">Add source</button><button id="save">Save settings</button><button id="all">Reimport all</button><button id="status">Check status</button><label><input type="checkbox" id="watch"> Watch saved changes and import automatically</label><p id="result" role="status" style="white-space:pre-wrap"></p><details id="details" hidden><summary>Details (JSON)</summary><pre id="raw"></pre></details></div>`,
  style:`#app{padding:18px;overflow:auto;height:100%;box-sizing:border-box;font:14px system-ui}section{border:1px solid #607080;padding:14px;margin:12px 0;border-radius:6px}label{display:block;margin:8px 0}input{margin-left:8px;width:60%;padding:5px}input[type=checkbox]{width:auto}button{margin:5px;padding:7px}pre{white-space:pre-wrap;overflow-wrap:anywhere}#path{overflow-wrap:anywhere;color:#aaa}`,
  $:{app:'#app',sources:'#sources',path:'#path',add:'#add',save:'#save',all:'#all',status:'#status',watch:'#watch',result:'#result',details:'#details',raw:'#raw'},
  async ready(this:any){
    this.config={schema_version:1,sources:[]};this.revision='missing';this.busy=false;this.registries=new Map<string,string[]>();
    const request=(action:string,...args:any[])=>Editor.Message.request('devcel-importer',action,...args);
    const errorText=(value:any):string=>typeof value==='string'?value:value?.text??value?.message??(value?.error?errorText(value.error):'Open the details to investigate the cause.');
    const summarize=(value:any):string=>{
      if(typeof value==='string')return value;
      const data=value?.result??value,sources=data?.data?.sources??data?.sources;
      const labels:Record<string,string>={pulled:'Import completed',ready:'Up to date',needs_pull:'Reimport required',error:'Import failed'};
      if(Array.isArray(sources))return sources.map(source=>`${source.id}: ${labels[source.status]??'Check the status'}${source.error?'\n  '+errorText(source.error):''}`).join('\n');
      if(data?.config)return `Saved settings (${data.config.sources.length} sources)`;
      if(typeof data?.watching==='boolean')return data.watching?'Started watching saved changes.':'Stopped watching saved changes.';
      return data?.ok===false?'Operation failed.\n'+errorText(data.error):'Operation completed.';
    };
    const showResult=(value:any,failed=false)=>{
      this.$.result.textContent=failed?(value?.data?.sources||value?.sources?summarize(value):'Operation failed.\n'+errorText(value)):summarize(value);
      this.$.details.open=false;this.$.details.hidden=typeof value==='string'&&!failed;this.$.raw.textContent=JSON.stringify(value,null,2);
    };
    const work=async(fn:()=>Promise<any>,progress='Working…')=>{
      if(this.busy)return;this.busy=true;this.$.result.textContent=progress;this.$.result.setAttribute('aria-busy','true');this.$.details.hidden=true;this.$.details.open=false;
      this.$.app.querySelectorAll('button,input,select').forEach((b:HTMLButtonElement)=>b.disabled=true);
      try{showResult(await fn());}catch(error){const message=error instanceof Error?error.message:String(error);let detail:any;try{detail=JSON.parse(message);}catch{detail={error:message};}showResult(detail,true);}
      finally{this.busy=false;this.$.result.setAttribute('aria-busy','false');this.$.app.querySelectorAll('button,input,select').forEach((b:HTMLButtonElement)=>b.disabled=false);render();}
    };
    const render=()=>{
      this.$.sources.replaceChildren();
      this.config.sources.forEach((source:Source,index:number)=>{
        const section=document.createElement('section');const heading=document.createElement('h3');heading.textContent=source.id||'New source';section.append(heading);
        const fields=[['id','Configuration ID'],['project','Source project'],['namespace','Namespace'],['class_name','Class name'],['version','Content Version'],['runtime_out','JSON output path'],['code_out','TypeScript output path']];
        for(const [key,title]of fields){const label=document.createElement('label');label.textContent=title;const input=document.createElement('input');input.value=String((source as any)[key]??'');const hints:Record<string,string>={class_name:'Leave blank to use the default class name',version:'Leave blank for all versions',code_out:'Leave blank to disable code generation'};input.placeholder=hints[key]??'';input.title=key==='version'?'Leave blank for all versions. Valid range: 0–4294967295.':input.placeholder;input.oninput=()=>{if(input.value===''&&['version','class_name','code_out'].includes(key))delete (source as any)[key];else (source as any)[key]=key==='version'?Number(input.value):input.value;if(key==='code_out'){if(input.value)source.code_target='typescript';else delete source.code_target;}};label.append(input);section.append(label);
          if(key==='project'){input.onchange=()=>render();const browse=document.createElement('button');browse.textContent='Select';browse.onclick=()=>work(async()=>{const project=await request('choose-project');if(project){source.project=project;input.value=project;render();}return 'Source selected';});label.append(browse);}}
        const filters=document.createElement('fieldset');const legend=document.createElement('legend');legend.textContent='Row / column tag filters';filters.append(legend);
        const explanation=document.createElement('p');explanation.textContent='Empty include means all; include tags use OR; exclude wins. Invalid references fail import and keep the last successful files.';filters.append(explanation);
        const presets:string[]|undefined=this.registries.get(source.project);
        const refresh=document.createElement('button');refresh.textContent='Load / refresh project tag presets';refresh.onclick=()=>work(async()=>{const project=source.project;const tags=await request('tag-presets',project);this.registries.set(project,tags);render();return 'Loaded project tag presets';});filters.append(refresh);
        const state=document.createElement('p');state.textContent=presets===undefined?'Load presets for this source before selecting tags. Existing values are retained.':'Presets loaded for '+source.project;filters.append(state);
        const keys=['row_include_tags','row_exclude_tags','column_include_tags','column_exclude_tags'] as const;
        const titles=['Include row tags','Exclude row tags','Include column tags','Exclude column tags'];
        keys.forEach((key,k)=>{
          const group=document.createElement('div'),title=document.createElement('h4');title.textContent=titles[k];group.append(title);
          const values=source[key]??[];
          values.forEach((tag,i)=>{
            const row=document.createElement('label');row.textContent=presets===undefined?'Saved tag':presets.includes(tag)?'Preset':'Unregistered tag (repair or remove)';
            if(presets?.includes(tag)){const select=document.createElement('select');for(const name of presets){const option=document.createElement('option');option.value=name;option.textContent=name;select.append(option);}select.value=tag;select.onchange=()=>{source[key]=values.map((v,n)=>n===i?select.value:v);render();};row.append(select);}
            else {const input=document.createElement('input');input.value=tag;input.disabled=presets===undefined;input.title='Existing unknown value: enter an exact registered preset name to return to the selector';input.onchange=()=>{source[key]=values.map((v,n)=>n===i?input.value:v);render();};row.append(input);}
            const remove=document.createElement('button');remove.textContent='Remove';remove.onclick=()=>{source[key]=values.filter((_,n)=>n!==i);render();};row.append(remove);group.append(row);
          });
          const available=(presets??[]).filter(tag=>!values.includes(tag));const add=document.createElement('select');const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Add preset…';add.append(placeholder);for(const tag of available){const option=document.createElement('option');option.value=tag;option.textContent=tag;add.append(option);}add.disabled=!available.length;add.onchange=()=>{if(add.value){source[key]=[...values,add.value];render();}};group.append(add);filters.append(group);
        });section.append(filters);
        const button=document.createElement('button');button.textContent='Reimport this source';button.onclick=()=>work(async()=>{await save();return request('import',source.id);},`${source.id}: Importing…`);section.append(button);
        const remove=document.createElement('button');remove.textContent='Remove from settings (keep generated files)';remove.onclick=()=>{this.config.sources.splice(index,1);render();};section.append(remove);this.$.sources.append(section);
      });
      if(this.busy)this.$.sources.querySelectorAll('button,input,select').forEach((e:HTMLInputElement)=>e.disabled=true);
    };
    const save=async()=>{const result=await request('save',this.config,this.revision);this.config=result.config;this.revision=result.revision;render();return result;};
    this.$.add.onclick=()=>{const n=this.config.sources.length+1;this.config.sources.push({id:'source'+n,project:'../Authoring/Game.devcelproj.toml',namespace:'Game.Source'+n,class_name:'GameData'+n,runtime_out:'assets/resources/devcel/source'+n+'.json',code_out:'assets/devcel/source'+n+'/GameData.ts',code_target:'typescript',mode:'full'});render();};
    this.$.save.onclick=()=>work(save,'Saving settings…');this.$.all.onclick=()=>work(async()=>{await save();return request('import');},'Importing all sources…');this.$.status.onclick=()=>work(()=>request('status'),'Checking source status…');this.$.watch.onchange=()=>work(()=>request('watch',this.$.watch.checked));
    await work(async()=>{const result=await request('config');this.config=result.config;this.revision=result.revision;this.$.path.textContent=result.path;render();return 'Loaded saved settings';});
  }
});
