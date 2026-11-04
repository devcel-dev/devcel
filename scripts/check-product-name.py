#!/usr/bin/env python3
"""Audit current source paths and bytes for retired product branding.

Build and cache output is excluded.
Run from any directory; no third-party Python dependencies are needed.
"""
from pathlib import Path
import os
import re
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
RETIRED = ''.join(('kro', 'nix'))
SKIP = {'.git', 'target', 'node_modules', 'dist', '.godot', 'test-output',
        '__pycache__', '.pytest_cache', '.venv', 'bin', 'obj'}
failures = []
files = 0

def plain(text):
    return ''.join(c for c in unicodedata.normalize('NFKD', text)
                   if not unicodedata.combining(c)).casefold()

for directory, dirs, names in os.walk(ROOT):
    dirs[:] = [name for name in dirs if name not in SKIP]
    for name in names:
        path = Path(directory) / name
        relative = path.relative_to(ROOT).as_posix()
        if RETIRED in plain(relative):
            failures.append(f'{relative}: retired name in path')
        if path.is_symlink():
            continue
        data = path.read_bytes()
        files += 1
        try:
            text = plain(data.decode('utf-8'))
        except UnicodeDecodeError:
            if RETIRED.encode() in data.lower():
                failures.append(f'{relative}: retired name in binary metadata')
            continue
        for line_no, line in enumerate(text.splitlines(), 1):
            if RETIRED in line:
                failures.append(f'{relative}:{line_no}: retired product name')

if failures:
    print('\n'.join(failures), file=sys.stderr)
    raise SystemExit(1)
print(f'PASS: {files} current files; no retired product names in paths or content')
