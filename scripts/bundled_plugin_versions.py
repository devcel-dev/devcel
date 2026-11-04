"""Release-owned plugin compatibility declarations; third-party ranges stay strict."""
from __future__ import annotations

from pathlib import Path
import re

SOURCES = {
    'devcel-studio/src/app/plugins/examples/CSVExporterPlugin.ts': '0.0.0',
    'devcel-studio/templates/plugin-template/src/index.ts': '0.0.0',
}
# Count every declaration, not only declarations containing the expected version.
DECLARATION = re.compile(rb'''\bdevcelVersion\s*:\s*(['"])([^'"\r\n]*)\1''')
SEMVER = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?')


def compatibility_range(version, minimum):
    """Allow stable hosts above the floor and only this release's prerelease."""
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        raise ValueError('Expected release SemVer without build metadata')
    if minimum not in SOURCES.values():
        raise ValueError('Unknown bundled plugin minimum version')
    # node-semver collapses >=0.0.0 OR an exact prerelease to '*'.
    # Split the stable range to retain only this release's explicit RC opt-in.
    stable = '>=0.0.0 <1.0.0 || >=1.0.0' if minimum == '0.0.0' and '-' in version else '>='+minimum
    return stable+(' || ='+version if '-' in version else '')


def render_sources(root, version):
    """Render build-only compatibility declarations without modifying sources."""
    edits = {}
    for name, minimum in SOURCES.items():
        raw = (Path(root)/name).read_bytes()
        declarations = list(DECLARATION.finditer(raw))
        # A malformed extra declaration must not be hidden by the string matcher.
        if len(declarations) != 1 or len(re.findall(rb'\bdevcelVersion\s*:', raw)) != 1:
            raise ValueError('Expected unique bundled plugin devcelVersion: '+name)
        declaration = declarations[0]
        if declaration[2] != compatibility_range("0.0.0", minimum).encode():
            raise ValueError('Bundled plugin compatibility differs from release: '+name)
        # A copied plugin template is owned by its author, not bundled into Studio.
        value = (('>='+minimum) if '/templates/' in name else compatibility_range(version, minimum)).encode()
        updated = raw[:declaration.start(2)]+value+raw[declaration.end(2):]
        edits[name] = updated
    return edits


def registration_fixtures(root, out):
    import json
    import shutil
    import release_version
    from product_version import CONFIG
    root, out = Path(root).resolve(), Path(out).resolve()
    working = out/'working'
    for name in [CONFIG, *SOURCES]:
        target = working/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root/name, target)
    manifest = []
    for index, version in enumerate(('0.0.3-rc.1', '0.0.3-rc.2', '0.0.3', '0.0.4-beta.1', '0.0.4')):
        changed = release_version.bump(version, working)
        if changed != [CONFIG]:
            raise ValueError('Version preparation must change only the canonical setting')
        rendered = render_sources(working, version)
        sources = []
        for name, minimum in SOURCES.items():
            target = out/str(index)/name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(rendered[name])
            if (working/name).read_bytes() != (root/name).read_bytes():
                raise ValueError('Rendering changed a stored plugin source')
            sources.append({'path': name, 'minimum': minimum, 'file': str(target)})
        manifest.append({'version': version, 'sources': sources})
    (out/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')


def check_registration(root):
    import json
    import shutil
    import subprocess
    import tempfile

    root = Path(root).resolve()
    with tempfile.TemporaryDirectory(prefix='devcel-plugin-registration-') as directory:
        out = Path(directory)
        registration_fixtures(root, out)
        manifest = json.loads((out/'manifest.json').read_text())
        fixtures = [{'version': entry['version'],
                     'sources': {key: Path(source['file']).read_text()
                                 for key, source in zip(('csv', 'template'), entry['sources'])}}
                    for entry in manifest]
        path = out/'registration.json'
        path.write_text(json.dumps(fixtures)+'\n')
        subprocess.run([shutil.which('node') or 'node', 'scripts/check-plugin-contracts.cjs',
                        '--bundled-fixtures', str(path)], cwd=root/'devcel-studio', check=True)


def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-registration', action='store_true')
    parser.add_argument('--render-json', action='store_true')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('command', nargs='?', choices=['fixtures'])
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.render_json:
        import json
        from product_version import read_version
        print(json.dumps({name: raw.decode('utf-8') for name, raw in render_sources(args.root, read_version(args.root)).items()}))
    elif args.check_registration:
        if args.command or args.out:
            parser.error('--check-registration cannot be combined with fixtures')
        check_registration(args.root)
    elif args.command == 'fixtures' and args.out:
        registration_fixtures(args.root, args.out)
    else:
        parser.error('Use --check-registration or fixtures --out DIR')


if __name__ == '__main__':
    main()
