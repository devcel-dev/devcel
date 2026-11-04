"""Pin the native/code-generation inputs used by the Git-installed Unity SDK."""
import hashlib
import json
import tomllib
from pathlib import Path


def fingerprint(root):
    files = [root / name for name in ('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml')]
    for crate in ('devcel-core', 'devcel-cli', 'devcel-runtime'):
        files += [root / crate / 'Cargo.toml']
        files += list((root / crate / 'src').rglob('*.rs'))
        build = root / crate / 'build.rs'
        if build.exists():
            files.append(build)
    digest = hashlib.sha256()
    # Sort portable relative names, not Path objects: Windows Path ordering is
    # case-insensitive while POSIX ordering is case-sensitive.
    for path in sorted(set(files), key=lambda item: item.relative_to(root).as_posix().encode()):
        name = path.relative_to(root).as_posix().encode()
        data = path.read_bytes().replace(b'\r\n', b'\n')
        # Release identity is checked separately and transactionally by the package
        # version gate. Keep a version-only release bump from changing the API pin.
        if path == root / 'Cargo.toml':
            document = tomllib.loads(data.decode())
            document.get('workspace', {}).get('package', {}).pop('version', None)
            data = json.dumps(document, sort_keys=True, separators=(',', ':')).encode()
        elif path == root / 'Cargo.lock':
            document = tomllib.loads(data.decode())
            for package in document.get('package', []):
                if 'source' not in package and package.get('name') in ('devcel-cli', 'devcel-core', 'devcel-runtime', 'devcel-studio'):
                    package.pop('version', None)
            data = json.dumps(document, sort_keys=True, separators=(',', ':')).encode()
        digest.update(len(name).to_bytes(8, 'little') + name)
        digest.update(len(data).to_bytes(8, 'little') + data)
    return digest.hexdigest()


def verify(root):
    # Source checkouts contain inputs, never a manually refreshed digest.
    return fingerprint(root)


def materialize(root, destination):
    target = Path(destination)/'Editor/NativeRequirements.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({'schema_version': 1, 'source_fingerprint': fingerprint(root)}, indent=2)+'\n', encoding='utf-8', newline='\n')


def verify_source(root, source):
    required = verify(root)
    if fingerprint(source) != required:
        raise ValueError('Native source tree does not match the Unity SDK toolchain fingerprint')
    return required


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, help='Generate metadata in an importer output folder')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.out:
        materialize(root, args.out)
    else:
        print(verify(root))
