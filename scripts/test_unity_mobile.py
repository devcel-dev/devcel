"""Synthetic format/provenance tests, not mobile execution acceptance."""
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

import unity_mobile as mobile


def android_binary(alignment=16384, cpu=183, elf_class=2):
    data = bytearray(120)
    data[:6] = b'\x7fELF' + bytes([elf_class, 1])
    struct.pack_into('<HH', data, 16, 3, cpu)
    struct.pack_into('<Q' if elf_class == 2 else '<I', data, 32 if elf_class == 2 else 28, 64)
    struct.pack_into('<HH', data, 54 if elf_class == 2 else 42, 56 if elf_class == 2 else 32, 1)
    struct.pack_into('<I', data, 64, 1)
    struct.pack_into('<Q' if elf_class == 2 else '<I', data, 112 if elf_class == 2 else 92, alignment)
    return bytes(data)


def ios_binary(platform=2, cpu=0x0100000c):
    obj = struct.pack('<IIIIIIII', 0xfeedfacf, cpu, 0, 1, 1, 24, 0, 0)
    obj += struct.pack('<IIIIII', 0x32, 24, platform, 0x000d0000, 0x00120000, 0)
    header = b'test.o/         ' + b'0           ' + b'0     0     ' + b'100644  ' + str(len(obj)).encode().ljust(10) + b'`\n'
    assert len(header) == 60
    return b'!<arch>\n' + header + obj


def fixture(path, system):
    raw = android_binary() if system == 'android' else ios_binary()
    value = {'schema_version': 1, 'system': system, 'version': '0.1.0', 'source_commit': 'a'*40,
             'source_repository': 'owner/repo', 'source_fingerprint': 'b'*64,
             'target': mobile.TARGETS[system], 'path': mobile.PATHS[system],
             'sha256': hashlib.sha256(raw).hexdigest(), 'meta_sha256': hashlib.sha256(b'meta').hexdigest()}
    notices = {}
    if system == 'android':
        notices = {name: b'original NDK notice fixture' for name in mobile.NDK_NOTICES.values()}
        value.update(minimum_api=23, ndk=mobile.NDK_VERSION,
                     notice_hashes={name: hashlib.sha256(data).hexdigest() for name, data in notices.items()})
    else:
        value.update(minimum_os='13.0', link_flags=['-lSystem', '-liconv'])
    values = {**notices, mobile.PATHS[system]: raw, mobile.PATHS[system] + '.meta': b'meta'}
    if system == 'android':
        value['variants'] = {}
        for abi, (target, _, elf_class, cpu) in mobile.ANDROID_ABIS.items():
            binary = f'Plugins/Android/{abi}/libdevcel_runtime.so'
            contents = android_binary(cpu=cpu, elf_class=elf_class)
            values[binary], values[binary + '.meta'] = contents, b'meta'
            value['variants'][abi] = {'target': target, 'path': binary,
                                      'sha256': hashlib.sha256(contents).hexdigest(),
                                      'meta_sha256': hashlib.sha256(b'meta').hexdigest()}
    values.update({
              f'Tools~/Mobile/{system}.json': json.dumps(value).encode()}
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    write_zip(path, values)
    return values


def write_zip(path, values):
    with zipfile.ZipFile(path, 'w') as archive:
        for name, raw in values.items():
            archive.writestr(name, raw)


class MobileTests(unittest.TestCase):
    def test_ios_link_flags_allow_only_system_libraries_and_framework_names(self):
        self.assertTrue(mobile.valid_ios_flags(['-lSystem', '-liconv', '-framework', 'Security']))
        for flags in (None, [], ['-framework'], ['-framework', '../Bad'], ['-Wl,@file'], ['-lfoo;run'], [None]):
            with self.subTest(flags=flags):
                self.assertFalse(mobile.valid_ios_flags(flags))

    def test_cpu_platform_alignment_and_truncation(self):
        mobile.check_binary(android_binary(), 'android')
        mobile.check_binary(android_binary(cpu=40, elf_class=1), 'android', 'armeabi-v7a')
        mobile.check_binary(android_binary(cpu=3, elf_class=1), 'android', 'x86')
        mobile.check_binary(android_binary(cpu=62), 'android', 'x86_64')
        mobile.check_binary(ios_binary(), 'ios')
        for system, data in [('android', android_binary(4096)), ('android', android_binary(cpu=62)),
                             ('ios', ios_binary(platform=7)), ('ios', ios_binary(cpu=0x01000007)),
                             ('android', android_binary()[:-1]), ('ios', ios_binary()[:-1])]:
            with self.subTest(system=system, data=data[:10]), self.assertRaises(ValueError):
                mobile.check_binary(data, system)
        with self.assertRaises(ValueError):
            mobile.check_binary(android_binary(cpu=40, elf_class=1), 'android', 'arm64-v8a')

    def test_both_artifacts_validate_exact_identity_and_payloads(self):
        for system in mobile.PATHS:
            with self.subTest(system=system), tempfile.TemporaryDirectory() as temp:
                path = Path(temp)/'runtime.zip'
                values = fixture(path, system)
                loaded, runtime = mobile.load(path, system, '0.1.0', 'a'*40, 'owner/repo', 'b'*64)
                self.assertEqual(loaded, values)
                self.assertIn(mobile.PATHS[system], {item['path'] for item in runtime})
                for version, commit, repo, fingerprint in [('0.2.0', 'a'*40, 'owner/repo', 'b'*64),
                        ('0.1.0', 'c'*40, 'owner/repo', 'b'*64), ('0.1.0', 'a'*40, 'other/repo', 'b'*64),
                        ('0.1.0', 'a'*40, 'owner/repo', 'c'*64)]:
                    with self.assertRaises(ValueError):
                        mobile.load(path, system, version, commit, repo, fingerprint)
                values[mobile.PATHS[system]] += b'tamper'
                write_zip(path, values)
                with self.assertRaisesRegex(ValueError, 'hash'):
                    mobile.load(path, system, '0.1.0', 'a'*40, 'owner/repo', 'b'*64)

    def test_missing_notices_and_foreign_entries_are_rejected(self):
        for remove in (True, False):
            with tempfile.TemporaryDirectory() as temp:
                path = Path(temp)/'runtime.zip'
                values = fixture(path, 'android')
                if remove:
                    del values[next(iter(mobile.NDK_NOTICES.values()))]
                else:
                    values['../unexpected'] = b'bad'
                write_zip(path, values)
                with self.assertRaises(ValueError):
                    mobile.load(path, 'android', '0.1.0', 'a'*40, 'owner/repo', 'b'*64)

    def test_missing_or_mismatched_android_abi_is_rejected(self):
        for kind in ('missing', 'wrong_cpu', 'wrong_meta'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp:
                path = Path(temp)/'runtime.zip'
                values = fixture(path, 'android')
                name = 'Plugins/Android/x86_64/libdevcel_runtime.so'
                if kind == 'missing':
                    del values[name]
                elif kind == 'wrong_meta':
                    values[name + '.meta'] = b'tampered'
                else:
                    values[name] = android_binary(cpu=183)
                    meta_name = 'Tools~/Mobile/android.json'
                    meta = json.loads(values[meta_name])
                    meta['variants']['x86_64']['sha256'] = hashlib.sha256(values[name]).hexdigest()
                    values[meta_name] = json.dumps(meta).encode()
                write_zip(path, values)
                with self.assertRaises(ValueError):
                    mobile.load(path, 'android', '0.1.0', 'a'*40, 'owner/repo', 'b'*64)


if __name__ == '__main__':
    unittest.main()
