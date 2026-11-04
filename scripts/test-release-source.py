#!/usr/bin/env python3
"""Offline regressions for revision-pinned source access and provenance gates."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import release_source as source


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2)+'\n', encoding='utf-8')


class SourceDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'Cargo.lock').write_text('version = 4\n[[package]]\nname = "mpl"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "'+('1'*64)+'"\n', encoding='utf-8')
        packages = {'': {'name':'fixture'}, 'node_modules/runtime': {'version':'1.0.0', 'resolved':'https://registry.npmjs.org/runtime/-/runtime-1.0.0.tgz', 'integrity':'sha512-runtime'},
                    'node_modules/builder': {'version':'2.0.0','dev':True,'resolved':'https://registry.npmjs.org/builder/-/builder-2.0.0.tgz','integrity':'sha512-builder'}}
        for lock in source.LOCKS[1:]: write(self.root/lock, {'packages':packages})
        write(self.root/'third-party/generated/inventory.json', {'inputs':{name:source.digest(self.root/name) for name in source.LOCKS},'packages':[{'ecosystem':'cargo','name':'mpl','version':'1.0.0','license_selection':'MPL-2.0','checksum':'1'*64}]})
        self.manifest = {'schema_version':1,'locks':{name:source.digest(self.root/name) for name in source.LOCKS},
            'cargo':[{'name':'mpl','version':'1.0.0','sha256':'1'*64,'repository':'https://github.com/upstream/mpl','commit':'b'*40,'directory':'src','source_kind':'upstream-git','evidence':'Verified crate source bytes and VCS metadata.'}],
            'npm':[{'name':'runtime','version':'1.0.0','tarball':packages['node_modules/runtime']['resolved'],'integrity':'sha512-runtime','repository':'https://github.com/upstream/runtime','commit':'c'*40,'directory':'packages/runtime','source_kind':'upstream-git','evidence':'Exact registry identity/artifact and publishing commit.'}]}
        self.save()

    def save(self):
        write(self.root/source.MANIFEST, self.manifest)

    def index(self):
        return source.source_index('owner/repo', 'a'*40, 'v1.0.0', self.root)

    def test_complete_bounded_source_inventory(self):
        result = self.index()
        self.assertEqual(len(result['preferred_sources']),2)
        self.assertEqual(len(result['npm_registry_artifacts']),4)
        self.assertEqual(result['cargo_registry_sources'][0]['url'],'https://static.crates.io/crates/mpl/mpl-1.0.0.crate')
        self.assertTrue(all('a'*40 in url for url in result['source'].values()))
        self.assertNotIn('/main/', json.dumps(result))

    def test_changed_lock_requires_source_refresh(self):
        with (self.root/'Cargo.lock').open('a') as stream: stream.write('# changed\n')
        with self.assertRaisesRegex(ValueError,'refreshed'): self.index()

    def test_stale_license_inventory_cannot_hide_copyleft_changes(self):
        path=self.root/'third-party/generated/inventory.json';data=json.loads(path.read_text());data['inputs']['Cargo.lock']='stale';write(path,data)
        with self.assertRaisesRegex(ValueError,'inventory is stale'): self.index()

    def test_checkout_line_endings_do_not_change_lock_evidence(self):
        # Fixtures already use CRLF when write_text runs on Windows. Normalize
        # before conversion, and repeat CRLF to exercise an unchanged checkout.
        for attempt, newline in enumerate((b'\n', b'\r\n', b'\r\n', b'\n')):
            with self.subTest(attempt=attempt, newline=newline):
                for lock in source.LOCKS:
                    path = self.root / lock
                    canonical = path.read_bytes().replace(b'\r\n', b'\n')
                    path.write_bytes(canonical.replace(b'\n', newline))
                self.index()

    def test_malformed_crcrlf_does_not_bypass_lock_evidence(self):
        path = self.root / 'Cargo.lock'
        canonical = path.read_bytes().replace(b'\r\n', b'\n')
        path.write_bytes(canonical.replace(b'\n', b'\r\r\n'))
        with self.assertRaisesRegex(ValueError, 'refreshed'):
            self.index()

    def test_missing_or_duplicate_runtime_source_is_not_silently_excluded(self):
        for value in ([], self.manifest['npm']*2):
            self.manifest['npm']=value;self.save()
            with self.assertRaisesRegex(ValueError,'coverage differs'): self.index()

    def test_standalone_and_bundled_origins_are_both_retained(self):
        lock=self.root/'package-lock.json'; data=json.loads(lock.read_text())
        data['packages']['node_modules/builder/node_modules/runtime']={'version':'1.0.0','inBundle':True,'dev':True}
        write(lock,data)
        self.manifest['locks']={name:source.digest(self.root/name) for name in source.LOCKS};self.save()
        inventory=self.root/'third-party/generated/inventory.json'; data=json.loads(inventory.read_text());data['inputs']=self.manifest['locks'];write(inventory,data)
        index=self.index()
        origins=[p for p in index['npm_registry_artifacts'] if p['name']=='runtime']
        self.assertEqual(len(origins),3)
        self.assertTrue(any(p.get('bundled_from',{}).get('tarball','').endswith('/builder-2.0.0.tgz') for p in origins))
        self.assertTrue(any(p['tarball'] and p['tarball'].endswith('/runtime-1.0.0.tgz') for p in origins))
        self.assertEqual(source.npm_packages(self.root)['runtime@1.0.0']['integrity'],'sha512-runtime')

    def test_dev_only_artifacts_do_not_require_runtime_entries(self):
        self.assertEqual(len(source.validate_preferred_sources(self.root)['npm']),1)
        self.assertFalse(next(p for p in self.index()['npm_registry_artifacts'] if p['name']=='builder')['runtime'])

    def test_runtime_artifact_url_and_integrity_must_match(self):
        for field in ('integrity','tarball'):
            original=self.manifest['npm'][0][field]
            self.manifest['npm'][0][field]='wrong';self.save()
            with self.assertRaisesRegex(ValueError,field+' mismatch'): self.index()
            self.manifest['npm'][0][field]=original

    def test_mpl_crate_checksum_must_match(self):
        self.manifest['cargo'][0]['sha256']='2'*64;self.save()
        with self.assertRaisesRegex(ValueError,'crate checksum mismatch'): self.index()

    def test_moving_branches_are_not_preferred_source(self):
        self.manifest['npm'][0]['commit']='main';self.save()
        with self.assertRaisesRegex(ValueError,'full upstream commit'): self.index()

    def test_registry_artifact_needs_explicit_editable_source_evidence(self):
        entry=self.manifest['npm'][0];entry['source_kind']='registry-source';entry.pop('commit');entry.pop('repository');self.save()
        with self.assertRaisesRegex(ValueError,'editable source paths'): self.index()
        entry['source_paths']=['src/index.ts'];self.save()
        self.assertEqual(self.index()['preferred_sources'][1]['source_url'],entry['tarball'])

    def test_evidence_is_required(self):
        self.manifest['npm'][0].pop('evidence');self.save()
        with self.assertRaisesRegex(ValueError,'evidence'): self.index()

    def test_upstream_locations_are_safe(self):
        for repo in ('https://github.com/upstream/repo.git','https://evil.example/upstream/repo','https://user:password@github.com/upstream/repo'):
            self.manifest['npm'][0]['repository']=repo;self.save()
            with self.assertRaises(ValueError): self.index()
        self.manifest['npm'][0]['repository']='https://github.com/upstream/repo'
        self.manifest['npm'][0]['directory']='../outside';self.save()
        with self.assertRaisesRegex(ValueError,'Unsafe'): self.index()

    def test_source_index_cannot_be_reused_for_another_revision(self):
        path=self.root/source.ASSET
        source.write_index(path,'owner/repo','a'*40,'v1.0.0',self.root)
        source.validate_index(path,'owner/repo','a'*40,'v1.0.0',self.root)
        with self.assertRaisesRegex(ValueError,'does not match'):
            source.validate_index(path,'owner/repo','d'*40,'v1.0.0',self.root)
        path.unlink()
        with self.assertRaisesRegex(ValueError,'required'):
            source.validate_index(path,'owner/repo','a'*40,'v1.0.0',self.root)

    def test_visibility_notes_do_not_promise_public_access(self):
        for visibility in ('private','internal'):
            text=source.source_notes(self.index(),visibility)
            self.assertIn('require repository read access',text)
            self.assertNotIn('publicly accessible',text)
        self.assertIn('publicly accessible',source.source_notes(self.index(),'public'))
        with self.assertRaisesRegex(ValueError,'visibility'):
            source.source_notes(self.index(),None)

    def test_release_notes_link_source_and_rebuild_next_to_binaries(self):
        text=source.source_notes(self.index(),'public')
        for key in ('browse','tar_gz','zip','build','dependencies','delivery'):
            self.assertIn(self.index()['source'][key],text)
        self.assertIn('SOURCE-ACCESS.json',text)

    def test_source_checks_are_read_only_anonymous_and_fail_closed(self):
        response=type('Response',(),{'status':200,'geturl':lambda self:'https://codeload.github.com/upstream/repo/tar.gz/'+'b'*40,
            '__enter__':lambda self:self,'__exit__':lambda *args:None})()
        with patch.object(source.urllib.request,'urlopen',return_value=response) as open_url:
            self.assertEqual(source.verify_source_urls(self.index()),2)
            for call in open_url.call_args_list:
                request=call.args[0]
                self.assertEqual(request.get_method(),'HEAD')
                self.assertNotIn('Authorization',request.headers)
        with patch.object(source.urllib.request,'urlopen',side_effect=OSError('source unavailable')):
            with self.assertRaisesRegex(OSError,'unavailable'): source.verify_source_urls(self.index())

    def test_invalid_release_identifiers_rejected(self):
        for repository,commit,tag in [('owner/repo/extra','a'*40,'v1.0.0'),('owner/repo','main','v1.0.0'),('owner/repo','a'*40,'../main')]:
            with self.assertRaises(ValueError): source.source_index(repository,commit,tag,self.root)


if __name__ == '__main__': unittest.main()
