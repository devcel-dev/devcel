#!/usr/bin/env python3
"""Extract final Tauri artifacts and require native notice evidence for each one."""
import argparse, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, zipfile, stat

spec=importlib.util.spec_from_file_location('native_check',pathlib.Path(__file__).with_name('check-native-distribution.py'))
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
evidence_spec=importlib.util.spec_from_file_location('native_evidence',pathlib.Path(__file__).with_name('collect-native-review-evidence.py'))
evidence=importlib.util.module_from_spec(evidence_spec);evidence_spec.loader.exec_module(evidence)

def run(args): subprocess.run(list(map(str,args)),check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)

import release_privacy
import debian_version
import studio_cli
from legal_distribution import distribution_files

def is_link(path):
    return path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))


def verify_deb_notices(root, repo):
    """Require the full generated legal tree in each actual Debian payload."""
    expected_root=repo/'third-party/generated'
    payload_root=root/'usr/lib/devcel-studio/legal'
    def files(directory):
        found={}
        if not directory.is_dir() or is_link(directory) or not directory.resolve().is_relative_to(root.resolve()):
            raise RuntimeError('Missing or linked Debian legal directory')
        for path in directory.rglob('*'):
            if is_link(path):raise RuntimeError('Linked Debian notice file')
            if path.is_file():found[path.relative_to(directory).as_posix()]=native.sha256(path)
        return found
    expected={name:native.sha256(path) for name,path in distribution_files(expected_root).items()};actual=files(payload_root)
    if not {'THIRD-PARTY-NOTICES.txt'}.issubset(expected):
        raise RuntimeError('Generated notice inventory is incomplete')
    if expected!=actual:
        missing=sorted(expected.keys()-actual.keys());extra=sorted(actual.keys()-expected.keys())
        changed=sorted(name for name in expected.keys()&actual.keys() if expected[name]!=actual[name])
        raise RuntimeError(f'Debian notices differ: missing={missing}, extra={extra}, changed={changed}')
    return {'verified_files':len(expected),'payload_root':'usr/lib/devcel-studio/legal'}

def verify_macos_notices(app, repo):
    expected = distribution_files(repo/'third-party/generated')
    legal = app/'Contents/Resources/legal'
    if not legal.is_dir() or is_link(legal) or not legal.resolve().is_relative_to(app.resolve()):
        raise RuntimeError('Missing or linked macOS legal directory')
    actual = {}
    for path in legal.rglob('*'):
        if is_link(path): raise RuntimeError('Linked macOS notice file')
        if path.is_file(): actual[path.relative_to(legal).as_posix()] = path
    if set(actual) != set(expected):
        raise RuntimeError('macOS legal payload differs from generated notices')
    for name, source in expected.items():
        if is_link(actual[name]) or actual[name].read_bytes() != source.read_bytes():
            raise RuntimeError('macOS notice missing, linked or changed: '+name)
    return {'verified_files': len(expected), 'payload_root': 'Contents/Resources/legal'}


def extract(artifact, root):
    suffix=artifact.suffix.lower()
    if suffix=='.zip':
        with zipfile.ZipFile(artifact) as archive:
            names=set()
            for entry in archive.infolist():
                destination=root/entry.filename
                if (entry.filename in names or '\\' in entry.orig_filename or
                    not destination.resolve().is_relative_to(root.resolve()) or
                    stat.S_ISLNK(entry.external_attr >> 16) or entry.is_dir()):
                    raise RuntimeError('Unsafe or duplicate ZIP entry')
                names.add(entry.filename)
            archive.extractall(root)
        return
    if artifact.is_dir() and suffix=='.app':
        shutil.copytree(artifact,root/artifact.name,symlinks=True);return
    if suffix=='.appimage':
        artifact.chmod(artifact.stat().st_mode|0o100)
        subprocess.run([str(artifact),'--appimage-extract'],cwd=root,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE);return
    if suffix=='.deb':run(['dpkg-deb','--extract',artifact,root]);return
    if suffix=='.rpm':
        command=subprocess.Popen(['rpm2cpio',str(artifact)],stdout=subprocess.PIPE)
        extracted=subprocess.run(['cpio','-id','--quiet','--no-absolute-filenames'],cwd=root,stdin=command.stdout,stderr=subprocess.PIPE)
        command.stdout.close()
        if command.wait() or extracted.returncode:raise RuntimeError('RPM extraction failed')
        return
    if suffix in ('.msi','.exe'):
        run(['7z','x','-y',f'-o{root}',artifact])
        for cabinet in list(root.rglob('*.cab')):
            run(['7z','x','-y',f'-o{cabinet.parent/(cabinet.name+"-payload")}',cabinet])
        # Unknown nested archives cannot be silently ignored.
        if any(root.rglob('*.7z')):raise RuntimeError('Nested Windows installer archive requires explicit extraction review')
        return
    if suffix=='.dmg':
        mount=root/'mounted';mount.mkdir()
        run(['hdiutil','attach','-readonly','-nobrowse','-mountpoint',mount,artifact])
        try:
            # The Applications shortcut is an installer destination, not shipped code.
            for path in mount.iterdir():
                if path.is_symlink() and os.readlink(path)=='/Applications':continue
                destination=root/'payload'/path.name;destination.parent.mkdir(parents=True,exist_ok=True)
                if path.is_dir():shutil.copytree(path,destination,symlinks=True)
                else:shutil.copyfile(path,destination,follow_symlinks=False)
        finally:run(['hdiutil','detach',mount])
        return
    raise RuntimeError('Unsupported artifact format: '+artifact.name)

def emit_report(report, destination):
    destination.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    # A compact, prefixed JSON line keeps evidence available in ordinary job
    # logs even if downloading Actions artifacts is unavailable.
    print('NATIVE_REVIEW_REPORT '+json.dumps(report,separators=(',',':')),flush=True)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform',choices=['linux','windows','macos'],required=True)
    parser.add_argument('--bundle-dir',type=pathlib.Path,required=True)
    parser.add_argument('--first-party',type=pathlib.Path,action='append',required=True)
    parser.add_argument('--report-dir',type=pathlib.Path,required=True)
    args=parser.parse_args();repo=pathlib.Path(__file__).resolve().parents[1]
    manifest=json.loads((repo/f'third-party/native-distributions/{args.platform}.json').read_text())
    extensions={'linux':{'.appimage','.deb','.rpm'},'windows':{'.zip','.exe','.msi'},'macos':{'.app','.dmg'}}[args.platform]
    artifacts=[p.resolve() for p in args.bundle_dir.rglob('*') if p.suffix.lower() in extensions and not any(parent.suffix.lower()=='.app' for parent in p.parents)]
    args.report_dir.mkdir(parents=True,exist_ok=True);failed=False
    if not artifacts:raise RuntimeError('No final native release artifacts found')
    for artifact in sorted(artifacts):
        with tempfile.TemporaryDirectory(prefix='devcel-native-notices-') as temp:
            root=pathlib.Path(temp).resolve()
            review_evidence={'evidence_only':True,'collection_error':'Artifact extraction or verification did not complete'}
            try:
                portable_report=None
                if args.platform=='windows':
                    if artifact.suffix.lower()!='.zip' or len(args.first_party)!=2:
                        raise RuntimeError('Windows distribution requires Studio and bundled CLI first-party EXEs')
                    portable_spec=importlib.util.spec_from_file_location('portable',pathlib.Path(__file__).with_name('package-windows-studio.py'))
                    portable=importlib.util.module_from_spec(portable_spec);portable_spec.loader.exec_module(portable)
                    portable_report=portable.verify_archive(artifact,args.first_party[0],repo)
                if artifact.suffix.lower()=='.deb':
                    debian_version.verify(artifact, json.loads((repo/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version'])
                extract(artifact,root)
                release_privacy.check_tree(root)
                packaged_cli=None
                macos_notices=None
                if args.platform in ('windows','linux','macos'):
                    if args.platform == 'macos':
                        import platform
                        arch = {'x86_64':'x64', 'arm64':'arm64', 'aarch64':'arm64'}.get(platform.machine())
                        if arch is None: raise RuntimeError('Unsupported macOS CPU')
                        cli_platform = 'osx-'+arch
                        apps = list(root.rglob('devcel-studio.app'))
                        if len(apps) != 1: raise RuntimeError('Expected one Studio app bundle')
                        cli_root = apps[0]/'Contents/Resources/bin'
                        macos_notices = verify_macos_notices(apps[0], repo)
                        run(['codesign','--verify','--deep','--strict',apps[0]])
                    else:
                        cli_platform='win-x64' if args.platform=='windows' else 'linux-x64'
                        cli_root=root/'bin' if args.platform=='windows' else root/'usr/lib/devcel-studio/bin'
                    packaged_cli=studio_cli.smoke(cli_root,cli_platform)
                    if packaged_cli != studio_cli.validate(repo/studio_cli.DIRECTORY,cli_platform):
                        raise RuntimeError('Packaged CLI manifest differs from staged source')
                    if (cli_root/'LICENSE-CLI.txt').read_bytes() != (repo/'devcel-cli/LICENSE').read_bytes():
                        raise RuntimeError('Packaged CLI license differs')
                deb_notices=verify_deb_notices(root,repo) if args.platform=='linux' and artifact.suffix.lower()=='.deb' else None
                files,errors=native.verify(root,manifest,args.first_party,artifact.suffix.lower())
                try:
                    review_evidence=evidence.collect(root,files)
                    if portable_report:review_evidence['portable_validation']=portable_report
                    if deb_notices:review_evidence['deb_notice_validation']=deb_notices
                    if macos_notices:review_evidence['macos_notice_validation']=macos_notices
                    if packaged_cli:review_evidence['bundled_cli_validation']=packaged_cli
                except Exception as exc: review_evidence={'evidence_only':True,'collection_error':release_privacy.diagnostic(exc, 'evidence-collection-failed')}
            except Exception as error:files=[];errors=[release_privacy.diagnostic(error, 'Incomplete artifact inspection')]
            report={'artifact':artifact.name,'sha256':native.sha256(artifact) if artifact.is_file() else None,'platform':args.platform,'version':json.loads((repo/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version'],'provenance':{key:os.environ.get(key) for key in ('GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_REPOSITORY')},'manifest_sha256':native.sha256(repo/f'third-party/native-distributions/{args.platform}.json'),'native_files':files,'review_evidence':review_evidence,'expected_first_party':[native.first_party_identity(path,artifact.suffix.lower()) for path in args.first_party],'errors':errors,'verified':not errors}
            emit_report(report,args.report_dir/(artifact.name+'.json'))
            if errors:
                failed=True;print(artifact.name+':\n'+'\n'.join(errors),file=sys.stderr)
    if failed:sys.exit(1)

if __name__=='__main__':main()
