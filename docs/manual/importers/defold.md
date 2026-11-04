# Defold Importer Setup

Register Devcel projects from Defold's Project menu and import JSON with the bundled CLI. The runtime uses plain Lua and standard Defold APIs, with no native extension. Editor scripts target Defold 1.13.2's `editor.ui`, `editor.execute`, and JSON APIs.

## First setup

1. Extract the Defold ZIP for your OS/CPU and copy its `devcel/` folder beside `game.project`. Review differences before replacing an existing folder. `devcel/tools/manifest.json` and the bundled CLI are required; source-only archives omit the executable.
2. Open the game and choose **Project → Reload Editor Scripts**.
3. Choose **Project → Devcel: Add Source**.
4. Enter a source ID (`base`), project (`../authoring/Game.devcelproj.toml`), and namespace (`Game.Master`). Class name is optional. A blank Content Version includes all content; `0` is valid. Press Enter or move focus to commit each field.
5. Leave JSON output blank for `devcel_generated/base.json`, and start with `full` mode. Save the settings to `devcel.import.json` in the game root.
6. Choose **Project → Devcel: Reimport** and select `base`. After success, `editor.execute` refreshes the Editor resource tree. Errors appear in the Console and previous output is preserved.
7. In `game.project`, add the **generated JSON file itself** to **Project → Custom Resources**, for example `/devcel_generated/base.json`. Separate multiple files with commas and retain existing entries. Selecting the whole output folder could also ship CLI ownership/cache files.
8. Load it from your `.script`:

```lua
local devcel = require "devcel.runtime.database"
function init(self)
    self.master = devcel.new("base")
    assert(self.master:load_resource("/devcel_generated/base.json"))
    local hero = self.master:by_id("Heroes", "hero-1")
    print(hero:get("hp"))
end
```

Replace the table name and ID with your data. To try the example unchanged, copy `samples/master.full.json` to the output path and register it as a Custom Resource.

## Settings and reimport

- Edit an existing source, save, and reimport. Reimport All processes every source; status prints the CLI's saved state to the Console.
- `project` identifies the `.devcelproj.toml` file. Relative paths use `devcel.import.json` as their base. Keep source/game layout consistent across checkouts.
- Source IDs are stable keys and cannot be renamed in the UI. Add a new source instead. Output names and namespaces must be unique.
- Namespace and `class_name` are saved as metadata. This importer does not generate Lua classes; use separate databases such as `local master = devcel.new("base")`.
- Sources with identical UUIDs remain isolated. Reference/TableRef resolves only within its own DB.
- After changing Content Version, reimport and inspect `db:manifest().content_version`. This differs from the format's `schema_version`.
- The bundled CLI's `pull-config-save` validates settings and replaces them atomically. Save or revert any direct JSON edits before using the settings UI.
- Unknown column keys are rejected. A complete new snapshot is constructed before replacement, and failures preserve the previous snapshot. Existing row/table handles retain old data; obtain fresh handles after reload.

### Per-source tag filters

Tag filters are stored on each source entry in `devcel.import.json` as `row_include_tags`, `row_exclude_tags`, `column_include_tags`, and `column_exclude_tags` string arrays. Save the source settings and reimport after changing filters.

The four filters are **row include**, **row exclude**, **column include**, and **column exclude**. Each source keeps its own selections. An empty include list includes all rows or columns; multiple includes use OR (any matching tag), and exclusions take priority. Content Version also applies.

Use exact names from the source project’s saved tag presets. Preserve a saved name missing from those presets until you correct it to a preset or explicitly remove it. If an exported reference needs an excluded row, import fails and preserves the previous output.


## Live updates

Refreshing the Editor resource tree and refreshing a running game's data are separate steps. Custom Resource JSON is included at build time; resource refresh alone does not notify running Lua.

### Native desktop Debug: poll generated JSON

```lua
function init(self)
    self.master = devcel.new("base")
    assert(self.master:load_resource("/devcel_generated/base.json"))
    assert(self.master:watch_file("/ABSOLUTE/MyGame/devcel_generated/base.json", 1,
        function(db, ok, changed)
            if not ok then print(db.last_error)
            elseif changed then print("Updated", db:by_id("Heroes", "hero-1"):get("hp")) end
        end))
end
function update(self, dt) self.master:update(dt) end
function final(self) self.master:stop_watch() end
```

Windows also accepts absolute paths such as `C:/Games/MyGame/devcel_generated/base.json`. Save in Studio and reimport the source to update the running game. Changed bytes are revalidated even when file size and manifest are unchanged. Loading errors and malformed data retain old values. The minimum polling interval is 0.25 seconds; this example uses one second.

`watch_file` is Debug-only and reads successfully generated JSON. HTML5/mobile builds should use `load_resource` for shipped JSON rather than development-machine paths.

### Explicit reload and HTTP

After `load_resource` or `load_file`, call `reload_if_changed()` to reload explicitly. `samples/controller.script` shows an `on_reload(self)` integration; standalone JSON hot reload is not automatic.

When using the CLI's Importer UI server, Debug builds can call `db:watch_http("http://127.0.0.1:PORT/runtime/base?token=SESSION_TOKEN", 1, callback)`. Keep the same `update` and `final` methods. Use the current session URL shown by the CLI; never save or ship its token. HTTP errors, invalid snapshots, and callbacks arriving after Stop preserve existing values. HTTP timeout is five seconds.

Both paths read saved source → Pull → generated JSON. Unsaved edits and P2P synchronization are outside this runtime workflow.

## Typed values and API

- `db:table(name)`, `table_by_uuid(uuid)`, `by_id(table,id)`: missing entries return `nil`.
- `table:count()`, `ids()`, `columns()`, `column_info(name)`, `at(index)`: Lua indices start at 1.
- `row:get_raw(column)` returns the normalized string; `row:get(column)` returns a typed value.
- I8 through U32 use numbers. I64/U64 use **exact decimal strings**; conversion to Lua numbers can round large values.
- F32/F64 are finite numbers; Boolean is boolean; String/Select/DateTime/None are strings.
- Color32/ColorFloat use `{r,g,b,a}`. Color32 components are 0..255. ColorFloat preserves negative/above-one HDR RGB and RGB at alpha 0, without gamma conversion, premultiplication, or RGB clamping.
- Curve returns a table of points. Empty cells retain the configured start/end values. This runtime has no curve evaluation helper.
- `row:reference(column)` and `row:table_reference(column)` resolve within the same source. Version-filtered targets return `nil`.
- Full and minimal exports are supported; omitted minimal cells use column defaults. Returned colors, arrays, and metadata are copies, so changing them leaves the database intact.

## Pre-build import and game builds

If needed, merge the functions from `samples/hooks.editor_script.example` into the existing root `hooks.editor_script`. Preserve existing hooks. Defold invokes lifecycle hooks only from that root file. Bob CLI builds do not run Editor hooks, so CI must run `devcel pull --config ...` first.

Include only generated JSON in Custom Resources. Exclude the CLI, settings JSON, owner/state/lock files, source archives, authoring source, and tokens. `require` includes `devcel/runtime/database.lua` in the game. A CLI checksum, version, or RID mismatch stops import; reinstall the matching ZIP. OS signature warnings, SmartScreen, Gatekeeper, and PowerShell execution policies are not bypassed automatically.

## Verification

The host Lua 5.4/stub harness covers full/minimal exports, references, integer limits and 64-bit precision, HDR/transparent colors, multiple sources, preservation after failure, equal-size file changes, HTTP errors, callbacks after Stop, and Lua/Editor-script syntax. It does not validate Defold's LuaJIT/Editor Lua VM, Editor UI, or native targets.

From the repository root, run `python3 importers/defold/tests/runtime_workflow.py --require-lua`. It uses Python's standard library and an existing system Lua 5.4 library. A missing library fails with `--require-lua`; otherwise it exits 77 (SKIP). See [tests/README.md](../../../importers/defold/tests/README.md). Python is a verification dependency, not an importer runtime dependency.

On Defold, first register the three JSON fixtures described in `samples/runtime-smoke.script` and run it to check unknown-column rejection and preservation after failure. Then verify:

1. Add source → save → restart → edit → per-source/all reimport → status.
2. Blank/zero/boundary Content Versions, namespace/class name, and project paths containing spaces and Japanese text.
3. Two sources with identical UUIDs; pulling one must leave the other unchanged.
4. Invalid TOML, namespace collision, invalid class name, and unwritable output; previous JSON/game values must remain usable.
5. Debug file polling after save/reimport, schema and equal-size value changes, and Stop/restart.
6. Offline Release/HTML5 loading with the CLI stopped, preserving existing Custom Resources and hooks.

Official references: [Editor scripts](https://defold.com/manuals/editor-scripts/), [Editor UI](https://defold.com/manuals/editor-scripts-ui/), [editor.execute](https://defold.com/ref/alpha/editor/#editor.execute:command-...-options), [Hot reload](https://defold.com/manuals/hot-reload/), [Custom Resources](https://defold.com/manuals/project-settings/), [JSON](https://defold.com/ref/json-lua/).
