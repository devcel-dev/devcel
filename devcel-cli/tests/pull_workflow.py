#!/usr/bin/env python3
"""Integration workflow: real CLI, saved projects, whole bundles, title-owned destinations.
Usage: python3 pull_workflow.py /absolute/devcel /absolute/evidence-directory
"""
import hashlib, json, pathlib, shutil, subprocess, sys
cli = str(pathlib.Path(sys.argv[1]).resolve())
root = pathlib.Path(sys.argv[2]).resolve(); root.mkdir(parents=True, exist_ok=True)
log = []
def run(*args, ok=True):
    process = subprocess.run([cli, *map(str,args)], text=True, capture_output=True, timeout=90)
    result = json.loads(process.stdout)
    log.append({'args':list(map(str,args)), 'exit':process.returncode, 'response':result})
    (root/'commands.json').write_text(json.dumps(log, ensure_ascii=False, indent=2))
    assert bool(result['ok']) == ok and (process.returncode==0) == ok, (args,result,process.stderr)
    return result

def mutate(project, *args): return run('--mode','local','--project',project,*args)['data']
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def save(config): configpath.write_text(json.dumps(config, ensure_ascii=False, indent=2))

a = pathlib.Path(run('init','SourceA','--dir',root)['data']['project_path'])
table = mutate(a,'table','create','Items')['table_uuid']
mutate(a,'column','add','Items','hp','I32')
mutate(a,'column','add','Items','double_hp','I32')
row = '11111111-1111-4111-8111-111111111111'
mutate(a,'record','add','Items','--uuid',row)
mutate(a,'cell','set','Items',row,'hp','7')
mutate(a,'cell','set','Items',row,'double_hp','=hp * 2')
shutil.copytree(a.parent,root/'SourceB')
b=root/'SourceB'/a.name
mutate(b,'cell','set','Items',row,'hp','99')
configpath=root/'devcel.import.json'
config={'schema_version':1,'sources':[
 {'id':'base','project':str(a),'namespace':'Game.Base','runtime_out':str(root/'data/base.json'),'code_out':str(root/'code/Base.cs'),'code_target':'csharp','mode':'full'},
 {'id':'event','project':str(b),'namespace':'Game.Event','runtime_out':str(root/'data/event.json'),'code_out':str(root/'code/Event.cs'),'code_target':'csharp','mode':'minimal'}]}
save(config)
assert all(x['status']=='needs_pull' for x in run('pull','--config',configpath,'--status')['data']['sources'])
state=root/'devcel.import.json.devcel-state.json'
assert not state.exists()
# Initial import must never claim and overwrite an unrelated existing asset.
foreign = root/'data/base.json'; foreign.parent.mkdir(parents=True, exist_ok=True)
foreign.write_text('{"unrelated_asset":true}')
run('pull','--config',configpath,'--source','base',ok=False)
assert foreign.read_text() == '{"unrelated_asset":true}'
assert not (root/'data/base.json.devcel-owner.json').exists()
foreign.unlink()
run('pull','--config',configpath)
assert all(x['status']=='ready' for x in run('pull','--config',configpath,'--status')['data']['sources'])
bundles=[json.loads((root/'data'/f'{id}.json').read_text()) for id in ['base','event']]
assert bundles[0]['tables'][0]['uuid'] == bundles[1]['tables'][0]['uuid']
assert bundles[0]['tables'][0]['records'][0]['values']['double_hp'] == '14'
assert bundles[1]['tables'][0]['records'][0]['values']['double_hp'] == '198'
assert bundles[0]['manifest']['content_hash'] != bundles[1]['manifest']['content_hash']
assert 'namespace Game.Base' in (root/'code/Base.cs').read_text()
assert 'namespace Game.Event' in (root/'code/Event.cs').read_text()
state_before=state.read_bytes()
run('pull','--config',configpath,'--status')
assert state.read_bytes()==state_before
old_base=digest(root/'data/base.json');old_event=digest(root/'data/event.json')
mutate(b,'cell','set','Items',row,'hp','123')
statuses=run('pull','--config',configpath,'--status')['data']['sources']
assert [s['status'] for s in statuses] == ['ready','needs_pull']
run('pull','--config',configpath,'--source','event')
assert digest(root/'data/base.json')==old_base and digest(root/'data/event.json')!=old_event
# Invalid second source keeps its last success; first source can finish independently.
old_event=digest(root/'data/event.json')
source_backup=b.read_bytes();b.write_text('INVALID TOML {{{')
partial=run('pull','--config',configpath,ok=False)['data']['sources']
assert [s['status'] for s in partial]==['pulled','error']
assert digest(root/'data/event.json')==old_event
b.write_bytes(source_backup);run('pull','--config',configpath,'--source','event')
# Configuration-wide conflicts reject all writes, including single-source requests.
for change in ['namespace','runtime_out']:
 bad=json.loads(json.dumps(config));bad['sources'][1][change]=bad['sources'][0][change];save(bad)
 before=digest(root/'data/base.json');run('pull','--config',configpath,'--source','base',ok=False);assert digest(root/'data/base.json')==before
# Source-tree overwrite, including parent-relative aliases, fails before writing.
for out in [str(a.parent/'overwrite.json'),str(root/'data/../SourceA/overwrite.json')]:
 bad=json.loads(json.dumps(config));bad['sources'][0]['runtime_out']=out;save(bad);run('pull','--config',configpath,ok=False)
# Symlink aliases to a source tree cannot bypass protection.
(root/'source-link').symlink_to(a.parent,target_is_directory=True)
bad=json.loads(json.dumps(config));bad['sources'][0]['runtime_out']=str(root/'source-link/overwrite.json');save(bad);run('pull','--config',configpath,ok=False)
# Source files themselves may not alias an external .json destination.
source_table=next((b.parent/'Tables').glob('*.table.toml'))
source_bytes=source_table.read_bytes();external=root/'external-authoring.json';external.write_bytes(source_bytes)
source_table.unlink();source_table.symlink_to(external)
bad=json.loads(json.dumps(config));bad['sources'][1]['runtime_out']=str(external);save(bad)
run('pull','--config',configpath,ok=False);assert external.read_bytes()==source_bytes
source_table.unlink();source_table.write_bytes(source_bytes)
# Ancestor namespaces collide with generated runtime types and must fail early.
bad=json.loads(json.dumps(config));bad['sources'][0]['namespace']='Game';bad['sources'][1]['namespace']='Game.DevcelDatabase';save(bad)
run('pull','--config',configpath,ok=False)
# A second config cannot claim another config's destinations.
save(config);other=root/'other.import.json';other.write_text(configpath.read_text())
run('pull','--config',other,ok=False)
# Output damage marks needs_pull and reimport repairs it.
(root/'data/base.json').write_text('{}')
assert run('pull','--config',configpath,'--status')['data']['sources'][0]['status']=='needs_pull'
run('pull','--config',configpath,'--source','base')
# Code-generation collision fails before runtime replacement.
old_base=digest(root/'data/base.json');old_code=digest(root/'code/Base.cs')
mutate(a,'table','create','Handle')
failed=run('pull','--config',configpath,'--source','base',ok=False)
assert digest(root/'data/base.json')==old_base and digest(root/'code/Base.cs')==old_code
(root/'result.json').write_text(json.dumps({'ok':True,'commands':len(log),'config':str(configpath),'same_uuid_sources':True},indent=2))
print(json.dumps({'ok':True,'commands':len(log),'evidence':str(root)}))
