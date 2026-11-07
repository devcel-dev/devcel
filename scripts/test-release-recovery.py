#!/usr/bin/env python3
"""Release recovery provenance, immutable source, and fail-closed publication tests."""
import copy
import base64
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release_recovery', HERE/'release_recovery.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
A, B, T = 'a'*40, 'b'*40, 'e'*40
NOW = datetime(2026, 1, 2, tzinfo=timezone.utc)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.env = {'GITHUB_REPOSITORY': 'owner/repo', 'GH_REPO': 'owner/repo',
                    'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
                    'GITHUB_SHA': B, 'GITHUB_WORKFLOW_SHA': B,
                    'GITHUB_WORKFLOW_REF': 'owner/repo/'+r.WORKFLOW+'@refs/heads/main', 'RECOVERY_RUN_ID': '123', 'RECOVERY_ATTEMPT': '2', 'RELEASE_VERSION': '0.1.0'}
        self.repo = {'id': 1, 'full_name': 'owner/repo', 'default_branch': 'main'}
        self.run = {'id': 123, 'run_attempt': 2, 'status': 'completed', 'event': 'push',
                    'head_sha': A, 'head_branch': 'v0.1.0', 'path': r.WORKFLOW, 'workflow_id': 10,
                    'repository': {'id': 1}, 'head_repository': {'id': 1}}
        self.latest = copy.deepcopy(self.run)
        self.jobs = [{'id': i, 'name': name, 'run_id': 123, 'run_attempt': 2, 'head_sha': A,
                      'status': 'completed', 'conclusion': 'success',
                      'started_at': '2026-01-01T00:00:00Z', 'completed_at': '2026-01-01T00:02:00Z'}
                     for i, name in enumerate(('validate', *r.BUILDS.values()), 1)]
        self.artifacts = [{'id': i, 'name': name, 'digest': 'sha256:'+format(i, '064x'), 'size_in_bytes': 100,
                           'expired': False, 'created_at': '2026-01-01T00:01:00Z',
                           'updated_at': '2026-01-01T00:01:01Z', 'expires_at': '2030-01-01T00:00:00Z',
                           'workflow_run': {'id': 123, 'repository_id': 1, 'head_repository_id': 1, 'head_sha': A}}
                          for i, name in enumerate(r.BUILDS, 5)]
        self.tag = {'object': {'type': 'tag', 'sha': T}}
        self.releases = [[]]
        self.calls = []

    def api(self, repository, suffix, paginate=False):
        self.assertEqual(repository, 'owner/repo')
        self.calls.append(suffix)
        data = {'': self.repo, 'commits/refs/heads/main': {'sha': B},
                'actions/workflows/release.yml': {'id': 10}, 'actions/runs/123': self.latest,
                'actions/runs/123/attempts/2': self.run,
                'git/ref/tags/v0.1.0': self.tag, 'commits/refs/tags/v0.1.0': {'sha': A},
                'actions/runs/123/attempts/2/jobs?per_page=100': [{'jobs': self.jobs}],
                'actions/runs/123/artifacts?per_page=100': [{'artifacts': self.artifacts}],
                'releases?per_page=100': self.releases}
        return copy.deepcopy(data[suffix])

    def inspect(self):
        with patch.object(r, 'api', side_effect=self.api), patch.object(r.ci, 'run', return_value=''), patch.object(r.ci, 'checked_commit', return_value=B):
            return r.inspect(self.env, NOW)

    def test_exact_build_artifacts_are_pinned_to_distinct_publisher_and_source(self):
        plan = self.inspect()
        self.assertEqual((plan['publisher'], plan['commit']), (B, A))
        self.assertEqual([a['id'] for a in plan['artifacts']], [5, 6, 7, 8, 9, 10, 11])
        self.assertEqual(plan['tag_identity'], {'object': T, 'type': 'tag', 'commit': A})
        self.assertIn('actions/runs/123/attempts/2/jobs?per_page=100', self.calls)

    def test_lightweight_tags_are_supported(self):
        self.tag = {'object': {'type': 'commit', 'sha': A}}
        self.assertEqual(self.inspect()['tag_identity']['object'], A)

    def test_normal_release_tag_resolves_exact_source_parent_and_rejects_source_changes(self):
        entry = {'path':'source', 'mode':'100644', 'type':'blob', 'sha':'c'*40}
        data = {
            'git/ref/tags/v0.1.0': {'object':{'type':'commit','sha':T}},
            'commits/refs/tags/v0.1.0': {'sha':T,'parents':[{'sha':A}], 'commit':{'tree':{'sha':'d'*40}}},
            'git/trees/'+'d'*40+'?recursive=1': {'tree':[entry, {'path':'importers/unity/Tools~/manifest.json','mode':'100644','type':'blob','sha':'f'*40}]},
            'git/commits/'+A: {'tree':{'sha':'1'*40}},
            'git/trees/'+'1'*40+'?recursive=1': {'tree':[entry]},
            'contents/importers/unity/Tools~/manifest.json?ref='+T: {'content':base64.b64encode(json.dumps({
                'source_commit':A,'source_repository':'owner/repo','version':'0.1.0'}).encode()).decode()}}
        with patch.object(r, 'api', side_effect=lambda repo, suffix: data[suffix]):
            self.assertEqual(r.tag_identity('owner/repo','v0.1.0')['source_commit'], A)
            data['git/trees/'+'1'*40+'?recursive=1']['tree'] = [dict(entry, sha='2'*40)]
            with self.assertRaisesRegex(ValueError, 'outside'):
                r.tag_identity('owner/repo','v0.1.0')

    def test_manual_preparation_does_not_assume_run_head_is_built_commit(self):
        for item in (self.run, self.latest):
            item.update(event='workflow_dispatch', head_branch='main', head_sha='c'*40)
        for job in self.jobs:
            job['head_sha'] = 'c'*40
        for name in ('prepare_manual', 'create_tag'):
            self.jobs.append(dict(self.jobs[0], name=name))
        for item in self.artifacts:
            item['workflow_run']['head_sha'] = 'c'*40
        plan = self.inspect()
        self.assertEqual((plan['run_head'], plan['commit']), ('c'*40, A))

    def test_invalid_dispatch_context_is_rejected(self):
        for key, value in [('GH_REPO', 'other/repo'), ('GITHUB_REF', 'refs/heads/feature'),
                           ('GITHUB_EVENT_NAME', 'push'), ('GITHUB_WORKFLOW_SHA', A),
                           ('GITHUB_WORKFLOW_REF', 'owner/repo/other.yml@refs/heads/main'), ('RECOVERY_RUN_ID', '../123'),
                           ('RECOVERY_ATTEMPT', ''), ('RELEASE_VERSION', '0.1.0/other'),
                           ('REBUILD_EXISTING_TAG', 'true'), ('REBUILD_COMMIT', A)]:
            with self.subTest(key=key), patch.dict(self.env, {key: value}):
                with self.assertRaises(ValueError): self.inspect()

    def test_untrusted_publisher_commit_is_rejected(self):
        with patch.dict(self.env, {'GITHUB_WORKFLOW_SHA': A}), patch.object(r, 'api', side_effect=self.api), patch.object(r.ci, 'run', return_value=''), patch.object(r.ci, 'checked_commit', return_value=A):
            with self.assertRaisesRegex(ValueError, 'Default branch moved'): r.inspect(self.env, NOW)

    def test_wrong_repository_workflow_event_ref_commit_attempt_or_status_is_rejected(self):
        cases = [('repository', {'id': 2}), ('head_repository', {'id': 2}), ('path', '.github/workflows/ci.yml'),
                 ('workflow_id', 11), ('event', 'pull_request'), ('head_branch', 'main'),
                 ('head_sha', B), ('run_attempt', 1), ('status', 'in_progress')]
        for key, value in cases:
            with self.subTest(key=key):
                old, latest = copy.deepcopy(self.run), copy.deepcopy(self.latest)
                self.run[key] = self.latest[key] = value
                with self.assertRaises(ValueError): self.inspect()
                self.run, self.latest = old, latest

    def test_later_attempt_is_not_mixed_with_prior_artifacts(self):
        self.latest['run_attempt'] = 3
        with self.assertRaises(ValueError): self.inspect()

    def test_required_jobs_must_be_unique_successful_and_same_attempt(self):
        for change in ('missing', 'duplicate', 'failure', 'attempt', 'commit'):
            with self.subTest(change=change):
                before = copy.deepcopy(self.jobs)
                if change == 'missing': self.jobs.pop()
                elif change == 'duplicate': self.jobs.append(copy.deepcopy(self.jobs[-1]))
                elif change == 'failure': self.jobs[-1]['conclusion'] = 'failure'
                elif change == 'attempt': self.jobs[-1]['run_attempt'] = 1
                else: self.jobs[-1]['head_sha'] = B
                with self.assertRaises(ValueError): self.inspect()
                self.jobs = before

    def test_missing_duplicate_expired_wrong_digest_or_attempt_artifacts_are_rejected(self):
        cases = [('expired', True), ('digest', ''), ('size_in_bytes', 0),
                 ('created_at', '2025-12-31T00:00:00Z'), ('updated_at', '2026-01-02T00:00:00Z'),
                 ('expires_at', '2026-01-01T00:00:00Z'),
                 ('workflow_run', {'id': 123, 'repository_id': 1, 'head_repository_id': 1, 'head_sha': B})]
        for key, value in cases:
            with self.subTest(key=key):
                before = copy.deepcopy(self.artifacts)
                self.artifacts[0][key] = value
                with self.assertRaises(ValueError): self.inspect()
                self.artifacts = before
        for mode in ('missing', 'duplicate', 'extra'):
            with self.subTest(mode=mode):
                before = copy.deepcopy(self.artifacts)
                if mode == 'missing': self.artifacts.pop()
                else: self.artifacts.append(dict(self.artifacts[-1], name='release-Other') if mode == 'extra' else self.artifacts[-1])
                with self.assertRaises(ValueError): self.inspect()
                self.artifacts = before

    def test_draft_and_published_release_stop_recovery(self):
        for draft in (True, False):
            self.releases = [[{'tag_name': 'v0.1.0', 'draft': draft}]]
            with self.assertRaisesRegex(ValueError, 'existing draft or published'): self.inspect()

    def test_api_failure_is_not_absence(self):
        with patch.object(r, 'api', side_effect=RuntimeError('unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'unavailable'): r.inspect(self.env, NOW)

    def test_source_checkout_remains_independent_and_all_final_guards_are_called(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root/'release-source'; source.mkdir()
            plan = self.inspect(); path = root/'plan.json'; path.write_text(json.dumps(plan))
            with patch.object(r, 'ROOT', root), patch.object(r, 'plan_path', return_value=path), \
                 patch.object(r, 'inspect', return_value=plan), patch.object(r.ci, 'checked_commit') as checked, \
                 patch.object(r.ci, 'run', return_value='') as command, patch.object(r.ci, 'validate') as validate, \
                 patch.object(r, 'load') as notices, patch.object(r, 'tag_identity', return_value=plan['tag_identity']), \
                 patch.dict(os.environ), patch.object(r.ci, 'publish') as publish:
                r.publish()
                checked.assert_called_once_with(A, root=source)
                validate.assert_called_once_with('v0.1.0', root=source)
                notices.return_value.verify_locks.assert_called_once_with(source)
                kwargs = publish.call_args.kwargs
                self.assertEqual(kwargs['source_root'], source)
                kwargs['before_create'](); kwargs['before_publish']()
                self.assertEqual(checked.call_count, 3)
                self.assertFalse(any(c.args[0] in ('cargo', 'node', 'npm') for c in command.call_args_list))

    def test_provenance_change_or_dirty_source_prevents_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root/'release-source').mkdir()
            plan = self.inspect(); path = root/'plan.json'; path.write_text(json.dumps(plan))
            for changed, dirty in ((True, ''), (False, ' M Cargo.toml')):
                with self.subTest(changed=changed), patch.object(r, 'ROOT', root), \
                     patch.object(r, 'plan_path', return_value=path), \
                     patch.object(r, 'inspect', return_value={} if changed else plan), \
                     patch.object(r.ci, 'checked_commit'), patch.object(r.ci, 'run', return_value=dirty), \
                     patch.object(r.ci, 'publish') as publish:
                    with self.assertRaises(ValueError): r.publish()
                    publish.assert_not_called()

    def test_preparation_writes_only_pinned_ids_and_source_outputs_outside_repository(self):
        plan = self.inspect()
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)/'outputs'
            with patch.dict(os.environ, {'RUNNER_TEMP': temp, 'GITHUB_OUTPUT': str(output)}), \
                 patch.object(r, 'inspect', return_value=plan):
                r.prepare()
                self.assertEqual(json.loads(r.plan_path().read_text()), plan)
            self.assertEqual(output.read_text().splitlines(),
                             ['tag=v0.1.0', 'commit='+A, 'run_id=123', 'artifact_ids=5,6,7,8,9,10,11'])
        with patch.dict(os.environ, {'RUNNER_TEMP': str(r.ROOT)}):
            with self.assertRaisesRegex(ValueError, 'outside'): r.plan_path()

    def test_api_uses_explicit_repository_and_keeps_pagination(self):
        with patch.object(r.ci, 'run', return_value='{}') as command:
            r.api('owner/repo', '')
            command.assert_called_once_with('gh','api','repos/owner/repo',capture=True)
        with patch.object(r.ci, 'run', return_value='[]') as command:
            r.api('owner/repo', 'actions/runs/123/artifacts?per_page=100', True)
            command.assert_called_once_with('gh','api','--paginate','--slurp',
                                           'repos/owner/repo/actions/runs/123/artifacts?per_page=100',capture=True)
        with self.assertRaises(ValueError): r.rows({'jobs': []}, 'jobs')

    def test_workflow_has_no_build_version_or_tag_operations_in_recovery(self):
        text = (HERE.parent/'.github/workflows/release.yml').read_text(encoding='utf-8')
        recovery = text.split('  recover_publication:', 1)[1]
        self.assertIn('actions: read', recovery)
        self.assertNotIn('actions: write', recovery)
        self.assertIn('artifact-ids: ${{ steps.recovery.outputs.artifact_ids }}', recovery)
        self.assertIn('digest-mismatch: error', recovery)
        self.assertIn('path: release-source', recovery)
        self.assertIn('ref: ${{ github.sha }}', recovery)
        for forbidden in ('ci-release.py package', 'create_tag', 'prepare_manual_release', 'npm ci', 'cargo build'):
            self.assertNotIn(forbidden, recovery)
        self.assertIn('group: release-main', text)
        self.assertIn('!inputs.recovery_run_id && !inputs.recovery_attempt', text)


    def test_source_version_or_license_failure_stops_before_publisher(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root/'release-source').mkdir()
            plan = self.inspect(); path = root/'plan.json'; path.write_text(json.dumps(plan))
            for stage in ('version', 'license'):
                with self.subTest(stage=stage), patch.object(r, 'ROOT', root), \
                     patch.object(r, 'plan_path', return_value=path), patch.object(r, 'inspect', return_value=plan), \
                     patch.object(r.ci, 'checked_commit'), patch.object(r.ci, 'run', return_value=''), \
                     patch.object(r.ci, 'validate', side_effect=ValueError('version') if stage == 'version' else None), \
                     patch.object(r, 'load') as notices, patch.object(r.ci, 'publish') as publish:
                    notices.return_value.verify_locks.side_effect = ValueError('license')
                    with self.assertRaisesRegex(ValueError, stage): r.publish()
                    publish.assert_not_called()

    def test_tag_object_or_commit_race_stops_final_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root/'release-source').mkdir()
            plan = self.inspect(); path = root/'plan.json'; path.write_text(json.dumps(plan))
            for identity in (dict(plan['tag_identity'], object=B), dict(plan['tag_identity'], commit=B)):
                with self.subTest(identity=identity), patch.object(r, 'ROOT', root), \
                     patch.object(r, 'plan_path', return_value=path), patch.object(r, 'inspect', return_value=plan), \
                     patch.object(r.ci, 'checked_commit'), patch.object(r.ci, 'run', return_value=''), \
                     patch.object(r.ci, 'validate'), patch.object(r, 'load'), \
                     patch.object(r, 'tag_identity', return_value=identity), patch.object(r.ci, 'publish') as publish:
                    r.publish()
                    with self.assertRaisesRegex(ValueError, 'tag changed'):
                        publish.call_args.kwargs['before_publish']()

    def test_draft_or_artifact_race_is_rechecked_immediately_before_creation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root/'release-source').mkdir()
            plan = self.inspect(); path = root/'plan.json'; path.write_text(json.dumps(plan))
            with patch.object(r, 'ROOT', root), patch.object(r, 'plan_path', return_value=path), \
                 patch.object(r, 'inspect', return_value=plan) as inspect, patch.object(r.ci, 'checked_commit'), \
                 patch.object(r.ci, 'run', return_value=''), patch.object(r.ci, 'validate'), \
                 patch.object(r, 'load'), patch.object(r.ci, 'publish') as publish:
                r.publish()
                for result in (ValueError('existing draft'), {}):
                    inspect.side_effect = result if isinstance(result, Exception) else None
                    inspect.return_value = result
                    with self.assertRaises(ValueError): publish.call_args.kwargs['before_create']()


class PublisherSourceTests(unittest.TestCase):
    def git(self, root, *args):
        return subprocess.check_output(['git', *args], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()

    def test_real_different_git_checkouts_preserve_source_commit_and_index_context(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); publisher = root/'publisher'; source = root/'source'
            for directory in (publisher, source):
                directory.mkdir(); self.git(directory, 'init', '-q')
                (directory/'identity').write_text(directory.name)
                self.git(directory, 'add', 'identity')
                self.git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', directory.name)
            commit = self.git(source, 'rev-parse', 'HEAD')
            self.assertNotEqual(commit, self.git(publisher, 'rev-parse', 'HEAD'))
            output = publisher/'release-publish'; output.mkdir()
            (output/'SOURCE-ACCESS.json').write_text('{}')
            (output/'SHA256SUMS.txt').write_text('fixture')
            real = r.ci.run; calls = []
            def command(*args, **kwargs):
                if args[0] == 'git': return real(*args, **kwargs)
                calls.append(args)
                if args[:2] == ('gh', 'api'):
                    if 'commits/refs/tags/' in args[2]: return commit
                    if '--slurp' in args: return '[[]]'
                    return '{"full_name":"owner/repo","visibility":"private"}'
            with patch.object(r.ci, 'ROOT', publisher), patch.object(r.ci, 'run', side_effect=command), \
                 patch.dict(os.environ, {'GH_REPO':'owner/repo', 'RELEASE_TAG':'v0.1.0', 'SOURCE_COMMIT':commit,
                                         'PRODUCT_RELEASE_NOTES':'', 'PRODUCT_RELEASE_NOTES_VERSION':''}), \
                 patch.object(r.ci, 'validate') as validate, patch.object(r.ci, 'collect_assets', return_value=['asset']), \
                 patch.object(r.ci.release_source, 'validate_index') as index, \
                 patch.object(r.ci.release_source, 'source_index', return_value={}) as description, \
                 patch.object(r.ci.release_source, 'source_notes', return_value='Source directions'):
                r.ci.publish(source_root=source)
                validate.assert_called_once_with('v0.1.0', root=source.resolve())
                index.assert_called_once_with(output/'SOURCE-ACCESS.json','owner/repo',commit,'v0.1.0',source.resolve())
                description.assert_called_once_with('owner/repo',commit,'v0.1.0',source.resolve())
                self.assertEqual(calls[-1], ('gh','release','edit','v0.1.0','--draft=false'))
                with patch.dict(os.environ, {'SOURCE_COMMIT': self.git(publisher, 'rev-parse', 'HEAD')}):
                    with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                        r.ci.publish(source_root=source)

    def test_failed_recovery_callbacks_never_create_or_publish(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); out = root/'release-publish'; out.mkdir()
            (out/'SOURCE-ACCESS.json').write_text('{}'); (out/'SHA256SUMS.txt').write_text('fixture')
            def fail(): raise ValueError('recovery guard')
            for stage in ('before_create', 'before_publish'):
                calls = []
                def command(*args, **kwargs):
                    calls.append(args)
                    if 'commits/refs/tags/' in str(args): return A
                    if '--slurp' in args: return '[[]]'
                    if args[:3] == ('gh','api','repos/{owner}/{repo}'):
                        return '{"full_name":"owner/repo","visibility":"private"}'
                with self.subTest(stage=stage), patch.object(r.ci, 'ROOT', root), \
                     patch.dict(os.environ, {'GH_REPO':'owner/repo','RELEASE_TAG':'v0.1.0','SOURCE_COMMIT':A,
                                             'PRODUCT_RELEASE_NOTES':'','PRODUCT_RELEASE_NOTES_VERSION':''}), \
                     patch.object(r.ci, 'run', side_effect=command), patch.object(r.ci, 'validate'), \
                     patch.object(r.ci, 'checked_commit', return_value=A), \
                     patch.object(r.ci, 'collect_assets', return_value=['asset']), \
                     patch.object(r.ci.release_source, 'validate_index'), \
                     patch.object(r.ci.release_source, 'source_index', return_value={}), \
                     patch.object(r.ci.release_source, 'source_notes', return_value='source'):
                    with self.assertRaisesRegex(ValueError, 'recovery guard'):
                        r.ci.publish(**{stage: fail})
                    self.assertFalse(any('--draft=false' in c for c in calls))
                    if stage == 'before_create': self.assertFalse(any(c[:3] == ('gh','release','create') for c in calls))


if __name__ == '__main__': unittest.main()
