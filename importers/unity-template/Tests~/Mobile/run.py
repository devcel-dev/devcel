"""Exercise the actual C# binary validator; does not launch Unity or a Player."""
import argparse
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--unity-data', type=Path, required=True)
parser.add_argument('--work-dir', type=Path, required=True)
args = parser.parse_args()
here = Path(__file__).resolve().parent
repo = here.parents[3]
sys.path.insert(0, str(repo/'scripts'))
from test_unity_mobile import android_binary, ios_binary

work = args.work_dir.resolve()
if work.is_relative_to(repo):
    parser.error('Test outputs must be outside the repository')
work.mkdir(parents=True, exist_ok=True)
unity = args.unity_data.resolve()
reference = unity/'UnityReferenceAssemblies/unity-4.8-api'
output = work/'MobileBinaryChecks.exe'
command = [str(unity/'NetCoreRuntime/dotnet.exe'), str(unity/'DotNetSdkRoslyn/csc.dll'),
           '/nologo', '/target:exe', '/nostdlib+', '/out:'+str(output),
           '/reference:'+str(reference/'mscorlib.dll'), '/reference:'+str(reference/'System.dll'),
           str(here/'Program.cs'), str(repo/'importers/unity/Editor/DevcelNativeBinary.cs')]
subprocess.run(command, check=True)
cases = [('android-arm64-16k', 'Android', android_binary(), True),
         ('android-reject-4k', 'Android', android_binary(4096), False),
         ('android-reject-x64', 'Android', android_binary(cpu=62), False),
         ('android-truncated', 'Android', android_binary()[:-1], False),
         ('ios-arm64-device', 'iOS', ios_binary(), True),
         ('ios-reject-simulator', 'iOS', ios_binary(platform=7), False),
         ('ios-reject-x64', 'iOS', ios_binary(cpu=0x01000007), False),
         ('ios-truncated', 'iOS', ios_binary()[:-1], False)]
for name, target, data, expected in cases:
    path = work/(name+'.bin')
    path.write_bytes(data)
    result = subprocess.run([str(unity/'MonoBleedingEdge/bin/mono.exe'), str(output), target, str(path), str(expected)],
                            text=True, capture_output=True)
    (work/(name+'.log')).write_text(result.stdout+result.stderr)
    if result.returncode:
        raise RuntimeError(name + ': ' + result.stdout + result.stderr)
    print('PASS', name)
print('8 actual C# validator cases passed; binary fixtures are synthetic, not executable runtimes.')
