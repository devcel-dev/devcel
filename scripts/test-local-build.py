"""Local staging and native Windows build-routing regressions; no product compilation."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_build', ROOT/'scripts/local_build.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


class StagingTests(unittest.TestCase):
    def test_local_payloads_keep_all_nine_importers_and_binaries(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ('devcel.exe', 'devcel_runtime.dll', 'devcel-studio.exe'):
                (root/name).write_bytes(b'local native fixture: '+name.encode())
            out = root/'importers'
            local.stage(ROOT, root, out, 'importers')
            self.assertEqual(len(list(out.iterdir())), 9)
            self.assertFalse(list(out.rglob('cli-source.tar.gz')))
            for engine, (relative, tools) in local.LAYOUTS.items():
                dest = next(out.glob('devcel-'+engine+'-*'))/relative
                self.assertTrue((dest/tools/'win-x64/devcel.exe').is_file())
                manifest = json.loads((dest/tools/'manifest.json').read_text())
                self.assertEqual(manifest['binaries']['win-x64']['path'], 'win-x64/devcel.exe')
                self.assertEqual(manifest['binaries']['win-x64']['sha256'], local.digest(root/'devcel.exe'))
                self.assertTrue((dest/'ThirdPartyNotices/THIRD-PARTY-NOTICES.txt').is_file())
            unity = next(out.glob('devcel-unity-*'))/'devcel-unity'
            manifest = json.loads((unity/'Tools~/manifest.json').read_text())
            self.assertEqual(manifest['native_runtime']['sha256'], local.digest(root/'devcel_runtime.dll'))
            self.assertEqual(manifest['source_fingerprint'], json.loads((unity/'Editor/NativeRequirements.json').read_text())['source_fingerprint'])
            local.stage(ROOT, root, root/'studio', 'studio')
            self.assertEqual((root/'studio/bin/devcel.exe').read_bytes(), (root/'devcel.exe').read_bytes())
            self.assertTrue((root/'studio/legal/THIRD-PARTY-NOTICES.txt').is_file())
            import studio_cli
            manifest = studio_cli.validate(root/'studio/bin', 'win-x64')
            self.assertEqual(set(manifest), {'schema_version','version','platform','executable','sha256','source_commit'})
            with self.assertRaisesRegex(ValueError, 'empty'):
                local.stage(ROOT, root, root/'studio', 'studio')

    def test_archive_cannot_borrow_enclosing_checkout_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp)
            subprocess.run(['git', 'init', str(parent)], check=True, capture_output=True)
            archive = parent/'source-archive'
            archive.mkdir()
            with patch.object(local.subprocess, 'check_output') as git:
                with self.assertRaisesRegex(ValueError, 'Source archives require'):
                    local.source_revision(archive)
                git.assert_not_called()
            self.assertEqual(local.source_revision(archive, 'a'*40), 'a'*40)
            with self.assertRaisesRegex(ValueError, 'full source commit'):
                local.source_revision(archive, 'short')
            (archive/'.git').write_text('gitdir: ../.git')
            with patch.object(local.subprocess, 'check_output', return_value=str(parent)):
                with self.assertRaisesRegex(ValueError, 'enclosing checkout'):
                    local.source_revision(archive)

    def test_missing_native_binary_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(FileNotFoundError):
                local.stage(ROOT, Path(temp), Path(temp)/'out', 'importers')

    @unittest.skipUnless(os.name == 'nt' and shutil.which('pwsh'), 'Native Windows PowerShell required')
    def test_default_build_routes_without_release_tools_or_remote_source_links(self):
        with tempfile.TemporaryDirectory(prefix='devcel local [x] ') as temp:
            root = Path(temp)
            (root/'scripts').mkdir()
            (root/'devcel-studio/src-tauri').mkdir(parents=True)
            shutil.copyfile(ROOT/'build-all-windows.ps1', root/'build-all-windows.ps1')
            (root/'rust-toolchain.toml').write_text('[toolchain]\nchannel="1.99.0"\n')
            (root/'devcel-studio/package.json').write_text(json.dumps({'volta':{'node':'26.12.1','npm':'12.2.0'}}))
            (root/'devcel-studio/src-tauri/tauri.conf.json').write_text('{"version":"0.0.4"}')
            tool = root/'tool.py'
            tool.write_text('''import json,sys,os
from pathlib import Path
root=Path(os.environ['LOCAL_FIXTURE']); name=sys.argv[1]; args=sys.argv[2:]
with (root/'calls.jsonl').open('a') as f: f.write(json.dumps([name,args])+'\\n')
if name=='cargo':
 if args[0]=='metadata': print(json.dumps({'target_directory':str(root/'target')}))
 elif args[0]=='build':
  mode='release' if '--release' in args else 'debug'; dest=root/'target/x86_64-pc-windows-msvc'/mode;dest.mkdir(parents=True,exist_ok=True)
  for n in ('devcel.exe','devcel_runtime.dll'): (dest/n).write_bytes(b'fixture')
 else: sys.exit('Unexpected cargo operation')
elif name=='rustc': print('rustc 1.99.0')
elif name=='node': print('v26.12.1')
elif name=='npm':
 if args==['--version']: print('12.2.0')
 elif len(args)>1 and args[1].startswith('tauri:build'):
  mode='debug' if args[1].endswith(':debug') else 'release';dest=root/'target/x86_64-pc-windows-msvc'/mode;dest.mkdir(parents=True,exist_ok=True);(dest/'devcel-studio.exe').write_bytes(b'fixture')
elif name=='python':
 if args[0]=='-c': print('devcel-python-ready')
 elif Path(args[0]).name=='generate-third-party-notices.py':
  assert args[1:]==['--ensure']
 elif Path(args[0]).name=='local_build.py':
  out=Path(args[args.index('--out')+1]);out.mkdir(parents=True,exist_ok=True)
  if args[1]=='importers':
   for i in range(9): (out/('devcel-'+str(i))).mkdir()
 else: sys.exit('Distribution Python tool called in local mode')
elif name=='git': sys.exit('Git must not be needed for local build')
''')
            tools = root/'tools'; tools.mkdir()
            for name in ('cargo','rustc','rustup','node','npm','python','git'):
                (tools/(name+'.cmd')).write_text('@echo off\n"'+sys.executable+'" "'+str(tool)+'" '+name+' %*\n', encoding='ascii')
            env = {**os.environ, 'PATH':str(tools)+os.pathsep+os.environ['PATH'], 'LOCAL_FIXTURE':str(root)}
            result = subprocess.run([shutil.which('pwsh'), '-NoProfile', '-File', str(root/'build-all-windows.ps1'), '-OutputDirectory', str(root/'out'), '-NoOpen'], env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            calls = [json.loads(line) for line in (root/'calls.jsonl').read_text().splitlines()]
            self.assertFalse(any(name=='git' for name,args in calls))
            cargo = [args for name,args in calls if name=='cargo' and args[0]=='build']
            self.assertEqual(len(cargo), 2)
            self.assertTrue(all('-p' in args and 'devcel-runtime' in args and 'devcel-cli' in args for args in cargo))
            self.assertEqual([args for name,args in calls if name=='python' and Path(args[0]).name=='generate-third-party-notices.py'], [['scripts/generate-third-party-notices.py', '--ensure']])
            staging = [args for name,args in calls if name=='python' and Path(args[0]).name=='local_build.py']
            self.assertEqual([args[1] for args in staging], ['importers','importers','studio','studio'])
            tauri = [args for name,args in calls if name=='npm' and len(args)>1 and args[1].startswith('tauri:build')]
            self.assertEqual(len(tauri), 2)
            self.assertTrue(all(Path(args[-1]) == root/'scripts/tauri-local.conf.json' for args in tauri))
            # Explicit distribution mode must still enter the strict packager and propagate failure.
            result = subprocess.run([shutil.which('pwsh'), '-NoProfile', '-File', str(root/'build-all-windows.ps1'),
                '-OutputDirectory', str(root/'distribution-out'), '-NoOpen', '-Distribution', '-SkipTauri',
                '-SourceRepository', 'owner/repo', '-SourceCommit', 'a'*40],
                env=env, capture_output=True, text=True, timeout=60)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Importer packaging failed', result.stdout)
            calls = [json.loads(line) for line in (root/'calls.jsonl').read_text().splitlines()]
            self.assertTrue(any(name=='python' and args[0]=='scripts/package-importers.py' for name,args in calls))



if __name__ == '__main__':
    unittest.main()
