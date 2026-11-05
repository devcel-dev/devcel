#!/usr/bin/env python3
"""Stage executables and importer sources for local development, not redistribution.

No vendoring, release source archives, upstream evidence generation or publication.
Use package-importers.py and package-windows-studio.py for distribution payloads.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import re
from unity_toolchain import fingerprint
import importer_versions

LAYOUTS = {
    'unity': ('devcel-unity', 'Tools~'),
    'godot': ('addons/devcel', 'bin'),
    'unreal': ('Plugins/Devcel', 'Tools'),
    'rpgmaker': ('', 'js/plugins/devcel/bin'),
    'wolf': ('devcel-wolf', 'Tools/bin'),
    'gamemaker': ('devcel-gamemaker', 'tools'),
    'defold': ('', 'devcel/tools'),
    'cocos': ('devcel-cocos', 'bin'),
    'javascript': ('devcel-javascript', 'bin'),
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_revision(repo, explicit=None):
    if explicit is not None:
        commit = explicit
    else:
        message = 'Source archives require --source-commit; an enclosing checkout cannot supply Studio CLI identity'
        if not (repo/'.git').exists():
            raise ValueError(message)
        try:
            top = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', '--show-toplevel'], text=True, stderr=subprocess.PIPE).strip()
            if Path(top).resolve() != repo.resolve():
                raise ValueError(message)
            commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True, stderr=subprocess.PIPE).strip()
        except (OSError, subprocess.CalledProcessError) as error:
            raise ValueError(message) from error
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Studio CLI identity requires a full source commit')
    return commit


def stage(repo, native, out, kind, platform='win-x64', source_commit=None):
    repo, native, out = map(Path, (repo, native, out))
    if platform not in ('win-x64', 'linux-x64'):
        raise ValueError('Unsupported local target')
    cli = native/('devcel.exe' if platform == 'win-x64' else 'devcel')
    runtime = native/('devcel_runtime.dll' if platform == 'win-x64' else 'libdevcel_runtime.so')
    required = [cli, runtime] if kind == 'importers' else [cli, native/('devcel-studio.exe' if platform == 'win-x64' else 'devcel-studio')]
    for path in required:
        if not path.is_file():
            raise FileNotFoundError(path)
    version = json.loads((repo/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
    if kind == 'studio':
        source_commit = source_revision(repo, source_commit)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise ValueError('Local output directory must be empty')
    notices = repo/'third-party/generated/THIRD-PARTY-NOTICES.txt'

    def copy_cli(destination):
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copy2(cli, destination/cli.name)
        shutil.copyfile(repo/'devcel-cli/LICENSE', destination/'LICENSE-CLI.txt')
        # This manifest supports local binary lookup; it is not release evidence.
        manifest = {'schema_version': 1, 'version': version, 'platform': platform,
                    'executable': cli.name, 'sha256': digest(cli)}
        if kind == 'studio':
            manifest['source_commit'] = source_commit
        else:
            manifest.update(supportedPlatforms=[platform],
                            binaries={platform: {'path': platform+'/'+cli.name, 'sha256': digest(cli)}})
        (destination/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')

    if kind == 'studio':
        shutil.copy2(required[1], out/required[1].name)
        copy_cli(out/'bin')
        shutil.copyfile(repo/'devcel-studio/LICENSE', out/'LICENSE-STUDIO.txt')
        shutil.copyfile(repo/'LICENSE-NOTICE', out/'LICENSE-NOTICE')
        (out/'legal').mkdir()
        shutil.copyfile(notices, out/'legal/THIRD-PARTY-NOTICES.txt')
    elif kind == 'importers':
        for engine, (relative, tools) in LAYOUTS.items():
            root = out/f'devcel-{engine}-{version}-{platform}'
            dest = root/relative
            source = repo/'importers'/engine
            if engine == 'godot':
                source /= 'addons/devcel'
            excluded = ['node_modules', '.git', '__pycache__', '.godot', 'Library', 'Temp', 'test-output']
            if engine == 'unity':
                excluded += ['Tools~', 'Plugins']
            elif engine == 'godot':
                excluded += ['bin']
            shutil.copytree(source, dest, ignore=shutil.ignore_patterns(*excluded))
            importer_versions.materialize(repo, engine, dest)
            bundled = dest/tools
            copy_cli(bundled/platform)
            shutil.move(str(bundled/platform/'manifest.json'), bundled/'manifest.json')
            shutil.move(str(bundled/platform/'LICENSE-CLI.txt'), bundled/'LICENSE-CLI-MIT.txt')
            if engine == 'godot':
                (bundled/'.gdignore').touch()
            if engine == 'unity':
                identity = fingerprint(repo)
                folder = 'Windows/x86_64' if platform == 'win-x64' else 'Linux/x86_64'
                plugin = dest/'Plugins'/folder/runtime.name
                plugin.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(runtime, plugin)
                manifest_path = bundled/'manifest.json'
                manifest = json.loads(manifest_path.read_text())
                manifest.update(source_fingerprint=identity, native_runtime={
                    'path': plugin.relative_to(dest).as_posix(), 'sha256': digest(runtime)})
                manifest_path.write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
                metadata = repo/'importers/unity-template/Tools~/NativePluginMetadata'/folder/(runtime.name+'.meta')
                shutil.copyfile(metadata, Path(str(plugin)+'.meta'))
            legal = dest/'ThirdPartyNotices'
            legal.mkdir(exist_ok=True)
            shutil.copyfile(notices, legal/notices.name)
            (root/'LOCAL-BUILD.txt').write_text(
                'Local development output. This folder has no distribution source archive or release verification.\n'
                'For redistribution, use the verified distribution packaging entrypoint.\n', encoding='utf-8')
    else:
        raise ValueError('Unknown local output kind')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=('studio', 'importers'))
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--native-dir', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--platform', choices=('win-x64', 'linux-x64'), default='win-x64')
    parser.add_argument('--source-commit')
    args = parser.parse_args()
    stage(args.repo, args.native_dir, args.out, args.kind, args.platform, args.source_commit)
