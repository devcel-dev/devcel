#!/usr/bin/env python3
"""Compile and inspect the real versioned C++/C# generator output.

Requires cargo, a C++17/C++20 compiler and a .NET SDK (8 or newer).
Run from any directory:
  python3 devcel-core/tests/compile_column_version_codegen.py
Use --fixtures DIR to consume output from the Rust integration test with
DEVCEL_CODEGEN_FIXTURE_OUT=DIR. --skip-csharp is an explicit C++-only check.
The C# checks use installed SDK reference packs with NuGet sources disabled.
This script does not install compilers or SDKs.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

VERSIONS = (0, 1, 2, 3, 4294967295)


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def check_cpp(fixtures, work, compiler):
    for version in VERSIONS:
        source = work / f"check-{version}.cpp"
        source.write_text(
            f'#include "v{version}.h"\n#include <type_traits>\n'
            "using namespace VersionCheck;\n"
            "template<class T> concept HasChild = requires(const T row) { row.child_future(); };\n"
            "template<class T> concept HasAncestor = requires(const T row) { row.ancestor_future(); };\n"
            "template<class T> concept HasPower = requires(const T row) { row.power(); };\n"
            "static_assert(IBase<HeroesRow>);\nstatic_assert(IChild<HeroesRow>);\n"
            f"static_assert(HasChild<HeroesRow> == {'true' if version >= 2 else 'false'});\n"
            f"static_assert(HasAncestor<HeroesRow> == {'true' if version >= 3 else 'false'});\n"
            f"static_assert(HasPower<ItemsRow> == {'true' if version >= 9 else 'false'});\n"
            "static_assert(std::is_same_v<decltype(std::declval<HeroesRow>().weapon()), std::optional<ItemsRow>>);\n"
            "static_assert(std::is_same_v<decltype(std::declval<CollisionsRow>().early_shared()), std::string_view>);\n",
            encoding="utf-8",
        )
        run(compiler, "-std=c++20", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-I", fixtures, source)
        source.write_text(f'#include "v{version}.h"\n', encoding="utf-8")
        run(compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-I", fixtures, source)
    for name, present in [("hidden", True), ("required", False)]:
        source = work / f"stale-{name}.cpp"
        source.write_text(
            f'#include "stale-{name}.h"\n'
            "using namespace StaleCheck;\n"
            "template<class T> concept HasValue = requires(const T row) { row.value(); };\n"
            f"static_assert(IContract<StaleRow> == {str(present).lower()});\n"
            f"static_assert(HasValue<StaleRow> == {str(present).lower()});\n", encoding="utf-8")
        run(compiler, "-std=c++20", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-I", fixtures, source)
        source.write_text(f'#include "stale-{name}.h"\n', encoding="utf-8")
        run(compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-I", fixtures, source)
    print("PASS: C++17/C++20 compile, projected contracts and both unsynced interface cases", flush=True)


def check_csharp(fixtures, work, dotnet):
    sdks = subprocess.check_output([dotnet, "--list-sdks"], text=True)
    versions = [int(line.split(".", 1)[0]) for line in sdks.splitlines() if line.strip()]
    major = max(versions, default=0)
    if major < 8:
        raise SystemExit("C# verification requires a .NET SDK version 8 or newer")
    env = os.environ.copy()
    env.update(DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE="1",
               DOTNET_NOLOGO="1", DOTNET_GENERATE_ASPNET_CERTIFICATE="false",
               DOTNET_CLI_HOME=str(work / "dotnet-home"))
    cases = []
    for version in VERSIONS:
        checks = (
            "Require(typeof(IBase).IsAssignableFrom(typeof(HeroesRow)));\n"
            "Require(typeof(IChild).IsAssignableFrom(typeof(HeroesRow)));\n"
            f'Require((typeof(HeroesRow).GetProperty("ChildFuture") != null) == {str(version >= 2).lower()});\n'
            f'Require((typeof(IChild).GetProperty("ChildFuture") != null) == {str(version >= 2).lower()});\n'
            f'Require((typeof(HeroesRow).GetProperty("AncestorFuture") != null) == {str(version >= 3).lower()});\n'
            f'Require((typeof(IChild).GetProperty("AncestorFuture") != null) == {str(version >= 3).lower()});\n'
            f'Require((typeof(ItemsRow).GetProperty("Power") != null) == {str(version >= 9).lower()});\n'
            'Require(typeof(HeroesRow).GetProperty("Weapon")?.PropertyType == typeof(ItemsRow?));\n'
            'Require(typeof(CollisionsRow).GetProperty("EarlyShared")?.PropertyType == typeof(string));\n'
        )
        cases.append((f"v{version}", "VersionCheck", checks))
    for name, present in [("hidden", True), ("required", False)]:
        checks = (
            f'Require(typeof(IContract).IsAssignableFrom(typeof(StaleRow)) == {str(present).lower()});\n'
            f'Require((typeof(StaleRow).GetProperty("Value") != null) == {str(present).lower()});\n'
            f'Require((typeof(IContract).GetProperty("Value") != null) == {str(not present).lower()});\n'
        )
        cases.append((f"stale-{name}", "StaleCheck", checks))
    for name, namespace, checks in cases:
        project = work / f"csharp-{name}"
        project.mkdir()
        shutil.copyfile(fixtures / f"{name}.cs", project / "Generated.cs")
        (project / "Check.csproj").write_text(
            f'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>'
            f'<TargetFramework>net{major}.0</TargetFramework><LangVersion>8.0</LangVersion>'
            '<Nullable>enable</Nullable><ImplicitUsings>disable</ImplicitUsings>'
            '<TreatWarningsAsErrors>true</TreatWarningsAsErrors>'
            '</PropertyGroup></Project>', encoding="utf-8")
        (project / "NuGet.Config").write_text(
            '<configuration><packageSources><clear /></packageSources></configuration>', encoding="utf-8")
        (project / "Program.cs").write_text(
            f"using System;\nusing {namespace};\nclass Program {{\n"
            'static void Require(bool value) { if (!value) throw new Exception("Projected API mismatch"); }\n'
            "static void Main() {\n" + checks + "}\n}\n", encoding="utf-8")
        run(dotnet, "build", project / "Check.csproj", "--configuration", "Release", "--nologo", env=env, cwd=project)
        run(dotnet, project / "bin" / "Release" / f"net{major}.0" / "Check.dll", env=env, cwd=project)
    print("PASS: C# 8 compilation, reflected projected contracts and both unsynced interface cases", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path)
    parser.add_argument("--cpp", default=os.environ.get("CXX", "g++"))
    parser.add_argument("--dotnet", default="dotnet")
    parser.add_argument("--skip-csharp", action="store_true")
    args = parser.parse_args()
    for name in [args.cpp] + ([] if args.skip_csharp else [args.dotnet]):
        if shutil.which(name) is None:
            raise SystemExit(f"Required compiler not found: {name}")
    with tempfile.TemporaryDirectory(prefix="devcel-column-codegen-") as directory:
        work = Path(directory)
        fixtures = args.fixtures.resolve() if args.fixtures else work / "fixtures"
        if args.fixtures is None:
            env = os.environ.copy()
            env["DEVCEL_CODEGEN_FIXTURE_OUT"] = str(fixtures)
            manifest = Path(__file__).resolve().parents[2] / "Cargo.toml"
            run("cargo", "test", "--manifest-path", manifest, "-p", "devcel-core", "--test",
                "column_version_codegen", env=env)
        check_cpp(fixtures, work, args.cpp)
        if not args.skip_csharp:
            check_csharp(fixtures, work, args.dotnet)


if __name__ == "__main__":
    main()
