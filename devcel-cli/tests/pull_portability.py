#!/usr/bin/env python3
"""Real CLI + local Git clone portability/safety workflow. Use a new empty directory."""
import hashlib, json, pathlib, shutil, subprocess, sys
cli = str(pathlib.Path(sys.argv[1]).resolve())
root = pathlib.Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=True)
assert not any(root.iterdir()), 'Use a new empty evidence directory'
repo = root / 'original'; repo.mkdir()
cwd = root / 'unrelated-cwd'; cwd.mkdir()
log = []
def run(*args, ok=True):
    result = subprocess.run([cli, *map(str,args)], cwd=cwd, capture_output=True, text=True, timeout=90)
    payload = json.loads(result.stdout)
    log.append({'args': list(map(str,args)), 'exit': result.returncode, 'response': payload})
    (root/'commands.json').write_text(json.dumps(log, ensure_ascii=False, indent=2))
    assert payload['ok'] == ok and (result.returncode == 0) == ok, payload
    return payload.get('data', {})
def git(*args, at=repo):
    return subprocess.check_output(['git', '-C', str(at), *args], stderr=subprocess.STDOUT, text=True)
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
project = pathlib.Path(run('init','Base','--dir',repo/'authoring')['project_path'])
def edit(path,*args): return run('--mode','local','--project',path,*args)
edit(project,'table','create','Items'); edit(project,'column','add','Items','hp','I32')
row = '11111111-1111-4111-8111-111111111111'
edit(project,'record','add','Items','--uuid',row); edit(project,'cell','set','Items',row,'hp','7')
title = repo/'title'; configpath = title/'.devcel/devcel.import.json'; configpath.parent.mkdir(parents=True)
config = {'schema_version':1, 'sources':[{'id':'base', 'project':'../../authoring/Base/'+project.name, 'namespace':'Game.Base', 'class_name':'BaseData', 'version':0, 'runtime_out':'../data/base.json','code_out':'../generated/Base.cs','code_target':'csharp','mode':'full'}]}
configpath.write_text(json.dumps(config, indent=2)); configbytes=configpath.read_bytes()
# Real addon ignore rules must keep the one shared config and drop local caches.
shutil.copyfile(pathlib.Path(__file__).resolve().parents[2]/'importers/godot/.gitignore', title/'.gitignore')
(title/'.devcel/pull-editor.cfg').write_text('[pull]\ncli="/machine-only/devcel"\n')
run('pull','--config',configpath)
assert run('pull','--config',configpath,'--status')['sources'][0]['status']=='ready'
original_bundle=json.loads((title/'data/base.json').read_text())
git('init','-q'); git('add','.'); git('-c','user.name=Portability QA','-c','user.email=qa@example.invalid','commit','-qm','fixture')
tracked=git('ls-files').splitlines()
assert 'title/.devcel/devcel.import.json' in tracked
assert not any(x.endswith(('.devcel-owner.json','.devcel-state.json','.devcel-lock','pull-editor.cfg')) for x in tracked), tracked
clone=root/'another-machine/checkout'; clone.parent.mkdir()
git('clone','-q',str(repo),str(clone),at=root)
# Remove original from the resolution path, so accidental absolute references fail.
repo.rename(root/'original-hidden')
configpath=clone/'title/.devcel/devcel.import.json'; title=clone/'title'; project=clone/'authoring/Base'/project.name
assert configpath.read_bytes()==configbytes
assert run('pull','--config',configpath,'--status')['sources'][0]['status']=='needs_pull'
run('pull','--config',configpath)
assert run('pull','--config',configpath,'--status')['sources'][0]['status']=='ready'
clone_bundle=json.loads((title/'data/base.json').read_text())
assert clone_bundle['tables']==original_bundle['tables']
assert clone_bundle['manifest']['content_hash']==original_bundle['manifest']['content_hash']
assert 'class BaseData' in (title/'generated/Base.cs').read_text()
edit(project,'cell','set','Items',row,'hp','19')
assert run('pull','--config',configpath,'--status')['sources'][0]['status']=='needs_pull'
run('pull','--config',configpath,'--source','base')
assert json.loads((title/'data/base.json').read_text())['tables'][0]['records'][0]['values']['hp']=='19'
# Directory symlink followed by .. must resolve physically before source protection.
(project.parent/'nested').mkdir()
(title/'alias').symlink_to(project.parent/'nested',target_is_directory=True)
bad=json.loads(json.dumps(config)); bad['sources'][0]['runtime_out']='../alias/../overwrite.json'
configpath.write_text(json.dumps(bad)); before=digest(title/'data/base.json')
run('pull','--config',configpath,ok=False)
assert not (project.parent/'overwrite.json').exists()
assert digest(title/'data/base.json')==before
(title/'alias').unlink(); configpath.write_bytes(configbytes)
run('pull','--config',configpath)
assert run('pull','--config',configpath,'--status')['sources'][0]['status']=='ready'
(root/'result.json').write_text(json.dumps({'ok':True,'tracked':tracked,'clone':str(clone),'config_unchanged':configpath.read_bytes()==configbytes},indent=2))
print('PASS: Git clone, unrelated cwd, relative source/output, re-Pull, local cache exclusion, symlink/parent safety')
