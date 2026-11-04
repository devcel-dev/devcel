#!/usr/bin/env python3
"""Collect read-only packaging evidence. Candidates are never review approvals."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

MAX_TEXT = 2 * 1024 * 1024

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def collect(root, native_files):
    documents = {}
    warnings = []
    def document(path):
        try:
            if not path.is_file(): return None
            size = path.stat().st_size
            key = digest(path)
            entry = {'sha256': key, 'size': size}
            if size <= MAX_TEXT:
                entry['text'] = path.read_bytes().decode('utf-8', errors='replace')
            else:
                entry['omitted_reason'] = 'Text exceeds 2 MiB evidence limit'
            documents.setdefault(key, entry)
            return key
        except (OSError, ValueError) as exc:
            warnings.append(f'{path}: {exc}')
            return None
    notices = []
    payload_files = []
    for path in sorted(root.rglob('*')):
        name = path.name.lower()
        if not path.is_file() or path.is_symlink(): continue
        payload_files.append({'path':path.relative_to(root).as_posix(),'sha256':digest(path),'size':path.stat().st_size})
        if any(word in name for word in ('license', 'licence', 'copyright', 'notice', 'copying')) or any(part.lower() in ('legal', 'licenses', 'licences') for part in path.relative_to(root).parts[:-1]):
            key = document(path)
            if key: notices.append({'payload_path': path.relative_to(root).as_posix(), 'sha256': key})
    result = {'evidence_only': True, 'payload_files': payload_files, 'payload_notices': notices, 'documents': documents,
              'native_provenance_candidates': [], 'warnings': warnings}
    if sys.platform == 'linux':
        result['system_common_licenses'] = [{'path':str(path),'document':document(path)}
            for path in sorted(Path('/usr/share/common-licenses').glob('*')) if path.is_file()]
        # File ownership comes from the runner's installed package database.
        # Matching names alone never establish binary identity: report full hashes.
        wanted = {Path(item['path']).name for item in native_files if 'first_party_identity' not in item}
        owners = {}
        for listing in sorted(Path('/var/lib/dpkg/info').glob('*.list')):
            try:
                for line in listing.read_text(errors='replace').splitlines():
                    if Path(line).name in wanted:
                        owners.setdefault(Path(line).name, []).append((listing.name[:-5], line))
            except OSError as exc: warnings.append(f'{listing}: {exc}')
        package_metadata = {}
        proc = subprocess.run(['dpkg-query', '-W', '-f', '${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n'],
                              capture_output=True, text=True)
        if proc.returncode:
            warnings.append('dpkg-query failed: ' + proc.stderr)
        else:
            for line in proc.stdout.splitlines():
                fields = line.split('\t')
                if len(fields) == 4:
                    package_metadata[fields[0]] = dict(zip(('package', 'version', 'source_package', 'source_version'), fields))
        for item in native_files:
            if 'first_party_identity' in item: continue
            matches = []
            for package, source_path in owners.get(Path(item['path']).name, []):
                path = Path(source_path)
                if not path.is_file(): continue
                try: source_hash = digest(path)
                except OSError as exc:
                    warnings.append(f'{path}: {exc}'); continue
                metadata = package_metadata.get(package, package_metadata.get(package.split(':')[0], {'package': package}))
                copyright_path = Path('/usr/share/doc') / package.split(':')[0] / 'copyright'
                matches.append({**metadata, 'installed_path': source_path, 'installed_sha256': source_hash,
                                'exact_hash_match': source_hash == item['sha256'],
                                'copyright_path': str(copyright_path), 'copyright_document': document(copyright_path)})
            result['native_provenance_candidates'].append({'payload_path': item['path'], 'sha256': item['sha256'], 'candidates': matches})
        result['system_release'] = Path('/etc/os-release').read_text() if Path('/etc/os-release').exists() else None
    elif sys.platform == 'win32':
        # Tauri keeps downloaded NSIS/WiX tools in its local data cache.
        caches = []
        for variable in ('LOCALAPPDATA', 'APPDATA'):
            value = os.environ.get(variable)
            if value:
                for suffix in ('tauri', 'tauri-bundler'):
                    candidate = Path(value) / suffix
                    if candidate.is_dir(): caches.append(candidate)
        result['tool_cache_evidence'] = []
        wanted = {Path(item['path']).name.lower() for item in native_files}
        for cache in caches:
            for path in sorted(cache.rglob('*')):
                if not path.is_file() or path.is_symlink(): continue
                name = path.name.lower()
                if name in wanted or any(word in name for word in ('license', 'licence', 'copyright', 'notice', 'copying')):
                    entry = {'cache': cache.name, 'path': path.relative_to(cache).as_posix(), 'sha256': digest(path)}
                    if name not in wanted: entry['document'] = document(path)
                    result['tool_cache_evidence'].append(entry)
    return result
