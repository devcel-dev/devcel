#!/usr/bin/env python3
"""Offline regression tests for license evidence generation and packaging gates."""
import contextlib, io, hashlib, importlib.util, json, pathlib, tempfile, unittest, subprocess, sys
from unittest.mock import patch

def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,pathlib.Path(__file__).with_name(filename))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
n=load('notices','generate-third-party-notices.py')

class NoticesTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        (self.root/'crate').mkdir();(self.root/'third-party').mkdir()
        (self.root/'Cargo.lock').write_text('version = 4\n[[package]]\nname = "dependency"\nversion = "1.0.0"\nchecksum = "locked-digest"\n')
        self.package={'id':'dep','name':'dependency','version':'1.0.0','manifest_path':str(self.root/'crate/Cargo.toml'),'source':'registry+https://github.com/rust-lang/crates.io-index','license':'MIT OR Apache-2.0','repository':'https://example.invalid/dependency','authors':['Original Author']}
        self.metadata={'packages':[self.package,{'id':'cli','name':'devcel-cli','source':None}], 'resolve':{'nodes':[{'id':'cli','deps':[{'pkg':'dep','dep_kinds':[{'kind':None,'target':None}]}]}]}}
    def tearDown(self): self.temp.cleanup()
    def test_missing_outputs_regenerate_and_unresolved_inputs_preserve_previous_outputs(self):
        import npm_license_inventory
        (self.root/'crate/LICENSE').write_text('Original terms')
        with contextlib.ExitStack() as stack:
            for name in ('devcel_component_inventory', 'importer_inventory', 'asset_inventory', 'rust_standard_library_inventory'):
                stack.enter_context(patch.object(n, name, return_value=[]))
            stack.enter_context(patch.object(npm_license_inventory, 'collect', return_value=[]))
            n.generate(self.root, metadata=self.metadata, ensure=True)
            generated = self.root/'third-party/generated'
            snapshot = {p.relative_to(generated):p.read_bytes() for p in generated.rglob('*') if p.is_file()}
            n.generate(self.root, metadata=self.metadata, check=True)
            n.generate(self.root, metadata=self.metadata, ensure=True)
            (self.root/'crate/LICENSE').unlink()
            with self.assertRaisesRegex(RuntimeError, 'Unresolved'):
                n.generate(self.root, metadata=self.metadata)
            self.assertEqual(snapshot, {p.relative_to(generated):p.read_bytes() for p in generated.rglob('*') if p.is_file()})

    def test_component_inventory_respects_isolated_and_studio_boundaries(self):
        packages = []
        for name, license in [('devcel-core', 'MIT'), ('devcel-studio', 'GPL-3.0')]:
            component = self.root/name
            component.mkdir()
            (component/'LICENSE').write_text(license, encoding='utf-8')
            manifest = component/'src-tauri/Cargo.toml' if name == 'devcel-studio' else component/'Cargo.toml'
            packages.append({'name':name, 'version':'1.0.0', 'source':None,
                             'manifest_path':str(manifest), 'license':license})
        isolated = n.devcel_component_inventory(self.root, {'packages':packages[:1]})
        self.assertEqual([e['name'] for e in isolated], ['devcel-core'])
        complete = n.devcel_component_inventory(self.root, {'packages':packages})
        self.assertEqual([(e['name'], e['license']) for e in complete],
                         [('devcel-core', 'MIT'), ('devcel-studio', 'GPL-3.0')])
        self.assertEqual(complete[1]['texts'][0]['text'], 'GPL-3.0')
        self.assertTrue(all('version' not in entry for entry in complete))

    def test_versionless_components_render_distribute_and_report_errors(self):
        from legal_distribution import distribution_files
        import npm_license_inventory
        sdk = self.root/'importers/example'
        sdk.mkdir(parents=True)
        (sdk/'LICENSE').write_text('Original SDK license')
        entries = n.importer_inventory(self.root)
        self.assertNotIn('version', entries[0])
        entries.append({'ecosystem':'cargo', 'name':'dependency', 'version':'1.0.0',
                        'license':'MIT', 'source':'registry', 'texts':[], 'errors':[]})
        generated = self.root/'third-party/generated'
        rendered = n.render(self.root, entries, {})
        for name, data in rendered.items():
            path = generated/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.assertNotIn('version', json.loads(rendered['inventory.json'])['packages'][1])
        self.assertIn(b'devcel: devcel-example\n', rendered['THIRD-PARTY-NOTICES.txt'])
        self.assertIn(b'cargo: dependency 1.0.0\n', rendered['THIRD-PARTY-NOTICES.txt'])
        self.assertEqual(set(distribution_files(generated)), {'THIRD-PARTY-NOTICES.txt'})
        aggregate = generated/'THIRD-PARTY-NOTICES.txt'
        aggregate.write_bytes(aggregate.read_bytes().replace(b'devcel: devcel-example\n', b''))
        with self.assertRaisesRegex(ValueError, 'Missing package notice mapping'):
            distribution_files(generated)
        entries[0]['errors'] = ['Missing component license declaration']
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(sys, 'argv', ['notices', '--repo', str(self.root)]))
            stack.enter_context(patch.object(n, 'cargo_metadata', return_value={}))
            stack.enter_context(patch.object(n, 'lock_hashes', return_value={}))
            for name in ('cargo_inventory', 'importer_inventory', 'asset_inventory', 'rust_standard_library_inventory'):
                stack.enter_context(patch.object(n, name, return_value=[]))
            stack.enter_context(patch.object(n, 'devcel_component_inventory', return_value=entries[:1]))
            stack.enter_context(patch.object(npm_license_inventory, 'collect', return_value=[]))
            error = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            with self.assertRaises(SystemExit) as raised:
                n.main()
            self.assertEqual(raised.exception.code, 1)
            self.assertIn('devcel-example: [', error.getvalue())

    def test_cargo_utf8_authors_survive_windows_code_page_and_render(self):
        authors = ['Ren\u00e9 Kijewski', 'Bastian K\u00f6cher', '\u043d\u0430\u0431', 'Andr\u00e9 S\u00e1 de Mello']
        self.package['authors'] = authors
        payload = json.dumps(self.metadata, ensure_ascii=False).encode('utf-8')
        check_output = subprocess.check_output
        def cargo_output(command, **kwargs):
            self.assertEqual(command, ['cargo', 'metadata', '--locked', '--format-version', '1'])
            return check_output([sys.executable, '-c', 'import sys;sys.stdout.buffer.write(' + repr(payload) + ')'], **kwargs)
        with patch.object(n.subprocess, 'check_output', side_effect=cargo_output), patch.object(subprocess, '_text_encoding', return_value='cp932'):
            metadata = n.cargo_metadata(self.root)
        self.assertEqual(metadata['packages'][0]['authors'], authors)
        original = 'Copyright ' + ', '.join(authors) + '\nOriginal license terms\n'
        (self.root/'crate/LICENSE').write_bytes(original.encode('utf-8'))
        files = n.render(self.root, n.cargo_inventory(self.root, metadata), {})
        self.assertEqual(json.loads(files['inventory.json'])['packages'][0]['authors'], authors)
        self.assertIn(original.encode('utf-8'), files['THIRD-PARTY-NOTICES.txt'])
    def test_cargo_metadata_rejects_invalid_utf8(self):
        check_output = subprocess.check_output
        def invalid_output(command, **kwargs):
            return check_output([sys.executable, '-c', "import sys;sys.stdout.buffer.write(bytes([255]))"], **kwargs)
        with patch.object(n.subprocess, 'check_output', side_effect=invalid_output):
            with self.assertRaises(UnicodeDecodeError): n.cargo_metadata(self.root)
    def test_upstream_evidence_remains_byte_exact(self):
        evidence = self.root/'third-party/upstream/LICENSE.md'
        evidence.parent.mkdir()
        original = b'Original license\nCopyright owner\n'
        evidence.write_bytes(original)
        index = {'dependency@1.0.0': [{'path':'third-party/upstream/LICENSE.md',
            'sha256':hashlib.sha256(original).hexdigest(), 'url':'https://example.invalid/LICENSE'}]}
        (self.root/'third-party/cargo-upstream.json').write_text(json.dumps(index))
        n.verify_upstream(self.root)
        self.assertEqual(n.cargo_inventory(self.root, self.metadata)[0]['texts'][0]['text'].encode(), original)
        evidence.write_bytes(original.replace(b'\n', b'\r\n'))
        n.verify_upstream(self.root)
        self.assertEqual(n.authenticated_upstream_bytes(self.root, index['dependency@1.0.0'][0]), original)
        self.assertEqual(n.cargo_inventory(self.root, self.metadata)[0]['texts'][0]['text'].encode(), original)
        evidence.write_bytes(original.replace(b'\n', b'\r\n', 1))
        self.assertEqual(n.authenticated_upstream_bytes(self.root, index['dependency@1.0.0'][0]), original)
        for invalid in (b'\xef\xbb\xbf'+original, original.replace(b'owner', b'owner '), original.replace(b'\n', b'\r')):
            evidence.write_bytes(invalid)
            with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch'):
                n.verify_upstream(self.root)
        evidence.write_bytes(original+b'changed')
        with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch'):
            n.cargo_inventory(self.root, self.metadata)

    def test_upstream_crlf_original_survives_lf_checkout_without_git(self):
        evidence = self.root/'third-party/upstream/LICENSE.md'
        evidence.parent.mkdir()
        original = b'Original license\r\nCopyright owner\r\n'
        evidence.write_bytes(original.replace(b'\r\n', b'\n'))
        item = {'path':'third-party/upstream/LICENSE.md', 'sha256':hashlib.sha256(original).hexdigest()}
        self.assertEqual(n.authenticated_upstream_bytes(self.root, item), original)

    def test_npm_upstream_uses_authenticated_original_line_endings(self):
        import npm_license_inventory as npm
        evidence = self.root/'third-party/upstream/LICENSE.md'
        evidence.parent.mkdir()
        original = b'Original license\nCopyright owner\n'
        item = {'path':'third-party/upstream/LICENSE.md', 'sha256':hashlib.sha256(original).hexdigest(), 'url':'https://example.invalid/LICENSE'}
        evidence.write_bytes(original.replace(b'\n', b'\r\n'))
        def record(): return {'name':'dependency','version':'1.0.0','license':'MIT','errors':['missing-license-text'],'texts':[],'review':[],'warnings':[]}
        result = record()
        npm._supplement(self.root, result, {'dependency@1.0.0':[item]}, {})
        self.assertEqual(result['texts'][0]['text'].encode(), original)
        self.assertEqual(result['errors'], [])
        evidence.write_bytes(original+b'changed')
        result = record()
        npm._supplement(self.root, result, {'dependency@1.0.0':[item]}, {})
        self.assertTrue(any('upstream-supplement-failed' in error for error in result['errors']))

    def test_original_bytes_and_explicit_alternative(self):
        original=b'MIT License\r\nCopyright Original Author\r\n';(self.root/'crate/LICENSE').write_bytes(original)
        item=n.cargo_inventory(self.root,self.metadata)[0]
        self.assertEqual(item['texts'][0]['text'].encode(),original)
        self.assertEqual(item['license_selection'],'MIT');self.assertEqual(item['scope'],['devcel-cli'])
        self.assertEqual(item['errors'],[])
    def test_and_obligations_are_not_dropped(self):
        (self.root/'crate/LICENSE').write_text('Original terms')
        self.package['license']='(MIT OR Apache-2.0) AND Unicode-3.0'
        self.assertEqual(n.cargo_inventory(self.root,self.metadata)[0]['license_selection'],self.package['license'])
    def test_legacy_slash_is_not_silently_reinterpreted(self):
        (self.root/'crate/LICENSE').write_text('Original terms')
        self.package['license']='MIT/Apache-2.0'
        self.assertEqual(n.cargo_inventory(self.root,self.metadata)[0]['license_selection'],'MIT/Apache-2.0')
    def test_missing_text_fails_honestly(self):
        item=n.cargo_inventory(self.root,self.metadata)[0]
        self.assertTrue(item['errors']);self.assertEqual(item['texts'],[])
    def test_render_is_independent_of_local_install_origin(self):
        (self.root/'crate/LICENSE').write_text('Original terms')
        items=n.cargo_inventory(self.root,self.metadata);a=n.render(self.root,items,{})
        items[0]['evidence_origin']='installed:path';items[0]['integrity_verified']=False
        self.assertEqual(a,n.render(self.root,items,{}))
    def embedded_entry(self):
        return {'ecosystem':'npm','name':'example-package','version':'1.2.3',
                'source':'https://registry.npmjs.org/example-package/-/example-package-1.2.3.tgz',
                'license':'MIT','scope':['devcel-studio'],'errors':[],
                'texts':[{'path':'embedded-notices/dist/example.js.L17.COPYRIGHT',
                          'text':'/* Copyright Original Author\r\n * Original terms \u00a9\r\n */'}]}
    def test_embedded_identity_is_reproducible_and_preserves_bytes(self):
        entry=self.embedded_entry();original=entry['texts'][0];raw=original['text'].encode()
        identity={'ecosystem':'npm','package':'example-package','version':'1.2.3',
                  'source_url':entry['source'],'original_path':'dist/example.js','original_line':17,
                  'body_sha256':hashlib.sha256(raw).hexdigest()}
        canonical=json.dumps(identity,sort_keys=True,ensure_ascii=False,separators=(',', ':')).encode()
        label='embedded-notices/source-sha256-'+hashlib.sha256(canonical).hexdigest()+'.COPYRIGHT'
        files=n.render(self.root,[entry],{})
        evidence=json.loads(files['inventory.json'])['packages'][0]['texts'][0]
        self.assertEqual(evidence['path'],label)
        self.assertEqual(files[evidence['file']],raw)
        self.assertIn(('--- '+label+' ---\n').encode()+raw,files['THIRD-PARTY-NOTICES.txt'])
        self.assertNotIn(original['path'].encode(),files['inventory.json'])
        self.assertNotIn(original['path'].encode(),files['THIRD-PARTY-NOTICES.txt'])
        self.assertEqual(original['path'],'embedded-notices/dist/example.js.L17.COPYRIGHT')
        self.assertIn(entry['source'].encode(),files['inventory.json'])
    def test_embedded_identity_binds_every_source_field(self):
        entry=self.embedded_entry();original=entry['texts'][0]
        base=n.embedded_source_identity(entry,original,n.digest(original['text'].encode()))[0]
        for field,value in [('ecosystem','cargo'),('name','another-package'),('version','1.2.4'),('source','https://example.invalid/source')]:
            changed={**entry,field:value}
            self.assertNotEqual(base,n.embedded_source_identity(changed,original,n.digest(original['text'].encode()))[0])
        for path in ['embedded-notices/other.js.L17.COPYRIGHT','embedded-notices/dist/example.js.L18.COPYRIGHT']:
            self.assertNotEqual(base,n.embedded_source_identity(entry,{**original,'path':path},n.digest(original['text'].encode()))[0])
        self.assertNotEqual(base,n.embedded_source_identity(entry,original,n.digest(b'Different original terms'))[0])
    def test_all_embedded_paths_use_ids_and_duplicate_references_are_retained(self):
        entry=self.embedded_entry();original=entry['texts'][0]
        entry['texts']=[original,dict(original),{**original,'path':'embedded-notices/other.js.L17.COPYRIGHT'},
                        {'path':'LICENSE','text':'Dedicated license text'}]
        files=n.render(self.root,[entry],{})
        texts=json.loads(files['inventory.json'])['packages'][0]['texts']
        self.assertEqual(len(texts),4)
        self.assertEqual(texts[0]['path'],texts[1]['path'])
        self.assertNotEqual(texts[0]['path'],texts[2]['path'])
        for text in texts[:3]:self.assertRegex(text['path'],r'^embedded-notices/source-sha256-[a-f0-9]{64}\.COPYRIGHT$')
        self.assertEqual(texts[3]['path'],'LICENSE')
    def test_different_embedded_identities_cannot_share_a_digest(self):
        entry=self.embedded_entry();original=entry['texts'][0]
        entry['texts'].append({**original,'path':'embedded-notices/other.js.L17.COPYRIGHT'})
        with patch.object(n,'digest',return_value='0'*64):
            with self.assertRaisesRegex(RuntimeError,'identity collision'):n.render(self.root,[entry],{})
    def test_embedded_identity_prefers_authentic_evidence_url(self):
        entry=self.embedded_entry();original={**entry['texts'][0],'url':'https://example.invalid/upstream/source'}
        _,canonical=n.embedded_source_identity(entry,original,n.digest(original['text'].encode()))
        self.assertEqual(json.loads(canonical)['source_url'],original['url'])
        entry['source']='';entry['bundled_from']={'source':'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz'}
        _,canonical=n.embedded_source_identity(entry,entry['texts'][0],n.digest(original['text'].encode()))
        self.assertEqual(json.loads(canonical)['source_url'],entry['bundled_from']['source'])
    def test_stale_lock_and_missing_text_block_packaging(self):
        (self.root/'crate/LICENSE').write_text('Original terms')
        entries=n.cargo_inventory(self.root,self.metadata);files=n.render(self.root,entries,n.lock_hashes(self.root))
        out=self.root/'third-party/generated'
        for name,data in files.items():
            path=out/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        public=self.root/'devcel-studio/public/legal';public.mkdir(parents=True)
        (public/'THIRD-PARTY-NOTICES.txt').write_bytes(files['THIRD-PARTY-NOTICES.txt'])
        n.verify_locks(self.root)
        (self.root/'Cargo.lock').write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'stale'): n.verify_locks(self.root)
    def test_shared_evidence_checks_each_hash_and_each_invocation(self):
        (self.root/'crate/LICENSE').write_text('Original terms')
        entries=n.cargo_inventory(self.root,self.metadata)
        entries[0]['texts'].append(dict(entries[0]['texts'][0]))
        files=n.render(self.root,entries,n.lock_hashes(self.root))
        out=self.root/'third-party/generated'
        for name,data in files.items():
            path=out/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        public=self.root/'devcel-studio/public/legal';public.mkdir(parents=True)
        (public/'THIRD-PARTY-NOTICES.txt').write_bytes(files['THIRD-PARTY-NOTICES.txt'])
        n.verify_locks(self.root)
        manifest=json.loads(files['inventory.json'])
        manifest['packages'][0]['texts'][1]['sha256']='0'*64
        (out/'inventory.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError,'changed or missing'): n.verify_locks(self.root)
        (out/'inventory.json').write_bytes(files['inventory.json'])
        evidence=out/manifest['packages'][0]['texts'][0]['file']
        evidence.write_text('Changed after the earlier successful verification')
        with self.assertRaisesRegex(RuntimeError,'changed or missing'): n.verify_locks(self.root)
    def test_std_toolchain_mismatch_fails(self):
        (self.root/'rust-toolchain.toml').write_text('[toolchain]\nchannel = "2.0.0"\n')
        (self.root/'third-party/rust-standard-library.json').write_text(json.dumps({'rust_version':'1.99.0'}))
        with self.assertRaisesRegex(RuntimeError,'toolchain'):n.rust_standard_library_inventory(self.root)

if __name__=='__main__':unittest.main()
