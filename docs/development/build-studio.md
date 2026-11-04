# Developing and building Studio

[Documentation index](../README.md) · [Installation](../manual/installation.md)

This guide is for building Devcel Studio from source. For table editing, use the [user manual](../manual/README.md).

## Prerequisites

Use the versions pinned in `devcel-studio/package.json` and `rust-toolchain.toml`: Node.js 26.12.1, npm 12.2.0 and Rust 1.99.0. Use these pins consistently for local, automated and distribution builds.

Follow [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/):

- Windows: Microsoft C++ Build Tools, WebView2 and the Rust MSVC toolchain.
- macOS: Xcode or Xcode Command Line Tools for desktop development.
- Linux: GTK 3, WebKitGTK 4.1 and C/C++ build tools. See [Linux development](linux.md).

Automated distribution targets are Windows x64 and Linux x64; see [CI and releases](releasing.md). macOS builds remain available locally. Actual platform coverage must be recorded separately alongside the checks described in [Contributing](../../CONTRIBUTING.md#check-the-result).

### Keep Node selectors synchronized

`devcel-studio/package.json` → `volta.node` is the canonical exact Node version. When updating it, also update the root and Studio `volta.node`/`engines.node`, both lockfiles' root `packages[""].engines.node`, the plugin template's `engines.node`, and `devcel-studio/.nvmrc`. Keep each engine minimum at `>=` the canonical version. Do not change dependency-package engine constraints or GitHub Actions' own JavaScript runtime to match the project pin.

Before installing dependencies or building, run these dependency-free checks from the repository root (Python 3.11+):

```sh
python scripts/check-node-pins.py
python scripts/test-node-pins.py
```

The guard also discovers `.nvmrc`, `.node-version`, `.nodejs-version`, `.tool-versions`, mise TOML selectors (including environment-specific and nested configuration), and `.prototools` recursively, including hidden directories. Any Node selector must resolve to the canonical exact version, not an alias or range. Dependency, generated-output and cache directories are excluded; the explicit exclusions are in `scripts/check-node-pins.py`. When introducing another selector format, extend the guard and add a stale-version fixture rather than relying on a text search that can omit hidden files.

`ci-release.py toolchains` installs pinned npm/Rust without running validation. The `compact` manual validation group and local aggregate `check` run the pin guard and its fixtures. The guard checks repository pin consistency; it does not establish native application behavior.

## Rebuild a release

Open the matching Release and read its `SOURCE-ACCESS.json`. Clone the named repository and detach at the recorded **full commit**, or extract that commit's source ZIP/tar.gz. Do not use the latest `main` or assume GitHub's source download includes dependencies.

```sh
git clone https://github.com/<owner>/<repo>.git devcel
cd devcel
git checkout --detach <full-commit>
python scripts/ci-release.py toolchains
cargo fetch --locked
npm ci --prefix devcel-studio
python scripts/release_source.py --check
python scripts/ci-release.py build_native
```

Install the pinned Node version and platform prerequisites first. `toolchains` installs the pinned npm and Rust versions. The release frontend hook reuses the staged production CLI for catalog generation, synchronizes the plugin SDK and builds Vite. `build_native` stages that CLI and creates the Windows portable ZIP or Linux deb package. Signing, timestamps and platform environments can change bytes; this is a source rebuild procedure, not a promise of byte-identical binaries.

`SOURCE-ACCESS.json` and [Source delivery](source-delivery.md) distinguish locked registry build artifacts from preferred editable dependency source. No secret, publisher signing key or update-service credential is needed to build and run a modified no-bundle executable. The standard updater is disabled.

## Development launch

Check out the source revision you want to build. From the repository root:

```sh
cd devcel-studio
npm ci
npm run tauri dev
```

When the welcome screen opens, test creation/save/reopen using [Getting started](../manual/getting-started.md).

`npm run tauri dev` starts the configured frontend and native application. Its `dev:with-fmt` preparation also runs `cargo fmt`; inspect resulting working-tree changes. `npm run dev` alone serves the browser frontend and does not validate native Tauri APIs or project persistence.

## Distribution build

From `devcel-studio`:

```sh
npm run check:lint
npm run typecheck
npm run lint
npm run check:tauri-contracts
npm run build
npm run tauri build --no-bundle
```

`npm run check:lint` verifies the fail-closed compiler/linter gates and focused hook regressions. `npm run lint` rejects every warning or error; see [frontend quality gates](frontend-quality.md). `npm run build` performs TypeScript checking and frontend compilation. Tauri's normal prebuild hook is `build:ci` (Vite), so run type checking separately as above.

This command builds the current OS/target's executable. Use the Windows aggregate build below or the release workflow to create the distribution package. Output defaults are `target/release/` and `target/release/bundle/` at the workspace root; `--target` or `CARGO_TARGET_DIR` changes them. See [Linux development](linux.md) for debug/no-bundle/deb builds.

Before distribution, test launch, project creation, editing, save and reopen on the destination OS/CPU. Identify the installer/executable and provide [installation instructions](../manual/installation.md). Standard builds disable in-app updating and leave its endpoint/public key unset; document the actual update mechanism used by the distribution.

Configuration: [`tauri.conf.json`](../../devcel-studio/src-tauri/tauri.conf.json). CLI-bundled game importers are built separately: [Godot](../manual/godot.md), [Unity](../manual/unity.md), [bundling contract](importer-packaging.md).

## Windows local build

Install PowerShell 7 or later and standard Python 3.11+. Run `./build-all-windows.ps1` from the repository root, or double-click `build-all-windows.cmd`. The Windows PowerShell 5.1 entry delegates to PowerShell 7; neither entry changes execution policy or file associations. The output directory can be selected interactively. Cancelling selection performs no build.

```powershell
pwsh -File ./build-all-windows.ps1 -Configuration release -OutputDirectory ./build-output -NoOpen
```

The default builds CLI, runtime and Studio executables, and stages all nine importers for local use. `-Configuration release|debug|both` selects configurations (default: both). `-SkipTauri` omits Studio; `-SkipImporters` omits importer folders. The CLI and runtime remain available in the Cargo target directory. Studio outputs include the CLI and runtime resources needed to run locally. License notices are generated automatically from locked dependencies and retained upstream materials. This path does not vendor dependencies, create source archives, or require GitHub source links. Studio CLI identity uses the checkout commit; when building a source archive, pass its full `-SourceCommit` value. Local output folders are not verified distribution packages.

The frontend's `npm run build:local` performs asset checks and Vite compilation without release evidence checks. Type checking is performed by the Windows entry before native compilation. On Linux, use `npm run typecheck` followed by `npm run tauri -- build --debug --no-bundle --config ../scripts/tauri-local.conf.json` for the same frontend build contract. See [Linux prerequisites](linux.md).

## Windows distribution packages

Use the release workflow for publication. To explicitly create verified distribution folders locally, add `-Distribution`:

```powershell
pwsh -File ./build-all-windows.ps1 -Distribution -Configuration release -OutputDirectory ./distribution-output -NoOpen
```

This mode creates the portable Studio folder and all nine CLI-bundled importer packages, including source and license evidence. Their integrity checks remain mandatory. Importers use release mode. A credential-free GitHub origin supplies the source repository; `-SourceRepository owner/repo` overrides it. Source archives require both `-SourceRepository` and `-SourceCommit <full-commit>` from their source metadata; they cannot inherit an unrelated enclosing checkout. The command does not publish a GitHub Release.

Both modes write `build_log.txt` and `build_summary.txt` in the timestamped output folder. A failed native command stops the build and returns a nonzero exit code. `-Clean` only removes the repository's Cargo target, rejecting external or linked directories.
