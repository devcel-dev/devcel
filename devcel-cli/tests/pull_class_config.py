#!/usr/bin/env python3
"""Real Pull/codegen contract for configurable database owner classes and content versions."""
import copy,json,pathlib,shutil,subprocess,sys,hashlib
cli=str(pathlib.Path(sys.argv[1]).resolve());root=pathlib.Path(sys.argv[2]).resolve();root.mkdir(parents=True,exist_ok=True)
if any(root.iterdir()):raise SystemExit('Use a new empty evidence directory')
commands=[]
def run(*args,ok=True):
 p=subprocess.run([cli,*map(str,args)],text=True,capture_output=True,timeout=90);r=json.loads(p.stdout)
 commands.append({'args':list(map(str,args)),'exit':p.returncode,'response':r});(root/'commands.json').write_text(json.dumps(commands,ensure_ascii=False,indent=2))
 assert r['ok']==ok and (p.returncode==0)==ok,(args,r,p.stderr)
 return r.get('data',r)
source=pathlib.Path(run('init','Database DevcelDatabase project','--dir',root/'authoring')['project_path'])
def edit(*args):return run('--mode','local','--project',source,*args)
table=edit('table','create','DatabaseLog')['table_uuid']
edit('column','add','DatabaseLog','database_key','String')
edit('column','add','DatabaseLog','tag','Select')
edit('column','select-config','DatabaseLog','tag',json.dumps({'options':[{'value':'Database','label':'Database label'},{'value':'DevcelDatabase','label':'DevcelDatabase label'}]}))
edit('interface','create','Empty')
edit('interface','create','Named')
edit('interface','column','add','Named','name','String','--default','Anonymous')
edit('interface','apply','DatabaseLog','Named')
for row,version in [('11111111-1111-4111-8111-111111111111',0),('22222222-2222-4222-8222-222222222222',4294967295)]:
 edit('record','add','DatabaseLog','--uuid',row)
 edit('cell','set','DatabaseLog',row,'database_key','Database DevcelDatabase')
 edit('cell','set','DatabaseLog',row,'tag','Database')
 edit('op',json.dumps({'op':'SetRecordMinVersion','data':{'table_uuid':table,'record_uuid':row,'min_version':str(version)}}))
configpath=root/'devcel.import.json'
base={'schema_version':1,'sources':[
 {'id':'cs','project':str(source),'namespace':'Game.DevcelDatabase','class_name':'MasterData','runtime_out':str(root/'cs.json'),'code_out':str(root/'MasterData.cs'),'code_target':'csharp'},
 {'id':'cpp','project':str(source),'namespace':'Game.Database','class_name':'ContentDb','runtime_out':str(root/'cpp.json'),'code_out':str(root/'ContentDb.h'),'code_target':'cpp'}]}
def pull(config,ok=True,selected=None):configpath.write_text(json.dumps(config,ensure_ascii=False,indent=2));return run('pull','--config',configpath,*(['--source',selected] if selected else []),ok=ok)
def hashes():return {name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['cs.json','cpp.json','MasterData.cs','ContentDb.h']}
pull(base)
cs=(root/'MasterData.cs').read_text();cpp=(root/'ContentDb.h').read_text()
for phrase in ['namespace Game.DevcelDatabase','public sealed class MasterData','WeakReference<global::Game.DevcelDatabase.MasterData>','readonly global::Game.DevcelDatabase.MasterData Database','DevcelTableReference(global::Game.DevcelDatabase.MasterData db','~MasterData()','public sealed class DatabaseLogTable','case "Database"','case "DevcelDatabase"']:
 assert phrase in cs,phrase
for phrase in ['namespace Game::Database','class ContentDb','~ContentDb()','std::optional<::Game::Database::ContentDb>','DatabaseLogTable(const ::Game::Database::ContentDb& db)','class DatabaseLogTable','std::string_view("Database",','std::string_view("DevcelDatabase",']:
 assert phrase in cpp,phrase
# Concrete native parser, exercising owner constructor / move assignment / root factories.
unit=root/'compile.cpp';unit.write_text('#include "ContentDb.h"\n#include <type_traits>\nstatic_assert(!std::is_copy_constructible_v<Game::Database::ContentDb>);\nvoid verify(){auto db=Game::Database::ContentDb::from_json("{}");if(db){auto rows=db->database_log.all();db->reload_if_changed();}}\n')
compiler=shutil.which('g++') or shutil.which('clang++')
assert compiler,'C++ compiler required for this integration test'
compile_results=[]
for standard in ['c++17','c++20']:
 compiled=subprocess.run([compiler,'-std='+standard,'-fsyntax-only',str(unit)],capture_output=True,text=True)
 (root/('cpp-compile-'+standard+'.log')).write_text(compiled.stdout+compiled.stderr);assert compiled.returncode==0,compiled.stderr
 compile_results.append(standard)
# Omitted and null class names preserve old defaults exactly, including low-level exporter output.
for value in ['omitted',None]:
 cfg=copy.deepcopy(base)
 for s in cfg['sources']:
  if value=='omitted':s.pop('class_name')
  else:s['class_name']=None
 pull(cfg)
 assert 'public sealed class DevcelDatabase' in (root/'MasterData.cs').read_text()
 assert 'class Database {' in (root/'ContentDb.h').read_text()
 for standard in ['c++17','c++20']:
  checked=subprocess.run([compiler,'-std='+standard,'-fsyntax-only','-x','c++',str(root/'ContentDb.h')],capture_output=True,text=True);assert checked.returncode==0,checked.stderr
 default_cs=run('--mode','local','--project',source,'export','code','csharp','--namespace','Game.DevcelDatabase')['code']
 assert default_cs==(root/'MasterData.cs').read_text()
# version is content filtering, independently of config schema_version.
version_results=[]
for version,count in [('omitted',2),(None,2),(0,1),(4294967295,2)]:
 cfg=copy.deepcopy(base)
 for s in cfg['sources']:
  if version!='omitted':s['version']=version
 pull(cfg)
 for name in ['cs.json','cpp.json']:
  bundle=json.loads((root/name).read_text());assert len(bundle['tables'][0]['records'])==count
  assert bundle['manifest'].get('content_version') == (None if version=='omitted' else version)
 version_results.append({'version':version,'count':count})
# All rejected class/version settings retain both prior code and prior runtime bytes.
invalid=['',' ','1Data','Bad.Name','Bad::Name','Bad;Name','class','namespace','var','record','dynamic','nint','nuint','_Reserved','Bad__Name',
 'DevcelNative','NativeState','DevcelTableReference','TableReference','DatabaseLogTable','DatabaseLogRow','INamed','DatabaseLogTagValue',
 'IntPtr','TimeSpan','DateTime','DllImportAttribute','MarshalAsAttribute','std','kr_str','devcel_rt_open','UINT64_MAX','INT32_MAX','INT32_C','SIZE_MAX','errno','WEOF','EXIT_SUCCESS','EXIT_FAILURE','MB_CUR_MAX','EIO','EINVAL']
for name in invalid:
 cfg=copy.deepcopy(base);cfg['sources'][0]['class_name']=name;before=hashes();pull(cfg,False,selected='cs');assert hashes()==before,name
for index,names in [(0,['Handle','Open','DatabaseLog']), (1,['state_','open','handle','database_log'])]:
 for name in names:
  cfg=copy.deepcopy(base);cfg['sources'][index]['class_name']=name;before=hashes();pull(cfg,False)
  # Sources publish independently; the failing source itself must retain previous output.
  paths=['cs.json','MasterData.cs'] if index==0 else ['cpp.json','ContentDb.h']
  after=hashes();assert all(before[p]==after[p] for p in paths),name
for version in [-1,4294967296,1.5,'3']:
 cfg=copy.deepcopy(base);cfg['sources'][0]['version']=version;before=hashes();pull(cfg,False);assert hashes()==before
# Cross-source namespace/owner type collision is rejected before generation.
cfg=copy.deepcopy(base);cfg['sources'][0]['namespace']='Game';cfg['sources'][0]['class_name']='MasterData';cfg['sources'][1]['namespace']='Game.MasterData';before=hashes();pull(cfg,False);assert hashes()==before
# A root class cannot shadow a namespace/type used by the C# templates.
cfg=copy.deepcopy(base);cfg['sources'][0]['namespace']='System.Text';cfg['sources'][0]['class_name']='Encoding';before=hashes();pull(cfg,False);after=hashes();assert before['MasterData.cs']==after['MasterData.cs'] and before['cs.json']==after['cs.json']
# Root names matching table fields/methods or factory locals remain valid through absolute type qualification.
for name in ['table_', 'index_generation_', 'col_database_key', 'refresh', 'count', 'checked_handle', 'by_id', 'all', 'h', 'path', 'json', 'other']:
 cfg=copy.deepcopy(base);cfg['sources'][1]['class_name']=name;pull(cfg)
 checked=subprocess.run([compiler,'-std=c++20','-fsyntax-only','-x','c++',str(root/'ContentDb.h')],capture_output=True,text=True)
 assert checked.returncode==0,(name,checked.stderr)
# Same root name in unrelated namespaces is valid.
cfg=copy.deepcopy(base);cfg['sources'][1]['class_name']='MasterData';pull(cfg)
# Leave the reviewable custom outputs/config in their intended final form.
pull(base)
(root/'result.json').write_text(json.dumps({'ok':True,'commands':len(commands),'cpp_compile':compile_results,'csharp_compile':False,'version_filter_results':version_results,'config':str(configpath)},indent=2))
print(json.dumps({'ok':True,'commands':len(commands),'cpp_compile':True,'evidence':str(root)}))
