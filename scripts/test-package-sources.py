#!/usr/bin/env python3
"""Offline regressions for importer documentation and source-archive boundaries."""
from __future__ import annotations
import base64, hashlib, importlib.util, io, json, os, re, tarfile, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

importers = load('package_importers', 'package-importers.py')
studio = load('package_studio_source', 'package-studio-source.py')


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text, encoding='utf-8')


class PackagingSources(unittest.TestCase):
    def test_checked_in_git_sdk_discloses_older_native_tools(self):
        repo = HERE.parent
        import unity_toolchain
        required = json.loads((repo/'importers/unity/Editor/NativeRequirements.json').read_text(encoding='utf-8'))
        if required['source_fingerprint'] != unity_toolchain.fingerprint(repo):
            readme = (repo/'importers/unity/README.md').read_text(encoding='utf-8')
            self.assertIn('published', readme)
            self.assertIn('next matching native distribution', readme)

    def test_checked_in_mobile_guide_matches_current_template(self):
        repo = HERE.parent
        template = (repo/'importers/unity-template/Documentation~/MOBILE.md').read_text(encoding='utf-8')
        packaged = (repo/'importers/unity/Documentation~/MOBILE.md').read_text(encoding='utf-8')
        self.assertEqual(packaged, template)
        self.assertIn('Release v0.0.3 supplies', packaged)
        self.assertNotIn('Simulator libraries are intentionally absent', packaged)
        install = (repo/'importers/unity/Documentation~/repository/importers/unity/INSTALL.md').read_text(encoding='utf-8')
        self.assertNotIn('Other Android ABIs, iOS Simulator and WebGL remain unsupported', install)
        self.assertNotIn('As of 2026-11-04, the published v0.0.1', install)

    def test_scratch_cleanup_is_only_deferred_on_github_hosted_runners(self):
        for actions, runner, retained in (('', '', False), ('true', 'self-hosted', False),
                                          ('', 'github-hosted', False), ('true', 'github-hosted', True)):
            for failure in (False, True):
                with self.subTest(actions=actions, runner=runner, failure=failure), tempfile.TemporaryDirectory() as parent:
                    with patch.dict(os.environ, {'GITHUB_ACTIONS': actions, 'RUNNER_ENVIRONMENT': runner}), \
                         patch.object(tempfile, 'tempdir', parent):
                        try:
                            with importers.package_scratch() as scratch:
                                path = Path(scratch)
                                (path/'source').write_text('preserved source')
                                if failure:
                                    raise RuntimeError('verification failed')
                        except RuntimeError as error:
                            self.assertEqual(str(error), 'verification failed')
                        self.assertEqual(path.exists(), retained)
                        if retained:
                            self.assertEqual((path/'source').read_text(), 'preserved source')

    def test_repository_license_notice_paths_and_component_licenses(self):
        repo = HERE.parent
        notice = (repo/'LICENSE-NOTICE').read_text(encoding='utf-8')
        self.assertIn('matching complete source repository', notice)
        for component in ('devcel-core','devcel-studio','devcel-cli','devcel-runtime'):
            self.assertTrue((repo/component/'LICENSE').is_file())
            self.assertIn(component+'/LICENSE', notice)
        engines = ('unity','godot','unreal','rpgmaker','wolf','gamemaker','defold','cocos','javascript')
        for engine in engines:
            self.assertIn('- importers/'+engine+'\n', notice)
            self.assertIn('MIT License', (repo/'importers'/engine/'LICENSE').read_text(encoding='utf-8'))
        self.assertIn('GNU GENERAL PUBLIC LICENSE', (repo/'devcel-studio/LICENSE').read_text(encoding='utf-8'))
        self.assertFalse((repo/'devcel-studio/app-settings/LICENSE').exists())

    def test_first_party_application_and_unity_identities(self):
        repo = HERE.parent
        app = json.loads((repo/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
        unity = json.loads((repo/'importers/unity-template/package.json').read_text(encoding='utf-8'))
        self.assertEqual(app['identifier'], 'org.devcel')
        self.assertEqual(unity['name'], 'org.devcel.unity')
        self.assertIn('"org.devcel.unity":', (repo/'importers/unity-template/README.md').read_text(encoding='utf-8'))
        self.assertIn('Packages/org.devcel.unity', (repo/'importers/unity-template/Editor/DevcelPaths.cs').read_text(encoding='utf-8'))
        # Package paths derive from Unity's resolved package metadata, without an alias.
        paths = (repo/'importers/unity-template/Editor/DevcelPaths.cs').read_text(encoding='utf-8')
        self.assertIn('"Packages/" + info.name', paths)
        # Preserve the ordinary display and npm names independently of reverse-DNS IDs.
        self.assertEqual(app['app']['windows'][0]['title'], 'Devcel Studio')
        javascript = json.loads((repo/'importers/javascript/package.json').read_text(encoding='utf-8'))
        self.assertEqual(javascript['name'], '@devcel/javascript')

    def test_unity_cli_release_contract(self):
        repo = HERE.parent
        package = json.loads((repo/'importers/unity-template/package.json').read_text(encoding='utf-8'))
        self.assertNotIn('version', package)
        self.assertEqual(importers.verify_unity_version(repo), importers.read_version(repo))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root/'devcel-studio/src-tauri/tauri.conf.json', json.dumps({'version':'3.2.1-rc.2'}))
            write(root/'importers/unity-template/package.json', json.dumps({'name':'org.devcel.unity'}))
            self.assertEqual(importers.verify_unity_version(root), '3.2.1-rc.2')
            for data in [{'name':'org.devcel.unity', 'version':'3.2.0'},
                         {'name':'other.package', 'version':'3.2.1-rc.2'},
                         {'name':'org.devcel.unity', 'version':None}]:
                write(root/'importers/unity-template/package.json', json.dumps(data))
                with self.assertRaises((RuntimeError, ValueError)):
                    importers.verify_unity_version(root)
            for invalid in ['', '1.2', '1.02.3', '1.2.3-01', '1.2.3+build', '1.2.3\n']:
                write(root/'devcel-studio/src-tauri/tauri.conf.json', json.dumps({'version':invalid}))
                write(root/'importers/unity-template/package.json', json.dumps({'name':'org.devcel.unity', 'version':invalid}))
                with self.assertRaises((RuntimeError, ValueError)):
                    importers.verify_unity_version(root)

    def test_unity_drift_fails_before_output_or_compile(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root/'devcel-studio/src-tauri/tauri.conf.json', json.dumps({'version':'3.2.1'}))
            write(root/'importers/unity-template/package.json', json.dumps({'name':'org.devcel.unity', 'version':'3.2.0'}))
            out = root/'out'
            argv = ['package-importers.py', '--repo', str(root), '--out', str(out),
                    '--source-repository', 'example/repo', '--source-commit', 'a'*40]
            with patch.object(importers.sys, 'argv', argv), patch.object(importers, 'run', side_effect=AssertionError('Must not build')):
                with self.assertRaisesRegex(RuntimeError, 'release-version'):
                    importers.main()
            self.assertFalse(out.exists())

    def test_isolated_cli_excludes_studio_owned_assets_and_tests(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); repo = root/'repo'; dest = root/'source'; dest.mkdir()
            for crate in ('devcel-cli', 'devcel-core', 'devcel-runtime'):
                write(repo/crate/'Cargo.toml', '[package]\nname="fixture"\n')
            write(repo/'devcel-cli/LICENSE', 'MIT fixture')
            write(repo/'devcel-studio/src-tauri/tests/user_color_swatches_store.rs', 'Studio-owned test')
            write(repo/'devcel-core/tests/keep.rs', 'ordinary core test')
            write(repo/'devcel-studio/LICENSE', 'GPL fixture')
            write(repo/'devcel-studio/app-settings/studio.devcelproj.toml', 'Studio seed fixture')
            write(repo/'Cargo.toml', '[workspace]\nmembers = ["devcel-cli", "devcel-core", "devcel-runtime", "devcel-studio/src-tauri"]\n')
            for name in ('Cargo.lock', 'rust-toolchain.toml', 'LICENSE-NOTICE'): write(repo/name, 'fixture')
            importers.copy_sources(repo, dest)
            self.assertFalse((dest/'devcel-core/tests/user_color_swatches_store.rs').exists())
            self.assertTrue((dest/'devcel-core/tests/keep.rs').is_file())
            self.assertFalse((dest/'devcel-studio').exists())
            self.assertFalse((dest/'app-settings').exists())
            self.assertTrue((repo/'devcel-studio/src-tauri/tests/user_color_swatches_store.rs').is_file())

    def test_document_graph_is_local_and_code_is_not_copied(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); repo = root/'repo'; stage = root/'stage'; dest = stage/'sdk'; bundled = dest/'bin'
            write(repo/'importers/javascript/README.md', '[Guide](../../docs/manual/guide.md)\n<picture><source srcset="../../assets/logo.svg"><img src="../../assets/logo.svg"></picture>\n')
            write(repo/'docs/manual/guide.md', '[Other](other.md#topic) ![Image](a%20b.png) [Code](../../devcel-studio/file.rs) [Studio guide](../../devcel-studio/guide.md)\n')
            write(repo/'docs/manual/other.md', '# Topic\n[Guide](guide.md)\n')
            write(repo/'docs/manual/a b.png', 'image fixture')
            write(repo/'assets/logo.svg', '<svg/>')
            write(repo/'devcel-studio/file.rs', '// GPL implementation fixture')
            write(repo/'devcel-studio/guide.md', 'GPL Studio documentation fixture')
            write(repo/'docs/development/importer-packaging.md', '[Guide](../manual/guide.md)\n')
            write(dest/'README.md', 'replaced'); write(bundled/'README.md', 'replaced')
            importers.bundle_documentation(repo, stage, dest, 'javascript', bundled, 'a'*40, 'example/project')
            docs = dest/'Documentation/repository/docs/manual'
            self.assertTrue((docs/'a b.png').is_file())
            self.assertTrue((dest/'Documentation/repository/assets/logo.svg').is_file())
            self.assertIn('srcset="Documentation/repository/assets/logo.svg"', (dest/'README.md').read_text(encoding='utf-8'))
            self.assertIn('a%20b.png', (docs/'guide.md').read_text(encoding='utf-8'))
            self.assertIn('https://github.com/example/project/blob/'+'a'*40+'/devcel-studio/file.rs', (docs/'guide.md').read_text(encoding='utf-8'))
            self.assertFalse(any(stage.rglob('*.rs')))
            self.assertFalse((dest/'Documentation/repository/devcel-studio').exists())
            self.assertIn('/devcel-studio/guide.md', (docs/'guide.md').read_text(encoding='utf-8'))
            self.assertTrue((dest/'INSTALL.md').is_file())
            write(repo/'docs/manual/guide.md', '[Missing](absent.md)\n')
            with self.assertRaises(RuntimeError):
                importers.bundle_documentation(repo, stage, dest, 'javascript', bundled, 'a'*40, 'example/project')

    def test_source_release_contains_documented_examples_and_test_harnesses(self):
        self.assertIn('examples', studio.SOURCE_ITEMS)
        self.assertIn('tests', studio.SOURCE_ITEMS)
        self.assertNotIn('app-settings', studio.SOURCE_ITEMS)
        self.assertTrue((HERE.parent/'devcel-studio/app-settings/studio.devcelproj.toml').is_file())
        self.assertNotIn('bindings', studio.SOURCE_ITEMS)

    def test_studio_source_copy_retains_runtime_without_authoring_sdk(self):
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)/'source'
            stage.mkdir()
            studio.copy_source(HERE.parent, stage)
            self.assertFalse((stage/'bindings').exists())
            self.assertFalse((stage/'third-party/generated').exists())
            self.assertFalse((stage/'importers/unity/Editor/NativeRequirements.json').exists())
            self.assertFalse((stage/'importers/unity/Documentation~').exists())
            self.assertTrue((stage/'importers/unity-template/Documentation~').is_dir())
            self.assertFalse((stage/'devcel-studio/public/legal/THIRD-PARTY-NOTICES.txt').exists())
            self.assertTrue((stage/'third-party/preferred-sources.json').is_file())
            for name in ('devcel-core/src/lib.rs', 'devcel-runtime/src/lib.rs',
                         'importers/unity/Runtime/Devcel.Unity.Runtime.asmdef',
                         'importers/unity/Editor/DevcelDistributionValidation.cs'):
                self.assertEqual((stage/name).read_bytes(), (HERE.parent/name).read_bytes())

    def test_mastermemory_local_builds_are_not_in_source_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); repo = root/'repo'; stage = root/'stage'; stage.mkdir()
            for item in studio.SOURCE_ITEMS:
                source = repo/item
                if Path(item).suffix or item in ('LICENSE-NOTICE', 'README.md', 'CONTRIBUTING.md'):
                    write(source, 'fixture')
                else:
                    source.mkdir(parents=True, exist_ok=True)
            write(repo/'importers/unity-mastermemory/bin/a.dll', 'not source')
            write(repo/'importers/unity-mastermemory/Tests/obj/cache.json', 'not source')
            write(repo/'importers/unity-mastermemory/support.cs.txt', 'source')
            studio.copy_source(repo, stage)
            self.assertFalse((stage/'importers/unity-mastermemory/bin/a.dll').exists())
            self.assertFalse((stage/'importers/unity-mastermemory/Tests/obj/cache.json').exists())
            self.assertTrue((stage/'importers/unity-mastermemory/support.cs.txt').is_file())

    def test_bundled_npm_requires_verified_parent_and_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); cache = root/'cache'; cache.mkdir(); repo = root/'repo'; stage = root/'stage'; stage.mkdir()
            archive = root/'parent.tgz'
            with tarfile.open(archive, 'w:gz') as tar:
                for member, value in [('package/package.json', {'name':'parent','version':'1.0.0'}), ('package/node_modules/child/package.json', {'name':'child','version':'2.0.0'})]:
                    body = json.dumps(value).encode(); info = tarfile.TarInfo(member); info.size = len(body); tar.addfile(info, io.BytesIO(body))
            integrity = 'sha512-'+base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
            url = 'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz'
            key = hashlib.sha256((url+'\n'+integrity).encode()).hexdigest()
            (cache/(key+'.tgz')).write_bytes(archive.read_bytes())
            packages = {'':{}, 'node_modules/parent':{'name':'parent','version':'1.0.0','resolved':url,'integrity':integrity}, 'node_modules/parent/node_modules/child':{'version':'2.0.0','inBundle':True}}
            for lockfile in ('package-lock.json','devcel-studio/package-lock.json'): write(repo/lockfile,json.dumps({'packages':packages}))
            sources = studio.collect_npm_sources(repo)
            self.assertEqual(len(sources), 1)
            item = next(iter(sources.items())); self.assertEqual(len(item[1]), 2)
            record = studio.archive_npm_source(item, stage, cache)
            self.assertTrue((stage/record['file']).is_file())
            item[1][0]['expected_packages']['node_modules/child'] = ('child', 'wrong')
            with self.assertRaises(ValueError): studio.archive_npm_source(item, stage, cache)
            del packages['node_modules/parent']['integrity']
            write(repo/'package-lock.json', json.dumps({'packages':packages}))
            with self.assertRaises(RuntimeError): studio.collect_npm_sources(repo)


if __name__ == '__main__': unittest.main()
