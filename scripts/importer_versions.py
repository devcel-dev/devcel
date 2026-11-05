"""Product identities in packaged engine metadata."""
import json
from pathlib import Path
from product_version import read_version
import re

ENGINES = ('unity', 'godot', 'unreal', 'rpgmaker', 'wolf', 'gamemaker', 'defold', 'cocos', 'javascript')
IDENTITIES = {'unity': ('package.json', 'version'), 'javascript': ('package.json', 'version'),
              'cocos': ('package.json', 'version'), 'unreal': ('Devcel.uplugin', 'VersionName')}


def source_root(root, engine):
    if engine not in ENGINES:
        raise ValueError('Unknown importer')
    folder = 'unity-template' if engine == 'unity' else engine
    return Path(root)/'importers'/folder/('addons/devcel' if engine == 'godot' else '')


def payload_files(root, engine):
    version = read_version(root)
    origin = source_root(root, engine)
    files = {}
    if engine in IDENTITIES:
        name = IDENTITIES[engine][0]
        value = json.loads((origin/name).read_bytes())
        value[IDENTITIES[engine][1]] = version
        if engine == 'unreal':
            value['Version'] = unreal_version_code(version)
        files[name] = (json.dumps(value, indent=2, ensure_ascii=False)+'\n').encode('utf-8')
    if engine == 'godot':
        text = (origin/'plugin.cfg').read_text(encoding='utf-8')
        if re.search(r'^version\s*=', text, re.MULTILINE):
            raise ValueError('Godot source template must not store a product version')
        files['plugin.cfg'] = text.replace('[plugin]', '[plugin]\nversion="'+version+'"', 1).encode('utf-8')
    return files


def unreal_version_code(version):
    major, minor, patch = map(int, version.split('-', 1)[0].split('.'))
    code = major * 1000000 + minor * 1000 + patch
    if minor >= 1000 or patch >= 1000 or code > 2147483647:
        raise ValueError('Unreal numeric plugin version cannot represent this product version')
    return code


def materialize(root, engine, destination):
    if engine == 'unity':
        from unity_toolchain import materialize as native_requirements
        native_requirements(root, destination)
    for name, raw in payload_files(root, engine).items():
        (Path(destination)/name).write_bytes(raw)
    verify_payload(destination, engine, read_version(root))


def validate_templates(root):
    for engine, (name, key) in IDENTITIES.items():
        value = json.loads((source_root(root, engine)/name).read_bytes())
        if key in value or engine == 'unreal' and 'Version' in value:
            raise ValueError('Product version belongs only in tauri.conf.json: '+engine)
    if re.search(r'^version\s*=', (source_root(root, 'godot')/'plugin.cfg').read_text(encoding='utf-8'), re.MULTILINE):
        raise ValueError('Product version belongs only in tauri.conf.json: godot')


def verify_payload(root, engine, version):
    """Validate the extracted engine product identities."""
    import json
    root = Path(root)
    if engine in IDENTITIES:
        name, key = IDENTITIES[engine]
        metadata = json.loads((root/name).read_text(encoding='utf-8'))
        if engine == 'unreal' and metadata.get('Version') != unreal_version_code(version):
            raise ValueError('Packaged Unreal numeric identity drift')
        if metadata.get(key) != version:
            raise ValueError('Packaged importer identity drift: '+engine)
    if engine == 'godot':
        values = re.findall(r'^version="([^"]+)"\s*$', (root/'plugin.cfg').read_text(encoding='utf-8'), re.MULTILINE)
        if values != [version]:
            raise ValueError('Packaged Godot identity drift')


def check_packaged_versions(root, version):
    """Round-trip engine product metadata through clean ZIPs.

    This checks packaging/version contracts, not native engine installation.
    The release registration gate calls it on real release.bump() outputs.
    """
    import tempfile
    import zipfile
    with tempfile.TemporaryDirectory(prefix='devcel-importer-identities-') as directory:
        directory = Path(directory)
        for engine in ENGINES:
            package = directory/(engine+'.zip')
            with zipfile.ZipFile(package, 'w') as archive:
                for name, raw in payload_files(Path(root), engine).items():
                    archive.writestr(name, raw)
            with zipfile.ZipFile(package) as archive:
                archive.extractall(directory/engine)
            verify_payload(directory/engine, engine, version)
    return len(ENGINES)
