#!/usr/bin/env python3
"""Publish immutable artifacts from a completed release build without rebuilding."""
from __future__ import annotations
import argparse
import base64
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = '.github/workflows/release.yml'
BUILDS = {'release-Linux': 'build (ubuntu-24.04)', 'release-Windows': 'build (windows-2022)',
          'release-macOS-X64': 'build (macos-15-intel)', 'release-macOS-ARM64': 'build (macos-15)',
          'release-mobile-android': 'mobile (android)', 'release-mobile-ios': 'mobile (ios)',
          'release-mobile-webgl': 'mobile (webgl)'}
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT/'scripts'/name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ci = load('ci-release.py')


def number(value):
    if not re.fullmatch(r'[1-9][0-9]{0,19}', str(value)):
        raise ValueError('A positive decimal run ID and attempt are required')
    return int(value)


def api(repository, suffix, paginate=False):
    args = ('--paginate', '--slurp') if paginate else ()
    return json.loads(ci.run('gh', 'api', *args, 'repos/'+repository+('/'+suffix if suffix else ''), capture=True))


def rows(pages, key):
    if not isinstance(pages, list) or any(not isinstance(p, dict) or not isinstance(p.get(key), list) for p in pages):
        raise ValueError('Incomplete paginated API response')
    return [item for page in pages for item in page[key]]


def stamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Artifact times must have a timezone')
    return result


def tag_identity(repository, tag):
    obj = api(repository, 'git/ref/tags/'+quote(tag, safe=''))['object']
    detail = api(repository, 'commits/refs/tags/'+quote(tag, safe=''))
    commit = detail['sha']
    if obj.get('type') not in ('commit', 'tag') or not SHA.fullmatch(obj.get('sha', '')) or not SHA.fullmatch(commit):
        raise ValueError('Invalid tag identity')
    result = {'object': obj['sha'], 'type': obj['type'], 'commit': commit}
    # A generated package commit changes only importers/unity relative to its source.
    if 'commit' in detail:
        tree = api(repository, 'git/trees/'+detail['commit']['tree']['sha']+'?recursive=1')
        if tree.get('truncated'):
            raise ValueError('Incomplete release tree')
        entries = {e['path']: e for e in tree['tree'] if e.get('type') != 'tree'}
        manifest_path = 'importers/unity/Tools~/manifest.json'
        if manifest_path in entries:
            parents = detail['parents']
            if len(parents) != 1:
                raise ValueError('Git package release requires one source parent')
            source = parents[0]['sha']
            parent = api(repository, 'git/commits/'+source)
            old = api(repository, 'git/trees/'+parent['tree']['sha']+'?recursive=1')
            if old.get('truncated'):
                raise ValueError('Incomplete parent tree')
            outside = lambda e: e['path'] != 'importers/unity' and not e['path'].startswith('importers/unity/') and e.get('type') != 'tree'
            def identity(e):
                return (e.get('mode'), e.get('type'), e.get('sha'))
            current = {e['path']:identity(e) for e in tree['tree'] if outside(e)}
            previous = {e['path']:identity(e) for e in old['tree'] if outside(e)}
            if current != previous:
                raise ValueError('Release commit changes files outside the generated package')
            blob = api(repository, 'contents/'+manifest_path+'?ref='+commit)
            manifest = json.loads(base64.b64decode(blob['content']))
            if manifest.get('source_commit') != source or manifest.get('source_repository') != repository or manifest.get('version') != tag[1:]:
                raise ValueError('Release package provenance mismatch')
            result['source_commit'] = source
    return result


def no_release(repository, tag):
    pages = api(repository, 'releases?per_page=100', True)
    if not isinstance(pages, list) or any(not isinstance(p, list) for p in pages):
        raise ValueError('Incomplete release list')
    if any(r['tag_name'] == tag for p in pages for r in p):
        raise ValueError('An existing draft or published release requires inspection')


def inspect(environment=None, now=None):
    env = os.environ if environment is None else environment
    if env.get('REBUILD_EXISTING_TAG') == 'true' or env.get('REBUILD_COMMIT'):
        raise ValueError('Publication recovery cannot be combined with existing-tag rebuild')
    repository = env['GITHUB_REPOSITORY']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or env.get('GH_REPO') != repository:
        raise ValueError('Recovery repository mismatch')
    repo = api(repository, '')
    if repo.get('full_name', '').lower() != repository.lower() or not isinstance(repo.get('id'), int):
        raise ValueError('Repository identity mismatch')
    branch = repo['default_branch']
    if env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or env.get('GITHUB_REF') != 'refs/heads/'+branch:
        raise ValueError('Recovery must be dispatched on the default branch')
    publisher = ci.checked_commit(env['GITHUB_SHA'])
    ci.run('git', 'diff', '--exit-code', 'HEAD', '--', cwd=ROOT)
    if (env.get('GITHUB_WORKFLOW_REF') != repository+'/'+WORKFLOW+'@refs/heads/'+branch
            or env.get('GITHUB_WORKFLOW_SHA') != publisher):
        raise ValueError('Recovery publisher workflow identity mismatch')
    current = api(repository, 'commits/refs/heads/'+quote(branch, safe='/'))['sha']
    if current != publisher:
        raise ValueError('Default branch moved; dispatch from its current trusted commit')
    run_id, attempt = number(env['RECOVERY_RUN_ID']), number(env['RECOVERY_ATTEMPT'])
    tag = 'v'+env['RELEASE_VERSION']
    if not ci.SEMVER.fullmatch(tag):
        raise ValueError('Invalid recovery version')
    workflow = api(repository, 'actions/workflows/release.yml')
    latest = api(repository, f'actions/runs/{run_id}')
    run = api(repository, f'actions/runs/{run_id}/attempts/{attempt}')
    for value in (latest, run):
        if (value.get('id') != run_id or value.get('run_attempt') != attempt or value.get('status') != 'completed'
                or value.get('repository', {}).get('id') != repo['id']
                or value.get('head_repository', {}).get('id') != repo['id']
                or value.get('path') != WORKFLOW or value.get('workflow_id') != workflow.get('id')):
            raise ValueError('Release run repository/workflow/attempt mismatch or incomplete run')
    if any(run.get(k) != latest.get(k) for k in ('head_sha', 'head_branch', 'event', 'workflow_id')):
        raise ValueError('Release attempt identity changed')
    identity = tag_identity(repository, tag)
    if run['event'] == 'push':
        if run.get('head_branch') != tag or run.get('head_sha') != identity['commit']:
            raise ValueError('Tag build ref or commit mismatch')
    elif run['event'] == 'workflow_dispatch':
        if run.get('head_branch') != branch:
            raise ValueError('Manual build was not dispatched on default branch')
    else:
        raise ValueError('Only verified tag/manual release builds can be recovered')
    if not SHA.fullmatch(run.get('head_sha', '')):
        raise ValueError('Invalid original run commit')
    jobs = rows(api(repository, f'actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100', True), 'jobs')
    required = ['validate', *BUILDS.values()]
    if run['event'] == 'workflow_dispatch':
        required += ['prepare_manual', 'create_tag']
    selected = {}
    for name in required:
        matches = [j for j in jobs if j.get('name') == name]
        if (len(matches) != 1 or matches[0].get('status') != 'completed' or matches[0].get('conclusion') != 'success'
                or matches[0].get('run_id') != run_id or matches[0].get('run_attempt') != attempt
                or matches[0].get('head_sha') != run['head_sha']):
            raise ValueError('Required release job missing, duplicated, failed or from another attempt: '+name)
        selected[name] = matches[0]
    artifacts = rows(api(repository, f'actions/runs/{run_id}/artifacts?per_page=100', True), 'artifacts')
    if any(a.get('name', '').startswith('release-') and a['name'] not in BUILDS for a in artifacts):
        raise ValueError('Unexpected release artifact set')
    pinned = []
    now = datetime.now(timezone.utc) if now is None else now
    for name, job_name in BUILDS.items():
        matches = [a for a in artifacts if a.get('name') == name]
        if len(matches) != 1:
            raise ValueError('Missing or duplicate release artifact: '+name)
        artifact = matches[0]
        job = selected[job_name]
        scope = artifact.get('workflow_run', {})
        if (artifact.get('expired') is not False or not DIGEST.fullmatch(artifact.get('digest', ''))
                or not isinstance(artifact.get('size_in_bytes'), int) or artifact['size_in_bytes'] <= 0
                or scope.get('id') != run_id or scope.get('repository_id') != repo['id']
                or scope.get('head_repository_id') != repo['id'] or scope.get('head_sha') != run['head_sha']
                or not stamp(job['started_at']) <= stamp(artifact['created_at']) <= stamp(artifact['updated_at']) <= stamp(job['completed_at'])
                or stamp(artifact['expires_at']) <= now):
            raise ValueError('Artifact expiry/digest/commit/attempt scope mismatch: '+name)
        pinned.append({k: artifact[k] for k in ('id', 'name', 'digest', 'size_in_bytes', 'created_at', 'updated_at', 'expires_at')})
        number(artifact['id'])
    if len({a['id'] for a in pinned}) != len(BUILDS):
        raise ValueError('Release artifact identities must be distinct')
    no_release(repository, tag)
    return {'repository': repository, 'repository_id': repo['id'], 'publisher': publisher,
            'default_branch': branch, 'run_id': run_id, 'attempt': attempt,
            'event': run['event'], 'run_head': run['head_sha'], 'tag': tag,
            'tag_identity': identity, 'commit': identity.get('source_commit', identity['commit']), 'artifacts': pinned}


def plan_path():
    path = Path(os.environ['RUNNER_TEMP'])/'devcel-release-recovery.json'
    if path.is_symlink() or path.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError('Recovery state must be outside the source repository')
    return path


def prepare():
    plan = inspect()
    plan_path().write_text(json.dumps(plan), encoding='utf-8')
    with Path(os.environ['GITHUB_OUTPUT']).open('a', encoding='utf-8', newline='\n') as output:
        for key, value in {'tag': plan['tag'], 'commit': plan['commit'], 'run_id': plan['run_id'],
                           'artifact_ids': ','.join(str(a['id']) for a in plan['artifacts'])}.items():
            output.write(f'{key}={value}\n')


def publish():
    plan = json.loads(plan_path().read_text(encoding='utf-8'))
    if inspect() != plan:
        raise ValueError('Recovery provenance changed after artifact selection')
    source = ROOT/'release-source'
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Immutable source checkout missing or linked')
    ci.checked_commit(plan['commit'], root=source)
    if ci.run('git', 'status', '--porcelain', '--untracked-files=normal', cwd=source, capture=True).strip():
        raise ValueError('Immutable source checkout is dirty')
    if plan['event'] == 'workflow_dispatch':
        ci.run('git', 'merge-base', '--is-ancestor', plan['run_head'], plan['commit'], cwd=source)
    ci.validate(plan['tag'], root=source)
    load('generate-third-party-notices.py').generate(source, ensure=True)
    load('generate-third-party-notices.py').verify_locks(source)
    def source_unchanged():
        ci.checked_commit(plan['commit'], root=source)
        if ci.run('git', 'status', '--porcelain', '--untracked-files=normal', cwd=source, capture=True).strip():
            raise ValueError('Immutable source checkout changed')
    def before_create():
        source_unchanged()
        if inspect() != plan:
            raise ValueError('Recovery provenance changed before release creation')
    def before_publish():
        source_unchanged()
        if tag_identity(plan['repository'], plan['tag']) != plan['tag_identity']:
            raise ValueError('Release tag changed before publication')
    os.environ['RELEASE_TAG'] = plan['tag']
    os.environ['SOURCE_COMMIT'] = plan['commit']
    ci.publish(source_root=source, before_create=before_create, before_publish=before_publish)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'publish'))
    args = parser.parse_args()
    globals()[args.command]()
