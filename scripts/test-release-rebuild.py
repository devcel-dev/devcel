#!/usr/bin/env python3
"""Existing-tag rebuild must preserve source and trusted workflow identities."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import release_rebuild as r

A, B, T = 'a'*40, 'b'*40, 'c'*40


class RebuildTests(unittest.TestCase):
    def setUp(self):
        self.env = {'GITHUB_REPOSITORY': 'owner/repo', 'GH_REPO': 'owner/repo',
                    'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
                    'GITHUB_SHA': B, 'GITHUB_WORKFLOW_SHA': B,
                    'GITHUB_WORKFLOW_REF': 'owner/repo/.github/workflows/release.yml@refs/heads/main',
                    'REBUILD_EXISTING_TAG': 'true', 'REBUILD_COMMIT': A, 'RELEASE_VERSION': '1.2.3'}
        self.responses = {'': {'full_name': 'owner/repo', 'default_branch': 'main'},
                          'commits/refs/heads/main': {'sha': B},
                          'git/ref/tags/v1.2.3': {'object': {'type': 'tag', 'sha': T}},
                          'commits/refs/tags/v1.2.3': {'sha': A}, 'releases?per_page=100': [[]]}

    def api(self, repository, suffix, paginate=False):
        self.assertEqual(repository, 'owner/repo')
        return copy.deepcopy(self.responses[suffix])

    def inspect(self):
        with patch.object(r.recovery, 'api', side_effect=self.api), \
             patch.object(r.ci, 'checked_commit', return_value=B), patch.object(r.ci, 'run'):
            return r.inspect(self.env)

    def test_trusted_main_selects_exact_existing_commit_without_mutating_refs(self):
        with patch.object(r.recovery, 'api', side_effect=self.api), \
             patch.object(r.ci, 'checked_commit', return_value=B), patch.object(r.ci, 'run') as run:
            plan = r.inspect(self.env)
            self.assertEqual((plan['publisher'], plan['commit'], plan['tag_identity']['object']), (B, A, T))
            run.assert_called_once_with('git', 'diff', '--exit-code', 'HEAD', '--', cwd=r.ROOT)

    def test_wrong_mode_context_version_or_expected_commit_is_rejected(self):
        for key, value in [('REBUILD_EXISTING_TAG', 'false'), ('REBUILD_COMMIT', ''),
                           ('REBUILD_COMMIT', B), ('RECOVERY_RUN_ID', '123'), ('RECOVERY_ATTEMPT', '1'),
                           ('GITHUB_EVENT_NAME', 'push'), ('GITHUB_REF', 'refs/tags/v1.2.3'),
                           ('GITHUB_WORKFLOW_SHA', A), ('GITHUB_WORKFLOW_REF', 'owner/repo/other.yml@refs/heads/main'),
                           ('GH_REPO', 'other/repo'), ('RELEASE_VERSION', '../1.2.3')]:
            with self.subTest(key=key), patch.dict(self.env, {key: value}):
                with self.assertRaises(ValueError):
                    self.inspect()

    def test_main_or_tag_movement_and_existing_release_are_rejected(self):
        cases = [('commits/refs/heads/main', {'sha': A}),
                 ('commits/refs/tags/v1.2.3', {'sha': B}),
                 ('releases?per_page=100', [[{'tag_name': 'v1.2.3', 'draft': True}]]),
                 ('releases?per_page=100', [[{'tag_name': 'v1.2.3', 'draft': False}]])]
        for key, value in cases:
            with self.subTest(key=key), patch.dict(self.responses, {key: value}):
                with self.assertRaises(ValueError): self.inspect()

    def test_release_branch_source_allowed_but_api_failure_is_not_ignored(self):
        def reject_ancestry(*args, **kwargs):
            if args[:2] == ('git', 'merge-base'):
                raise subprocess.CalledProcessError(1, ['git', 'merge-base'])
            return ''
        with patch.object(r.recovery, 'api', side_effect=self.api), \
             patch.object(r.ci, 'checked_commit', return_value=B), \
             patch.object(r.ci, 'run', side_effect=reject_ancestry):
            self.assertEqual(r.inspect(self.env)['commit'], A)
        with patch.object(r.recovery, 'api', side_effect=RuntimeError('offline')):
            with self.assertRaisesRegex(RuntimeError, 'offline'): r.inspect(self.env)

    def test_source_verification_preserves_version_license_and_clean_tree_guards(self):
        plan = self.inspect()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root/'release-source'; source.mkdir()
            path = root/'plan.json'; path.write_text(json.dumps(plan))
            with patch.object(r, 'ROOT', root), patch.object(r, 'plan_path', return_value=path), \
                 patch.object(r, 'inspect', return_value=plan), patch.object(r.ci, 'checked_commit') as checked, \
                 patch.object(r.ci, 'run', return_value='') as command, patch.object(r.ci, 'validate') as validate, \
                 patch.object(r.recovery, 'load') as notices, patch.object(r, 'require_build_recipe') as recipe:
                r.verify()
                checked.assert_called_once_with(A, root=source)
                recipe.assert_called_once_with(source)
                validate.assert_called_once_with('v1.2.3', root=source)
                notices.return_value.verify_locks.assert_called_once_with(source)
                command.return_value = ' M Cargo.toml'
                with self.assertRaisesRegex(ValueError, 'dirty'): r.verify()
            changed = dict(plan, tag_identity={'object': 'd'*40, 'type': 'tag', 'commit': A})
            with patch.object(r, 'plan_path', return_value=path), patch.object(r, 'inspect', return_value=changed):
                with self.assertRaisesRegex(ValueError, 'identity changed'): r.verify()

    def test_old_build_recipe_is_rejected_without_executing_source(self):
        import shutil
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            with patch.object(r.ci, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'unsupported build recipe'):
                    r.require_build_recipe(source)
                run.assert_not_called()
            r.require_build_recipe(r.ROOT)
            (source/'scripts').mkdir()
            shutil.copyfile(r.ROOT/'scripts/ci-release.py', source/'scripts/ci-release.py')
            (source/'scripts/ci-release.py').write_text('raise RuntimeError("must never execute")')
            with self.assertRaisesRegex(ValueError, 'unsupported build recipe'):
                r.require_build_recipe(source)

    def test_rebuild_workflow_does_not_prepare_versions_or_create_tags(self):
        workflow = (r.ROOT/'.github/workflows/release.yml').read_text()
        for name in ('prepare_manual', 'create_tag'):
            block = workflow.split('  '+name+':\n', 1)[1].split('    runs-on:', 1)[0]
            self.assertIn('!inputs.rebuild_existing_tag', block)
        self.assertIn('timeout-minutes: 240', workflow)
        self.assertIn('python scripts/release_rebuild.py prepare', workflow)
        self.assertIn('python scripts/release_rebuild.py verify', workflow)
        self.assertIn('ref: ${{ needs.validate.outputs.commit }}', workflow)

    def test_expected_rebuild_commit_cannot_enter_normal_version_preparation(self):
        with patch.dict(r.os.environ, {'REBUILD_COMMIT': A}), patch.object(r.ci, 'run') as command:
            with self.assertRaisesRegex(ValueError, 'requires existing-tag'):
                r.ci.prepare_manual_release()
            command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
