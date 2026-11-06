"""Archive contract checks only; synthetic bytes do not establish Unity support."""
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

import unity_upm
from test_unity_mobile import fixture as mobile_fixture


def fixture_entries(platform, version='0.1.0'):
    cli = platform + ('/devcel.exe' if platform == 'win-x64' else '/devcel')
    native = unity_upm.RUNTIMES[platform]
    digest = lambda value: hashlib.sha256(value).hexdigest()
    manifest = {'schema_version': 1, 'version': version, 'source_commit': 'a'*40,
                'source_repository': 'owner/repo', 'supportedPlatforms': [platform],
                'source_fingerprint': 'b'*64, 'source_sha256': digest(b'source'),
                'binaries': {platform: {'path': cli, 'sha256': digest(b'cli')}},
                'native_runtime': {'path': native, 'sha256': digest(b'native')}}
    values = {'package.json': json.dumps({'name': 'org.devcel.unity', 'version': version}).encode(),
              'Tools~/manifest.json': json.dumps(manifest).encode(),
              'Editor/NativeRequirements.json': json.dumps({'schema_version': 1, 'source_fingerprint': 'b'*64}).encode(),
              'Tools~/' + cli: b'cli', native: b'native', native + '.meta': b'plugin metadata',
              'Tools~/cli-source.tar.gz': b'source', 'LICENSE': b'license',
              'Tools~/LICENSE-CLI-MIT.txt': b'cli license',
              'ThirdPartyNotices/THIRD-PARTY-NOTICES.txt': b'notices',
              'Editor/Devcel.Unity.Editor.asmdef': b'{}',
              'Runtime/Devcel.Unity.Runtime.asmdef': b'{}'}
    return {'devcel-unity/' + name: raw for name, raw in values.items()}


def write_zip(path, values):
    with zipfile.ZipFile(path, 'w') as archive:
        for name, raw in values.items():
            archive.writestr(name, raw)


class UpmTests(unittest.TestCase):
    def test_mobile_payloads_augment_each_editor_without_replacing_its_runtime(self):
        for platform in unity_upm.RUNTIMES:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                values = fixture_entries(platform)
                write_zip(root/'source.zip', values)
                mobile = {system: root/(system+'.zip') for system in ('android', 'ios')}
                for system, path in mobile.items():
                    mobile_fixture(path, system)
                package = unity_upm.create(root/'source.zip', root, '0.1.0', platform, mobile)
                with tarfile.open(package) as archive:
                    manifest = json.load(archive.extractfile('package/Tools~/manifest.json'))
                    self.assertEqual(manifest['native_runtime']['path'], unity_upm.RUNTIMES[platform])
                    self.assertEqual({x['path'] for x in manifest['player_runtimes']},
                                     {f'Plugins/Android/{abi}/libdevcel_runtime.so' for abi in unity_upm.unity_mobile.ANDROID_ABIS} | {'Plugins/iOS/libdevcel_runtime.a'})
                    self.assertIn('package/ThirdPartyNotices/AndroidNDK-NOTICE.txt', archive.getnames())

    def test_all_platforms_preserve_every_byte_and_use_upm_root(self):
        for platform in unity_upm.RUNTIMES:
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                values = fixture_entries(platform)
                values['INSTALL.txt'] = b'outer instructions'
                write_zip(root/'source.zip', values)
                first = unity_upm.create(root/'source.zip', root/'first', '0.1.0', platform)
                second = unity_upm.create(root/'source.zip', root/'second', '0.1.0', platform)
                self.assertEqual(first.read_bytes(), second.read_bytes())
                with tarfile.open(first, 'r:gz') as archive:
                    actual = {member.name: archive.extractfile(member).read() for member in archive}
                    self.assertEqual(actual, {'package/' + name.removeprefix('devcel-unity/'): raw
                                             for name, raw in values.items() if name != 'INSTALL.txt'})
                    for member in archive:
                        self.assertTrue(member.isfile())
                        self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 0))
                        if member.name.endswith(('/devcel', '/devcel.exe')):
                            self.assertEqual(member.mode, 0o755)
                with self.assertRaises(FileExistsError):
                    unity_upm.create(root/'source.zip', root/'first', '0.1.0', platform)

    def test_missing_native_metadata_license_and_tampered_payload_fail(self):
        for name in fixture_entries('linux-x64'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                values = fixture_entries('linux-x64')
                del values[name]
                write_zip(root/'source.zip', values)
                with self.assertRaises(ValueError):
                    unity_upm.create(root/'source.zip', root, '0.1.0', 'linux-x64')
                self.assertFalse(list(root.glob('*.tgz')))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = fixture_entries('linux-x64')
            values['devcel-unity/Tools~/linux-x64/devcel'] = b'tampered'
            write_zip(root/'source.zip', values)
            with self.assertRaisesRegex(ValueError, 'checksum'):
                unity_upm.create(root/'source.zip', root, '0.1.0', 'linux-x64')

    def test_wrong_version_platform_fingerprint_and_unsafe_paths_fail(self):
        for change in ('version', 'platform', 'fingerprint', 'path', 'symlink'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                values = fixture_entries('linux-x64')
                if change == 'fingerprint':
                    values['devcel-unity/Editor/NativeRequirements.json'] = b'{"schema_version":1,"source_fingerprint":"wrong"}'
                if change == 'path':
                    values['devcel-unity/../outside'] = b'bad'
                write_zip(root/'source.zip', values)
                if change == 'symlink':
                    with zipfile.ZipFile(root/'source.zip', 'a') as archive:
                        info = zipfile.ZipInfo('devcel-unity/link')
                        info.external_attr = 0o120777 << 16
                        archive.writestr(info, b'target')
                with self.assertRaises(ValueError):
                    unity_upm.create(root/'source.zip', root,
                                     '0.2.0' if change == 'version' else '0.1.0',
                                     'osx-x64' if change == 'platform' else 'linux-x64')


if __name__ == '__main__':
    unittest.main()
