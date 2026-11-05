# Devcel Importer for WOLF RPG Editor

Generate files for WOLF's official CSV import and mappings for Devcel types and UUIDs. The importer leaves WOLF's proprietary `DataBase.dat`, `CommonEvent.dat`, and existing game databases unchanged.

## Workflow

- Register, save, and reimport individual or all sources through the bundled CLI's browser UI.
- Keep relative `.devcelproj.toml` paths, namespace, class name, Content Version, and full/minimal format in shared settings.
- Keep each source isolated, including copies with identical UUIDs.
- Read complete saved projects with the CLI and generate canonical JSON plus WOLF CSV/schema files.
- Import the CSV manually using WOLF's official controls into a **new, dedicated variable-database type**.

Namespace and class name are configuration metadata. The bridge does not generate native WOLF classes. Editor-integrated menus, direct database updates, and automatic live reload are unavailable; after reimport, explicitly load the new CSV in WOLF.

## Setup

1. Back up the complete WOLF game folder.
2. Extract the release ZIP to a working folder, keeping `StartImporter.cmd` beside `Tools/`.
3. On Windows, double-click `StartImporter.cmd` and select the game folder containing `Data`.
4. The browser opens the import settings UI. The launcher verifies the bundled CLI's manifest hash/version. No separate Node.js, Python, or CLI installation is needed.
5. Add a source with its `.devcelproj.toml`, ID (`base`), and namespace (`Game.Base`). Source paths are relative to the game folder, for example `../Authoring/Base.devcelproj.toml`.
6. Class name is optional. Leave Content Version blank for all data; `0` is valid. Version `N` includes rows/columns with `min_version <= N`.
7. Choose a separate runtime output such as `devcel_generated/base.json`. Save and reimport. Studio can be closed once the source is saved.
8. Read `devcel_generated/wolf/base/IMPORT.txt` and `schema.json`, then follow the WOLF import steps below.
9. Press Ctrl+C in the CLI window when finished. Closing the browser alone leaves the CLI running.

If Windows execution policy blocks the launcher, follow your organization's policy or ask its administrator. The importer does not change or bypass it. You can launch the extracted CLI directly in Command Prompt, for example `Tools\bin\win-x64\devcel.exe importer-ui --engine wolf --root "C:\Games\MyGame"`. Use `win-arm64` for ARM64 Windows.

Settings are saved in the selected game's `devcel.import.json`. Preserve the source/game relative layout when moving computers. State, owner, and lock files are machine-local caches; exclude them from Git.

### Import CSV in WOLF

1. Start with a disposable copy of the game.
2. Open the variable database and append a dedicated new type. Keep existing battle/system types separate.
3. Select a table from `schema.json`'s `tables`. Create fields in `columns[].index` order, all as strings. Field 0 is `__devcel_record_uuid` and stores the Devcel record UUID.
4. Set the data count to `record_count`. Each CSV represents one Devcel table.
5. Use WOLF's official **Load Data from CSV** action for the corresponding `csv` file. The first row contains field names; subsequent rows contain data. Exact UI wording varies by WOLF version.
6. Verify rows containing Japanese text, commas, quotes, and line breaks. Read the multiline-cell limitation below.
7. Save normally, then use **DB Operations** in test play to read values into string variables.
8. Assign every other source/table to its own dedicated type, including sources with identical UUIDs.

For event-driven loading at game startup, use the official **DB Operations → CSV Input** command. Explicitly copy generated CSV into a location such as `Data/Devcel/base/` and set the event path. The exporter does not copy files into `Data`. Respect WOLF's event-path restrictions, including prohibited `..`, absolute paths, and `//`.

## Values and WOLF types

WOLF numeric variables cannot represent all Devcel U64/F64/HDR/structured values. CSV fields therefore preserve canonical values as strings, with types in `schema.json`'s `devcel_type`.

- Integers: exact decimal strings, including U64 `18446744073709551615`.
- Floating point: decimal text, without implicit integer rounding.
- Boolean: `true`/`false` text, interpreted explicitly by the game.
- Color32: original `[r,g,b,a]` text, each component 0..255.
- ColorFloat: original `[r,g,b,a]`, including negative/HDR RGB, without clamping, sRGB conversion, or premultiplication.
- Curve: JSON text including tangents. No automatic conversion or evaluation in WOLF numeric variables.
- DateTime: original text with no timezone conversion.
- Reference/TableRef: record/table UUID strings, without replacement by numeric IDs.

Design ranges and units before explicitly converting a column to WOLF numbers. WOLF's documented limits include 32-bit optimized integer arithmetic and the usual ±2-billion range; U64/HDR values cannot be copied safely into numeric variables unchanged.

### Reference mappings

`table_uuid` identifies a table, `records[].uuid` identifies a record, and `records[].index` is its zero-based CSV data position. `reference_config.target_table_uuid` and `table_ref_config.interface_uuid` are retained.

For a reference to `abc-uuid` in source `base`, look up that target in `base`'s schema and map it to the dedicated WOLF type/data position. The same UUID in another source is separate data. Content Version may exclude a target. Row order can change on reimport, so use UUIDs as persistent IDs in save data.

## CSV format and limitations

- UTF-8 with BOM, CRLF record separators, and a header row.
- Every cell is double-quoted; embedded `"` becomes `""`.
- Embedded CR/LF and tabs are retained as RFC4180 multiline cells.
- Maximum 99 data columns plus the UUID column and 10,000 records per table. Exceeding a limit returns an error and preserves old output rather than truncating it.
- NUL and WOLF's reserved data-name marker `<<!--DATANAME--!>>` are rejected because they cannot be handled safely.
- Native WOLF CSV loading, especially multiline cells, is not established by the CLI checks. Import into a test database with your chosen WOLF version and verify unchanged strings before production use.

Spreadsheet applications can alter leading zeroes, U64 values, dates, or formula-like text when resaving CSV. Edit the Devcel source and regenerate instead of using exported CSV as an editing spreadsheet.

## Reimport and output protection

- Save the source, then reimport all sources or a selected source in the settings UI.
- CSV import into WOLF remains manual. Check field order and record count, and update the dedicated type's data count so deleted rows do not remain.
- From the CLI, run `devcel pull --config devcel.import.json --source base`, followed by `devcel wolf-export --config devcel.import.json --source base`.
- `wolf-export` requires ready settings, source, and runtime; stale or modified runtime JSON is rejected.
- All CSV/schema files are prepared and validated before publication into the source's dedicated directory. OS locks reject concurrent conversion; ownership and content hashes protect other sources and manually edited files.
- Publication failures restore the previous source directory. There is no all-source transaction across power loss. Inspect any leftover `.backup-*` directories before recovery.
- Output collisions with sources or other configured outputs, symlink destinations, and existing unowned directories are rejected.

## Release builds

After manual import, use WOLF's normal save and game-data packaging workflow. The CLI, UI, settings, caches, and authoring source are unnecessary in the game. Include copied CSV in `Data` only when the game explicitly loads it through events. SDK documentation/launchers and the bundled CLI are MIT-licensed. Preserve bundled licenses and source information when redistributing the CLI.

## Verification

Run `python3 tests/verify_export.py /absolute/devcel /new/evidence-directory` from this importer directory.

Real-CLI fixtures cover Japanese text, quotes/newlines, U64/HDR, full/minimal exports, identical UUIDs in different sources, per-source reimport, stale JSON rejection, and manual-edit/ownership protection. This uses the CLI and a standard CSV reader; it does not validate WOLF, the Windows launcher UI, or native PowerShell execution.

## Official references

- [Database](https://silversecond.com/WolfRPGEditor/Help/05database.html): string/numeric fields, types, and loading.
- [DB Operations](https://silversecond.com/WolfRPGEditor/Help/04ev_db.html): CSV input, runtime loading, path restrictions, and count limits.
- [CSV format examples](https://silversecond.com/WolfRPGEditor/old_releaselog/ReleaseLog03.html): header row followed by data.
- [Implicit specifications](https://silversecond.com/WolfRPGEditor/Help/01specifi.html): numeric ranges, reserved CSV marker, and database-name resolution.
- [String Operations](https://silversecond.com/WolfRPGEditor/Help/04ev_string.html): UTF-8/BOM and encoding detection.

## Per-source tag filters

In the source settings, select project tag presets for row include/exclude and column include/exclude. The choices come from that source's saved `.devcelproj.toml`; refresh presets after editing the project vocabulary. Filters are stored per source as `row_include_tags`, `row_exclude_tags`, `column_include_tags`, and `column_exclude_tags`. Empty include lists include all; multiple includes match any tag, and exclusions win. Content Version is applied in addition to these filters.

Names missing from the project's presets remain visible and editable after a merge. Correct them to a preset or explicitly remove them; they are never silently cleared. Import fails if an exported reference requires an excluded row, preserving the last good output. Save and import again after changing filters.
