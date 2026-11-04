#!/usr/bin/env python3
"""Real CLI WOLF conversion integration. Does not claim native WOLF editor validation.
Usage: python3 verify_export.py /absolute/devcel /new/evidence-directory
"""
import csv, hashlib, json, pathlib, shutil, subprocess, sys
cli=str(pathlib.Path(sys.argv[1]).resolve());root=pathlib.Path(sys.argv[2]).resolve();root.mkdir(parents=True,exist_ok=True)
assert not any(root.iterdir()),'Use a new empty evidence directory'
commands=[]
def run(*args,ok=True):
    process=subprocess.run([cli,*map(str,args)],capture_output=True,text=True,timeout=120)
    result=json.loads(process.stdout);commands.append({'args':list(map(str,args)),'exit':process.returncode,'result':result})
    (root/'commands.json').write_text(json.dumps(commands,ensure_ascii=False,indent=2))
    assert (process.returncode==0)==ok and result['ok']==ok,(args,result,process.stderr)
    return result.get('data')
def edit(project,*args):return run('--mode','local','--project',project,*args)
a=pathlib.Path(run('init','Authoring','--dir',root)['project_path']);table=edit(a,'table','create','Items')['table_uuid']
values={'name':('String',' 日本語,"引用"\n次の行\r\n終端 '),'huge':('U64','18446744073709551615'),'color':('ColorFloat','[-0.25,2,0.5,0]'),'hp':('I32','123'),'active':('Boolean','true')}
for column,(kind,value) in values.items():edit(a,'column','add','Items',column,kind)
row='11111111-1111-4111-8111-111111111111';edit(a,'record','add','Items','--uuid',row)
for column,(kind,value) in values.items():edit(a,'cell','set','Items',row,column,value)
bdir=root/'Copy';shutil.copytree(a.parent,bdir);b=bdir/a.name;edit(b,'cell','set','Items',row,'hp','999')
configpath=root/'devcel.import.json';config={'schema_version':1,'sources':[{'id':'base','project':str(a),'namespace':'Game.Base','class_name':'BaseData','runtime_out':'generated/base.json','mode':'full'},{'id':'event','project':str(b),'namespace':'Game.Event','class_name':'EventData','runtime_out':'generated/event.json','mode':'minimal','version':0}]}
configpath.write_text(json.dumps(config));run('pull','--config',configpath);run('wolf-export','--config',configpath)
def directory(source):return root/'generated'/'wolf'/source
def snapshot(source):return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in directory(source).iterdir()}
def load(source):
    schema=json.loads((directory(source)/'schema.json').read_text());table=schema['tables'][0];csvpath=directory(source)/table['csv']
    assert csvpath.read_bytes().startswith(b'\xef\xbb\xbf')
    with csvpath.open(encoding='utf-8-sig',newline='') as f:rows=list(csv.reader(f))
    assert rows[0]==[column['name'] for column in table['columns']]
    assert rows[1][0]==row and all(column['wolf_type']=='string' for column in table['columns'])
    return schema,dict(zip(rows[0],rows[1]))
schema,base=load('base');_,event=load('event');assert base['hp']=='123' and event['hp']=='999';assert schema['class_name']=='BaseData';assert schema['tables'][0]['table_uuid']==table
for col,(_,value) in values.items():
    if col=='color':assert json.loads(base[col])==json.loads(value)
    else:assert base[col]==value,(col,base[col],value)
assert schema['tables'][0]['contains_multiline_cells']
base_before=snapshot('base');edit(b,'cell','set','Items',row,'hp','77')
# Stale source JSON cannot be converted, and previous CSV is preserved.
event_before=snapshot('event');run('wolf-export','--config',configpath,'--source','event',ok=False);assert snapshot('event')==event_before
run('pull','--config',configpath,'--source','event');run('wolf-export','--config',configpath,'--source','event');assert snapshot('base')==base_before;assert load('event')[1]['hp']=='77'
# A modified generated file is never silently replaced.
readme=directory('base')/'IMPORT.txt';original=readme.read_bytes();readme.write_bytes(original+b'local edit');before=snapshot('base');run('wolf-export','--config',configpath,'--source','base',ok=False);assert snapshot('base')==before;readme.write_bytes(original)
# Unowned destinations, unknown sources and reserved native CSV markers are rejected.
config['sources'][0]['id']='unowned';config['sources'][0]['runtime_out']='generated/unowned.json';configpath.write_text(json.dumps(config));run('pull','--config',configpath,'--source','unowned');unknown=directory('unowned');unknown.mkdir();(unknown/'keep.txt').write_text('mine');run('wolf-export','--config',configpath,'--source','unowned',ok=False);assert (unknown/'keep.txt').read_text()=='mine'
config['sources'][0]['id']='base';config['sources'][0]['runtime_out']='generated/base.json';configpath.write_text(json.dumps(config));run('pull','--config',configpath,'--source','base')
run('wolf-export','--config',configpath,'--source','missing',ok=False)
edit(a,'cell','set','Items',row,'name','<<!--DATANAME--!>>danger');run('pull','--config',configpath,'--source','base');before=snapshot('base');run('wolf-export','--config',configpath,'--source','base',ok=False);assert snapshot('base')==before
edit(a,'cell','set','Items',row,'name',values['name'][1]);run('pull','--config',configpath);run('wolf-export','--config',configpath)
(root/'result.json').write_text(json.dumps({'ok':True,'commands':len(commands),'native_wolf':False,'multiline_csv_roundtrip':True,'source_isolation':True,'owner_protection':True},indent=2))
print(json.dumps({'ok':True,'commands':len(commands),'native_wolf':False,'evidence':str(root)}))
