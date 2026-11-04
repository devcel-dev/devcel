#!/usr/bin/env python3
"""Explicitly requested validation suites; never called by build/release workflows."""
import argparse
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import zipfile

sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
ROOT = Path(__file__).resolve().parents[1]

def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT/'scripts'/f'{name}.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

ci = module('ci-release')
SUITES = ('compact', 'frontend', 'rust', 'lint', 'importers', 'native', 'all')

def execute(suite):
    if suite != 'all':
        ci.run(sys.executable, 'scripts/generate-third-party-notices.py', '--ensure')
    if suite == 'all':
        for name in SUITES[:-1]: execute(name)
    elif suite == 'compact':
        ci.run(sys.executable, 'scripts/check-node-pins.py')
        ci.run(sys.executable, 'scripts/test-node-pins.py')
        ci.compact_checks()
    elif suite == 'frontend':
        studio = ROOT/'devcel-studio'
        scripts = ci.json.loads((studio/'package.json').read_text())['scripts']
        ci.run('npm', 'run', 'build', cwd=studio)
        # Include each existing UI/asset test group, including groups outside the batch.
        for name in scripts:
            if name.startswith('check:') or name in ('typecheck', 'assets:check', 'sdk:check', 'licenses:check'):
                if name != 'check:production-assets':
                    ci.run('npm', 'run', name, cwd=studio)
        ci.run('npm', 'run', 'check:production-assets', cwd=studio)
    elif suite == 'rust':
        ci.run('cargo', 'test', '--locked', '--release', '--workspace', '--all-features')
        for command, required, harnesses in ci.rust_regression_gates():
            ci.checked_rust_tests(command, required, harnesses)
    elif suite == 'lint':
        ci.run('rustup', 'component', 'add', 'rustfmt', 'clippy')
        ci.run('cargo', 'fmt', '--all', '--', '--check')
        ci.run('cargo', 'clippy', '--locked', '--release', '--workspace', '--all-targets', '--all-features', '--', '-D', 'warnings')
        ci.run('npm', 'run', 'lint', cwd=ROOT/'devcel-studio')
    elif suite == 'importers':
        packager = module('package-importers')
        platform = packager.host_platform()
        commit = ci.run('git', 'rev-parse', 'HEAD', capture=True).strip()
        with tempfile.TemporaryDirectory(prefix='devcel-importer-tests-') as directory:
            out = Path(directory)/'packages'
            ci.run(sys.executable, 'scripts/package-importers.py', '--out', out, '--platform', platform,
                   '--source-repository', os.environ['GITHUB_REPOSITORY'], '--source-commit', commit)
            archives = sorted(out.glob('*.zip'))
            if len(archives) != 9: raise ValueError('Expected nine importer archives')
            for archive in archives:
                extracted = Path(directory)/archive.stem
                with zipfile.ZipFile(archive) as package:
                    package.extractall(extracted)
                ci.release_privacy.check_tree(extracted)
                binaries = [p for p in extracted.rglob('devcel.exe' if platform == 'win-x64' else 'devcel') if p.is_file()]
                if len(binaries) != 1: raise ValueError('Expected one bundled CLI per importer')
                binaries[0].chmod(0o755)
                packager.verify_cli(binaries[0])
                for source in extracted.rglob('cli-source.tar.gz'):
                    ci.release_privacy.check_source_archive(source)
    elif suite == 'native':
        ci.release_privacy.configure(ROOT)
        ci.inspect_native()
        _, platform, _, _ = ci.platform_config()
        ci.studio_cli.smoke(ROOT/ci.studio_cli.DIRECTORY, platform)
    else:
        raise ValueError('Unknown validation suite: '+suite)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('suite', choices=SUITES)
    execute(parser.parse_args().suite)
