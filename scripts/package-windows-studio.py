#!/usr/bin/env python3
"""Build a Windows x64 portable ZIP from explicit release inputs."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import time
import shutil
import tempfile
from pathlib import Path
import re
import stat
import struct
import zipfile
import studio_cli

from legal_distribution import distribution_files

ROOT = Path(__file__).resolve().parents[1]
# Windows OS libraries only. WebView2Loader and the VC redistributable must not
# become dynamic dependencies of this distribution without a packaging review.
# ComBase.dll is the OS Windows Runtime library (Windows 8+):
# https://learn.microsoft.com/en-us/windows/win32/api/winstring/nf-winstring-windowsinspectstring2
SYSTEM_DLLS = set('''advapi32 avrt bcrypt bcryptprimitives cabinet cfgmgr32 combase comctl32
comdlg32 crypt32 cryptbase cryptsp d2d1 d3d11 d3d12 dcomp dbghelp dnsapi dwmapi
 dwrite dxgi gdi32 gdi32full hid imm32 iphlpapi kernel32 kernelbase mpr msimg32
 ncrypt netapi32 ntdll ole32 oleacc oleaut32 opengl32 powrprof propsys psapi
 rpcrt4 secur32 setupapi shell32 shlwapi sspicli ucrtbase user32 userenv usp10
 uxtheme version wer winhttp wininet winmm winspool wintrust wldap32 ws2_32
 wtsapi32 normaliz shcore windowscodecs urlmon win32u'''.split())


def pe_imports(data):
    """Read normal and delay-load imports of a PE32+ x64 image without executing it."""
    def unpack(fmt, offset):
        try: return struct.unpack_from(fmt, data, offset)
        except struct.error as exc: raise ValueError('Truncated PE image') from exc
    if data[:2] != b'MZ': raise ValueError('Studio is not a Windows executable')
    pe, = unpack('<I', 0x3c)
    if data[pe:pe+4] != b'PE\0\0': raise ValueError('Invalid PE signature')
    machine, count, _, _, _, size, _ = unpack('<HHIIIHH', pe+4)
    optional = pe+24
    magic, = unpack('<H', optional)
    if machine != 0x8664 or magic != 0x20b or size < 112 or not 1 <= count <= 96:
        raise ValueError('Expected a Windows x64 PE32+ image')
    image_base, = unpack('<Q', optional+24)
    directory_count, = unpack('<I', optional+108)
    if directory_count > (size-112)//8: raise ValueError('Invalid PE directory count')
    sections = []
    for i in range(count):
        pos = optional+size+i*40
        virtual_size, rva, raw_size, raw_offset = unpack('<IIII', pos+8)
        if raw_offset+raw_size > len(data): raise ValueError('Truncated PE section')
        sections.append((rva, raw_size, raw_offset))
    def file_offset(rva, size=1):
        for start, length, raw in sections:
            if start <= rva and rva+size <= start+length:
                return raw+rva-start
        raise ValueError('PE import points outside file-backed sections')
    def dll_name(rva):
        start = file_offset(rva)
        end = data.find(b'\0', start, min(len(data), start+260))
        if end < 0: raise ValueError('Unterminated PE DLL name')
        try: name = data[start:end].decode('ascii').lower()
        except UnicodeError as exc: raise ValueError('Invalid PE DLL name') from exc
        if not re.fullmatch(r'[a-z0-9_.-]+\.dll', name): raise ValueError('Invalid PE DLL name')
        return name
    imports = set()
    for index, width in ((1, 20), (13, 32)):
        if index >= directory_count: continue
        rva, length = unpack('<II', optional+112+index*8)
        if not rva and not length: continue
        if not rva or length < width: raise ValueError('Invalid PE import directory')
        offset = file_offset(rva, length)
        terminated = False
        for pos in range(offset, offset+length-width+1, width):
            entry = unpack('<'+'I'*(width//4), pos)
            if not any(entry): terminated = True; break
            name_rva = entry[3] if index == 1 else entry[1]
            if index == 13:
                if entry[0] & ~1: raise ValueError('Unsupported delay import attributes')
                if not entry[0] & 1: name_rva -= image_base
            imports.add(dll_name(name_rva))
        if not terminated: raise ValueError('Unterminated PE import directory')
    if not imports: raise ValueError('No PE imports found')
    unknown = [name for name in sorted(imports)
               if name[:-4] not in SYSTEM_DLLS and not re.fullmatch(r'(?:api|ext)-ms-win-[a-z0-9-]+\.dll', name)]
    if unknown: raise ValueError('Unreviewed external runtime DLLs: '+', '.join(unknown))
    return sorted(imports)


def inputs(executable, repo=ROOT):
    config = json.loads((repo/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
    if config['bundle'].get('resources') != {'../../third-party/generated/THIRD-PARTY-NOTICES.txt': 'legal/THIRD-PARTY-NOTICES.txt'}:
        raise ValueError('Portable resource mapping requires review')
    if config['bundle'].get('externalBin'):
        raise ValueError('Portable sidecars require review')
    files = {'devcel-studio.exe': executable,
             'LICENSE-STUDIO.txt': repo/'devcel-studio/LICENSE',
             'LICENSE-NOTICE': repo/'LICENSE-NOTICE',
             'README.txt': repo/'devcel-studio/PORTABLE-WINDOWS.txt'}
    cli_root = repo/studio_cli.DIRECTORY
    studio_cli.validate(cli_root, 'win-x64')
    for name in ('devcel.exe', 'manifest.json', 'LICENSE-CLI.txt'):
        files['bin/'+name] = cli_root/name
    legal = repo/'third-party/generated'
    for name, source in distribution_files(legal).items(): files['legal/'+name] = source
    if len({name.casefold() for name in files}) != len(files):
        raise ValueError('Portable input names collide on Windows')
    for name, source in files.items():
        if source.is_symlink() or not source.is_file(): raise ValueError('Missing/linked portable input: '+name)
    return files


def verify_archive(archive, executable, repo=ROOT):
    expected = inputs(executable, repo)
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)) or set(names) != set(expected):
            raise ValueError('Portable ZIP file list differs from the explicit payload')
        for entry in entries:
            if stat.S_ISLNK(entry.external_attr >> 16) or entry.is_dir() or entry.flag_bits & 1:
                raise ValueError('Unexpected ZIP entry: '+entry.filename)
            # Byte equality covers EXE, licenses, readme and every resource. It
            # accepts neither CRLF normalization nor installer bundle patching.
            if package.read(entry) != expected[entry.filename].read_bytes():
                raise ValueError('Portable ZIP bytes differ: '+entry.filename)
        imports = pe_imports(package.read('devcel-studio.exe'))
        pe_imports(package.read('bin/devcel.exe'))
    return {'format': 'windows-portable-zip', 'payload_files': len(expected),
            'exe_sha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
            'external_system_dlls': imports, 'webview2_runtime_requirement': 'Evergreen Runtime required on host; availability not tested by this checker'}


def verify_directory(directory, executable, repo=ROOT):
    expected = inputs(executable, repo)
    actual = {}
    for path in directory.rglob('*'):
        if path.is_symlink(): raise ValueError('Linked portable output')
        if path.is_file(): actual[path.relative_to(directory).as_posix()] = path
    if set(actual) != set(expected): raise ValueError('Portable directory file list differs')
    for name, source in expected.items():
        if actual[name].read_bytes() != source.read_bytes():
            raise ValueError('Portable directory bytes differ: ' + name)
    pe_imports(actual['bin/devcel.exe'].read_bytes())
    return {'format': 'windows-portable-directory', 'payload_files': len(expected),
            'exe_sha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
            'external_system_dlls': pe_imports(actual['devcel-studio.exe'].read_bytes())}


def package(executable, archive, repo=ROOT, *, output_format='zip', build_epoch=None):
    build_epoch = int(time.time()) if build_epoch is None else int(build_epoch)
    if not 315532800 <= build_epoch <= 4354819198: raise ValueError('Build timestamp outside ZIP range')
    if output_format == 'directory':
        expected = inputs(executable, repo)
        archive.parent.mkdir(parents=True, exist_ok=True)
        if archive.exists(): raise ValueError('Output directory already exists')
        with tempfile.TemporaryDirectory(prefix='.studio-stage-', dir=archive.parent) as scratch:
            stage = Path(scratch) / 'payload'; stage.mkdir()
            for name, source in expected.items():
                destination = stage / name; destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
            for path in sorted(stage.rglob('*'), reverse=True): os.utime(path, (build_epoch, build_epoch))
            os.utime(stage, (build_epoch, build_epoch))
            report = {'format': 'windows-portable-directory', 'payload_files': len(expected)}
            stage.rename(archive)
        report['build_epoch'] = build_epoch
        return report
    expected = inputs(executable, repo)
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix('.zip.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as output:
            for name, source in sorted(expected.items()):
                entry = zipfile.ZipInfo(name, time.gmtime(build_epoch)[:6])
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = (stat.S_IFREG | 0o644) << 16
                output.writestr(entry, source.read_bytes())
        report = {'format': 'windows-portable-zip', 'payload_files': len(expected)}
        temporary.replace(archive)
        os.utime(archive, (build_epoch, build_epoch))
        report['build_epoch'] = build_epoch
        return report
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--format', choices=('zip', 'directory'), default='zip')
    parser.add_argument('--build-epoch', type=int)
    args = parser.parse_args()
    print(json.dumps(package(args.executable, args.out, output_format=args.format, build_epoch=args.build_epoch), indent=2))


if __name__ == '__main__': main()
