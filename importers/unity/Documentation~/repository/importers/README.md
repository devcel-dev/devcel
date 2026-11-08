# Devcel Importers

Unity and Godot are first-class integrations. All other engine integrations are experimental; their APIs, packaging and platform coverage may change, so validate them in your project.

Choose an importer for your engine. Unity uses the complete Git UPM package described in its guide; other engines use an installation ZIP for the Editor operating system and CPU. GitHub source archives do not include an executable CLI.

- [Unity](../../../README.md): Editor wizard, generated C# types, and automatic import of saved changes
- [Godot](godot/README.md): Editor dock, GDScript reader, and automatic import of saved changes
- [Bevy](bevy/README.md): experimental Rust resource and on-demand reload
- [Roblox](roblox/README.md): experimental Luau ModuleScript export
- [RPG Maker MV/MZ](rpgmaker/README.md): Test-play settings, per-source import, and complete loading at game startup; no live reload
- [WOLF RPG Editor](wolf/README.md): Settings UI and files for the official CSV importer; complete the final import into a dedicated variable-database type in WOLF
- [Unreal Engine 5](../docs/manual/importers/unreal.md): Slate wizard, Data Assets, Blueprint/C++ reader, and PIE data updates
- [GameMaker](gamemaker/README.md): Settings UI, Included Files, GML reader, and development-time HTTP reload
- [Cocos Creator](cocos/README.md): Extension panel, generated TypeScript types, and JsonAsset reload
- [Defold](defold/README.md): Editor menu, Lua reader, and development-time file/HTTP reload
- [JavaScript / TypeScript](javascript/README.md): Node settings UI, engine-independent runtime, generated TypeScript types, and file/HTTP reload

## Shared workflow

Save the source `.devcelproj.toml`, Source ID, namespace, class name, and Content Version in the importer settings. Source paths are relative to the settings file. A blank Content Version includes all content; `0` is valid. Each import reads the complete saved source and uses the shared Rust exporter to evaluate formulas, including cross-table formulas, before projecting its selected rows and columns.

Each source has four tag filters: row include/exclude and column include/exclude. Choose tags from that project’s saved presets. Empty includes select all; includes match any selected tag; exclusions win. Saved unknown names remain editable and continue to match exactly until corrected or explicitly removed. Filters never silently widen when the preset registry changes. References to excluded rows fail the import and retain the last good output.

Keep multiple sources separate through their Source IDs, namespaces, output paths, and runtime instances. Readers preserve types, 64-bit integers, RGBA, and HDR values. Values outside an engine's numeric range use explicit types or strings. Failed exports preserve previous output; unrelated existing files are protected.

The CLI, authoring source, import settings, and owner/state caches are development-only files. Each engine guide lists what to include in a game build.

## Packaging

- [Build ZIPs with a bundled CLI](../../../Tools~/README.md)
- [Shared pull configuration and safety](../devcel-cli/docs/importer-pull.md)
- Each SDK has an MIT license. The bundled CLI is also MIT and includes corresponding source and dependency notices.

Native engine verification and CLI/runtime fixture or compilation checks cover different things. Static or mock tests alone do not establish native engine support. Test the native Editor and packaged game on each target platform.
