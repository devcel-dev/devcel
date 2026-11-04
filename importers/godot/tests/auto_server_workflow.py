#!/usr/bin/env python3
"""Real Godot Editor + bundled CLI integration. No mock CLI or product overrides.
Usage: python3 tests/auto_server_workflow.py /absolute/devcel /absolute/godot NEW_DIR
This driver uses Linux /bin/ps for zombie-child checks. All files stay in NEW_DIR.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

if sys.platform != 'linux':
    raise SystemExit('This integration driver requires Linux for process-lifetime checks')
cli = pathlib.Path(sys.argv[1]).resolve()
godot = pathlib.Path(sys.argv[2]).resolve()
root = pathlib.Path(sys.argv[3]).resolve()
root.mkdir(parents=True, exist_ok=True)
if any(root.iterdir()):
    raise SystemExit('Use a new empty evidence directory')
tests = pathlib.Path(__file__).resolve().parent
results = []


def prepare(name, helper):
    fixture = root / name
    subprocess.run([sys.executable, str(tests / 'prepare_pull_qa.py'), str(cli), str(fixture)], check=True)
    title = fixture / 'title'
    config_file = title / '.devcel/devcel.import.json'
    config = json.loads(config_file.read_text())
    config['sources'][0].update(code_target='csharp', code_out=str(title / 'generated/Base.cs'), class_name='BaseData', version=0)
    config['sources'][1].update(code_target='cpp', code_out=str(title / 'generated/Event.h'), class_name='EventData', version=4294967295)
    config_file.write_text(json.dumps(config, indent=2))
    addon = title / 'addons/auto_qa'
    addon.mkdir()
    shutil.copy2(tests / helper, addon / 'plugin.gd')
    (addon / 'plugin.cfg').write_text('[plugin]\nname="Auto server integration"\ndescription="Real Editor + bundled CLI"\nauthor="Devcel"\nversion="1"\nscript="plugin.gd"\n')
    project = title / 'project.godot'
    project.write_text(project.read_text().replace('enabled=PackedStringArray("res://addons/devcel/plugin.cfg")', 'enabled=PackedStringArray("res://addons/devcel/plugin.cfg", "res://addons/auto_qa/plugin.cfg")'))
    env = os.environ.copy()
    for variable, directory in [('HOME', 'home'), ('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache')]:
        (fixture / directory).mkdir()
        env[variable] = str(fixture / directory)
    return fixture, title, env, config


def editor(fixture, title, env, name, argument=''):
    with (fixture / (name + '.log')).open('w') as log:
        subprocess.run([str(godot), '--headless', '--editor', '--path', str(title), '--', argument], env=env, stdout=log, stderr=subprocess.STDOUT, timeout=600, check=True)
    text = (fixture / (name + '.log')).read_text()
    if 'SCRIPT ERROR:' in text or '\nERROR:' in text:
        raise AssertionError('Godot reported errors: ' + str(fixture / (name + '.log')))


def record(title, filename, name):
    result = json.loads((title / filename).read_text())
    result['name'] = name
    results.append(result)
    print(json.dumps(result), flush=True)
    assert result['ok'], result


fixture, title, env, _ = prepare('automatic', 'test_auto_server_editor.gd')
editor(fixture, title, env, 'editor')
record(title, 'auto-result.json', 'automatic-and-20-mode-cycles')
editor(fixture, title, env, 'reload', '--auto-reload')
record(title, 'auto-reload-result.json', 'saved-off-restart')
fixture, title, env, _ = prepare('schema-version', 'test_auto_server_schema_editor.gd')
editor(fixture, title, env, 'editor')
record(title, 'schema-version-result.json', 'schema-and-version-regeneration')
for mode in ['disable', 'exit', 'crash']:
    fixture, title, env, config = prepare('lifecycle-' + mode, 'test_auto_server_lifecycle_editor.gd')
    with (fixture / 'editor.log').open('w') as log:
        process = subprocess.Popen([str(godot), '--headless', '--editor', '--path', str(title), '--', '--' + mode], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and process.poll() is None and not (title / 'lifecycle-ready.json').exists():
                time.sleep(0.1)
            assert (title / 'lifecycle-ready.json').exists(), (mode, 'Editor did not connect both sources')
            if mode == 'crash':
                process.kill()  # This Popen object owns this exact disposable Editor child.
            process.wait(timeout=20)
            assert mode == 'crash' or process.returncode == 0, (mode, process.returncode)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    # CLI shared-server idle grace is five seconds. Do not poll status during grace.
    time.sleep(7)
    statuses = []
    for source in config['sources']:
        status = subprocess.run([str(cli), '--project', source['project'], 'status'], env=env, capture_output=True, text=True, check=True)
        statuses.append(json.loads(status.stdout)['data']['server_running'])
    result = {'name': 'lifecycle-' + mode, 'servers_running': statuses, 'ok': not any(statuses)}
    if mode == 'disable':
        result.update(json.loads((title / 'lifecycle-disabled.json').read_text()))
        result['ok'] = result['ok'] and result['no_zombies'] and result['plugin_removed']
    results.append(result)
    print(json.dumps(result), flush=True)
    assert result['ok'], result
(root / 'results.json').write_text(json.dumps(results, indent=2))
print('Godot automatic-server integration passed:', root / 'results.json')
