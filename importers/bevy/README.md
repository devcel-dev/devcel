# Bevy integration (experimental)

This small Rust crate exposes a Devcel runtime bundle as a Bevy 0.17 ECS resource. It is experimental: there is no editor importer, generated Rust API, automatic export, asset-server integration or automatic file watcher. Platform coverage has not been established. Export a full JSON bundle with the [Devcel CLI](../../docs/manual/cli.md) first; ship the exported file with the application. The CLI and authoring files are not runtime dependencies.

This crate is intended to be used from a Devcel checkout, e.g. `devcel-bevy-experimental = { path = "../devcel/importers/bevy" }`. Configure the path for your checkout. It uses the local `devcel-runtime` Rust crate, without a native DLL.

```rust
use bevy::prelude::*;
use devcel_bevy_experimental::DevcelData;

fn read_master(data: Res<DevcelData>) {
    let snapshot = data.snapshot();
    if let Some(table) = snapshot.table_index("enemies").and_then(|i| snapshot.table(i)) {
        // Resolve the record's UUID and a column name for your project.
        let _row_count = table.row_count;
    }
}

fn main() -> Result<(), String> {
    let data = DevcelData::open("assets/master.json")?;
    App::new().add_plugins(DefaultPlugins).insert_resource(data)
        .add_systems(Update, read_master).run();
    Ok(())
}
```

Call `reload_if_changed()` only when your import process reports a new file, and handle errors; failed reloads retain the previous snapshot. Existing snapshots stay valid across reloads; obtain a new snapshot to see updated values. Loading/reloading reads and parses the entire file and allocates, so avoid doing it each frame. The snapshot's indexed value reads borrow its data. Test your own target and deployment paths.

## License and dependencies

The Devcel adapter is MIT licensed; see [LICENSE](LICENSE). Bevy ECS and its transitive crates are external dependencies and are not bundled as source or binaries in this adapter. Bevy ECS 0.17 is MIT OR Apache-2.0; inspect the resolved Cargo.lock and provide the applicable third-party licenses and notices with any redistributed game binary. The repository's generated third-party inventory for the main workspace does not automatically cover this independent experimental Cargo workspace.
