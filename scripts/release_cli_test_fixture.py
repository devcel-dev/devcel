"""Small complete real-evidence graph for the CLI startup regression only.

This is not release input. Standalone version/source/legal gates still inspect
the full checkout. No validator or child test is replaced by this fixture.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import tomllib
import bundled_plugin_versions
import release_source

OWN = ('devcel-cli', 'devcel-core', 'devcel-runtime', 'devcel-studio')
MEMBERS = ['devcel-cli', 'devcel-core', 'devcel-runtime', 'devcel-studio/src-tauri']
CARGO = {
    'dtoa': ('1.0.11', '4c3cf4824e2d5f025c7b531afcb2325364084a16806f6d47fbc1f5fbd9960590'),
    'dtoa-short': ('0.3.5', 'cd1511a7b6a56299bd043a9c167a6d2bfb37bf84a6dfceaba651168adfb43c87'),
}
NPM_VERSION = '2.1.1'
NPM_TARBALL = 'https://registry.npmjs.org/clsx/-/clsx-2.1.1.tgz'
NPM_INTEGRITY = 'sha512-eYm0QWBtUrBWZWG0d386OGAw16Z995PiOVo2B7bjWSbHedGl5e0ZWaq65kOGgUSNesEIDkB9ISbTg/JK9dhCZA=='
EDGES = {'devcel-core': [], 'devcel-cli': ['devcel-core'],
         'devcel-runtime': ['devcel-core'], 'devcel-studio': ['devcel-core', 'dtoa-short'],
         'dtoa': [], 'dtoa-short': ['dtoa']}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def write(root, name, raw):
    path = root/name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw if isinstance(raw, bytes) else raw.encode('utf-8'))


def write_json(root, name, value):
    write(root, name, json.dumps(value, indent=2, ensure_ascii=False)+'\n')


def validate_graph(root):
    """Assert identities, closure, edges, integrity and provenance independently."""
    root = Path(root)
    packages = tomllib.loads((root/'Cargo.lock').read_text())['package']
    mapped = {p['name']: p for p in packages}
    workspace = tomllib.loads((root/'Cargo.toml').read_text())['workspace']
    product_version = json.loads((root/'devcel-studio/src-tauri/tauri.conf.json').read_text())['version']
    require(workspace['members'] == MEMBERS, 'Fixture workspace members differ')
    require(len(packages) == len(mapped) == 6 and set(mapped) == set(EDGES), 'Fixture Cargo identity/closure differs')
    for name, package in mapped.items():
        require(package.get('dependencies', []) == EDGES[name], 'Fixture Cargo edges differ: '+name)
        if name in CARGO:
            dependency_version, checksum = CARGO[name]
            require(package['version'] == dependency_version and package['checksum'] == checksum
                    and package['source'] == 'registry+https://github.com/rust-lang/crates.io-index',
                    'Fixture Cargo integrity differs: '+name)
        else:
            require('source' not in package, 'Fixture workspace identity differs')
            directory = 'devcel-studio/src-tauri' if name == 'devcel-studio' else name
            manifest = tomllib.loads((root/directory/'Cargo.toml').read_text())
            expected_dependencies = {
                dependency: '='+CARGO[dependency][0] if dependency in CARGO else
                {'path': '../../devcel-core' if name == 'devcel-studio' else '../devcel-core'}
                for dependency in EDGES[name]
            }
            require(manifest['package']['name'] == name
                    and 'version' not in manifest['package']
                    and manifest.get('dependencies', {}) == expected_dependencies, 'Fixture workspace manifest/edges differ')
    root_lock = json.loads((root/'package-lock.json').read_text())
    studio = json.loads((root/'devcel-studio/package-lock.json').read_text())
    require(set(root_lock['packages']) == {''} and not root_lock['packages'][''].get('dependencies'), 'Fixture root npm graph differs')
    require(set(studio['packages']) == {'', 'node_modules/clsx'}, 'Fixture npm closure differs')
    npm = studio['packages']['node_modules/clsx']
    require(npm['version'] == NPM_VERSION and npm['resolved'] == NPM_TARBALL
            and npm['integrity'] == NPM_INTEGRITY and not npm.get('dependencies')
            and not npm.get('dev', False), 'Fixture npm integrity/edges differ')
    require(studio['packages']['']['dependencies'] == {'clsx': NPM_VERSION}, 'Fixture npm root edges differ')
    require('version' not in studio and 'version' not in studio['packages'][''], 'Fixture npm duplicates product version')
    require(json.loads((root/'devcel-studio/package.json').read_text()) == studio['packages'][''], 'Fixture npm manifest differs from lock root')
    inventory = json.loads((root/'third-party/generated/inventory.json').read_text())
    identities = [(p['ecosystem'], p['name']) for p in inventory['packages']]
    require(len(identities) == 7 and set(identities) ==
            {('devcel', n) for n in OWN} | {('cargo', n) for n in CARGO} | {('npm', 'clsx')},
            'Fixture license inventory coverage differs')
    preferred = json.loads((root/'third-party/preferred-sources.json').read_text())
    require(len(preferred['cargo']) == len(preferred['npm']) == 1, 'Fixture source mapping cardinality differs')
    cargo, npm_source = preferred['cargo'][0], preferred['npm'][0]
    require(cargo['name'] == 'dtoa-short' and cargo['version'] == CARGO['dtoa-short'][0]
            and cargo['sha256'] == CARGO['dtoa-short'][1]
            and cargo['commit'] == '2d905cdb8b2e08163dc0d015f529877fe657b4ef', 'Fixture MPL source mapping differs')
    require(npm_source['name'] == 'clsx' and npm_source['version'] == NPM_VERSION
            and npm_source['tarball'] == NPM_TARBALL and npm_source['integrity'] == NPM_INTEGRITY
            and npm_source['commit'] == '925494cf31bcd97d3337aacd34e659e80cae7fe2', 'Fixture npm source mapping differs')


def build(source, target):
    """Materialize complete original legal bytes without modifying source."""
    import release_version as release
    source, target = Path(source), Path(target)
    require(source.resolve() != target.resolve(), 'Fixture must be separate from source')
    notices = release.module('generate-third-party-notices')
    version = json.loads((source/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
    paths = [p.relative_to(source).as_posix() for p in (source/'scripts').glob('*.py')]
    paths += list(bundled_plugin_versions.SOURCES)
    paths += ['devcel-studio/src-tauri/tauri.conf.json', 'importers/unity/package.json',
              'importers/javascript/package.json', 'importers/cocos/package.json',
              'importers/unreal/Devcel.uplugin', 'importers/godot/addons/devcel/plugin.cfg']
    for name in paths:
        write(target, name, (source/name).read_bytes())
    write(target, 'Cargo.toml', '[workspace]\nmembers = ["devcel-cli", "devcel-core", "devcel-runtime", "devcel-studio/src-tauri"]\nresolver = "2"\n')
    for name in OWN:
        directory = 'devcel-studio/src-tauri' if name == 'devcel-studio' else name
        dependencies = ''.join(n+' = '+('"='+CARGO[n][0]+'"' if n in CARGO else '{ path = "'+('../devcel-core' if name != 'devcel-studio' else '../../devcel-core')+'" }')+'\n' for n in EDGES[name])
        write(target, directory+'/Cargo.toml', '[package]\nname = '+json.dumps(name)+'\n[dependencies]\n'+dependencies)
    source_cargo = tomllib.loads((source/'Cargo.lock').read_text())['package']
    cargo = [{'name': n, 'version': next(p['version'] for p in source_cargo if p['name'] == n and 'source' not in p),
              **({'dependencies': EDGES[n]} if EDGES[n] else {})} for n in OWN]
    cargo += [copy.deepcopy(next(p for p in source_cargo if p['name'] == n and p['version'] == v)) for n, (v, _) in CARGO.items()]
    write(target, 'Cargo.lock', 'version = 4\n'+''.join('\n[[package]]\n'+''.join(k+' = '+json.dumps(v)+'\n' for k, v in p.items()) for p in cargo))
    write_json(target, 'package.json', {'name': 'release-cli-fixture', 'private': True, 'dependencies': {}})
    write_json(target, 'package-lock.json', {'name': 'release-cli-fixture', 'lockfileVersion': 3, 'packages': {'': {'name': 'release-cli-fixture', 'dependencies': {}}}})
    manifest = {'name': 'devcel-studio', 'license': 'GPL-3.0', 'dependencies': {'clsx': NPM_VERSION}}
    write_json(target, 'devcel-studio/package.json', manifest)
    npm = json.loads((source/'devcel-studio/package-lock.json').read_text())['packages']['node_modules/clsx']
    write_json(target, 'devcel-studio/package-lock.json', {'name': 'devcel-studio', 'lockfileVersion': 3, 'packages': {'': manifest, 'node_modules/clsx': npm}})
    preferred = json.loads((source/'third-party/preferred-sources.json').read_text())
    preferred = {'schema_version': 1, 'locks': {name: release_source.digest(target/name) for name in release_source.LOCKS},
                 'cargo': [p for p in preferred['cargo'] if p['name'] == 'dtoa-short' and p['version'] == CARGO['dtoa-short'][0]],
                 'npm': [p for p in preferred['npm'] if p['name'] == 'clsx' and p['version'] == NPM_VERSION]}
    write_json(target, 'third-party/preferred-sources.json', preferred)
    inventory = json.loads((source/release.GENERATED/'inventory.json').read_text())
    wanted = {('devcel', n) for n in OWN} | {('cargo', n) for n in CARGO} | {('npm', 'clsx')}
    entries = [copy.deepcopy(p) for p in inventory['packages'] if (p['ecosystem'], p['name']) in wanted]
    for entry in entries:
        for evidence in entry['texts']:
            raw = (source/release.GENERATED/evidence.pop('file')).read_bytes()
            require(hashlib.sha256(raw).hexdigest() == evidence.pop('sha256'), 'Original fixture evidence hash differs')
            evidence['text'] = raw.decode('utf-8')
    for name, raw in notices.render(target, entries, notices.lock_hashes(target)).items():
        write(target, release.GENERATED+'/'+name, raw)
    write(target, release.PUBLIC, (target/release.GENERATED/'THIRD-PARTY-NOTICES.txt').read_bytes())
    validate_graph(target)
    notices.verify_render(target)
    release_source.validate_preferred_sources(target)
