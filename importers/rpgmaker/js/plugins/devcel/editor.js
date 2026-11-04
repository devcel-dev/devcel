/* Devcel desktop test-play importer. Never required by deployed game runtime. */
"use strict";
var fs=require("fs"), path=require("path"), crypto=require("crypto"), cp=require("child_process");
function fail(message){throw new Error(message);}
function hash(bytes){return crypto.createHash("sha256").update(bytes).digest("hex");}
function noLinks(file){
    var resolved=path.resolve(file),current=path.parse(resolved).root;
    resolved.slice(current.length).split(path.sep).forEach(function(part){if(!part)return;current=path.join(current,part);try{if(fs.lstatSync(current).isSymbolicLink())fail("Symlinks are not allowed: "+current);}catch(e){if(e.code!=="ENOENT")throw e;}});
    return resolved;
}
function mkdir(directory){if(fs.existsSync(directory))return;mkdir(path.dirname(directory));fs.mkdirSync(directory);}
function exec(binary,args,cwd){return new Promise(function(resolve,reject){cp.execFile(binary,args,{cwd:cwd,windowsHide:true,maxBuffer:64*1024*1024},function(error,stdout,stderr){if(error){var problem=new Error("CLI failed: "+(stdout||stderr||error.message));problem.stdout=stdout;problem.stderr=stderr;reject(problem);}else resolve(stdout);});});}
function prepareCli(packageRoot){
    var platform={win32:"win",darwin:"osx",linux:"linux"}[process.platform],architecture=process.arch;
    // MV can bundle a 32-bit NW.js process on a 64-bit Windows host. The CLI is a separate process.
    if(platform==="win"&&architecture==="ia32"){var host=(process.env.PROCESSOR_ARCHITEW6432||process.env.PROCESSOR_ARCHITECTURE||"").toUpperCase();if(host==="AMD64")architecture="x64";else if(host==="ARM64")architecture="arm64";}
    if(!platform||["x64","arm64"].indexOf(architecture)<0)return Promise.reject(new Error("Unsupported OS/CPU: "+process.platform+"/"+architecture));
    var rid=platform+"-"+architecture,binRoot=path.join(packageRoot,"bin"),manifest,file,entry,expected;
    try{
        noLinks(binRoot);
        manifest=JSON.parse(fs.readFileSync(noLinks(path.join(binRoot,"manifest.json")),"utf8"));
        if(manifest.schema_version!==1||!Array.isArray(manifest.supportedPlatforms)||manifest.supportedPlatforms.indexOf(rid)<0)fail("Invalid bundled CLI manifest. Extract the matching Importer ZIP again");
        entry=manifest.binaries&&manifest.binaries[rid];expected=rid+"/devcel"+(platform==="win"?".exe":"");
        if(!entry||entry.path!==expected||!/^[0-9a-f]{64}$/.test(entry.sha256))fail("Invalid CLI binary entry: "+rid);
        file=noLinks(path.join(binRoot,entry.path));
        var stat=fs.statSync(file);
        if(!stat.isFile()||hash(fs.readFileSync(file))!==entry.sha256)fail("Bundled CLI SHA256 mismatch. Extract the Importer ZIP again");
        if(platform!=="win"&&(stat.mode&64)===0)fs.chmodSync(file,stat.mode|64);
        if(hash(fs.readFileSync(file))!==entry.sha256)fail("The file changed during CLI verification");
    }catch(error){return Promise.reject(error);}
    return Promise.resolve(file);
}
function runCli(packageRoot,args,cwd){return prepareCli(packageRoot).then(function(binary){return exec(binary,args,cwd);}).then(function(stdout){var result;try{result=JSON.parse(stdout);}catch(e){fail("Invalid CLI JSON response: "+stdout);}if(!result||result.ok!==true)fail("CLI failed: "+stdout);return result;});}
function atomicWrite(file,text){
    noLinks(file);mkdir(path.dirname(file));
    var temp=file+".tmp-"+process.pid+"-"+crypto.randomBytes(8).toString("hex");
    try{fs.writeFileSync(temp,text,{encoding:"utf8",flag:"wx"});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
exports.prepareCli=prepareCli;
exports.runCli=runCli;
exports.create=function(gameRoot,indexFile){
    gameRoot=fs.realpathSync(gameRoot);
    var packageRoot=path.join(gameRoot,"js/plugins/devcel"),configPath=path.join(gameRoot,"devcel.import.json");
    var runtime=require(path.join(gameRoot,"js/plugins/Devcel.js")),busy=false,windowHandle=null,windowOpening=false;
    function runtimePath(value){
        if(typeof value!=="string"||!/^data\/devcel\/[A-Za-z0-9_./-]+\.json$/.test(value)||value.split("/").some(function(p){return p===".."||p==="."||p==="";}))fail("The output must be a relative JSON path under data/devcel/");
        return noLinks(path.join(gameRoot,value));
    }
    runtimePath(indexFile);
    function config(){
        noLinks(configPath);
        return fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,"utf8")):{schema_version:1,sources:[]};
    }
    function validateSettings(settings){
        if(!settings||settings.schema_version!==1||!Array.isArray(settings.sources)||settings.sources.length===0)fail("Add at least one import configuration");
        var outputs=Object.create(null),index=runtimePath(indexFile).toLowerCase();
        runtime.validateIndex({schema_version:1,sources:settings.sources.map(function(s){
            if(typeof s.project!=="string"||path.isAbsolute(s.project)||!s.project.endsWith(".devcelproj.toml"))fail("The source must be a relative path to a .devcelproj.toml file");
            var output=runtimePath(s.runtime_out).toLowerCase();
            if(output===index||outputs[output])fail("Runtime output collides with the index JSON or another configuration");
            outputs[output]=true;
            if(s.mode!=="full"&&s.mode!=="minimal")fail("mode must be full or minimal");
            if(s.version!==null&&s.version!==undefined&&(!isFinite(s.version)||typeof s.version!=="number"||Math.floor(s.version)!==s.version||s.version<0||s.version>4294967295))fail("Content Version must be blank or in 0..4294967295");
            // This editor emits JSON only. Keep generated program files outside the runtime importer.
            if(s.code_out||s.code_target)fail("This screen cannot edit code_out/code_target. Use a separate configuration file");
            return {id:s.id,namespace:s.namespace,class_name:s.class_name,runtime_file:s.runtime_out};
        })});return settings;
    }
    function exclusive(action){if(busy)return Promise.reject(new Error("Import is in progress. Wait for it to finish"));busy=true;return Promise.resolve().then(action).then(function(value){busy=false;return value;},function(error){busy=false;throw error;});}
    function save(settings){return exclusive(function(){
        validateSettings(settings);
        var input=path.join(gameRoot,".devcel-config-input-"+crypto.randomBytes(8).toString("hex")+".json");
        fs.writeFileSync(input,JSON.stringify(settings,null,2),{encoding:"utf8",flag:"wx"});
        return runCli(packageRoot,["pull-config-save","--config",configPath,"--input",input],gameRoot).then(function(result){fs.unlinkSync(input);return result;},function(error){fs.unlinkSync(input);throw error;});
    });}
    function buildIndex(settings){
        // Validate every source before publishing the index. Never publish a half-populated game.
        var index={schema_version:1,sources:settings.sources.map(function(s){
            var bytes=fs.readFileSync(runtimePath(s.runtime_out),"utf8");
            var database=new runtime.Database(bytes);
            if((database.manifest().content_version===undefined?null:database.manifest().content_version)!==(s.version===undefined?null:s.version))fail("Some configurations have not been reimported: "+s.id);
            return {id:s.id,namespace:s.namespace,class_name:s.class_name||null,runtime_file:s.runtime_out};
        })};
        runtime.validateIndex(index);
        var output=runtimePath(indexFile),ownerPath=output+".devcel-index-owner.json";
        var owner=hash(configPath+"\0rpgmaker-index");
        noLinks(ownerPath);
        if(fs.existsSync(output)){
            var previous=fs.readFileSync(output,"utf8"),marker=fs.existsSync(ownerPath)?JSON.parse(fs.readFileSync(ownerPath,"utf8")):null;
            // An explicitly empty index is safe to initialize; populated unowned files are protected.
            var empty=JSON.parse(previous);
            if(!marker){if(empty.schema_version!==1||!Array.isArray(empty.sources)||empty.sources.length!==0)fail("Unmanaged index.json will not be overwritten");}
            else if(marker.owner!==owner||marker.sha256!==hash(previous))fail("The index JSON belongs to another configuration or was manually edited. Back it up and inspect it");
        }
        var next=JSON.stringify(index,null,2)+"\n",oldOutput=fs.existsSync(output)?fs.readFileSync(output):null;
        try{atomicWrite(output,next);atomicWrite(ownerPath,JSON.stringify({owner:owner,sha256:hash(next)},null,2));}
        catch(error){if(oldOutput!==null)atomicWrite(output,oldOutput);else if(fs.existsSync(output))fs.unlinkSync(output);throw error;}
        return index;
    }
    function pull(sourceId,status){return exclusive(function(){
        var settings=validateSettings(config()),args=["pull","--config",configPath];
        if(sourceId){if(!settings.sources.some(function(s){return s.id===sourceId;}))fail("Configuration not found: "+sourceId);args.push("--source",sourceId);}
        if(status)args.push("--status");
        return runCli(packageRoot,args,gameRoot).then(function(result){
            if(status)return result;
            return runCli(packageRoot,["pull","--config",configPath,"--status"],gameRoot).then(function(state){
                if(!state.data||!state.data.success||state.data.sources.some(function(s){return s.status!=="ready";}))fail("Some configurations have not been reimported. The index JSON was preserved. Reimport all configurations");
                buildIndex(settings);return result;
            });
        });
    });}
    function tagPresets(project){
        if(typeof project!=="string"||path.isAbsolute(project)||!project.endsWith(".devcelproj.toml"))return Promise.reject(new Error("Choose a relative .devcelproj.toml path"));
        return runCli(packageRoot,["tag-presets","--project",noLinks(path.resolve(gameRoot,project)),"--mode","local"],gameRoot).then(function(result){
            if(!result.data||!Array.isArray(result.data.presets)||result.data.presets.some(function(tag){return typeof tag!=="string";}))fail("Invalid project tag presets");
            return result.data.presets;
        });
    }
    var api={tagPresets:tagPresets,config:config,save:save,pull:function(id){return pull(id,false);},status:function(id){return pull(id,true);},relativeProject:function(file){return path.relative(gameRoot,file).split(path.sep).join("/");},root:gameRoot};
    api.openWindow=function(){
        if(windowHandle){windowHandle.focus();return;}
        if(windowOpening)return;
        // NW.js requires a local file to enable Node integration. No network page is opened.
        var nwApi=typeof nw!=="undefined"?nw:require("nw.gui");
        windowOpening=true;
        try{nwApi.Window.open("js/plugins/devcel/importer.html",{title:"Devcel Import settings",width:900,height:800},function(win){
            windowOpening=false;windowHandle=win;
            win.on("loaded",function(){if(windowHandle!==win)return;win.window.DevcelImporter=api;win.window.dispatchEvent(new win.window.Event("devcel-ready"));});
            win.on("closed",function(){windowHandle=null;});
        });}catch(error){windowOpening=false;throw error;}
    };
    return api;
};
