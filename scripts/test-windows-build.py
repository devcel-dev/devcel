#!/usr/bin/env python3
"""Run the Windows build orchestrator in PowerShell with fake native tools.

On Linux only the native-Windows guard is removed in an isolated fixture copy.
This tests PowerShell control flow and argv, not MSVC, cmd.exe, or installers.
Set PWSH to a PowerShell 7 executable; CI should install it or use Windows pwsh.
"""
import json
import importlib.util
import zipfile
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PWSH = os.environ.get('PWSH') or shutil.which('pwsh')
TOOL = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, subprocess
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
root=pathlib.Path(os.environ['FIXTURE_ROOT'])
with (root/'commands.jsonl').open('a',encoding='utf-8') as f:
 f.write(json.dumps([name,args,str(pathlib.Path.cwd())])+'\n')
if os.environ.get('FAIL_TOOL') == name and (not os.environ.get('FAIL_ARG') or os.environ['FAIL_ARG'] in args): sys.exit(17)
if name == 'cargo': print(json.dumps({'target_directory':os.environ.get('CUSTOM_TARGET', str(root/'target [x]'))}))
elif name == 'rustc': print('rustc '+os.environ.get('RUST_VERSION','1.99.0')+'\r')
elif name == 'git':
 if args[-2:] == ['rev-parse','--show-toplevel']: print(os.environ.get('CHECKOUT_ROOT', str(root))+'\r')
 elif args[-3:] == ['config','--get','remote.origin.url']: print(os.environ.get('GIT_ORIGIN','https://github.com/owner/repo.git')+'\r')
 elif args[-2:] == ['rev-parse','HEAD']: print('a'*40+'\r')
 else: sys.exit('Unexpected git arguments')
elif name == 'npm.cmd':
 if args == ['--version']: print('12.2.0\r')
 elif len(args)>1 and args[1].startswith('tauri:build'):
  mode='debug' if args[1].endswith(':debug') else 'release'
  dest=root/'target [x]'/'x86_64-pc-windows-msvc'/mode
  if os.environ.get('OMIT_BUILD'): sys.exit(0)
  dest.mkdir(parents=True,exist_ok=True)
  (dest/'devcel-studio.exe').write_bytes((root/'fixture.exe').read_bytes())
elif name == 'node': print('v26.12.1\r')
elif name == 'python' and args and args[0] == '-c': print('devcel-python-ready')
elif name == 'python' and args and args[0] == 'scripts/package-importers.py':
 out=pathlib.Path(args[args.index('--out')+1]);out.mkdir(parents=True)
 for i in range(int(os.environ.get('ZIP_COUNT','9'))): (out/f'devcel-importer-{i}').mkdir()
elif name == 'python' and args and pathlib.Path(args[0]).name == 'studio_cli.py':
 import hashlib
 dest=root/'devcel-studio/src-tauri/bundled-cli';dest.mkdir(parents=True,exist_ok=True)
 raw=(root/'fixture.exe').read_bytes();(dest/'devcel.exe').write_bytes(raw)
 (dest/'LICENSE-CLI.txt').write_text('MIT fixture')
 (dest/'manifest.json').write_text(json.dumps({'schema_version':1,'version':'0.0.1','platform':'win-x64','executable':'devcel.exe','sha256':hashlib.sha256(raw).hexdigest(),'source_commit':'a'*40}))
elif name == 'python' and args and pathlib.Path(args[0]).name == 'package-windows-studio.py':
 sys.exit(subprocess.call([sys.executable,*args]))
'''

@unittest.skipUnless(PWSH, 'PowerShell 7 is required (PWSH or PATH)')
@unittest.skipIf(os.name == 'nt', 'POSIX fake tool launchers; native Windows build is a separate check')
class WindowsBuild(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='windows-build-')
        self.root = Path(self.temp.name)/'Repo 日本 [audit] & space'
        self.root.mkdir()
        script=(ROOT/'build-all-windows.ps1').read_text(encoding='utf-8')
        self.assertIn('if (!$IsWindows)',script)
        script=script.replace('if (!$IsWindows)', 'if ($false)',1)
        (self.root/'build-all-windows.ps1').write_bytes(script.replace('\n','\r\n').encode())
        for name,data in {
            'devcel-studio/package.json':json.dumps({'version':'0.0.1','volta':{'node':'26.12.1','npm':'12.2.0'}}),
            'Cargo.toml':'[workspace.package]\nedition="2021"\n',
            'devcel-studio/src-tauri/tauri.conf.json':json.dumps({'productName':'devcel-studio','version':'0.0.1','bundle':{'resources':{'../../third-party/generated/THIRD-PARTY-NOTICES.txt':'legal/THIRD-PARTY-NOTICES.txt'}}}),
            'rust-toolchain.toml':'[toolchain]\r\nchannel = \"1.99.0\"\r\n',
            'devcel-studio/LICENSE':'GPL\r\n', 'LICENSE-NOTICE':'licenses\r\n',
            'third-party/generated/THIRD-PARTY-NOTICES.txt':'unchanged bytes\r\n',
            'third-party/generated/inventory.json':'{"packages":[]}',
            'devcel-studio/PORTABLE-WINDOWS.txt':'Portable instructions',
        }.items():
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data.encode())
        spec=importlib.util.spec_from_file_location('portable_tests',ROOT/'scripts/test-windows-portable.py')
        fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
        (self.root/'fixture.exe').write_bytes(fixture.image())
        (self.root/'scripts').mkdir()
        shutil.copyfile(ROOT/'scripts/package-windows-studio.py',self.root/'scripts/package-windows-studio.py')
        shutil.copyfile(ROOT/'scripts/legal_distribution.py',self.root/'scripts/legal_distribution.py')
        shutil.copyfile(ROOT/'scripts/studio_cli.py',self.root/'scripts/studio_cli.py')
        bindir=Path(self.temp.name)/'tools';bindir.mkdir()
        for name in ['cargo','rustc','rustup','node','npm.cmd','python','git']:
            p=bindir/name;p.write_text(TOOL);p.chmod(0o755)
        self.env={**os.environ,'FIXTURE_ROOT':str(self.root),'PATH':str(bindir)+os.pathsep+os.environ['PATH'],
            'XDG_CACHE_HOME':self.temp.name+'/cache','XDG_CONFIG_HOME':self.temp.name+'/config'}
        self.out=Path(self.temp.name)/'Output 日本 [final] & space'
    def tearDown(self): self.temp.cleanup()
    def run_build(self,*args,env=None):
        return subprocess.run([PWSH,'-NoProfile','-File',str(self.root/'build-all-windows.ps1'),
            '-OutputDirectory',str(self.out),'-NoOpen','-Distribution',*args],env={**self.env,**(env or {})},
            cwd=self.temp.name,text=True,capture_output=True)
    def test_both_configs_literal_paths_crlf_licenses(self):
        p=self.run_build('-SkipImporters');self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        build=next(self.out.glob('Build_*'))
        for mode in ['Release','Debug']:
            dest=build/f'TauriApp_{mode}'
            folders=list(dest.glob('devcel-*'));self.assertEqual(len(folders),1)
            self.assertTrue(folders[0].is_dir())
            self.assertFalse(list(dest.rglob('*.zip')))
            self.assertEqual((folders[0]/'legal/THIRD-PARTY-NOTICES.txt').read_bytes(),b'unchanged bytes\r\n')
            self.assertTrue((folders[0]/'LICENSE-STUDIO.txt').is_file())
            self.assertEqual((folders[0]/'bin/devcel.exe').read_bytes(),(self.root/'fixture.exe').read_bytes())
            self.assertEqual(json.loads((folders[0]/'bin/manifest.json').read_text())['version'],'0.0.1')
            self.assertEqual([p.name for p in folders[0].glob('*.exe')],['devcel-studio.exe'])
            self.assertEqual(len(list(dest.glob('*.exe'))),0)
            self.assertEqual(len(list(dest.glob('*.msi'))),0)
        commands=[json.loads(x) for x in (self.root/'commands.jsonl').read_text().splitlines()]
        builds=[x for x in commands if x[0]=='npm.cmd' and len(x[1])>1 and x[1][1].startswith('tauri:build')]
        self.assertEqual(len(builds),2)
        for _,argv,cwd in builds:
            self.assertEqual(argv[-3:],['--target','x86_64-pc-windows-msvc','--no-bundle'])
            self.assertEqual(Path(cwd),self.root/'devcel-studio')
    def test_nine_importers_and_source_argument(self):
        p=self.run_build('-SkipTauri','-SourceRepository','owner/repo','-SourceCommit','b'*40)
        self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        build=next(self.out.glob('Build_*'))
        self.assertEqual(len(list((build/'Importers').glob('devcel-*'))),9)
        self.assertFalse((build/'TauriApp_Release').exists())
    def commands(self):
        file = self.root/'commands.jsonl'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []
    def importer_args(self):
        return next(args for name,args,_ in reversed(self.commands())
            if name == 'python' and args and args[0] == 'scripts/package-importers.py')
    def test_github_origin_infers_repository_and_head(self):
        (self.root/'.git').mkdir()
        for origin in ['https://github.com/Owner/repo.git', 'https://github.com/Owner/repo',
            'git@github.com:Owner/repo.git', 'ssh://git@github.com/Owner/repo.git',
            'https://github.com/Owner/repo.git/', 'https://github.com/Owner/repo-name_2.0']:
            with self.subTest(origin=origin):
                p=self.run_build('-SkipTauri',env={'GIT_ORIGIN':origin})
                self.assertEqual(p.returncode,0,p.stdout+p.stderr)
                args=self.importer_args()
                expected='Owner/repo-name_2.0' if origin.endswith('repo-name_2.0') else 'Owner/repo'
                self.assertEqual(args[args.index('--source-repository')+1],expected)
                self.assertEqual(args[args.index('--source-commit')+1],'a'*40)
    def test_explicit_repository_overrides_origin(self):
        (self.root/'.git').mkdir()
        p=self.run_build('-SkipTauri','-SourceRepository','explicit/source','-SourceCommit','b'*40,
            env={'GIT_ORIGIN':'https://example.com/not-github.git'})
        self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        args=self.importer_args()
        self.assertEqual(args[args.index('--source-repository')+1],'explicit/source')
        self.assertEqual(args[args.index('--source-commit')+1],'b'*40)
        self.assertFalse(any(name=='git' for name,_,_ in self.commands()))
    def test_unsafe_or_non_github_origins_fail_closed_without_echo(self):
        (self.root/'.git').mkdir()
        for origin in ['https://example.com/owner/repo.git', 'http://github.com/owner/repo',
            'https://token@github.com/owner/repo.git', 'https://user:secret@github.com/owner/repo.git',
            'https://github.com.evil.example/owner/repo', 'https://github.com/owner/repo?secret=value',
            'https://github.com/owner/repo#fragment', 'https://github.com/owner/repo/extra',
            'ssh://secret@github.com/owner/repo', 'ssh://git:secret@github.com/owner/repo',
            'git@github.com:owner/repo.git\nhttps://github.com/other/repo', '']:
            with self.subTest(origin=origin):
                p=self.run_build('-SkipTauri',env={'GIT_ORIGIN':origin})
                self.assertNotEqual(p.returncode,0,p.stdout+p.stderr)
                self.assertIn('Cannot infer',p.stderr)
                if origin: self.assertNotIn(origin,p.stdout+p.stderr)
        self.assertFalse(self.out.exists(), 'provenance errors precede all build writes')
    def test_invalid_explicit_repository_is_not_replaced_from_origin(self):
        (self.root/'.git').mkdir()
        p=self.run_build('-SkipTauri','-SourceRepository','invalid/repo/path','-SourceCommit','b'*40)
        self.assertNotEqual(p.returncode,0)
        self.assertIn('Specify -SourceRepository',p.stderr)
        self.assertFalse(any(name=='git' for name,_,_ in self.commands()))
    def test_missing_origin_or_foreign_checkout_fails_closed(self):
        (self.root/'.git').mkdir()
        p=self.run_build('-SkipTauri',env={'FAIL_TOOL':'git','FAIL_ARG':'config'})
        self.assertNotEqual(p.returncode,0);self.assertIn('Cannot infer',p.stderr)
        p=self.run_build('-SkipTauri',env={'CHECKOUT_ROOT':self.temp.name})
        self.assertNotEqual(p.returncode,0);self.assertIn('Cannot identify this source checkout',p.stderr)
    def test_archive_cannot_borrow_parent_origin_even_with_explicit_commit(self):
        (Path(self.temp.name)/'.git').mkdir()
        p=self.run_build('-SkipTauri','-SourceCommit','b'*40)
        self.assertNotEqual(p.returncode,0);self.assertIn('Specify -SourceRepository',p.stderr)
        self.assertFalse(any(name=='git' for name,_,_ in self.commands()))
    def test_git_worktree_marker_file_is_supported(self):
        (self.root/'.git').write_text('gitdir: ../worktree-admin')
        p=self.run_build('-SkipTauri')
        self.assertEqual(p.returncode,0,p.stdout+p.stderr)
    def test_partial_importer_set_fails(self):
        p=self.run_build('-SkipTauri','-SourceRepository','owner/repo','-SourceCommit','b'*40,env={'ZIP_COUNT':'8'})
        self.assertNotEqual(p.returncode,0);self.assertIn('Expected all nine',p.stdout)
    def test_failures_propagate(self):
        for tool,arg in [('cargo','metadata'),('npm.cmd','ci'),('npm.cmd','typecheck'),('npm.cmd','tauri:build'),('rustup','target')]:
            with self.subTest(tool=tool,arg=arg):
                p=self.run_build('-SkipImporters',env={'FAIL_TOOL':tool,'FAIL_ARG':arg})
                self.assertNotEqual(p.returncode,0,p.stdout+p.stderr)
                self.assertNotIn('Build Completed Successfully',p.stdout)
    def test_stale_installer_is_never_packaged(self):
        for kind,ext in [('msi','.msi'),('nsis','.exe')]:
            d=self.root/'target [x]/x86_64-pc-windows-msvc/release/bundle'/kind;d.mkdir(parents=True)
            (d/('devcel-studio_0.0.1_old'+ext)).write_bytes(b'old')
            (d/('another-product'+ext)).write_bytes(b'unrelated')
        p=self.run_build('-SkipImporters','-Configuration','release')
        self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        self.assertEqual(len(list((self.root/'target [x]').rglob('*_old*'))),2)
        self.assertFalse(list(self.out.rglob('*.msi')))
        self.assertFalse(list(self.out.rglob('*.exe')))
        self.assertEqual(len(list((self.root/'target [x]').rglob('another-product*'))),2)
    def test_missing_executable_fails(self):
        p=self.run_build('-SkipImporters','-Configuration','release',env={'OMIT_BUILD':'1'})
        self.assertNotEqual(p.returncode,0);self.assertIn('No standalone executable',p.stdout)
    def test_portable_packaging_failure_propagates(self):
        p=self.run_build('-SkipImporters',env={'FAIL_TOOL':'python','FAIL_ARG':str(self.root/'scripts/package-windows-studio.py')})
        self.assertNotEqual(p.returncode,0);self.assertIn('Portable Studio packaging failed',p.stdout)
    def test_archive_cannot_inherit_enclosing_git_head(self):
        p=self.run_build('-SkipTauri','-SourceRepository','owner/repo')
        self.assertNotEqual(p.returncode,0);self.assertIn('source archive',p.stderr)
    def test_no_build_rejected(self):
        p=self.run_build('-SkipTauri','-SkipImporters')
        self.assertNotEqual(p.returncode,0);self.assertIn('at least one',p.stderr)
    def test_wrong_rust_version_rejected(self):
        p=self.run_build('-SkipImporters',env={'RUST_VERSION':'1.98.0'})
        self.assertNotEqual(p.returncode,0);self.assertIn('Rust 1.99.0 is required',p.stdout)
    def test_importer_command_failure_propagates(self):
        p=self.run_build('-SkipTauri','-SourceRepository','owner/repo','-SourceCommit','b'*40,
            env={'FAIL_TOOL':'python','FAIL_ARG':'scripts/package-importers.py'})
        self.assertNotEqual(p.returncode,0);self.assertIn('Importer packaging failed',p.stdout)
    def test_clean_external_and_junction_target_rejected(self):
        external=Path(self.temp.name)/'external';external.mkdir()
        keep=external/'keep';keep.write_text('safe')
        p=self.run_build('-SkipImporters','-Clean',env={'CUSTOM_TARGET':str(external)})
        self.assertNotEqual(p.returncode,0);self.assertTrue(keep.exists())
        (self.root/'linked').symlink_to(external,target_is_directory=True)
        p=self.run_build('-SkipImporters','-Clean',env={'CUSTOM_TARGET':str(self.root/'linked')})
        self.assertNotEqual(p.returncode,0);self.assertTrue(keep.exists())
        self.assertIn('junction or symbolic link',p.stdout)
    def test_native_guard_is_retained(self):
        p=subprocess.run([PWSH,'-NoProfile','-File',str(ROOT/'build-all-windows.ps1'),'-SkipImporters'],env=self.env,text=True,capture_output=True)
        self.assertNotEqual(p.returncode,0);self.assertIn('native Windows',p.stderr)

if __name__=='__main__': unittest.main()
