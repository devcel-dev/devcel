"""Local assembly/Git round-trips; no remote refs or native execution."""
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch

import unity_git_package as package
from test_unity_upm import fixture_entries, write_zip
from test_unity_mobile import fixture as mobile_fixture


def fixture(root, commit="a"*40):
    desktop = {}
    for rid in package.RIDS:
        desktop[rid] = root/(rid+'.zip')
        values = fixture_entries(rid)
        values["devcel-unity/Tools~/manifest.json"] = values["devcel-unity/Tools~/manifest.json"].replace(("a"*40).encode(), commit.encode())
        write_zip(desktop[rid], values)
    mobile = {system: root/(system+'.zip') for system in ('android', 'ios')}
    for system, path in mobile.items():
        values = mobile_fixture(path, system)
        name = f"Tools~/Mobile/{system}.json"
        values[name] = values[name].replace(("a"*40).encode(), commit.encode())
        write_zip(path, values)
    return desktop, mobile


class GitPackageTests(unittest.TestCase):
    def test_real_documentation_graph_and_windows_crlf_inputs(self):
        repo = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('packaging_fixture', repo/'scripts/package-importers.py')
        packaging = importlib.util.module_from_spec(spec); spec.loader.exec_module(packaging)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            desktop, mobile = fixture(root)
            for rid in package.RIDS:
                stage = root/('stage-'+rid); dest = stage/'devcel-unity'
                shutil.copytree(repo/'importers/unity-template', dest, ignore=shutil.ignore_patterns('__pycache__'))
                for name, raw in fixture_entries(rid).items():
                    path = stage/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
                packaging.bundle_documentation(repo, stage, dest, 'unity', dest/'Tools~', 'a'*40, 'owner/repo')
                values = {p.relative_to(stage).as_posix(): p.read_bytes() for p in dest.rglob('*') if p.is_file()}
                self.assertTrue(all(b'\r\n' not in raw for name, raw in values.items() if name.endswith('.md')))
                if rid == 'win-x64':
                    values = {name: raw.replace(b'\n',b'\r\n') if name.endswith('.md') or name.endswith('/NativeRequirements.json') else raw
                              for name,raw in values.items()}
                write_zip(desktop[rid], values)
            package.assemble(desktop, mobile, root/'package', '0.1.0', 'a'*40, 'owner/repo')
            files = {p.relative_to(root/'package').as_posix():p.read_bytes() for p in (root/'package').rglob('*') if p.is_file()}
            self.assertIn('Tools~/README.md', files)
            self.assertIn('Tools~/LICENSE-CLI-MIT.txt', files)
            self.assertNotIn('Tools~/Sources/win-x64/README.md', files)
            self.assertNotIn(b'\r\n', files['Editor/NativeRequirements.json'])
            package.validate_documentation(files)
            files.pop('Tools~/README.md')
            with self.assertRaisesRegex(ValueError, 'documentation link'):
                package.validate_documentation(files)

    def test_one_tag_has_all_platforms_sources_and_notices_and_clones_locally(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root/'source'; repo.mkdir()
            def git(*args):
                return subprocess.run(['git', *args], cwd=repo, check=True, text=True, capture_output=True).stdout.strip()
            git('init', '--quiet')
            (repo/'source.txt').write_text('unchanged source')
            old_package = repo/'importers/unity'; old_package.mkdir(parents=True)
            (old_package/'package.json').write_text('{\"name\":\"template\"}')
            (old_package/'obsolete.txt').write_text('old source-only file')
            git('add', '.')
            git('-c', 'user.name=eight-ways', '-c', 'user.email=145819685+eight-ways@users.noreply.github.com', 'commit', '-qm', 'Source')
            source = git('rev-parse', 'HEAD')
            desktop, mobile = fixture(root, source)
            outputs = package.create(desktop, mobile, root/'out', '0.1.0', source, 'owner/repo')
            repeated = package.create(desktop, mobile, root/'out-repeat', '0.1.0', source, 'owner/repo')
            self.assertEqual(outputs[0].read_bytes(), repeated[0].read_bytes())
            self.assertEqual(outputs[1].read_bytes(), repeated[1].read_bytes())
            report = json.loads(outputs[1].read_text())
            self.assertFalse(report['git_lfs'])
            self.assertLess(report['largest_file_bytes'], package.MAX_BLOB)
            release = package.stage_release(*outputs, repo, 'eight-ways', '145819685+eight-ways@users.noreply.github.com')
            self.assertEqual(package.stage_release(*outputs, repo, 'eight-ways', '145819685+eight-ways@users.noreply.github.com'), release)
            self.assertEqual(package.source_identity(repo, release), source)
            package.verify_release_tree(repo, release, release)
            self.assertEqual(git('rev-parse', 'HEAD'), source)
            self.assertEqual(git('status', '--porcelain'), '')
            git('tag', 'v0.1.0', release)
            remote = root/'remote.git'
            subprocess.run(['git', 'init', '--bare', '--quiet', str(remote)], check=True)
            git('push', str(remote), source+':refs/heads/main')
            git('push', '--atomic', str(remote), release+':refs/heads/main', release+':refs/tags/v0.1.0')
            refs = subprocess.run(['git', '--git-dir', str(remote), 'show-ref'], check=True, text=True, capture_output=True).stdout
            self.assertIn(release+' refs/heads/main', refs)
            self.assertIn(release+' refs/tags/v0.1.0', refs)
            clone = root/'clone'
            subprocess.run(['git', 'clone', '--quiet', '--branch', 'v0.1.0', 'file:///' + repo.as_posix() if os.name == 'nt' else repo.as_uri(), str(clone)], check=True)
            self.assertEqual((clone/'source.txt').read_text(), 'unchanged source')
            clone = clone/'importers'/'unity'
            self.assertFalse((clone/'obsolete.txt').exists())
            manifest = json.loads((clone/'Tools~/manifest.json').read_text())
            self.assertEqual(set(manifest['supportedPlatforms']), set(package.RIDS))
            self.assertEqual(len(manifest['native_runtimes']), 3)
            self.assertEqual(len(manifest['player_runtimes']), 5)
            self.assertNotIn('native_runtime', manifest)
            self.assertIn('folderAsset: yes', (clone/'Plugins.meta').read_text())
            self.assertTrue((clone/'Plugins/Android/arm64-v8a.meta').is_file())
            self.assertFalse((clone/'Tools~.meta').exists())
            for rid in package.RIDS:
                self.assertFalse((clone/'Tools~/Sources'/rid/'cli-source.tar.gz').exists())
                entry = next(x for x in manifest['source_archives'] if x['platform'] == rid)
                self.assertEqual(entry['url'], f'https://github.com/owner/repo/releases/download/v0.1.0/devcel-unity-0.1.0-{rid}.zip')
                self.assertEqual(entry['archive_entry'], 'devcel-unity/Tools~/cli-source.tar.gz')
                self.assertEqual(entry['sha256'], __import__('hashlib').sha256(b'source').hexdigest())
                self.assertTrue((clone/'ThirdPartyNotices'/rid/'THIRD-PARTY-NOTICES.txt').is_file())
            self.assertEqual(json.loads((clone/'package.json').read_text())['version'], '0.1.0')
            (clone/'extra.txt').write_text('rebuild payload drift')
            changed = package.release_commit(clone, repo, source, '0.1.0', author_name='eight-ways',
                                             author_email='145819685+eight-ways@users.noreply.github.com')
            with self.assertRaisesRegex(ValueError, 'immutable release tag'):
                package.verify_release_tree(repo, release, changed)
            # A change outside the generated subtree is not a valid envelope.
            git('checkout', '--detach', release)
            (repo/'source.txt').write_text('modified')
            git('add', '.')
            git('-c', 'user.name=eight-ways', '-c', 'user.email=145819685+eight-ways@users.noreply.github.com', 'commit', '-qm', 'Invalid')
            with self.assertRaises(ValueError): package.source_identity(repo, git('rev-parse', 'HEAD'))

    def test_identity_sdk_collision_and_size_budget_fail_closed(self):
        for case in ('commit', 'sdk', 'size', 'missing'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                desktop, mobile = fixture(root)
                if case == 'missing': desktop.pop('osx-x64')
                if case == 'sdk':
                    values = fixture_entries('linux-x64'); values['devcel-unity/Runtime/extra.cs'] = b'drift'
                    write_zip(desktop['linux-x64'], values)
                with patch.object(package, 'MAX_PACKAGE', 1 if case == 'size' else package.MAX_PACKAGE):
                    with self.assertRaises(ValueError):
                        package.assemble(desktop, mobile, root/'package', '0.1.0',
                                         'c'*40 if case == 'commit' else 'a'*40, 'owner/repo')
                self.assertFalse((root/'package').exists())


if __name__ == '__main__':
    unittest.main()
