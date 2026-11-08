-- Editor-only integration. Fixed project-local settings; CLI owns all project/export validation.
local M={}
local CONFIG="devcel.import.json"
local unpack_args=table.unpack or unpack
local function read(path)
    local f,err=io.open(path,"rb"); assert(f,err); local text=f:read("*a"); f:close(); return text
end
local function platform()
    local p=editor.platform
    local map={['x86_64-win32']='win-x64',['arm64-win32']='win-arm64',
        ['x86_64-linux']='linux-x64',['arm64-linux']='linux-arm64',
        ['arm64-macos']='osx-arm64'}
    assert(map[p],"Unsupported editor platform: "..tostring(p)); return map[p]
end
local function cli()
    local rid=platform(); local windows=rid:match('^win')~=nil
    if not windows then
        for _,path in ipairs({'devcel','devcel/tools','devcel/tools/manifest.json','devcel/tools/'..rid}) do
            editor.execute('test','!', '-L',path,{reload_resources=false})
        end
    end
    local manifest=json.decode(read('devcel/tools/manifest.json'))
    assert(manifest.schema_version==1,"Reinstall the matching Devcel ZIP: invalid CLI manifest")
    local entry=manifest.binaries and manifest.binaries[rid]
    local relative=rid..(windows and '/devcel.exe' or '/devcel')
    assert(entry and entry.path==relative and type(entry.sha256)=='string' and entry.sha256:match('^[0-9a-f]+$') and #entry.sha256==64,"Bundled CLI platform/hash missing")
    local binary='devcel/tools/'..relative
    local options={out='capture',reload_resources=false}
    if not windows then editor.execute('test','!', '-L',binary,{reload_resources=false}) end
    local digest
    if windows then
        digest=editor.execute('powershell.exe','-NoProfile','-NonInteractive','-File','devcel/editor/verify-cli.ps1',rid,options)
    elseif rid:match('^osx') then
        digest=editor.execute('shasum','-a','256',binary,options)
    else digest=editor.execute('sha256sum',binary,options) end
    assert(digest:sub(1,64):lower()==entry.sha256,"Bundled CLI checksum mismatch. Reinstall; no command was executed.")
    if not windows then
        for _,path in ipairs({'devcel','devcel/tools','devcel/tools/'..rid,binary}) do
            editor.execute('test','!', '-L',path,{reload_resources=false})
        end
        editor.execute('chmod','u+x',binary,{reload_resources=false})
    end
    return binary
end
function M.read_config()
    if not editor.resource_attributes('/'..CONFIG).exists then return {schema_version=1,sources={}} end
    local config=json.decode(read(CONFIG))
    assert(config.schema_version==1 and type(config.sources)=='table',"Invalid devcel.import.json")
    return config
end
function M.tag_presets(project)
    assert(type(project)=='string' and project:match('%.devcelproj%.toml$'), 'Specify a .devcelproj.toml file')
    -- CONFIG lives at the editor project root; relative source paths have the same base.
    local result=editor.execute(cli(),'tag-presets','--mode','local','--project',project,{out='capture',reload_resources=false})
    local response=json.decode(result)
    assert(response.ok and response.data and type(response.data.presets)=='table','Invalid project tag registry: '..result)
    for _,tag in ipairs(response.data.presets) do assert(type(tag)=='string','Invalid project tag preset') end
    return response.data.presets
end
function M.pull(id)
    local arguments={'pull','--config',CONFIG}
    if id then arguments[#arguments+1]='--source'; arguments[#arguments+1]=id end
    arguments[#arguments+1]={out='capture',reload_resources=true}
    local result=editor.execute(cli(),unpack_args(arguments))
    local response=json.decode(result)
    assert(response.ok and response.data and response.data.success,"Devcel Pull failed: "..result)
    print('Devcel: import complete; resources reloaded. '..result)
    return response
end
function M.status()
    local result=editor.execute(cli(),'pull','--config',CONFIG,'--status',{out='capture',reload_resources=false})
    print(result); return json.decode(result)
end
local function validate(source)
    assert(type(source.id)=='string' and source.id:match('^[A-Za-z0-9_-]+$'),"Configuration IDs may contain letters, digits, underscores, and hyphens")
    assert(type(source.project)=='string' and source.project:match('%.devcelproj%.toml$'),"Specify a .devcelproj.toml file")
    assert(type(source.namespace)=='string' and #source.namespace>0,"Enter a namespace")
    assert(source.mode=='full' or source.mode=='minimal',"Invalid mode")
    if source.version then assert(source.version==math.floor(source.version) and source.version>=0 and source.version<=4294967295,"Content Version must be in the range 0–4294967295") end
end
local filter_keys={row_include_tags=true,row_exclude_tags=true,column_include_tags=true,column_exclude_tags=true}
-- Editor JSON and runtime JSON have different APIs. Emit known arrays explicitly,
-- including [], instead of depending on the encoder's empty-table inference.
local function string_array(values)
    assert(type(values)=='table','Tag filters must be arrays')
    local encoded={}
    for index,value in ipairs(values) do assert(type(value)=='string','Tag filters must contain strings');encoded[index]=json.encode(value) end
    for key in pairs(values) do assert(type(key)=='number' and key>=1 and key<=#encoded and key==math.floor(key),'Tag filters must be dense arrays') end
    return '['..table.concat(encoded,',')..']'
end
function M.encode_config(config)
    local sources={}
    for index,source in ipairs(config.sources) do
        local fields={}
        for key,value in pairs(source) do fields[#fields+1]=json.encode(key)..':'..(filter_keys[key] and string_array(value) or json.encode(value)) end
        sources[index]='{'..table.concat(fields,',')..'}'
    end
    local fields={}
    for key,value in pairs(config) do fields[#fields+1]=json.encode(key)..':'..(key=='sources' and ('['..table.concat(sources,',')..']') or json.encode(value)) end
    return '{'..table.concat(fields,',')..'}'
end
function M.save_source(source)
    validate(source)
    local config=M.read_config(); local found=false
    for index,old in ipairs(config.sources) do
        if old.id==source.id then
            -- Preserve code_out/code_target and any future CLI-supported settings.
            for key,value in pairs(source) do old[key]=value end
            old.class_name=source.class_name; old.version=source.version
            config.sources[index]=old; found=true; break
        end
    end
    if not found then config.sources[#config.sources+1]=source end
    -- Keep the editor's unsaved text buffer from silently overwriting external writes.
    if editor.can_get('/'..CONFIG,'text') then
        assert(editor.get('/'..CONFIG,'text')==read(CONFIG),"Save or revert devcel.import.json before editing settings")
    end
    local encoded=M.encode_config(config)
    local binary=cli()
    local tmp='.devcel.import.'..tostring(os.time())..'.'..tostring(math.random(100000000,999999999))..'.pending.json'
    local existing=io.open(tmp,'rb'); if existing then existing:close(); error('Temporary settings path already exists; retry') end
    local f,err=io.open(tmp,'wb'); assert(f,err)
    local ok,why=f:write(encoded); f:close(); assert(ok,why)
    local saved,result=pcall(editor.execute,binary,'pull-config-save','--config',CONFIG,'--input',tmp,{out='capture',reload_resources=true})
    os.remove(tmp)
    assert(saved,result)
    local response=json.decode(result); assert(response.ok,'Settings save failed: '..result)
end
return M
