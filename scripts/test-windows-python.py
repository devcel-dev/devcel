"""Exercise the actual PowerShell resolver with controlled command discovery."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'build-all-windows.ps1'
PWSH = os.environ.get('PWSH') or shutil.which('pwsh')

@unittest.skipUnless(PWSH, 'PowerShell 7 is required')
class PythonDetection(unittest.TestCase):
    def invoke(self, available, first_bad=False):
        source = SOURCE.read_text(encoding='utf-8')
        start = source.index('function Resolve-DevcelPython {')
        end = source.index('\n}', start) + 2
        helper = source[start:end]
        setup = r'''
$ErrorActionPreference='Stop'
$script:count=0
function Get-Command {
    param($Name,$CommandType,[switch]$All,$ErrorAction)
    if ($Name -eq 'AVAILABLE') { [pscustomobject]@{Source='Invoke-Probe'} }
}
function Invoke-Probe {
    $script:count++
    if ('AVAILABLE' -eq 'py' -and $args[0] -ne '-3') { throw 'Missing py launcher prefix' }
    if ($args -notcontains '-c') { throw 'Missing capability probe' }
    $global:LASTEXITCODE=0
    if (FIRSTBAD) { $global:LASTEXITCODE=1; return }
    'devcel-python-ready'
}
'''.replace('AVAILABLE', available).replace('FIRSTBAD', '$true' if first_bad else '$false')
        with tempfile.TemporaryDirectory(prefix='devcel-python-test-') as directory:
            script = Path(directory)/'probe.ps1'
            script.write_text(setup+'\n'+helper+'\nResolve-DevcelPython | ConvertTo-Json', encoding='utf-8')
            return subprocess.run([PWSH,'-NoProfile','-File',str(script)], text=True, capture_output=True, timeout=30)

    def test_python(self):
        p=self.invoke('python'); self.assertEqual(p.returncode,0,p.stdout+p.stderr)

    def test_py_launcher(self):
        p=self.invoke('py'); self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        self.assertIn('-3',p.stdout)

    def test_python3(self):
        p=self.invoke('python3'); self.assertEqual(p.returncode,0,p.stdout+p.stderr)

    def test_missing_python_fails_with_guidance(self):
        p=self.invoke('missing'); self.assertNotEqual(p.returncode,0)
        self.assertIn('Python prerequisite failed',p.stderr)

    def test_failed_probe_is_not_accepted(self):
        p=self.invoke('python',True); self.assertNotEqual(p.returncode,0)
        self.assertIn('Python prerequisite failed',p.stderr)

    def test_early_common_probe_and_resolved_calls(self):
        source=SOURCE.read_text(encoding='utf-8')
        self.assertLess(source.index('$python = Resolve-DevcelPython'),source.index('$metadataJson = & cargo'))
        self.assertIn('& $python.Command @pythonPrefix scripts/package-importers.py',source)
        self.assertIn('& $python.Command @pythonPrefix $packager',source)
        self.assertNotIn('& python ',source)

if __name__ == '__main__': unittest.main()
