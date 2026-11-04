import os
from pathlib import Path
import tempfile
import unittest
import tarfile
import io
from unittest.mock import patch

import release_privacy as privacy


class PrivacyTests(unittest.TestCase):
    def test_release_metadata_is_scanned_without_values_in_diagnostics(self):
        privacy.check_bytes(b'{"source_commit":"0123456789","source_repository":"owner/repo"}', 'SOURCE-ACCESS.json')
        privacy.check_bytes(b'0123456789  devcel-unity-0.0.3-linux-x64.zip\n', 'SHA256SUMS.txt')
        leak = (chr(47)+'home'+chr(47)+'unexpected-owner/source').encode()
        for name in ('SOURCE-ACCESS.json', 'SHA256SUMS.txt'):
            with self.assertRaises(ValueError) as error:
                privacy.check_bytes(leak, name)
            self.assertNotIn('unexpected-owner', str(error.exception))

    def test_cargo_flag_semantics_and_encoded_precedence(self):
        flags = r'-D warnings --remap-path-prefix=C:\Build\Source=/canonical -C target-feature=+crt-static'
        with patch.dict(os.environ, {'RUSTFLAGS': flags}, clear=True), \
                patch.object(privacy.subprocess, 'check_output', return_value='/opt/toolchain'), \
                patch.object(privacy.Path, 'home', return_value=Path('/build-user')):
            privacy.configure(Path('/build/source'))
            actual = os.environ['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')
            self.assertEqual(actual[:len(flags.split())], flags.split())
            encoded = ['-D', 'warnings', '--remap-path-prefix=C:\\Build With Spaces\\Source=/canonical', '-C', 'target-feature=+crt-static']
            os.environ['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(encoded)
            os.environ['RUSTFLAGS'] = 'ignored old flags'
            privacy.configure(Path('/build/source'))
            self.assertEqual(os.environ['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')[:len(encoded)], encoded)

    def test_real_linux_example_generic_tmp_is_not_a_personal_build_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root/'source'
            stage.mkdir()
            original = Path(__file__).resolve().parents[1]/'devcel-core/examples/basic.rs'
            (stage/'basic.rs').write_bytes(original.read_bytes())
            archive = root/'source.tar.gz'
            privacy.write_source_archive(stage, archive, 'devcel-cli-source')
            with patch.dict(os.environ, {'DEVCEL_RELEASE_PRIVATE_PREFIXES': '["/tmp/owned-build-unique"]'}):
                privacy.check_source_archive(archive)
                with self.assertRaises(ValueError):
                    privacy.check_bytes(b'/tmp/owned-build-unique/source/main.rs', 'app')

    def test_non_native_engine_payload_leak_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root/'addons'/'devcel'/'editor.gd'
            script.parent.mkdir(parents=True)
            script.write_text('const endpoint = "localhost"')
            privacy.check_tree(root)
            leak_path = chr(47)+'home'+chr(47)+'unexpected-owner/private-source'
            script.write_text('const build = '+repr(leak_path))
            with self.assertRaises(ValueError):
                privacy.check_tree(root)

    def test_only_exact_synthetic_literals_are_classified(self):
        for name in ('release_privacy.py', 'test-release-privacy.py'):
            path = Path(__file__).with_name(name)
            relative = 'devcel-source/scripts/'+name
            original = path.read_bytes()
            privacy.check_bytes(privacy.source_fixture_bytes(original, relative), relative)
            leak_path = chr(47)+'home'+chr(47)+'unexpected-owner/private-source'
            leaked = original+('\nUNEXPECTED = '+repr(leak_path)+'\n').encode()
            with self.assertRaises(ValueError):
                privacy.check_bytes(privacy.source_fixture_bytes(leaked, relative), relative)
            leaked = original+b'\nTOKEN = "ghp_'+b'x'*32+b'"\n'
            with self.assertRaises(ValueError):
                privacy.check_bytes(privacy.source_fixture_bytes(leaked, relative), relative)

    def test_studio_archive_is_deterministic_and_has_anonymous_gzip_header(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root/'local-owner-stage'
            stage.mkdir()
            source = stage/'BUILD-SOURCE.txt'
            source.write_text('canonical source')
            first, second = root/'private-first.tar.gz', root/'private-second.tar.gz'
            privacy.write_source_archive(stage, first, 'devcel-source', 1234)
            os.utime(source, (4567, 4567))
            privacy.write_source_archive(stage, second, 'devcel-source', 1234)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            header = first.read_bytes()[:10]
            self.assertEqual(header[:2], b'\x1f\x8b')
            self.assertEqual(header[3] & 8, 0, 'gzip header omits original filename')
            self.assertEqual(int.from_bytes(header[4:8], 'little'), 1234)
            privacy.check_source_archive(first)

    def test_diagnostic_retains_category_without_raw_local_data(self):
        error = RuntimeError('Failed reading C:\\Users\\private-person\\source token=private-token')
        self.assertEqual(privacy.diagnostic(error, 'artifact-inspection'), 'artifact-inspection: RuntimeError')

    def test_source_archive_has_neutral_ownership_and_scans_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'cli-source.tar.gz'
            def write(raw, neutral=True):
                with tarfile.open(path, 'w:gz') as archive:
                    info = tarfile.TarInfo('devcel-cli-source/BUILD-SOURCE.txt')
                    info.size = len(raw)
                    info.uid, info.gid, info.uname, info.gname = 1001, 1002, 'private-person', 'private-group'
                    if neutral:
                        info = privacy.archive_info(info, 1234)
                    archive.addfile(info, io.BytesIO(raw))
            write(b'canonical source revision')
            privacy.check_source_archive(path)
            with tarfile.open(path) as archive:
                info = archive.next()
                self.assertEqual((info.uid, info.gid, info.uname, info.gname, info.mtime), (0, 0, '', '', 1234))
            write(b'canonical', False)
            with self.assertRaises(ValueError):
                privacy.check_source_archive(path)
            write(b'RUSTFLAGS: --remap-path-prefix=/home/private-person=/devcel/source')
            with self.assertRaises(ValueError) as error:
                privacy.check_source_archive(path)
            self.assertNotIn('private-person', str(error.exception))

    def test_windows_unix_and_utf16_are_rejected_without_echoing_match(self):
        values = [r'C:\Users\private-person\source\main.rs', '/home/private-person/source',
                  '/Users/private-person/source', 'ghp_'+'x'*32]
        for value in values:
            for encoding in ('utf-8', 'utf-16-le'):
                with self.subTest(encoding=encoding), self.assertRaises(ValueError) as error:
                    privacy.check_bytes(value.encode(encoding), 'app.exe')
                self.assertNotIn('private-person', str(error.exception))
                self.assertNotIn('x'*32, str(error.exception))

    def test_canonical_paths_and_attribution_are_preserved(self):
        privacy.check_bytes(b'/devcel/source/main.rs /devcel/cargo/registry crate author@example.com', 'app')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'legal').mkdir()
            (root/'legal'/'original.txt').write_text('/Users/webpack/original author@example.com')
            privacy.check_tree(root)
            (root/'BUILD-SOURCE.txt').write_text('/home/private-person/build')
            with self.assertRaises(ValueError):
                privacy.check_tree(root)

    def test_encoded_flags_keep_spaces_and_existing_warning_gate(self):
        with tempfile.TemporaryDirectory(prefix='source with spaces ') as directory:
            with patch.dict(os.environ, {'RUSTFLAGS': '-D warnings'}, clear=True), \
                    patch.object(privacy.subprocess, 'check_output', return_value=directory), \
                    patch.object(privacy.Path, 'home', return_value=Path(directory)/'home'):
                privacy.configure(Path(directory))
                flags = os.environ['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')
                self.assertEqual(flags[:2], ['-D', 'warnings'])
                self.assertIn('--remap-path-prefix='+str(Path(directory).resolve())+'=/devcel/source', flags)
                self.assertNotIn(directory, privacy.provenance_flags())
                self.assertNotIn('RUSTFLAGS', privacy.provenance_flags())


if __name__ == '__main__':
    unittest.main()
