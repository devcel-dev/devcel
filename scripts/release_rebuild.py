#!/usr/bin/env python3
"""Resolve an unpublished existing tag from a trusted default-branch workflow."""
import argparse
import json
import os
import re
from pathlib import Path

import release_recovery as recovery

ROOT = Path(__file__).resolve().parents[1]
ci = recovery.ci


def inspect(environment=None):
    env = os.environ if environment is None else environment
    if env.get('REBUILD_EXISTING_TAG') != 'true' or env.get('RECOVERY_RUN_ID') or env.get('RECOVERY_ATTEMPT'):
        raise ValueError('Existing-tag rebuild cannot be combined with publication recovery')
    repository = env['GITHUB_REPOSITORY']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or env.get('GH_REPO') != repository:
        raise ValueError('Rebuild repository mismatch')
    repo = recovery.api(repository, '')
    if repo.get('full_name', '').lower() != repository.lower() or repo.get('default_branch') != 'main':
        raise ValueError('Rebuild requires this repository default branch main')
    if env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or env.get('GITHUB_REF') != 'refs/heads/main':
        raise ValueError('Rebuild must be dispatched on main')
    publisher = ci.checked_commit(env['GITHUB_SHA'])
    if (env.get('GITHUB_WORKFLOW_SHA') != publisher or
            env.get('GITHUB_WORKFLOW_REF') != repository+'/'+recovery.WORKFLOW+'@refs/heads/main'):
        raise ValueError('Untrusted rebuild workflow identity')
    ci.run('git', 'diff', '--exit-code', 'HEAD', '--', cwd=ROOT)
    if recovery.api(repository, 'commits/refs/heads/main')['sha'] != publisher:
        raise ValueError('Main moved; dispatch from current main')
    tag = 'v'+env.get('RELEASE_VERSION', '')
    expected = env.get('REBUILD_COMMIT', '')
    if not ci.SEMVER.fullmatch(tag) or not recovery.SHA.fullmatch(expected):
        raise ValueError('Rebuild requires a version and its full expected commit SHA')
    identity = recovery.tag_identity(repository, tag)
    if identity['commit'] != expected:
        raise ValueError('Existing tag differs from the expected source commit')
    recovery.no_release(repository, tag)
    return {'repository': repository, 'publisher': publisher, 'tag': tag,
            'commit': identity.get('source_commit', expected), 'tag_identity': identity}


def plan_path():
    path = Path(os.environ['RUNNER_TEMP'])/'devcel-release-rebuild.json'
    if path.is_symlink() or path.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError('Rebuild plan must be outside the source checkout')
    return path


def prepare():
    plan = inspect()
    plan_path().write_text(json.dumps(plan), encoding='utf-8')
    ci.emit_release(plan['tag'], plan['commit'])


def require_build_recipe(source, trusted=ROOT):
    """Never execute an older tag's unreviewed build helpers to rebuild it."""
    recipes = (
        'scripts/ci-release.py', 'scripts/studio_cli.py', 'scripts/package-importers.py',
        'scripts/unity_upm.py', 'scripts/unity_mobile.py', 'scripts/unity_toolchain.py',
        'scripts/unity_git_package.py',
        '.github/actions/build-unity-mobile/action.yml',
        'scripts/package-windows-studio.py', 'scripts/tauri-release.conf.json',
        'scripts/debian_version.py', 'scripts/legal_distribution.py',
        'scripts/generate-third-party-notices.py', 'scripts/release_privacy.py',
        'scripts/product_version.py', 'scripts/importer_versions.py', 'scripts/bundled_plugin_versions.py',
        'devcel-studio/vite.config.ts', 'devcel-studio/scripts/catalog-chunks.mjs',
        'devcel-studio/scripts/bundled-plugin-versions.mjs',
        'devcel-studio/scripts/sync-plugin-sdk.js', 'devcel-studio/src-tauri/build.rs',
    )
    for name in recipes:
        path = source/name
        if path.is_symlink() or not path.is_file() or path.read_text(encoding='utf-8') != (trusted/name).read_text(encoding='utf-8'):
            raise ValueError('Existing tag has an unsupported build recipe: '+name+
                             '; old source will not be rebuilt by build-only CI')
    # Version fields may differ; only build entry points must match trusted main.
    for name, key in (('devcel-studio/package.json', 'scripts'),
                      ('devcel-studio/src-tauri/tauri.conf.json', 'build')):
        path = source/name
        if path.is_symlink() or not path.is_file() or json.loads(path.read_text(encoding='utf-8'))[key] != json.loads((trusted/name).read_text(encoding='utf-8'))[key]:
            raise ValueError('Existing tag has unsupported build hooks: '+name)


def verify():
    plan = json.loads(plan_path().read_text(encoding='utf-8'))
    if inspect() != plan:
        raise ValueError('Rebuild identity changed after selection')
    source = ROOT/'release-source'
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Immutable rebuild source checkout is missing or linked')
    ci.checked_commit(plan['commit'], root=source)
    if ci.run('git', 'status', '--porcelain', '--untracked-files=normal', cwd=source, capture=True).strip():
        raise ValueError('Immutable rebuild source checkout is dirty')
    require_build_recipe(source)
    ci.validate(plan['tag'], root=source)
    recovery.load('generate-third-party-notices.py').generate(source, ensure=True)
    recovery.load('generate-third-party-notices.py').verify_locks(source)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'verify'))
    globals()[parser.parse_args().command]()
