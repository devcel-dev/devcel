"""Local assembly/Git round-trips; no remote refs or native execution."""
import json
import os
from pathlib import Path
import subprocess
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
    def test_one_tag_has_all_platforms_sources_and_notices_and_clones_locally(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root/'source'; repo.mkdir()
            def git(*args):
                return subprocess.run(['git', *args], cwd=repo, check=True, text=True, capture_output=True).stdout.strip()
            git('init', '--quiet')
            (repo/'source.txt').write_text('unchanged source')
            git('add', '.')
            git('-c', 'user.name=eight-ways', '-c', 'user.email=145819685+eight-ways@users.noreply.github.com', 'commit', '-qm', 'Source')
            source = git('rev-parse', 'HEAD')
            desktop, mobile = fixture(root, source)
            outputs = package.create(desktop, mobile, root/'out', '0.1.0', source, 'owner/repo')
            report = json.loads(outputs[1].read_text())
            self.assertFalse(report['git_lfs'])
            self.assertLess(report['largest_file_bytes'], package.MAX_BLOB)
            release = package.stage_release(*outputs, repo, 'eight-ways', '145819685+eight-ways@users.noreply.github.com')
            self.assertEqual(package.stage_release(*outputs, repo, 'eight-ways', '145819685+eight-ways@users.noreply.github.com'), release)
            self.assertEqual(package.source_identity(repo, release), source)
            self.assertEqual(git('rev-parse', 'HEAD'), source)
            self.assertEqual(git('status', '--porcelain'), '')
            git('tag', 'v0.1.0', release)
            clone = root/'clone'
            subprocess.run(['git', 'clone', '--quiet', '--branch', 'v0.1.0', 'file:///' + repo.as_posix() if os.name == 'nt' else repo.as_uri(), str(clone)], check=True)
            self.assertEqual((clone/'source.txt').read_text(), 'unchanged source')
            clone = clone/'upm'
            manifest = json.loads((clone/'Tools~/manifest.json').read_text())
            self.assertEqual(set(manifest['supportedPlatforms']), set(package.RIDS))
            self.assertEqual(len(manifest['native_runtimes']), 3)
            self.assertEqual(len(manifest['player_runtimes']), 2)
            self.assertNotIn('native_runtime', manifest)
            self.assertIn('folderAsset: yes', (clone/'Plugins.meta').read_text())
            self.assertTrue((clone/'Plugins/Android/arm64-v8a.meta').is_file())
            self.assertFalse((clone/'Tools~.meta').exists())
            for rid in package.RIDS:
                self.assertEqual((clone/'Tools~/Sources'/rid/'cli-source.tar.gz').read_bytes(), b'source')
                self.assertTrue((clone/'ThirdPartyNotices'/rid/'THIRD-PARTY-NOTICES.txt').is_file())
            self.assertEqual(json.loads((clone/'package.json').read_text())['version'], '0.1.0')
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
