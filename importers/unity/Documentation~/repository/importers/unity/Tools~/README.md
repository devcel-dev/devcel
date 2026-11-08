# Packaging importers with the CLI

Importer distributions include a CLI for the target OS/CPU, a manifest, licenses, dependency notices, and matching source. This guide is for distribution maintainers.

## Layout and supported targets

| Importer | Bundled CLI path |
|---|---|
| Unity | `devcel-unity/Tools~/<rid>/devcel[.exe]` |
| Godot | `addons/devcel/bin/<rid>/devcel[.exe]` |
| Unreal | `Plugins/Devcel/Tools/<rid>/devcel[.exe]` |
| RPG Maker MV/MZ | `js/plugins/devcel/bin/<rid>/devcel[.exe]` |
| WOLF | `devcel-wolf/Tools/bin/<rid>/devcel[.exe]` |
| GameMaker | `devcel-gamemaker/tools/<rid>/devcel[.exe]` |
| Defold | `devcel/tools/<rid>/devcel[.exe]` |
| Cocos | `devcel-cocos/bin/<rid>/devcel[.exe]` |
| JavaScript | `devcel-javascript/bin/<rid>/devcel[.exe]` |

The packager targets `linux-x64`, `win-x64`, and `osx-arm64`. Each package contains only its named/manifest RID. Resolvers also recognize Linux/Windows ARM64, but this packager does not produce those distributions. Unsupported OS/CPU combinations fail explicitly.

Install Unity using its complete Git UPM release (or a local generated package); install Godot at the game project root and enable the addon. Unreal's source plugin must be built using the matching UE toolchain. Cocos extension contents belong under `extensions/devcel-importer/`. Defold's `devcel` directory belongs in the game project. JavaScript games include the runtime only. WOLF itself is Windows-only; other platform CLI packages support preparing CSV, not running WOLF.

Unity also includes the host-compatible runtime library; macOS runtime is universal x86_64/arm64. Editor CLI support does not imply support for every Player target. `Tools~` is outside Unity's asset pipeline. Godot combines `bin/.gdignore` with export exclusion of `bin/`. Do not ship CLI binaries, source archives, or editor settings in games.

CLI execution and any owner-execute-bit restoration occur only during a requested import/status action or enabled automatic import. Unity/Godot new settings default to Auto. Consult individual guides for other engines' automatic import and running-game reload support.

At runtime, verify the manifest, SHA-256, OS, and CPU. Missing or mismatched artifacts fail and require the correct distribution; do not silently fall back to a PATH executable.

## Manifest

Example `Tools~/manifest.json` or `bin/manifest.json`:

```json
{
  "schema_version": 1,
  "version": "0.0.2",
  "supportedPlatforms": ["linux-x64"],
  "binaries": {
    "linux-x64": {
      "path": "linux-x64/devcel",
      "sha256": "<64 lowercase hexadecimal characters>",
      "target": "x86_64-unknown-linux-gnu"
    }
  },
  "source_commit": "<source commit>",
  "source_archive": "cli-source.tar.gz",
  "source_sha256": "<archive SHA-256>"
}
```

Paths are relative to the manifest directory. Package names and manifests use the existing Studio product version. `release_version.py` changes only `tauri.conf.json`. The packager generates product identities into staged importer manifests and verifies those outputs; source manifests contain no product version. Unreal requires a numeric `Version` in addition to `VersionName`: packaging derives it as major * 1000000 + minor * 1000 + patch, requiring minor and patch below 1000 and a signed 32-bit result. CLI execution does not read or compare software versions. Stable releases and release SemVer prereleases are accepted; arbitrary version ranges or build-metadata aliases are not. The frontend build renders in memory the compatibility declarations of Studio’s bundled CSV plugin: stable host minimums are preserved, with an exact clause for only the current release when it is a prerelease. Advancing an RC replaces the previous prerelease clause; a stable release removes it. Plugin templates and third-party plugins retain author-declared compatibility ranges and are not rewritten, and strict prerelease matching applies. Verify `pull --help` and `watch --help` support for `--ensure-server` and `--parent-stdin`. The packager includes matching source and computes its archive hash and Unity native-source fingerprint automatically. `Editor/NativeRequirements.json` is generated only in the package; no digest needs source edits.

## Build and verification

Use Python 3.11+, the Rust toolchain pinned by `rust-toolchain.toml`, the native linker/toolchain, and required Rust targets. macOS requires Xcode Command Line Tools and both `x86_64-apple-darwin` and `aarch64-apple-darwin` runtime targets (`python3 scripts/ci-release.py toolchains` installs them). The deployment minimum follows Studio's macOS 13.3 setting. The native CLI and final Universal dylib are ad-hoc signed before manifest hashes are computed; this is not Developer ID signing or notarization.

```sh
python scripts/package-importers.py --out dist/importers --source-repository <owner/repo> --source-commit <git-commit>
```

`build-all-windows` uses `--format directory`: nine ready-to-use folders, without outer ZIP files. Direct packager calls default to `--format zip` for CI. Both paths construct the same payload without executing the CLI. `--build-epoch` supplies one UTC Unix timestamp for a build; otherwise the packager captures the current time once. ZIP timestamps have two-second precision and no timezone field. The bundled `cli-source.tar.gz` is corresponding source, not an installation step.

Omitting `--platform` selects the host. Packaging for another OS/CPU, missing binaries or incompatible versions fails. Missing dependency license text also stops packaging. The process does not publish GitHub releases.

1. Build an isolated CLI/core/runtime workspace, retaining dependency versions from Cargo.lock while excluding Studio-only dependencies.
2. Release-build CLI/runtime, using static CRT for Windows MSVC.
3. Stage native binaries without running behavior tests.
4. Include CLI/shared-catalog MIT licenses, vendored registry sources/notices, Cargo.lock, and offline rebuild instructions in `cli-source.tar.gz`. Preserve engine-runtime MIT and all dependency license/notice/copyright text.
5. Generate binary hashes and manifests. Package-level `ThirdPartyNotices/THIRD-PARTY-NOTICES.txt` includes every original license/NOTICE/copyright text and its package mapping, including Rust standard-library notices outside Cargo.lock. The original hash evidence and inventory remain audit inputs; distribution generation verifies all of them against the aggregate.
6. Copy each staged folder (local mode) or write each ZIP (CI mode). Executable ZIP entries use Unix mode 0755.

Use the `importers` group in Manual validation to extract all nine ZIPs and test Pull, watch capabilities and saved-project status. These tests do not run in automatic CI or release packaging.

Always build distributable binaries from the source matching their stated licenses; do not merely relabel an older binary. Build each supported RID with its native toolchain and verify the extracted package.

## Unity Package Manager release assets

Release publication converts each validated Unity ZIP into `org.devcel.unity-<version>-<rid>.tgz` and includes it in `SHA256SUMS.txt`. Each tarball has a `package/` root and retains the desktop package files, including plugin `.meta` files, notices and matching source, except the outer `INSTALL.txt`. Publication also adds the verified Android ARM64 and iOS ARM64 device runtimes, their build metadata and NDK notices, and extends the native manifest with `player_runtimes` hashes. The Editor runtime stays platform-specific. The conversion checks version, repository, commit, native source fingerprint, binary formats and payload hashes; it never runs the CLI or establishes Unity compatibility.

The version remains generated from `devcel-studio/src-tauri/tauri.conf.json`; do not add a version to the source Unity template. Recovery deterministically recreates the same tarballs from the recorded ZIP bytes, without rebuilding binaries. For a local generated ZIP, run:

```sh
python scripts/unity_upm.py dist/importers/devcel-unity-<version>-<rid>.zip --out dist/upm --version <version> --platform <rid>
python scripts/test_unity_upm.py
```

The complete tarball needs no `org.devcel.native` companion. That legacy companion installer remains for separately generated SDK/native setups; do not combine it with a full tarball. See the [Unity SDK guide](../../../../../README.md) for installation and explicit updates. Test tarball installation in Unity and import/Player execution separately from archive checks.

The local command above produces a desktop-only tarball. Supply both `--mobile-android` and `--mobile-ios` archives to include mobile Players; the release pipeline requires both. See [mobile build and acceptance instructions](../../../../MOBILE.md). Release recovery also pins the two mobile build job artifacts. The desktop ZIPs remain desktop-only installation alternatives.

## Platform acceptance

Some ZIP tools discard executable mode. On Linux/macOS, first verify manifest/hash and regular-file/ancestor-path safety, then restore only the bundled CLI owner's execute bit if necessary. Do not repair symlinks, checksum mismatches, or unrelated paths automatically. Failure must remain explicit.

Signing, notarization, quarantine/Gatekeeper handling, and SmartScreen validation require platform-specific acceptance. The script does not bypass security warnings. Test downloaded ZIPs and native editors before claiming platform distribution readiness. Inspect actual glibc/symbol requirements for Linux artifacts rather than assuming a prior build's baseline. Cross-compilation or binary-format inspection does not establish native execution or Editor/Player compatibility.

The source repository must be an explicit GitHub `OWNER/REPO` slug and the source commit a full commit hash that exists there. Packages record both; do not reuse a private staging commit for a different public repository. Public manual/image links are resolved and copied into the ZIP. Code, directory, and Studio-document references link to that source revision; this local packaging check does not verify remote access or existence. Verification commands in the guides may require the full source checkout. The isolated CLI source omits the Studio-coupled palette-store integration test; the full Studio source release retains it.

## Git UPM release generation

Users install the normal release tag with `https://github.com/<release-repository>.git?path=/importers/unity#v<version>`. There is no UPM-specific tag or permanent distribution branch. The source SDK template remains unversioned: packaging generates `package.json` from the canonical Tauri version. Between releases, `importers/unity` remains the last published complete package even when development changes `importers/unity-template`; the untagged URL therefore does not expose unreleased SDK changes.

For a new manual release, version preparation records a source commit on main. All three desktop builds and the Android, iOS and WebGL builds use that exact commit. Release collection produces the common `org.devcel.unity-<version>-git.zip` and `-git.json` report alongside the offline tarballs and checksums. These ZIP/report files are publication inputs; users normally install the Git URL.

Only after all builds and artifact checks succeed, publication creates a child commit replacing `importers/unity` in that source tree and creates the normal `v<version>` tag there. All paths outside `importers/unity` remain byte-identical to the parent. The release updates main and the new tag together after verifying main still points to the build source. The generated manifest records the build source parent, and publication/recovery validate this relationship separately from the tagged release commit. There is no self-referential commit hash: native artifacts record the parent from which they were built.

The downloadable native archive keeps CLI binaries under `Tools~/<rid>`, their source archives under `Tools~/Sources/<rid>`, and original notices under `ThirdPartyNotices/<rid>`. The shared `Tools~/README.md` and tool licenses stay at their original paths so documentation links remain valid. An aggregate notice retains all four originals. Generated Markdown and shared JSON use LF; assembly accepts CRLF equivalents of those text files without altering native binaries, source archives or original license texts. Assembly validates every packaged Markdown relative link against the final file layout. The manifest has four CLI entries, four hashed source archives, three `native_runtimes` and seven `player_runtimes`. The universal dylib from osx-arm64 serves both macOS CPUs; both macOS CLIs remain. Android notices/build metadata and iOS link metadata are retained. Editor and Player gates select the expected path and verify its hash; older single-runtime manifests remain readable.

Assembly rejects files at or above 100 MiB and a package over 1 GiB. The report records actual package size and largest file. The Git SDK downloads the matching native archive on request and verifies its pinned SHA-256; Git LFS is not required. Real release payloads must pass the bounds; synthetic tests do not measure production size or prove device operation. A source repository clone may include older release objects, so monitor repository growth too.

### Local preparation and publication permissions

For independently built artifacts, run `scripts/unity_git_package.py --help` to assemble the three desktop ZIPs and Android, iOS and WebGL archives. Then prepare the child commit locally:

```sh
python scripts/publish_unity_git.py --archive org.devcel.unity-<version>-git.zip --report org.devcel.unity-<version>-git.json --repo /path/to/source-checkout --author-name <name> --author-email <email>
```

This command writes local Git objects only. It does not create a tag, change the checkout/index/main, push, or publish a release. It reports the exact source/release commits and intended Git URL. The source commit must exist in that checkout. After explicit authorization, a maintainer may publish only the new `v<version>` tag at the reported release commit and publish the corresponding artifacts. The automated manual release path performs this preparation after its builds and uses a non-force push of that one tag.

Never replace or move an existing tag to add UPM support. v0.0.1 remains Windows/Linux ZIP-only; Git installation is available from v0.0.2. For a fork build, record its actual repository slug throughout instead of relabeling its assets as official. Preparing or merging tooling does not authorize a release or new tag in the upstream repository.

If a new manual build fails before tag creation, rerun its failed jobs while its artifacts remain available. Publication recovery requires an existing immutable tag; it cannot recover a pre-tag failure through an invented tag. After a tag has been created, recovery checks its package/source parent relationship and compares the regenerated `importers/unity` Git tree with the immutable tagged tree. Any byte or path difference stops publication. Use original artifacts or a new version if a rebuild is not byte-reproducible; never move the tag. If a draft or public release already exists, inspect it before retrying. Existing old source-only tags retain their original behavior and are not retrofitted into Git-installable releases.

Official v0.0.1 has no generated Git package, mobile or macOS downloads; v0.0.2 includes them. Validate local Git installation in Unity and each native target separately from artifact generation.
