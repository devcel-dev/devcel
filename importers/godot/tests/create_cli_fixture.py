#!/usr/bin/env python3
"""Create a dedicated project with the real Devcel CLI and generate full, minimal, and versioned bundles."""
import json, pathlib, subprocess, sys, time, tomllib
ROOT=pathlib.Path(__file__).resolve().parents[1]
CLI=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT.parent/'target/debug/devcel'
OUT=ROOT/'test-output'/'実 CLI project'/f'run-{time.time_ns()}'
OUT.mkdir(parents=True)
LOG=[];PROJECT=None

def run(*args, expect_ok=True):
    cmd=[str(CLI),'--mode','local']+(['--project',str(PROJECT)] if PROJECT else [])+list(args)
    p=subprocess.run(cmd,text=True,capture_output=True,timeout=30)
    LOG.append({'args':list(args),'exit_code':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
    (OUT/'cli-commands.json').write_text(json.dumps(LOG,ensure_ascii=False,indent=2))
    try: result=json.loads(p.stdout)
    except Exception as e: raise AssertionError(f'CLI stdout is not one JSON object: {args}\n{p.stdout}\n{p.stderr}') from e
    assert isinstance(result,dict) and isinstance(result.get('ok'),bool),result
    if expect_ok: assert p.returncode==0 and result['ok'],(args,result,p.stderr)
    else: assert p.returncode!=0 and not result['ok'],(args,result)
    return result.get('data',result)

def op(name,**data): return run('op',json.dumps({'op':name,'data':data},ensure_ascii=False))

PROJECT=pathlib.Path(run('init','godot_roundtrip','--dir',str(OUT))['project_path'])
heroes=run('table','create','Heroes')['table_uuid'];items=run('table','create','Items')['table_uuid']
run('interface','create','Named')
run('interface','column','add','Named','label','String','--default','回復薬')
interface_uuid=tomllib.loads((PROJECT.parent/'Tables/Named.interface.toml').read_text())['uuid']
run('interface','create','Loot')
direct_interface_uuid=tomllib.loads((PROJECT.parent/'Tables/Loot.interface.toml').read_text())['uuid']
run('interface','extends','Loot',interface_uuid)
run('interface','apply','Items','Loot')
interfaces=run('interface','list')
# Items directly implements Loot, while TableRef below requires its parent Named.
columns=[('name','String','無名'),('hp','I32','100'),('active','Boolean','true'),('wide','I64','9007199254740993'),('huge','U64','18446744073709551615'),('computed','I32','=1+2'),('color32','Color32','[18,171,239,0]'),('color_float','ColorFloat','[-0.25,2.0,0.5,0.0]'),('item','Reference',''),('drops','TableRef',items),('growth','Curve','')]
for name,kind,default in columns:
    run('column','add','Heroes',name,kind)
    if default:op('SetColumnDefaultValue',table_uuid=heroes,column_name=name,default_value=default)
op('SetColumnReferenceConfig',table_uuid=heroes,column_name='item',target_table_uuid=items,display_column_name='label')
hero1='11111111-1111-4111-8111-111111111111';hero3='33333333-3333-4333-8333-333333333333'
item1='22222222-2222-4222-8222-222222222222';item3='44444444-4444-4444-8444-444444444444'
for table,uuid,table_uuid,version in [('Heroes',hero1,heroes,1),('Heroes',hero3,heroes,3),('Items',item1,items,1),('Items',item3,items,3)]:
    run('record','add',table,'--uuid',uuid)
    op('SetRecordMinVersion',table_uuid=table_uuid,record_uuid=uuid,min_version=str(version))
run('cell','set','Heroes',hero1,'name','実CLIの勇者')
run('cell','set','Heroes',hero1,'item',item1)
run('cell','set','Heroes',hero3,'item',item3)
curve={'points':[{'x':0,'y':2,'mode':'linear'},{'x':.5,'y':6,'mode':'constant'},{'x':1,'y':8,'mode':'linear'}]}
curve_text=json.dumps(curve,separators=(',',':'))
op('SetColumnDefaultValue',table_uuid=heroes,column_name='growth',default_value=curve_text)
# Exercise the public configuration operations; no private TOML mutation is needed.
run('column','curve-config','Heroes','growth','--start','2','--end','8')
run('column','table-ref-config','Heroes','drops','Named')
for label,flags in [('full-v1',['--version','1']),('minimal-v1',['--minimal','--version','1']),('full-v3',['--version','3']),('all',[])]:
    run('export','runtime',*flags,'--out',str(OUT/f'{label}.json'))
run('export','code','csharp','--out',str(OUT/'Devcel.cs'))
run('export','code','cpp','--out',str(OUT/'Devcel.h'))
run('table','get','MissingTable',expect_ok=False)
manifest={'project':str(PROJECT),'directory':str(OUT),'heroes_uuid':heroes,'items_uuid':items,'interface_uuid':interface_uuid,'direct_interface_uuid':direct_interface_uuid,'hero1':hero1,'hero3':hero3,'item1':item1,'item3':item3,'command_count':len(LOG)}
(ROOT/'test-output/cli-current.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print(json.dumps({'ok':True,'commands':len(LOG),'manifest':manifest},ensure_ascii=False))
