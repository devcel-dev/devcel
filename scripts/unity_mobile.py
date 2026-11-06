"""Build pinned Android ABI and iOS device runtimes and verify release inputs.

Internal CI archives are combined with the licensed desktop Unity distribution
by unity_upm.py; they are not standalone user installation packages.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import struct
import subprocess
import sys
import zipfile

from product_version import read_version
from unity_toolchain import fingerprint
import release_privacy

ROOT = Path(__file__).resolve().parents[1]
NDK_VERSION = '28.2.13676358'
PATHS = {'android': 'Plugins/Android/arm64-v8a/libdevcel_runtime.so',
         'ios': 'Plugins/iOS/libdevcel_runtime.a'}
TARGETS = {'android': 'aarch64-linux-android', 'ios': 'aarch64-apple-ios'}
ANDROID_ABIS = {
    'arm64-v8a': ('aarch64-linux-android', 'aarch64-linux-android23-clang', 2, 183),
    'armeabi-v7a': ('armv7-linux-androideabi', 'armv7a-linux-androideabi23-clang', 1, 40),
    'x86': ('i686-linux-android', 'i686-linux-android23-clang', 1, 3),
    'x86_64': ('x86_64-linux-android', 'x86_64-linux-android23-clang', 2, 62),
}
NDK_NOTICES = {'NOTICE': 'ThirdPartyNotices/AndroidNDK-NOTICE.txt',
               'NOTICE.toolchain': 'ThirdPartyNotices/AndroidNDK-NOTICE-toolchain.txt'}


def valid_ios_flags(flags):
    if not isinstance(flags, list) or not flags:
        return False
    index = 0
    while index < len(flags):
        flag = flags[index]
        if not isinstance(flag, str):
            return False
        if re.fullmatch(r'-l[A-Za-z0-9_]+', flag):
            index += 1
        elif flag == '-framework' and index + 1 < len(flags) and isinstance(flags[index + 1], str) and re.fullmatch(r'[A-Za-z0-9_]+', flags[index + 1]):
            index += 2
        else:
            return False
    return True


def check_binary(raw, system, abi='arm64-v8a'):
    if system == 'android':
        _, _, elf_class, machine = ANDROID_ABIS[abi]
        if len(raw) < 64 or raw[:6] != b'\x7fELF' + bytes([elf_class, 1]) or struct.unpack_from('<HH', raw, 16) != (3, machine):
            raise ValueError('Android runtime has the wrong ELF class or CPU for ' + abi)
        offset = struct.unpack_from('<Q' if elf_class == 2 else '<I', raw, 32 if elf_class == 2 else 28)[0]
        size, count = struct.unpack_from('<HH', raw, 54 if elf_class == 2 else 42)
        if size < (56 if elf_class == 2 else 32) or not count or offset + size * count > len(raw):
            raise ValueError('Invalid Android program headers')
        loads = 0
        for i in range(count):
            header = offset + i * size
            if struct.unpack_from('<I', raw, header)[0] != 1:
                continue
            loads += 1
            file_offset, address = struct.unpack_from('<QQ' if elf_class == 2 else '<II', raw, header + (8 if elf_class == 2 else 4))
            alignment = struct.unpack_from('<Q' if elf_class == 2 else '<I', raw, header + (48 if elf_class == 2 else 28))[0]
            if alignment < 16384 or alignment & (alignment - 1) or file_offset % 16384 != address % 16384:
                raise ValueError('Android runtime requires 16 KB compatible PT_LOAD segments')
        if not loads:
            raise ValueError('Android runtime has no load segments')
    else:
        if not raw.startswith(b'!<arch>\n'):
            raise ValueError('iOS runtime must be a static archive')
        offset, device = 8, False
        while offset < len(raw):
            if offset + 60 > len(raw) or raw[offset + 58:offset + 60] != b'`\n':
                raise ValueError('Invalid iOS archive member')
            name = raw[offset:offset + 16].decode('ascii').strip()
            size = int(raw[offset + 48:offset + 58])
            start, end = offset + 60, offset + 60 + size
            if size < 0 or end > len(raw):
                raise ValueError('Truncated iOS archive')
            if name.startswith('#1/'):
                start += int(name[3:])
            if start > end:
                raise ValueError('Invalid iOS archive name')
            if raw[start:start + 4] == b'\xcf\xfa\xed\xfe':
                if end - start < 32:
                    raise ValueError('Truncated Mach-O header')
                cpu, _, kind, count, size_of_commands = struct.unpack_from('<IIIII', raw, start + 4)
                if cpu != 0x0100000c or kind != 1:
                    raise ValueError('iOS archive requires ARM64 object files')
                command, commands_end = start + 32, start + 32 + size_of_commands
                if commands_end > end or count > size_of_commands // 8:
                    raise ValueError('Invalid iOS load commands')
                for _ in range(count):
                    if command + 8 > commands_end:
                        raise ValueError('Truncated iOS load command')
                    kind, command_size = struct.unpack_from('<II', raw, command)
                    if command_size < 8 or command + command_size > commands_end:
                        raise ValueError('Invalid iOS load command size')
                    if kind == 0x32:
                        if command_size < 24 or struct.unpack_from('<I', raw, command + 8)[0] != 2:
                            raise ValueError('iOS Simulator/macOS objects cannot be used for devices')
                        device = True
                    elif kind == 0x25:
                        device = True
                    elif kind in (0x24, 0x2f, 0x30):
                        raise ValueError('Not an iOS device object')
                    command += command_size
            offset = end + (size & 1)
        if offset != len(raw) or not device:
            raise ValueError('No iOS device object found')


def load(path, system, version, commit, repository, source_fingerprint):
    """Validate provenance before admitting any mobile bytes into a UPM package."""
    binary = PATHS[system]
    metadata = f'Tools~/Mobile/{system}.json'
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        binaries = ([f'Plugins/Android/{abi}/libdevcel_runtime.so' for abi in ANDROID_ABIS]
                    if system == 'android' else [binary])
        expected = {metadata} | {item + suffix for item in binaries for suffix in ('', '.meta')} | (set(NDK_NOTICES.values()) if system == 'android' else set())
        if len(names) != len(expected) or set(names) != expected:
            raise ValueError('Unexpected mobile artifact contents')
        if any(entry.file_size > 256 * 1024 * 1024 or (entry.external_attr >> 16) & 0o170000 == 0o120000 for entry in archive.infolist()):
            raise ValueError('Oversized or linked mobile payload')
        contents = {name: archive.read(name) for name in names}
    value = json.loads(contents[metadata])
    if (value.get('schema_version') != 1 or value.get('version') != version or
            value.get('source_commit') != commit or value.get('source_repository') != repository or
            value.get('source_fingerprint') != source_fingerprint or value.get('system') != system or
            value.get('target') != TARGETS[system] or value.get('path') != binary or
            value.get('sha256') != hashlib.sha256(contents[binary]).hexdigest() or
            value.get('meta_sha256') != hashlib.sha256(contents[binary + '.meta']).hexdigest()):
        raise ValueError('Mobile runtime source/version/hash mismatch')
    if system == 'android' and (value.get('minimum_api') != 23 or value.get('ndk') != NDK_VERSION):
        raise ValueError('Android build requirements mismatch')
    if system == 'android':
        variants = value.get('variants', {})
        if set(variants) != set(ANDROID_ABIS):
            raise ValueError('Android ABI list mismatch')
        for abi, (target, _, _, _) in ANDROID_ABIS.items():
            path = f'Plugins/Android/{abi}/libdevcel_runtime.so'
            item = variants[abi]
            if (item.get('target') != target or item.get('path') != path or
                    item.get('sha256') != hashlib.sha256(contents[path]).hexdigest() or
                    item.get('meta_sha256') != hashlib.sha256(contents[path + '.meta']).hexdigest()):
                raise ValueError('Android ABI source/hash mismatch: ' + abi)
            check_binary(contents[path], system, abi)
        for name in NDK_NOTICES.values():
            if not contents[name] or value.get('notice_hashes', {}).get(name) != hashlib.sha256(contents[name]).hexdigest():
                raise ValueError('Android NDK original notice missing or changed')
    if system == 'ios' and (value.get('minimum_os') != '13.0' or not valid_ios_flags(value.get('link_flags'))):
        raise ValueError('Invalid iOS link requirements')
    if system == 'ios':
        check_binary(contents[binary], system)
    return contents, ([{'path': item['path'], 'sha256': item['sha256']} for item in value['variants'].values()]
                      if system == 'android' else [{'path': binary, 'sha256': value['sha256']}])


def run(*command, env=None):
    result = subprocess.run(list(map(str, command)), cwd=ROOT, env=env,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        print(result.stdout + result.stderr, file=sys.stderr)
        result.check_returncode()
    return result.stdout + result.stderr


def build(system, out, repository, commit, ndk=None):
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
        raise ValueError('Explicit source repository and full commit required')
    if run('git', 'rev-parse', 'HEAD').strip() != commit or run('git', 'status', '--porcelain', '--untracked-files=no').strip():
        raise ValueError('Mobile runtimes must be built from the clean recorded commit')
    if (system == 'ios' and platform.system() != 'Darwin') or (system == 'android' and platform.system() not in ('Linux', 'Darwin', 'Windows')):
        raise ValueError('iOS runtimes require macOS and Xcode')
    release_privacy.configure(ROOT)
    env = dict(os.environ)
    target = TARGETS[system]
    flags = env.get('CARGO_ENCODED_RUSTFLAGS', '').split('\x1f')
    value = {'schema_version': 1, 'system': system, 'version': read_version(ROOT),
             'source_repository': repository, 'source_commit': commit,
             'source_fingerprint': fingerprint(ROOT), 'target': target, 'path': PATHS[system],
             'rustc': run('rustc', '--version').strip()}
    notices = {}
    if system == 'android':
        ndk = Path(ndk or os.environ.get('ANDROID_NDK_HOME', ''))
        if not (ndk/'source.properties').is_file() or not re.search(r'^Pkg.Revision\s*=\s*' + re.escape(NDK_VERSION) + r'\s*$', (ndk/'source.properties').read_text(), re.M):
            raise ValueError('Android NDK ' + NDK_VERSION + ' required (--ndk or ANDROID_NDK_HOME)')
        host = {'Linux': 'linux-x86_64', 'Darwin': 'darwin-x86_64', 'Windows': 'windows-x86_64'}[platform.system()]
        linker = ndk/'toolchains/llvm/prebuilt'/host/'bin'/('aarch64-linux-android23-clang.cmd' if platform.system() == 'Windows' else 'aarch64-linux-android23-clang')
        if not linker.is_file():
            raise ValueError('NDK ARM64 API 23 linker missing')
        env['CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER'] = str(linker.resolve())
        flags += ['-C', 'link-arg=-Wl,-z,max-page-size=16384']
        value.update(minimum_api=23, ndk=NDK_VERSION)
        notices = {output: (ndk/original).read_bytes() for original, output in NDK_NOTICES.items()}
        value['notice_hashes'] = {name: hashlib.sha256(data).hexdigest() for name, data in notices.items()}
    else:
        env['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
        env['SDKROOT'] = run('xcrun', '--sdk', 'iphoneos', '--show-sdk-path').strip()
        value.update(minimum_os='13.0', xcode=run('xcodebuild', '-version').strip())
    env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(filter(None, flags))
    command = ['cargo', 'rustc', '--locked', '--release', '--lib', '-p', 'devcel-runtime', '--target', target,
               '--crate-type', 'staticlib' if system == 'ios' else 'cdylib']
    if system == 'ios':
        command += ['--', '--print', 'native-static-libs']
    log = run(*command, env=env)
    if system == 'ios':
        matches = re.findall(r'native-static-libs:\s*([^\r\n]+)', log)
        if not matches:
            raise ValueError('rustc did not report static library link requirements')
        value['link_flags'] = matches[-1].split()
    output_root = Path(json.loads(run('cargo', 'metadata', '--format-version', '1', '--no-deps', '--locked'))['target_directory'])
    binary = output_root/target/'release'/Path(PATHS[system]).name
    raw = binary.read_bytes()
    check_binary(raw, system)
    meta = (ROOT/'importers/unity-template/Tools~/NativePluginMetadata'/Path(PATHS[system]).relative_to('Plugins')).with_suffix(binary.suffix + '.meta').read_bytes()
    value.update(sha256=hashlib.sha256(raw).hexdigest(), meta_sha256=hashlib.sha256(meta).hexdigest())
    payload = {PATHS[system]: raw, PATHS[system] + '.meta': meta}
    if system == 'android':
        value['variants'] = {}
        for abi, (abi_target, clang, _, _) in ANDROID_ABIS.items():
            abi_path = f'Plugins/Android/{abi}/libdevcel_runtime.so'
            if abi != 'arm64-v8a':
                abi_linker = ndk/'toolchains/llvm/prebuilt'/host/'bin'/(clang + ('.cmd' if platform.system() == 'Windows' else ''))
                if not abi_linker.is_file():
                    raise ValueError('NDK linker missing for ' + abi)
                env['CARGO_TARGET_' + abi_target.upper().replace('-', '_') + '_LINKER'] = str(abi_linker.resolve())
                run('cargo', 'rustc', '--locked', '--release', '--lib', '-p', 'devcel-runtime', '--target', abi_target,
                    '--crate-type', 'cdylib', env=env)
                raw = (output_root/abi_target/'release'/'libdevcel_runtime.so').read_bytes()
                meta = (ROOT/'importers/unity-template/Tools~/NativePluginMetadata/Android'/abi/'libdevcel_runtime.so.meta').read_bytes()
            check_binary(raw, system, abi)
            payload[abi_path] = raw
            payload[abi_path + '.meta'] = meta
            value['variants'][abi] = {'target': abi_target, 'path': abi_path,
                                      'sha256': hashlib.sha256(raw).hexdigest(),
                                      'meta_sha256': hashlib.sha256(meta).hexdigest()}
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    destination = out/f'unity-mobile-{system}.zip'
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in {**notices, **payload,
                           f'Tools~/Mobile/{system}.json': (json.dumps(value, indent=2)+'\n').encode()}.items():
            entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)
    load(destination, system, value['version'], commit, repository, value['source_fingerprint'])
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--system', required=True, choices=PATHS)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--ndk', type=Path)
    parser.add_argument('--source-repository', required=True)
    parser.add_argument('--source-commit', required=True)
    args = parser.parse_args()
    print(build(args.system, args.out, args.source_repository, args.source_commit, args.ndk))
