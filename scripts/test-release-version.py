"""Single-setting version changes and generated package metadata regressions."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import release_version as release
import importer_versions as importers
import bundled_plugin_versions as plugins
from product_version import CONFIG, read_version


class VersionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        names = [CONFIG, 'devcel-studio/package.json', 'devcel-studio/package-lock.json',
                 'Cargo.lock', 'third-party/preferred-sources.json', *plugins.SOURCES]
        for engine, (name, _) in importers.IDENTITIES.items():
            names.append(f"importers/{'unity-template' if engine == 'unity' else engine}/{name}")
        names.append('importers/godot/addons/devcel/plugin.cfg')
        for name in names:
            target = self.root/name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(release.ROOT/name, target)

    def snapshot(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for p in self.root.rglob('*') if p.is_file()}

    def test_stable_and_prerelease_change_exactly_one_file(self):
        for version in ('2.4.6', '2.4.7-rc.1', '2.4.7-rc.2', '2.4.7', '0.0.0'):
            before = self.snapshot()
            self.assertEqual(release.bump(version, self.root), [CONFIG])
            after = self.snapshot()
            self.assertEqual({n for n in before if before[n] != after[n]}, {CONFIG})
            self.assertEqual(read_version(self.root), version)
            self.assertEqual(release.bump(version, self.root), [])
            self.assertEqual(importers.check_packaged_versions(self.root, version), 9)
            generated = plugins.render_sources(self.root, version)
            for name, minimum in plugins.SOURCES.items():
                expected = '>='+minimum if '/templates/' in name else plugins.compatibility_range(version, minimum)
                self.assertIn(expected.encode(), generated[name])
            self.assertEqual(after, self.snapshot(), 'Generation must never write source versions back')

    def test_no_stored_product_version_mirrors(self):
        importers.validate_templates(self.root)
        package = json.loads((self.root/'devcel-studio/package.json').read_bytes())
        lock = json.loads((self.root/'devcel-studio/package-lock.json').read_bytes())
        self.assertNotIn('version', package)
        self.assertNotIn('version', lock)
        self.assertNotIn('version', lock['packages'][''])

    def test_invalid_version_changes_nothing(self):
        for version in ('', 'v1.2.3', '1.2', '01.2.3', '1.2.3-01', '1.2.3\n', '../1.2.3', 'hoge'):
            before = self.snapshot()
            with self.assertRaises(ValueError):
                release.bump(version, self.root)
            self.assertEqual(before, self.snapshot())

    def test_write_failure_preserves_original_and_removes_temporary_file(self):
        before = self.snapshot()
        with patch.object(release.os, 'replace', side_effect=OSError('injected failure')):
            with self.assertRaises(OSError): release.bump('9.8.7', self.root)
        self.assertEqual(before, self.snapshot())

    def test_concurrent_configuration_edit_is_preserved(self):
        config = self.root/CONFIG
        original = Path.read_bytes
        reads = 0
        def read(path):
            nonlocal reads
            if path == config:
                reads += 1
                if reads == 3:
                    path.write_bytes(original(path).replace(b'"productName"', b'"changedProductName"'))
            return original(path)
        with patch.object(Path, 'read_bytes', read):
            with self.assertRaisesRegex(ValueError, 'changed during'):
                release.bump('9.8.7', self.root)
        self.assertIn(b'changedProductName', config.read_bytes())
        self.assertFalse(list(config.parent.glob('.product-version-*')))

    def test_duplicate_source_version_is_rejected_by_packaging(self):
        path = self.root/'importers/unity-template/package.json'
        value = json.loads(path.read_bytes()); value['version'] = '9.9.9'
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'only in tauri'):
            importers.validate_templates(self.root)

    def test_bundled_plugin_source_drift_is_not_hidden(self):
        path = self.root/next(iter(plugins.SOURCES))
        path.write_bytes(path.read_bytes().replace(b'>=0.0.0', b'>=99.0.0'))
        with self.assertRaises(ValueError): plugins.render_sources(self.root, '1.2.3-rc.1')


if __name__ == '__main__':
    unittest.main()
