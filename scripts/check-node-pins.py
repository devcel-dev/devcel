#!/usr/bin/env python3
"""Check first-party Node pins, including hidden selectors, using Python 3.11+."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
EXACT_VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')
# Do not inspect dependency copies, generated output, caches, or Git internals.
EXCLUDED_DIRS = frozenset({
    '.git', '.cache', '.npm', '.yarn', '.venv', '__pycache__', 'node_modules',
    'bower_components', 'jspm_packages', 'web_modules', 'vendor', 'target',
    'dist', 'build', 'build-output', 'devcel-out', 'out', 'coverage', 'generated',
    'release-assets', 'release-importers', 'release-reports', 'release-downloads',
    'release-publish', 'native-review-artifacts', 'native-ui-review',
})
PLAIN_SELECTORS = frozenset({'.nvmrc', '.node-version', '.nodejs-version'})


def read_text(path):
    if path.is_symlink():
        raise ValueError(f'Refusing to read a Node configuration through a symlink: {path}')
    return path.read_text(encoding='utf-8')


def read_json(root, relative):
    try:
        return json.loads(read_text(root / relative))
    except (OSError, ValueError) as error:
        raise ValueError(f'{relative}: {error}') from error


def field(value, *keys):
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def selector_kind(path):
    name = path.name
    if name in PLAIN_SELECTORS:
        return 'plain'
    if name == '.tool-versions':
        return 'asdf'
    if name == '.prototools':
        return 'proto'
    if (re.fullmatch(r'\.?mise(?:\.[^.]+)*\.toml', name)
            or (path.parent.name in ('.mise', 'mise')
                and re.fullmatch(r'config(?:\.[^.]+)*\.toml', name))):
        return 'mise'
    return None


def selectors(root):
    def walk_error(error):
        raise error
    for directory, subdirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        subdirs[:] = sorted(name for name in subdirs
                           if name not in EXCLUDED_DIRS
                           and not (Path(directory) / name).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            kind = selector_kind(path)
            if kind:
                yield path, kind


def selector_values(path, kind):
    text = read_text(path)
    if kind == 'plain':
        # Accept comments and an optional v prefix, but not aliases or ranges.
        values = [line.split('#', 1)[0].strip() for line in text.splitlines()]
        return [('', ' '.join(value for value in values if value))]
    if kind == 'asdf':
        values = []
        for line in text.splitlines():
            parts = line.split('#', 1)[0].split()
            if parts and parts[0] in ('nodejs', 'node'):
                values.append((parts[0], ' '.join(parts[1:])))
        return values
    parsed = tomllib.loads(text)
    table = parsed.get('tools', {}) if kind == 'mise' else parsed
    if not isinstance(table, dict):
        raise ValueError('Expected a tool version table')
    values = []
    for name in ('node', 'nodejs'):
        if name in table:
            value = table[name]
            if isinstance(value, dict):
                value = value.get('version')
            values.append((name, value))
    return values


def check(root=ROOT):
    root = Path(root)
    studio = read_json(root, 'devcel-studio/package.json')
    version = field(studio, 'volta', 'node')
    if not isinstance(version, str) or not EXACT_VERSION.fullmatch(version):
        raise ValueError('devcel-studio/package.json volta.node must be an exact MAJOR.MINOR.PATCH pin')
    errors = []

    def expect(label, actual, expected):
        if actual != expected:
            errors.append(f'{label}: expected {expected!r}, found {actual!r}')

    for relative in ('package.json', 'devcel-studio/package.json'):
        package = studio if relative.startswith('devcel-studio/') else read_json(root, relative)
        expect(f'{relative} volta.node', field(package, 'volta', 'node'), version)
        expect(f'{relative} engines.node', field(package, 'engines', 'node'), '>=' + version)
        lock_path = relative.replace('package.json', 'package-lock.json')
        lock = read_json(root, lock_path)
        expect(f'{lock_path} packages[\"\"].engines.node',
               field(lock, 'packages', '', 'engines', 'node'), '>=' + version)
    template_path = 'devcel-studio/templates/plugin-template/package.json'
    template = read_json(root, template_path)
    expect(f'{template_path} engines.node', field(template, 'engines', 'node'), '>=' + version)
    if field(template, 'volta', 'node') is not None:
        expect(f'{template_path} volta.node', field(template, 'volta', 'node'), version)

    found = []
    for path, kind in selectors(root):
        relative = path.relative_to(root).as_posix()
        try:
            values = selector_values(path, kind)
        except (OSError, ValueError) as error:
            errors.append(f'{relative}: {error}')
            continue
        for name, value in values:
            label = relative + (f' {name}' if name else '')
            found.append(label)
            normalized = value.removeprefix('v') if isinstance(value, str) else value
            expect(label, normalized, version)
    if errors:
        raise ValueError('Node pin mismatch:\n  ' + '\n  '.join(errors))
    return version, found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help='Repository root to check')
    args = parser.parse_args()
    try:
        version, found = check(args.root)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    print(f'Node pins match Studio {version}; checked manifests, lock roots, template and {len(found)} selector(s).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
