"""Create a self-contained UPM tarball from a generated Unity distribution ZIP.

No downloads or native execution. Preserve every package byte, including licenses,
native plugin metadata, matching source, and generated version requirements.
"""
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import zipfile
import unity_mobile


RUNTIMES = {
    'win-x64': 'Plugins/Windows/x86_64/devcel_runtime.dll',
    'linux-x64': 'Plugins/Linux/x86_64/libdevcel_runtime.so',
    'osx-x64': 'Plugins/macOS/libdevcel_runtime.dylib',
    'osx-arm64': 'Plugins/macOS/libdevcel_runtime.dylib',
}
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?')


def package_entries(archive):
    entries = {}
    for entry in archive.infolist():
        name = entry.filename
        parts = PurePosixPath(name).parts
        if ('\\' in name or ':' in name or name.startswith('/') or
                any(part in ('', '.', '..') for part in name.rstrip('/').split('/')) or
                stat.S_ISLNK(entry.external_attr >> 16)):
            raise ValueError('Unsafe Unity ZIP entry')
        if entry.is_dir() or name == 'INSTALL.txt':
            continue
        if not parts or parts[0] != 'devcel-unity' or len(parts) < 2:
            raise ValueError('Unexpected Unity ZIP root')
        relative = '/'.join(parts[1:])
        if relative in entries:
            raise ValueError('Duplicate Unity ZIP entry')
        entries[relative] = entry
    return entries


def validate(archive, entries, version, platform):
    def document(name):
        if name not in entries or entries[name].file_size > 1024 * 1024:
            raise ValueError('Missing or oversized UPM metadata: ' + name)
        return json.loads(archive.read(entries[name]))

    def hashed(name, expected):
        if name not in entries or not re.fullmatch(r'[0-9a-f]{64}', expected or ''):
            raise ValueError('Missing UPM payload or SHA-256: ' + name)
        with archive.open(entries[name]) as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                raise ValueError('UPM payload checksum mismatch: ' + name)

    package = document('package.json')
    manifest = document('Tools~/manifest.json')
    required = document('Editor/NativeRequirements.json')
    if (package.get('name') != 'org.devcel.unity' or package.get('version') != version or
            manifest.get('schema_version') != 1 or manifest.get('version') != version or
            manifest.get('supportedPlatforms') != [platform] or
            required.get('schema_version') != 1 or
            not re.fullmatch(r'[0-9a-f]{64}', required.get('source_fingerprint', '')) or
            required['source_fingerprint'] != manifest.get('source_fingerprint')):
        raise ValueError('UPM version/platform/native source mismatch')
    cli = manifest.get('binaries', {}).get(platform, {})
    cli_path = platform + ('/devcel.exe' if platform == 'win-x64' else '/devcel')
    native = manifest.get('native_runtime', {})
    if cli.get('path') != cli_path or native.get('path') != RUNTIMES[platform]:
        raise ValueError('UPM native payload path mismatch')
    hashed('Tools~/' + cli_path, cli.get('sha256'))
    hashed(RUNTIMES[platform], native.get('sha256'))
    hashed('Tools~/cli-source.tar.gz', manifest.get('source_sha256'))
    for name in ('LICENSE', 'Tools~/LICENSE-CLI-MIT.txt',
                 'ThirdPartyNotices/THIRD-PARTY-NOTICES.txt', RUNTIMES[platform] + '.meta',
                 'Editor/Devcel.Unity.Editor.asmdef', 'Runtime/Devcel.Unity.Runtime.asmdef'):
        if name not in entries:
            raise ValueError('Missing UPM package file: ' + name)


def create(source, destination, version, platform, mobile_archives=None):
    """Return a deterministic tarball path; never overwrite an existing artifact."""
    if not VERSION.fullmatch(version) or platform not in RUNTIMES:
        raise ValueError('Invalid UPM version/platform')
    destination = Path(destination)
    target = destination / f'org.devcel.unity-{version}-{platform}.tgz'
    with zipfile.ZipFile(source) as archive:
        entries = package_entries(archive)
        validate(archive, entries, version, platform)
        additions = {}
        if mobile_archives is not None:
            if set(mobile_archives) != {'android', 'ios'}:
                raise ValueError('Both Android and iOS runtime archives are required')
            manifest = json.loads(archive.read(entries['Tools~/manifest.json']))
            manifest['player_runtimes'] = []
            for system, mobile_archive in mobile_archives.items():
                contents, runtime = unity_mobile.load(mobile_archive, system, version,
                    manifest['source_commit'], manifest['source_repository'], manifest['source_fingerprint'])
                if set(contents) & (set(entries) | set(additions)):
                    raise ValueError('Mobile payload collides with an existing package file')
                additions.update(contents)
                manifest['player_runtimes'].extend(runtime)
            additions['Tools~/manifest.json'] = (json.dumps(manifest, indent=2)+'\n').encode()
        destination.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as output:
            try:
                # Fixed timestamp and empty gzip filename make recovery reproducible.
                with gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as compressed:
                    with tarfile.open(fileobj=compressed, mode='w') as tar:
                        for name in sorted(set(entries) | set(additions)):
                            info = tarfile.TarInfo('package/' + name)
                            info.size = len(additions[name]) if name in additions else entries[name].file_size
                            info.mode = 0o755 if name.endswith(('/devcel', '/devcel.exe', '.sh', '.command')) else 0o644
                            with (io.BytesIO(additions[name]) if name in additions else archive.open(entries[name])) as data:
                                tar.addfile(info, data)
            except BaseException:
                output.close()
                target.unlink()
                raise
    return target


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('zip', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--platform', required=True, choices=RUNTIMES)
    parser.add_argument('--mobile-android', type=Path)
    parser.add_argument('--mobile-ios', type=Path)
    args = parser.parse_args()
    mobile = {'android': args.mobile_android, 'ios': args.mobile_ios} if args.mobile_android and args.mobile_ios else None
    if bool(args.mobile_android) != bool(args.mobile_ios):
        parser.error('Supply both mobile runtime archives')
    print(create(args.zip, args.out, args.version, args.platform, mobile))
