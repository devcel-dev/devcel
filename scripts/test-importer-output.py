"""Byte-only importer packaging regression; never executes CLI or native binaries."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
import time
import json
import shutil
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('packager', Path(__file__).with_name('package-importers.py'))
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)

class ImporterOutputTests(unittest.TestCase):
    def test_nine_layouts_in_both_formats(self):
        layouts = {'unity':'devcel-unity/Tools~','godot':'addons/devcel/bin',
            'unreal':'Plugins/Devcel/Tools','rpgmaker':'js/plugins/devcel/bin',
            'wolf':'devcel-wolf/Tools/bin','gamemaker':'devcel-gamemaker/tools',
            'defold':'devcel/tools','cocos':'devcel-cocos/bin','javascript':'devcel-javascript/bin'}
        for engine, tools in layouts.items():
            for output_format in ('directory','zip'):
                with self.subTest(engine=engine, output_format=output_format), tempfile.TemporaryDirectory() as temp:
                    root=Path(temp); stage=root/'stage'; stage.mkdir()
                    inputs={tools+'/win-x64/devcel.exe': b'fixture only - not executable',
                        tools+'/manifest.json':b'{"fixture":true}', tools+'/LICENSE-CLI-MIT.txt':b'Original\r\n',
                        tools+'/cli-source.tar.gz':b'source fixture', 'INSTALL.txt':b'instructions',
                        'ThirdPartyNotices/THIRD-PARTY-NOTICES.txt':b'copyright and NOTICE\r\n'}
                    if engine=='unity': inputs['devcel-unity/Plugins/Windows/x86_64/devcel_runtime.dll']=b'native fixture'
                    for name,data in inputs.items():
                        target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
                    package=p.prepare_payload(stage,root,engine,'devcel.exe',output_format,1792897201)
                    if output_format=='directory':
                        self.assertTrue(package.is_dir())
                        for name,data in inputs.items(): self.assertEqual((package/name).read_bytes(),data)
                        self.assertFalse(list(root.glob('*.zip')))
                    else:
                        with zipfile.ZipFile(package) as archive:
                            self.assertEqual(set(archive.namelist()),set(inputs))
                            for name,data in inputs.items(): self.assertEqual(archive.read(name),data)
                            for entry in archive.infolist():
                                self.assertEqual(entry.date_time,time.gmtime(1792897200)[:6])
                            self.assertEqual(archive.getinfo(tools+'/win-x64/devcel.exe').external_attr>>16 & 0o777,0o755)
                        self.assertEqual(int(package.stat().st_mtime),1792897201)
                    with self.assertRaisesRegex(RuntimeError,'already exists'):
                        p.prepare_payload(stage,root,engine,'devcel.exe',output_format,1792897201)
    def test_bad_upstream_evidence_fails_before_native_build(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'scripts').mkdir()
            shutil.copyfile(Path(__file__).with_name('generate-third-party-notices.py'), root/'scripts/generate-third-party-notices.py')
            evidence = root/'third-party/upstream/LICENSE.md'
            evidence.parent.mkdir(parents=True)
            evidence.write_bytes(b'changed original')
            (root/'third-party/cargo-upstream.json').write_text(json.dumps({
                'dependency@1': [{'path':'third-party/upstream/LICENSE.md', 'sha256':'a'*64}]}))
            argv = ['package-importers.py','--repo',str(root),'--out',str(root/'out'),
                    '--platform',p.host_platform(),'--source-repository','owner/repo','--source-commit','b'*40]
            with patch.object(sys, 'argv', argv), patch.object(p, 'verify_unity_version', return_value='0.0.4'), \
                 patch.object(p, 'verify_unity_toolchain'), patch.object(p, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch.*expected=.*actual='):
                    p.main()
                run.assert_not_called()
            self.assertFalse((root/'out').exists())

    def test_invalid_format_is_not_silently_a_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with self.assertRaises(ValueError): p.prepare_payload(root,root,'bad','devcel.exe','other',1792897201)

if __name__=='__main__': unittest.main()
