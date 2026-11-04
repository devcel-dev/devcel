#!/usr/bin/env python3
"""Check that editor-local Japanese text has English text and matching placeholders."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1] / 'addons/devcel/editor'
string = r'"(?:[^"\\]|\\.)*"'
pair = re.compile(r'Locale\.text\((' + string + r'), (' + string + r')\)')
japanese = re.compile(r'[\u3000-\u9fff]')
checks = 0
for path in sorted(root.glob('*.gd')):
    source = path.read_text()
    starts = set()
    for match in pair.finditer(source):
        starts.add(match.start(1))
        assert not japanese.search(match.group(2)), (path, 'Japanese in English text')
        assert re.findall(r'%[sd]', match.group(1)) == re.findall(r'%[sd]', match.group(2)), (path, 'placeholder mismatch')
        checks += 1
    for match in re.finditer(string, source):
        if japanese.search(match.group()):
            assert match.start() in starts, (path, 'unlocalized literal', match.group())
assert checks > 200, checks
print(f'EDITOR_LOCALE_STATIC_OK: {checks} bilingual text uses')
