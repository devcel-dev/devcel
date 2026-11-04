#!/usr/bin/env python3
"""Create an isolated title for the real three-step wizard, metadata and watch workflow."""
import json
import pathlib
import shlex
import shutil
import subprocess
import sys

cli = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(sys.argv[2]).resolve()
subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('prepare_pull_qa.py')), str(cli), str(root)], check=True)
title = root / 'title'
# Keep metadata/wizard fixtures intentionally idle; default Auto is covered by
# auto_server_workflow.py with the actual bundled server lifecycle.
(title / '.devcel/pull-editor.cfg').write_text('[pull]\nsync_modes={"base":"Off","event":"Off"}\n')
config_path = title / '.devcel/devcel.import.json'
config = json.loads(config_path.read_text())
config['sources'][0]['code_out'] = str(title / 'generated/Base.cs')
config['sources'][0]['code_target'] = 'csharp'
config['sources'][1].update({'class_name': None, 'version': None, 'code_target': 'cpp', 'code_out': str(title / 'generated/Event.h')})
config_path.write_text(json.dumps(config, indent=2))
helper = title / 'addons/pull_metadata_qa'
helper.mkdir()
shutil.copy2(pathlib.Path(__file__).with_name('test_pull_metadata_editor.gd'), helper / 'plugin.gd')
(helper / 'plugin.cfg').write_text('[plugin]\nname="Pull metadata QA"\ndescription="Isolated Editor workflow verification"\nauthor="Devcel"\nversion="1"\nscript="plugin.gd"\n')
project = title / 'project.godot'
project.write_text(project.read_text().replace('enabled=PackedStringArray("res://addons/devcel/plugin.cfg")', 'enabled=PackedStringArray("res://addons/devcel/plugin.cfg", "res://addons/pull_metadata_qa/plugin.cfg")'))
for name in ['home', 'cache', 'data', 'config']:
    (root / name).mkdir()
env = ' '.join(f'{key}={shlex.quote(str(root / path))}' for key, path in [('HOME', 'home'), ('XDG_CACHE_HOME', 'cache'), ('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config')])
print(f'{env} godot --headless --editor --path {shlex.quote(str(title))} -- --wizard-clean')
print(f'{env} godot --headless --editor --path {shlex.quote(str(title))}')
print(f'{env} godot --headless --editor --path {shlex.quote(str(title))} -- --metadata-reload')
