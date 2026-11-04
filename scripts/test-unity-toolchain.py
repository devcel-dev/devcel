import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unity_toolchain import fingerprint, verify_source, materialize


class ToolchainTests(unittest.TestCase):
    def fixture(self, root):
        root.mkdir()
        (root/'Cargo.toml').write_text('[workspace.package]\nversion="0.0.2"\n')
        (root/'Cargo.lock').write_text('version=4\n[[package]]\nname="devcel-core"\nversion="0.0.2"\n')
        (root/'rust-toolchain.toml').write_text('[toolchain]\nchannel="stable"\n')
        for crate in ('devcel-core', 'devcel-cli', 'devcel-runtime'):
            (root/crate/'src').mkdir(parents=True)
            (root/crate/'Cargo.toml').write_text('[package]\nversion.workspace=true\n')
            (root/crate/'src/lib.rs').write_text('pub const VERSION: u32 = 1;\n')

    def test_native_requirements_are_generated_only_in_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'sdk'; self.fixture(root)
            out=Path(directory)/'package'
            materialize(root,out)
            self.assertEqual(json.loads((out/'Editor/NativeRequirements.json').read_text())['source_fingerprint'], fingerprint(root))
            self.assertFalse((root/'importers/unity/Editor/NativeRequirements.json').exists())

    def test_mixed_case_paths_have_one_portable_fixed_digest(self):
        # Windows Path ordering folds case; POSIX does not. This exact digest
        # must hold on both hosts and for a fresh LF-only source copy.
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'sdk'; self.fixture(root)
            for name in ('Z.rs', 'a.rs'):
                (root/'devcel-core/src'/name).write_bytes(b'// mixed case path ordering\n')
            expected='631dad9056dbb3a7653062605565bcb1c1938c2f6ac55c5146e878d34417b8a7'
            self.assertEqual(fingerprint(root), expected)
            fresh=Path(directory)/'fresh'; shutil.copytree(root, fresh)
            for path in fresh.rglob('*'):
                if path.is_file():
                    path.write_bytes(path.read_bytes().replace(b'\r\n', b'\n'))
            self.assertEqual(fingerprint(fresh), expected)
            for path in fresh.rglob('*.rs'):
                path.write_bytes(path.read_bytes().replace(b'\n', b'\r\n'))
            self.assertEqual(fingerprint(fresh), expected)

    def test_studio_owned_catalog_is_not_a_native_sdk_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'sdk';self.fixture(root);expected=fingerprint(root)
            asset=root/'devcel-studio/app-settings/Tables/Themes.table.toml'
            asset.parent.mkdir(parents=True);asset.write_text('Studio-only theme data')
            self.assertEqual(fingerprint(root),expected)
            asset.write_text('Changed theme');self.assertEqual(fingerprint(root),expected)

    def test_alternate_source_must_match_actual_native_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'sdk'; self.fixture(root)
            source=Path(directory)/'native'; shutil.copytree(root,source)
            self.assertEqual(verify_source(root,source),fingerprint(root))
            (source/'devcel-core/src/lib.rs').write_text('pub const VERSION: u32 = 0;\n')
            with self.assertRaisesRegex(ValueError,'source tree'):
                verify_source(root,source)

    def test_line_endings_and_separately_checked_release_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'sdk'; self.fixture(root); expected=fingerprint(root)
            for name in ('Cargo.toml','Cargo.lock'):
                p=root/name;p.write_bytes(p.read_bytes().replace(b'0.0.2',b'0.0.3').replace(b'\n',b'\r\n'))
            self.assertEqual(fingerprint(root),expected)
            with (root/'Cargo.lock').open('a') as f:f.write('\n[[package]]\nname="third-party"\nversion="1.0.0"\nsource="registry"\n')
            self.assertNotEqual(fingerprint(root),expected)


if __name__ == '__main__': unittest.main()
