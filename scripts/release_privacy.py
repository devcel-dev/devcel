"""Deterministic release compiler paths and redacted payload privacy checks."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import tarfile
import json
import gzip
import ast
import tokenize
import io


def configure(root, extra_source=None):
    """Retain caller flags, passing paths with spaces as individual rustc args."""
    flags = (os.environ['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')
             if 'CARGO_ENCODED_RUSTFLAGS' in os.environ
             else os.environ.get('RUSTFLAGS', '').split())
    sysroot = subprocess.check_output(['rustc', '--print', 'sysroot'], text=True).strip()
    mappings = [(Path.home(), '/devcel/user-source'),
                (Path(os.environ.get('CARGO_HOME', Path.home()/'.cargo')), '/devcel/cargo'),
                (Path(sysroot), '/devcel/toolchain'),
                (Path(root), '/devcel/source')]
    if extra_source is not None:
        mappings.append((Path(extra_source), '/devcel/source'))
    physical = json.loads(os.environ.get('DEVCEL_RELEASE_PRIVATE_PREFIXES', '[]'))
    # rustc applies the last matching mapping; specific sources follow parents.
    for source, destination in sorted(mappings, key=lambda item: len(str(item[0]))):
        value = str(source.resolve())
        for spelling in dict.fromkeys((value, value.replace('\\', '/'))):
            if spelling not in physical:
                physical.append(spelling)
            argument = '--remap-path-prefix='+spelling+'='+destination
            if argument not in flags:
                flags.append(argument)
    os.environ['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(flags)
    os.environ['DEVCEL_RELEASE_PRIVATE_PREFIXES'] = json.dumps(physical)


def provenance_flags():
    """Never distribute caller-controlled flags or physical remap source paths."""
    return 'release privacy remapping enabled; caller flags omitted'


def archive_info(info, epoch):
    info.mtime = epoch
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    info.pax_headers = {}
    return info


def write_source_archive(stage, destination, name, epoch=0):
    """No physical gzip filename or filesystem owner/timestamp enters output."""
    with Path(destination).open('wb') as stream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=epoch) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                archive.add(stage, arcname=name, filter=lambda info: archive_info(info, epoch))


def diagnostic(error, category):
    # Exception messages can contain arbitrary paths, URLs or caller content.
    return category+': '+type(error).__name__


def check_source_archive(path):
    with tarfile.open(path, 'r:gz') as archive:
        for entry in archive:
            if entry.uid or entry.gid or entry.uname or entry.gname:
                raise ValueError('Release privacy check failed: archive ownership')
            if entry.linkname:
                check_bytes(entry.linkname.encode('utf-8'), 'archive link target')
            name = entry.name
            if name.startswith(('/', '\\')) or '..' in Path(name).parts or re.match(r'^[A-Za-z]:', name):
                raise ValueError('Release privacy check failed: archive path')
            if not entry.isfile():
                continue
            parts = Path(name).parts
            if any(p in {'vendor', 'third-party'} for p in parts) or Path(name).name.startswith(('LICENSE', 'COPYRIGHT', 'THIRD-PARTY-NOTICES')):
                continue
            stream = archive.extractfile(entry)
            if stream is not None:
                check_bytes(source_fixture_bytes(stream.read(), name), name)


PATTERNS = {
    'user-directory': re.compile(rb'(?i)(?:[A-Z]:[\\/]+Users[\\/]+|/home/|/Users/)[^\\/\s\x00]+'),
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'credential-token': re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b'),
}


def source_fixture_bytes(raw, name):
    """Only documented synthetic identities, never an entire file/directory."""
    normalized = name.replace('\\', '/')
    if not normalized.endswith(('/scripts/test-release-privacy.py', '/scripts/release_privacy.py')):
        return raw
    text = raw.decode('utf-8')
    lines = text.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1]+len(line))
    replacements = []
    fixtures = ['C:'+chr(92)+'Users'+chr(92)+'private-person',
                'C:'+chr(92)*2+'Users'+chr(92)*2+'private-person',
                '/home/private-person', '/Users/private-person', '/Users/webpack']
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type != tokenize.STRING:
            continue
        value = ast.literal_eval(token.string)
        if normalized.endswith('/scripts/release_privacy.py') and value == PATTERNS['user-directory'].pattern:
            cleaned = b'<privacy-regex>'
        else:
            cleaned = value
            for fixture in fixtures:
                marker = fixture.encode() if isinstance(cleaned, bytes) else fixture
                replacement = b'<synthetic-privacy-fixture>' if isinstance(cleaned, bytes) else '<synthetic-privacy-fixture>'
                cleaned = cleaned.replace(marker, replacement)
        if cleaned != value:
            replacements.append((offsets[token.start[0]-1]+token.start[1], offsets[token.end[0]-1]+token.end[1], repr(cleaned)))
    for start, end, replacement in reversed(replacements):
        text = text[:start]+replacement+text[end:]
    raw = text.encode('utf-8')
    return raw


def check_bytes(raw, name):
    """Report only category and payload-relative path, never the matched value."""
    for data in (raw, raw.replace(b'\x00', b'')):
        for prefix in json.loads(os.environ.get('DEVCEL_RELEASE_PRIVATE_PREFIXES', '[]')):
            if prefix.encode().lower() in data.lower():
                raise ValueError('Release privacy check failed: physical build prefix in '+name)
        for category, pattern in PATTERNS.items():
            if pattern.search(data):
                raise ValueError('Release privacy check failed: '+category+' in '+name)


def check_tree(root):
    root = Path(root)
    for path in root.rglob('*'):
        if not path.is_file() or path.is_symlink():
            continue
        name = path.relative_to(root).as_posix()
        # Original third-party attribution is required verbatim, not scrubbed.
        if any(part.lower() in {'legal', 'third-party', 'thirdpartynotices', 'vendor'} for part in path.relative_to(root).parts):
            continue
        if path.name.startswith(('LICENSE', 'COPYRIGHT', 'THIRD-PARTY-NOTICES')):
            continue
        if path.name == 'cli-source.tar.gz':
            check_source_archive(path)
            continue
        check_bytes(path.read_bytes(), name)
