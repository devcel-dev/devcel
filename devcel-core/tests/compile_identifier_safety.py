#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2024 Devcel Studio Contributors
# See devcel-core/LICENSE in the complete source distribution.
"""Compile fixtures emitted by codegen_identifier_safety without invoking Cargo.

Generate fixtures with DEVCEL_CODEGEN_SAFETY_OUT=DIR cargo test -p devcel-core
--test codegen_identifier_safety, then run this script with --fixtures DIR.
Requires C++17/20, Node/TypeScript and .NET. --skip-csharp explicitly records an
unverified C# stage; this script never installs tools or downloads dependencies.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def run(*args, **kwargs):
    subprocess.run([str(value) for value in args], check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--cxx", default="g++")
    parser.add_argument("--node", default="node")
    parser.add_argument("--tsc", type=Path)
    parser.add_argument("--dotnet", default="dotnet")
    parser.add_argument("--skip-csharp", action="store_true")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    fixtures = args.fixtures.resolve()
    tsc = args.tsc or repo / "devcel-studio/node_modules/typescript/bin/tsc"
    with tempfile.TemporaryDirectory(prefix="devcel-identifier-safety-") as directory:
        work = Path(directory)
        for name in ["keywords", "strings", "comments", "splice", "interface_types"]:
            header = fixtures / f"{name}.h"
            if not header.is_file():
                raise SystemExit(f"Missing required fixture: {header}")
            source = work / f"{name}.cpp"
            assertions = ""
            if name == "interface_types":
                assertions = "\n#if defined(__cpp_concepts)\nstatic_assert(ConceptSafety::IStats<ConceptSafety::GoodRow>);\nstatic_assert(!ConceptSafety::IStats<ConceptSafety::NamesRow>);\nstruct WrongVoid { void hp() const; };\nstruct WrongWide { int64_t hp() const; };\nstatic_assert(!ConceptSafety::IStats<WrongVoid>);\nstatic_assert(!ConceptSafety::IStats<WrongWide>);\n#endif\n"
            source.write_text(f'#include "{header.name}"\n'+assertions, encoding="utf-8")
            for version in [17, 20]:
                if Path(args.cxx).name.lower() in ("cl", "cl.exe"):
                    run(args.cxx, "/nologo", f"/std:c++{version}", "/W4", "/WX", "/Zs",
                        "/EHsc", "/permissive-", "/utf-8", "/I"+str(fixtures), source)
                else:
                    run(args.cxx, f"-std=c++{version}", "-Wall", "-Wextra", "-Werror",
                        "-fsyntax-only", "-I", fixtures, source)
                print(f"PASS C++{version}: {header.name}", flush=True)
        for name in ["keywords", "strings", "comments"]:
            shutil.copyfile(fixtures / f"{name}.ts", work / f"{name}.ts")
            shutil.copyfile(fixtures / f"{name}.cs", work / f"{name}.cs")
        for name in ["devcel-runtime.js", "devcel-runtime.d.ts"]:
            shutil.copyfile(repo / "importers/javascript/runtime" / name, work / name)
        run(args.node, tsc, "--strict", "--noEmit", "--target", "ES2020", "--module",
            "ES2020", "--moduleResolution", "bundler", *sorted(work.glob("*.ts")))
        print("PASS TypeScript: keywords, strings, comments", flush=True)
        if args.skip_csharp:
            print("SKIP C#: explicitly requested; no C# compile claim", flush=True)
            return
        sdks = subprocess.check_output([args.dotnet, "--list-sdks"], text=True)
        major = max((int(line.split(".", 1)[0]) for line in sdks.splitlines() if line.strip()), default=0)
        if major < 8:
            raise SystemExit("C# verification requires an installed .NET SDK 8 or newer")
        (work / "Check.csproj").write_text(
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>'
            f'<TargetFramework>net{major}.0</TargetFramework>'
            '<Nullable>enable</Nullable><CheckForOverflowUnderflow>true</CheckForOverflowUnderflow>'
            '</PropertyGroup></Project>', encoding="utf-8")
        (work / "NuGet.Config").write_text(
            '<configuration><packageSources><clear /></packageSources></configuration>', encoding="utf-8")
        env = dict(os.environ, DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE="1",
                   DOTNET_GENERATE_ASPNET_CERTIFICATE="false", DOTNET_CLI_HOME=str(work / "dotnet-home"))
        run(args.dotnet, "build", work / "Check.csproj", "--configfile", work / "NuGet.Config", env=env)
        print("PASS C#: keywords, strings, comments", flush=True)


if __name__ == "__main__":
    main()
