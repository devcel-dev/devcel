#!/usr/bin/env python3
import contextlib, importlib.util, io, json, pathlib, tempfile, unittest
spec=importlib.util.spec_from_file_location('native',pathlib.Path(__file__).with_name('check-native-distribution.py'))
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
class NativeNoticeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name).resolve();self.binary=self.root/'devcel';self.binary.write_bytes(b'\x7fELFfirst-party')
        self.manifest={'review_status':'verified','platform':'linux','format':'test-fixture','extraction_evidence':'Unit-test fixture only','bootstrapper_and_system_runtime_review':'No installer in fixture','native_components':[]}
    def tearDown(self):self.temp.cleanup()
    def test_exact_first_party_bytes(self):self.assertFalse(n.verify(self.root,self.manifest,[self.binary])[1])
    def test_reviewed_format_is_enforced(self):
        self.manifest['reviewed_artifact_formats']=['.deb']
        self.assertFalse(n.verify(self.root,self.manifest,[self.binary],'.deb')[1])
        for suffix in ('.appimage','.rpm',None):
            self.assertTrue(any('format has not been reviewed' in e for e in n.verify(self.root,self.manifest,[self.binary],suffix)[1]))
    def test_unknown_native_is_blocked(self):
        (self.root/'libvendor.so').write_bytes(b'\x7fELFvendor')
        self.assertTrue(any('Unreviewed' in error for error in n.verify(self.root,self.manifest,[self.binary])[1]))
    def test_pending_packaging_review_is_blocked(self):
        self.manifest['review_status']='pending';self.assertTrue(n.verify(self.root,self.manifest,[self.binary])[1])
    def test_notice_must_ship_with_correct_bytes(self):
        vendor=self.root/'vendor.dll';vendor.write_bytes(b'MZvendor');notice=self.root/'LICENSE-vendor';notice.write_text('Original legal terms')
        self.manifest['native_components']=[{'sha256':n.sha256(vendor),'name':'test-vendor','version':'1','license':'MIT','upstream_source':'https://example.invalid/source','source_availability':'fixture-source','linking_or_relinking':'dynamic','notices':[{'payload_path':notice.name,'sha256':n.sha256(notice)}]}]
        self.assertFalse(n.verify(self.root,self.manifest,[self.binary])[1]);notice.unlink()
        self.assertTrue(any('missing/changed' in error for error in n.verify(self.root,self.manifest,[self.binary])[1]))
    def test_first_party_binary_must_be_in_payload(self):
        payload=self.root/'payload';payload.mkdir()
        vendor=payload/'vendor.dll';vendor.write_bytes(b'MZvendor')
        notice=payload/'LICENSE-vendor';notice.write_text('Original legal terms')
        self.manifest['native_components']=[{'sha256':n.sha256(vendor),'name':'test-vendor','version':'1','license':'MIT','upstream_source':'https://example.invalid/source','source_availability':'fixture-source','linking_or_relinking':'dynamic','notices':[{'payload_path':notice.name,'sha256':n.sha256(notice)}]}]
        errors=n.verify(payload,self.manifest,[self.binary])[1]
        self.assertEqual(len(errors),1)
        self.assertIn('first-party binary missing',errors[0])
    def test_all_expected_first_party_binaries_must_ship(self):
        payload=self.root/'payload';payload.mkdir()
        (payload/'devcel').write_bytes(self.binary.read_bytes())
        other=self.root/'runtime';other.write_bytes(b'\x7fELFother-first-party')
        self.assertTrue(any('first-party binary missing' in error for error in n.verify(payload,self.manifest,[self.binary,other])[1]))
    def test_tauri_bundle_type_patch_matches_whole_file(self):
        self.binary.write_bytes(b'MZheader'+n.BUNDLE_TOKEN+b'executable-code')
        payload=self.root/'payload';payload.mkdir()
        packed=payload/'Path'  # MSI extraction can replace the original name.
        for suffix,kind in n.BUNDLE_TYPES.items():
            with self.subTest(suffix=suffix):
                packed.write_bytes(self.binary.read_bytes().replace(n.BUNDLE_TOKEN,n.BUNDLE_TOKEN[:-3]+kind,1))
                files,errors=n.verify(payload,self.manifest,[self.binary],suffix)
                self.assertFalse(errors)
                self.assertEqual(files[0]['first_party_identity']['bundle_type'],kind.decode())
                self.assertEqual(files[0]['first_party_identity']['source_sha256'],n.sha256(self.binary))
    def test_other_byte_changes_are_rejected(self):
        self.binary.write_bytes(b'MZheader'+n.BUNDLE_TOKEN+b'executable-code')
        payload=self.root/'payload';payload.mkdir()
        packed=payload/'devcel.exe'
        patched=self.binary.read_bytes().replace(n.BUNDLE_TOKEN,n.BUNDLE_TOKEN[:-3]+b'MSI',1)
        for data in (patched+b'overlay',patched[:-1]+b'X',patched.replace(b'MSI',b'NSS')):
            packed.write_bytes(data)
            self.assertTrue(any('first-party binary missing' in error for error in n.verify(payload,self.manifest,[self.binary],'.msi')[1]))
    def test_only_first_token_is_patched(self):
        self.binary.write_bytes(b'MZ'+n.BUNDLE_TOKEN+b'code'+n.BUNDLE_TOKEN)
        payload=self.root/'payload';payload.mkdir();packed=payload/'app.exe'
        packed.write_bytes(self.binary.read_bytes().replace(n.BUNDLE_TOKEN,n.BUNDLE_TOKEN[:-3]+b'NSS',1))
        self.assertFalse(n.verify(payload,self.manifest,[self.binary],'.exe')[1])
        packed.write_bytes(self.binary.read_bytes().replace(n.BUNDLE_TOKEN,n.BUNDLE_TOKEN[:-3]+b'NSS'))
        self.assertTrue(n.verify(payload,self.manifest,[self.binary],'.exe')[1])
    def test_no_implicit_normalization_without_artifact_format(self):
        self.binary.write_bytes(b'MZ'+n.BUNDLE_TOKEN)
        payload=self.root/'payload';payload.mkdir()
        (payload/'app.exe').write_bytes(b'MZ'+n.BUNDLE_TOKEN[:-3]+b'NSS')
        self.assertTrue(n.verify(payload,self.manifest,[self.binary])[1])
    def test_marker_absent_requires_exact_bytes(self):
        payload=self.root/'payload';payload.mkdir();packed=payload/'app.exe'
        packed.write_bytes(self.binary.read_bytes())
        self.assertFalse(n.verify(payload,self.manifest,[self.binary],'.exe')[1])
        packed.write_bytes(self.binary.read_bytes()+n.BUNDLE_TOKEN[:-3]+b'NSS')
        self.assertTrue(n.verify(payload,self.manifest,[self.binary],'.exe')[1])
    def test_unknown_format_does_not_enable_transform(self):
        self.binary.write_bytes(b'MZ'+n.BUNDLE_TOKEN)
        payload=self.root/'payload';payload.mkdir()
        (payload/'app.exe').write_bytes(b'MZ'+n.BUNDLE_TOKEN[:-3]+b'NSS')
        self.assertTrue(n.verify(payload,self.manifest,[self.binary],'.unknown')[1])
    def test_known_patch_does_not_bypass_review(self):
        self.binary.write_bytes(b'MZ'+n.BUNDLE_TOKEN)
        payload=self.root/'payload';payload.mkdir()
        (payload/'app.exe').write_bytes(b'MZ'+n.BUNDLE_TOKEN[:-3]+b'NSS')
        self.manifest['review_status']='pending'
        self.assertIn('Platform packaging/runtime review is not verified',n.verify(payload,self.manifest,[self.binary],'.exe')[1])
    def test_artifact_report_is_identical_in_file_and_log(self):
        spec=importlib.util.spec_from_file_location('artifacts',pathlib.Path(__file__).with_name('check-native-release-artifacts.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        report={'artifact':'fixture.exe','native_files':[],'errors':['pending'],'verified':False}
        output=io.StringIO();destination=self.root/'report.json'
        with contextlib.redirect_stdout(output):module.emit_report(report,destination)
        self.assertEqual(json.loads(destination.read_text()),report)
        self.assertEqual(json.loads(output.getvalue().removeprefix('NATIVE_REVIEW_REPORT ')),report)
    def test_payload_escape_is_blocked(self):
        (self.root/'escaped.so').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(RuntimeError,'escapes'):n.inventory(self.root)

class MacNoticeTests(unittest.TestCase):
    def test_macos_resources_require_exact_generated_notice_bytes(self):
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('artifacts', pathlib.Path(__file__).with_name('check-native-release-artifacts.py'))
        artifacts = importlib.util.module_from_spec(spec); spec.loader.exec_module(artifacts)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            app = root/'devcel-studio.app'
            legal = app/'Contents/Resources/legal'; legal.mkdir(parents=True)
            source = root/'notice.txt'; source.write_bytes(b'Original copyright and license')
            payload = legal/'THIRD-PARTY-NOTICES.txt'; payload.write_bytes(source.read_bytes())
            with patch.object(artifacts, 'distribution_files', return_value={'THIRD-PARTY-NOTICES.txt': source}):
                self.assertEqual(artifacts.verify_macos_notices(app, root)['verified_files'], 1)
                payload.write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, 'changed'): artifacts.verify_macos_notices(app, root)
                payload.unlink()
                with self.assertRaisesRegex(RuntimeError, 'differs'): artifacts.verify_macos_notices(app, root)

if __name__=='__main__':unittest.main()
