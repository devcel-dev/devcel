#!/usr/bin/env python3
"""Build and package editor-only CLI with all engine importers (Python 3.11+).
Every package is explicitly for one native editor platform; no PATH prerequisite.
"""
from __future__ import annotations
from contextlib import contextmanager
import time
import gzip
import importer_versions
from product_version import read_version
import argparse, importlib.util, hashlib, json, os, platform, re, shutil, stat, subprocess, sys, tarfile, tempfile, tomllib, zipfile
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import release_privacy
from legal_distribution import distribution_files
from unity_toolchain import verify_source as verify_unity_toolchain

CLI_LICENSE_NAME = 'LICENSE-CLI-MIT.txt'


@contextmanager
def package_scratch():
    # Hosted runners discard the VM after the job. Keep the validated outputs
    # moving toward upload instead of recursively deleting vendored sources.
    if os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted':
        yield tempfile.mkdtemp(prefix='devcel-package-')
    else:
        with tempfile.TemporaryDirectory(prefix='devcel-package-') as scratch:
            yield scratch

PLATFORMS = {
    'linux-x64': ('x86_64-unknown-linux-gnu', 'libdevcel_runtime.so', 'Linux/x86_64'),
    'win-x64': ('x86_64-pc-windows-msvc', 'devcel_runtime.dll', 'Windows/x86_64'),
    'osx-arm64': ('aarch64-apple-darwin', 'libdevcel_runtime.dylib', 'macOS'),
}

def run(*args, cwd=None):
    if str(args[0]) in ('cargo', 'lipo'): print('Running: ' + ' '.join(map(str, args)), file=sys.stderr, flush=True)
    p = subprocess.run(list(map(str, args)), cwd=cwd, text=True, encoding='utf-8', errors='replace', capture_output=True)
    if p.returncode:
        raise RuntimeError(f'{args[0]} exited {p.returncode}\n{p.stdout}\n{p.stderr}')
    return p.stdout.strip()

def host_platform():
    system = {'Linux':'linux', 'Windows':'win', 'Darwin':'osx'}.get(platform.system(), '')
    arch = {'x86_64':'x64', 'AMD64':'x64', 'aarch64':'arm64', 'arm64':'arm64'}.get(platform.machine(), '')
    return f'{system}-{arch}'

def sha256(path):
    with path.open('rb') as source: return hashlib.file_digest(source, 'sha256').hexdigest()

def copy_sources(source, dest):
    """An isolated workspace avoids packaging the unrelated Studio dependency graph."""
    for crate in ('devcel-cli', 'devcel-core', 'devcel-runtime'):
        shutil.copytree(source / crate, dest / crate, ignore=shutil.ignore_patterns('target', '.git', '__pycache__'))
    manifest = (source / 'Cargo.toml').read_text(encoding='utf-8')
    manifest, count = re.subn(r'(?ms)^members\s*=\s*\[.*?\]', 'members = ["devcel-cli", "devcel-core", "devcel-runtime"]', manifest, count=1)
    if count != 1: raise RuntimeError('workspace members must be explicit')
    (dest / 'Cargo.toml').write_text(manifest, encoding='utf-8')
    shutil.copyfile(source / 'Cargo.lock', dest / 'Cargo.lock')
    shutil.copyfile(source / 'rust-toolchain.toml', dest / 'rust-toolchain.toml')
    shutil.copyfile(source / 'LICENSE-NOTICE', dest / 'LICENSE-NOTICE')
    if not (dest / 'devcel-cli/LICENSE').is_file():
        raise RuntimeError('devcel-cli/LICENSE is required for redistributed CLI')


def zip_tree(root, out, build_epoch=None):
    build_epoch = int(time.time()) if build_epoch is None else build_epoch
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for p in sorted(root.rglob('*')):
            if p.is_symlink(): raise RuntimeError(f'Package symlinks are not allowed: {p}')
            if not p.is_file(): continue
            info = zipfile.ZipInfo(p.relative_to(root).as_posix(), time.gmtime(build_epoch)[:6])
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if p.name in ('devcel', 'devcel.exe') or p.suffix in ('.sh', '.command') else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, p.read_bytes())



def prepare_payload(stage, scratch, package_name, cli_name, output_format, build_epoch):
    if output_format not in ('zip', 'directory'): raise ValueError('Unknown output format')
    if any(p.is_symlink() for p in stage.rglob('*')): raise RuntimeError('Package symlinks are not allowed')
    package = scratch / (package_name + ('.zip' if output_format == 'zip' else ''))
    if package.exists(): raise RuntimeError('Package staging output already exists')
    if output_format == 'zip':
        zip_tree(stage, package, build_epoch)
        os.utime(package, (build_epoch, build_epoch))
    else:
        shutil.copytree(stage, package)
    return package


def markdown_links(text):
    """Yield Markdown/HTML link URL spans outside fenced code examples."""
    offset = 0
    fence = None
    for line in text.splitlines(keepends=True):
        token = re.match(r'^\s*(`{3,}|~{3,})', line)
        if token:
            mark = token[1]
            if fence is None: fence = mark
            elif mark[0] == fence[0] and len(mark) >= len(fence): fence = None
        elif fence is None:
            spans = [(match.start(1), match.end(1), match[1]) for match in
                     re.finditer(r'!?\[[^\]]*\]\(([^\s)]+)(?:\s+[\"\'][^)]*)?\)', line)]
            # README branding uses picture/source/img, not Markdown image links.
            for tag in re.finditer(r'<(?:a|img|source)\b[^>]*>', line, re.I):
                for attribute in re.finditer(r'\b(src|href|srcset)\s*=\s*([\"\'])(.*?)\2', tag[0], re.I):
                    start = tag.start() + attribute.start(3)
                    if attribute[1].lower() == 'srcset':
                        spans.extend((start + item.start(1), start + item.end(1), item[1])
                            for item in re.finditer(r'(?:^|,)\s*([^\s,]+)', attribute[3]))
                    else: spans.append((start, start + len(attribute[3]), attribute[3]))
            reference = re.match(r'^\s{0,3}\[[^\]]+\]:\s*(<?[^\s>]+>?)', line)
            if reference: spans.append((reference.start(1), reference.end(1), reference[1]))
            for start, end, href in sorted(spans):
                yield offset + start, offset + end, href
        offset += len(line)


def bundle_documentation(repo, stage, dest, engine, bundled, source_commit, source_repository):
    """Ship the public documentation graph, without copying implementation code.

    Code/directory/Studio-document links point to the stated source revision; all remaining local
    file links resolve inside this ZIP. Verification commands may need that full
    checkout. These docs are separate from the MIT CLI corresponding-source tree.
    """
    repo = repo.resolve()
    sources = {}
    # Unity's checked-in package is generated; never use it as a documentation
    # source or each release can embed the previous release recursively.
    original = repo / 'importers' / ('unity-template' if engine == 'unity' else engine)
    if engine == 'godot': original /= 'addons/devcel'
    for path in dest.rglob('*.md'):
        source = original / path.relative_to(dest)
        if source.is_file(): sources[path] = source
    sources[bundled / 'README.md'] = repo / 'docs/development/importer-packaging.md'
    manual = repo / f'docs/manual/{engine}.md' if engine in ('unity', 'godot') else None
    if engine == 'unreal':
        manual = repo / 'docs/manual/importers/unreal.md'
        sources[dest / 'Docs/unreal.md'] = manual
    if manual is not None:
        sources[dest / 'INSTALL.md'] = manual
    elif (original / 'README.md').is_file():
        sources[dest / 'INSTALL.md'] = original / 'README.md'
    # Retain an actual, readable Godot API guide in the addon distribution too.
    if engine == 'godot': sources[dest / 'README.md'] = repo / 'importers/godot/README.md'
    # Keep documentation images out of Unity's asset pipeline and Godot exports.
    docs_root = dest / 'Documentation~' if engine == 'unity' else bundled / 'Documentation' if engine == 'godot' else dest / 'Documentation'
    canonical = {}
    for path, source in sources.items(): canonical.setdefault(source.resolve(), path)
    queue = list(sources)
    processed = set()
    while queue:
        path = queue.pop(0)
        if path in processed: continue
        processed.add(path)
        source = sources[path]
        text = source.read_text(encoding='utf-8')
        edits = []
        for start, end, href in markdown_links(text):
            url = urlsplit(href.strip('<>'))
            if url.scheme or url.netloc or not url.path: continue
            target = (source.parent / unquote(url.path)).resolve()
            if not target.is_relative_to(repo) or not target.exists():
                raise RuntimeError(f'Documentation target missing or outside repository: {source}: {href}')
            # Links in repository manuals may name the generated Unity package.
            # Resolve editable documentation to the template, and never embed
            # generated-only files (especially prior Documentation~/repository trees).
            generated_unity = repo / 'importers/unity'
            if engine == 'unity' and target.is_relative_to(generated_unity):
                template_target = repo / 'importers/unity-template' / target.relative_to(generated_unity)
                if template_target.is_file():
                    target = template_target.resolve()
                else:
                    kind = 'tree' if target.is_dir() else 'blob'
                    replacement = f'https://github.com/{source_repository}/{kind}/{quote(source_commit, safe="")}/{quote(target.relative_to(repo).as_posix(), safe="/")}'
                    edits.append((start, end, replacement))
                    continue
            # Public docs/images/licenses are distributable documentation. Do not
            # pull GPL Studio code or documentation into an MIT importer through a link.
            is_document = target.is_file() and target.relative_to(repo).parts[0] != 'devcel-studio' and (target.suffix.lower() in ('.md', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp') or target.name.startswith(('LICENSE', 'NOTICE')))
            if is_document:
                destination = canonical.get(target)
                if destination is None:
                    destination = docs_root / 'repository' / target.relative_to(repo)
                    canonical[target] = destination
                    if target.suffix.lower() == '.md':
                        sources[destination] = target; queue.append(destination)
                    else:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(target, destination)
                relative = os.path.relpath(destination, path.parent).replace('\\', '/')
                replacement = urlunsplit(('', '', quote(relative, safe='/~'), url.query, url.fragment))
            else:
                kind = 'tree' if target.is_dir() else 'blob'
                replacement = f'https://github.com/{source_repository}/{kind}/{quote(source_commit, safe="")}/{quote(target.relative_to(repo).as_posix(), safe="/")}'
                if url.fragment: replacement += '#' + url.fragment
            edits.append((start, end, replacement))
        for start, end, value in reversed(edits): text = text[:start] + value + text[end:]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8', newline='\n')

def install_mastermemory_tools(repo, bundled):
    """Include the optional source generator and its complete first-party license."""
    source = repo / 'importers/unity-mastermemory'
    target = bundled / 'MasterMemory'
    target.mkdir(parents=True, exist_ok=True)
    for name in ('generate.py', 'support.cs.txt', 'live.cs.txt', 'LICENSE'):
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('Missing or unsafe MasterMemory generator input: ' + str(path))
        # These inputs are combined across OS artifacts; normalize checkout line endings.
        (target / name).write_text(path.read_text(encoding='utf-8'), encoding='utf-8', newline='\n')


def verify_cli(cli):
    help_text = run(cli, 'pull', '--help')
    for argument in ('--config', '--status', '--source'):
        if argument not in help_text: raise RuntimeError(f'CLI pull is missing {argument}')
    watch_help = run(cli, 'watch', '--help')
    for argument in ('--ensure-server', '--parent-stdin'):
        if argument not in watch_help: raise RuntimeError(f'CLI watch is missing {argument}')
    for command in ('pull-config-save', 'importer-ui', 'wolf-export'):
        run(cli, command, '--help')
    # Real workflow verifies the bundled executable, not a renamed placeholder.
    with tempfile.TemporaryDirectory(prefix='devcel-pull-smoke-') as temp:
        temp = Path(temp)
        data = json.loads(run(cli, 'init', 'BundleSmoke', '--dir', temp))['data']
        project = Path(data['project_path'])
        run(cli, '--mode', 'local', '--project', project, 'table', 'create', 'Items')
        config = temp / 'title/.devcel/devcel.import.json'
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'schema_version':1, 'sources':[{
            'id':'base', 'project':os.path.relpath(project, config.parent).replace('\\','/'),
            'namespace':'BundleSmoke.Base', 'class_name':'BaseData',
            'runtime_out':'../data/base.json', 'code_out':'../generated/Base.cs',
            'code_target':'csharp', 'mode':'full'}]}), encoding='utf-8')
        result = json.loads(run(cli, 'pull', '--config', config))
        if not result['ok']: raise RuntimeError('Bundled CLI Pull failed')
        status = json.loads(run(cli, 'pull', '--config', config, '--status'))
        if status['data']['sources'][0]['status'] != 'ready': raise RuntimeError('Bundled CLI Pull is not ready')
        if not (temp / 'title/data/base.json').is_file(): raise RuntimeError('Pull output missing')
        ts = json.loads(run(cli, '--mode', 'local', '--project', project, 'export', 'code', 'typescript', '--namespace', 'BundleSmoke.Types'))
        if not ts.get('ok') or 'namespace BundleSmoke' not in ts['data']['code']: raise RuntimeError('TypeScript code generation missing')


def verify_unity_version(repo):
    """Fail before compiling if the package contract and Studio release have drifted."""
    package = json.loads((repo / 'importers/unity-template/package.json').read_text(encoding='utf-8'))
    version = read_version(repo)
    if not isinstance(package, dict) or package.get('name') != 'org.devcel.unity' or 'version' in package:
        raise RuntimeError('Unity release-version template must name org.devcel.unity without a stored version')
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--platform', choices=PLATFORMS, default=host_platform())
    parser.add_argument('--source-root', type=Path, help='Optional separately materialized exact CLI/core source tree')
    parser.add_argument('--source-repository', required=True, help='GitHub OWNER/REPO containing the source commit (no URL or credentials)')
    parser.add_argument('--source-commit', required=True, help='Base source commit; actual bundled source is also included and hashed')
    parser.add_argument('--format', choices=('zip', 'directory'), default='zip')
    parser.add_argument('--build-epoch', type=int)
    args = parser.parse_args()
    build_epoch = int(time.time()) if args.build_epoch is None else args.build_epoch
    if not 315532800 <= build_epoch <= 4354819198: parser.error('Build timestamp outside ZIP range')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', args.source_repository):
        parser.error('--source-repository must be a GitHub OWNER/REPO slug without credentials')
    if not re.fullmatch(r'(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})', args.source_commit):
        parser.error('--source-commit must be a full Git commit hash from --source-repository')
    if args.platform not in PLATFORMS or args.platform != host_platform():
        raise RuntimeError('Packaging must run on the matching native OS/CPU; cross-platform packaging is not supported')
    repo = args.repo.resolve(); source = (args.source_root or repo).resolve()
    version = verify_unity_version(repo)
    importer_versions.validate_templates(repo)
    unity_fingerprint = verify_unity_toolchain(repo, source)
    spec = importlib.util.spec_from_file_location('devcel_notices', repo/'scripts/generate-third-party-notices.py')
    notices_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notices_module)
    notices_module.verify_upstream(repo)
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    target, runtime_name, runtime_dir = PLATFORMS[args.platform]
    if args.platform.startswith('osx-'):
        from studio_cli import configure_macos
        configure_macos(repo)
    with package_scratch() as scratch:
        scratch = Path(scratch); build = scratch / 'source'; build.mkdir()
        copy_sources(source, build)
        cli_license = tomllib.loads((build/'devcel-cli/Cargo.toml').read_text(encoding='utf-8')).get('package', {}).get('license')
        if cli_license != 'MIT' or (build/'devcel-cli/LICENSE').read_bytes() != (repo/'devcel-cli/LICENSE').read_bytes():
            raise RuntimeError('Bundled CLI must be built from the current MIT-licensed source; do not relabel older GPL artifacts')
        original = tomllib.loads((source/'Cargo.lock').read_text(encoding='utf-8'))
        allowed = {(p['name'],p['version'],p.get('source',''),p.get('checksum','')) for p in original['package']}
        # Cargo may prune unused Studio entries, but must not upgrade any dependency.
        metadata = json.loads(run('cargo','metadata','--format-version','1', cwd=build))
        pruned = tomllib.loads((build/'Cargo.lock').read_text(encoding='utf-8'))
        if any((p['name'],p['version'],p.get('source',''),p.get('checksum','')) not in allowed for p in pruned['package']):
            raise RuntimeError('Dependency resolution changed; update and review the repository Cargo.lock first')
        # A standalone Windows editor CLI must not need a separate MSVC redistributable.
        if args.platform == 'win-x64':
            os.environ['RUSTFLAGS'] = (os.environ.get('RUSTFLAGS', '') + ' -C target-feature=+crt-static').strip()
            if 'CARGO_ENCODED_RUSTFLAGS' in os.environ:
                os.environ['CARGO_ENCODED_RUSTFLAGS'] += '\x1f-C\x1ftarget-feature=+crt-static'
        # External target cache is allowed; outputs must match these exact source files.
        release_privacy.configure(repo, build)
        run('cargo','build','--locked','--release','--target',target,'-p','devcel-cli','-p','devcel-runtime',cwd=build)
        target_dir = Path(metadata['target_directory']) / target / 'release'
        cli = target_dir / ('devcel.exe' if args.platform.startswith('win-') else 'devcel')
        runtime = target_dir / runtime_name
        if not cli.is_file() or not runtime.is_file(): raise RuntimeError('Required native artifact missing')
        if args.platform.startswith('osx-'):
            # Unity runtime contract requires both CPUs even in an editor-specific CLI ZIP.
            other = 'aarch64-apple-darwin' if target == 'x86_64-apple-darwin' else 'x86_64-apple-darwin'
            run('cargo','build','--locked','--release','--target',other,'-p','devcel-runtime',cwd=build)
            universal = scratch / runtime_name
            run('lipo','-create',runtime,Path(metadata['target_directory'])/other/'release'/runtime_name,'-output',universal)
            runtime = universal
            # lipo changes signed bytes; sign the final universal library and CLI
            # before generating their hashes. This is ad-hoc, not notarization.
            for binary in (cli, runtime):
                run('codesign', '--force', '--sign', '-', binary)
        vendor_config = run('cargo','vendor','--locked','vendor',cwd=build)
        (build/'.cargo').mkdir(exist_ok=True)
        (build/'.cargo/config.toml').write_text(vendor_config+'\n',encoding='utf-8')
        notices = notices_module.cargo_inventory(repo, metadata) + notices_module.devcel_component_inventory(repo, metadata) + notices_module.importer_inventory(repo) + notices_module.rust_standard_library_inventory(repo)
        unresolved = [p['name'] for p in notices if p.get('errors')]
        if unresolved: raise RuntimeError('Missing original dependency license evidence: ' + ', '.join(unresolved))
        legal = build/'third-party'; legal.mkdir()
        for name, data in notices_module.render(repo, notices, {'Cargo.lock': sha256(build/'Cargo.lock')}, include_templates=False).items():
            path = legal/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(data)
        shutil.copyfile(legal/'inventory.json', build/'THIRD-PARTY-NOTICES.json')
        rust_version = run('rustc', '--version', cwd=build)
        rust_flags = release_privacy.provenance_flags()
        (build/'BUILD-SOURCE.txt').write_text(f'Compiler: {rust_version}\nSource repository: https://github.com/{args.source_repository}\nBase commit: {args.source_commit}\nPackage version: {version}\nTarget: {target}\nRUSTFLAGS: {rust_flags}\nBuild: cargo build --offline --locked --release --target {target} -p devcel-cli -p devcel-runtime\nAll registry dependency sources and original notices are in vendor/.\n',encoding='utf-8')
        if args.platform.startswith('osx-'):
            with (build/'BUILD-SOURCE.txt').open('a', encoding='utf-8') as instructions:
                instructions.write(
                    f"macOS: export MACOSX_DEPLOYMENT_TARGET={os.environ['MACOSX_DEPLOYMENT_TARGET']} before building.\n"
                    'Install both Darwin targets with rustup target add x86_64-apple-darwin aarch64-apple-darwin.\n'
                    f'Also build: cargo build --offline --locked --release --target {other} -p devcel-runtime\n'
                    'Combine the two target/<triple>/release/libdevcel_runtime.dylib files with lipo -create -output libdevcel_runtime.dylib.\n'
                    'If CARGO_TARGET_DIR is set, use that directory instead of target/.\n'
                    'Ad-hoc sign the final CLI and Universal dylib: codesign --force --sign - <binary>.\n'
                    'Regenerate manifest hashes after signing modified binaries. No Apple notarization is included.\n')
        source_archive = scratch/'cli-source.tar.gz'
        def source_timestamp(info):
            return release_privacy.archive_info(info, build_epoch)
        with source_archive.open('wb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=build_epoch) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                # Original source contents are preserved; only output metadata changes.
                for name in ('LICENSE-NOTICE','Cargo.toml','Cargo.lock','rust-toolchain.toml','devcel-cli','devcel-core','devcel-runtime','vendor','.cargo','third-party','THIRD-PARTY-NOTICES.json','BUILD-SOURCE.txt'):
                    archive.add(build/name,arcname='devcel-cli-source/'+name,filter=source_timestamp)
        manifest = {'build_epoch':build_epoch,'schema_version':1,'version':version,'supportedPlatforms':[args.platform],
            'binaries':{args.platform:{'path':args.platform+'/'+cli.name,'sha256':sha256(cli),'target':target}},
            'source_repository':args.source_repository,'source_commit':args.source_commit,'rustc':rust_version,'source_archive':'cli-source.tar.gz','source_sha256':sha256(source_archive),
            'source_fingerprint':unity_fingerprint,
            'native_runtime':{'path':'Plugins/'+runtime_dir+'/'+runtime_name,'sha256':sha256(runtime)}}
        if args.platform.startswith('linux-'):
            versions = [tuple(map(int, v.split(b'.'))) for v in re.findall(rb'GLIBC_(\d+\.\d+)', cli.read_bytes())]
            if versions: manifest['binaries'][args.platform]['minimum_glibc'] = '.'.join(map(str, max(versions)))
        results=[]
        pending=[]
        for engine in ('unity','godot','unreal','rpgmaker','wolf','gamemaker','defold','cocos','javascript'):
            stage=scratch/engine; stage.mkdir()
            if engine=='unity':
                dest=stage/'devcel-unity'
                shutil.copytree(repo/'importers/unity-template',dest,ignore=shutil.ignore_patterns('Tools~','Plugins','Plugins.meta','Library','Temp','.git','test-output'))
                bundled=dest/'Tools~'
                plugin=dest/'Plugins'/runtime_dir/runtime_name; plugin.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(runtime,plugin)
                shutil.copyfile(repo/"importers/unity-template/Tools~/NativePluginMetadata"/runtime_dir/(runtime_name+".meta"), Path(str(plugin)+".meta"))
            elif engine=='godot':
                dest=stage/'addons/devcel'
                shutil.copytree(repo/'importers/godot/addons/devcel',dest,ignore=shutil.ignore_patterns('bin','.godot','.git','test-output'))
                bundled=dest/'bin'
            else:
                source_dir=repo/'importers'/engine
                if not (source_dir/'LICENSE').is_file(): raise RuntimeError(f'{engine} importer license missing')
                destinations = {
                    'unreal': ('Plugins/Devcel', 'Tools'),
                    'rpgmaker': ('', 'js/plugins/devcel/bin'),
                    'wolf': ('devcel-wolf', 'Tools/bin'),
                    'gamemaker': ('devcel-gamemaker', 'tools'),
                    'defold': ('', 'devcel/tools'),
                    'cocos': ('devcel-cocos', 'bin'),
                    'javascript': ('devcel-javascript', 'bin'),
                }
                relative, tools = destinations[engine]
                dest=stage/relative
                shutil.copytree(source_dir,dest,dirs_exist_ok=True,ignore=shutil.ignore_patterns('node_modules','.git','__pycache__','test-output','Tests','tests'))
                bundled=dest/tools
                manual=repo/'docs/manual/importers/unreal.md' if engine=='unreal' else source_dir/'README.md'
                if manual.is_file(): shutil.copyfile(manual,dest/'INSTALL.md')
                if engine=='unreal':
                    (dest/'Docs').mkdir(exist_ok=True); shutil.copyfile(manual,dest/'Docs/unreal.md')
            importer_versions.materialize(repo, engine, dest)
            if engine == 'unity': install_mastermemory_tools(repo, bundled)
            (bundled/args.platform).mkdir(parents=True)
            shutil.copyfile(repo/'docs/development/importer-packaging.md', bundled/'README.md')
            installation_path = (dest/'INSTALL.md').relative_to(stage).as_posix()
            instructions = {
                'unity': 'Add the devcel-unity folder as a local or embedded Unity Package Manager package. Follow devcel-unity/INSTALL.md.',
                'godot': 'Copy the addons folder into the Godot project root and enable Devcel in Project Settings > Plugins. Follow addons/devcel/INSTALL.md.',
            }.get(engine, f'Follow the installation steps in {installation_path}.')
            (stage/'INSTALL.txt').write_text(
                f'Devcel {engine} importer / {args.platform} / Package {version}\n{instructions}\n'
                f'Requirements and licenses: {bundled.relative_to(stage).as_posix()}/README.md\n'
                'Use the package matching the editor operating system and CPU.\n'
                'Linked manuals/images are included. Verification commands may require the full source checkout.\n'
                f'Source references: https://github.com/{args.source_repository}/tree/{args.source_commit}\n', encoding='utf-8')
            shutil.copyfile(cli,bundled/args.platform/cli.name)
            (bundled/args.platform/cli.name).chmod(0o755)
            (bundled/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
            shutil.copyfile(build/'devcel-cli/LICENSE',bundled/CLI_LICENSE_NAME)
            (dest/'ThirdPartyNotices').mkdir()
            for name, original in distribution_files(legal).items():
                shutil.copyfile(original, dest/'ThirdPartyNotices'/name)
            shutil.copyfile(source_archive,bundled/'cli-source.tar.gz')
            if engine=='godot': (bundled/'.gdignore').touch()
            bundle_documentation(repo, stage, dest, engine, bundled, args.source_commit, args.source_repository)
            package_name = f'devcel-{engine}-{version}-{args.platform}'
            package = prepare_payload(stage, scratch, package_name, cli.name, args.format, build_epoch)
            result = {'file':package.name,'format':args.format,'build_epoch':build_epoch,'platform':args.platform,'cli_sha256':sha256(cli)}
            if args.format == 'zip':
                result['sha256'] = sha256(package)
            else:
                result['files'] = {p.relative_to(package).as_posix(): sha256(p)
                                   for p in sorted(package.rglob('*')) if p.is_file()}
                for path in sorted(package.rglob('*'), reverse=True): os.utime(path, (build_epoch, build_epoch))
                os.utime(package, (build_epoch, build_epoch))
            results.append(result)
            shutil.rmtree(stage)
            pending.append(package)
        # Move complete packages to the output directory.
        if any((out/package.name).exists() for package in pending): raise RuntimeError('Package output already exists')
        for package in pending: shutil.move(str(package), str(out/package.name))
        (out/f'checksums-{args.platform}.json').write_text(json.dumps(results,indent=2)+'\n',encoding='utf-8')
        os.utime(out/f'checksums-{args.platform}.json', (build_epoch, build_epoch))
        os.utime(out, (build_epoch, build_epoch))
        print(json.dumps(results,indent=2))

if __name__=='__main__': main()
