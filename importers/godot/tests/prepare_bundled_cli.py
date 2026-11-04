#!/usr/bin/env python3
"""Place a QA executable in an isolated title's actual bundled layout, never an override."""
import hashlib
import json
import pathlib
import platform
import shutil
import sys


def install_bundled_cli(cli, title):
    cli, title = pathlib.Path(cli).resolve(), pathlib.Path(title).resolve()
    system = {'Linux': 'linux', 'Darwin': 'osx', 'Windows': 'win'}[platform.system()]
    architecture = {'x86_64': 'x64', 'amd64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine().lower()]
    target = f'{system}-{architecture}'
    filename = 'devcel.exe' if system == 'win' else 'devcel'
    bin_root = title / 'addons/devcel/bin'
    executable = bin_root / target / filename
    executable.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(cli, executable)
    executable.chmod(executable.stat().st_mode | 0o100)
    manifest = {'schema_version': 1, 'version': json.loads((pathlib.Path(__file__).resolve().parents[3]/'devcel-studio/package.json').read_text(encoding='utf-8'))['version'], 'supportedPlatforms': [target],
                'binaries': {target: {'path': f'{target}/{filename}', 'sha256': hashlib.sha256(executable.read_bytes()).hexdigest()}}}
    (bin_root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return executable


if __name__ == '__main__':
    print(install_bundled_cli(sys.argv[1], sys.argv[2]))
