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
from test_unity_mobile import android_binary, ios_binary, ios_simulator_binary, webgl_binary

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
           str(here/'Program.cs'), str(here.parents[1]/'Editor/DevcelNativeBinary.cs')]
subprocess.run(command, check=True)
cases = [('android-arm64-16k', 'Android', 'Plugins/Android/arm64-v8a', android_binary(), True),
         ('android-armv7', 'Android', 'Plugins/Android/armeabi-v7a', android_binary(cpu=40, elf_class=1), True),
         ('android-x86', 'Android', 'Plugins/Android/x86', android_binary(cpu=3, elf_class=1), True),
         ('android-x64', 'Android', 'Plugins/Android/x86_64', android_binary(cpu=62), True),
         ('android-reject-4k', 'Android', 'Plugins/Android/arm64-v8a', android_binary(4096), False),
         ('android-reject-x64', 'Android', 'Plugins/Android/arm64-v8a', android_binary(cpu=62), False),
         ('android-truncated', 'Android', 'Plugins/Android/arm64-v8a', android_binary()[:-1], False),
         ('ios-arm64-device', 'iOS', 'Plugins/iOS', ios_binary(), True),
         ('ios-reject-simulator', 'iOS', 'Plugins/iOS', ios_binary(platform=7), False),
         ('ios-reject-x64', 'iOS', 'Plugins/iOS', ios_binary(cpu=0x01000007), False),
         ('ios-truncated', 'iOS', 'Plugins/iOS', ios_binary()[:-1], False),
         ('ios-simulator-universal', 'iOS', 'Plugins/iOSSimulator', ios_simulator_binary(), True),
         ('ios-simulator-reject-device', 'iOS', 'Plugins/iOSSimulator', ios_binary(), False),
         ('ios-simulator-truncated', 'iOS', 'Plugins/iOSSimulator', ios_simulator_binary()[:-1], False),
         ('webgl', 'WebGL', 'Plugins/WebGL', webgl_binary(), True),
         ('webgl-reject-ios', 'WebGL', 'Plugins/WebGL', ios_binary(), False)]
for name, target, directory, data, expected in cases:
    path = work/directory/(name+'.bin')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    result = subprocess.run([str(unity/'MonoBleedingEdge/bin/mono.exe'), str(output), target, str(path), str(expected)],
                            text=True, capture_output=True)
    (work/(name+'.log')).write_text(result.stdout+result.stderr)
    if result.returncode:
        raise RuntimeError(name + ': ' + result.stdout + result.stderr)
    print('PASS', name)
print(f'{len(cases)} actual C# validator cases passed; binary fixtures are synthetic, not executable runtimes.')
