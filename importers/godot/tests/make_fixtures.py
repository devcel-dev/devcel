#!/usr/bin/env python3
"""Deterministic hand-authored contract fixtures; real CLI E2E is a separate test."""
import json
from pathlib import Path
root = Path(__file__).resolve().parents[1]
curve = json.dumps({'points':[{'x':0,'y':0,'mode':'linear'},{'x':.5,'y':5,'mode':'constant'},{'x':1,'y':10,'mode':'linear'}]},separators=(',',':'))
columns=[
 {'name':'name','data_type':'String','default_value':'名無し'},
 {'name':'hp','data_type':'I32','default_value':'100'},
 {'name':'speed','data_type':'F32','default_value':'1.5'},
 {'name':'active','data_type':'Boolean','default_value':'false'},
 {'name':'wide','data_type':'I64','default_value':'9007199254740993'},
 {'name':'huge','data_type':'U64','default_value':'18446744073709551615'},
 {'name':'color32','data_type':'Color32','default_value':'[18,171,239,0]'},
 {'name':'color_float','data_type':'ColorFloat','default_value':'[-0.25,2.0,0.5,0.0]'},
 {'name':'item','data_type':'Reference','default_value':'item-1','reference_config':{'target_table_uuid':'items-uuid'}},
 {'name':'drops','data_type':'TableRef','default_value':'items-uuid','table_ref_config':{'interface_uuid':'loot-interface'}},
 {'name':'growth','data_type':'Curve','default_value':curve,'curve_config':{'start_value':0,'end_value':10}},
 {'name':'empty_curve','data_type':'Curve','default_value':'','curve_config':{'start_value':2,'end_value':4}},
]
bundle={'manifest':{'schema_version':1,'content_hash':'sample','content_version':1,'data_revision':1,'generated_at':'2026-10-01T00:00:00Z','mode':'full'},'project_name':'Devcel Godot Sample','tables':[
 {'name':'Heroes','uuid':'heroes-uuid','interfaces':[], 'columns':columns,'records':[
   {'id':'hero-1','values':{c['name']:c['default_value'] for c in columns}},
   {'id':'hero-2','values':{c['name']:c['default_value'] for c in columns}}]},
 {'name':'Items','uuid':'items-uuid','interfaces':['loot-interface'],'columns':[{'name':'label','data_type':'String'}],'records':[{'id':'item-1','values':{'label':'回復薬'}}]}
]}
bundle['tables'][0]['records'][0]['values']['name']='勇者'
bundle['tables'][0]['records'][0]['values']['active']='true'
(root/'samples'/'master.full.json').write_text(json.dumps(bundle,ensure_ascii=False,indent=2)+'\n')
minimal=json.loads(json.dumps(bundle));minimal['manifest']['mode']='minimal';minimal['manifest']['content_hash']='sample-minimal'
for t in minimal['tables']:
 for r in t['records']:
  r['values']={c['name']:r['values'][c['name']] for c in t['columns'] if r['values'].get(c['name'])!=c.get('default_value')}
(root/'samples'/'master.minimal.json').write_text(json.dumps(minimal,ensure_ascii=False,indent=2)+'\n')
