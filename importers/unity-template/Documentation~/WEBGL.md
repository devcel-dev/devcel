# WebGL Player

A release containing the WebGL runtime is required; v0.0.2 does not include it. Install the complete Git package from the repository README and regenerate the C# accessors with the CLI from the same release. The generated native imports use `__Internal` for WebGL Players, and the package build gate validates the WebAssembly archive and its manifest hash.

Use Unity WebGL Build Support and build with IL2CPP. The supplied static archive is built with Rust 1.85.1 for `wasm32-unknown-emscripten`; the local integration was checked with Unity 6000.3.28f1. Other Unity/Emscripten versions require separate validation. Serve the Player with HTTP(S), not a local `file:` URL.

Read exported data through `DevcelBundle.LoadText` and pass the resulting JSON to the generated `DevcelDatabase.FromJson`; WebGL StreamingAssets is fetched over HTTP. The CLI, authoring projects and Editor file watcher do not run in the Player. The native runtime and the managed read model parse the data in memory, so profile startup time and peak memory on the browsers and devices that will run the game.

The release build uses `cargo +1.85.1 rustc --locked --release --lib -p devcel-runtime --target wasm32-unknown-emscripten --crate-type staticlib`. The resulting archive is validated together with version, source repository, commit, fingerprint and plugin metadata before being included in the Unity package. Release recovery requires the matching WebGL artifact in addition to the desktop and mobile artifacts.
