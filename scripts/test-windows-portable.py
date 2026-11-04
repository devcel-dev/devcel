#!/usr/bin/env python3
"""Portable ZIP/PE regression fixtures; these do not launch Windows."""
import importlib.util
import json
import hashlib
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile
import os

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('portable',ROOT/'scripts/package-windows-studio.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)


def image(dll=b'KERNEL32.dll', delay=False):
    data=bytearray(2048);data[:2]=b'MZ';struct.pack_into('<I',data,0x3c,0x80)
    data[0x80:0x84]=b'PE\0\0'
    struct.pack_into('<HHIIIHH',data,0x84,0x8664,1,0,0,0,240,2)
    opt=0x98;struct.pack_into('<H',data,opt,0x20b)
    struct.pack_into('<Q',data,opt+24,0x140000000)
    struct.pack_into('<I',data,opt+108,16)
    struct.pack_into('<II',data,opt+112+(13 if delay else 1)*8,0x1000,64 if delay else 40)
    struct.pack_into('<IIII',data,opt+240+8,1536,0x1000,1536,512)
    if delay:struct.pack_into('<IIIIIIII',data,512,1,0x1100,0,0,0,0,0,0)
    else:struct.pack_into('<IIIII',data,512,0,0,0,0x1100,0)
    data[768:768+len(dll)+1]=dll+b'\0'
    return bytes(data)


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.exe=self.root/'original.exe';self.exe.write_bytes(image())
        for name, content in {'devcel-studio/LICENSE':b'GPL\r\n','LICENSE-NOTICE':b'Notice\r\n',
                'devcel-studio/PORTABLE-WINDOWS.txt':b'Instructions\r\n',
                'third-party/generated/THIRD-PARTY-NOTICES.txt':b'fixture: example 1\nLicense\r\n',
                'third-party/generated/inventory.json':json.dumps({'packages':[{'ecosystem':'fixture','name':'example','version':'1','texts':[{'file':'licenses/example/LICENSE','sha256':hashlib.sha256(b'License\r\n').hexdigest()}]}]}).encode(),
                'third-party/generated/licenses/example/LICENSE':b'License\r\n'}.items():
            target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
        self.config=self.root/'devcel-studio/src-tauri/tauri.conf.json';self.config.parent.mkdir(parents=True)
        self.config.write_text(json.dumps({'bundle':{'resources':{'../../third-party/generated/THIRD-PARTY-NOTICES.txt':'legal/THIRD-PARTY-NOTICES.txt'}}}))
        self.archive=self.root/'studio.zip'
        (self.root/'devcel-studio/package.json').write_text(json.dumps({'version':'0.0.3'}))
        cli=self.root/'devcel-studio/src-tauri/bundled-cli';cli.mkdir()
        (cli/'devcel.exe').write_bytes(image())
        (cli/'LICENSE-CLI.txt').write_bytes(b'MIT\n')
        (cli/'manifest.json').write_text(json.dumps({'schema_version':1,'version':'0.0.3','platform':'win-x64','executable':'devcel.exe','sha256':hashlib.sha256(image()).hexdigest(),'source_commit':'a'*40}))
    def tearDown(self):self.temp.cleanup()
    def build(self):return p.package(self.exe,self.archive,self.root,build_epoch=1792897201)
    def alter(self, modify):
        with zipfile.ZipFile(self.archive) as source:items={i.filename:source.read(i) for i in source.infolist()}
        modify(items)
        with zipfile.ZipFile(self.archive,'w') as out:
            for name,data in items.items():out.writestr(name,data)
    def test_exact_full_payload_and_crlf(self):
        report=self.build();self.assertEqual(report['payload_files'],8)
        self.assertEqual(p.verify_archive(self.archive,self.exe,self.root)['external_system_dlls'],['kernel32.dll'])
        with zipfile.ZipFile(self.archive) as z:
            self.assertEqual(z.read('LICENSE-STUDIO.txt'),b'GPL\r\n')
            self.assertEqual(z.read('devcel-studio.exe'),self.exe.read_bytes())
            self.assertFalse(any(n.endswith(('.dll','.msi')) for n in z.namelist()))
    def test_deterministic_zip(self):
        self.build();first=self.archive.read_bytes();self.build();self.assertEqual(first,self.archive.read_bytes())
    def test_directory_payload_timestamp_and_tampering(self):
        directory=self.root/'expanded'
        report=p.package(self.exe,directory,self.root,output_format='directory',build_epoch=1792897201)
        self.assertEqual(report['format'],'windows-portable-directory')
        self.assertFalse(list(directory.rglob('*.zip')))
        for path in directory.rglob('*'): self.assertEqual(int(path.stat().st_mtime),1792897201)
        p.verify_directory(directory,self.exe,self.root)
        (directory/'README.txt').write_bytes(b'altered')
        with self.assertRaisesRegex(ValueError,'bytes differ'):p.verify_directory(directory,self.exe,self.root)
        with self.assertRaisesRegex(ValueError,'already exists'):
            p.package(self.exe,directory,self.root,output_format='directory')

    def test_zip_timestamp_utc_two_second_precision(self):
        import time
        self.build()
        with zipfile.ZipFile(self.archive) as z:
            for entry in z.infolist():
                self.assertEqual(entry.date_time,time.gmtime(1792897200)[:6])
        self.assertEqual(int(self.archive.stat().st_mtime),1792897201)

    def test_any_changed_byte_fails(self):
        for name in ('devcel-studio.exe','legal/THIRD-PARTY-NOTICES.txt','README.txt'):
            self.build();self.alter(lambda d:d.update({name:d[name]+b'x'}))
            with self.assertRaisesRegex(ValueError,'bytes differ'):p.verify_archive(self.archive,self.exe,self.root)
    def test_missing_and_extra_files_fail(self):
        for change in (lambda d:d.pop('LICENSE-NOTICE'),lambda d:d.update({'vendor.dll':b'MZ'}),lambda d:d.update({'../escape':b'bad'})):
            self.build();self.alter(change)
            with self.assertRaisesRegex(ValueError,'file list'):p.verify_archive(self.archive,self.exe,self.root)
    def test_duplicate_file_rejected(self):
        self.build()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',UserWarning)
            with zipfile.ZipFile(self.archive,'a') as z:z.writestr('README.txt',b'Instructions\r\n')
        with self.assertRaisesRegex(ValueError,'file list'):p.verify_archive(self.archive,self.exe,self.root)
    def test_symlink_input_rejected(self):
        self.exe.unlink()
        try:self.exe.symlink_to(self.root/'LICENSE-NOTICE')
        except OSError:self.skipTest('Symlink creation is unavailable')
        with self.assertRaisesRegex(ValueError,'linked'):self.build()
    def test_missing_legal_inventory_rejected(self):
        (self.root/'third-party/generated/inventory.json').unlink()
        with self.assertRaises(FileNotFoundError):self.build()
    def test_resource_change_requires_review(self):
        self.config.write_text(json.dumps({'bundle':{'resources':{'new':'new'}}}))
        with self.assertRaisesRegex(ValueError,'resource mapping'):self.build()
    def test_missing_original_text_rejected(self):
        (self.root/'third-party/generated/THIRD-PARTY-NOTICES.txt').write_bytes(b'fixture: example 1\n')
        with self.assertRaisesRegex(ValueError,'text missing'):self.build()
    def test_changed_original_evidence_rejected(self):
        (self.root/'third-party/generated/licenses/example/LICENSE').write_bytes(b'altered')
        with self.assertRaises(ValueError):self.build()
    def test_sidecar_change_requires_review(self):
        config=json.loads(self.config.read_text());config['bundle']['externalBin']=['sidecar'];self.config.write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError,'sidecars'):self.build()
    def test_unreviewed_external_dlls_rejected(self):
        for dll in (b'VCRUNTIME140.dll',b'MSVCP140.dll',b'WebView2Loader.dll',b'custom.dll'):
            for delay in (False,True):
                with self.subTest(dll=dll,delay=delay):
                    with self.assertRaisesRegex(ValueError,'Unreviewed external'):p.pe_imports(image(dll,delay))
    def test_os_combase_import_is_allowed_but_namesakes_are_not(self):
        for delay in (False,True):
            self.assertEqual(p.pe_imports(image(b'ComBase.dll',delay)),['combase.dll'])
            with self.assertRaisesRegex(ValueError,'Unreviewed external'):
                p.pe_imports(image(b'combase-vendor.dll',delay))

    def test_system_delay_and_api_imports(self):
        for name in (b'USER32.dll',b'api-ms-win-core-file-l1-1-0.dll'):
            self.assertEqual(p.pe_imports(image(name,True)),[name.decode().lower()])
    def test_invalid_pe_rejected(self):
        for data in (b'MZ',b'not PE',image()[:600]):
            with self.assertRaises(ValueError):p.pe_imports(data)
    def test_wrong_architecture_rejected(self):
        data=bytearray(image());struct.pack_into('<H',data,0x84,0x14c)
        with self.assertRaisesRegex(ValueError,'x64'):p.pe_imports(data)
    def test_import_rva_escape_rejected(self):
        data=bytearray(image());struct.pack_into('<I',data,524,0x5000)
        with self.assertRaisesRegex(ValueError,'outside'):p.pe_imports(data)
    def test_native_extractor_rejects_path_escape_and_symlink(self):
        spec=importlib.util.spec_from_file_location('artifacts',ROOT/'scripts/check-native-release-artifacts.py')
        artifacts=importlib.util.module_from_spec(spec);spec.loader.exec_module(artifacts)
        target=self.root/'extract';target.mkdir()
        for name in ('../escape','/absolute','dir\\escape'):
            with zipfile.ZipFile(self.archive,'w') as z:
                entry=zipfile.ZipInfo('placeholder');entry.filename=name
                z.writestr(entry,b'bad')
            with self.assertRaisesRegex(RuntimeError,'Unsafe'):artifacts.extract(self.archive,target)
        with zipfile.ZipFile(self.archive,'w') as z:
            entry=zipfile.ZipInfo('link');entry.external_attr=(stat.S_IFLNK|0o777)<<16
            z.writestr(entry,'../outside')
        with self.assertRaisesRegex(RuntimeError,'Unsafe'):artifacts.extract(self.archive,target)

    def test_real_legal_tree_passes_native_gate_with_fixture_exe(self):
        # This exercises the shipping gate with the real legal inputs. The PE
        # image is synthetic and is never presented as an actual Studio build.
        self.exe.write_bytes(image())
        with patch.object(p.studio_cli,'DIRECTORY',str(self.root/'devcel-studio/src-tauri/bundled-cli')):
            p.package(self.exe,self.archive,ROOT)
        spec=importlib.util.spec_from_file_location('artifacts',ROOT/'scripts/check-native-release-artifacts.py')
        artifacts=importlib.util.module_from_spec(spec);spec.loader.exec_module(artifacts)
        extracted=self.root/'extracted';extracted.mkdir();artifacts.extract(self.archive,extracted)
        manifest=json.loads((ROOT/'third-party/native-distributions/windows.json').read_text())
        files,errors=artifacts.native.verify(extracted,manifest,[self.exe,self.root/'devcel-studio/src-tauri/bundled-cli/devcel.exe'],'.zip')
        self.assertEqual(errors,[]);self.assertEqual(len(files),2)
        self.assertEqual(files[0]['first_party_identity']['transformation'],'exact')

    def test_bundler_marker_is_not_rewritten(self):
        self.exe.write_bytes(image()+b'__TAURI_BUNDLE_TYPE_VAR_UNK');self.build()
        self.alter(lambda d:d.update({'devcel-studio.exe':d['devcel-studio.exe'].replace(b'_UNK',b'_NSS')}))
        with self.assertRaisesRegex(ValueError,'bytes differ'):p.verify_archive(self.archive,self.exe,self.root)

    def test_cli_identity_tampering_and_unrelated_sidecars_fail_closed(self):
        directory=self.root/'devcel-studio/src-tauri/bundled-cli'
        path=directory/'manifest.json';original=path.read_bytes()
        for key,value in [('platform','linux-x64'),('executable','../other.exe'),('sha256','0'*64),('source_commit','bad')]:
            manifest=json.loads(original);manifest[key]=value;path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'mismatch'):self.build()
        path.write_bytes(original)
        extra=directory/'unrelated.exe';extra.write_bytes(image())
        with self.assertRaisesRegex(ValueError,'allowlist'):self.build()
        extra.unlink();self.build()
        self.alter(lambda items:items.update({'bin/devcel.exe':b'tampered'}))
        with self.assertRaisesRegex(ValueError,'bytes differ'):p.verify_archive(self.archive,self.exe,self.root)

    def test_cli_build_flags_preserve_encoded_precedence_and_restore(self):
        original={'RUSTFLAGS':'-D warnings','CARGO_ENCODED_RUSTFLAGS':'--remap-path-prefix=C:\\build root=src\x1f-D\x1fwarnings'}
        with patch.dict(os.environ,original):
            with p.studio_cli.build_flags('win-x64'):
                self.assertEqual(os.environ['CARGO_ENCODED_RUSTFLAGS'],original['CARGO_ENCODED_RUSTFLAGS']+'\x1f-C\x1ftarget-feature=+crt-static')
                self.assertEqual(os.environ['RUSTFLAGS'],'-D warnings -C target-feature=+crt-static')
            for key,value in original.items():self.assertEqual(os.environ[key],value)
            with p.studio_cli.build_flags('linux-x64'):
                for key,value in original.items():self.assertEqual(os.environ[key],value)

    def test_cli_staging_uses_relative_resource_mapping_and_exact_three_files(self):
        release=self.root/'target/release';release.mkdir(parents=True)
        (release/'devcel.exe').write_bytes(image())
        (self.root/'devcel-cli').mkdir();(self.root/'devcel-cli/LICENSE').write_bytes(b'MIT\n')
        (self.root/'scripts').mkdir()
        (self.root/'scripts/tauri-release.conf.json').write_text(json.dumps({'build':{'beforeBuildCommand':'canonical frontend hook'}}))
        with patch.object(p.studio_cli.subprocess,'check_output',return_value='b'*40),patch.object(p.studio_cli,'smoke') as smoke:
            config_path=p.studio_cli.stage(self.root,self.root/'target','win-x64')
        config=json.loads(config_path.read_text())
        self.assertEqual(config['build']['beforeBuildCommand'],'canonical frontend hook')
        self.assertEqual(config['bundle']['resources'],{'../../third-party/generated/THIRD-PARTY-NOTICES.txt':'legal/THIRD-PARTY-NOTICES.txt','bundled-cli/':'bin/'})
        self.assertNotIn(str(self.root),config_path.read_text())
        manifest=p.studio_cli.validate(self.root/p.studio_cli.DIRECTORY,'win-x64','b'*40)
        self.assertEqual(manifest['sha256'],hashlib.sha256(image()).hexdigest())
        smoke.assert_not_called()

    def test_cli_smoke_ignores_manifest_version_and_only_probes_pull_help(self):
        directory = self.root/p.studio_cli.DIRECTORY
        path = directory/'manifest.json'
        manifest = json.loads(path.read_text())
        manifest['version'] = 'hoge'
        path.write_text(json.dumps(manifest))
        result = p.studio_cli.subprocess.CompletedProcess([], 0, stdout='--config --source --status')
        with patch.object(p.studio_cli.subprocess, 'run', return_value=result) as run:
            self.assertEqual(p.studio_cli.smoke(directory, 'win-x64')['version'], 'hoge')
        self.assertEqual(run.call_args.args[0][1:], ['pull', '--help'])


if __name__=='__main__':unittest.main()
