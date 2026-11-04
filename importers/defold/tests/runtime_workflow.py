#!/usr/bin/env python3
"""Execute Devcel Lua integration workflows using an existing system Lua 5.4 library.

No pip packages or Lua/Defold downloads. json/sys/http/editor are explicit API stubs;
this is NOT native Defold VM, JSON parser, editor UI, or target build validation.
Exit 0 = passed, 1 = failure, 77 = skipped (Lua unavailable). --require-lua turns
an unavailable system library into failure for CI that promises this coverage.
"""
import argparse
import atexit
import ctypes as C
import ctypes.util
import json
import os
import pathlib
import sys
import tempfile

if not __debug__:
    raise SystemExit("FAIL: run without Python -O; integration assertions must remain enabled")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--require-lua", action="store_true")
parser.add_argument("--lua-library", default=os.environ.get("DEVCEL_LUA_LIBRARY"),
                    help="Explicit installed Lua 5.4 library; do not fall back if unavailable")
args = parser.parse_args()
engine = pathlib.Path(__file__).resolve().parents[1]
CURRENT_VERSION = json.loads((engine.parents[1]/'devcel-studio/package.json').read_text(encoding='utf-8'))['version']
candidates = [args.lua_library] if args.lua_library else []
if not args.lua_library:
    for name in ("lua5.4", "lua54", "lua-5.4"):
        candidates.append(ctypes.util.find_library(name))
    candidates.extend(("liblua5.4.so.0", "liblua5.4.dylib", "liblua54.dylib", "lua54.dll"))
L = None
failures = []
for candidate in dict.fromkeys(c for c in candidates if c):
    try:
        library = C.CDLL(candidate)
        # Only the 5.4 ABI is supported by this harness.
        library.lua_resetthread
        library.luaL_newstate
        L = library
        break
    except (OSError, AttributeError) as error:
        failures.append(str(error))
if L is None:
    print(("FAIL" if args.require_lua else "SKIP") +
          ": system Lua 5.4 shared library unavailable; native Defold coverage was not run")
    sys.exit(1 if args.require_lua else 77)
print("Using system Lua library:", L._name, flush=True)
L.luaL_newstate.restype=C.c_void_p
state=L.luaL_newstate()
if not state:
    raise RuntimeError('Lua state allocation failed')
L.lua_close.argtypes = [C.c_void_p]
L.lua_close.restype = None
atexit.register(lambda: L.lua_close(state))
for name,argument_types,ret in [('luaL_openlibs',[C.c_void_p],None),('luaL_loadstring',[C.c_void_p,C.c_char_p],C.c_int),('lua_pcallk',[C.c_void_p,C.c_int,C.c_int,C.c_int,C.c_ssize_t,C.c_void_p],C.c_int),('lua_tolstring',[C.c_void_p,C.c_int,C.POINTER(C.c_size_t)],C.c_void_p),('lua_setglobal',[C.c_void_p,C.c_char_p],None),('lua_pushnil',[C.c_void_p],None),('lua_pushstring',[C.c_void_p,C.c_char_p],C.c_void_p),('lua_settop',[C.c_void_p,C.c_int],None)]:
 f=getattr(L,name);f.argtypes=argument_types;f.restype=ret
CB=C.CFUNCTYPE(C.c_int,C.c_void_p)
L.lua_pushcclosure.argtypes=[C.c_void_p,CB,C.c_int]
L.luaL_openlibs(state)
def quote(s):
 return '"'+''.join('\\%03d'%b for b in s.encode())+'"'
def lua(x):
 if x is None:return 'json.null'
 if x is True:return 'true'
 if x is False:return 'false'
 if isinstance(x,str):return quote(x)
 if isinstance(x,(int,float)):return repr(x)
 if isinstance(x,list):return '{'+','.join('['+str(i+1)+']='+lua(v) for i,v in enumerate(x))+'}'
 return '{'+','.join('['+quote(k)+']='+lua(v) for k,v in x.items())+'}'
def text(st,index):
 size=C.c_size_t();p=L.lua_tolstring(st,index,C.byref(size));return C.string_at(p,size.value).decode() if p else ''
@CB
def decode(st):
 try:
  value=json.loads(text(st,1), parse_constant=lambda x: (_ for _ in ()).throw(ValueError('non-JSON number: '+x)));src=('return '+lua(value)).encode()
  if L.luaL_loadstring(st,src) or L.lua_pcallk(st,0,1,0,0,None):raise ValueError(text(st,-1))
  return 1
 except Exception as e:
  L.lua_pushnil(st);L.lua_pushstring(st,str(e).encode());return 2
L.lua_pushcclosure(state,decode,0);L.lua_setglobal(state,b'_decode')
def run(s):
 if L.luaL_loadstring(state,s.encode()) or L.lua_pcallk(state,0,0,0,0,None):raise RuntimeError(text(state,-1))
run('json={null=io.stdout}; json.decode=function(s,opts) local v,e=_decode(s); assert(not e,e); return v end')
# Compile all editor/runtime Lua without loading editor-side globals.
for p in list((engine).rglob('*.lua'))+list((engine).rglob('*.editor_script'))+list((engine).rglob('*.script')):
 if L.luaL_loadstring(state,p.read_bytes()):raise RuntimeError(str(p)+': '+text(state,-1))
 L.lua_settop(state,0)
print('Lua syntax OK')
full=(engine/'samples/master.full.json').read_text(encoding='utf-8')
mini=(engine/'samples/master.minimal.json').read_text(encoding='utf-8')
parts=[f'''package.path={quote(str(engine/'?.lua'))}..';'..package.path
sys={{load_resource=function(p) local f=assert(io.open(p,'rb')); local x=f:read('*a'); f:close(); return x end,get_engine_info=function() return {{is_debug=true}} end}}
local pending={{}}; http={{request=function(url,method,cb,headers,body,options) pending[#pending+1]=cb end}}
local D=require 'devcel.runtime.database'; local db=D.new('base'); local other=D.new('event')
assert(db:load_json({quote(full)})); assert(other:load_json({quote(mini)}))
local hero=db:by_id('Heroes','hero-1')
assert(hero:get('hp')==100 and hero:get('wide')=='9007199254740993' and hero:get('huge')=='18446744073709551615')
assert(hero:get('color_float').r==-0.25 and hero:get('color_float').g==2 and hero:get('color_float').a==0)
assert(hero:get('color32').r==18 and hero:get('color32').a==0)
assert(hero:reference('item'):get('label')=='回復薬')
assert(hero:table_reference('drops'):name()=='Items')
assert(db:table('Heroes'):count()==2 and db:table_by_uuid('heroes-uuid'):at(1):id()=='hero-1')
assert(db:table('Heroes'):at(0)==nil and db:table('Heroes'):at(999)==nil)
local copy=hero:get('color_float');copy.g=999;assert(hero:get('color_float').g==2)
local copy=db:manifest();copy.content_version=999;assert(db:manifest().content_version==1)
for _,t in ipairs(db:tables()) do for _,id in ipairs(db:table(t):ids()) do for _,c in ipairs(db:table(t):columns()) do
assert(db:by_id(t,id):get_raw(c)==other:by_id(t,id):get_raw(c)) end end end
local before=db:manifest().content_hash
assert(not db:load_json('oops'));assert(db:manifest().content_hash==before)
''']
# Default decoding is reused, but each row must own mutable value containers.
for explicit in (False, True):
    default_bundle=json.loads(full)
    for record in default_bundle['tables'][0]['records']:
        record['values']={c['name']:c['default_value'] for c in default_bundle['tables'][0]['columns'] if isinstance(c.get('default_value'), str)} if explicit else {}
    parts.append(f'''local defaults=D.new('defaults'); assert(defaults:load_json({quote(json.dumps(default_bundle))}))
    local first=defaults._snapshot.tables.Heroes.records['hero-1']
    local second=defaults._snapshot.tables.Heroes.records['hero-2']
    assert(first.typed.color_float~=second.typed.color_float)
    first.typed.color_float.g=999;assert(second.typed.color_float.g==2)
    assert(defaults:by_id('Heroes','hero-2'):get('hp')==100)
    ''')
invalid=[json.loads((engine/'samples/master.invalid-column.json').read_text(encoding='utf-8'))]
for typ,val in [('I64','9223372036854775808'),('U64','18446744073709551616'),('U64','-1'),('U8','256'),('F32','1e100'),('F64','nan'),('Boolean','1'),('Color32','[0,1.0,2,3]'),('Color32','[0,1e0,2,3]'),('Color32','[0,true,2,3]'),('Color32','[-1,0,0,0]'),('ColorFloat','[0,0,0,1.1]'),('ColorFloat','[1e100,0,0,0]'),('Curve','{"points":[{"x":"bad","y":1}]}')]:
 b=json.loads(full);b['tables'][0]['columns'][0]['data_type']=typ;b['tables'][0]['columns'][0].pop('default_value',None);b['tables'][0]['records'][0]['values']['name']=val
 invalid.append(b)
for field,value in [('schema_version',99),('mode','weird'),('content_version',-1),('data_revision',-1)]:
 b=json.loads(full);b['manifest'][field]=value;invalid.append(b)
for b in invalid:
 parts.append(f"assert(not db:load_json({quote(json.dumps(b))})); assert(db:manifest().content_hash==before)\n")
b=json.loads(full);b['tables'][0]['records'][0]['values']['hp']='777'
changed=json.dumps(b)
temporary = tempfile.TemporaryDirectory(prefix='devcel-defold-integration ')
atexit.register(temporary.cleanup)
path = str(pathlib.Path(temporary.name) / 'live-fixture.json')
pathlib.Path(path).write_text(full, encoding='utf-8')
parts.append(f'''assert(db:watch_file({quote(path)},0.25));local f=assert(io.open({quote(path)},'wb'));f:write({quote(changed)});f:close();db:update(0.3)
assert(db:by_id('Heroes','hero-1'):get('hp')==777)
assert(hero:get('hp')==100) -- old row keeps its old complete snapshot
assert(other:by_id('Heroes','hero-1'):get('hp')==100) -- same UUIDs in another source stay isolated
local f=assert(io.open({quote(path)},'wb'));f:write('bad');f:close();db:update(0.3)
assert(db:by_id('Heroes','hero-1'):get('hp')==777)
db:watch_http('http://127.0.0.1:1234/runtime/base?token=abc_123',0.25);db:update(0.3);assert(#pending==1)
db:stop_watch();pending[1](nil,nil,{{status=200,response={quote(full)}}});assert(db:by_id('Heroes','hero-1'):get('hp')==777)
db:watch_http('http://127.0.0.1:1234/runtime/base?token=abc_123',0.25);db:update(0.3);pending[2](nil,nil,{{status=200,response={quote(full)}}})
assert(db:by_id('Heroes','hero-1'):get('hp')==100)
db:update(0.3);pending[3](nil,nil,{{status=500,response='bad'}});assert(db:by_id('Heroes','hero-1'):get('hp')==100)
assert(not pcall(function() db:watch_http('http://127.0.0.1:80@evil.test/runtime/base?token=x',1) end))
print('Runtime fixture/full/minimal/types/HDR/references/reload/stale callback/source isolation checks passed')
''')
run(''.join(parts))
run('sys.load_resource=function(p) local f=assert(io.open('+quote(str(engine))+'..p,"rb"));local t=f:read("*a");f:close();return t end; dofile('+quote(str(engine/'samples/runtime-smoke.script'))+'); init({})')

# Exercise editor process capture with LF/CRLF and no trailing newline. No external
# process or engine state is changed by these stubs.
manifest = json.dumps({"schema_version": 1, "version": CURRENT_VERSION, "binaries": {
    "linux-x64": {"path": "linux-x64/devcel", "sha256": "a" * 64}}})
run(f'''local original_open=io.open
io.open=function(path,mode)
    if path=='devcel/tools/manifest.json' then return {{read=function() return {quote(manifest)} end,close=function() end}} end
    return original_open(path,mode)
end
editor={{platform='x86_64-linux',execute=function(command,...)
    local args={{...}}
    if command=='sha256sum' then return string.rep('a',64)..'  devcel/tools/linux-x64/devcel\\n' end
    if command=='test' or command=='chmod' then return nil end
    assert(command=='devcel/tools/linux-x64/devcel')
    assert(args[1]~='--version', 'version probe must not run')
    if args[1]=='tag-presets' then
        assert(args[2]=='--mode' and args[3]=='local' and args[4]=='--project' and args[5]=='../日本語 ゲーム/Game.devcelproj.toml')
        assert(args[6].reload_resources==false and args[6].out=='capture')
        return '{{"ok":true,"data":{{"presets":["mobile","hidden"]}}}}'
    end
    assert(args[1]=='pull' and args[2]=='--config' and args[3]=='devcel.import.json' and args[4]=='--status')
    assert(args[5].reload_resources==false and args[5].out=='capture')
    return '{{"ok":true,"data":{{"sources":[]}}}}\\n'
end}}
local importer=require 'devcel.editor.importer'
assert(importer.status().ok)
json.encode=function(v) if type(v)=='string' then return string.format('%q',v) end;assert(type(v)=='number');return tostring(v) end
local encoded=importer.encode_config({{schema_version=1,sources={{{{id='base',row_include_tags={{}},row_exclude_tags={{'mobile'}},column_include_tags={{}},column_exclude_tags={{}}}}}}}})
assert(encoded:find('"row_include_tags":[]',1,true) and encoded:find('"column_exclude_tags":[]',1,true))
local tags=importer.tag_presets('../日本語 ゲーム/Game.devcelproj.toml');assert(tags[1]=='mobile' and tags[2]=='hidden')
io.open=original_open
print('Editor invokes commands without a version probe')
''')
# Render native editor-script component trees through explicit UI stubs. This checks
# labels, tooltips and cancel behavior, without claiming a native window was opened.
run(f'''local dialogs={{}}
local components={{}}
local function node(kind) return function(props) props._kind=kind; return props end end
editor.ui={{SPACING={{SMALL='small'}},PADDING={{LARGE='large'}},
    component=function(fn) components[#components+1]=fn; return fn end,
    use_state=function(value,...) if type(value)=='function' then value=value(...) end; return value,function() end end,
    horizontal=node('horizontal'),vertical=node('vertical'),label=node('label'),
    button=node('button'),string_field=node('string_field'),select_box=node('select_box'),dialog=node('dialog'),dialog_button=node('dialog_button'),
    show_dialog=function(dialog) dialogs[#dialogs+1]=dialog; return nil end}}
local extension=dofile({quote(str(engine/'devcel/editor/devcel.editor_script'))})
local commands=extension.get_commands()
assert(#commands==5 and commands[1].label=='Devcel: Add source')
assert(commands[2].label=='Devcel: Edit settings' and commands[3].label=='Devcel: Reimport')
assert(commands[4].label=='Devcel: Reimport all' and commands[5].label=='Devcel: Import status')
commands[1].run();assert(#dialogs==1)
local dialog=dialogs[1];assert(dialog.title=='Devcel: Import settings')
assert(dialog.buttons[1].text=='Cancel' and dialog.buttons[2].text=='Save')
local expected={{'Configuration ID','Project','Namespace','Class name','Content Version','JSON output'}}
for i,label in ipairs(expected) do
    local row=dialog.content.children[i+1]
    assert(row.children[1].text==label)
    assert(type(row.children[2].tooltip)=='string' and #row.children[2].tooltip>0)
end
assert(dialog.buttons[2].enabled==false) -- Blank source ID must not be saved.
local zero=components[2]({{source={{id='base',project='../日本語 ゲーム/Game.devcelproj.toml',namespace='Game.Master',version=0}}}})
assert(zero.buttons[2].enabled and zero.buttons[2].result.version==0)
assert(zero.buttons[2].result.runtime_out=='devcel_generated/base.json')
local all=components[2]({{source={{id='base',project='../Game.devcelproj.toml',namespace='Game.Master'}}}})
assert(all.buttons[2].enabled and all.buttons[2].result.version==nil and all.buttons[2].result.class_name==nil)
local filter=require 'devcel.editor.tag_filters'
local changed
local values={{'missing','registered'}}
local props={{index=1,values=values,presets={{'registered','other'}},set=function(v) changed=v end}}
local group=filter.controls(props)
assert(group.children[2].children[2]._kind=='string_field')
assert(group.children[3].children[2]._kind=='select_box')
group.children[2].children[2].on_value_changed('other');assert(changed[1]=='other' and changed[2]=='registered')
props.values=changed;group=filter.controls(props);assert(group.children[2].children[2]._kind=='select_box')
group.children[2].children[3].on_pressed();assert(#changed==1 and changed[1]=='registered')
props.values=changed;group=filter.controls(props);group.children[#group.children].on_value_changed('other');assert(#changed==2 and changed[2]=='other')
props.presets=nil;props.values={{'missing'}};group=filter.controls(props);assert(group.children[2].children[2].enabled==false and props.values[1]=='missing')
local saved=components[2]({{source={{id='x',project='../a.devcelproj.toml',namespace='Game',row_include_tags={{'unknown'}},code_out='keep.lua',future_setting='keep'}}}}).buttons[2].result
assert(saved.row_include_tags[1]=='unknown' and saved.code_out=='keep.lua' and saved.future_setting=='keep')
for _,key in ipairs(filter.keys) do assert(type(saved[key])=='table') end
print('Editor UI labels/defaults and tag preset selection/unknown repair/removal/field preservation checked through stubs')
''')
for path in (engine / 'README.md', engine.parent / 'gamemaker/README.md',
             engine.parents[1] / 'docs/manual/importers/defold.md',
             engine.parents[1] / 'docs/manual/importers/gamemaker.md'):
    if path.exists():
        contents = path.read_text(encoding='utf-8')
        # Keep user-facing terminology aligned with all importer setup screens.
        assert chr(0x539F) + chr(0x672C) not in contents, path
        for old_label in ('ContentVersion',):
            assert old_label not in contents, (path, old_label)

print("PASS: Lua integration and syntax checks; native Defold validation remains separate")
