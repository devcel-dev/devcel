"""Assemble one complete Git-installable Unity package without publishing refs.

Four native desktop ZIPs and Android, iOS and WebGL artifacts must share a source identity.
The generated package is added to a release commit before its normal v<version> tag.
No network, remote push, or source branch modification occurs here.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import posixpath
import shutil
import subprocess
import tempfile
import zipfile
from urllib.parse import unquote, urlsplit

import unity_mobile
import unity_upm

RIDS = ('win-x64', 'linux-x64', 'osx-x64', 'osx-arm64')
MAX_BLOB = 100 * 1024 * 1024
MAX_PACKAGE = 1024 * 1024 * 1024


def canonical_shared(name, raw):
    # Older Windows generators translated these text outputs to CRLF. Normalize
    # only generated docs/JSON, never binaries, source archives or original licenses.
    if name.endswith('.md') or name in ('package.json', 'Editor/NativeRequirements.json'):
        return raw.replace(b'\r\n', b'\n')
    return raw


def validate_documentation(files):
    spec = importlib.util.spec_from_file_location('devcel_packaged_docs', Path(__file__).with_name('package-importers.py'))
    packaging = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(packaging)
    for name, raw in files.items():
        if not name.endswith('.md'):
            continue
        for _, _, href in packaging.markdown_links(raw.decode('utf-8')):
            url = urlsplit(href.strip('<>'))
            if url.scheme or url.netloc or not url.path:
                continue
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), unquote(url.path)))
            if target.startswith('../') or target == '..' or target.startswith('/') or not (
                    target in files or any(path.startswith(target.rstrip('/')+'/') for path in files)):
                raise ValueError(f'Generated package documentation link is missing: {name}: {href}')


def add_missing_metadata(files):
    """Git packages are immutable: Unity cannot create missing folder/asset metas."""
    folders, assets = set(), set()
    for name in list(files):
        parts = name.split('/')
        if any(part.startswith('.') or part.endswith('~') for part in parts):
            continue
        for index in range(1, len(parts)):
            folders.add('/'.join(parts[:index]))
        if not name.endswith('.meta'):
            assets.add(name)
    for name in sorted(folders | assets):
        if name+'.meta' in files:
            continue
        guid = hashlib.sha256(('org.devcel.unity/'+name).encode()).hexdigest()[:32]
        folder = 'folderAsset: yes\n' if name in folders else ''
        files[name+'.meta'] = (f'fileFormatVersion: 2\nguid: {guid}\n'+folder+
            'DefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n').encode()


def assemble(desktop, mobile, destination, version, commit, repository):
    if set(desktop) != set(RIDS) or set(mobile) != {'android', 'ios', 'webgl'}:
        raise ValueError('Four Editor RIDs and Android, iOS and WebGL artifacts are required')
    if not unity_upm.VERSION.fullmatch(version):
        raise ValueError('Invalid package version')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', repository):
        raise ValueError('Invalid source repository')
    destination = Path(destination)
    if destination.exists():
        raise ValueError('Git package destination must not exist')
    files, common, binaries, runtimes, sources, notices = {}, None, {}, {}, [], []
    required_fingerprint = None
    for rid in RIDS:
        with zipfile.ZipFile(desktop[rid]) as archive:
            entries = unity_upm.package_entries(archive)
            if any('.git' in [part.lower() for part in name.split('/')] for name in entries):
                raise ValueError('Git control directories are forbidden in package inputs')
            if any(entry.file_size >= MAX_BLOB for entry in entries.values()):
                raise ValueError('Package input exceeds GitHub single-file limit')
            unity_upm.validate(archive, entries, version, rid)
            manifest = json.loads(archive.read(entries['Tools~/manifest.json']))
            if required_fingerprint is None:
                required_fingerprint = manifest['source_fingerprint']
            if (manifest.get('source_commit') != commit or manifest.get('source_repository') != repository or
                    manifest.get('source_fingerprint') != required_fingerprint):
                raise ValueError('Desktop source identity mismatch')
            shared = {name: canonical_shared(name, archive.read(entry)) for name, entry in entries.items()
                      if not name.startswith(('Plugins/', 'ThirdPartyNotices/')) and
                      (not name.startswith('Tools~/') or
                       (name not in ('Tools~/manifest.json', 'Tools~/cli-source.tar.gz') and
                        not name.startswith('Tools~/'+rid+'/')))}
            if common is None:
                common = shared
                files.update(shared)
            elif shared != common:
                raise ValueError('Managed SDK/metadata/documentation differs between desktop builds')
            for name, entry in entries.items():
                if name.startswith('ThirdPartyNotices/'):
                    files['ThirdPartyNotices/' + rid + '/' + name.split('/', 1)[1]] = archive.read(entry)
                elif name.startswith('Tools~/'):
                    if name == 'Tools~/manifest.json' or name in shared:
                        continue
                    if name == 'Tools~/cli-source.tar.gz':
                        # The unchanged matching source archive remains in the
                        # published per-RID Unity ZIP, not in Git history.
                        url = f'https://github.com/{repository}/releases/download/v{version}/devcel-unity-{version}-{rid}.zip'
                        sources.append({'platform': rid, 'url': url,
                                        'archive_entry': 'devcel-unity/Tools~/cli-source.tar.gz',
                                        'sha256': manifest['source_sha256']})
                    elif name.startswith('Tools~/' + rid + '/'):
                        files[name] = archive.read(entry)
                elif name.startswith('Plugins/'):
                    # Both macOS inputs contain a universal dylib. Select the
                    # Apple Silicon build for both CPUs; retain both distinct CLIs.
                    if rid != 'osx-x64':
                        if name in files:
                            raise ValueError('Unexpected native plugin collision')
                        files[name] = archive.read(entry)
            binaries[rid] = manifest['binaries'][rid]
            if rid != 'osx-x64':
                runtimes[rid] = manifest['native_runtime']
            notices.append(b'\n===== ' + rid.encode() + b' =====\n' +
                           archive.read(entries['ThirdPartyNotices/THIRD-PARTY-NOTICES.txt']))
    files['ThirdPartyNotices/THIRD-PARTY-NOTICES.txt'] = b''.join(notices)
    players = []
    for system in ('android', 'ios', 'webgl'):
        additions, runtime = unity_mobile.load(mobile[system], system, version, commit, repository, required_fingerprint)
        if set(additions) & set(files):
            raise ValueError('Mobile payload collision')
        files.update(additions)
        players.extend(runtime)
    manifest = {'schema_version': 1, 'version': version, 'source_commit': commit,
                'source_repository': repository, 'source_fingerprint': required_fingerprint,
                'supportedPlatforms': list(RIDS), 'binaries': binaries,
                'native_runtimes': list(runtimes.values()), 'player_runtimes': players,
                'source_archives': sources}
    files['Tools~/manifest.json'] = (json.dumps(manifest, indent=2)+'\n').encode()
    # Retain payload bytes and execute permissions without Git LFS or filters.
    files['.gitattributes'] = b'* -text -filter\n'
    validate_documentation(files)
    add_missing_metadata(files)
    total = sum(len(raw) for raw in files.values())
    largest = max(files, key=lambda name: len(files[name]))
    if len(files[largest]) >= MAX_BLOB or total > MAX_PACKAGE:
        raise ValueError('Git package exceeds the 100 MiB file / 1 GiB package budget')
    destination.mkdir(parents=True)
    for name, raw in sorted(files.items()):
        path = destination/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        if name.endswith(('/devcel', '/devcel.exe')):
            path.chmod(0o755)
    return {'version': version, 'source_commit': commit, 'source_repository': repository,
            'files': len(files), 'package_bytes': total, 'largest_file': largest,
            'largest_file_bytes': len(files[largest]), 'git_lfs': False,
            'macos_runtime_provider': 'osx-arm64'}


PACKAGE_PATH = 'importers/unity'


def release_commit(package, repository_root, source_commit, version, *, author_name, author_email):
    """Replace the Unity package subtree in an isolated index; change no refs."""
    root = Path(repository_root).resolve()
    env = dict(os.environ, GIT_AUTHOR_NAME=author_name, GIT_AUTHOR_EMAIL=author_email,
               GIT_COMMITTER_NAME=author_name, GIT_COMMITTER_EMAIL=author_email,
               GIT_AUTHOR_DATE='2000-01-01T00:00:00+00:00', GIT_COMMITTER_DATE='2000-01-01T00:00:00+00:00',
               GIT_ATTR_NOSYSTEM='1')
    for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'):
        env.pop(key, None)
    with tempfile.TemporaryDirectory(prefix='devcel-release-tree-') as temp:
        stage = Path(temp)/'tree'; stage.mkdir()
        (stage/PACKAGE_PATH).parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(package, stage/PACKAGE_PATH)
        empty = Path(temp)/'empty'; empty.mkdir()
        attrs = Path(temp)/'attributes'; attrs.touch()
        git_dir = subprocess.run(['git', 'rev-parse', '--absolute-git-dir'], cwd=root,
                                 check=True, text=True, capture_output=True).stdout.strip()
        env.update(GIT_DIR=git_dir, GIT_WORK_TREE=str(stage), GIT_INDEX_FILE=str(Path(temp)/'index'))
        def git(*args):
            return subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath='+str(empty),
                '-c', 'core.attributesFile='+str(attrs), '-c', 'commit.gpgSign=false', *args],
                env=env, cwd=stage, text=True, capture_output=True, check=True).stdout.strip()
        if git('rev-parse', source_commit+'^{commit}') != source_commit:
            raise ValueError('Exact source commit required')
        timestamp = git('show', '-s', '--format=%cI', source_commit)
        env.update(GIT_AUTHOR_DATE=timestamp, GIT_COMMITTER_DATE=timestamp)
        git('read-tree', source_commit)
        git('rm', '-r', '--cached', '--ignore-unmatch', '--', PACKAGE_PATH)
        git('add', '--force', '--all', '--', PACKAGE_PATH)
        for path in (stage/PACKAGE_PATH).glob('Tools~/*/devcel'):
            git('update-index', '--chmod=+x', path.relative_to(stage).as_posix())
        tree = git('write-tree')
        revision = git('commit-tree', tree, '-p', source_commit, '-m', 'Release '+version+' with Unity package')
        if source_identity(root, revision) != source_commit:
            raise ValueError('Generated release tree failed provenance validation')
        return revision


def source_identity(root, release_commit):
    """Validate the release envelope: one source parent and only the Unity package subtree changed."""
    def git(*args):
        return subprocess.run(['git', *args], cwd=root, check=True, text=True, capture_output=True).stdout.strip()
    parts = git('rev-list', '--parents', '-n', '1', release_commit).split()
    if len(parts) != 2:
        raise ValueError('Release package commit must have exactly one source parent')
    source = parts[1]
    changes = git('diff-tree', '--no-commit-id', '--name-status', '-r', source, release_commit).splitlines()
    if not changes or any(len(line.split('\t')) != 2 or not line.split('\t')[1].startswith(PACKAGE_PATH+'/') for line in changes):
        raise ValueError('Release commit may only change the generated Unity package subtree')
    manifest = json.loads(git('show', release_commit+':'+PACKAGE_PATH+'/Tools~/manifest.json'))
    package = json.loads(git('show', release_commit+':'+PACKAGE_PATH+'/package.json'))
    if manifest.get('source_commit') != source or manifest.get('version') != package.get('version'):
        raise ValueError('Release package source/version mismatch')
    return source


def verify_release_tree(root, existing, prepared):
    """A rebuild may not publish assets differing from the immutable Git package."""
    def tree(commit):
        return subprocess.run(['git', 'rev-parse', commit+':'+PACKAGE_PATH], cwd=root,
                              check=True, text=True, capture_output=True).stdout.strip()
    if source_identity(root, existing) != source_identity(root, prepared) or tree(existing) != tree(prepared):
        raise ValueError('Rebuilt package differs from the immutable release tag Unity package tree; use the original artifacts or a new version, never move the tag.')


def create(desktop, mobile, output, version, commit, repository, author_name=None, author_email=None):
    """Create a deterministic complete package ZIP and size/provenance report; no Git writes."""
    output = Path(output); output.mkdir(parents=True, exist_ok=True)
    artifact = output/f'org.devcel.unity-{version}-git.zip'
    report = output/f'org.devcel.unity-{version}-git.json'
    if artifact.exists() or report.exists():
        raise ValueError('Git package outputs already exist')
    with tempfile.TemporaryDirectory(prefix='devcel-upm-stage-') as temp:
        package = Path(temp)/'package'
        result = assemble(desktop, mobile, package, version, commit, repository)
        with zipfile.ZipFile(artifact, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(package.rglob('*')):
                if path.is_file():
                    info = zipfile.ZipInfo(path.relative_to(package).as_posix(), (2000,1,1,0,0,0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, path.read_bytes())
    result.update(tag='v'+version, package_path=PACKAGE_PATH,
                  archive_sha256=hashlib.sha256(artifact.read_bytes()).hexdigest())
    report.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    return [artifact, report]


def stage_release(archive, report, root, author_name, author_email):
    """Prepare a release commit locally. Never push, tag, or update a source branch."""
    metadata = json.loads(Path(report).read_text(encoding='utf-8'))
    if hashlib.sha256(Path(archive).read_bytes()).hexdigest() != metadata['archive_sha256']:
        raise ValueError('Git package archive checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='devcel-release-package-') as temp:
        with zipfile.ZipFile(archive) as source:
            for info in source.infolist():
                parts = info.filename.split('/')
                if any(part.lower() in ('', '.', '..', '.git') or ':' in part or '\\' in part for part in parts):
                    raise ValueError('Unsafe package archive path')
                if info.file_size >= MAX_BLOB:
                    raise ValueError('GitHub file size limit exceeded')
            if sum(item.file_size for item in source.infolist()) > MAX_PACKAGE:
                raise ValueError('Git package size budget exceeded')
            source.extractall(temp)
        return release_commit(temp, root, metadata['source_commit'], metadata['version'],
                              author_name=author_name, author_email=author_email)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desktop-dir', type=Path, required=True)
    parser.add_argument('--mobile-android', type=Path, required=True)
    parser.add_argument('--mobile-ios', type=Path, required=True)
    parser.add_argument('--mobile-webgl', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--source-repository', required=True)
    args = parser.parse_args()
    print(create({rid: args.desktop_dir/f'devcel-unity-{args.version}-{rid}.zip' for rid in RIDS},
        {'android': args.mobile_android, 'ios': args.mobile_ios, 'webgl': args.mobile_webgl}, args.out, args.version,
        args.source_commit, args.source_repository))
