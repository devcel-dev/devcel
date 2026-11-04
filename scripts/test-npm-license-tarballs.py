#!/usr/bin/env python3
"""Exercise original tarball evidence and npm's current inBundle lock contract.

No network or npm installation is required. Synthetic bytes are test fixtures,
never generated license evidence for real dependencies.
"""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import npm_license_inventory as inventory


class TarballEvidence(unittest.TestCase):
    def test_concurrent_download_reuses_verified_cache_without_replacing_open_reader(self):
        import threading
        import time
        from concurrent.futures import ThreadPoolExecutor
        payload = b'Authenticated concurrent download fixture'
        integrity = 'sha512-'+base64.b64encode(hashlib.sha512(payload).digest()).decode()
        url = 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz'
        start = threading.Barrier(2)
        handles = []
        replace = inventory.os.replace
        class Response(io.BytesIO):
            def geturl(self): return url
        def download(*args, **kwargs):
            time.sleep(0.05)  # Both callers encounter an initially empty cache.
            return Response(payload)
        def publish(source, destination):
            replace(source, destination)
            handles.append(Path(destination).open('rb'))
        def call():
            start.wait(timeout=5)
            return inventory._download(url, integrity, self.cache)
        try:
            with patch.dict(os.environ, {'DEVCEL_NPM_LICENSE_OFFLINE':'0'}), \
                    patch.object(inventory.urllib.request, 'urlopen', side_effect=download) as request, \
                    patch.object(inventory.os, 'replace', side_effect=publish):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(lambda _: call(), range(2)))
            self.assertEqual(results[0], results[1])
            self.assertEqual(request.call_count, 1)
            self.assertEqual(results[0].read_bytes(), payload)
            self.assertFalse(list(self.cache.glob('*.partial')))
        finally:
            for handle in handles: handle.close()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.parent = 'node_modules/@owner/bundle'
        self.child = self.parent + '/node_modules/@scope/child'
        self.subpath = 'node_modules/@scope/child'
        self.entries = [
            ('package/package.json', self.manifest('@owner/bundle')),
            ('package/LICENSE', b'Parent terms only'),
            ('package/' + self.subpath + '/package.json', self.manifest('@scope/child')),
            ('package/' + self.subpath + '/LICENSE', b'Original child terms\r\n'),
            ('package/node_modules/sibling/package.json', self.manifest('sibling')),
            ('package/node_modules/sibling/LICENSE', b'Sibling terms only'),
            ('package/' + self.subpath + '/node_modules/inner/LICENSE', b'Nested terms only'),
        ]
        self.packages = {
            self.parent: {'version': '1.0.0', 'resolved': 'https://registry.npmjs.org/@owner/bundle/-/bundle-1.0.0.tgz'},
            self.child: {'version': '1.0.0', 'inBundle': True, 'license': 'MIT', 'dev': True, 'optional': True},
        }
        self.offline = patch.dict(os.environ, {'DEVCEL_NPM_LICENSE_OFFLINE': '1'})
        self.offline.start()
        self.addCleanup(self.offline.stop)

    @staticmethod
    def manifest(name, version='1.0.0', license='MIT'):
        return json.dumps({'name': name, 'version': version, 'license': license}).encode()

    def tarball(self, entries):
        path = self.root / 'fixture.tgz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in entries:
                member = tarfile.TarInfo(name)
                if isinstance(data, tuple):
                    member.type, member.linkname = data
                    archive.addfile(member)
                else:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
        return path

    def cache_tarball(self, entries=None, owner=None):
        owner = owner or self.parent
        path = self.tarball(self.entries if entries is None else entries)
        raw = path.read_bytes()
        locked = self.packages[owner]
        locked['integrity'] = 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode()
        key = hashlib.sha256((locked['resolved'] + '\n' + locked['integrity']).encode()).hexdigest()
        cached = self.cache / (key + '.tgz')
        cached.write_bytes(raw)
        return cached

    def collect(self, child=None):
        child = child or self.child
        return inventory._collect_one(self.repo, 'package-lock.json', child,
                                      self.packages[child], self.cache, packages=self.packages)

    def assert_failed(self, record):
        self.assertTrue(record['errors'])
        self.assertFalse(record['integrity_verified'])
        self.assertEqual(record['texts'], [])

    def test_normal_and_named_tarball_roots(self):
        for root in ('package', 'react'):
            with self.subTest(root=root):
                errors = []
                result = inventory._read_tarball(self.tarball([
                    (root + '/package.json', self.manifest('@types/react')),
                    (root + '/LICENSE', b'Original license fixture'),
                ]), errors)
                self.assertEqual(errors, [])
                self.assertEqual(result['LICENSE'], b'Original license fixture')
                self.assertEqual(json.loads(result['package.json'])['name'], '@types/react')

    def test_ambiguous_and_duplicate_manifests_rejected(self):
        for extra in ('other/package.json', './package/package.json'):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                inventory._read_tarball(self.tarball(self.entries + [(extra, b'{}')]), [])

    def test_bundle_original_bytes_and_explicit_provenance(self):
        self.cache_tarball()
        record = self.collect()
        self.assertEqual(record['errors'], [])
        self.assertTrue(record['integrity_verified'])
        self.assertEqual(record['evidence_origin'], 'bundled-registry-tarball')
        self.assertEqual(record['texts'], [{'path': 'LICENSE', 'text': 'Original child terms\r\n'}])
        self.assertEqual(record['source'], '')
        self.assertEqual(record['integrity'], '')
        self.assertEqual(record['bundled_from']['package_path'], self.parent)
        self.assertEqual(record['bundled_from']['package_subpath'], self.subpath)
        self.assertEqual(record['bundled_from']['integrity'], self.packages[self.parent]['integrity'])
        self.assertEqual(record['scope'], 'dev-only')
        self.assertTrue(record['optional'])

    def test_bundle_never_trusts_installed_copy(self):
        installed = self.repo / self.child
        installed.mkdir(parents=True)
        (installed / 'package.json').write_bytes(self.manifest('@scope/child'))
        (installed / 'LICENSE').write_text('Unverified local text')
        self.cache_tarball()
        self.assertEqual(self.collect()['texts'][0]['text'], 'Original child terms\r\n')

    def test_parent_integrity_required_even_with_matching_installed_copy(self):
        cached = self.cache_tarball()
        cached.write_bytes(cached.read_bytes() + b'corruption')
        self.assert_failed(self.collect())
        self.packages[self.parent].pop('integrity')
        self.assert_failed(self.collect())

    def test_parent_source_must_be_official_registry(self):
        self.cache_tarball()
        self.packages[self.parent]['resolved'] = 'https://example.com/bundle.tgz'
        self.assert_failed(self.collect())

    def test_parent_and_child_identity_must_match(self):
        for name in ('package/package.json', 'package/' + self.subpath + '/package.json'):
            for bad in (self.manifest('different'), self.manifest('@scope/child', '9.9.9')):
                with self.subTest(name=name, bad=bad):
                    self.cache_tarball([(n, bad if n == name else data) for n, data in self.entries])
                    self.assert_failed(self.collect())

    def test_alias_uses_lockfile_name(self):
        self.packages[self.child]['name'] = 'actual-name'
        self.cache_tarball([(n, self.manifest('actual-name') if n == 'package/' + self.subpath + '/package.json' else data)
                            for n, data in self.entries])
        record = self.collect()
        self.assertEqual(record['errors'], [])
        self.assertEqual(record['name'], 'actual-name')

    def test_nested_bundle_checks_intermediate_identity(self):
        nested = self.child + '/node_modules/nested'
        self.packages[nested] = {'version': '1.0.0', 'inBundle': True}
        entries = self.entries + [
            ('package/' + self.subpath + '/node_modules/nested/package.json', self.manifest('nested')),
            ('package/' + self.subpath + '/node_modules/nested/LICENSE', b'Nested package terms'),
        ]
        self.cache_tarball(entries)
        record = self.collect(nested)
        self.assertEqual(record['errors'], [])
        self.assertEqual(record['texts'][0]['text'], 'Nested package terms')
        self.assertEqual(record['bundled_from']['package_path'], self.parent)
        self.packages[self.child]['version'] = '2.0.0'
        self.assert_failed(self.collect(nested))
        del self.packages[self.child]
        self.assert_failed(self.collect(nested))

    def test_subtree_reader_requires_complete_identity_chain(self):
        path = self.tarball(self.entries)
        for expected in (None, {'': ('@owner/bundle', '1.0.0')},
                         {self.subpath: ('@scope/child', '1.0.0')}):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                inventory._read_tarball(path, [], self.subpath, expected)

    def test_nearest_nonbundled_ancestor_owns_tarball(self):
        nested = self.child + '/node_modules/nested'
        self.packages[self.child] = {'version': '1.0.0', 'resolved': 'https://registry.npmjs.org/child/-/child-1.0.0.tgz'}
        self.packages[nested] = {'version': '1.0.0', 'inBundle': True}
        self.cache_tarball([
            ('package/package.json', self.manifest('@scope/child')),
            ('package/node_modules/nested/package.json', self.manifest('nested')),
            ('package/node_modules/nested/LICENSE', b'Nearest parent original terms'),
        ], owner=self.child)
        record = self.collect(nested)
        self.assertEqual(record['errors'], [])
        self.assertEqual(record['bundled_from']['package_path'], self.child)
        self.packages[self.child].pop('integrity')
        self.assert_failed(self.collect(nested))

    def test_missing_linked_or_root_ancestor_rejected(self):
        self.cache_tarball()
        original = copy.deepcopy(self.packages)
        for replacement in (None, {'link': True}, {'version': '1.0.0', 'inBundle': True}):
            with self.subTest(replacement=replacement):
                self.packages = copy.deepcopy(original)
                if replacement is None:
                    del self.packages[self.parent]
                else:
                    self.packages[self.parent] = replacement
                self.assert_failed(self.collect())

    def test_package_boundaries_reject_directory_and_traversal_confusion(self):
        for value in (
            'node_modules/parent/lib/node_modules/child',
            'node_modules/parent/../node_modules/child',
            'node_modules/parent//node_modules/child',
            '/node_modules/parent/node_modules/child',
            'node_modules/parent\\node_modules/child',
            'node_modules/@scope', 'node_modules/@scope/node_modules/child',
        ):
            with self.subTest(path=value), self.assertRaises(ValueError):
                inventory._bundle_source(value, self.packages)

    def test_unsafe_tar_member_rejected_even_outside_target(self):
        for name in ('package/../outside', '/outside', 'package\\outside'):
            with self.subTest(name=name):
                self.cache_tarball(self.entries + [(name, b'Unsafe')])
                self.assert_failed(self.collect())

    def test_linked_manifest_or_package_ancestor_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            for name in ('package/' + self.subpath, 'package/node_modules', 'package/' + self.subpath + '/package.json'):
                with self.subTest(kind=kind, name=name):
                    entries = [(n, d) for n, d in self.entries if n != name]
                    self.cache_tarball(entries + [(name, (kind, 'elsewhere'))])
                    self.assert_failed(self.collect())

    def test_linked_license_and_directory_are_not_followed(self):
        prefix = 'package/' + self.subpath
        for additions in (
            [(prefix + '/LICENSE', (tarfile.SYMTYPE, '../../LICENSE'))],
            [(prefix + '/LICENSE', (tarfile.LNKTYPE, 'package/LICENSE'))],
            [(prefix + '/legal', (tarfile.SYMTYPE, '../../legal')), (prefix + '/legal/LICENSE', b'Untrusted terms')],
        ):
            with self.subTest(additions=additions):
                self.cache_tarball([(n, d) for n, d in self.entries if n != prefix + '/LICENSE'] + additions)
                record = self.collect()
                self.assertTrue(record['errors'])
                self.assertEqual(record['texts'], [])

    def test_declared_license_stays_in_target_package(self):
        prefix = 'package/' + self.subpath
        for reference in ('../LICENSE', '/LICENSE', 'node_modules/inner/LICENSE'):
            with self.subTest(reference=reference):
                self.cache_tarball([(n, self.manifest('@scope/child', license='SEE LICENSE IN ' + reference)
                                     if n == prefix + '/package.json' else d) for n, d in self.entries])
                self.assert_failed(self.collect())
        entries = [(n, self.manifest('@scope/child', license='SEE LICENSE IN terms.txt')
                    if n == prefix + '/package.json' else d)
                   for n, d in self.entries if n != prefix + '/LICENSE']
        self.cache_tarball(entries + [(prefix + '/terms.txt', b'Original referenced terms')])
        record = self.collect()
        self.assertEqual(record['errors'], [])
        self.assertEqual(record['texts'], [{'path': 'terms.txt', 'text': 'Original referenced terms'}])

    def test_collect_passes_complete_lock_context(self):
        self.cache_tarball()
        (self.repo / 'package-lock.json').write_text(json.dumps({'lockfileVersion': 3, 'packages': {'': {}, **self.packages}}))
        (self.repo / 'devcel-studio').mkdir()
        (self.repo / 'devcel-studio/package-lock.json').write_text(json.dumps({'lockfileVersion': 3, 'packages': {'': {}}}))
        with patch.dict(os.environ, {'DEVCEL_NPM_LICENSE_CACHE': str(self.cache)}):
            result = inventory.collect(self.repo)
        self.assertEqual(len(result), 2)
        self.assertTrue(all(not record['errors'] for record in result))
        self.assertTrue(all(record['integrity_verified'] for record in result))


if __name__ == '__main__':
    unittest.main(verbosity=2)
