#!/usr/bin/env python3
"""Optionally package repository source plus locked Cargo/npm build-input archives.

Creates a local archive; never publishes it. This cache bundle does not include
all upstream preferred-source trees; see third-party/preferred-sources.json. Registry downloads are restricted to
HTTPS registry.npmjs.org URLs already recorded with integrity in committed locks.
"""
from __future__ import annotations
import argparse, hashlib, json, os, shutil, subprocess, sys, tarfile, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import release_privacy
from npm_license_inventory import _cache_dir, _download, _bundle_source, _read_tarball

SOURCE_ITEMS = (
    '.github', '.gitattributes', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'package-lock.json',
    'LICENSE-NOTICE', 'README.md', 'build-all-windows.ps1', 'assets',
    'examples', 'tests', 'devcel-core', 'devcel-cli', 'devcel-runtime', 'devcel-studio', 'importers', 'docs', 'scripts', 'third-party', 'CONTRIBUTING.md',
)
EXCLUDED_DIRS = {'node_modules','target','dist','.git','.cache','.vite','.godot','Library','Temp','__pycache__','test-output'}
EXCLUDED_SUFFIXES = ('.devcel-write.lock', '.pyc', '.pyo', '.log')
SECRET_NAMES = {'.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.toml', '.aws', '.ssh'}

def sha256(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()

def copy_source(repo, stage):
    for item in SOURCE_ITEMS:
        source=repo/item
        if not source.exists(): raise RuntimeError(f'Required build source missing: {item}')
        paths=[source] if source.is_file() else sorted(source.rglob('*'))
        for path in paths:
            relative=path.relative_to(repo)
            # The generated Unity distribution can contain platform binaries and
            # vendored archives; its editable sources live in unity-template.
            if relative.parts[:2] == ('importers', 'unity') and len(relative.parts) > 2 and relative.parts[2] in ('Plugins', 'Tools~', 'ThirdPartyNotices', 'Plugins.meta', 'ThirdPartyNotices.meta'):
                continue
            if relative.parts[:2] == ('third-party', 'generated') or relative.as_posix() in ('devcel-studio/public/legal/THIRD-PARTY-NOTICES.txt', 'importers/unity/Editor/NativeRequirements.json'): continue
            if any(part in EXCLUDED_DIRS and not (part == 'dist' and relative.parts[:2] == ('importers', 'cocos')) for part in relative.parts) or path.name.endswith(EXCLUDED_SUFFIXES): continue
            if path.is_symlink(): raise RuntimeError(f'Release source symlink requires explicit review: {relative}')
            if not path.is_file(): continue
            if path.name.startswith('.env') or any(part in SECRET_NAMES for part in relative.parts) or path.suffix in ('.pem','.key','.p12','.pfx'): raise RuntimeError(f'Unexpected credential-like file in source: {relative}')
            destination=stage/relative; destination.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(path,destination)

def collect_npm_sources(repo):
    """Resolve every locked entry to its own or verified enclosing tarball."""
    sources = {}
    for lockfile in ('package-lock.json', 'devcel-studio/package-lock.json'):
        packages = json.loads((repo / lockfile).read_text(encoding='utf-8'))['packages']
        for path, package in packages.items():
            if not path: continue
            bundled = None
            if package.get('inBundle') is True:
                parent_path, parent, identities = _bundle_source(path, packages)
                source, integrity = parent.get('resolved'), parent.get('integrity')
                bundled = {'lockfile': lockfile, 'package_path': path,
                    'package_subpath': path[len(parent_path) + 1:],
                    'expected_packages': identities}
            else:
                source, integrity = package.get('resolved'), package.get('integrity')
            if not source or not integrity:
                raise RuntimeError(f'Unarchivable npm dependency: {lockfile}:{path}')
            entries = sources.setdefault((source, integrity), [])
            if bundled is not None: entries.append(bundled)
    return sources


def archive_npm_source(item, stage, cache):
    (source, integrity), bundled = item
    path = _download(source, integrity, cache)
    # Integrity authenticates all archive bytes. Check the parent and every
    # intermediate/child package identity too; inBundle is not a skip flag.
    for entry in bundled:
        errors = []
        _read_tarball(path, errors, entry['package_subpath'], entry['expected_packages'])
        if errors: raise RuntimeError(f'Invalid bundled npm source {entry["package_path"]}: {errors}')
    destination = stage / 'npm-tarballs' / path.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, destination)
    return {'url': source, 'integrity': integrity,
        'file': destination.relative_to(stage).as_posix(), 'sha256': sha256(destination),
        'bundled_packages': bundled}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--source-commit',required=True)
    parser.add_argument('--build-epoch',type=int,default=0)
    args=parser.parse_args();repo=args.repo.resolve();out=args.out.resolve()
    subprocess.run([sys.executable,str(repo/'scripts/generate-third-party-notices.py'),'--ensure'],cwd=repo,check=True)
    with tempfile.TemporaryDirectory(prefix='devcel-studio-source-') as temp:
        stage=Path(temp)/'devcel-source';stage.mkdir();copy_source(repo,stage)
        subprocess.run([sys.executable, str(stage/'scripts/check-manual.py')], cwd=stage, check=True)
        vendor=subprocess.run(['cargo','vendor','--locked',str(stage/'vendor')],cwd=repo,text=True,capture_output=True,check=True).stdout
        # Cargo emits the supplied absolute path; the archive must be relocatable.
        vendor=vendor.replace(str(stage/'vendor').replace('\\','/'),'vendor').replace(str(stage/'vendor'),'vendor')
        (stage/'.cargo').mkdir();(stage/'.cargo/config.toml').write_text(vendor,encoding='utf-8')
        packages = collect_npm_sources(repo)
        cache = _cache_dir(repo)
        with ThreadPoolExecutor(max_workers=8) as pool:
            npm = list(pool.map(lambda item: archive_npm_source(item, stage, cache), sorted(packages.items())))
        (stage/'npm-tarballs/index.json').write_text(json.dumps(npm,indent=2)+'\n')
        (stage/'BUILD-SOURCE.txt').write_text(
            f'Devcel Studio source commit: {args.source_commit}\n'
            f'This archive has no .git. For build-all-windows.ps1 importer builds, pass -SourceCommit {args.source_commit}\n'
            'and -SourceRepository OWNER/REPO containing that revision (or -SkipImporters for Studio only).\n'
            'Use the pinned Rust/Node/npm toolchains. Cargo registry sources and original notices are in vendor/.\n'
            'npm-tarballs/index.json records exact locked registry archives with integrity and SHA256.\n'
            'To seed an isolated npm cache, run npm cache add <archive> --cache <cache> for each npm-tarballs/*.tgz,\n'
            'then npm ci --offline --cache <cache> in devcel-studio. Build with npm run tauri build.\n'
            'Platform SDKs and system libraries are external prerequisites; consult docs/development/build-studio.md.\n'
            'Original component licenses are retained. The license inventory identifies copyleft and upstream caveats.\n'
            'Preferred upstream editable-source trees are referenced in third-party/preferred-sources.json, not automatically copied.\n'
            'Preserve those too for a fully offline editable-source copy; see docs/development/source-delivery.md.\n',encoding='utf-8')
        hashes={p.relative_to(stage).as_posix():sha256(p) for p in sorted(stage.rglob('*')) if p.is_file()}
        (stage/'SOURCE-SHA256.json').write_text(json.dumps(hashes,indent=2)+'\n')
        out.parent.mkdir(parents=True,exist_ok=True)
        release_privacy.write_source_archive(stage, out, 'devcel-source', args.build_epoch)
        release_privacy.check_source_archive(out)
        # Read every member back and validate file content against the manifest.
        with tarfile.open(out,'r:gz') as archive:
            for name,expected in hashes.items():
                member=archive.extractfile('devcel-source/'+name)
                if member is None or hashlib.sha256(member.read()).hexdigest()!=expected: raise RuntimeError(f'Source archive verification failed: {name}')
        print(json.dumps({'file':out.name,'sha256':sha256(out),'files':len(hashes),'npm_archives':len(npm),'source_commit':args.source_commit}))

if __name__=='__main__':main()
