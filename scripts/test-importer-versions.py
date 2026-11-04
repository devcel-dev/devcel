import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import sys
import os
import hashlib

import importer_versions as versions

ROOT = Path(__file__).resolve().parents[1]


LAUNCHER_CHECK = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
let probes = 0;
// Resolving the bundled binary must not execute a software-version probe.
require('node:child_process').execFile = (file, args, options, done) => {
  probes++; throw new Error('unexpected CLI probe');
};
const resolver = require(process.argv[1]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-launcher-version-'));
(async () => {
  try {
    const rid = ({win32:'win',linux:'linux',darwin:'osx'})[process.platform]+'-'+process.arch;
    const executable = rid+'/'+(process.platform==='win32'?'devcel.exe':'devcel');
    const binary = Buffer.from('isolated non-executable resolver fixture');
    fs.mkdirSync(path.join(root,'bin',rid), {recursive:true});
    fs.writeFileSync(path.join(root,'bin',executable), binary);
    const manifest = {schema_version:1, version:'hoge', supportedPlatforms:[rid],
      binaries:{[rid]:{path:executable,sha256:crypto.createHash('sha256').update(binary).digest('hex')}}};
    const write = () => fs.writeFileSync(path.join(root,'bin/manifest.json'), JSON.stringify(manifest));
    write();
    assert.equal(fs.realpathSync.native(await resolver.prepareCli(root)), fs.realpathSync.native(path.join(root,'bin',executable)));
    assert.equal(probes, 0);
    const previous = probes;
    manifest.binaries[rid].sha256 = '0'.repeat(64); write();
    await assert.rejects(() => resolver.prepareCli(root));
    assert.equal(probes, previous, 'wrong digest must fail before process execution');
  } finally { fs.rmSync(root, {recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode=1; });
"""


class VersionTests(unittest.TestCase):
    def test_unreal_numeric_version_is_generated_and_checked(self):
        for version, code in [('0.0.0', 0), ('0.0.8', 8), ('2.3.4-rc.1', 2003004)]:
            self.assertEqual(versions.unreal_version_code(version), code)
        for version in ('1.1000.0', '1.0.1000', '2148.0.0'):
            with self.assertRaises(ValueError): versions.unreal_version_code(version)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'Devcel.uplugin').write_text(json.dumps({'VersionName':'0.0.8', 'Version':7}))
            with self.assertRaisesRegex(ValueError, 'numeric'): versions.verify_payload(root, 'unreal', '0.0.8')

    def test_actual_packager_validates_canonical_version_before_staging(self):
        import importlib.util
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('packager_entry_contract', ROOT/'scripts/package-importers.py')
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        current = json.loads((ROOT/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
        class StagingReached(Exception):
            pass
        with tempfile.TemporaryDirectory() as directory:
            argv = ['package-importers.py', '--repo', str(ROOT), '--out', str(Path(directory)/'out'),
                    '--source-repository', 'example/repo', '--source-commit', 'a'*40]
            with patch.object(sys, 'argv', argv), \
                    patch.object(packager, 'copy_sources', side_effect=StagingReached), \
                    patch.object(packager, 'run', side_effect=AssertionError('No compiler expected')):
                with self.assertRaises(StagingReached):
                    packager.main()

    def test_clean_package_contracts_and_negative_drift(self):
        current = json.loads((ROOT/'devcel-studio/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
        self.assertEqual(versions.check_packaged_versions(ROOT, current), 9)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for engine in versions.ENGINES:
                stage = root/engine
                for name, raw in versions.payload_files(ROOT, engine).items():
                    target = stage/name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(raw)
                versions.verify_payload(stage, engine, current)
                if not versions.payload_files(ROOT, engine): continue
                victim = next(path for path in stage.rglob('*') if path.is_file() and current.encode() in path.read_bytes())
                victim.write_bytes(victim.read_bytes().replace(current.encode(), b'99.0.0'))
                with self.assertRaises(ValueError): versions.verify_payload(stage, engine, current)

    @unittest.skipUnless(sys.platform == 'win32' and shutil.which('pwsh'), 'Windows PowerShell launcher test')
    def test_actual_powershell_launch_ignores_manifest_version(self):
        compiler = Path(os.environ.get('WINDIR', ''))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        if not compiler.is_file():
            self.skipTest('Installed .NET Framework compiler unavailable')
        with tempfile.TemporaryDirectory(prefix='devcel-launcher-version-') as directory:
            root = Path(directory)
            calls = root/'calls.txt'
            code = ('using System; using System.IO; class Probe { static int Main(string[] args) {'
                    'File.AppendAllText('+json.dumps(str(calls))+',String.Join("|",args)+"\\n");'
                    'if(args.Length==1 && args[0]==\"--version\") return 9; Console.WriteLine(String.Join(\"|\",args));'
                    'return 0; }}')
            source = root/'Probe.cs'
            source.write_text(code, encoding='utf-8')
            binary = root/'probe.exe'
            subprocess.run([str(compiler), '/nologo', '/out:'+str(binary), str(source)], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for engine, script, bin_directory, argument in (
                ('wolf', 'Tools/StartImporter.ps1', 'Tools/bin', '-TitleRoot'),
                ('gamemaker', 'importer.ps1', 'tools', '-Root'),
            ):
                sdk = root/engine
                launcher = sdk/script
                launcher.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT/'importers'/engine/script, launcher)
                executable = sdk/bin_directory/'win-x64/devcel.exe'
                executable.parent.mkdir(parents=True)
                shutil.copyfile(binary, executable)
                title = sdk/'Game with spaces'
                (title/'Data').mkdir(parents=True)
                manifest = {'schema_version':1, 'version':'hoge', 'supportedPlatforms':['win-x64'],
                            'binaries':{'win-x64':{'path':'win-x64/devcel.exe',
                            'sha256':hashlib.sha256(executable.read_bytes()).hexdigest()}}}
                manifest_path = sdk/bin_directory/'manifest.json'
                manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
                command = [shutil.which('pwsh'), '-NoProfile', '-NonInteractive', '-File', str(launcher), argument, str(title)]
                result = subprocess.run(command, text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                args = result.stdout.strip().splitlines()[-1].split('|')
                self.assertEqual(args[:4], ['importer-ui', '--engine', engine, '--root'])
                self.assertEqual(len(args), 5)
                self.assertTrue(os.path.samefile(args[4], title), 'launcher must receive the exact title directory')
                self.assertNotIn(b'--version', calls.read_bytes())
                before = calls.read_bytes()
                manifest['binaries']['win-x64']['sha256'] = '0'*64
                manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
                rejected = subprocess.run(command, text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=15)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertEqual(calls.read_bytes(), before, 'hash rejection must precede executable invocation')


    @unittest.skipUnless(sys.platform == 'win32', 'Windows 8.3 path alias regression')
    def test_windows_short_temp_alias_keeps_real_launcher_contracts(self):
        import ctypes
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(prefix='devcel short alias regression ') as directory:
            buffer = ctypes.create_unicode_buffer(32768)
            size = ctypes.windll.kernel32.GetShortPathNameW(directory, buffer, len(buffer))
            self.assertGreater(size, 0, 'GetShortPathNameW must succeed for the owned fixture')
            short = buffer.value
            if short == directory:
                self.skipTest('This volume does not expose an 8.3 alias')
            self.assertTrue(os.path.samefile(short, directory))
            self.assertNotEqual(short, str(Path(short).resolve()))
            # Exercise actual resolvers and launchers through the alias, preserving
            # path identity, ignored version metadata, and digest rejection checks.
            with patch.dict(os.environ, {'TMP': short, 'TEMP': short}), \
                    patch.object(tempfile, 'tempdir', short):
                self.test_native_resolvers_ignore_manifest_version_without_probing()
                self.test_actual_powershell_launch_ignores_manifest_version()

    def test_native_resolvers_ignore_manifest_version_without_probing(self):
        for engine, relative in [('javascript', 'editor/cli.cjs'), ('cocos', 'editor/cli.cjs'),
                                 ('rpgmaker', 'js/plugins/devcel/editor.js')]:
            with self.subTest(engine=engine):
                subprocess.run(['node', '-e', LAUNCHER_CHECK, str(ROOT/'importers'/engine/relative)], check=True)


if __name__ == '__main__':
    unittest.main()
