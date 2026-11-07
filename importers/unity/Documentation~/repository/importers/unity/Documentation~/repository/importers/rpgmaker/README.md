# Devcel Importer for RPG Maker MV / MZ

Import saved Devcel projects as game-specific JSON. Access them through `Devcel.source("base")`; RPG Maker's Actors, Items, Enemies, and other built-in databases remain unchanged.

## First setup

1. Back up the game project.
2. Copy the release ZIP's `js` folder into the project so `js/plugins/Devcel.js` sits beside `js/plugins/devcel/`. Keep the name `Devcel.js`.
3. Add and enable `Devcel` in **Tools → Plugin Manager**.
4. Start desktop test play and press F6 to open the separate Devcel Import settings window.
5. Add a source and enter:
   - Source ID: `base`, a stable name used by the game.
   - Namespace: `Game.Base`. It must neither duplicate nor be a parent/child of another source's namespace.
   - Source project: select the `.devcelproj.toml`. Its path is saved relative to the game folder.
   - Runtime JSON: `data/devcel/base.json`. Output outside this directory or over the index JSON is rejected.
   - Class name: optional, for example `BaseData`. It is settings/runtime metadata; the UI does not generate JavaScript classes.
   - Content Version: blank includes all data; `0` is valid. A value `N` includes rows/columns with `min_version <= N`.
   - Format: start with `full`. `minimal` also loads the complete database by restoring defaults.
6. Save settings, then reimport all sources. The importer reads only saved Studio data; Studio can be closed.
7. Restart test play. Startup loads and validates every configured source before completing.

The importer selects the bundled CLI for your OS/CPU and verifies its manifest SHA-256 and version. If F6 conflicts with another plugin, set `ImporterKey` to false and use plugin commands.

### Plugin commands

- MZ: **Plugin Command → Devcel → Open Devcel Import Settings**.
- MV: `Devcel OpenImporter`.
- MZ: use the Devcel Reimport command with source ID `base` for one source.
- MV: `Devcel Reimport base`, or `Devcel Reimport` for all sources.

Import actions are available only in NW.js desktop test play. Browser/release games do not launch the CLI or access authoring files. Settings open in a local HTML window from the runtime, rather than an RPG Maker toolbar panel.

## Read data in a game

Use an event's Script command or your own plugin:

```javascript
var db = Devcel.source("base");
var heroes = db.table("Heroes");
var hero = heroes.byId("YOUR_RECORD_UUID");
if (hero) {
    $gameVariables.setValue(1, hero.get("hp"));
    $gameMessage.add(hero.get("name"));
}
```

- `db.tables()`, `db.table(name)`, `db.tableByUuid(uuid)`.
- `table.count()`, `table.ids()`, `table.columns()`, `table.columnInfo(name)`.
- `table.at(index)`, `table.byId(uuid)`: missing entries return `null`.
- `row.id`, `row.raw(column)`, `row.get(column)`.
- `row.reference(column)` resolves a record in the same source; `row.tableReference(column)` resolves a table in that source. Version-filtered targets return `null`.
- `Devcel.sourceIds()` and `Devcel.sourceInfo(id)` expose namespace, class name, and runtime path.

Copies with identical project/table/row UUIDs can use different source IDs and namespaces. Databases and references stay isolated per source.

### Types and values

| Devcel type | JavaScript value |
|---|---|
| String / Select / DateTime / None | String; DateTime is not converted to local time |
| I8/U8/I16/U16/I32/U32 | Number |
| I64/U64 | Exact decimal string, compatible with older MV without BigInt |
| F32/F64 | Finite Number; F32 is converted to float32 |
| Boolean | boolean |
| Color32 | `{r,g,b,a}`, 0..255 |
| ColorFloat | `{r,g,b,a}`, preserving negative/HDR RGB; alpha 0..1 |
| Curve | `row.get("growth").sample(0.5)` evaluates Devcel tangents |
| Reference / TableRef | UUID string from `get`; dedicated methods resolve it |

For I64/U64 arithmetic within Number's safe integer range, use `row.safeNumber(column)`. Out-of-range values raise an error rather than round. Colors use straight alpha without RGB clamping, sRGB/linear conversion, or premultiplication. `raw` preserves the canonical cell string.

## Changes and reimport

- Save the source, open F6 settings, and reimport the desired source.
- Save configuration changes before reimporting. After adding a new source, reimport all sources initially.
- Automatic live reload is unavailable. Restart test play after a successful reimport; the running DB and existing rows are otherwise unchanged.
- Invalid sources/settings and collisions preserve previous output. The index JSON updates only after every configured source reports ready.
- Concurrent reimport attempts are rejected. Status checks leave output unchanged.
- Removing a source from settings keeps its source and generated files. After saving, reimport the remaining sources to remove it from the runtime index.
- Share the root `devcel.import.json` through Git, including namespace, class name, version, and relative source/output layout.

## Release builds

Include the enabled `Devcel.js`, `data/devcel/index.json`, and each source JSON named by the index. Leave these JSON files unencrypted and present. Test the actual exported game folder.

Exclude:

- `js/plugins/devcel/`, containing the import UI and CLI.
- `devcel.import.json`, `.devcel-*` state/owner/lock files, and `.devcel-config-input-*`.
- Authoring sources, test fixtures, and SDK documentation.

The CLI and SDK runtime are MIT-licensed. Game builds do not need the CLI. When redistributing a CLI-containing importer ZIP, preserve its licenses and source information.

## Troubleshooting

- **Loading failed at startup:** confirm the generated source JSON and index are present. Release builds report missing data as an error.
- On the first test play only, a missing index allows startup with no sources so you can import with F6. Existing malformed JSON remains an error.
- **SHA-256/version mismatch:** extract `js/plugins/devcel/bin/` from the official importer ZIP again. Arbitrary executable fallbacks are unsupported.
- **Manually edited/owned by another source:** inspect the source, settings, and output. Back up needed edits, then move the affected generated files and ownership caches elsewhere. Leave active locks in place.
- Custom NW.js `node-main` configurations are outside the verified standard RPG Maker setup.

## Verification

Run `node tests/verify-runtime.cjs` for Node fixtures and `node tests/verify-editor.cjs /absolute/devcel /new/evidence-dir` for real-CLI integration.

These cover canonical JSON, CLI/settings, source isolation, corruption protection, and boot hooks under Node. Native MV/MZ test play, NW.js windows, file selection, and release builds need verification in the target engine.

Acceptance workflow: install in a new game → open F6 → cancel source selection → add two sources → save → import all → restart → display values → edit source → import one source → close/reopen settings → restart → remove CLI from release output → start the release. On errors, verify existing Actors/Items hashes remain unchanged.

## Official references

- [MV Plugin Specifications](https://rpgmakerofficial.com/product/MV_Help/page/01_11_03.html)
- [MZ annotations](https://rpgmakerofficial.com/product/mz/plugin/make/annotation.html)
- [Reading MZ official plugins](https://rpgmakerofficial.com/product/mz/plugin/make/koushiki.html)
- [NW.js Window](https://docs.nwjs.io/References/Window/)
- [NW.js Changes to Node](https://docs.nwjs.io/References/Changes%20to%20Node/)

## Per-source tag filters

In the source settings, select project tag presets for row include/exclude and column include/exclude. The choices come from that source's saved `.devcelproj.toml`; refresh presets after editing the project vocabulary. Filters are stored per source as `row_include_tags`, `row_exclude_tags`, `column_include_tags`, and `column_exclude_tags`. Empty include lists include all; multiple includes match any tag, and exclusions win. Content Version is applied in addition to these filters.

Names missing from the project's presets remain visible and editable after a merge. Correct them to a preset or explicitly remove them; they are never silently cleared. Import fails if an exported reference requires an excluded row, preserving the last good output. Save and import again after changing filters.
