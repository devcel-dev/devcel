#!/usr/bin/env python3
"""Exercise CRLF checkouts without changing legal evidence or artifact hashes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

notices = load('line_ending_notices', 'generate-third-party-notices.py')
ci = load('line_ending_ci', 'ci-release.py')

class CheckoutTests(unittest.TestCase):
    def test_git_checkout_preserves_all_authenticated_upstream_bytes(self):
        if not (ROOT/'.git').exists() or not shutil.which('git'):
            self.skipTest('Git checkout required for index-byte regression')
        indexes = {name: json.loads((ROOT/'third-party'/name).read_text(encoding='utf-8')) for name in ('cargo-upstream.json','npm-upstream.json','rust-standard-library.json','assets.json')}
        evidence = {e['path']: e for e in notices.all_upstream_evidence(ROOT)}
        for setting in ('true', 'false', 'input'):
            with self.subTest(autocrlf=setting), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                subprocess.run(['git', '-c', 'core.autocrlf='+setting, 'checkout-index',
                                '--prefix='+root.as_posix()+'/', '--', *evidence], cwd=ROOT,
                               check=True, capture_output=True)
                for name, index in indexes.items():
                    (root/'third-party'/name).write_text(json.dumps(index), encoding='utf-8')
                original_inputs = notices.lock_hashes(root)
                for path, item in evidence.items():
                    with self.subTest(path=path):
                        raw = (root/path).read_bytes()
                        self.assertEqual(hashlib.sha256(raw).hexdigest(), item['sha256'])
                        # Simulate existing pre-attribute CRLF bytes; no Git metadata in this source archive.
                        (root/path).write_bytes(raw.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))
                        self.assertEqual(notices.authenticated_upstream_bytes(root, item), raw)
                self.assertEqual(notices.lock_hashes(root), original_inputs)
                notices.verify_upstream(root)

    def test_notice_input_hashes_accept_crlf_but_legal_evidence_is_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = json.loads((ROOT/'third-party/generated/inventory.json').read_text(encoding='utf-8'))
            paths = set(manifest['inputs']) | {'third-party/generated/inventory.json',
                'third-party/generated/THIRD-PARTY-NOTICES.txt',
                'devcel-studio/public/legal/THIRD-PARTY-NOTICES.txt'}
            paths.update('third-party/generated/'+t['file'] for p in manifest['packages'] for t in p['texts'])
            for name in paths:
                dest = root/name
                dest.parent.mkdir(parents=True, exist_ok=True)
                raw = (ROOT/name).read_bytes()
                if name in manifest['inputs'] and (name.endswith(('.py', '.json', '.toml')) or name == 'Cargo.lock') and not name.startswith('third-party/upstream/'):
                    raw = raw.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
                dest.write_bytes(raw)
            notices.verify_locks(root)
            lock = root/'Cargo.lock'
            original = lock.read_bytes()
            lock.write_bytes(original+b'# changed\r\n')
            with self.assertRaisesRegex(RuntimeError, 'stale'):
                notices.verify_locks(root)
            lock.write_bytes(original)
            text = next(t for p in manifest['packages'] for t in p['texts'])
            evidence = root/'third-party/generated'/text['file']
            evidence.write_bytes(evidence.read_bytes()+b'\r\n')
            with self.assertRaisesRegex(RuntimeError, 'License text changed'):
                notices.verify_locks(root)

    def test_asset_paths_use_canonical_root_and_reject_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)/'repo'
            (root/'third-party').mkdir(parents=True)
            (root/'child').mkdir()
            (root/'LICENSE').write_bytes(b'Original legal text\r\n')
            manifest = root/'third-party/assets.json'
            manifest.write_text(json.dumps({'assets': [{'license_files': ['LICENSE']}]}), encoding='utf-8')
            expected = notices.lock_hashes(root.resolve())
            self.assertEqual(notices.lock_hashes(root/'child/..'), expected)
            (root.parent/'outside-license').write_bytes(b'Outside evidence')
            manifest.write_text(json.dumps({'assets': [{'license_files': ['../outside-license']}]}), encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'escapes repository'):
                notices.lock_hashes(root/'child/..')

    def test_versions_and_process_output_accept_crlf(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ['Cargo.toml', 'Cargo.lock', 'devcel-studio/src-tauri/Cargo.toml',
                         'devcel-studio/package.json', 'devcel-studio/package-lock.json',
                         'devcel-studio/src-tauri/tauri.conf.json',
                         'devcel-cli/Cargo.toml', 'devcel-core/Cargo.toml', 'devcel-runtime/Cargo.toml',
                         'importers/unity/package.json', 'importers/javascript/package.json',
                         'importers/cocos/package.json', 'importers/unreal/Devcel.uplugin',
                         'importers/godot/addons/devcel/plugin.cfg']:
                dest = root/name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes((ROOT/name).read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))
            version = json.loads((root/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
            self.assertEqual(ci.validate('v'+version, root), version)
            output = ci.run(sys.executable, '-c', "import sys; sys.stdout.buffer.write(b'1.2.3\\r\\n')", capture=True)
            self.assertEqual(output, '1.2.3\n')

    def test_sdk_mixed_checkout_endings_and_real_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            studio = Path(tmp)
            script = studio/'scripts/sync-plugin-sdk.mjs'
            script.parent.mkdir()
            shutil.copyfile(ROOT/'devcel-studio/scripts/sync-plugin-sdk.js', script)
            for folder in ('src/app/types', 'templates/plugin-template/src/types'):
                for name in ('pluginTypes.ts', 'menuTypes.ts', 'tableTypes.ts', 'tableRules.ts', 'colorTypes.ts'):
                    dest = studio/folder/name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    raw = (ROOT/'devcel-studio/src/app/types'/name).read_bytes().replace(b'\r\n', b'\n')
                    if folder.startswith('templates/') and name == 'pluginTypes.ts':
                        raw += b"\nexport type { MenuConfiguration } from './menuTypes';\n"
                    if folder.startswith('src/'):
                        raw = raw.replace(b'\n', b'\r\n')
                    dest.write_bytes(raw)
            subprocess.run(['node', str(script), '--check'], check=True)
            target = studio/'templates/plugin-template/src/types/tableTypes.ts'
            target.write_bytes(target.read_bytes()+b'// changed\r\n')
            result = subprocess.run(['node', str(script), '--check'], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'Plugin SDK is stale', result.stderr)

    def test_importer_source_copies_accept_mixed_endings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index, name in enumerate(['scripts/test-importer-tag-filters.cjs',
                    'devcel-cli/src/importer_tag_filters.js',
                    'importers/rpgmaker/js/plugins/devcel/tag-filters.js',
                    'importers/javascript/editor/tag-filters.js']):
                dest = root/name
                dest.parent.mkdir(parents=True, exist_ok=True)
                raw = (ROOT/name).read_bytes().replace(b'\r\n', b'\n')
                dest.write_bytes(raw.replace(b'\n', b'\r\n') if index % 2 else raw)
            subprocess.run(['node', str(root/'scripts/test-importer-tag-filters.cjs')], check=True)

    def test_git_checkout_protects_original_notice_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'config', 'core.autocrlf', 'true'], check=True)
            shutil.copyfile(ROOT/'.gitattributes', root/'.gitattributes')
            files = {'source.py': b'print("hello")\n', 'Cargo.lock': b'version = 4\n',
                     'third-party/upstream/original.txt': b'Original\r\nterms\r\n',
                     'third-party/generated/licenses/example/LICENSE': b'Original\r\nterms\r\n',
                     'devcel-core/LICENSE': b'MIT\n',
                     'payload.zip': b'PK\x00\r\n\x00\n'}
            for name, raw in files.items():
                file = root/name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(raw)
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            for name in files: (root/name).unlink()
            subprocess.run(['git', '-C', str(root), 'checkout-index', '-a', '-f'], check=True)
            for name, raw in files.items(): self.assertEqual((root/name).read_bytes(), raw, name)

    def test_release_checksums_hash_raw_crlf_bytes(self):
        suite = load('line_ending_release_tests', 'test-ci-release.py')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            suite.ReleaseTests().fixture(root)
            name = 'devcel-studio-0.1.0-windows-x64.zip'
            raw = b'MZ\x00a\r\nb\n'
            (root/'release-Windows'/name).write_bytes(raw)
            ci.collect_assets(root, root/'out', 'v0.1.0')
            self.assertEqual((root/'out'/name).read_bytes(), raw)
            checksums = (root/'out/SHA256SUMS.txt').read_bytes()
            self.assertNotIn(b'\r', checksums)
            self.assertIn((hashlib.sha256(raw).hexdigest()+'  '+name+'\n').encode(), checksums)

if __name__ == '__main__':
    unittest.main()
