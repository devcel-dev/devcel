#!/usr/bin/env python3
"""Read-only native evidence collection tests."""
import hashlib
import contextlib
import io
import json
import sys
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('collect-native-review-evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)

class EvidenceTests(unittest.TestCase):
    def test_original_notice_is_hashed_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            body = b'Copyright Example\nLicense original text\n'
            (root/'LICENSE').write_bytes(body)
            (root/'NOTICE').write_bytes(body)
            with patch.object(evidence.sys, 'platform', 'other'):
                result = evidence.collect(root, [])
            sha = hashlib.sha256(body).hexdigest()
            self.assertTrue(result['evidence_only'])
            self.assertEqual(len(result['payload_notices']), 2)
            self.assertEqual(list(result['documents']), [sha])
            self.assertEqual(result['documents'][sha]['text'], body.decode())
            self.assertNotIn('verified', result)

    def test_crlf_notice_preserves_original_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            body = b'Copyright Example\r\nOriginal notice\r\n'
            (root/'LICENSE').write_bytes(body)
            with patch.object(evidence.sys, 'platform', 'other'):
                result = evidence.collect(root, [])
            sha = hashlib.sha256(body).hexdigest()
            self.assertEqual(result['documents'][sha]['text'].encode('utf-8'), body)

    def test_missing_candidates_are_not_approved(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(evidence.sys, 'platform', 'other'):
                result = evidence.collect(Path(temp), [{'path':'unidentified.so','sha256':'f'*64}])
            self.assertEqual(result['native_provenance_candidates'], [])
            self.assertTrue(result['evidence_only'])

    def test_large_notice_is_explicitly_omitted(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'COPYING').write_bytes(b'long original notice')
            with patch.object(evidence.sys, 'platform', 'other'), patch.object(evidence, 'MAX_TEXT', 1):
                result = evidence.collect(root, [])
            document = next(iter(result['documents'].values()))
            self.assertIn('omitted_reason', document)
            self.assertNotIn('text', document)

class DebianNoticeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('release_check', Path(__file__).with_name('check-native-release-artifacts.py'))
        self.module = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(); self.base = Path(self.temp.name)
        self.repo = self.base/'repo'; self.root = self.base/'payload'
        self.source = self.repo/'third-party/generated'; self.payload = self.root/'usr/lib/devcel-studio/legal'
        self.source.mkdir(parents=True); self.payload.mkdir(parents=True)
        for name in ('THIRD-PARTY-NOTICES.txt',):
            (self.source/name).write_bytes(b'Original\r\n')
            (self.payload/name).write_bytes(b'Original\r\n')
        (self.source/'inventory.json').write_text('{"packages":[]}', encoding='utf-8')
    def tearDown(self): self.temp.cleanup()
    def test_exact_tree_passes(self):
        self.assertEqual(self.module.verify_deb_notices(self.root,self.repo)['verified_files'],1)
    def test_modified_missing_and_extra_notices_fail(self):
        target=self.payload/'THIRD-PARTY-NOTICES.txt'
        target.write_bytes(b'Original\n')
        with self.assertRaisesRegex(RuntimeError,'changed='):self.module.verify_deb_notices(self.root,self.repo)
        target.unlink()
        with self.assertRaisesRegex(RuntimeError,'missing='):self.module.verify_deb_notices(self.root,self.repo)
        target.write_bytes(b'Original\r\n');(self.payload/'extra.txt').write_bytes(b'extra')
        with self.assertRaisesRegex(RuntimeError,'extra='):self.module.verify_deb_notices(self.root,self.repo)
    def test_missing_whole_tree_fails(self):
        import shutil
        shutil.rmtree(self.payload)
        with self.assertRaisesRegex(RuntimeError,'legal directory'):self.module.verify_deb_notices(self.root,self.repo)

class ReportPersistenceTests(unittest.TestCase):
    def test_main_persists_collector_output_and_extraction_failure(self):
        spec = importlib.util.spec_from_file_location('release_check', Path(__file__).with_name('check-native-release-artifacts.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'fixture.deb').write_bytes(b'artifact')
            first = root/'app'
            first.write_bytes(b'first party fixture')
            output = root/'reports'
            argv = ['check', '--platform', 'linux', '--bundle-dir', str(root),
                    '--first-party', str(first), '--report-dir', str(output)]
            def extracted_fixture(artifact, destination):
                cli = destination/'usr/lib/devcel-studio/bin'
                cli.mkdir(parents=True)
                (cli/'LICENSE-CLI.txt').write_bytes((Path(__file__).resolve().parent.parent/'devcel-cli/LICENSE').read_bytes())
            with patch.object(sys, 'argv', argv), patch.object(module, 'extract', side_effect=extracted_fixture), \
                 patch.object(module.debian_version, 'verify'), \
                 patch.object(module.studio_cli, 'smoke', return_value={'fixture': True}), \
                 patch.object(module.studio_cli, 'validate', return_value={'fixture': True}), \
                 patch.object(module, 'verify_deb_notices', return_value={'verified_files': 1}), \
                 patch.object(module.native, 'verify', return_value=([], ['pending'])), \
                 patch.object(module.evidence, 'collect', return_value={'evidence_only': True, 'documents': {'sentinel': 'kept'}}), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit): module.main()
            report = json.loads((output/'fixture.deb.json').read_text())
            self.assertEqual(report['review_evidence']['documents']['sentinel'], 'kept')
            with patch.object(sys, 'argv', argv), \
                 patch.object(module.debian_version, 'verify'), \
                 patch.object(module, 'extract', side_effect=RuntimeError('invalid artifact')), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit): module.main()
            report = json.loads((output/'fixture.deb.json').read_text())
            self.assertIn('did not complete', report['review_evidence']['collection_error'])
            self.assertFalse(report['verified'])

if __name__ == '__main__':
    unittest.main()
