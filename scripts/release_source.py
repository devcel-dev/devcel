#!/usr/bin/env python3
"""Create and validate compact, revision-pinned release source directions.

This is a provenance/access check, not a legal-compliance certification. Registry
artifacts and preferred editable source are recorded separately. General-purpose
unmodified build tools remain locked build prerequisites, not runtime libraries.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import tomllib
import urllib.parse
import urllib.request
from npm_license_inventory import _bundle_source

ROOT = Path(__file__).resolve().parents[1]
LOCKS = ('Cargo.lock', 'package-lock.json', 'devcel-studio/package-lock.json')
MANIFEST = 'third-party/preferred-sources.json'
ASSET = 'SOURCE-ACCESS.json'
COMMIT = re.compile(r'[0-9a-f]{40}')
REPOSITORY = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+')


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def identity(package):
    return package['name'] + '@' + package['version']


def github_repository(url):
    if not isinstance(url, str) or not url.startswith('https://github.com/'):
        raise ValueError('Preferred source must name an HTTPS GitHub repository')
    name = url.removeprefix('https://github.com/')
    if not REPOSITORY.fullmatch(name) or name.endswith('.git'):
        raise ValueError('Invalid preferred-source repository')
    return name


def npm_artifacts(root):
    """Keep every lockfile occurrence, including bundled and standalone origins."""
    result = []
    for lockfile in LOCKS[1:]:
        packages = json.loads((root/lockfile).read_text(encoding='utf-8'))['packages']
        for path, item in packages.items():
            if not path:
                continue
            name = item.get('name') or path.rsplit('node_modules/', 1)[-1]
            runtime = not item.get('dev', False) or item.get('devOptional', False)
            value = {'name': name, 'version': item['version'], 'tarball': item.get('resolved'),
                     'integrity': item.get('integrity'), 'runtime': runtime,
                     'lockfile': lockfile, 'package_path': path}
            if item.get('inBundle'):
                parent_path, parent, _ = _bundle_source(path, packages)
                value['bundled_from'] = {'tarball': parent['resolved'], 'integrity': parent['integrity'],
                                         'package_subpath': path[len(parent_path)+1:]}
            result.append(value)
    return result


def npm_packages(root):
    """Runtime review is per name/version, not per redundant install location."""
    result = {}
    for value in npm_artifacts(root):
        key = identity(value)
        if key in result:
            previous = result[key]
            runtime = value['runtime'] or previous['runtime']
            # Standalone registry identity is the preferred review anchor; retain
            # *all* enclosing artifacts separately in npm_registry_artifacts.
            if previous['tarball'] and value['tarball'] and any(previous[f] != value[f] for f in ('tarball', 'integrity')):
                raise ValueError('Conflicting locked registry artifacts for '+key)
            if previous['tarball'] and not value['tarball']:
                value = dict(previous)
            value['runtime'] = runtime
        result[key] = value
    return result


def validate_preferred_sources(root=ROOT):
    manifest = json.loads((root/MANIFEST).read_text(encoding='utf-8'))
    if manifest.get('schema_version') != 1:
        raise ValueError('Unsupported preferred-source manifest schema')
    locks = {name: digest(root/name) for name in LOCKS}
    if 'locks' in manifest and manifest['locks'] != locks:
        raise ValueError('Preferred-source evidence must be refreshed for the current lockfiles')
    npm = npm_packages(root)
    runtime = {key: value for key, value in npm.items() if value['runtime']}
    inventory_document = json.loads((root/'third-party/generated/inventory.json').read_text(encoding='utf-8'))
    if any(inventory_document.get('inputs', {}).get(name) != locks[name] for name in LOCKS):
        raise ValueError('Cargo/npm license inventory is stale for the current locks')
    inventory = inventory_document['packages']
    copyleft = {identity(p): p for p in inventory if p['ecosystem'] == 'cargo'
                and any(term in p.get('license_selection', p.get('license', '')) for term in ('MPL-', 'GPL-'))}
    for ecosystem, expected in (('cargo', copyleft), ('npm', runtime)):
        records = manifest.get(ecosystem, [])
        mapped = {identity(entry): entry for entry in records}
        if len(mapped) != len(records) or set(mapped) != set(expected):
            raise ValueError(f'{ecosystem} preferred-source coverage differs: missing={sorted(set(expected)-set(mapped))}; extra={sorted(set(mapped)-set(expected))}')
        for key, entry in mapped.items():
            if not entry.get('evidence'):
                raise ValueError(f'Missing preferred-source evidence: {key}')
            if ecosystem == 'npm':
                for field in ('integrity', 'tarball'):
                    if entry.get(field) != expected[key].get(field) or not entry.get(field):
                        raise ValueError(f'Preferred-source {field} mismatch: {key}')
            else:
                if entry.get('sha256') != expected[key]['checksum']:
                    raise ValueError(f'Preferred-source crate checksum mismatch: {key}')
            if entry.get('source_kind') not in ('upstream-git', 'registry-source'):
                raise ValueError(f'Unreviewed preferred-source kind: {key}')
            if entry.get('source_kind') == 'registry-source' and ecosystem == 'npm':
                if not entry.get('source_paths'):
                    raise ValueError(f'No editable source paths recorded: {key}')
            else:
                github_repository(entry.get('repository'))
                if not COMMIT.fullmatch(entry.get('commit', '')):
                    raise ValueError(f'Preferred source must pin a full upstream commit: {key}')
            directory = entry.get('directory', '')
            if not isinstance(directory, str) or directory.startswith('/') or '..' in directory.split('/') or '\\' in directory:
                raise ValueError(f'Unsafe upstream source directory: {key}')
    return manifest


def source_index(repository, commit, tag, root=ROOT):
    if not REPOSITORY.fullmatch(repository) or not COMMIT.fullmatch(commit):
        raise ValueError('Source directions require OWNER/REPO and a full Git commit')
    # Tags are a human label; all source and documentation URLs pin the commit.
    if not re.fullmatch(r'v[0-9A-Za-z.-]+', tag):
        raise ValueError('Invalid source release tag')
    manifest = validate_preferred_sources(root)
    base = 'https://github.com/'+repository
    crates = []
    for package in tomllib.loads((root/'Cargo.lock').read_text(encoding='utf-8'))['package']:
        if 'source' not in package:
            continue
        if package['source'] != 'registry+https://github.com/rust-lang/crates.io-index':
            raise ValueError('Non-crates.io Cargo source needs an explicit source-delivery implementation')
        name, version = package['name'], package['version']
        crates.append({'name': name, 'version': version, 'sha256': package['checksum'],
                       'url': f'https://static.crates.io/crates/{name}/{name}-{version}.crate'})
    preferred = []
    for ecosystem in ('cargo', 'npm'):
        for package in manifest[ecosystem]:
            entry = dict(package, ecosystem=ecosystem)
            if entry.get('source_kind') == 'registry-source':
                entry['source_url'] = entry['tarball']
            else:
                entry['source_url'] = entry['repository']+'/archive/'+entry['commit']+'.tar.gz'
                entry['browse_url'] = entry['repository']+'/tree/'+entry['commit']+('/'+entry['directory'] if entry.get('directory') else '')
            preferred.append(entry)
    return {'schema_version': 1, 'repository': repository, 'commit': commit, 'tag': tag,
            'source': {'browse': base+'/tree/'+commit,
                       'tar_gz': base+'/archive/'+commit+'.tar.gz',
                       'zip': base+'/archive/'+commit+'.zip',
                       'build': base+'/blob/'+commit+'/docs/development/build-studio.md',
                       'dependencies': base+'/blob/'+commit+'/'+MANIFEST,
                       'delivery': base+'/blob/'+commit+'/docs/development/source-delivery.md'},
            'locks': {name: digest(root/name) for name in LOCKS},
            'cargo_registry_sources': sorted(crates, key=identity),
            'npm_registry_artifacts': sorted(npm_artifacts(root), key=lambda p: (identity(p), p['lockfile'], p['package_path'])),
            'preferred_sources': preferred,
            'access': 'Source links inherit repository access. Every binary recipient must have equivalent source access at no additional charge. If distributing outside this repository, provide an accessible matching source mirror or source copy; do not rely on a private link.',
            'scope': 'Registry artifacts reproduce locked inputs; preferred-source entries separately locate editable runtime source. Unmodified general-purpose build tools and platform SDK/system prerequisites are documented separately. Preserve upstream license and copyright notices.'}


def verify_source_urls(index):
    """Check current anonymous upstream access without downloading large archives.

    This only checks availability; the committed review binds preferred source
    to exact versions. No credentials are sent to third-party source hosts.
    """
    urls = sorted({entry['source_url'] for entry in index['preferred_sources']})
    def check(url):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != 'https' or parsed.hostname not in ('github.com', 'registry.npmjs.org') or parsed.username or parsed.password:
            raise ValueError('Unapproved source host: '+url)
        request = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'Devcel-source-access/1.0'})
        with urllib.request.urlopen(request, timeout=60) as response:
            final = urllib.parse.urlparse(response.geturl())
            if final.scheme != 'https' or final.hostname not in ('github.com', 'codeload.github.com', 'registry.npmjs.org') or response.status != 200:
                raise ValueError('Source is not available at its reviewed location: '+url)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(check, urls))
    return len(urls)


def write_index(out, repository, commit, tag, root=ROOT):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(source_index(repository, commit, tag, root), indent=2)+'\n', encoding='utf-8', newline='\n')


def validate_index(path, repository, commit, tag, root=ROOT):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Matching source-access manifest is required')
    if json.loads(path.read_text(encoding='utf-8')) != source_index(repository, commit, tag, root):
        raise ValueError('Source-access manifest does not match this release revision and locked dependencies')


def source_notes(index, visibility):
    if visibility not in ('public', 'private', 'internal'):
        raise ValueError('Repository visibility must be checked before publication')
    source = index['source']
    access = ('These source links are publicly accessible.' if visibility == 'public' else
              'This repository is '+visibility+'. These links require repository read access, just like this release. Do not redistribute the binaries to someone without providing equivalent access to the matching source.')
    return ('## Source and rebuild instructions\n\n'
            f'Tag: {index["tag"]}; exact source commit: {index["commit"]}.\n\n'
            f'- [Browse matching source]({source["browse"]})\n'
            f'- [Download source tar.gz]({source["tar_gz"]}) or [ZIP]({source["zip"]})\n'
            f'- [Build and rebuild instructions]({source["build"]})\n'
            f'- [Exact dependency preferred-source references]({source["dependencies"]})\n'
            f'- [Source access and redistribution details]({source["delivery"]})\n\n'
            'SOURCE-ACCESS.json attached to this release records locked registry URLs/checksums and editable-source references. '
            'The source download is optional for binary users; no giant combined source archive is required.\n\n'
            +access+' Source must remain available at no additional charge while these binaries are offered. '
            'Repository visibility is not changed by the release workflow.\n\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--verify-urls', action='store_true')
    parser.add_argument('--repository')
    parser.add_argument('--commit')
    parser.add_argument('--tag')
    args = parser.parse_args()
    if args.check:
        manifest = validate_preferred_sources(args.repo)
        print(f'Preferred-source coverage verified: {len(manifest["cargo"])} copyleft crates; {len(manifest["npm"])} runtime npm versions')
    elif args.out and args.repository and args.commit and args.tag:
        index = source_index(args.repository, args.commit, args.tag, args.repo)
        if args.verify_urls:
            print(f'Preferred-source URLs available: {verify_source_urls(index)}')
        write_index(args.out, args.repository, args.commit, args.tag, args.repo)
    else:
        parser.error('Use --check or --out --repository --commit --tag')


if __name__ == '__main__':
    main()
