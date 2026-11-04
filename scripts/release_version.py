"""Update only the canonical product SemVer; build outputs are never written back."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
from product_version import CONFIG, read_version, validate_version

ROOT = Path(__file__).resolve().parents[1]
GENERATED = 'third-party/generated'
PUBLIC = 'devcel-studio/public/legal/THIRD-PARTY-NOTICES.txt'


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT/'scripts'/f'{name}.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def replace_version(raw, old, new, count=1, key='version'):
    pattern = rb'("'+key.encode()+rb'"\s*:\s*")'+re.escape(old.encode())+rb'(")'
    result, changed = re.subn(pattern, lambda m: m[1]+new.encode()+m[2], raw, count=count)
    if changed != count:
        raise ValueError('Expected unique product version field')
    return result


def bump(version, root=ROOT):
    validate_version(version)
    root = Path(root).resolve()
    config = root/CONFIG
    if config.is_symlink() or not config.resolve().is_relative_to(root):
        raise ValueError('Refusing linked product configuration')
    original = config.read_bytes()
    old = read_version(root)
    if old == version:
        return []
    updated = replace_version(original, old, version)
    expected = json.loads(original)
    expected['version'] = version
    if json.loads(updated) != expected:
        raise ValueError('Product version update would alter other configuration')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=config.parent, prefix='.product-version-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        if config.read_bytes() != original:
            raise ValueError('Product configuration changed during preparation')
        os.replace(temporary, config)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return [CONFIG]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version')
    parser.add_argument('--repo', type=Path, default=ROOT)
    args = parser.parse_args()
    changed = bump(args.version, args.repo)
    print(f'Product version {args.version}: {len(changed)} changed file(s)')
    for name in changed:
        print(name)


if __name__ == '__main__':
    main()
