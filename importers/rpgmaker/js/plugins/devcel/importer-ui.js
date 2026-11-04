(function(){"use strict";
var api,settings,dirty=false,working=false,pickerCallback=null;
var $=function(id){return document.getElementById(id);};
function node(tag,text){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
function mark(){dirty=true;$("dirty").textContent="There are unsaved changes. Save settings before reimporting.";}
function show(value,error){
    var summary=value,details=typeof value!=="string",failed=!!error;
    if(details){
        var data=value&&value.data?value.data:value;
        var sources=data&&data.sources,imported=false;
        if(Array.isArray(sources)&&sources.length){
            summary=sources.map(function(source){
                var message;
                if(source.status==="pulled"){message="Import completed";imported=true;}
                else if(source.status==="ready")message="Up to date";
                else if(source.status==="needs_pull")message="Updates are available. Reimport to apply them";
                else if(source.status==="error"){message="Import failed";failed=true;}
                else message="Could not check the status. Review the technical details";
                if(source.error&&source.error.text)message+="。"+source.error.text;
                return source.id+": "+message;
            }).join("\n");
            if(imported)summary+="\n\nRestart the playtest to use the new data.";
        }else if(value&&value.error&&value.error.text){summary=value.error.text;failed=true;}
        else summary=failed?"Operation failed. Review the technical details.":"Operation completed.";
    }
    $("result").textContent=summary;
    $("result").className=failed?"result error":"result";
    $("details").hidden=!details;
    $("details").open=false;
    $("detail-json").textContent=details?JSON.stringify(value,null,2):"";
}
function busy(value){working=value;Array.prototype.forEach.call(document.querySelectorAll("button,input,select"),function(n){n.disabled=value;});}
function run(action){if(working)return;busy(true);show("Working. Keep this window open until the operation finishes.");Promise.resolve().then(action).then(function(result){show(result);busy(false);},function(error){var detail=error.message;if(error.stdout){try{detail=JSON.parse(error.stdout);}catch(ignore){}}show(detail,true);busy(false);});}
function label(parent,text,field){var l=node("label",text);l.appendChild(field);parent.appendChild(l);}
function field(source,key,placeholder){var n=node("input");n.value=source[key]===undefined||source[key]===null?"":source[key];if(placeholder)n.placeholder=placeholder;n.addEventListener("input",function(){source[key]=n.value;mark();});return n;}
function requireSaved(){if(dirty)throw new Error("Click Save settings first");}
function render(){
    $("sources").textContent="";
    settings.sources.forEach(function(source,index){
        var box=node("fieldset"),legend=node("legend","Import configuration "+(index+1));box.appendChild(legend);
        var grid=node("div");grid.className="grid";
        label(grid,"Configuration ID",field(source,"id","base"));label(grid,"Namespace",field(source,"namespace","Game.Base"));
        box.appendChild(grid);
        var project=field(source,"project","../authoring/Base.devcelproj.toml"),file=node("div");file.className="file";file.appendChild(project);
        var browse=node("button","Select a source…");browse.addEventListener("click",function(){pickerCallback=function(value){source.project=api.relativeProject(value);project.value=source.project;filters.update(source.project);mark();};$("picker").value="";$("picker").click();});file.appendChild(browse);label(box,"Project",file);
        label(box,"JSON output path",field(source,"runtime_out","data/devcel/base.json"));
        var options=node("div");options.className="grid";
        label(options,"Class name",field(source,"class_name","BaseData"));
        var version=field(source,"version","Blank for all versions. Zero is also valid");version.type="number";version.min="0";version.max="4294967295";version.step="1";label(options,"Content Version",version);
        box.appendChild(options);
        var filterHost=node("div");box.appendChild(filterHost);
        var filters=DevcelTagFilters.create(filterHost,source,function(value){return api.tagPresets(value);},mark,function(){return working;});
        project.addEventListener("input",function(){filters.update("");});
        project.addEventListener("change",function(){filters.update(source.project);});filters.update(source.project);
        var mode=node("select");["full","minimal"].forEach(function(v){var o=node("option",v);o.value=v;mode.appendChild(o);});mode.value=source.mode||"full";mode.addEventListener("change",function(){source.mode=mode.value;mark();});label(box,"Export mode",mode);
        var toolbar=node("div");toolbar.className="toolbar";
        var reimport=node("button","Reimport this configuration");reimport.addEventListener("click",function(){run(function(){requireSaved();return api.pull(source.id);});});toolbar.appendChild(reimport);
        var remove=node("button","Remove from settings");remove.addEventListener("click",function(){settings.sources.splice(index,1);mark();render();});toolbar.appendChild(remove);box.appendChild(toolbar);$("sources").appendChild(box);
    });
}
function normalized(){var copy=JSON.parse(JSON.stringify(settings));copy.sources.forEach(function(s){if(s.class_name===null||s.class_name===undefined||s.class_name==="")delete s.class_name;if(s.version===null||s.version===undefined||s.version==="")delete s.version;else {if(!/^\d+$/.test(String(s.version)))throw new Error("Content Version must be an integer");s.version=Number(s.version);}});return copy;}
function ready(){if(api)return;api=window.DevcelImporter;if(!api)return;try{settings=api.config();$("root").textContent="Game: "+api.root;render();show("Add a configuration, save it, then reimport all.");}catch(e){show(e.message,true);}}
$("add").addEventListener("click",function(){var number=settings.sources.length+1;while(settings.sources.some(function(s){return s.id.toLowerCase()==="source"+number;}))number++;settings.sources.push({id:"source"+number,project:"",namespace:"Game.Source"+number,runtime_out:"data/devcel/source"+number+".json",mode:"full"});mark();render();});
$("save").addEventListener("click",function(){run(function(){var next=normalized();return api.save(next).then(function(){settings=next;dirty=false;$("dirty").textContent="";render();return "Settings saved. Reimport to apply them.";});});});
$("all").addEventListener("click",function(){run(function(){requireSaved();return api.pull(null);});});
$("status").addEventListener("click",function(){run(function(){return api.status(null);});});
$("picker").addEventListener("change",function(){if(pickerCallback&&this.value)pickerCallback(this.value);});
window.addEventListener("devcel-ready",ready);window.addEventListener("beforeunload",function(e){if(working||dirty){e.returnValue="There are unsaved changes or an import in progress. Close anyway?";return e.returnValue;}});ready();
})();
