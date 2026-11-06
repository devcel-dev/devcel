# Editor / Player Packaging

## Assemblies and native PluginImporter

- `Editor/Devcel.Unity.Editor.asmdef` is Editor-only and contains settings, CLI integration, watching, generation, and preview.
- `Runtime/Devcel.Unity.Runtime.asmdef` and generated C# are required by Players. Runtime code must not reference Editor assemblies.
- asmdef `precompiledReferences` controls managed DLL references, not native P/Invoke packaging.
- The read-only `devcel-runtime` is used by Editor preview and generated Player APIs; do **not** make it Editor-only. Authoring `devcel-core` and the CLI are development-only.
- Player-targeted authoring DLLs and native core libraries stop the build.
- Runtime Database TextAssets/StreamingAssets are validated with the current runtime before packaging. Authoring files and invalid bundles are rejected.
- Unity excludes folders ending in `~` from asset import; place the CLI in `Tools~`.

References: [Plugin Inspector](https://docs.unity3d.com/2021.3/Documentation/Manual/PluginInspector.html), [Special Folders](https://docs.unity3d.com/2021.3/Documentation/Manual/SpecialFolders.html).

## Native layout

Paths are relative to the package root.

| Path | Editor OS / CPU | Player |
|---|---|---|
| `Plugins/Windows/x86_64/devcel_runtime.dll` | Windows / x86_64 | Windows 64-bit |
| `Plugins/Linux/x86_64/libdevcel_runtime.so` | Linux / x86_64 | Linux 64-bit |
| `Plugins/macOS/libdevcel_runtime.dylib` | OSX / AnyCPU | macOS x86_64 + arm64 universal |
| `Plugins/Android/<abi>/libdevcel_runtime.so` | Disabled | Android ARMv7, ARM64, x86, x86_64; API 23+ |
| `Plugins/iOS/libdevcel_runtime.a` | Disabled | iOS ARM64 device, iOS 13+ |

Matching `.meta` files are bundled. `DevcelNativePluginPostprocessor` applies settings when known paths import; `DevcelNativePlugins` applies them after Editor startup and through **Devcel → Repair Native Plugin Settings**. Any Platform is false, Editor is enabled only for desktop libraries on their OS/CPU, and only the matching Player is enabled. Mobile plugins never load in the Editor. Preload/define constraints are cleared. Identical settings cause no writes or reimports. Only these known package paths are modified.

macOS AnyCPU still requires both CPU slices. The Player gate checks PE x64 DLL, ELF64 x86_64 shared-object, or Mach-O universal-dylib headers. Header checks do not establish ABI, dependency, code-signing, or execution correctness. Restart Unity after replacing a native library because it cannot be unloaded within the current session.

## Build a CLI-containing package

The importer selects `Tools~/<rid>/devcel[.exe]` through the manifest. On the target native OS, with Rust and Python 3.11+ available, run:

```sh
python scripts/package-importers.py --out dist/importers --source-repository <owner/repo> --source-commit <git-commit>
```

The packager performs release CLI/runtime builds, metadata checks, source/notice collection, and binary hashing. Release collection combines all four desktop ZIPs and both mobile archives into a complete package under `importers/unity` in a new release commit, before creating the normal `v<version>` tag. OS-specific UPM `.tgz` files remain optional offline alternatives. See [Git UPM release generation](../../../docs/development/importer-packaging.md#git-upm-release-generation). Packaging does not perform a real Unity import or Player execution test. Windows helper scripts use this same build path. macOS requires Xcode and both Rust targets to create a universal runtime dylib.

Editor CLI OS and Player runtime OS are separate requirements. A single-RID ZIP may lack the runtime for another Player target; the missing-runtime gate remains active. See [bundled CLI packaging](../../../docs/development/importer-packaging.md) for manifests and coverage.

Automatic import requires `watch --ensure-server --parent-stdin`. Verify these options with the real CLI as part of manual acceptance.

## Settings contract

The only settings location is `Assets/DevcelUnity/Editor/DevcelImporterSettings.asset`, with `settingsSchemaVersion: 1` and a long `contentVersion` per environment. Missing/mismatched schemas reject load/save without modifying the asset. Create/edit settings through Importer or Setup Wizard. Settings assets outside Editor folders fail the Player gate.

Only `-1` means all content; `0..4294967295` are filter values. Input uses `LongField` and passes a long to the CLI. Reject values below `-1`, above u32, unregistered selected environments, and duplicates. Release builds keep the chosen environment. Test the native Editor and target Player before shipping; see [Tests~/README.md](../Tests~/README.md).

## Player build gate

1. Reject Devcel settings outside Editor folders and CLI/known authoring files or configured source paths inside Resources/StreamingAssets. An Editor subfolder inside StreamingAssets is still copied and is not a safe exclusion.
2. With registered sources, require a matching native runtime. Reject unsupported targets, missing/wrong-CPU/duplicate runtimes, and invalid PluginImporter settings.
3. If `exportOnBuild=true`, export every source and stop for any failure or missing output.
4. If C# changes, stop until Unity compiles, then rebuild.
5. Use the selected `activeEnvironment`, including for release builds; there is no automatic Production switch.

`exportOnBuild=false` skips CLI execution only. Safety and environment validation still run, including null, duplicate, out-of-range, or missing selected environments. Valid existing bundles can build without CLI/source files because these checks do not require them.

With no registered sources, native libraries are optional and installing the package alone need not block Android or other builds. Known authoring-data leaks and invalid native settings are still rejected. The gate cannot track arbitrary encrypted archives or user-defined copies of authoring data; inspect the final Player and BuildReport too.

Android ARMv7/ARM64/x86/x86_64 and iOS ARM64 device builds require the complete Git UPM release package (or an offline tarball containing mobile runtimes) and matching hashes in `player_runtimes`. The build gate checks each selected Android architecture/API and 16 KB-compatible ELF segments, or iOS Device SDK/minimum OS and ARM64 device Mach-O objects in the static archive. Unsupported ABIs, Simulator and WebGL fail explicitly. `DevcelBundle.LoadText` retrieves the bundle; `FromJson` uses the native runtime. See [mobile Players](MOBILE.md) for prerequisites and acceptance.
