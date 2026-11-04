#!/usr/bin/env python3
"""Repeat GameMaker fixture/lexical checks and the isolated POSIX launcher workflow.

Python standard library only. This does NOT compile or execute GML. The launcher
uses a temporary fake CLI, never a user project or installed Devcel executable.
Exit 0 = all requested checks passed; 1 = failed; 77 = launcher unavailable.
Use --require-launcher to make unavailable launcher coverage fail CI, or explicitly
--static-only for the portable fixture/lexical subset (prints that scope).
"""
import argparse
import hashlib
import json
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import tempfile

if not __debug__:
    raise SystemExit('FAIL: run without Python -O; assertions must remain enabled')
parser = argparse.ArgumentParser(description=__doc__)
group = parser.add_mutually_exclusive_group()
group.add_argument('--static-only', action='store_true')
group.add_argument('--require-launcher', action='store_true')
args = parser.parse_args()
engine = pathlib.Path(__file__).resolve().parents[1]
CURRENT_VERSION = json.loads((engine.parents[1]/'devcel-studio/package.json').read_text(encoding='utf-8'))['version']

def load_json(path):
    return json.loads(path.read_text(encoding='utf-8'))

def expand(bundle):
    return {
        (table['uuid'], row['id'], column['name']):
        row['values'].get(column['name'], column.get('default_value', ''))
        for table in bundle['tables'] for row in table['records']
        for column in table['columns']
    }

full = load_json(engine / 'samples/master.full.json')
minimal = load_json(engine / 'samples/master.minimal.json')
assert full['manifest']['schema_version'] == minimal['manifest']['schema_version'] == 1
assert expand(full) == expand(minimal)
invalid = load_json(engine / 'samples/master.invalid-column.json')
unknown = [
    key for table in invalid['tables'] for row in table['records']
    for key in row['values'] if key not in {col['name'] for col in table['columns']}
]
assert unknown == ['undefined_column']
print('PASS: canonical full/minimal parity and unknown-column regression fixture')

runtime = engine / 'scripts/DevcelRuntime/DevcelRuntime.gml'
source = runtime.read_text(encoding='utf-8')
# Lexical delimiter check only; deliberately not presented as compiler coverage.
pattern = re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[{}()\[\]]')
stack = []
for match in pattern.finditer(source):
    token = match.group()
    if token[0] in '"\'' or token.startswith('//') or token.startswith('/*'):
        continue
    if token in '({[':
        stack.append(token)
    else:
        assert stack and stack.pop() == {')': '(', ']': '[', '}': '{'}[token], match.start()
assert not stack
functions = re.findall(r'^function\s+(\w+)\s*\(', source, re.M)
assert len(functions) == len(set(functions))
assert '__devcel_loopback_url(_url)' in source
assert '__snapshot = _candidate' in source
assert 'variable_struct_exists(_t.columns,_keys[_k])' in source
assert load_json(runtime.with_suffix('.yy'))['name'] == 'DevcelRuntime'
smoke = (engine / 'samples/runtime-smoke.gml').read_text(encoding='utf-8')
assert 'master.invalid-column.json' in smoke and 'Unknown-column keeps active snapshot' in smoke
print('PASS: GML lexical structure and YY metadata; native compilation NOT RUN')
if args.static_only:
    print('PASS: requested static-only scope; POSIX/PowerShell/native engine checks NOT RUN')
    sys.exit(0)

host = (platform.system(), platform.machine())
rids = {('Linux', 'x86_64'): 'linux-x64', ('Darwin', 'x86_64'): 'osx-x64',
        ('Darwin', 'arm64'): 'osx-arm64'}
rid = rids.get(host)
required = ['sh', 'uname', 'sed', 'grep', 'chmod', 'dirname',
            'shasum' if host[0] == 'Darwin' else 'sha256sum']
missing = [command for command in required if not shutil.which(command)]
if not rid or missing:
    print(('FAIL' if args.require_launcher else 'SKIP') +
          f': POSIX launcher coverage unavailable for {host}; missing tools: {missing}')
    sys.exit(1 if args.require_launcher else 77)
subprocess.run(['sh', '-n', str(engine / 'importer.sh')], check=True)
with tempfile.TemporaryDirectory(prefix='devcel-launcher ') as temporary:
    root = pathlib.Path(temporary)
    sdk = root / '日本語 SDK [検証] & spaces'
    (sdk / 'tools' / rid).mkdir(parents=True)
    binary = sdk / 'tools' / rid / 'devcel'
    binary.write_text('#!/bin/sh\n[ "$1" != --version ] || exit 1\nprintf "%s\\n" "$@"\n', encoding='utf-8')
    binary.chmod(0o644)
    manifest = {'schema_version': 1, 'version': CURRENT_VERSION, 'supportedPlatforms': [rid],
                'binaries': {rid: {'path': rid + '/devcel',
                                  'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}}}
    (sdk / 'tools/manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    shutil.copyfile(engine / 'importer.sh', sdk / 'importer.sh')
    game = root / '日本語 ゲーム [01] & spaces'
    game.mkdir()
    # Unrelated cwd proves the SDK itself is located relative to its launcher.
    command = ['sh', str(sdk / 'importer.sh'), str(game)]
    result = subprocess.run(command, cwd='/', capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert result.stdout.splitlines() == ['importer-ui', '--engine', 'gamemaker', '--root', str(game)]
    assert binary.stat().st_mode & 0o100
    # Relative title paths are passed as one argument with the caller's cwd intact.
    for relative_root in ('./' + game.name, './仮の 階層/../' + game.name):
        (root / '仮の 階層').mkdir(exist_ok=True)
        result = subprocess.run(['sh', str(sdk / 'importer.sh'), relative_root], cwd=root,
                                capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, (result.stdout, result.stderr)
        assert result.stdout.splitlines() == ['importer-ui', '--engine', 'gamemaker', '--root', relative_root]
    # Omitted root uses the caller's current directory, including non-ASCII/spaces.
    result = subprocess.run(['sh', str(sdk / 'importer.sh')], cwd=game,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert result.stdout.splitlines() == ['importer-ui', '--engine', 'gamemaker', '--root', str(game)]
    binary.write_text(binary.read_text(encoding='utf-8') + '# altered\n', encoding='utf-8')
    binary.chmod(0o644)
    result = subprocess.run(command, capture_output=True, text=True, timeout=20)
    assert result.returncode != 0 and 'checksum mismatch' in result.stderr
    assert not binary.stat().st_mode & 0o100  # Never chmod an unverified binary.
print('PASS: POSIX launcher Japanese/spaces/metacharacters/relative-root/default-root/cwd/argv/hash gate/execute-bit repair')
print('PowerShell and GameMaker native engine checks NOT RUN; use documented native smoke workflow')
