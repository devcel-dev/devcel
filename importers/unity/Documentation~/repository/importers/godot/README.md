# Devcel for Godot

Start with the [Godot manual](../../docs/manual/godot.md) for installation, first import, and automatic import. This guide covers addon settings, runtime APIs, packaging, and verification.

The addon reads Devcel data using Godot's built-in JSON and GDScript support:

- Record/table UUID lookup and typed getters.
- Full/minimal exports, evaluated formulas, and Content Version filtering.
- Reference, interface-constrained TableRef, and Devcel Bezier/step curves.
- Validated reload that preserves current data after invalid JSON or incomplete writes.
- Editor-only multi-source import, automatic import, status/errors, and game DB updates during Play.
- A safe PCK workflow that publishes only after generation, validation, and package auditing succeed.

The target is **Godot 4.6 or later**.

## Run the sample

1. Open this folder's `project.godot` in Godot.
2. Press F5 to run the project.
3. Inspect hero HP, equipment references, TableRef, 64-bit integers, and growth curves.
4. In Editor Play, JSON changes reload automatically. The manual reload action also works. Invalid JSON preserves the last valid data.

Manage sources in the right-side **Devcel** dock; use the right arrow if the tab is hidden. Save the Devcel project before importing through the CLI.

## Add to your project

Install the addon ZIP matching your Editor's OS/CPU and register sources as shown in the [manual](../../docs/manual/godot.md). Shared settings live in `.devcel/devcel.import.json`; local per-source sync modes live in `.devcel/pull-editor.cfg`. Review the wizard and click **Save and Import**. Subsequent saved changes import automatically. With sync Off or after failure, use Import All or the selected source's Import action.

On final save, project/runtime/code paths become relative to the configuration's `.devcel/` directory, for example `../../authoring/Base/Base.devcelproj.toml` and `../data/base.json`. Dialog selections and manually entered absolute paths follow the same rule. Cross-drive paths are rejected because they cannot be made relative.

Version-control `.devcel/devcel.import.json` and the complete authoring project/table/interface files, preserving their relative layout. Exclude `.devcel/pull-editor.cfg`, `*.devcel-state.json`, `*.devcel-owner.json`, `*.devcel-lock`, and `.godot/`. The bundled `.gitignore` keeps the shared JSON eligible for version control. A fresh checkout recreates output/local state on import. Opening existing settings leaves them unchanged; explicit save normalizes paths.

Each source stores `namespace`, optional `class_name`, and numeric `version`, shared by manual/automatic imports. Omitted/null class names default to `DevcelDatabase` for C# and `Database` for C++. Blank UI fields are omitted. Specify both `code_out` and `code_target`, or neither; supported code targets are `csharp` and `cpp`. Root class names do not change table/row/interface types or the GDScript reader. A source without code output can still retain class-name metadata.

Blank Content Version includes all content; `0..4294967295` applies the `min_version` filter. `schema_version` identifies the settings format and is independent of content version.

Sources with identical UUIDs can coexist with distinct IDs, namespaces, and outputs. The CLI rejects namespace/output collisions, overwriting source data, and symlink-based escapes. Relative `..` paths are allowed, but resolved outputs must lie outside the authoring tree. Symlinks inside the source tree are also rejected. The dock resolves `res://` to absolute paths before saving; directly edited JSON uses the configuration directory as its relative base.

### Automatic import

New sources default to Auto; saved Off settings remain Off.

- **FileWatch:** checks content hashes of saved project/table/interface files.
- **P2P:** imports while connected, using notifications plus file watching for delayed saves.
- **Auto:** combines P2P with FileWatch and continues saved-file imports while disconnected.
- **Off:** stops automatic import.

Auto/P2P use the bundled CLI to start or share a server for each source, including an existing Studio/manual/importer server. Off, source removal, addon disable, and Editor exit close only owned connections. Automatically started servers stop about five seconds after their final user leaves; pre-existing Studio/manual servers remain running. Both modes import saved data only. Sync preferences are stored by Source ID in local `pull-editor.cfg`, separate from the CLI JSON contract.

Changes are debounced for 500 ms; changes during import are queued for another pass. Failed automatic imports retry after five seconds. Saving source settings rebuilds the watches.

Imports run asynchronously. While running, duplicate execution and settings changes are blocked. Wait for publication to finish rather than force-cancel it. Each source's output is generated/validated before atomic replacement; failures preserve its previous output. Simultaneous all-file publication and power-loss transactions are not guaranteed. After interruption, check status and reimport.

For multiple runtime databases, use `devcel_project_set.gd`: `add_source("base", "Game.Base", "res://data/base.json")` and `add_source("event", "Game.Event", "res://data/event.json")` create independent DBs accessed through `source("base")`. UUIDs never merge sources. A separate `DevcelLiveDatabase` node per source supports Play-mode updates.

See the [shared CLI contract](../../devcel-cli/docs/importer-pull.md) for failure boundaries.

## Bundled CLI

Extract `devcel-godot-<version>-<rid>.zip` for the Editor OS/CPU into the project root. It includes `addons/devcel/bin/<rid>/devcel` (`.exe` on Windows), manifest, MIT license, dependency notices, and corresponding source. GitHub source ZIPs omit required executable artifacts.

The addon checks manifest version, SHA-256, and OS/CPU, stopping on absence or mismatch. `bin/.gdignore` excludes binaries from Editor scanning; the export plugin excludes the whole `bin/` directory from the game/PCK. The CLI runs for import/status or enabled sync. See [bundled CLI packaging](../../../../Tools~/README.md) for packaging and platform coverage.

## Runtime reading

```gdscript
const DevcelDatabase = preload("res://addons/devcel/runtime/devcel_database.gd")
var database = DevcelDatabase.new()

func _ready():
    if not database.load_file("res://data/master.json"):
        push_error(database.last_error)
        return
    var heroes = database.table("Heroes")
    if heroes == null:
        return
    var hero = heroes.by_id("YOUR_RECORD_UUID")
    if hero != null:
        var hp: int = hero.get_int("hp")
        var label: String = hero.get_string("name")
        var enabled: bool = hero.get_bool("active")
        var speed: float = hero.get_float("speed")
```

For a missing column or wrong type, `get_*` returns its fallback (default 0/false/empty string) and sets the row's `last_error`. Missing tables/rows return `null`. Check errors for required fields.

- Database: `load_file(path)`, `load_json(text)`, `table(name)`, `table_by_uuid(uuid)`, `by_id(table_name,id)`, `tables()`, `manifest()`, `project_name()`, `reload_if_changed()`.
- Table: `by_id(id)`, `at(index)`, `count()`, `ids()`, `columns()`, `column_info(name)`, `implements_interface(uuid)`.
- Row: `id()`, `get_raw(column)`, `get_string(column)`, `get_int(column)`, `get_float(column)`, `get_bool(column)`, `get_color32(column)`, `get_color_float(column)`, `get_u64_decimal(column)`, `get_reference(column)`, `get_table_reference(column)`, `get_curve(column)`.

I64 is parsed directly from text without losing precision above 2^53. Godot `int` is signed 64-bit. For U64 above `9223372036854775807`, use `get_u64_decimal()` for an exact decimal string. `get_int()` returns its fallback and an error rather than wrapping/clamping.

### Color32 / ColorFloat

Color32 has four integer components in 0..255; ColorFloat has four finite f32 components, preserving negative/above-one HDR RGB with alpha in 0..1. Saved/full-bundle cells contain JSON-array strings. When both default and cell are omitted, the default is white (`[255,255,255,255]` or `[1.0,1.0,1.0,1.0]`). Explicit empty strings, non-RGBA values, and undefined types are rejected. Runtime, settings, and CLI manifests use schema `1`.

```gdscript
var bytes = hero.get_color32("color32")       # Database.Color32: integer r/g/b/a.
var hdr = hero.get_color_float("color_float") # Database.ColorFloat: float r/g/b/a.
var tint: Color = bytes.to_color()            # Divide each component by 255.
var hdr_tint: Color = hdr.to_color()           # Copy components unchanged.
```

Wrong-type getters return null or the supplied fallback and set `last_error`. Returned value objects are independent copies. `to_array()` returns `PackedByteArray` or `PackedFloat32Array`. Conversion to Godot Color is explicit, preserving RGB at alpha 0 without automatic gamma conversion, RGB clamping, or premultiplication.

### References and curves

```gdscript
var item = hero.get_reference("item")
if item != null:
    print(item.get_string("label"))
var drop_table = hero.get_table_reference("drops")
if drop_table != null:
    print(drop_table.count())
var curve = hero.get_curve("growth")
if curve != null:
    print(curve.sample(0.5)) # x is 0..1; values outside it clamp to endpoints.
```

Reference uses required `reference_config.target_table_uuid` and the cell's record UUID. TableRef resolves a table UUID and checks `table_ref_config.interface_uuid` when present. Invalid UUID/interface metadata is rejected. `get_raw()` exposes the UUID. A version-filtered target returns null and diagnostics rather than substituting another row.

Curve evaluates Devcel constant/linear/auto/autoLength/free modes. Each point must specify its mode. Validation requires strictly increasing x, endpoints at 0/1, finite numbers, and handle lengths in 0..3. `curve_config` fixes endpoint y values when supplied. An empty cell creates a two-point curve following that configuration. Evaluation uses the Devcel curve directly rather than approximating it as a Godot Curve.

### Reload

```gdscript
var result = database.reload_if_changed()
if not result.ok:
    push_warning(result.error) # The previous snapshot remains usable.
elif result.changed:
    var new_hero = database.by_id("Heroes", "YOUR_RECORD_UUID")
```

The full snapshot is built/validated before replacement. Existing Table/Row handles retain the old snapshot; obtain new handles where fresh data is needed. A DB loaded only from JSON text has no source file to reload.

Comparison uses the producer's `content_hash` and meaningful manifest fields (version/mode/schema). The hash is not a signature or tamper-proof guarantee. Only bundle schema `1` is accepted. Duplicate identifiers, unknown types, or invalid values reject the entire bundle. Use the database on the game's main thread.

## Update a game's DB during Editor Play

Use a live node, as in `samples/demo.gd`:

```gdscript
const LiveDatabase = preload("res://addons/devcel/runtime/devcel_live_database.gd")
var live = LiveDatabase.new()

func _ready():
    live.bundle_path = "res://data/master.json"
    live.reloaded.connect(refresh_game_data)
    live.reload_failed.connect(func(message): push_warning(message))
    add_child(live) # Initial JSON load.

func refresh_game_data():
    var heroes = live.database.table("Heroes")
    # Obtain fresh tables/rows and update game UI or state.
```

`live.database` provides the same API. During Editor Play it checks JSON every 0.5 seconds by default. Invalid updates preserve old data, and an initially missing file can recover after generation. Disable through `editor_hot_reload`.

Exported PCKs carry `devcel_exported`, disabling automatic watching even when run with an Editor binary. Games need only runtime JSON reading, not CLI/P2P/settings/source paths. Explicit post-release reload is available through `reload_now()` or `reload_if_changed()`.

## Export a game

Godot packages already-imported JSON. Finish imports in the dock first. The safe-export helper validates all sources in `.devcel/devcel.import.json`, then creates a PCK. Create the target export preset in Godot first; the sample includes Linux.

```sh
godot --headless --path . --script res://addons/devcel/editor/safe_export.gd -- --preset Linux --output build/game.pck
godot --headless --main-pack build/game.pck --quit-after 3
```

The helper checks saved settings against every JSON's Content Version and full/minimal mode, creates a temporary PCK, then audits it in a separate process: JSON SHA-256, runtime loading, export feature, and exclusion of Editor/CLI/authoring data. Only success replaces the existing PCK. Disabled plugins and parse failures are errors. Failure, cancellation, or timeout preserves the previous PCK and imported JSON. Export timeout is 300 seconds; audit timeout is 30 seconds.

Configured JSON is included directly by the export plugin, requiring no include filter. Add other JSON to Godot's non-resource include filter. Include the addon LICENSE. Editor scripts are excluded before GDScript bytecode conversion, along with `.devcel/`, CLI files, and source project/table/interface TOML. Sample presets also carry exclusion filters.

**Godot 4.6.3's standard export callback cannot abort an export: it may log ERROR yet return exit 0 and produce output. Atomic publication guarantees apply to the safe PCK path above. Standard `--export-pack` and normal executable export require separate artifact checks.** Standard export still runs validation/exclusion hooks. Audit every source's JSON and excluded files in resulting packages. See [EditorExportPlugin](https://docs.godotengine.org/en/4.6/classes/class_editorexportplugin.html).

PCK `res://` is read-only. To update JSON after release, save downloaded data under `user://` and load it there. The reader itself makes no network requests. Executable distribution also needs the platform's Godot export template and required license notices.

## Regression checks

See [tests/README.md](tests/README.md) for runtime, CLI, Editor-integration, and safe-PCK test commands and requirements.

## Layout and licenses

- `addons/devcel/runtime/`: game readers.
- `addons/devcel/editor/`: dock and CLI integration.
- `samples/`: scene and bundles.
- `tests/`: reproducible regression checks.
- `.devcel/devcel.import.json`: shared settings, version-controlled and excluded from PCK.
- Other `.devcel/` settings/state/locks: local-only, excluded from Git and PCK.
- `test-output/`, `.godot/`: regenerable output, excluded from Git.

The addon and samples use the MIT [LICENSE](LICENSE), retaining the copyright notice from `devcel-core/LICENSE`. Keep `addons/devcel/LICENSE` when redistributing only that folder. Godot itself is not bundled; games containing Godot must follow its [license guidance](https://godotengine.org/license/).

For setup and automatic import, see the [Godot manual](../../docs/manual/godot.md).

## Per-source tag filters

In the source settings, select project tag presets for row include/exclude and column include/exclude. The choices come from that source's saved `.devcelproj.toml`; refresh presets after editing the project vocabulary. Filters are stored per source as `row_include_tags`, `row_exclude_tags`, `column_include_tags`, and `column_exclude_tags`. Empty include lists include all; multiple includes match any tag, and exclusions win. Content Version is applied in addition to these filters.

Names missing from the project's presets remain visible and editable after a merge. Correct them to a preset or explicitly remove them; they are never silently cleared. Import fails if an exported reference requires an excluded row, preserving the last good output. Save and import again after changing filters.
