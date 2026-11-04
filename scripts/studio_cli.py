"""CLI payload shared by Studio portable ZIP, Debian and macOS builds."""
import hashlib
import json
import shutil
import subprocess
import contextlib
import os
from pathlib import Path

DIRECTORY = 'devcel-studio/src-tauri/bundled-cli'


@contextlib.contextmanager
def build_flags(platform):
    """Match the existing standalone importer CLI's static Windows CRT policy."""
    keys = ('RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS')
    original = {key: os.environ.get(key) for key in keys}
    try:
        if platform == 'win-x64':
            os.environ['RUSTFLAGS'] = (os.environ.get('RUSTFLAGS', '')+' -C target-feature=+crt-static').strip()
            if 'CARGO_ENCODED_RUSTFLAGS' in os.environ:
                prefix = os.environ['CARGO_ENCODED_RUSTFLAGS']
                os.environ['CARGO_ENCODED_RUSTFLAGS'] = prefix+('\x1f' if prefix else '')+'-C\x1ftarget-feature=+crt-static'
        yield
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def configure_macos(repo):
    config = json.loads((Path(repo)/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
    os.environ['MACOSX_DEPLOYMENT_TARGET'] = config['bundle']['macOS']['minimumSystemVersion']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(directory, platform, source_commit=None):
    directory = Path(directory)
    executable = 'devcel.exe' if platform == 'win-x64' else 'devcel'
    expected = {executable, 'manifest.json', 'LICENSE-CLI.txt'}
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Missing or linked Studio CLI payload')
    if {p.name for p in directory.iterdir()} != expected:
        raise ValueError('Studio CLI payload differs from explicit allowlist')
    for name in expected:
        if (directory/name).is_symlink() or not (directory/name).is_file():
            raise ValueError('Missing or linked Studio CLI file')
    manifest = json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
    if (set(manifest) != {'schema_version', 'version', 'platform', 'executable', 'sha256', 'source_commit'}
            or manifest['schema_version'] != 1
            or manifest['platform'] != platform or manifest['executable'] != executable
            or manifest['sha256'] != digest(directory/executable)
            or len(manifest['source_commit']) != 40
            or any(c not in '0123456789abcdef' for c in manifest['source_commit'])
            or source_commit is not None and manifest['source_commit'] != source_commit):
        raise ValueError('Studio CLI target/hash/provenance mismatch')
    return manifest


def smoke(directory, platform):
    manifest = validate(directory, platform)
    result = subprocess.run([str((Path(directory)/manifest['executable']).resolve()), 'pull', '--help'],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=15, check=True, text=True, encoding='utf-8')
    if any(argument not in result.stdout for argument in ('--config', '--source', '--status')):
        raise ValueError('Bundled CLI lacks required pull commands')
    return manifest


def stage(repo, target, platform, profile='release', source_commit=None):
    repo, target = Path(repo), Path(target)
    version = json.loads((repo/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
    commit = source_commit or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    destination = repo/DIRECTORY
    if destination.is_symlink():
        raise ValueError('Linked Studio CLI staging directory')
    destination.mkdir(exist_ok=True)
    executable = 'devcel.exe' if platform == 'win-x64' else 'devcel'
    # Do not recursively clean an unexpected staging entry.
    allowed = {'devcel', 'devcel.exe', 'manifest.json', 'LICENSE-CLI.txt'}
    if any(p.name not in allowed or p.is_symlink() or not p.is_file() for p in destination.iterdir()):
        raise ValueError('Unexpected Studio CLI staging entry')
    for path in destination.iterdir():
        path.unlink()
    shutil.copyfile(target/profile/executable, destination/executable)
    (destination/executable).chmod(0o755)
    if platform.startswith('osx-'):
        # Sign before hashing; the resource manifest must describe shipped bytes.
        subprocess.run(['codesign', '--force', '--sign', '-', str(destination/executable)], check=True)
    shutil.copyfile(repo/'devcel-cli/LICENSE', destination/'LICENSE-CLI.txt')
    manifest = {'schema_version': 1, 'version': version, 'platform': platform,
                'executable': executable, 'sha256': digest(destination/executable), 'source_commit': commit}
    (destination/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    config = json.loads((repo/'scripts/tauri-release.conf.json').read_text())
    resources = json.loads((repo/'devcel-studio/src-tauri/tauri.conf.json').read_text())['bundle']['resources']
    config['bundle'] = {'resources': {**resources, 'bundled-cli/': 'bin/'}}
    if platform.startswith('osx-'):
        config['bundle']['macOS'] = {'signingIdentity': '-'}
    path = repo/'devcel-studio/src-tauri/.bundled-cli.conf.json'
    path.write_text(json.dumps(config, indent=2)+'\n', encoding='utf-8')
    return path


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--target-dir', type=Path, required=True)
    parser.add_argument('--platform', choices=['win-x64', 'linux-x64', 'osx-x64', 'osx-arm64'], required=True)
    parser.add_argument('--profile', choices=['release', 'debug'], default='release')
    parser.add_argument('--target')
    parser.add_argument('--source-commit')
    args = parser.parse_args()
    command = ['cargo', 'build', '--locked', '-p', 'devcel-cli']
    if args.profile == 'release':
        command.append('--release')
    if args.target:
        command += ['--target', args.target]
    import release_privacy
    release_privacy.configure(args.repo)
    if args.platform.startswith('osx-'):
        configure_macos(args.repo)
    with build_flags(args.platform):
        subprocess.run(command, cwd=args.repo, check=True)
    print(stage(args.repo, args.target_dir, args.platform, args.profile, args.source_commit))
