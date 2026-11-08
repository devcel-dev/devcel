"""Opt-in, local Roblox Studio smoke test. Requires Studio sign-in and Rojo."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from export_module import render
import test_export_module as fixtures


SCRIPT = r'''local data = require(game:GetService("ReplicatedStorage"):WaitForChild("DevcelData"))
local v = data.tables[1].records[1].values
assert(v.color.r == 255 and v.color.a == 255 and v.hdr.g == -1)
assert(v.item:Resolve() == data.tables[2].records[1])
assert(v.table:Resolve() == data.tables[2])
assert(math.abs(v.curve:Sample(0.15) - 1.002585613171157) < 1e-12)
assert(math.abs(v.curve:Sample(0.55) - 1.437342524517376) < 1e-12)
assert(v.curve:Sample(0.85) == 2 and v.hp == 17 and v.wide == "18446744073709551615")
print("DEVCEL_ROBLOX_STUDIO_RUNTIME_PASS")
'''


def prepare(directory, rojo):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    (directory/'src').mkdir()
    (directory/'src/DevcelData.luau').write_text(render(json.dumps(fixtures.ExportTests().bundle())), encoding='utf-8', newline='\n')
    project = {'name':'DevcelStudioAcceptance', 'tree':{'$className':'DataModel',
               'ReplicatedStorage':{'$className':'ReplicatedStorage', 'DevcelData':{'$path':'src/DevcelData.luau'}}}}
    (directory/'default.project.json').write_text(json.dumps(project), encoding='utf-8', newline='\n')
    script = directory/'acceptance.luau'
    script.write_text(SCRIPT, encoding='utf-8', newline='\n')
    place = directory/'acceptance.rbxlx'
    subprocess.run([str(rojo), 'build', str(directory/'default.project.json'), '--output', str(place)], check=True)
    return place, script


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--studio', type=Path, required=True, help='Official RobloxStudio executable; sign in before running')
    parser.add_argument('--rojo', type=Path, required=True, help='Rojo executable')
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    if args.timeout < 1:
        parser.error('timeout must be positive')
    with tempfile.TemporaryDirectory(prefix='devcel-roblox-studio-') as temp:
        root = Path(temp)
        place, script = prepare(root, args.rojo.resolve())
        output = root/'studio-output.log'
        command = [str(args.studio.resolve()), '--task', 'RunScript', '--localPlaceFile', str(place),
                   '--runScriptFile', str(script), '--outputFile', str(output), '--quitAfterExecution']
        try:
            result = subprocess.run(command, timeout=args.timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            raise SystemExit('Studio did not finish; check that Studio is signed in and can open a local place.') from exc
        text = output.read_text(encoding='utf-8', errors='replace') if output.is_file() else ''
        if result.returncode != 0 or 'DEVCEL_ROBLOX_STUDIO_RUNTIME_PASS' not in text:
            raise SystemExit('Studio smoke test did not pass (exit '+str(result.returncode)+'):\n'+text[-4000:])
        print('Roblox Studio typed runtime smoke test passed.')


if __name__ == '__main__':
    main()
