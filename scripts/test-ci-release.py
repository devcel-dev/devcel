#!/usr/bin/env python3
"""Offline CI regressions; real warning fixtures require pinned Rust and Clippy."""
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from test_unity_upm import fixture_entries
from test_unity_mobile import fixture as mobile_fixture
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ci_release', ROOT/'scripts/ci-release.py')
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def rust_output(names, harnesses=1):
    """Stable libtest pretty output, including one nonempty result per harness."""
    names = list(names)
    groups = [names[index::harnesses] for index in range(harnesses)]
    return ''.join(
        f'\nrunning {len(group)} tests\n'
        + ''.join(f'test {name} ... ok\n' for name in group)
        + f'\ntest result: ok. {len(group)} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n'
        for group in groups)


def rust_required_names(required):
    return {name + f'fixture_{index}' if name.endswith('::') else name
            for name, minimum in required.items() for index in range(minimum)}


def rust_gate_outputs():
    return [rust_output(sorted(rust_required_names(required)), harnesses)
            for _, required, harnesses in ci.rust_regression_gates()]


class ReleaseTests(unittest.TestCase):
    def test_node_pin_checks_are_manual_only(self):
        for command in (ci.toolchains, ci.frontend_release):
            with patch.object(ci, 'run') as run:
                command()
            calls = [call.args for call in run.call_args_list]
            self.assertFalse(any('scripts/check-node-pins.py' in call or 'scripts/test-node-pins.py' in call for call in calls))
        with patch.object(ci, 'run') as run:
            ci.check()
        self.assertEqual(run.call_args_list[0].args, (ci.sys.executable, 'scripts/generate-third-party-notices.py', '--ensure'))
        self.assertEqual(run.call_args_list[1].args, (ci.sys.executable, 'scripts/check-node-pins.py'))

    def test_pr_ci_keeps_the_standard_build_matrix_without_gui_investigations(self):
        text = (ROOT/'.github/workflows/ci.yml').read_text()
        jobs = text.split('jobs:\n', 1)[1]
        self.assertEqual(re.findall(r'^  ([a-z_]+):$', jobs, re.MULTILINE), ['check'])
        self.assertIn('os: [ubuntu-24.04, windows-2022, macos-15-intel, macos-15]', jobs)
        prefix = jobs.split('    strategy:', 1)[0]
        self.assertNotIn('needs:', prefix)
        self.assertNotIn('if:', prefix)
        for unwanted in ('review_input', 'debian_native', 'prepare-debian-review.py',
                         'test-debian-', 'build-native-ui-review.py', 'native-dev-shell',
                         'github.event.pull_request.number == 3', 'artifact-ids:'):
            self.assertNotIn(unwanted, text)
        for required in ('Build native distribution', 'Save Rust release cache'):
            self.assertIn(required, text)

    def test_compact_regressions_use_one_checked_entrypoint(self):
        for name in ('ci.yml', 'release.yml'):
            with self.subTest(workflow=name):
                text = (ROOT/'.github/workflows'/name).read_text()
                self.assertNotIn('ci-release.py compact_checks', text)
        with patch.object(ci.sys, 'argv', ['ci-release.py', 'compact_checks']), \
                patch.object(ci, 'run') as run:
            ci.main()
            self.assertEqual([call.args for call in run.call_args_list], [
                (ci.sys.executable, 'scripts/unity_toolchain.py'),
                (ci.sys.executable, 'scripts/test-unity-toolchain.py'),
                (ci.sys.executable, 'scripts/test-release-source.py'),
                (ci.sys.executable, 'scripts/test-ci-release.py'),
                (ci.sys.executable, 'scripts/test-release-recovery.py'),
                (ci.sys.executable, 'scripts/test-release-rebuild.py'),
                (ci.sys.executable, 'scripts/release_source.py', '--check'),
                (ci.sys.executable, 'scripts/test-release-version.py'),
                (ci.sys.executable, 'scripts/bundled_plugin_versions.py', '--check-registration'),
                (ci.sys.executable, 'scripts/test-importer-versions.py'),
                (ci.sys.executable, 'scripts/test-debian-version.py'),
                (ci.sys.executable, 'scripts/test-release-privacy.py'),
                (ci.sys.executable, 'scripts/test-importer-output.py'),
                (ci.sys.executable, 'scripts/test-native-review-evidence.py'),
            ])

    def test_real_compact_failure_stops_before_later_success(self):
        # Real child processes prove that a later success cannot mask any failure.
        for failing in range(14):
            with self.subTest(failing=failing), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                scripts = root/'scripts'
                scripts.mkdir()
                names = ('unity_toolchain.py', 'test-unity-toolchain.py', 'test-release-source.py', 'test-ci-release.py', 'test-release-recovery.py', 'test-release-rebuild.py', 'release_source.py', 'test-release-version.py', 'bundled_plugin_versions.py', 'test-importer-versions.py', 'test-debian-version.py', 'test-release-privacy.py', 'test-importer-output.py', 'test-native-review-evidence.py')
                for index, name in enumerate(names):
                    (scripts/name).write_text(
                        'from pathlib import Path\n'
                        f'Path("ran-{index}").touch()\n'
                        f'raise SystemExit({7 if index == failing else 0})\n')
                checked_run = ci.run
                with patch.object(ci, 'run', side_effect=lambda *args: checked_run(*args, cwd=root)):
                    with self.assertRaises(subprocess.CalledProcessError) as error:
                        ci.compact_checks()
                self.assertEqual(error.exception.returncode, 7)
                self.assertEqual([index for index in range(len(names)) if (root/f'ran-{index}').exists()],
                                 list(range(failing+1)))

    def test_native_reports_are_manual_only(self):
        for name in ('ci.yml', 'release.yml'):
            text = (ROOT/'.github/workflows'/name).read_text()
            self.assertNotIn('release-reports/', text)
        text = (ROOT/'.github/workflows/manual-checks.yml').read_text()
        self.assertIn('if: always()', text)
        self.assertIn('path: release-reports/*.json', text)

    def test_release_cache_survives_notice_failure_and_excludes_installers(self):
        for name in ('ci.yml', 'release.yml'):
            text = (ROOT/'.github/workflows'/name).read_text()
            self.assertIn('uses: actions/cache/restore@v5', text)
            self.assertIn('uses: actions/cache/save@v5', text)
            self.assertIn("!cancelled() && steps.rust-cache.outputs.cache-primary-key != ''", text)
            self.assertIn("steps.rust-cache.outputs.cache-hit != 'true'", text)
            self.assertIn('key: ${{ steps.rust-cache.outputs.cache-primary-key }}', text)
            self.assertIn('CARGO_TARGET_DIR: ${{ github.workspace }}/target', text)
            self.assertEqual(text.count('            target/*/release\n'), 2)
            self.assertEqual(text.count('!target/*/release/bundle'), 2)
            self.assertEqual(text.count('!target/release/bundle'), 2)
            self.assertEqual(text.count('!target/release/incremental'), 2)
            self.assertIn("hashFiles('rust-toolchain.toml', '**/Cargo.lock', '**/Cargo.toml', '.cargo/config*')", text)
            self.assertIn('${{ matrix.os }}-${{ runner.arch }}', text)
            self.assertIn('${{ env.RUSTFLAGS }}', text)

    def test_semver(self):
        for tag in ('v0.1.0', 'v12.30.40', 'v1.2.3-rc.1', 'v1.2.3-beta'):
            self.assertIsNotNone(ci.SEMVER.fullmatch(tag), tag)
        for tag in ('1.2.3', 'v1', 'v1.2', 'v01.2.3', 'v1.2.3-01',
                    'v1.2.3+build', 'v1.2.3/evil', 'v1.2.3\n', 'v1.2.3;echo x'):
            self.assertIsNone(ci.SEMVER.fullmatch(tag), tag)

    def test_committed_version(self):
        version = json.loads((ROOT/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
        self.assertEqual(ci.validate('v'+version), version)
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            ci.validate('v999.999.999')

    def test_version_validation_does_not_require_main_ancestry(self):
        version = json.loads((ROOT/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
        with patch.object(ci, 'run') as run:
            ci.validate('v'+version)
            run.assert_not_called()

    def test_triggers_and_permissions(self):
        directory = ROOT/'.github/workflows'
        self.assertEqual({p.name for p in directory.iterdir()}, {'ci.yml', 'release.yml', 'manual-checks.yml', 'unity-mobile.yml'})
        ci_text = (directory/'ci.yml').read_text()
        release = (directory/'release.yml').read_text()
        self.assertIn('on:\n  pull_request:\n    branches: [main]\n', ci_text)
        self.assertNotIn('contents: write', ci_text)
        self.assertNotIn('workflow_dispatch:', ci_text)
        self.assertIn("on:\n  push:\n    tags: ['v[0-9]*.[0-9]*.[0-9]*']\n", release)
        self.assertIn('  workflow_dispatch:\n    inputs:\n      version:', release)
        self.assertIn('        required: true\n        type: string', release)
        self.assertIn('needs: [validate, build, mobile]', release)
        self.assertEqual(release.count('contents: write'), 4)
        for job in ('validate', 'build'):
            block = re.search(r'(?ms)^  '+job+r':\n(.*?)(?=^  [a-z_]+:|\Z)', release).group(1)
            self.assertNotIn('contents: write', block)
        for text in (ci_text, release):
            for forbidden in ('schedule:', 'pull_request_target:', 'branches: ["*"]'):
                self.assertNotIn(forbidden, text)
            self.assertIn('os: [ubuntu-24.04, windows-2022, macos-15-intel, macos-15]', text)
            self.assertIn('persist-credentials: false', text)
            self.assertIn("env:\n  PYTHONUTF8: '1'\n", text)

    def test_manual_and_tag_release_share_pinned_jobs(self):
        release = (ROOT/'.github/workflows/release.yml').read_text()
        self.assertIn('group: release-main', release)
        self.assertIn('cancel-in-progress: false', release)
        self.assertIn('ref: ${{ github.sha }}', release)
        self.assertEqual(release.count('ref: ${{ needs.validate.outputs.commit }}'), 4)
        self.assertEqual(release.count('SOURCE_COMMIT: ${{ needs.validate.outputs.commit }}'), 3)
        self.assertEqual(release.count('RELEASE_TAG: ${{ needs.validate.outputs.tag }}'), 3)
        self.assertEqual(release.count('persist-credentials: false'), 9)
        self.assertEqual(release.count('run: python scripts/ci-release.py package'), 1)
        self.assertEqual(release.count('run: python scripts/ci-release.py publish'), 1)
        self.assertEqual(release.count('GH_TOKEN: ${{ github.token }}'), 5)
        self.assertIn("if: github.event_name == 'workflow_dispatch'", release)
        self.assertIn('needs: [validate, create_tag]', release)
        self.assertIn("!cancelled() && needs.validate.result == 'success' && (needs.create_tag.result == 'success' || needs.create_tag.result == 'skipped')", release)
        self.assertIn("!cancelled() && needs.validate.result == 'success' && needs.build.result == 'success'", release)
        for line in release.splitlines():
            if 'run:' in line:
                self.assertNotIn('${{', line, 'Untrusted expressions must not enter shell code')
        self.assertNotIn('secrets.', release)
        self.assertNotIn('actions: write', release)

    def test_manual_request_pins_validated_main_commit(self):
        version = json.loads((ROOT/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
        with patch.object(ci, 'run', return_value='a'*40+'\n') as run:
            self.assertEqual(ci.release_request('workflow_dispatch', 'refs/heads/main', version, 'a'*40),
                             ('v'+version, 'a'*40))
        self.assertEqual(run.call_args_list[0].args,
                         ('git', 'rev-parse', '--verify', 'a'*40+'^{commit}'))

    def test_manual_invalid_input_never_reaches_git_or_api(self):
        for version in ('', 'v0.0.1', '01.0.1', '0.0.1+build', '0.0.1-01', '0.0.1;echo bad',
                        '0.0.1\ncommit=bad', '$(touch bad)', '0.0.1/other', ' 0.0.1', '0.0.1 ', '999.999.999'):
            with self.subTest(version=version), patch.object(ci, 'run') as run:
                with self.assertRaises(ValueError):
                    ci.release_request('workflow_dispatch', 'refs/heads/main', version, 'a'*40)
                run.assert_not_called()

    def test_manual_non_main_rejected_before_validation(self):
        for ref in ('refs/heads/feature', 'refs/tags/v0.0.1', 'main', 'refs/heads/main-other'):
            with self.subTest(ref=ref), patch.object(ci, 'validate') as validate, patch.object(ci, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'main branch'):
                    ci.release_request('workflow_dispatch', ref, '0.0.1', 'a'*40)
                validate.assert_not_called()
                run.assert_not_called()

    def test_unsupported_events_rejected(self):
        for event, ref in [('push', 'refs/heads/main'), ('pull_request', 'refs/pull/1/merge'),
                           ('workflow_call', 'refs/heads/main')]:
            with self.subTest(event=event), patch.object(ci, 'run') as run:
                with self.assertRaises(ValueError): ci.release_request(event, ref, '', 'a'*40)
                run.assert_not_called()

    def test_tag_push_uses_exact_tag_and_commit(self):
        with patch.object(ci, 'validate') as validate, patch.object(ci, 'run', return_value='a'*40+'\n'):
            self.assertEqual(ci.release_request('push', 'refs/tags/v1.2.3-rc.1', '', 'b'*40),
                             ('v1.2.3-rc.1', 'a'*40))
            validate.assert_called_once_with('v1.2.3-rc.1', root=ROOT)
        with patch.object(ci, 'validate'), patch.object(ci, 'run', side_effect=['a'*40, 'a'*40, 'b'*40]):
            with self.assertRaisesRegex(ValueError, 'no longer points'):
                ci.release_request('push', 'refs/tags/v1.2.3', '', 'a'*40)

    def test_bad_or_wrong_commit_rejected(self):
        for sha in ('main', '--all', 'a'*39, 'a'*40+'\n', 'a'*40+';echo bad'):
            with self.subTest(sha=sha), patch.object(ci, 'run') as run:
                with self.assertRaises(ValueError): ci.checked_commit(sha)
                run.assert_not_called()
        for outputs in [('b'*40, 'a'*40), ('bad', 'bad')]:
            with patch.object(ci, 'run', side_effect=outputs):
                with self.assertRaisesRegex(ValueError, 'Checkout'):
                    ci.checked_commit('a'*40)

    def test_git_commit_and_annotated_tag_resolution(self):
        # Real local Git proves peeling, ancestry, and stale checkout rejection.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def git(*args):
                return ci.run('git', *args, cwd=root, capture=True).strip()
            git('init', '--initial-branch=main')
            git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid',
                'commit', '--allow-empty', '-m', 'Fixture')
            commit = git('rev-parse', 'HEAD')
            git('update-ref', 'refs/remotes/origin/main', commit)
            git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid',
                'tag', '-a', 'v1.2.3', '-m', 'Annotated fixture')
            annotated = git('rev-parse', 'v1.2.3')
            self.assertNotEqual(annotated, commit)
            self.assertEqual(ci.checked_commit(annotated, root=root), commit)
            git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid',
                'commit', '--allow-empty', '-m', 'Unintegrated fixture')
            with self.assertRaises(ValueError): ci.checked_commit(commit, root=root)
            with self.assertRaises(subprocess.CalledProcessError):
                git('merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main')
            # A new release tag on this non-main commit is valid. Still resolve
            # the annotated object and verify that the checkout matches exactly.
            git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid',
                'tag', '-a', 'v1.2.4', '-m', 'Release branch fixture')
            release_commit = git('rev-parse', 'HEAD')
            with patch.object(ci, 'validate') as validate:
                self.assertEqual(ci.release_request('push', 'refs/tags/v1.2.4', '',
                                                    git('rev-parse', 'v1.2.4'), root=root),
                                 ('v1.2.4', release_commit))
                validate.assert_called_once_with('v1.2.4', root=root)

    def test_prepare_outputs_are_written_only_after_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)/'output'
            env = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
                   'GITHUB_SHA': 'a'*40, 'RELEASE_VERSION': '1.2.3-rc.1', 'GITHUB_OUTPUT': str(output)}
            with patch.dict(ci.os.environ, env), patch.object(ci, 'release_request', return_value=('v1.2.3-rc.1', 'a'*40)):
                ci.prepare_release()
            self.assertEqual(output.read_text(), 'tag=v1.2.3-rc.1\ncommit='+'a'*40+'\n')
            before = output.read_bytes()
            with patch.dict(ci.os.environ, env), patch.object(ci, 'release_request', side_effect=ValueError('invalid')):
                with self.assertRaises(ValueError): ci.prepare_release()
            self.assertEqual(output.read_bytes(), before)

    def test_tag_preflight_is_read_only(self):
        tag, commit = 'v1.2.3-rc.1', 'a'*40
        env = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
               'RELEASE_TAG': tag, 'SOURCE_COMMIT': commit, 'GH_REPO': 'owner/repo'}
        response = ''
        with patch.dict(ci.os.environ, env), patch.object(ci, 'validate') as validate, \
                patch.object(ci, 'checked_commit', return_value=commit), patch.object(ci, 'run', return_value=response) as run:
            ci.create_tag()
        validate.assert_called_once_with(tag)
        run.assert_called_once_with('git', 'ls-remote', '--refs', 'https://github.com/owner/repo.git', 'refs/tags/'+tag, capture=True)

    def test_existing_tag_or_api_failure_never_retries_or_overwrites(self):
        env = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
               'RELEASE_TAG': 'v1.2.3', 'SOURCE_COMMIT': 'a'*40, 'GH_REPO': 'owner/repo'}
        for status in (409, 422):
            with patch.dict(ci.os.environ, env), patch.object(ci, 'validate'), \
                    patch.object(ci, 'checked_commit', return_value='a'*40), \
                    patch.object(ci, 'run', side_effect=subprocess.CalledProcessError(status, 'gh')) as run:
                with self.assertRaises(subprocess.CalledProcessError): ci.create_tag()
                self.assertEqual(run.call_count, 1)

    def test_create_tag_rechecks_branch_version_and_commit(self):
        for event, ref in [('push', 'refs/tags/v1.2.3'), ('workflow_dispatch', 'refs/heads/feature')]:
            with patch.dict(ci.os.environ, {'GITHUB_EVENT_NAME': event, 'GITHUB_REF': ref}), patch.object(ci, 'run') as run:
                with self.assertRaises(ValueError): ci.create_tag()
                run.assert_not_called()
        env = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
               'RELEASE_TAG': 'v999.999.999', 'SOURCE_COMMIT': 'a'*40}
        with patch.dict(ci.os.environ, env), patch.object(ci, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'mismatch'): ci.create_tag()
            run.assert_not_called()
        with patch.dict(ci.os.environ, env), patch.object(ci, 'validate'), \
                patch.object(ci, 'checked_commit', side_effect=ValueError('wrong commit')), patch.object(ci, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'wrong commit'): ci.create_tag()
            run.assert_not_called()

    def test_create_tag_checks_api_response(self):
        env = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
               'RELEASE_TAG': 'v1.2.3', 'SOURCE_COMMIT': 'a'*40, 'GH_REPO': 'owner/repo'}
        for response in ({}, {'ref': 'refs/tags/v1.2.3', 'object': {'sha': 'b'*40}},
                         {'ref': 'refs/tags/v1.2.4', 'object': {'sha': 'a'*40}}):
            with patch.dict(ci.os.environ, env), patch.object(ci, 'validate'), \
                    patch.object(ci, 'checked_commit', return_value='a'*40), \
                    patch.object(ci, 'run', return_value=json.dumps(response)):
                with self.assertRaisesRegex(ValueError, 'already exists'): ci.create_tag()

    def test_runners_avoid_full_local_suite_and_preserve_local_checks(self):
        for name in ('ci.yml', 'release.yml'):
            text = (ROOT/'.github/workflows'/name).read_text()
            for setting in ("CARGO_INCREMENTAL: '0'",):
                self.assertEqual(text.count(setting), 1)
            self.assertNotIn('CARGO_PROFILE_', text)
            self.assertNotIn('ci-release.py check', text)
            self.assertNotIn('cargo test', text)
            self.assertNotIn('cargo clippy', text)
        with patch.object(ci, 'run') as run:
            ci.check()
        calls = [call.args for call in run.call_args_list]
        self.assertIn(('cargo', 'test', '--locked', '--workspace'), calls)
        self.assertIn(('cargo', 'clippy', '--locked', '--workspace', '--all-targets',
                       '--all-features', '--', '-D', 'warnings'), calls)
        self.assertIn(('npm', 'run', 'check:lint'), calls)
        self.assertIn(('npm', 'run', 'lint'), calls)
        self.assertIn(('npm', 'run', 'build'), calls)

    def test_local_release_plugin_regressions_are_ordered_and_fail_closed(self):
        expected = [
            (ci.sys.executable, 'scripts/generate-third-party-notices.py', '--ensure'),
            (ci.sys.executable, 'scripts/check-node-pins.py'),
            (ci.sys.executable, 'scripts/test-node-pins.py'),
            (ci.sys.executable, 'scripts/test-ci-release.py'),
            (ci.sys.executable, 'scripts/test-release-recovery.py'),
            (ci.sys.executable, 'scripts/test-release-rebuild.py'),
            (ci.sys.executable, 'scripts/unity_toolchain.py'),
            (ci.sys.executable, 'scripts/test-unity-toolchain.py'),
            (ci.sys.executable, 'scripts/test-release-source.py'),
            (ci.sys.executable, 'scripts/release_source.py', '--check'),
            (ci.sys.executable, 'scripts/test-release-version.py'),
            (ci.sys.executable, 'scripts/bundled_plugin_versions.py', '--check-registration'),
            (ci.sys.executable, 'scripts/test-importer-versions.py'),
            (ci.sys.executable, 'scripts/test-debian-version.py'),
        ]
        with patch.object(ci, 'run') as run:
            ci.check()
        calls = [call.args for call in run.call_args_list]
        self.assertEqual(calls[:len(expected)], expected)
        self.assertEqual(calls.count(expected[-1]), 1)
        self.assertEqual(calls[len(expected)],
                         (ci.sys.executable, 'scripts/test-checkout-line-endings.py'))
        for failing in (len(expected)-2, len(expected)-1):
            with self.subTest(failing=failing), patch.object(ci, 'run') as run:
                run.side_effect = [None]*failing + [subprocess.CalledProcessError(7, expected[failing])]
                with self.assertRaises(subprocess.CalledProcessError):
                    ci.check()
                self.assertEqual([call.args for call in run.call_args_list], expected[:failing+1])
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root/'scripts').mkdir()
                commands = expected + [(ci.sys.executable, 'scripts/test-checkout-line-endings.py')]
                for index, command in enumerate(commands):
                    (root/command[1]).write_text(
                        'from pathlib import Path\n'
                        f'Path("ran-{index}").touch()\n'
                        f'raise SystemExit({7 if index == failing else 0})\n')
                checked_run = ci.run
                with patch.object(ci, 'run', side_effect=lambda *args: checked_run(*args, cwd=root)):
                    with self.assertRaises(subprocess.CalledProcessError) as error:
                        ci.check()
                self.assertEqual(error.exception.returncode, 7)
                self.assertEqual([index for index in range(len(commands)) if (root/f'ran-{index}').exists()],
                                 list(range(failing+1)))

    def test_strict_checks_run_frontend_clippy_then_bounded_rust_regressions(self):
        with patch.object(ci, 'run', side_effect=[None]*5+rust_gate_outputs()) as run, \
                patch('sys.stdout', new_callable=io.StringIO):
            ci.strict_checks()
        cargo = ('cargo', 'test', '--locked', '--release', '--all-features')
        harness = ('--format=pretty', '--color=never', '--test-threads=1')
        expected = [
            ('npm', 'run', 'check:lint'),
            ('npm', 'run', 'typecheck'),
            ('npm', 'run', 'lint'),
            ('npm', 'run', 'check:studio-batch'),
            ('cargo', 'clippy', '--locked', '--release', '--workspace', '--all-targets',
             '--all-features', '--', '-D', 'warnings'),
            cargo + ('-p', 'devcel-core', '--test', 'table_display_catalog', '--test', 'project_creation_diagnostics',
                     '--test', 'export_error_diagnostics', '--test', 'interface_storage_diagnostics',
                     '--test', 'interface_integration_test', '--test', 'current_contract_regression',
                     '--test', 'record_inheritance', '--test', 'typed_color_authoring',
                     '--test', 'color_swatch_authoring', '--test', 'memo_interface_regression',
                     '--test', 'column_conversion_diagnostics', '--test', 'formula_completion_catalog', '--test', 'table_edit_controls',
                     '--test', 'audit_data_integrity',
                     '--test', 'codegen_identifier_safety',
                     '--test', 'formula_collections_integration',
                     '--test', 'referenced_deletion_regression',
                     '--test', 'connected_client_count', '--test', 'current_wire_contract',
                     '--test', 'write_locks', '--') + harness,
            cargo + ('-p', 'devcel-core', '--lib', '--', 'plugin_resources::tests::',
                     'app_catalog::tests::', 'edit_controls::fixed_settings_tests::', 'theme_schema::tests::', 'localization::release_contract_tests::',
                     'table_catalog::display_metadata_stream_tests::', 'table_storage::tests::',
                     'replication::typed_storage_tests::', 'app_settings_migration::tests::',
                     'app_error::authoring_contract_tests::', 'p2p_errors::localization_tests::',
                     'msgpack_client::localization_tests::', 'msgpack_server::localization_tests::',
                     'p2p_auth::tests::', 'project_paths::tests::',
                     'msgpack_framing::resource_tests::', 'registry::private_discovery_tests::',
                     'p2p_diagnostics::tests::', 'conflict_resolution::tests::',
                     'write_locks::tests::', 'table_mutation::read_dependency_tests::', 'project_impl::history_file_tests::') + harness,
            cargo + ('-p', 'devcel-studio', '--lib', '--', 'formula_completion_tests::', 'settings_contract_tests::', 'settings_profile::tests::', 'plugin_packages::version_profile_tests::',
                     'plugin_catalog::diagnostic_tests::', 'command_dispatcher::tests::',
                     'color_preview::color_preview_diagnostic_tests::',
                     'p2p_event_listener::localization_tests::',
                     'rule_commands::native_snapshot_regression_tests::native_snapshot_weight_counts_nested_formula_diagnostics_without_flattening') + harness,
            cargo + ('-p', 'devcel-studio', '--test', 'user_color_swatches_store', '--') + harness,
            cargo + ('-p', 'devcel-cli', '--test', 'managed_server_lifecycle', '--') + harness,
            cargo + ('-p', 'devcel-runtime', '--test', 'regressions', '--') + harness,
            cargo + ('-p', 'devcel-cli', '--bin', 'devcel', '--',
                     'wolf_export::tests::minimal_blank_numeric_boolean_defaults_match_full_values') + harness,
        ]
        self.assertEqual([call.args for call in run.call_args_list], expected)
        for call in run.call_args_list[:4]:
            self.assertEqual(call.kwargs, {'cwd': ROOT/'devcel-studio'})
        self.assertEqual(run.call_args_list[4].kwargs, {})
        for call in run.call_args_list[5:]:
            self.assertEqual(call.kwargs, {'cwd': ROOT, 'capture': True})

    def test_strict_check_failure_stops_later_checks(self):
        outputs = [None]*5+rust_gate_outputs()
        for failing_index in range(len(outputs)):
            with self.subTest(failing_index=failing_index), \
                    patch.object(ci, 'run', side_effect=outputs[:failing_index]+[
                        subprocess.CalledProcessError(7, 'strict check')]) as run, \
                    patch('sys.stdout', new_callable=io.StringIO):
                with self.assertRaises(subprocess.CalledProcessError):
                    ci.strict_checks()
                self.assertEqual(run.call_count, failing_index+1)

    def test_missing_rust_coverage_stops_later_gates(self):
        outputs = [None]*5+rust_gate_outputs()
        for failing_index in range(5, len(outputs)):
            with self.subTest(failing_index=failing_index), \
                    patch.object(ci, 'run', side_effect=outputs[:failing_index]+[
                        rust_output([])]) as run, patch('sys.stdout', new_callable=io.StringIO):
                with self.assertRaisesRegex(ValueError, 'required test harness'):
                    ci.strict_checks()
                self.assertEqual(run.call_count, failing_index+1)

    def test_rust_gate_requires_every_group_even_when_other_tests_pass(self):
        for platform in ('linux', 'win32'):
            with patch.object(ci.sys, 'platform', platform):
                gates = ci.rust_regression_gates()
            for command, required, harnesses in gates:
                names = rust_required_names(required)
                for name, minimum in required.items():
                    matches = sorted(test for test in names if
                                     (test.startswith(name) if name.endswith('::') else test == name))
                    # Keep the harness nonempty and its summaries valid. The
                    # missing group alone must reject this otherwise green run.
                    incomplete = names-set(matches[minimum-1:])
                    output = rust_output(sorted(incomplete | {'unrelated::still_passes'}), harnesses)
                    with self.subTest(platform=platform, missing=name), \
                            patch.object(ci, 'run', return_value=output), \
                            patch('sys.stdout', new_callable=io.StringIO):
                        with self.assertRaisesRegex(ValueError, 'coverage missing'):
                            ci.checked_rust_tests(command, required, harnesses)

    def test_rust_gate_rejects_ignored_empty_duplicate_and_incomplete_results(self):
        valid = rust_output(['fixture::one', 'fixture::two'])
        invalid = (
            '', rust_output([]), 'Finished release [optimized] target(s)\n',
            valid.replace('test fixture::two ... ok', 'test fixture::two ... ignored')
                 .replace('2 passed; 0 failed; 0 ignored', '1 passed; 0 failed; 1 ignored'),
            valid.replace('0 failed', '1 failed'),
            valid.replace('2 passed', '3 passed'),
            valid.replace('test result: ok.', 'test result: FAILED.'),
            rust_output(['fixture::one', 'fixture::one']),
            valid+rust_output(['unexpected::test']),
            valid+rust_output([]).replace('test result: ok.', 'test result: FAILED.'),
        )
        for output in invalid:
            with self.subTest(output=output), patch.object(ci, 'run', return_value=output), \
                    patch('sys.stdout', new_callable=io.StringIO):
                with self.assertRaises(ValueError):
                    ci.checked_rust_tests(('cargo', 'test'), {'fixture::': 2}, 1)

    def test_required_rust_test_names_exist_in_selected_sources(self):
        # Unlike synthesized gate output, source declarations catch renamed tests.
        # Execution counts and module-prefix coverage remain enforced by the gate.
        for platform in ('linux', 'win32', 'darwin'):
            with patch.object(ci.sys, 'platform', platform):
                gates = ci.rust_regression_gates()
            for command, required, _ in gates:
                package = command[command.index('-p') + 1]
                root = ROOT / ('devcel-studio/src-tauri' if package == 'devcel-studio' else package)
                sources = list((root / 'src').rglob('*.rs'))
                targets = [command[i + 1] for i, arg in enumerate(command) if arg == '--test']
                sources += [root / 'tests' / (target + '.rs') for target in targets]
                if 'user_color_swatches_store' in targets:
                    sources += list((ROOT / 'devcel-studio/src-tauri/src').rglob('*.rs'))
                declarations = set()
                for source in sources:
                    declarations.update(re.findall(r'#\[(?:tokio::)?test(?:\([^\]]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:async\s+)?fn\s+(\w+)', source.read_text(encoding='utf-8')))
                for name in required:
                    if not name.endswith('::'):
                        with self.subTest(platform=platform, package=package, test=name):
                            self.assertIn(name.rsplit('::', 1)[-1], declarations)

    def test_platform_requirements_do_not_skip_unix_or_require_them_on_windows(self):
        for platform in ('linux', 'win32', 'darwin'):
            with patch.object(ci.sys, 'platform', platform):
                gates = ci.rust_regression_gates()
            integration, core, native = [required for _, required, _ in gates[:3]]
            self.assertEqual([count for _, _, count in gates], [20, 1, 1, 1, 1, 1, 1])
            self.assertEqual(gates[3][1]['app_settings_store::tests::'], 11)
            self.assertEqual(gates[3][1]['settings_resources_store::tests::'], 13)
            self.assertEqual(gates[3][1]['store::warning_tests::'], 1)
            self.assertEqual(core, {'plugin_resources::tests::': 1,
                                   'app_catalog::tests::': 3,
                                   'edit_controls::fixed_settings_tests::': 1,
                                   'theme_schema::tests::': 1,
                                   'localization::release_contract_tests::': 1,
                                   'table_catalog::display_metadata_stream_tests::': 3,
                                   'table_storage::tests::': 2, 'replication::typed_storage_tests::': 2,
                                   'app_settings_migration::tests::': 2,
                                   'app_error::authoring_contract_tests::': 5,
                                   'p2p_errors::localization_tests::': 3,
                                   'msgpack_client::localization_tests::': 3,
                                   'msgpack_server::localization_tests::': 9,
                                   'p2p_auth::tests::': 5, 'project_paths::tests::': 6,
                                   'msgpack_framing::resource_tests::': 2, 'registry::private_discovery_tests::': 2,
                                   'p2p_diagnostics::tests::': 1, 'conflict_resolution::tests::': 6,
                                   'write_locks::tests::': 1, 'table_mutation::read_dependency_tests::': 1,
                                   'project_impl::history_file_tests::': 1})
            self.assertEqual(native['plugin_packages::version_profile_tests::'],
                             10 if platform == 'win32' else 11)
            self.assertEqual('dangling_destination_symlink_is_rejected_with_a_semantic_path'
                             in integration, platform != 'win32')
            self.assertEqual('explicit_table_open_rejects_directories_and_links_without_changing_data'
                             in integration, platform != 'win32')
            self.assertEqual('explicit_interface_open_rejects_links_and_directories_but_preserves_regular_documents'
                             in integration, platform != 'win32')
            self.assertEqual(native['rule_commands::native_snapshot_regression_tests::native_snapshot_weight_counts_nested_formula_diagnostics_without_flattening'], 1)
            self.assertEqual('fifo_table_sources_are_never_opened_and_strict_discovery_reports_them'
                             in integration, platform == 'linux')
            self.assertEqual('automatic_interface_reload_rejects_foreign_symlinks_and_cycles'
                             in integration, platform != 'win32')
            for command, required, harnesses in gates:
                output = rust_output(sorted(rust_required_names(required)), harnesses)
                with patch.object(ci, 'run', return_value=output), \
                        patch('sys.stdout', new_callable=io.StringIO):
                    ci.checked_rust_tests(command, required, harnesses)

    def test_table_edit_controls_gate_requires_all_declared_tests_on_both_platforms(self):
        source = (ROOT/'devcel-core/tests/table_edit_controls.rs').read_text(encoding='utf-8')
        names = set(re.findall(r'#\[(?:tokio::)?test(?:\([^\]]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:async\s+)?fn\s+(\w+)', source))
        self.assertEqual(len(names), 23)
        bulk = 'shortcut_bulk_cells_and_version_validate_before_any_write_and_one_undo_restores_all'
        self.assertIn(bulk, names)
        for platform in ('linux', 'win32'):
            with self.subTest(platform=platform), patch.object(ci.sys, 'platform', platform):
                command, required, harnesses = ci.rust_regression_gates()[0]
                targets = [command[i+1] for i, arg in enumerate(command) if arg == '--test']
                self.assertEqual(targets.count('table_edit_controls'), 1)
                self.assertEqual(harnesses, 20)
                self.assertEqual({name: required.get(name) for name in names}, dict.fromkeys(names, 1))
                output = rust_output(sorted(rust_required_names(required)-{bulk}), harnesses)
                with patch.object(ci, 'run', return_value=output), patch('sys.stdout', new_callable=io.StringIO):
                    with self.assertRaisesRegex(ValueError, 'coverage missing: '+bulk):
                        ci.checked_rust_tests(command, required, harnesses)

    def test_audit_repairs_gate_requires_real_declared_regressions(self):
        targets = ('audit_data_integrity', 'codegen_identifier_safety',
                   'formula_collections_integration', 'referenced_deletion_regression')
        for platform in ('linux', 'win32'):
            with self.subTest(platform=platform), patch.object(ci.sys, 'platform', platform):
                gates = ci.rust_regression_gates()
                command, required, harnesses = gates[0]
                for target in targets:
                    source = (ROOT/f'devcel-core/tests/{target}.rs').read_text(encoding='utf-8')
                    names = set(re.findall(r'#\[(?:tokio::)?test(?:\([^\]]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:async\s+)?fn\s+(\w+)', source))
                    self.assertTrue(names)
                    self.assertEqual(command.count(target), 1)
                    expected = dict.fromkeys(names, 1)
                    if target == 'formula_collections_integration':
                        unix_only = 'automatic_interface_reload_rejects_foreign_symlinks_and_cycles'
                        self.assertRegex(source, r'#\[cfg\(unix\)\]\s*#\[test\]\s*fn '+unix_only)
                        if platform == 'win32':
                            expected[unix_only] = None
                    self.assertEqual({name: required.get(name) for name in names}, expected)
                runtime = gates[-2]
                self.assertIn('f32_max_decimal_roundtrip_uses_finite_f32_conversion', runtime[1])
                self.assertEqual(gates[-1][1], {'wolf_export::tests::minimal_blank_numeric_boolean_defaults_match_full_values': 1})

    def test_real_rust_gate_child_output_and_failure_are_not_masked(self):
        output = rust_output(['fixture::ran'])
        for status in (0, 7):
            command = (ci.sys.executable, '-c',
                       f'import sys; print({output!r}, end=""); sys.exit({status})')
            with self.subTest(status=status), patch('sys.stdout', new_callable=io.StringIO) as stdout:
                if status:
                    with self.assertRaises(subprocess.CalledProcessError) as error:
                        ci.checked_rust_tests(command, {'fixture::ran': 1}, 1)
                    self.assertEqual(error.exception.returncode, status)
                else:
                    ci.checked_rust_tests(command, {'fixture::ran': 1}, 1)
                self.assertEqual(stdout.getvalue(), output)

    def test_strict_check_command_is_available_to_ci_and_local_callers(self):
        with patch.object(ci.sys, 'argv', ['ci-release.py', 'strict_checks']), \
                patch.object(ci, 'strict_checks') as strict:
            ci.main()
            strict.assert_called_once_with()

    def test_automatic_workflows_only_build_and_package(self):
        for name, command in (('ci.yml', 'build_native'), ('release.yml', 'package')):
            text = (ROOT/'.github/workflows'/name).read_text()
            self.assertIn('python scripts/ci-release.py '+command, text)
            self.assertIn('os: [ubuntu-24.04, windows-2022, macos-15-intel, macos-15]', text)
            for forbidden in ('strict_checks', 'compact_checks', 'inspect_native', 'cargo test', '--no-run', 'RUSTFLAGS: -D warnings'):
                self.assertNotIn(forbidden, text)
        text = (ROOT/'.github/workflows/manual-checks.yml').read_text()
        triggers = text.split('on:\n', 1)[1].split('permissions:', 1)[0]
        self.assertEqual(re.findall(r'^  ([a-z_]+):$', triggers, re.MULTILINE), ['workflow_dispatch'])
        self.assertIn('options: [compact, frontend, rust, lint, importers, native, all]', text)


    def test_production_hook_reuses_cli_for_generation_without_validation(self):
        config = json.loads((ROOT/'scripts/tauri-release.conf.json').read_text())
        self.assertEqual(config['build']['beforeBuildCommand'], 'python ../scripts/ci-release.py frontend_release')
        for platform in ('linux', 'win32'):
            with patch.object(ci.sys, 'platform', platform), patch.object(ci, 'run') as run:
                ci.frontend_release()
            calls = [call.args for call in run.call_args_list]
            self.assertEqual(len(calls), 4)
            cli = ROOT/ci.studio_cli.DIRECTORY/('devcel.exe' if platform == 'win32' else 'devcel')
            self.assertEqual([call[3:5] for call in calls if call[0] == cli], [('localization', 'export'), ('app-catalog', 'export')])
            self.assertIn(('node', 'scripts/sync-plugin-sdk.js'), calls)
            self.assertEqual(calls[-1], ('node', 'node_modules/vite/bin/vite.js', 'build'))
            for call in calls:
                self.assertNotIn('--check', call)
                self.assertNotIn('cargo', call)
                self.assertNotIn('typecheck', call)

    def test_native_release_is_single_build_and_package_never_calls_local_suite(self):
        platforms = (
            ('linux', 'linux-x64', 'deb', 'devcel-studio'),
            ('windows', 'win-x64', None, 'devcel-studio.exe'),
        )
        for config in platforms:
            with self.subTest(platform=config[0]), tempfile.TemporaryDirectory() as temp, \
                    patch.dict(ci.os.environ, {'CARGO_TARGET_DIR': str(Path(temp)/'target')}), \
                    patch.object(ci, 'platform_config', return_value=config), \
                    patch.object(ci.studio_cli, 'stage', return_value=Path('prepared-cli.conf.json')), \
                    patch.object(ci, 'run') as run:
                ci.build_native()
                calls = [call.args for call in run.call_args_list]
                builds = [call for call in calls if call[:5] == ('npm', 'run', 'tauri', '--', 'build')]
                self.assertEqual(len(builds), 1)
                self.assertEqual(calls.pop(0), (ci.sys.executable, 'scripts/generate-third-party-notices.py', '--ensure'))
                self.assertEqual(calls[0], ('cargo','build','--locked','--release','-p','devcel-cli'))
                self.assertEqual(calls[1], builds[0])
                self.assertIn(Path('prepared-cli.conf.json'), builds[0])
                self.assertNotIn('--debug', builds[0])
                if config[0] == 'windows':
                    version = json.loads((ROOT/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
                    self.assertIn('--no-bundle', builds[0])
                    self.assertEqual(calls[2:], [(ci.sys.executable, 'scripts/package-windows-studio.py',
                        '--executable', Path(temp)/'target/release/devcel-studio.exe',
                        '--out', Path(temp)/f'target/release/portable/devcel-studio-{version}-windows-x64.zip')])
                else:
                    version = json.loads((ROOT/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
                    self.assertEqual(calls[2:], [(ci.sys.executable, 'scripts/debian_version.py',
                        '--bundle-dir', Path(temp)/'target/release/bundle/deb', '--version', version)])
                    self.assertEqual(builds[0][5:7], ('--bundles', 'deb'))
        with patch.object(ci, 'check') as local_check, \
                patch.object(ci, 'build_native', side_effect=RuntimeError('build boundary')) as build:
            with self.assertRaisesRegex(RuntimeError, 'build boundary'):
                ci.package()
            local_check.assert_not_called()
            build.assert_called_once()

    def test_pr_native_evidence_is_not_published(self):
        ci_text = (ROOT/'.github/workflows/ci.yml').read_text()
        self.assertNotIn('python scripts/ci-release.py inspect_native', ci_text)
        self.assertNotIn('ci-release.py publish', ci_text)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root/'target'
            (target/'release/portable').mkdir(parents=True)
            (target/'release/portable/studio.zip').write_bytes(b'installer')
            (target/'release/devcel-studio.exe').write_bytes(b'app')
            cli = root/ci.studio_cli.DIRECTORY
            cli.mkdir(parents=True)
            (cli/'devcel.exe').write_bytes(b'cli')
            with patch.object(ci, 'ROOT', root), \
                    patch.object(ci, 'build_native', return_value=('windows', 'win-x64', 'devcel-studio.exe', target)), \
                    patch.object(ci, 'verify_native', side_effect=RuntimeError('unreviewed')):
                with self.assertRaisesRegex(RuntimeError, 'unreviewed'):
                    ci.inspect_native()
            self.assertEqual((root/'native-review-artifacts/bundle/studio.zip').read_bytes(), b'installer')
            self.assertEqual((root/'native-review-artifacts/bundled-cli/devcel.exe').read_bytes(), b'cli')
            self.assertFalse((root/'release-assets').exists())

    def fixture(self, root):
        for system, platform in [('Linux', 'linux-x64'), ('Windows', 'win-x64'),
                                 ('macOS-X64', 'osx-x64'), ('macOS-ARM64', 'osx-arm64')]:
            directory = root/('release-'+system)
            directory.mkdir()
            for engine in ('unity', 'godot', 'unreal', 'rpgmaker', 'wolf', 'gamemaker', 'defold', 'cocos', 'javascript'):
                import zipfile
                with zipfile.ZipFile(directory/f'devcel-{engine}-0.1.0-{platform}.zip', 'w') as archive:
                    if engine == 'unity':
                        for name, raw in fixture_entries(platform).items():
                            archive.writestr(name, raw)
                    else:
                        archive.writestr('sdk/bin/manifest.json', json.dumps({'schema_version':1, 'version':'0.1.0', 'source_commit':'a'*40, 'source_repository':'owner/repo', 'supportedPlatforms':[platform], 'binaries':{platform:{'path':platform+'/devcel'}}}))
            (directory/ci.studio_asset_name(system.lower(), 'v0.1.0')).write_bytes(b'fixture')
        (root/'release-Windows/devcel-studio-0.1.0-windows-x64.zip').write_bytes(b'portable')
        (root/'release-Linux/SOURCE-ACCESS.json').write_bytes(b'source')
        for system in ('android', 'ios', 'webgl'):
            mobile_fixture(root/f'release-mobile-{system}'/f'unity-mobile-{system}.zip', system)

    def test_collect_rejects_old_importer_filename_and_manifest_identity(self):
        import zipfile
        for field, wrong in [('version', '0.0.2'), ('source_commit', 'b'*40), ('source_repository', 'other/repo'), ('supportedPlatforms', ['wrong-rid'])]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.fixture(root)
                path = root/'release-Windows/devcel-unity-0.1.0-win-x64.zip'
                with zipfile.ZipFile(path) as archive:
                    manifest = json.loads(archive.read('devcel-unity/Tools~/manifest.json'))
                manifest[field] = wrong
                with zipfile.ZipFile(path, 'w') as archive:
                    archive.writestr('sdk/bin/manifest.json', json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, 'version/source commit/platform'):
                    ci.collect_assets(root, root/'out', 'v0.1.0', 'a'*40, 'owner/repo')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            path = root/'release-Windows/devcel-unity-0.1.0-win-x64.zip'
            path.rename(path.with_name('devcel-unity-0.0.2-win-x64.zip'))
            with self.assertRaisesRegex(ValueError, 'unity'):
                ci.collect_assets(root, root/'out', 'v0.1.0', 'a'*40, 'owner/repo')

    def test_collect_complete_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            files = ci.collect_assets(root, root/'out', 'v0.1.0')
            self.assertEqual(len(files), 48)
            self.assertEqual(len((root/'out/SHA256SUMS.txt').read_text().splitlines()), 47)
            self.assertEqual(len(list((root/'out').glob('org.devcel.unity-*.tgz'))), 4)

    def test_publication_requires_both_mobile_artifacts(self):
        for system in ('android', 'ios', 'webgl'):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                self.fixture(root)
                (root/f'release-mobile-{system}'/f'unity-mobile-{system}.zip').unlink()
                with self.assertRaisesRegex(ValueError, 'runtime artifacts are required'):
                    ci.collect_assets(root, root/'out', 'v0.1.0')

    def test_studio_asset_names_match_release_version_and_platform(self):
        for version in ('0.0.2', '0.0.3', '1.2.3-rc.1'):
            for system, suffix in (('linux', 'linux-x64.deb'), ('windows', 'windows-x64.zip'),
                                   ('macos-x64', 'macos-x64.dmg'), ('macos-arm64', 'macos-arm64.dmg')):
                with self.subTest(version=version, system=system):
                    self.assertEqual(ci.studio_asset_name(system, 'v'+version),
                                     f'devcel-studio-{version}-{suffix}')
        for tag in ('0.1.0', 'v0.01.0', 'v0.1.0\n', 'v0.1.0/other'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                ci.studio_asset_name('linux', tag)
        with self.assertRaises(ValueError): ci.studio_asset_name('macos', 'v0.1.0')

    def test_collect_rejects_legacy_wrong_version_and_wrong_platform_studio_names(self):
        cases = {
            'Linux': ('linux-devcel-studio_0.1.0_amd64.deb',
                      'devcel-studio-0.0.9-linux-x64.deb', 'devcel-studio-0.1.0-linux-arm64.deb',
                      'devcel-studio-0.1.0-windows-x64.deb'),
            'Windows': ('devcel-studio-0.0.9-windows-x64.zip',
                        'devcel-studio-0.1.0-linux-x64.zip', 'devcel-studio-0.1.0-windows-arm64.zip'),
        }
        for system, invalid_names in cases.items():
            for invalid in invalid_names:
                with self.subTest(system=system, invalid=invalid), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp); self.fixture(root)
                    directory = root/('release-'+system)
                    expected = ci.studio_asset_name(system.lower(), 'v0.1.0')
                    (directory/expected).rename(directory/invalid)
                    with self.assertRaisesRegex(ValueError, 'Studio package'):
                        ci.collect_assets(root, root/'out', 'v0.1.0')

    def test_collect_rejects_missing_or_duplicate_studio_assets(self):
        for system in ('Linux', 'Windows', 'macOS-X64', 'macOS-ARM64'):
            for duplicate in (False, True):
                with self.subTest(system=system, duplicate=duplicate), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp); self.fixture(root)
                    directory = root/('release-'+system)
                    asset = directory/ci.studio_asset_name(system.lower(), 'v0.1.0')
                    if duplicate:
                        extra = directory/ci.studio_asset_name(system.lower(), 'v0.1.1')
                        extra.write_bytes(asset.read_bytes())
                    else:
                        asset.unlink()
                    with self.assertRaisesRegex(ValueError, 'Studio package'):
                        ci.collect_assets(root, root/'out', 'v0.1.0')

    def test_standardized_studio_names_and_raw_bytes_are_in_checksums(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); self.fixture(root)
            payloads = {}
            for system in ('Linux', 'Windows', 'macOS-X64', 'macOS-ARM64'):
                name = ci.studio_asset_name(system.lower(), 'v0.1.0')
                payloads[name] = (system+'\r\n').encode()+bytes(range(256))
                (root/('release-'+system)/name).write_bytes(payloads[name])
            ci.collect_assets(root, root/'out', 'v0.1.0')
            checksums = (root/'out/SHA256SUMS.txt').read_text()
            for name, raw in payloads.items():
                self.assertEqual((root/'out'/name).read_bytes(), raw)
                self.assertIn(ci.hashlib.sha256(raw).hexdigest()+'  '+name+'\n', checksums)
            self.assertNotIn('  linux-', checksums)

    def test_unreviewed_linux_installer_stops_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            (root/'release-Linux/studio.AppImage').write_bytes(b'unreviewed')
            with self.assertRaisesRegex(ValueError, 'Unsupported release installer'):
                ci.collect_assets(root, root/'out', 'v0.1.0')

    def test_macos_native_platform_and_toolchains(self):
        for machine, rid in (('x86_64', 'x64'), ('arm64', 'arm64')):
            with patch.object(ci.sys, 'platform', 'darwin'), patch.object(ci.platform, 'machine', return_value=machine):
                self.assertEqual(ci.platform_config(), ('macos-'+rid, 'osx-'+rid, 'app,dmg', 'devcel-studio'))
                with patch.object(ci, 'run') as run:
                    ci.toolchains()
                self.assertIn(('rustup', 'target', 'add', '--toolchain', '1.99.0',
                               'x86_64-apple-darwin', 'aarch64-apple-darwin'), [c.args for c in run.call_args_list])
        with patch.object(ci.sys, 'platform', 'darwin'), patch.object(ci.platform, 'machine', return_value='other'):
            with self.assertRaises(ValueError): ci.platform_config()

    def test_macos_build_checks_sealed_payload_and_propagates_signing_failure(self):
        for rid in ('x64', 'arm64'):
            with tempfile.TemporaryDirectory() as temp, patch.dict(ci.os.environ, {'CARGO_TARGET_DIR': temp}), \
                    patch.object(ci, 'platform_config', return_value=('macos-'+rid, 'osx-'+rid, 'app,dmg', 'devcel-studio')), \
                    patch.object(ci.studio_cli, 'configure_macos'), \
                    patch.object(ci.studio_cli, 'stage', return_value=Path('cli.conf.json')), \
                    patch.object(ci.studio_cli, 'validate', return_value={'sha256': 'signed'}) as validate, \
                    patch.object(ci, 'run') as run:
                ci.build_native()
                calls = [c.args for c in run.call_args_list]
                self.assertEqual(calls[2][:7], ('npm', 'run', 'tauri', '--', 'build', '--bundles', 'app,dmg'))
                self.assertEqual(calls[-1], ('codesign', '--verify', '--deep', '--strict',
                                            Path(temp)/'release/bundle/macos/devcel-studio.app'))
                self.assertEqual(validate.call_args.args, (Path(temp)/'release/bundle/macos/devcel-studio.app/Contents/Resources/bin', 'osx-'+rid))
                validate.side_effect = [{'sha256': 'original'}, {'sha256': 'modified'}]
                with self.assertRaisesRegex(ValueError, 'differs'): ci.build_native()
                validate.side_effect = None
                run.side_effect = lambda *args, **kwargs: (_ for _ in ()).throw(subprocess.CalledProcessError(1, args)) if args[0] == 'codesign' else None
                with self.assertRaises(subprocess.CalledProcessError): ci.build_native()

    def test_missing_macos_architecture_stops_publication(self):
        for label in ('macOS-X64', 'macOS-ARM64'):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); self.fixture(root)
                ci.shutil.rmtree(root/('release-'+label))
                with self.assertRaisesRegex(ValueError, 'All four'):
                    ci.collect_assets(root, root/'out', 'v0.1.0')

    def test_macos_cli_signed_before_manifest_hash_and_configured_ad_hoc(self):
        for rid in ('osx-x64', 'osx-arm64'):
            with self.subTest(rid=rid), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                for name in ('devcel-studio/src-tauri/tauri.conf.json', 'scripts/tauri-release.conf.json', 'devcel-cli/LICENSE'):
                    destination = root/name; destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes((ROOT/name).read_bytes())
                target = root/'target/release'; target.mkdir(parents=True)
                (target/'devcel').write_bytes(b'unsigned')
                def sign(command, **kwargs):
                    self.assertEqual(command[:4], ['codesign', '--force', '--sign', '-'])
                    Path(command[4]).write_bytes(b'signed')
                with patch.object(ci.studio_cli.subprocess, 'run', side_effect=sign):
                    config = ci.studio_cli.stage(root, target.parent, rid, source_commit='a'*40)
                manifest = ci.studio_cli.validate(root/ci.studio_cli.DIRECTORY, rid)
                self.assertEqual(manifest['sha256'], ci.hashlib.sha256(b'signed').hexdigest())
                self.assertEqual(json.loads(config.read_text())['bundle']['macOS']['signingIdentity'], '-')

    def test_linux_build_selects_deb_only(self):
        with patch.object(ci.sys, 'platform', 'linux'):
            self.assertEqual(ci.platform_config()[2], 'deb')

    def test_windows_build_is_portable_only(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.dict(ci.os.environ, {'CARGO_TARGET_DIR': str(Path(temp)/'target')}), \
                patch.object(ci.studio_cli, 'stage', return_value=Path('prepared-cli.conf.json')), \
                patch.object(ci.sys, 'platform', 'win32'), patch.object(ci, 'run') as run:
            ci.build_native()
        calls=[call.args for call in run.call_args_list]
        self.assertEqual(len(calls),4)
        self.assertEqual(calls.pop(0), (ci.sys.executable, 'scripts/generate-third-party-notices.py', '--ensure'))
        self.assertEqual(calls[0],('cargo','build','--locked','--release','-p','devcel-cli'))
        self.assertIn('--no-bundle',calls[1])
        self.assertNotIn('--bundles',calls[1])
        self.assertEqual(calls[2][1],'scripts/package-windows-studio.py')

    def test_windows_installer_stops_publication(self):
        for suffix in ('msi','exe'):
            with tempfile.TemporaryDirectory() as temp:
                root=Path(temp);self.fixture(root)
                (root/f'release-Windows/setup.{suffix}').write_bytes(b'old')
                with self.assertRaisesRegex(ValueError,'Unsupported release installer'):
                    ci.collect_assets(root,root/'out','v0.1.0')

    def test_missing_portable_stops_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);self.fixture(root)
            (root/'release-Windows/devcel-studio-0.1.0-windows-x64.zip').unlink()
            with self.assertRaisesRegex(ValueError,'Studio package'):
                ci.collect_assets(root,root/'out','v0.1.0')

    def test_restored_bundles_removed_before_linux_build(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);target=root/'target';release=target/'release'
            for name in ('bundle/appimage/old.AppImage','bundle/msi/old.msi','bundle/deb/old.deb','portable/old.zip','deps/keep.rlib','build/keep','devcel-studio'):
                path=release/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'old')
            (root/'devcel-studio/src-tauri').mkdir(parents=True)
            (root/'devcel-studio/src-tauri/tauri.conf.json').write_text(json.dumps({'version':'0.0.3'}))
            reports=root/'release-reports';reports.mkdir();(reports/'old.json').write_text('{}')
            def build(*args,**kwargs):
                if args[0] == 'cargo':
                    return
                if args[0] == ci.sys.executable:
                    if args[1] == 'scripts/generate-third-party-notices.py':
                        self.assertEqual(args[2], '--ensure')
                        return
                    self.assertEqual(args[1], 'scripts/debian_version.py')
                    self.assertTrue((release/'bundle/deb/new.deb').is_file())
                    return
                self.assertFalse((release/'bundle').exists())
                self.assertFalse((release/'portable').exists())
                self.assertFalse(reports.exists())
                output=release/'bundle/deb/new.deb';output.parent.mkdir(parents=True);output.write_bytes(b'new')
            with patch.object(ci,'ROOT',root), patch.dict(ci.os.environ,{'CARGO_TARGET_DIR':str(target)}), \
                    patch.object(ci.studio_cli,'stage',return_value=Path('prepared-cli.conf.json')), \
                    patch.object(ci.sys,'platform','linux'), patch.object(ci,'run',side_effect=build):
                ci.build_native()
            self.assertEqual(list(ci.native_artifact_dir('linux',target).iterdir()),[release/'bundle/deb/new.deb'])
            self.assertEqual((release/'deps/keep.rlib').read_bytes(),b'old')
            self.assertTrue((release/'build/keep').is_file())
            self.assertTrue((release/'devcel-studio').is_file())

    def test_cache_cleanup_preserves_compilation_and_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);target=root/'target';release=target/'release'
            for name in ('bundle/deb/new.deb','portable/new.zip','deps/keep.rlib','.fingerprint/keep'):
                path=release/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'keep')
            with patch.object(ci,'ROOT',root), patch.dict(ci.os.environ,{'CARGO_TARGET_DIR':str(target)}):
                ci.clean_native_outputs();ci.clean_native_outputs()
            self.assertFalse((release/'bundle').exists());self.assertFalse((release/'portable').exists())
            self.assertTrue((release/'deps/keep.rlib').is_file());self.assertTrue((release/'.fingerprint/keep').is_file())
            with patch.object(ci,'ROOT',root), patch.dict(ci.os.environ,{'CARGO_TARGET_DIR':str(root)}):
                with self.assertRaisesRegex(ValueError,'source root'):ci.clean_native_outputs()

    def test_only_selected_linux_format_is_inspected(self):
        with patch.object(ci,'run') as run:
            ci.verify_native('linux','devcel-studio',Path('target'))
        self.assertIn(Path('target/release/bundle/deb'),run.call_args.args)
        for name in ('ci.yml','release.yml'):
            text=(ROOT/'.github/workflows'/name).read_text()
            self.assertLess(text.index('Remove generated packages before caching'),text.index('Save Rust release cache'))
            self.assertIn('run: python scripts/ci-release.py clean_native_outputs',text)
            uploads=() if name=='ci.yml' else ('name: release-${{ runner.os }}',)
            for upload in uploads:
                self.assertLess(text.index(upload),text.index('Remove generated packages before caching'))

    def test_package_cannot_republish_stale_installer(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);target=root/'target'
            for name in ('release/bundle/deb/current.deb','release/bundle/appimage/old.AppImage','release/bundle/msi/old.msi'):
                path=target/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'fixture')
            out=root/'release-assets';out.mkdir();(out/'stale.msi').write_bytes(b'old')
            def package_command(*args,**kwargs):
                if args[1]=='scripts/package-importers.py':
                    imports=root/'release-importers';imports.mkdir()
                    for i in range(9):(imports/f'importer-{i}.zip').write_bytes(b'new')
                elif args[1]=='scripts/release_source.py':
                    self.assertIn('--verify-urls', args)
                    (out/'SOURCE-ACCESS.json').write_bytes(b'source')
                else:self.fail(str(args))
            with patch.object(ci,'ROOT',root), patch.dict(ci.os.environ,{'SOURCE_REPOSITORY':'owner/repo','SOURCE_COMMIT':'a'*40,'RELEASE_TAG':'v0.1.0'}), \
                    patch.object(ci,'build_native',return_value=('linux','linux-x64','devcel-studio',target)), \
                    patch.object(ci,'verify_native'),patch.object(ci,'run',side_effect=package_command):
                ci.package()
            self.assertEqual(len(list(out.iterdir())),11)
            self.assertEqual((out/'devcel-studio-0.1.0-linux-x64.deb').read_bytes(), b'fixture')
            self.assertEqual((target/'release/bundle/deb/current.deb').read_bytes(), b'fixture')
            self.assertFalse((out/'linux-current.deb').exists())
            self.assertFalse(any(p.suffix in ('.msi','.AppImage') for p in out.iterdir()))

    def test_package_rejects_missing_or_duplicate_native_studio_payloads(self):
        for count in (0, 2):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); target = root/'target'
                bundle = target/'release/bundle/deb'; bundle.mkdir(parents=True)
                for index in range(count):
                    (bundle/f'internal-{index}.deb').write_bytes(b'reviewed')
                with patch.object(ci, 'ROOT', root), \
                        patch.dict(ci.os.environ, {'RELEASE_TAG': 'v0.1.0'}), \
                        patch.object(ci, 'build_native', return_value=('linux', 'linux-x64', 'devcel-studio', target)), \
                        patch.object(ci, 'verify_native'), patch.object(ci, 'run') as run:
                    with self.assertRaisesRegex(ValueError, 'exactly one Studio package'):
                        ci.package()
                    run.assert_not_called()
                self.assertEqual(list((root/'release-assets').iterdir()), [])

    def test_missing_engine_stops_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            (root/'release-Windows/devcel-unity-0.1.0-win-x64.zip').unlink()
            with self.assertRaisesRegex(ValueError, 'unity'):
                ci.collect_assets(root, root/'out', 'v0.1.0')

    def test_missing_source_stops_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            (root/'release-Linux/SOURCE-ACCESS.json').unlink()
            with self.assertRaisesRegex(ValueError, 'source-access manifest'):
                ci.collect_assets(root, root/'out', 'v0.1.0')

    def publication_fixture(self):
        # collect_assets is mocked by orchestration tests; retain real byte reads
        # and privacy inspection over isolated collected metadata fixtures.
        from contextlib import contextmanager
        @contextmanager
        def fixture():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output = root/'release-publish'
                output.mkdir()
                (output/'SOURCE-ACCESS.json').write_text('{}\n')
                (output/'SHA256SUMS.txt').write_text('a'*64+'  fixture.zip\n')
                with patch.object(ci, 'ROOT', root), patch.dict(ci.os.environ, {
                        'PRODUCT_RELEASE_NOTES_VERSION': '0.1.0', 'PRODUCT_RELEASE_NOTES': 'Product changes'}):
                    yield
        return fixture()

    def test_publish_is_draft_upload_then_publish(self):
        captured = {}
        responses = iter(['a'*40, '[[{"tag_name":"v0.0.9"}],[]]', None,
                          '{"full_name":"owner/repo","visibility":"private"}', None, None, None])
        def command(*args, **kwargs):
            if '--notes-file' in args:
                path = Path(args[args.index('--notes-file')+1])
                captured['path'] = path
                captured['body'] = path.read_text(encoding='utf-8')
                self.assertFalse(path.is_relative_to(ci.ROOT))
            return next(responses)
        with self.publication_fixture(), patch.dict(ci.os.environ, {'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40,'GH_REPO':'owner/repo'}), \
                patch.object(ci,'validate'), patch.object(ci,'collect_assets',return_value=['asset']), \
                patch.object(ci,'checked_commit',return_value='a'*40), \
                patch.object(ci.release_source,'validate_index') as verify, \
                patch.object(ci.release_source,'source_index',return_value={'source':'fixture'}), \
                patch.object(ci.release_source,'source_notes',return_value='Exact source directions') as notes, \
                patch.object(ci,'run',side_effect=command) as run:
            ci.publish()
            calls=[call.args for call in run.call_args_list]
            self.assertEqual(calls[0],('gh','api','repos/{owner}/{repo}/commits/refs/tags/v0.1.0','--jq','.sha'))
            self.assertEqual(calls[1],('gh','api','--paginate','--slurp','repos/{owner}/{repo}/releases?per_page=100'))
            verify.assert_called_once_with(ci.ROOT/'release-publish/SOURCE-ACCESS.json','owner/repo','a'*40,'v0.1.0',ci.ROOT)
            notes.assert_called_once_with({'source':'fixture'},'private')
            self.assertIn('--draft',calls[4]); self.assertIn('--verify-tag',calls[4])
            self.assertNotIn('--generate-notes',calls[4]); self.assertNotIn('--notes',calls[4])
            self.assertIn('--notes-file',calls[4])
            self.assertEqual(captured['body'], 'Product changes\n\nExact source directions')
            self.assertFalse(captured['path'].exists())
            self.assertEqual(calls[5],('gh','release','upload','v0.1.0','asset'))
            self.assertEqual(calls[6],('gh','release','edit','v0.1.0','--draft=false'))

    def test_new_release_stages_complete_package_before_creating_normal_tag(self):
        self.check_new_release_publication(False)
        self.check_new_release_publication(True)

    def check_new_release_publication(self, resume):
        events = []
        def collect(*args):
            events.append('collect'); return ['asset']
        def stage(*args):
            events.append('stage'); return 'b'*40
        def command(*args, **kwargs):
            if args[:2] == ('git', 'ls-remote'):
                if args[-1] == 'refs/heads/main': return ('b' if resume or 'push' in events else 'a')*40+'\trefs/heads/main'
                return 'b'*40+'\trefs/tags/v0.1.0' if resume else ''
            if 'releases?per_page=100' in str(args): return '[[]]'
            if args == ('gh', 'api', 'repos/{owner}/{repo}'):
                return '{"full_name":"owner/repo","visibility":"public"}'
            if 'push' in args:
                events.append('push')
                self.assertIn('--atomic', args)
                self.assertEqual(args[-2:], ('b'*40+':refs/heads/main', 'b'*40+':refs/tags/v0.1.0'))
                self.assertNotIn('--force', args)
            if '--jq' in args: return 'b'*40
            if args[:3] == ('gh','release','create'):
                events.append('create')
                self.assertIn('?path=/importers/unity#v0.1.0', Path(args[args.index('--notes-file')+1]).read_text())
            if args[:3] == ('gh','release','upload'): events.append('upload')
            if args[:3] == ('gh','release','edit'): events.append('publish')
            return ''
        with self.publication_fixture(), patch.dict(ci.os.environ, {
                'GITHUB_EVENT_NAME':'workflow_dispatch', 'RECOVERY_RUN_ID':'', 'REBUILD_EXISTING_TAG':'false',
                'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40,'GH_REPO':'owner/repo'}), \
                patch.object(ci,'validate'), patch.object(ci,'checked_commit',return_value='a'*40), \
                patch.object(ci,'collect_assets',side_effect=collect), \
                patch.object(ci.unity_git_package,'stage_release',side_effect=stage), \
                patch.object(ci.release_source,'validate_index'), \
                patch.object(ci.release_source,'source_index',return_value={}), \
                patch.object(ci.release_source,'source_notes',return_value='source'), \
                patch.object(ci,'run',side_effect=command):
            ci.publish()
        self.assertEqual(events, ['collect','stage']+([] if resume else ['push'])+['create','upload','publish'])

    def test_existing_git_tag_payload_drift_stops_before_remote_writes(self):
        with self.publication_fixture(), patch.dict(ci.os.environ, {
                'GITHUB_EVENT_NAME':'workflow_dispatch', 'REBUILD_EXISTING_TAG':'true',
                'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40,'GH_REPO':'owner/repo'}), \
                patch.object(ci,'validate'), patch.object(ci,'checked_commit',return_value='a'*40), \
                patch.object(ci,'collect_assets',return_value=['asset']), \
                patch.object(ci.unity_git_package,'source_identity',return_value='a'*40), \
                patch.object(ci.unity_git_package,'stage_release',return_value='c'*40), \
                patch.object(ci.unity_git_package,'verify_release_tree',side_effect=ValueError('immutable release tag')) as verify, \
                patch.object(ci,'run',side_effect=['b'*40, '', '[[]]', '']) as run:
            with self.assertRaisesRegex(ValueError, 'immutable release tag'):
                ci.publish()
            verify.assert_called_once_with(ci.ROOT, 'b'*40, 'c'*40)
            self.assertFalse(any(call.args[:2] == ('gh','release') or 'push' in call.args
                                 for call in run.call_args_list))

    def test_publication_notes_normalize_input_and_bind_version(self):
        self.assertEqual(ci.publication_notes('v0.1.0', 'Exact source', 'Changes\r\n\r\nImproved editing.\r\n', '0.1.0'),
                         'Changes\n\nImproved editing.\n\nExact source')
        with self.assertRaisesRegex(ValueError, 'version'):
            ci.publication_notes('v0.1.0', 'source', 'Changes', '0.0.9')

    def test_product_notes_reject_invalid_input(self):
        for text in ('', ' \n', 'x'*65537, '\0', '\ud800'):
            with self.assertRaises((ValueError, UnicodeError)):
                ci.publication_notes('v0.1.0', 'source', text, '0.1.0')
        for tag in ('../0.1.0', 'v0.1.0/other', '0.1.0'):
            with self.assertRaises(ValueError):
                ci.publication_notes(tag, 'source', 'Changes', '0.1.0')

    def test_missing_notes_stops_before_draft_creation(self):
        with self.publication_fixture(), patch.dict(ci.os.environ, {'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40,'GH_REPO':'owner/repo','PRODUCT_RELEASE_NOTES':''}), \
                patch.object(ci,'validate'), patch.object(ci,'collect_assets',return_value=['asset']), \
                patch.object(ci,'checked_commit',return_value='a'*40), \
                patch.object(ci.release_source,'validate_index'), \
                patch.object(ci.release_source,'source_index',return_value={'source':'fixture'}), \
                patch.object(ci.release_source,'source_notes',return_value='Exact source'), \
                patch.object(ci,'run',side_effect=['a'*40,'[[]]',None,
                    '{"full_name":"owner/repo","visibility":"private"}']) as run:
            with self.assertRaisesRegex(ValueError, 'nonempty'):
                ci.publish()
            self.assertEqual(run.call_count, 4)

    def test_source_only_publication_never_generates_change_history(self):
        captured = {}
        def command(*args, **kwargs):
            if '--notes-file' in args:
                path = Path(args[args.index('--notes-file')+1])
                captured['body'] = path.read_text(encoding='utf-8')
                self.assertFalse(path.is_relative_to(ci.ROOT))
            if args[:3] == ('gh', 'api', 'repos/{owner}/{repo}/commits/refs/tags/v0.1.0'):
                return 'a'*40
            if '--slurp' in args:
                return '[[]]'
            if args[:3] == ('gh', 'api', 'repos/{owner}/{repo}'):
                return '{"full_name":"owner/repo","visibility":"private"}'
        with self.publication_fixture(), patch.dict(ci.os.environ, {
                'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40,'GH_REPO':'owner/repo',
                'PRODUCT_RELEASE_NOTES':'','PRODUCT_RELEASE_NOTES_VERSION':''}), \
                patch.object(ci,'validate'), patch.object(ci,'collect_assets',return_value=['asset']), \
                patch.object(ci,'checked_commit',return_value='a'*40), \
                patch.object(ci.release_source,'validate_index'), \
                patch.object(ci.release_source,'source_index',return_value={'source':'fixture'}), \
                patch.object(ci.release_source,'source_notes',return_value='Exact source directions'), \
                patch.object(ci,'run',side_effect=command) as run:
            ci.publish()
            self.assertEqual(captured['body'], 'Exact source directions')
            self.assertFalse(any('--generate-notes' in call.args for call in run.call_args_list))
        workflow = (ROOT/'.github/workflows/release.yml').read_text()
        self.assertNotIn('PRODUCT_RELEASE_NOTES', workflow)
        for version in ('v0.1.0', 'v2.3.4'):
            self.assertEqual(ci.publication_notes(version, 'Exact source directions', '', ''),
                             'Exact source directions')

    def test_changed_tag_stops_publication(self):
        with patch.dict(ci.os.environ, {'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40,'GH_REPO':'owner/repo'}), \
                patch.object(ci,'validate'), patch.object(ci,'checked_commit',return_value='a'*40), \
                patch.object(ci.unity_git_package, 'source_identity', return_value='c'*40), \
                patch.object(ci,'collect_assets') as collect, patch.object(ci,'run',return_value='b'*40) as run:
            with self.assertRaisesRegex(ValueError,'no longer points'): ci.publish()
            collect.assert_not_called(); self.assertEqual(run.call_count,2)

    def test_existing_release_stops_before_upload(self):
        for draft in (True,False):
            pages=json.dumps([[{'tag_name':'v0.0.9'}],[{'tag_name':'v0.1.0','draft':draft}]])
            with patch.dict(ci.os.environ,{'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40}), \
                    patch.object(ci,'validate'),patch.object(ci,'collect_assets') as collect, \
                    patch.object(ci,'checked_commit',return_value='a'*40), \
                    patch.object(ci,'run',side_effect=['a'*40,pages]) as run:
                with self.assertRaisesRegex(ValueError,'already exists'): ci.publish()
                collect.assert_not_called(); self.assertEqual(run.call_count,2)

    def test_release_list_failure_stops_before_publication(self):
        with patch.dict(ci.os.environ,{'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40}), \
                patch.object(ci,'validate'),patch.object(ci,'collect_assets') as collect, \
                patch.object(ci,'checked_commit',return_value='a'*40), \
                patch.object(ci,'run',side_effect=['a'*40,RuntimeError('API unavailable')]) as run:
            with self.assertRaisesRegex(RuntimeError,'API unavailable'): ci.publish()
            collect.assert_not_called(); self.assertEqual(run.call_count,2)

    def test_wrong_or_missing_source_stops_before_release_creation(self):
        with self.publication_fixture(), patch.dict(ci.os.environ,{'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40,'GH_REPO':'owner/repo'}), \
                patch.object(ci,'validate'),patch.object(ci,'collect_assets',return_value=['asset']), \
                patch.object(ci,'checked_commit',return_value='a'*40), \
                patch.object(ci.release_source,'validate_index',side_effect=ValueError('source mismatch')), \
                patch.object(ci,'run',side_effect=['a'*40,'[[]]',None]) as run:
            with self.assertRaisesRegex(ValueError,'source mismatch'): ci.publish()
            self.assertEqual(run.call_count,3)

    def test_visibility_failure_or_wrong_repository_stops_creation(self):
        for response in (RuntimeError('API unavailable'),'{"full_name":"other/repo","visibility":"public"}'):
            with self.publication_fixture(), patch.dict(ci.os.environ,{'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40,'GH_REPO':'owner/repo'}), \
                    patch.object(ci,'validate'),patch.object(ci,'collect_assets',return_value=['asset']), \
                    patch.object(ci,'checked_commit',return_value='a'*40), \
                    patch.object(ci.release_source,'validate_index'), \
                    patch.object(ci,'run',side_effect=['a'*40,'[[]]',None,response]) as run:
                with self.assertRaises((RuntimeError,ValueError)): ci.publish()
                self.assertEqual(run.call_count,4)

    def test_release_create_or_upload_failure_does_not_publish(self):
        for stage in ('create','upload'):
            replies=['a'*40,'[[]]',None,'{"full_name":"owner/repo","visibility":"public"}']
            if stage=='upload': replies.append(None)
            replies.append(RuntimeError('failed '+stage))
            with self.publication_fixture(), patch.dict(ci.os.environ,{'RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':'a'*40,'GH_REPO':'owner/repo'}), \
                    patch.object(ci,'validate'),patch.object(ci,'collect_assets',return_value=['asset']), \
                    patch.object(ci,'checked_commit',return_value='a'*40), \
                    patch.object(ci.release_source,'validate_index'), \
                    patch.object(ci.release_source,'source_index'), \
                    patch.object(ci.release_source,'source_notes',return_value='source directions'), \
                    patch.object(ci,'run',side_effect=replies) as run:
                with self.assertRaisesRegex(RuntimeError,'failed '+stage): ci.publish()
                self.assertEqual(run.call_count,len(replies))
                self.assertFalse(any('--draft=false' in call.args for call in run.call_args_list))


class ManualVersionPreparationTests(unittest.TestCase):
    def environment(self, version='0.0.3'):
        return {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
                'GITHUB_SHA': 'a'*40, 'GH_REPO': 'owner/repo',
                'GITHUB_REPOSITORY': 'owner/repo', 'RELEASE_VERSION': version}

    def simulate(self, *, version='0.0.3', changed=True, remote_shas=None, existing=False,
                 fail_script=None, push_failure=False, dirty=False, unexpected=False):
        import release_version
        base, prepared = 'a'*40, ('b'*40 if changed else 'a'*40)
        replies = iter(remote_shas or [base, base, prepared])
        paths = ['Cargo.toml', 'Cargo.lock'] if changed else []
        calls = []
        def fake_run(*args, **kwargs):
            calls.append(args)
            if 'ls-remote' in args:
                if args[-1].startswith('refs/tags/'):
                    return base+'\t'+args[-1]+'\n' if existing else ''
                return next(replies)+'\trefs/heads/main\n'
            if args[:3] == ('git', 'status', '--porcelain'):
                return ' M unrelated.txt' if dirty else ''
            if args[:2] == ('git', 'diff'):
                return '\0'.join(paths+(['unrelated.txt'] if unexpected else []))+'\0'
            if args[:3] == ('git', 'rev-parse', '--verify'):
                return prepared+'\n'
            if fail_script and fail_script in args:
                raise subprocess.CalledProcessError(1, args)
            if push_failure and 'push' in args:
                raise subprocess.CalledProcessError(1, args)
            return ''
        with patch.dict(ci.os.environ, self.environment(version)), \
                patch.object(ci, 'checked_commit', return_value=base), \
                patch.object(ci, 'run', side_effect=fake_run), \
                patch.object(release_version, 'bump', return_value=paths) as bump, \
                patch.object(ci, 'validate'), \
                patch.object(ci, 'release_request', return_value=('v'+version, prepared)) as request, \
                patch.object(ci, 'emit_release') as emit:
            error = None
            try:
                ci.prepare_manual_release()
            except (ValueError, subprocess.CalledProcessError) as exc:
                error = exc
            return calls, bump, request, emit, error

    def test_current_and_future_versions_prepare_exact_commit_before_output(self):
        for version in ('0.0.2', '0.0.3', '0.0.4-rc.1'):
            with self.subTest(version=version):
                calls, bump, request, emit, error = self.simulate(version=version)
                self.assertIsNone(error)
                bump.assert_called_once_with(version, ci.ROOT)
                request.assert_called_once_with('workflow_dispatch', 'refs/heads/main', version, 'b'*40)
                emit.assert_called_once_with('v'+version, 'b'*40)
                push = next(call for call in calls if 'push' in call)
                self.assertEqual(push[-3:], ('push', 'https://github.com/owner/repo.git', 'HEAD:refs/heads/main'))
                self.assertIn('credential.helper=!gh auth git-credential', push)
                self.assertNotIn('--force', push)
                self.assertTrue(any(call[:3] == ('git', 'add', '--') for call in calls))
                self.assertFalse(any('scripts/test-release-version.py' in call or 'scripts/test-release-source.py' in call for call in calls))
                self.assertFalse(any('--global' in call or 'config' in call for call in calls))

    def test_retry_on_already_prepared_main_creates_no_duplicate_commit(self):
        calls, bump, request, emit, error = self.simulate(changed=False)
        self.assertIsNone(error)
        self.assertFalse(any('commit' in call or 'push' in call or 'add' in call for call in calls))
        emit.assert_called_once_with('v0.0.3', 'a'*40)

    def test_invalid_event_ref_version_or_repository_never_mutates(self):
        import release_version
        variants = [{'RELEASE_VERSION': value} for value in
                    ('', 'v0.0.3', '0.0.3\n', '0.0.3;echo bad', '01.0.3', '0.0.3+build')]
        variants += [{'GITHUB_EVENT_NAME': 'push'}, {'GITHUB_REF': 'refs/heads/feature'},
                     {'GH_REPO': 'different/repo'}, {'GH_REPO': '../repo'}]
        for variant in variants:
            with self.subTest(variant=variant), \
                    patch.dict(ci.os.environ, {**self.environment(), **variant}), \
                    patch.object(ci, 'run') as run, patch.object(release_version, 'bump') as bump, \
                    patch.object(ci, 'emit_release') as emit:
                with self.assertRaises(ValueError): ci.prepare_manual_release()
                run.assert_not_called(); bump.assert_not_called(); emit.assert_not_called()

    def test_stale_main_existing_tag_and_dirty_checkout_stop_before_bump(self):
        for options in ({'remote_shas': ['c'*40]}, {'existing': True}, {'dirty': True}):
            with self.subTest(options=options):
                calls, bump, request, emit, error = self.simulate(**options)
                self.assertIsInstance(error, ValueError)
                bump.assert_not_called(); request.assert_not_called(); emit.assert_not_called()
                self.assertFalse(any('push' in call or 'commit' in call for call in calls))

    def test_offline_validation_and_races_stop_without_release_output(self):
        variants = [{'fail_script': 'scripts/'+name} for name in
                    ('release_source.py', 'generate-third-party-notices.py')]
        variants += [{'remote_shas': ['a'*40, 'c'*40]}, {'unexpected': True}]
        for options in variants:
            with self.subTest(options=options):
                calls, bump, request, emit, error = self.simulate(**options)
                self.assertIsNotNone(error)
                request.assert_not_called(); emit.assert_not_called()
                self.assertFalse(any('push' in call or 'commit' in call for call in calls))

    def test_rejected_push_and_post_push_race_never_allow_tagging(self):
        for options in ({'push_failure': True}, {'remote_shas': ['a'*40, 'a'*40, 'c'*40]}):
            with self.subTest(options=options):
                calls, bump, request, emit, error = self.simulate(**options)
                self.assertIsNotNone(error)
                request.assert_not_called(); emit.assert_not_called()
                self.assertEqual(sum('push' in call for call in calls), 1)

    def test_real_normal_push_accepts_prepared_commit_and_rejects_concurrent_main(self):
        import release_version
        for race in (False, True):
            with self.subTest(race=race), tempfile.TemporaryDirectory() as directory:
                temp = Path(directory)
                remote = temp/'remote.git'
                root = temp/'checkout'; root.mkdir()
                def git(*args, cwd=root):
                    return subprocess.run(['git', *map(str, args)], cwd=cwd, check=True,
                                          text=True, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE).stdout.strip()
                git('init', '--bare', '--initial-branch=main', remote)
                git('init', '--initial-branch=main')
                git('config', 'user.name', 'Fixture')
                git('config', 'user.email', 'fixture@example.invalid')
                (root/'VERSION').write_text('0.0.2\n')
                git('add', 'VERSION'); git('commit', '-m', 'Base')
                git('remote', 'add', 'origin', remote)
                git('push', 'origin', 'HEAD:main')
                base = git('rev-parse', 'HEAD')
                competitor = temp/'competitor'
                git('clone', remote, competitor)
                git('config', 'user.name', 'Competitor', cwd=competitor)
                git('config', 'user.email', 'competitor@example.invalid', cwd=competitor)
                real_run = ci.run
                real_checked = ci.checked_commit
                def run(*args, **kwargs):
                    if args[0] != 'git':
                        return ''  # Offline validators have their own real suites.
                    if race and 'push' in args:
                        (competitor/'COMPETING').write_text('concurrent update\n')
                        git('add', 'COMPETING', cwd=competitor)
                        git('commit', '-m', 'Concurrent change', cwd=competitor)
                        git('push', 'origin', 'HEAD:main', cwd=competitor)
                    # Substitute only the fixed repository URL with this local bare remote.
                    args = tuple(str(remote) if arg == 'https://github.com/owner/repo.git' else arg
                                 for arg in args)
                    kwargs['cwd'] = root
                    return real_run(*args, **kwargs)
                def bump(version, target):
                    self.assertEqual(target, root)
                    (root/'VERSION').write_text(version+'\n')
                    return ['VERSION']
                env = {**self.environment(), 'GITHUB_SHA': base}
                with patch.dict(ci.os.environ, env), patch.object(ci, 'ROOT', root), \
                        patch.object(ci, 'run', side_effect=run), \
                        patch.object(ci, 'checked_commit', side_effect=lambda sha, **kwargs: real_checked(sha, root)), \
                        patch.object(release_version, 'bump', side_effect=bump), \
                        patch.object(ci, 'validate'), patch.object(ci, 'emit_release') as emit:
                    if race:
                        with self.assertRaises(subprocess.CalledProcessError):
                            ci.prepare_manual_release()
                        emit.assert_not_called()
                        self.assertNotEqual(git('rev-parse', 'HEAD'), git('rev-parse', 'main', cwd=remote))
                    else:
                        ci.prepare_manual_release()
                        prepared = git('rev-parse', 'HEAD')
                        self.assertNotEqual(prepared, base)
                        self.assertEqual(git('rev-parse', 'main', cwd=remote), prepared)
                        self.assertEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', prepared), 'VERSION')
                        emit.assert_called_once_with('v0.0.3', prepared)
                    self.assertEqual(git('tag', '--list', cwd=remote), '')

    def test_small_cli_fixture_preserves_real_evidence_and_rejects_tampering(self):
        import hashlib
        import release_cli_test_fixture as fixture
        import release_version
        notices = release_version.module('generate-third-party-notices')
        source_inventory = json.loads((ROOT/release_version.GENERATED/'inventory.json').read_text())
        source_bodies = {e['sha256']: (ROOT/release_version.GENERATED/e['file']).read_bytes()
                         for p in source_inventory['packages'] for e in p['texts']}
        with tempfile.TemporaryDirectory(prefix='release-cli-graph-') as directory:
            root = Path(directory)
            fixture.build(ROOT, root)
            inventory = json.loads((root/release_version.GENERATED/'inventory.json').read_text())
            for package in inventory['packages']:
                for evidence in package['texts']:
                    raw = (root/release_version.GENERATED/evidence['file']).read_bytes()
                    self.assertEqual(raw, source_bodies[evidence['sha256']])
                    self.assertEqual(hashlib.sha256(raw).hexdigest(), evidence['sha256'])
            def rejects(name, transform, validator):
                path = root/name
                original = path.read_bytes()
                altered = transform(original)
                self.assertNotEqual(altered, original, 'Negative fixture must change data')
                path.write_bytes(altered)
                try:
                    with self.assertRaises((ValueError, RuntimeError)):
                        validator(root)
                finally:
                    path.write_bytes(original)
                fixture.validate_graph(root)
            def change_json(raw, change):
                value = json.loads(raw)
                change(value)
                return (json.dumps(value)+'\n').encode()
            rejects('Cargo.toml', lambda b: b.replace(b'"devcel-cli", ', b''), fixture.validate_graph)
            rejects('devcel-cli/Cargo.toml', lambda b: b.replace(b'../devcel-core', b'../wrong-core'), fixture.validate_graph)
            rejects('devcel-studio/src-tauri/Cargo.toml', lambda b: b.replace(b'=0.3.5', b'=0.3.4'), fixture.validate_graph)
            rejects('Cargo.lock', lambda b: b.replace(b'"dtoa"', b'"missing-dtoa"'), fixture.validate_graph)
            rejects('Cargo.lock', lambda b: b.replace(b'dependencies = ["dtoa"]', b'dependencies = []'), fixture.validate_graph)
            rejects('devcel-studio/package-lock.json', lambda b: change_json(b, lambda d: d['packages']['node_modules/clsx'].update(integrity='invalid')), fixture.validate_graph)
            rejects('third-party/preferred-sources.json', lambda b: change_json(b, lambda d: d['cargo'][0].update(commit='0'*40)), fixture.validate_graph)
            body = inventory['packages'][0]['texts'][0]['file']
            rejects(release_version.GENERATED+'/'+body, lambda b: b+b'\ncorrupted evidence', notices.verify_locks)
            cargo_lock = root/'Cargo.lock'
            original_lock = cargo_lock.read_bytes()
            header, *blocks = original_lock.split(b'[[package]]')
            cargo_lock.write_bytes(header+b''.join(b'[[package]]'+block for block in reversed(blocks)))
            try:
                fixture.validate_graph(root)  # External entries before workspace entries must not shadow its version.
            finally:
                cargo_lock.write_bytes(original_lock)
            aggregate = root/release_version.GENERATED/'THIRD-PARTY-NOTICES.txt'
            public = root/release_version.PUBLIC
            original = aggregate.read_bytes()
            aggregate.write_bytes(original+b'\nUnreviewed addition\n')
            public.write_bytes(aggregate.read_bytes())
            with self.assertRaisesRegex(ValueError, 'round-trip differs'):
                notices.verify_render(root)

    def test_real_cli_keeps_checkout_clean_without_caller_bytecode_flags(self):
        # Execute the actual CLI and all of its real child validation scripts.
        # No -B or inherited PYTHONDONTWRITEBYTECODE may hide startup imports.
        import release_version
        notices = release_version.module('generate-third-party-notices')
        with tempfile.TemporaryDirectory(prefix='release-cli-bytecode-') as directory:
            temp = Path(directory)
            root = temp/'checkout'; root.mkdir()
            remote = temp/'remote.git'
            paths = set(notices.lock_hashes(ROOT))
            paths.update([release_version.PUBLIC, 'devcel-studio/src-tauri/tauri.conf.json',
                          'importers/unreal/Devcel.uplugin', 'importers/godot/addons/devcel/plugin.cfg',
                          'devcel-studio/src/app/plugins/examples/CSVExporterPlugin.ts',
                          'devcel-studio/templates/plugin-template/src/index.ts'])
            paths.update(p.relative_to(ROOT).as_posix()
                         for p in (ROOT/release_version.GENERATED).rglob('*') if p.is_file())
            paths.update(p.relative_to(ROOT).as_posix() for p in (ROOT/'scripts').glob('*.py'))
            import hashlib
            import release_cli_test_fixture as fixture
            def source_hashes():
                return {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in paths}
            original_source_hashes = source_hashes()
            self.addCleanup(lambda: self.assertEqual(source_hashes(), original_source_hashes))
            fixture.build(ROOT, root)
            def git(*args, cwd=root):
                return subprocess.run(['git', *map(str, args)], cwd=cwd, check=True,
                                      text=True, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE).stdout.strip()
            git('init', '--initial-branch=main')
            git('config', 'core.autocrlf', 'false')
            git('add', '.')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                'commit', '-m', 'Clean source and reviewed release evidence')
            git('init', '--bare', '--initial-branch=main', remote)
            git('push', remote, 'HEAD:main')
            base = git('rev-parse', 'HEAD')
            env = dict(ci.os.environ)
            for key in ('PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX'):
                env.pop(key, None)
            env.update(self.environment(), GITHUB_SHA=base, GITHUB_OUTPUT=str(temp/'output'),
                       GIT_CONFIG_COUNT='1',
                       GIT_CONFIG_KEY_0='url.'+remote.resolve().as_uri()+'.insteadOf',
                       GIT_CONFIG_VALUE_0='https://github.com/owner/repo.git',
                       GIT_TERMINAL_PROMPT='0')
            probe = subprocess.run([ci.sys.executable, '-c',
                                    'import sys; print(sys.dont_write_bytecode)'],
                                   cwd=root, env=env, text=True, capture_output=True, check=True)
            self.assertEqual(probe.stdout.strip(), 'False')
            def invoke():
                return subprocess.run([ci.sys.executable, 'scripts/ci-release.py',
                                       'prepare_manual_release'], cwd=root, env=env,
                                      text=True, capture_output=True, timeout=300)
            # Existing untracked files, including a pre-existing Python cache,
            # must still fail untouched. Production code must never clean them up.
            for name in ('unrelated.txt', 'scripts/__pycache__/existing.pyc'):
                path = root/name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'existing user content')
                result = invoke()
                self.assertNotEqual(result.returncode, 0, result.stdout+result.stderr)
                self.assertIn('requires a clean checkout', result.stderr)
                self.assertEqual(path.read_bytes(), b'existing user content')
                self.assertEqual(git('rev-parse', 'main', cwd=remote), base)
                self.assertFalse((temp/'output').exists())
                path.unlink()  # Remove only the dirty fixture created by this test.
            self.assertEqual(git('status', '--porcelain'), '')
            result = invoke()
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            prepared = git('rev-parse', 'HEAD')
            self.assertEqual(git('rev-parse', 'main', cwd=remote), prepared)
            self.assertEqual((temp/'output').read_text(), 'tag=v0.0.3\ncommit='+prepared+'\n')
            self.assertEqual(git('status', '--porcelain'), '')
            self.assertEqual(list(root.rglob('*.pyc')), [])
            self.assertEqual(git('tag', '--list', cwd=remote), '')
            self.assertEqual(re.findall(r'^Ran (\d+) tests in ', result.stderr, re.MULTILINE), [])
            self.assertEqual(len(re.findall(r'^OK$', result.stderr, re.MULTILINE)), 0)
            fixture.validate_graph(root)

    def test_tag_validation_never_invokes_version_preparation(self):
        import release_version
        with patch.dict(ci.os.environ, {**self.environment(), 'GITHUB_EVENT_NAME': 'push',
                                       'GITHUB_REF': 'refs/tags/v0.0.3'}), \
                patch.object(ci, 'release_request', return_value=('v0.0.3', 'a'*40)), \
                patch.object(ci, 'run', return_value='upm'), \
                patch.object(ci.unity_git_package, 'source_identity', return_value='a'*40), \
                patch.object(release_version, 'bump') as bump, patch.object(ci, 'emit_release'):
            ci.prepare_release()
        bump.assert_not_called()

    def test_source_only_tag_push_is_rejected_without_publication(self):
        with patch.dict(ci.os.environ, {**self.environment(), 'GITHUB_EVENT_NAME': 'push',
                                       'GITHUB_REF': 'refs/tags/v0.0.3'}), \
                patch.object(ci, 'release_request', return_value=('v0.0.3', 'a'*40)), \
                patch.object(ci, 'run', return_value=''), patch.object(ci, 'emit_release') as emit:
            with self.assertRaisesRegex(ValueError, 'must already contain generated Unity package'):
                ci.prepare_release()
        emit.assert_not_called()

    def test_dispatch_preparation_is_separate_and_validate_stays_read_only(self):
        text = (ROOT/'.github/workflows/release.yml').read_text()
        prepare = text.split('  prepare_manual:\n', 1)[1].split('  validate:\n', 1)[0]
        self.assertIn("if: github.event_name == 'workflow_dispatch'", prepare)
        self.assertIn('contents: write', prepare)
        self.assertIn('run: python scripts/ci-release.py prepare_manual_release', prepare)
        validate = text.split('  validate:\n', 1)[1].split('  create_tag:\n', 1)[0]
        self.assertIn('needs: prepare_manual', validate)
        self.assertIn("needs.prepare_manual.result == 'skipped'", validate)
        self.assertIn("needs.prepare_manual.result == 'success'", validate)
        self.assertIn('ref: ${{ needs.prepare_manual.outputs.commit || github.sha }}', validate)
        self.assertIn('SOURCE_COMMIT: ${{ needs.prepare_manual.outputs.commit || github.sha }}', validate)
        self.assertNotIn('contents: write', validate)


class RustWarningGateTests(unittest.TestCase):
    """Real, offline positive/negative controls; never build project dependencies."""

    def fixture_runs(self, source, commands):
        toolchain = ci.tomllib.loads((ROOT/'rust-toolchain.toml').read_text())['toolchain']['channel']
        rustup = ci.shutil.which('rustup') or 'rustup'
        with tempfile.TemporaryDirectory(prefix='devcel-warning-gate-') as temp:
            root = Path(temp)
            (root/'src').mkdir()
            (root/'Cargo.toml').write_text(
                '[package]\nname = "warning-gate-fixture"\n'
                'edition = "2021"\n[workspace]\n', encoding='utf-8')
            (root/'src/lib.rs').write_text(source, encoding='utf-8')
            env = dict(ci.os.environ)
            # Positive controls intentionally permit warnings only in this fixture.
            # Never mutate the workflow's production warning policy or target cache.
            for name in ('CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET', 'CLIPPY_ARGS'):
                env.pop(name, None)
            env.update(CARGO_TARGET_DIR=str(root/'target'), CARGO_NET_OFFLINE='true',
                       CARGO_BUILD_WARNINGS='warn', CARGO_TERM_COLOR='never')
            results = []
            for command, flags, rustflags in commands:
                env['RUSTFLAGS'] = rustflags
                # Unlike cargo +TOOLCHAIN, rustup run without --install cannot
                # download a missing toolchain. Missing tools are a test failure.
                result = subprocess.run([
                    rustup, 'run', toolchain, 'cargo', command, '--offline',
                    '--message-format=json', '--release', '--workspace', '--all-features', *flags,
                ], cwd=root, env=env, text=True, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, timeout=60)
                results.append(result)
            return results

    def assert_diagnostic(self, result, code, level):
        diagnostics = []
        for line in result.stdout.splitlines():
            message = json.loads(line)
            if message.get('reason') == 'compiler-message':
                diagnostic = message['message']
                diagnostics.append(((diagnostic.get('code') or {}).get('code'), diagnostic['level']))
        self.assertIn((code, level), diagnostics, result.stdout+result.stderr)

    def test_real_compiler_warning_fails_only_when_warnings_are_denied(self):
        normal, strict = self.fixture_runs(
            'pub fn compiler_warning() { let unused_value = 42; }\n', [
                ('check', ['--all-targets'], ''),
                ('check', ['--all-targets'], '-D warnings'),
            ])
        self.assertEqual(normal.returncode, 0, normal.stdout+normal.stderr)
        self.assert_diagnostic(normal, 'unused_variables', 'warning')
        self.assertNotEqual(strict.returncode, 0, strict.stdout+strict.stderr)
        self.assert_diagnostic(strict, 'unused_variables', 'error')

    def test_real_clippy_warning_fails_only_when_warnings_are_denied(self):
        normal, strict = self.fixture_runs('pub fn answer() -> u32 { return 42; }\n', [
            ('clippy', ['--all-targets'], ''),
            ('clippy', ['--all-targets', '--', '-D', 'warnings'], ''),
        ])
        self.assertEqual(normal.returncode, 0, normal.stdout+normal.stderr)
        self.assert_diagnostic(normal, 'clippy::needless_return', 'warning')
        self.assertNotEqual(strict.returncode, 0, strict.stdout+strict.stderr)
        self.assert_diagnostic(strict, 'clippy::needless_return', 'error')

    def test_all_targets_catches_a_real_test_only_clippy_finding(self):
        library_only, all_targets = self.fixture_runs(
            'pub fn answer() -> u32 { 42 }\n'
            '#[cfg(test)] mod tests {\n'
            '    fn test_answer() -> u32 { return 42; }\n'
            '    #[test] fn answer_matches() { assert_eq!(test_answer(), super::answer()); }\n'
            '}\n', [
                ('clippy', ['--', '-D', 'warnings'], '-D warnings'),
                ('clippy', ['--all-targets', '--', '-D', 'warnings'], '-D warnings'),
            ])
        self.assertEqual(library_only.returncode, 0, library_only.stdout+library_only.stderr)
        self.assertNotEqual(all_targets.returncode, 0, all_targets.stdout+all_targets.stderr)
        self.assert_diagnostic(all_targets, 'clippy::needless_return', 'error')


apt_spec = importlib.util.spec_from_file_location('ci_apt_cache', ROOT/'scripts/ci-apt-cache.py')
apt = importlib.util.module_from_spec(apt_spec)
apt_spec.loader.exec_module(apt)


class AptCacheTests(unittest.TestCase):
    NAME = 'fixture_1%3a1.0_all.deb'
    DATA = b'package archive fixture'

    def archives(self):
        return {self.NAME: {'size': len(self.DATA),
                            'sha256': apt.hashlib.sha256(self.DATA).hexdigest()}}

    def test_plan_uses_sha256_and_rejects_unsafe_or_weak_records(self):
        digest = self.archives()[self.NAME]['sha256']
        record = f"'https://example.invalid/fixture.deb' {self.NAME} {len(self.DATA)} SHA256:{digest}"
        self.assertEqual(apt.parse_plan('Reading package lists...\n'+record), self.archives())
        for bad in (record.replace(self.NAME, '../bad.deb'),
                    record.replace('SHA256:', 'MD5Sum:'), record.replace(digest, 'bad'),
                    record.replace(str(len(self.DATA)), '-1'), record+' extra'):
            with self.subTest(record=bad), self.assertRaises(ValueError):
                apt.parse_plan(bad)

    def test_key_tracks_resolved_archives_and_explicit_packages(self):
        original = self.archives()
        key = apt.cache_key(original)
        self.assertEqual(key, apt.cache_key(dict(reversed(list(original.items())))))
        changed = self.archives()
        changed[self.NAME]['sha256'] = '0'*64
        self.assertNotEqual(key, apt.cache_key(changed))
        with patch.object(apt, 'PACKAGES', (*apt.PACKAGES, 'new-package')):
            self.assertNotEqual(key, apt.cache_key(original))

    def test_restore_rejects_same_size_corruption_stale_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cache = root/'cache'; cache.mkdir()
            destination = root/'verified'; destination.mkdir()
            source = cache/self.NAME
            source.write_bytes(self.DATA)
            (cache/'stale.deb').write_bytes(self.DATA)
            self.assertEqual(apt.restore_verified(cache, destination, self.archives()),
                             (1, len(self.DATA)))
            self.assertEqual([p.name for p in destination.iterdir()], [self.NAME])
            (destination/self.NAME).unlink()
            for bad in (b'X'+self.DATA[1:], b'truncated'):
                source.write_bytes(bad)
                self.assertEqual(apt.restore_verified(cache, destination, self.archives()), (0, 0))
                self.assertEqual(list(destination.iterdir()), [])
            source.unlink()
            with patch.object(Path, 'is_symlink', autospec=True, side_effect=lambda path: path == source):
                self.assertEqual(apt.restore_verified(cache, destination, self.archives()), (0, 0))
            with patch.object(Path, 'is_symlink', return_value=True), self.assertRaises(OSError):
                apt.restore_verified(cache, destination, self.archives())

    def test_plan_uses_empty_archives_without_installing_or_downloading(self):
        digest = self.archives()[self.NAME]['sha256']
        record = f"'https://example.invalid/fixture.deb' {self.NAME} {len(self.DATA)} SHA256:{digest}"
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(apt, 'archive_directory', return_value=Path(temp)/'empty'), \
                patch.object(apt.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, record)) as run, \
                patch.object(apt, 'output') as output:
            apt.plan(Path(temp))
            command = run.call_args.args[0]
            self.assertIn('--print-uris', command)
            self.assertIn('--download-only', command)
            self.assertIn('Acquire::ForceHash=sha256', command)
            self.assertIn(f'Dir::Cache::archives={Path(temp)/"empty"}', command)
            self.assertEqual(json.loads((Path(temp)/'devcel-apt-plan.json').read_text()), self.archives())
            output.assert_called_once_with('key', apt.cache_key(self.archives()))

    def test_plan_failure_is_only_a_cache_miss(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(apt, 'archive_directory', return_value=Path(temp)), \
                patch.object(apt.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'apt-get')), \
                patch.object(apt, 'output') as output:
            apt.plan(Path(temp))
            output.assert_called_once_with('key', '')

    def test_hit_and_missing_plan_both_install_normally(self):
        for hit in (True, False):
            with self.subTest(hit=hit), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                cache = root/'devcel-apt-cache'; cache.mkdir()
                destination = root/'archives'; destination.mkdir()
                if hit:
                    (root/'devcel-apt-plan.json').write_text(json.dumps(self.archives()))
                    (cache/self.NAME).write_bytes(self.DATA)
                with patch.object(apt, 'archive_directory', return_value=destination), \
                        patch.object(apt.subprocess, 'run') as run, \
                        patch.object(apt, 'output') as output:
                    apt.install(root)
                command = run.call_args.args[0]
                self.assertEqual(command[:3], ['sudo', 'apt-get', '-y'])
                self.assertIn(f'Dir::Cache::archives={destination}', command)
                self.assertIn('APT::Keep-Downloaded-Packages=true', command)
                self.assertEqual(command[-len(apt.PACKAGES)-1:], ['install', *apt.PACKAGES])
                run.assert_called_once()
                output.assert_called_once_with('save', 'true' if hit else 'false')

    def test_restore_failure_uses_a_new_empty_archive_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'devcel-apt-plan.json').write_text(json.dumps(self.archives()))
            old = root/'old'; old.mkdir()
            clean = root/'clean'; clean.mkdir()
            with patch.object(apt, 'archive_directory', side_effect=[old, clean]), \
                    patch.object(apt, 'restore_verified', side_effect=OSError('unreadable cache')), \
                    patch.object(apt.subprocess, 'run') as run, patch.object(apt, 'output'):
                apt.install(root)
            self.assertIn(f'Dir::Cache::archives={clean}', run.call_args.args[0])

    def test_cache_save_failure_does_not_fail_successful_installation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'devcel-apt-cache').write_text('not a directory')
            destination = root/'archives'; destination.mkdir()
            with patch.object(apt, 'archive_directory', return_value=destination), \
                    patch.object(apt.subprocess, 'run') as run, patch.object(apt, 'output') as output:
                apt.install(root)
            run.assert_called_once()
            output.assert_called_once_with('save', 'false')

    def test_install_failure_is_not_hidden_by_cache_fallback(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(apt, 'archive_directory', return_value=Path(temp)), \
                patch.object(apt.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'apt-get')), \
                patch.object(apt, 'output') as output:
            with self.assertRaises(subprocess.CalledProcessError):
                apt.install(Path(temp))
            output.assert_not_called()

    def test_workflow_caches_only_downloads_and_always_refreshes_and_installs(self):
        for name in ('ci.yml', 'release.yml'):
            with self.subTest(workflow=name):
                text = (ROOT/'.github/workflows'/name).read_text()
                block = text.split('      - name: Prepare Linux download cache\n', 1)[1].split('      - run: npm ci', 1)[0]
                self.assertLess(block.index('sudo apt-get update'), block.index('ci-apt-cache.py plan'))
                self.assertIn('apt-v1-${{ matrix.os }}-${{ runner.arch }}-', block)
                self.assertIn("hashFiles('scripts/ci-apt-cache.py')", block)
                self.assertIn('${{ steps.apt-plan.outputs.key }}', block)
                self.assertEqual(block.count('path: ${{ runner.temp }}/devcel-apt-cache/*.deb'), 2)
                self.assertEqual(block.count('continue-on-error: true'), 2)
                install = block.split('      - name: Install Linux build dependencies\n', 1)[1].split('      - name:', 1)[0]
                self.assertIn("if: runner.os == 'Linux'\n", install)
                self.assertNotIn("!= 'true'", install)
                self.assertNotIn('/var/lib', block)
                self.assertNotIn('/etc/apt', block)



if __name__ == '__main__':
    unittest.main()
