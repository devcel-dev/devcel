#!/usr/bin/env python3
"""Cache only authenticated APT downloads, never installed system state."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

PACKAGES = (
    'build-essential', 'libwebkit2gtk-4.1-dev', 'libayatana-appindicator3-dev',
    'librsvg2-dev', 'libssl-dev', 'libxdo-dev', 'patchelf', 'rpm', 'cpio',
)


def parse_plan(text):
    archives = {}
    for line in text.splitlines():
        if not line.startswith("'"):
            continue
        _, name, size, digest = shlex.split(line)
        if (not re.fullmatch(r'[A-Za-z0-9.+%_~:-]+\.deb', name)
                or not re.fullmatch(r'SHA256:[0-9a-fA-F]{64}', digest)
                or not size.isdecimal()):
            raise ValueError('Unexpected APT archive metadata')
        value = {'size': int(size), 'sha256': digest[7:].lower()}
        if name in archives and archives[name] != value:
            raise ValueError('Conflicting APT archive metadata')
        archives[name] = value
    return archives


def cache_key(archives):
    # Freshly resolved versions/checksums invalidate exact hits immediately.
    data = json.dumps({'packages': PACKAGES, 'archives': archives}, sort_keys=True)
    return hashlib.sha256(data.encode()).hexdigest()


def output(name, value):
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
        stream.write(f'{name}={value}\n')


def archive_directory():
    directory = Path(tempfile.mkdtemp(prefix='devcel-apt-'))
    # Keep APT's normal _apt sandbox; only public package downloads live here.
    directory.chmod(0o755)
    return directory


def plan(root):
    try:
        # An empty archive directory ensures cached filenames cannot hide URIs.
        result = subprocess.run([
            'sudo', 'apt-get', '--print-uris', '--download-only', '-y',
            '-o', 'Acquire::ForceHash=sha256',
            '-o', f'Dir::Cache::archives={archive_directory()}',
            'install', *PACKAGES,
        ], check=True, text=True, stdout=subprocess.PIPE)
        archives = parse_plan(result.stdout)
        (root/'devcel-apt-plan.json').write_text(json.dumps(archives), encoding='utf-8')
        output('key', cache_key(archives))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'::warning::APT cache planning unavailable; using normal downloads: {error}')
        output('key', '')


def restore_verified(cache, destination, archives):
    """APT trusts existing archive sizes, so verify SHA-256 before handing it any."""
    if cache.is_symlink():
        raise OSError('APT cache directory must not be a symlink')
    count = size = 0
    for name, expected in archives.items():
        source = cache/name
        if source.is_symlink() or not source.is_file():
            continue
        if source.stat().st_size != expected['size']:
            continue
        with source.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != expected['sha256']:
            continue
        shutil.copyfile(source, destination/name)
        count += 1
        size += expected['size']
    return count, size


def install(root):
    cache = root/'devcel-apt-cache'
    destination = archive_directory()
    archives = None
    count = size = 0
    try:
        archives = json.loads((root/'devcel-apt-plan.json').read_text(encoding='utf-8'))
        count, size = restore_verified(cache, destination, archives)
    except (OSError, ValueError) as error:
        # A broken/missing cache must not block the normal package installation.
        print(f'::warning::APT cache unavailable; using normal downloads: {error}')
        destination = archive_directory()
        archives = None
        count = size = 0
    remaining = (sum(item['size'] for item in archives.values()) - size
                 if archives is not None else 'unknown')
    print(f"APT cache exact hit: {os.environ.get('APT_CACHE_HIT') or 'false'}; "
          f'reused {count} verified archives ({size} bytes); '
          f'planned download bytes: {remaining}', flush=True)
    # A hit never skips installation or dependency resolution. A private archive
    # path also avoids image cleanup hooks targeting /var/cache/apt/archives.
    subprocess.run([
        'sudo', 'apt-get', '-y', '-o', f'Dir::Cache::archives={destination}',
        '-o', 'APT::Keep-Downloaded-Packages=true', 'install', *PACKAGES,
    ], check=True)
    try:
        if cache.is_symlink():
            raise OSError('APT cache directory must not be a symlink')
        cache.mkdir(exist_ok=True)
        for previous in cache.glob('*.deb'):
            previous.unlink()
        files = list(destination.glob('*.deb'))
        for source in files:
            shutil.copyfile(source, cache/source.name)
        print(f'APT cache retained: {len(files)} archives '
              f'({sum(source.stat().st_size for source in files)} bytes)', flush=True)
        output('save', 'true' if files else 'false')
    except OSError as error:
        print(f'::warning::APT cache save unavailable: {error}')
        output('save', 'false')


if __name__ == '__main__':
    {'plan': plan, 'install': install}[sys.argv[1]](Path(os.environ['RUNNER_TEMP']))
