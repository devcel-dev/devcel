"""Exercise the real Windows 5.1 entry and cmd launcher without compiling products."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PWSH = shutil.which('pwsh')
LEGACY = Path(os.environ.get('SystemRoot', 'C:/Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'

@unittest.skipUnless(os.name == 'nt' and PWSH and LEGACY.exists(), 'Native Windows with PowerShell 5.1 and 7 required')
class EntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='devcel entry ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.script = self.root/'build-all-windows.ps1'
        self.prefix = (ROOT/'build-all-windows.ps1').read_text(encoding='utf-8').split('\n$ErrorActionPreference = "Stop"',1)[0]
        self.leaf = '''
$saved = @{}
foreach ($key in $PSBoundParameters.Keys) {
    $v = $PSBoundParameters[$key]
    if ($v -is [System.Management.Automation.SwitchParameter]) { $v = [bool]$v }
    $saved[$key] = $v
}
@{ Major=$PSVersionTable.PSVersion.Major; Directory=(Get-Location).Path; Parameters=$saved } | ConvertTo-Json -Compress -Depth 5
exit 23
'''

    def run_entry(self, args='', injection=''):
        prefix=self.prefix.replace('# Windows PowerShell 5.1 delegates',injection+'\n# Windows PowerShell 5.1 delegates',1)
        self.script.write_text(prefix+self.leaf,encoding='ascii')
        command="& '"+str(self.script).replace("'","''")+"' "+args+'; exit $LASTEXITCODE'
        encoded=base64.b64encode(command.encode('utf-16-le')).decode()
        return subprocess.run([str(LEGACY),'-NoProfile','-EncodedCommand',encoded],cwd=self.root,capture_output=True,text=True,timeout=40)

    def test_arguments_directory_and_exit_code(self):
        p=self.run_entry("-Configuration debug -SkipTauri:$false -SkipImporters -Clean:$false -NoOpen -OutputDirectory 'output [x] 日本語' -SourceRepository owner/repo -SourceCommit "+'a'*40)
        self.assertEqual(p.returncode,23,p.stdout+p.stderr)
        data=json.loads(p.stdout)
        self.assertGreaterEqual(data['Major'],7)
        self.assertEqual(Path(data['Directory']),self.root)
        self.assertEqual(data['Parameters'],dict(Configuration='debug',SkipTauri=False,SkipImporters=True,Clean=False,NoOpen=True,OutputDirectory='output [x] 日本語',SourceRepository='owner/repo',SourceCommit='a'*40))

    def test_older_candidate_is_skipped(self):
        injection="function Get-Command { param($Name,$CommandType,[switch]$All,$ErrorAction) @([pscustomobject]@{Source='"+str(LEGACY)+"'},[pscustomobject]@{Source='"+PWSH+"'}) }"
        p=self.run_entry(injection=injection)
        self.assertEqual(p.returncode,23,p.stdout+p.stderr)
        self.assertGreaterEqual(json.loads(p.stdout)['Major'],7)

    def test_missing_supported_version_fails(self):
        injection="function Get-Command { param($Name,$CommandType,[switch]$All,$ErrorAction) [pscustomobject]@{Source='"+str(LEGACY)+"'} }; $env:ProgramFiles='"+str(self.root)+"'"
        p=self.run_entry(injection=injection)
        self.assertNotEqual(p.returncode,0)
        self.assertIn('PowerShell 7 or later is required',p.stderr)

    def test_cmd_preserves_exit_without_claiming_build_success(self):
        self.script.write_text(self.prefix+self.leaf,encoding='ascii')
        launcher=self.root/'build-all-windows.cmd'
        shutil.copyfile(ROOT/'build-all-windows.cmd',launcher)
        p=subprocess.run([os.environ['COMSPEC'],'/d','/c',str(launcher),'-NoOpen'],cwd=self.root,input='\n',capture_output=True,text=True,timeout=40)
        self.assertEqual(p.returncode,23,p.stdout+p.stderr)
        self.assertIn('Command exited with code 23.',p.stdout)
        self.assertNotIn('completed successfully',p.stdout)

    def test_entry_is_ascii(self):
        self.assertTrue((ROOT/'build-all-windows.ps1').read_bytes().isascii())

if __name__ == '__main__': unittest.main()
