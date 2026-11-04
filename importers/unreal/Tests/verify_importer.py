#!/usr/bin/env python3
"""UE importer source-contract checks plus real CLI workflow. This does NOT compile or run Unreal.
Run: python3 importers/unreal/Tests/verify_importer.py --static-only
     python3 importers/unreal/Tests/verify_importer.py --cli /path/devcel --out /new/empty/evidence
"""
import argparse, copy, hashlib, json, os, pathlib, re, shutil, subprocess
PLUGIN = pathlib.Path(__file__).resolve().parents[1]

def source_checks():
    plugin = json.loads((PLUGIN / 'Devcel.uplugin').read_text())
    assert {(x['Name'], x['Type']) for x in plugin['Modules']} == {('DevcelRuntime', 'Runtime'), ('DevcelEditor', 'Editor')}
    runtime = (PLUGIN / 'Source/DevcelRuntime/Private/DevcelDataAsset.cpp').read_text()
    editor = (PLUGIN / 'Source/DevcelEditor/Private/DevcelImporter.cpp').read_text()
    header = (PLUGIN / 'Source/DevcelRuntime/Public/DevcelDataAsset.h').read_text()
    assert 'UnrealEd' not in (PLUGIN / 'Source/DevcelRuntime/DevcelRuntime.Build.cs').read_text()
    assert '#include "DevcelDataAsset.generated.h"' in header
    for method in ['ReplaceJson', 'ResolveReference', 'ResolveTableReference', 'SampleCurve', 'GetUnsignedInteger']:
        assert method in header and 'UDevcelDataAsset::' + method in runtime
    assert runtime.index('if (!Parse(Json, Candidate, Error)) return false;') < runtime.index('CanonicalJson = Json; Snapshot = MoveTemp(Candidate);')
    for guard in ['pull-config-save --config', 'AtomicReplace(Filename, Temporary)', 'Asset->ImportOwner != Owner',
                  'CurrentSettings != StartConfigText', 'GetSHA256Signature', 'Process->Cancel(true)', 'PendingSource', 'RestoreAfterFailedSave(OldJson, OldRevision)']:
        assert guard in editor, guard
    assert editor.index('if (!Saved)') < editor.index('Asset->NotifyReloaded()')
    assert 'ExecProcess' not in editor and 'system(' not in editor
    sample = json.loads((PLUGIN / 'Tests/fixtures/master.full.json').read_text())
    values = sample['tables'][0]['records'][0]['values']
    assert int(values['wide']) == 9007199254740993 and int(values['huge']) == 18446744073709551615
    assert json.loads(values['color_float']) == [-.25, 2, .5, 0]
    # Lexical delimiter balance is a static check, never a substitute for UHT/UBT.
    for path in (PLUGIN / 'Source').rglob('*'):
        if path.suffix not in ('.cpp', '.h', '.cs'): continue
        text = path.read_text()
        text = re.sub(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'', '', text, flags=re.S)
        stack = []
        for char in text:
            if char in '([{': stack.append(char)
            elif char in ')]}': assert stack and stack.pop() == {')':'(', ']':'[', '}':'{'}[char], path
        assert not stack, path
    return {'descriptor': True, 'source_contracts': True, 'fixture': True, 'native_unreal_run': False}

def workflow(cli, root):
    root.mkdir(parents=True, exist_ok=True)
    assert not any(root.iterdir()), 'Use a new empty evidence directory.'
    log = []
    def run(*args, ok=True):
        p = subprocess.run([str(cli), *map(str,args)], cwd=root, capture_output=True, text=True, timeout=120)
        obj = json.loads(p.stdout)
        log.append({'args': list(map(str,args)), 'exit': p.returncode, 'response': obj, 'stderr': p.stderr})
        (root/'commands.json').write_text(json.dumps(log, ensure_ascii=False, indent=2))
        assert (p.returncode == 0) == ok and obj['ok'] == ok, (args, obj, p.stderr)
        return obj.get('data', obj)
    project = pathlib.Path(run('init', 'UE Source', '--dir', root/'authoring')['project_path'])
    def edit(path, *args): return run('--mode','local','--project',path,*args)
    table = edit(project, 'table','create','Heroes')['table_uuid']
    for name, kind, default in [('wide','I64','9007199254740993'),('huge','U64','18446744073709551615'),
                                 ('color32','Color32','[18,171,239,0]'),('hdr','ColorFloat','[-0.25,2.0,0.5,0.0]'),('hp','I32','7')]:
        edit(project, 'column','add','Heroes',name,kind)
        edit(project, 'op', json.dumps({'op':'SetColumnDefaultValue','data':{'table_uuid':table,'column_name':name,'default_value':default}}))
    early = '11111111-1111-4111-8111-111111111111'
    late = '22222222-2222-4222-8222-222222222222'
    for row, version in [(early,0),(late,4)]:
        edit(project,'record','add','Heroes','--uuid',row)
        edit(project,'op',json.dumps({'op':'SetRecordMinVersion','data':{'table_uuid':table,'record_uuid':row,'min_version':str(version)}}))
    shutil.copytree(project.parent, root/'copied-authoring'); other = root/'copied-authoring'/project.name
    edit(other, 'cell','set','Heroes',early,'hp','99')
    configpath = root/'title/Config/Devcel.import.json'; configpath.parent.mkdir(parents=True)
    config = {'schema_version':1,'sources':[
        {'id':'base','project':os.path.relpath(project,configpath.parent),'namespace':'Game.Base','class_name':'BaseData','runtime_out':'../Intermediate/Devcel/base/master.json','mode':'full','version':0},
        {'id':'event','project':os.path.relpath(other,configpath.parent),'namespace':'Game.Event','class_name':'EventData','runtime_out':'../Intermediate/Devcel/event/master.json','mode':'minimal'}]}
    candidate = root/'candidate.json'
    def save(value, ok=True):
        candidate.write_text(json.dumps(value,ensure_ascii=False,indent=2))
        result = run('pull-config-save','--config',configpath,'--input',candidate,ok=ok)
        if ok: assert result['saved'] is True
    save(config)
    assert json.loads(configpath.read_text())['sources'][0]['version'] == 0
    run('pull','--config',configpath)
    base = root/'title/Intermediate/Devcel/base/master.json'; event = root/'title/Intermediate/Devcel/event/master.json'
    a,b = json.loads(base.read_text()), json.loads(event.read_text())
    assert a['tables'][0]['uuid'] == b['tables'][0]['uuid'] and len(a['tables'][0]['records']) == 1 and len(b['tables'][0]['records']) == 2
    v=a['tables'][0]['records'][0]['values']
    assert v['wide']=='9007199254740993' and v['huge']=='18446744073709551615' and json.loads(v['hdr']) == [-.25,2,.5,0]
    base_before=base.read_bytes(); event_before=event.read_bytes()
    edit(other,'cell','set','Heroes',early,'hp','123')
    run('pull','--config',configpath,'--source','event')
    assert base.read_bytes()==base_before and event.read_bytes()!=event_before
    previous=configpath.read_bytes(); bad=copy.deepcopy(config); bad['sources'][1]['namespace']='Game.Base'
    save(bad,ok=False); assert configpath.read_bytes()==previous and base.read_bytes()==base_before
    bad=copy.deepcopy(config); bad['sources'][0]['version']=4294967296
    save(bad,ok=False); assert configpath.read_bytes()==previous
    backup=project.read_bytes(); project.write_text('not valid TOML {{')
    run('pull','--config',configpath,'--source','base',ok=False); assert base.read_bytes()==base_before
    project.write_bytes(backup); run('pull','--config',configpath,'--source','base')
    assert all(s['status']=='ready' for s in run('pull','--config',configpath,'--status')['sources'])
    result={'ok':True,'commands':len(log),'source_checks':source_checks(),'cli_workflow':True,'native_unreal_run':False}
    (root/'result.json').write_text(json.dumps(result,indent=2)); return result

if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--static-only',action='store_true'); parser.add_argument('--cli',type=pathlib.Path);parser.add_argument('--out',type=pathlib.Path)
    args=parser.parse_args()
    if args.static_only: print(json.dumps(source_checks(),indent=2))
    else:
        if not args.cli or not args.out: parser.error('Provide --cli and --out, or --static-only.')
        print(json.dumps(workflow(args.cli.resolve(),args.out.resolve()),indent=2))
