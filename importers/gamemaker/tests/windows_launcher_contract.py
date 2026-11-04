#!/usr/bin/env python3
"""Static Windows launcher/path contracts for GameMaker and WOLF, NOT native QA.

Python standard library only; never runs PowerShell, cmd.exe, or an executable.
Fixture path normalization models intended drive-absolute/relative arguments;
PowerShell/Windows native quoting and Unicode behavior still require a Windows host.
"""
import json
import ntpath
import pathlib
import re
import sys

if not __debug__:
    raise SystemExit('FAIL: run without Python -O')
gamemaker = pathlib.Path(__file__).resolve().parents[1]
importers = gamemaker.parent
fixture = json.loads((gamemaker / 'tests/fixtures/launcher_paths.json').read_text(encoding='utf-8'))

checks = []
for engine, batch_path, ps_path, root_variable in (
    ('gamemaker', gamemaker / 'importer.cmd', gamemaker / 'importer.ps1', '$Root'),
    ('wolf', importers / 'wolf/StartImporter.cmd', importers / 'wolf/Tools/StartImporter.ps1', '$TitleRoot'),
):
    batch = batch_path.read_text(encoding='utf-8-sig')
    source = ps_path.read_text(encoding='utf-8-sig')
    # .cmd must quote the complete script filename, including %~dp0, as one argument.
    relative_script = 'importer.ps1' if engine == 'gamemaker' else r'Tools\StartImporter.ps1'
    assert f'-File "%~dp0{relative_script}"' in batch, engine
    assert 'Invoke-Expression' not in source and 'iex ' not in source.lower(), engine
    assert re.search(r'^\s*& \$binary importer-ui --engine ' + engine + r' --root ', source, re.M), engine
    assert 'Get-Content -LiteralPath $manifestPath' in source, engine
    assert 'Get-FileHash -LiteralPath $binary' in source or 'Get-FileHash -LiteralPath $binary -Algorithm' in source, engine
    if engine == 'gamemaker':
        assert 'Get-FileHash -LiteralPath $binary -Algorithm SHA256' in source
        assert '([IO.Path]::GetFullPath($Root))' in source
        assert re.search(r'-File "%~dp0importer.ps1"\s+%\*', batch)
        assert 'ExecutionPolicy Bypass' not in batch
    else:
        assert '(Resolve-Path -LiteralPath $TitleRoot).Path' in source
        assert "Join-Path $TitleRoot 'Data'" in source
        assert '--root $TitleRoot' in source
        # WOLF .cmd intentionally opens a folder dialog; explicit paths go to the PS1.
        assert 'FolderBrowserDialog' in source and '$dialog.SelectedPath' in source
    for case in fixture['cases']:
        root = case['root']
        normalized = ntpath.normpath(root if ntpath.isabs(root) else ntpath.join(case['cwd'], root))
        assert normalized == case['expected_root'], (engine, case['name'])
        script_path = ntpath.join(case['sdk'], relative_script)
        expanded_script_argument = '"' + script_path + '"'
        assert expanded_script_argument.startswith('"') and expanded_script_argument.endswith('"')
        assert script_path in expanded_script_argument
        # Each root remains one explicit data argument to the native CLI; no command
        # construction, tokenization, or evaluation of path contents is used in PS1.
        expected_argv = ['importer-ui', '--engine', engine, '--root', normalized]
        assert len(expected_argv) == 5 and expected_argv[-1] == case['expected_root']
        checks.append({'engine': engine, 'case': case['name'], 'expected_argv': expected_argv,
                       'quoted_ps1_path': expanded_script_argument})
    if 'ExecutionPolicy Bypass' in batch:
        print('NOTE: WOLF .cmd currently requests ExecutionPolicy Bypass; reported separately; unchanged by this test', file=sys.stderr)
print(json.dumps({'ok': True, 'scope': 'static-source-and-path-fixtures', 'cases': len(checks),
                  'windows_native': False, 'powershell_executed': False, 'checks': checks},
                 ensure_ascii=False, indent=2))
