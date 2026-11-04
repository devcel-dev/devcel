#!/usr/bin/env python3
"""Run the isolated Linux C# process integration checks, without Unity Editor."""
import argparse
from contextlib import redirect_stdout
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

# Do not leave Python/SDK/build artifacts inside the package.
sys.dont_write_bytecode = True
from static_audit import audit
from parent_crash import check_parent_crash


def executable(value):
    found = shutil.which(value)
    if found is None:
        raise argparse.ArgumentTypeError(f"Executable not found: {value}")
    return Path(found).resolve()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dotnet", required=True, type=executable, help="Installed .NET 8 SDK executable")
    parser.add_argument("--cli", type=executable, help="Built current devcel CLI; omit for mock/process checks only")
    parser.add_argument("--work-dir", type=Path, help="New disposable output directory, outside this repository")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("This integration driver currently supports Linux; it does not validate Unity Editor or other OSes")
    here = Path(__file__).resolve().parent
    if args.work_dir:
        work = args.work_dir.resolve()
        if work.is_relative_to(here.parents[1]):
            parser.error("--work-dir must be outside devcel-unity")
        work.mkdir(parents=True, exist_ok=False)
    else:
        work = Path(tempfile.mkdtemp(prefix="devcel-unity-auto-"))
    print(f"QA output: {work}", flush=True)
    package = here.parents[1]
    sources = [package / "Editor" / (name + ".cs") for name in [
        "DevcelChangeWatcher", "DevcelCliRunner", "DevcelCliWatchProcess",
        "DevcelImporterSettings", "DevcelImporterWindow",
    ]]
    sources += sorted(path for path in here.iterdir() if path.is_file())

    def source_hashes():
        return {str(path.relative_to(package)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}

    initial_source_hashes = source_hashes()
    env = os.environ.copy()
    env.update({
        "DOTNET_CLI_HOME": str(work / "dotnet-home"),
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
        "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1",
        "DOTNET_GENERATE_ASPNET_CERTIFICATE": "false",
        "DOTNET_NOLOGO": "1",
        "NUGET_PACKAGES": str(work / "nuget"),
    })

    def run(name, command, extra=None, timeout=150):
        run_env = dict(env)
        run_env.update(extra or {})
        log = work / (name + ".log")
        with log.open("w") as output:
            subprocess.run([str(x) for x in command], env=run_env, cwd=work,
                           stdout=output, stderr=subprocess.STDOUT, timeout=timeout, check=True)
        text = log.read_text()
        print(text, end="", flush=True)
        counts = re.findall(r"^TOTAL (\d+)$", text, re.MULTILINE)
        return int(counts[-1]) if counts else None

    contracts = audit()
    (work / "static-audit.json").write_text(json.dumps(contracts, indent=2))
    print(f"PASS {len(contracts)} static contracts", flush=True)
    # No NuGet packages are used. Explicit empty sources keep restoration offline.
    nuget = work / "NuGet.config"
    nuget.write_text('<configuration><packageSources><clear /></packageSources></configuration>')
    run("compile", [args.dotnet, "build", here / "UnityAutoSync.csproj", "--nologo", "-v", "minimal",
                    f"-p:BaseIntermediateOutputPath={work / 'obj'}/",
                    f"-p:OutputPath={work / 'bin'}/", "-p:UseSharedCompilation=false", f"-p:RestoreConfigFile={nuget}"])
    assembly = work / "bin/UnityAutoSync.dll"
    fake = work / "fake-devcel"
    script = (here / "fake_cli.py").read_text()
    fake.write_text("#!" + sys.executable + "\n" + script.split("\n", 1)[1])
    fake.chmod(0o700)
    results = {"compile": "passed", "static_contracts": len(contracts)}
    results["mock_process_checks"] = run("mock-process", [args.dotnet, assembly, fake],
                                         {"QA_ROOT": str(work / "fake")})
    if args.cli:
        results["cli_sha256"] = hashlib.sha256(args.cli.read_bytes()).hexdigest()
        results["real_cli_checks"] = run("real-cli", [args.dotnet, assembly, args.cli, "real"],
                                         {"QA_ROOT": str(work / "real")})
        with (work / "parent-crash.log").open("w") as output, redirect_stdout(output):
            check_parent_crash(args.dotnet, assembly, args.cli, work / "crash", environment=env)
        print((work / "parent-crash.log").read_text(), end="")
        results["owner_crash_checks"] = 2
        # Refuse to attribute results to a binary that changed during the run.
        assert results["cli_sha256"] == hashlib.sha256(args.cli.read_bytes()).hexdigest(), "CLI changed during verification; rerun"
    else:
        results["real_cli_checks"] = "not run (no --cli)"
        results["owner_crash_checks"] = "not run (no --cli)"
    assert initial_source_hashes == source_hashes(), "Sources changed during verification; rerun"
    results["source_sha256"] = initial_source_hashes
    results["command"] = [sys.executable, *sys.argv]
    results["limits"] = ["Unity APIs and asset loading are mocked", "Unity serialization, GUI, Play, Player builds, Windows and macOS were not tested"]
    (work / "manifest.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"PASS manifest: {work / 'manifest.json'}")


if __name__ == "__main__":
    main()
