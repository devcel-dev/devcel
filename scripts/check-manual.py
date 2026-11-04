#!/usr/bin/env python3
"""Check current manual entry points, local Markdown links/anchors and fences."""
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
FILES = [ROOT / 'README.md', ROOT / 'CONTRIBUTING.md', ROOT / 'devcel-studio/README.md']
for directory in ('docs', 'examples', 'importers'):
    FILES += sorted((ROOT / directory).rglob('*.md'))
FILES = sorted(set(FILES))


def outside_fences(text):
    lines = []
    fence = None
    for line in text.splitlines():
        token = re.match(r'^\s*(`{3,}|~{3,})', line)
        if token:
            marker = token[1]
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence):
                fence = None
            continue
        if fence is None:
            lines.append(line)
    return '\n'.join(lines), fence


def anchors(path):
    body, _ = outside_fences(path.read_text(encoding='utf-8'))
    result = set(re.findall(r'<a\s+(?:id|name)=[\"\']([^\"\']+)', body))
    counts = {}
    for heading in re.findall(r'^#{1,6}\s+(.+?)\s*#*$', body, re.M):
        heading = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', heading)
        heading = re.sub(r'<[^>]+>', '', heading).replace('`', '').lower()
        slug = ''.join(c for c in heading if c in '-_ ' or unicodedata.category(c)[0] in 'LNM')
        slug = slug.replace(' ', '-')
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        result.add(slug if count == 0 else f'{slug}-{count}')
    return result


errors = []
links = 0
anchor_cache = {}
for source in FILES:
    if not source.is_file():
        errors.append(f'missing page: {source.relative_to(ROOT)}')
        continue
    body, fence = outside_fences(source.read_text(encoding='utf-8'))
    if fence:
        errors.append(f'unclosed fence: {source.relative_to(ROOT)}')
    for match in re.finditer(r'!?\[[^\]]*\]\(([^\s)]+)(?:\s+[\"\'][^)]*)?\)', body):
        target = match[1].strip('<>')
        url = urlsplit(target)
        if url.scheme or url.netloc:
            continue
        links += 1
        path = (source.parent / unquote(url.path)).resolve() if url.path else source
        if not path.exists():
            errors.append(f'{source.relative_to(ROOT)}: missing {target}')
        elif url.fragment and path.suffix == '.md':
            if path not in anchor_cache:
                anchor_cache[path] = anchors(path)
            if unquote(url.fragment) not in anchor_cache[path]:
                errors.append(f'{source.relative_to(ROOT)}: missing anchor {target}')
if errors:
    print('\n'.join(errors), file=sys.stderr)
    sys.exit(1)
print(f'Manual check passed: {len(FILES)} pages, {links} local links, balanced fences')
