# Devcel for Unreal Engine 5

This source plugin imports saved Devcel projects into UE5 Data Assets and provides complete local data access from Blueprint and C++. It targets UE5.5 and later APIs. Install Unreal Engine and its C++ toolchain separately.

1. Extract the **ZIP with a bundled CLI** for your Editor's OS and CPU into `<game>/Plugins/Devcel/`. Check that `Plugins/Devcel/Devcel.uplugin` exists.
2. Build the C++ project and enable the plugin. Close the Editor for the first build and whenever plugin code changes.
3. Open `Tools → Devcel Importer → Add Source…`, select a `.devcelproj.toml`, and set the namespace, class name, and Content Version.
4. Click `Save and Import`. The importer creates `Content/Devcel/<source ID>/Database`.
5. Assign it to a Blueprint variable of type `Devcel Data Asset`, then call `Get Tables`, `Get Record Ids`, or `Get Value`. For C++, add `DevcelRuntime` to your game module's dependencies.

`Class name` is shared per-source metadata. The plugin uses `UDevcelDataAsset` and `FDevcelValue`; it does not generate per-source C++ or UCLASS code. All integer widths, colors, curves, and references are supported.

Use `Reimport` or the default `Auto import` for data updates. After an asset saves successfully, PIE data updates and emits `OnReloaded`. Sources remain isolated even when they contain the same UUIDs.

See the [UE5 guide](../../docs/manual/importers/unreal.md) for detailed installation, Blueprint/C++ examples, recovery, packaging, and verification coverage. In an extracted SDK ZIP, use `Docs/unreal.md`.

## Verification

- Run `python3 Tests/verify_importer.py --static-only` to check the descriptor, source contracts, and fixtures.
- Build the CLI from the source being verified, then run `python3 Tests/verify_importer.py --cli /absolute/devcel --out /new/evidence` to check relative paths, version `0`, 64-bit/HDR values, isolated sources with identical UUIDs, per-source reimport, and preservation after failure.
- Regenerate the ZIP with the matching CLI/runtime and verify the extracted artifacts. Results from a different build do not validate this package.
- Verify the Editor, UHT/UBT, PIE, cooking/packaging, and native UI in the target UE environment. Static and CLI checks do not cover those workflows.
