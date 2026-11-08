# Unity SDK Tests

The automated harness lives under `Tests~` so Unity does not import it into the package.

## Automatic-sync harness

Requirements: Linux, Python 3.10 or later, .NET 8 SDK, and optionally a matching Devcel CLI. From the repository root:

```sh
python3 'importers/unity/Tests~/AutoSync/run.py' \
  --dotnet /absolute/path/to/dotnet \
  --cli /absolute/path/to/devcel
```

Without `--cli`, the harness runs compilation, static contracts, and fake-CLI subprocess checks. With it, the harness also exercises saved-file imports and managed-server startup, sharing, reconnect, and shutdown. Supply `--work-dir /absolute/path/to/new-directory` to select a fresh output directory; otherwise the script prints its temporary directory.

See [AutoSync/README.md](AutoSync/README.md) for the tested cases, output files, and isolation guarantees. No SDK is downloaded by the harness.

## Package-version contract

[VersionContract](VersionContract/README.md) executes the actual package path/version/hash validator and CLI runner with an installed Mono compiler and a real CLI. It covers UPM/Assets lookup and negative version/metadata cases without substituting DevcelPaths.

## Native checks

The harness uses Unity API mocks. It does not establish actual asset serialization, native Editor UI, domain reload, Play mode, Player packaging, or Windows/macOS behavior.

Use Unity Editor 2021.3 or later with the OS/CPU-matched package. Follow the [Unity manual](../INSTALL.md) in a disposable project, then check automatic imports, code recompilation, data-only Play reload, relocated relative paths, and recovery after an invalid source. For Player tests, follow [packaging requirements](../Documentation~/DISTRIBUTION.md) and inspect the final build on its target platform, including its native runtime and exclusion of authoring files.

Old row handles must be reacquired after a successful Unity runtime reload. A failed update must retain the previous valid database. TextAsset-backed databases need explicit reopen; only matching file-backed databases receive automatic Play-mode reloads.

Tag-filter source contracts across Unity/Godot/Unreal: `python3 importers/tests/verify_tag_filters.py`. These are static checks only; they do not run Unity or compile Unreal.
