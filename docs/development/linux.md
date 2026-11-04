# Linux development and verification

See [Developing and building Studio](build-studio.md) for the shared workflow.

## Prerequisites

Use the pinned Rust 1.99.0, Node.js 26.12.1 and npm 12.2.0, GTK 3/WebKitGTK 4.1, C/C++ build tools and an X11 or Wayland desktop session.

On a normal Debian/Ubuntu development machine, follow [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/):

```sh
sudo apt update
sudo apt install build-essential curl wget file libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev patchelf
```

Do not bypass administrative restrictions on managed machines. Extracting build libraries into a workspace does not necessarily provide correct runtime locations for WebKit helper processes.

## Frontend and native builds

```sh
cd devcel-studio
npm ci
npm run check:tauri-contracts
npm run build
npm run tauri -- build --debug --no-bundle
```

Use the existing lockfile without `--force`. Official optional dependencies select platform-specific frontend/Tauri binaries; helpers verify installed dependencies rather than recursively installing packages or rewriting lockfiles.

The native executable is `target/debug/devcel-studio` at the workspace root. A Vite-only `npm run dev` does not validate native APIs or saving.

For a Debian package after building:

```sh
npm run tauri -- bundle --debug --bundles deb
```

The Linux deb targets Ubuntu 24.04 x64 and Debian 13 x64 with current security updates. The same Ubuntu-built package is installed on both targets; Debian support does not rely on a renamed distribution label or a separate patched runtime. Install it with `sudo apt install ./path/to/devcel-studio-0.0.2-linux-x64.deb`, then open Devcel Studio from the application menu. Validate the final package on each target before publishing.

The package declares WebKitGTK 4.1 with implementation version at least 2.40 and GTK 3. Debian 13 resolves GTK 3 through `libgtk-3-0t64`, which provides `libgtk-3-0`. Let apt resolve the entire dependency closure; do not omit package dependencies, mix distributions, rewrite WebKit helper paths, set a replacement `LD_LIBRARY_PATH`, or disable its sandbox. A managed machine that cannot install these packages is a separate environment limitation.

## Core and P2P

From the repository root:

```sh
cargo test -p devcel-core
cargo run -p devcel-core --example p2p_smoke -- --with-heartbeat-test
```

The disposable-project smoke checks connection, Ping, broadcasts, server promotion and heartbeat. GUI synchronization and Unity integration require separate verification.

## Native UI checks

Using disposable data, verify project creation/close/reopen; table/column/row creation and editing; save/reload; edit/delete Undo/Redo; references; interface synchronization and description-history restoration; opening a file's parent/directory in the file manager; and dialog cancel/close/reopen.

Core tests and frontend builds do not substitute for these checks. Distinguish ordinary screen interaction from accessibility-API automation. If inspection crashes WebKit, retain diagnostics and report the environment limitation without disabling accessibility, GPU security, WebKit sandboxing or ASLR. Do not infer Windows/macOS, multiwindow P2P or Unity success from Linux/core results.

## Minimum WebView requirements

Studio requires GTK 3 and WebKitGTK 2.40 or later through the `webkit2gtk-4.1` API. The API name 4.1 is distinct from the WebKit implementation version.

```sh
pkg-config --atleast-version=2.40 webkit2gtk-4.1
pkg-config --modversion webkit2gtk-4.1
```

A declared minimum is not proof of rendering coverage on that exact version. Check actual bundled versions/licenses and [installation requirements](../manual/installation.md).

## Debian 13 verification

Native GUI verification is performed locally, separately from CI build/package and automated checks. Install the final package through apt on the target OS and use disposable data for the native UI checks above. Keep the package/source hashes, runtime versions, screenshots and functional results with the review. Do not count a packaging check or a screenshot alone as successful project persistence.
