#!/usr/bin/env python3
"""Offline focused tests of actual DevcelPaths and DevcelCliRunner; not Unity GUI."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mono', type=Path, required=True)
    parser.add_argument('--csc', type=Path, required=True)
    parser.add_argument('--cli', type=Path, required=True, help='Real current CLI, not a fake executable')
    parser.add_argument('--work-dir', type=Path, required=True, help='New output directory outside the package')
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    package = here.parents[1]
    work = args.work_dir.resolve()
    if work.is_relative_to(package):
        parser.error('Output must remain outside the source package')
    work.mkdir(parents=True, exist_ok=False)
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    sources = [package/'Editor/DevcelPaths.cs', package/'Editor/DevcelCliRunner.cs', here/'Program.cs', here/'UnityApiMocks.cs']
    before = {str(p.relative_to(package)): sha(p) for p in sources}
    cli_hash = sha(args.cli)
    package_data = json.loads((package/'package.json').read_text())
    version = package_data['version']
    assembly = work/'VersionContract.exe'
    compile_command = [str(args.mono), str(args.csc), '/nologo', '/target:exe', '/warnaserror+', '/nowarn:0649', '/define:UNITY_EDITOR_LINUX', '/out:'+str(assembly), '/r:'+str(args.csc.parent/'System.Runtime.Serialization.dll'), *map(str, sources)]
    compiled = subprocess.run(compile_command, capture_output=True, text=True)
    (work/'compile.log').write_text(compiled.stdout+compiled.stderr)
    assert compiled.returncode == 0, compiled.stdout+compiled.stderr
    game = work/'Game'; root = game/'Assets/DevcelUnity'
    (root/'Editor').mkdir(parents=True)
    (root/'Editor/DevcelPaths.cs').write_bytes((package/'Editor/DevcelPaths.cs').read_bytes())
    binary = root/'Tools~/linux-x64/devcel'; binary.parent.mkdir(parents=True)
    shutil.copyfile(args.cli, binary); binary.chmod(0o755)
    manifest = {'schema_version': 1, 'version': version, 'supportedPlatforms': ['linux-x64'], 'binaries': {'linux-x64': {'path': 'linux-x64/devcel', 'sha256': cli_hash}}}
    records = []

    def reset(metadata=None, tool_manifest=None):
        (root/'package.json').write_text(json.dumps(package_data if metadata is None else metadata))
        (root/'Tools~/manifest.json').write_text(json.dumps(manifest if tool_manifest is None else tool_manifest))

    def check(name, action='prepare', ok=True, contains=None, mode='upm', text=None):
        command = [str(args.mono), str(assembly), mode, str(root), str(game), action]
        if text is not None:
            command.append(text)
        started = time.monotonic()
        process = subprocess.run(command, capture_output=True, text=True, timeout=60)
        assert process.returncode == 0, (name, process.stdout, process.stderr)
        result = json.loads(process.stdout)
        record = {'name': name, 'result': result, 'command': command, 'elapsed_seconds': round(time.monotonic()-started, 3)}
        records.append(record)
        (work/'results.json').write_text(json.dumps(records, indent=2)+'\n')
        assert result['ok'] == ok, record
        if contains:
            assert contains in (result['error'] or ''), record
        if ok and action == 'prepare':
            assert Path(result['value']) == binary, record
        print('PASS '+name, flush=True)

    reset()
    check('local/embedded UPM actual package path')
    check('complete package under Assets', mode='assets')
    check('actual CLI pull/watch capability', action='bundled')
    check('actual CLI accepted from Assets', action='bundled', mode='assets')
    changed = copy.deepcopy(manifest); changed['version'] = 'hoge'; reset(tool_manifest=changed)
    check('manifest version is not read')
    for field, value in [('schema_version', 2), ('supportedPlatforms', ['win-x64'])]:
        changed = copy.deepcopy(manifest); changed[field] = value; reset(tool_manifest=changed)
        check('retain '+field+' rejection', ok=False, contains='OS/CPU')
    changed = copy.deepcopy(manifest); changed['binaries']['linux-x64']['sha256'] = '0'*64; reset(tool_manifest=changed)
    check('retain binary SHA-256 rejection', ok=False, contains='SHA256')
    changed = copy.deepcopy(manifest); changed['binaries']['linux-x64']['path'] = '../devcel'; reset(tool_manifest=changed)
    check('retain binary path rejection', ok=False, contains='path/SHA256')

    reset()
    assert sha(args.cli) == cli_hash
    assert before == {str(p.relative_to(package)): sha(p) for p in sources}
    summary = {'passed': len(records), 'source_sha256': before, 'cli_sha256': cli_hash, 'compile_command': compile_command, 'limits': ['Unity APIs are minimal host mocks; actual DevcelPaths and DevcelCliRunner execute.', 'No Unity Editor GUI, serialization, asset import, Play mode, Player build, Windows or macOS verification.']}
    (work/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    print('TOTAL '+str(len(records)))


if __name__ == '__main__':
    main()
