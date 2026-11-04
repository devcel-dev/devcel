from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import debian_version as versions


class DebianVersions(unittest.TestCase):
    def test_canonical_mapping_and_control_preserves_other_fields(self):
        for version, expected in [('0.0.3', '0.0.3'), ('0.0.3-rc.1', '0.0.3~rc.1'),
                                  ('1.2.3-beta.10', '1.2.3~beta.10')]:
            self.assertEqual(versions.control_version(version), expected)
            raw = f'Package: devcel-studio\nVersion: {version}\nArchitecture: amd64\n'.encode()
            self.assertEqual(versions.rewrite_control(raw, version), raw.replace(version.encode(), expected.encode()))
        for invalid in ('0.0.3\n', 'v0.0.3', '0.0.3+alias', '0.03.0', '0.0.3-01'):
            with self.assertRaises(ValueError): versions.control_version(invalid)
        for raw in (b'Package: example\n', b'Version: 0.0.2\n', b'Version: 0.0.3\nversion: 0.0.3\n'):
            with self.assertRaises(ValueError): versions.rewrite_control(raw, '0.0.3')

    @unittest.skipUnless(shutil.which('dpkg') and shutil.which('dpkg-deb'), 'Debian tools unavailable on this OS')
    def test_real_ordering_and_repack_keeps_payload(self):
        subprocess.run(['dpkg', '--compare-versions', '0.0.3~rc.1', 'lt', '0.0.3'], check=True)
        subprocess.run(['dpkg', '--compare-versions', '0.0.3-rc.1', 'gt', '0.0.3'], check=True)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            stage = directory/'stage'
            (stage/'DEBIAN').mkdir(parents=True)
            (stage/'DEBIAN/control').write_text('Package: devcel-studio\nVersion: 0.0.3-rc.1\nArchitecture: amd64\nMaintainer: Example <example@example.invalid>\nDescription: isolated fixture\n')
            (stage/'payload').write_bytes(b'unchanged payload')
            package = directory/'fixture.deb'
            subprocess.run(['dpkg-deb', '--build', '--root-owner-group', str(stage), str(package)], check=True)
            versions.prepare(package, '0.0.3-rc.1')
            versions.verify(package, '0.0.3-rc.1')
            subprocess.run(['dpkg-deb', '--extract', str(package), str(directory/'out')], check=True)
            self.assertEqual((directory/'out/payload').read_bytes(), b'unchanged payload')


if __name__ == '__main__': unittest.main()
