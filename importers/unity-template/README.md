# Devcel Unity SDK

For installation, first import, and automatic import, start with the [Unity manual](../../docs/manual/unity.md). This guide covers settings, runtime APIs, packaging, and verification.

- **Authoring and generation:** the `devcel` CLI, backed by `devcel-core`, runs as a subprocess to generate typed C# accessors and version-filtered JSON bundles.
- **Reading in the Editor and game:** generated `database.Get(reference)` returns live typed handles backed by an eagerly prepared managed read model. Normal acquisition, including strings and nested references, does not allocate managed objects. Low-level raw `Row` access remains available; its string/reference getters can allocate and its rows must be reacquired after reload.

The editable Unity package template is under `importers/unity-template`; packaging generates its version from the canonical Tauri setting. Unity Editor 2021.3 or later is required.

## Package installation

Use **Window > Package Manager > + > Add package from git URL** (called **Install package from Git URL** in newer Unity versions). Use the following URL:

```text
https://github.com/devcel-dev/devcel.git?path=/importers/unity
```

Install Git on the Editor machine. The default branch supplies the latest generated package; append `#v<version>` to select a published release tag. The editable source template is `importers/unity-template`.

One Git URL supplies Windows x64, Linux x64, Intel macOS and Apple Silicon Editor CLIs; Windows/Linux x64 and macOS universal runtimes; and Android ARMv7/ARM64/x86/x86_64 and iOS device/Simulator runtimes in newly generated distributions. The Editor selects its CLI automatically, including an Intel process under Rosetta. Platform-specific plugin metadata selects Player libraries. No separate `org.devcel.native`, PATH CLI, registry or Git LFS is required. See the [mobile Player guide](Documentation~/MOBILE.md) for target modules and device requirements.

Commit `Packages/manifest.json` and `Packages/packages-lock.json` with the game. A dependency looks like `"org.devcel.unity": "https://github.com/devcel-dev/devcel.git?path=/importers/unity"`. Every team member uses the same URL. The immutable tag and lock file pin the package; releases never move an existing tag.

Release v0.0.2 includes the Git-installable package and Windows, Linux and macOS importer distributions. The older v0.0.1 release contains Windows/Linux importer ZIPs only.

### Updates and migration

Stop Play mode, remove an older Assets-based or embedded SDK copy and any `org.devcel.native` companion through Package Manager, preserving settings under `Assets/DevcelUnity/Editor` and generated game data. Add the complete Git package once.

To upgrade or roll back, change the Git URL to the desired published release tag, resolve the package in Package Manager, commit both package manifest and lock file, and restart Unity to unload the previous native library. Reimport sources to regenerate matching C#. Never combine SDK/CLI/runtime files from different distributions or edit `Library/PackageCache`.

OS-specific `.tgz` files remain an offline alternative: use **Add package from tarball**, keep the file at a stable project-relative location outside Assets/Packages and share it with the game. Choose the Editor RID (`win-x64`, `linux-x64`, `osx-x64`, `osx-arm64`); these tarballs are not interchangeable across desktop OSes. Older ZIPs use **Add package from disk** on the extracted `devcel-unity/package.json` and may lack mobile runtimes.

## Import workflow

Open **Devcel → Importer** and use the wizard to review the `.devcelproj.toml`, Source ID, namespace, root class name, per-environment Content Version, and JSON/code outputs. Click **Save and Import**. Subsequent saved changes in Studio import automatically. Add multiple sources as needed. With automatic import off, or to retry a failure, use the source's Import action, Import All, or **Devcel → Import All**. Inspect status and errors per source. Imports always use saved authoring data.

Sources with identical UUIDs remain separate through Source ID, namespace, output path, and DB instance. An existing `DevcelDatabaseAsset` selects a source through `projectName`. Namespace/output collisions are rejected across the whole configuration. If generated C# changes, let Unity compile before restarting Play.

`codeClassName` sets the optional root class; blank means `DevcelDatabase`. Namespace `Game.Master` and class `MasterData` produce `Game.Master.MasterData.Open(...)`. Table, row, and interface type names are unchanged. Play-mode reload uses the same namespace/class name.

Editor settings generate a pull configuration under `Library/Devcel/`, using the shared `devcel pull --config` contract. See [importer-pull.md](../../devcel-cli/docs/importer-pull.md) for CLI usage, partial failures, and atomicity boundaries. Each source saves `namespace`, optional `class_name`, and the selected environment's `version`. Blank class names and all-content version `-1` are omitted from JSON. Content Version is the numeric `0..4294967295` filter, separate from `schema_version`.

### Version control and relocated checkouts

- Share `Assets/DevcelUnity/Editor/DevcelImporterSettings.asset` and its `.meta`. Both Importer and Setup Wizard save source/code/JSON paths relative to the Unity project root, using `/`, whether entered manually or selected in a dialog.
- For `repo/Game/Assets` and `repo/Master/Main.devcelproj.toml`, the source is `../Master/Main.devcelproj.toml`. Preserve that layout across checkouts and version-control the project/table/interface sources. External sibling folders must also exist at the same relative location.
- Exclude `Library/` from Git. Runtime JSON configurations, state, and locks under `Library/Devcel/` are generated locally. Absolute execution paths are rebuilt from the current Unity root for each import/status operation.
- The CLI comes from the installed package for the Editor's OS/CPU. Reinstall the matching package if its manifest or executable is missing.
- Loading an existing settings asset leaves it unchanged. Convert old absolute paths through an explicit save on the original machine before sharing. If already relocated, reselect the source. Shared generated C#/runtime JSON and applicable `.meta` files can be consumed without authoring sources or CLI access.

Use the [Unity manual](../../docs/manual/unity.md) for setup and troubleshooting. Test the native Editor and Player on each target platform.

## Install

### Building from source

Use the [packaging workflow](../../docs/development/importer-packaging.md) to generate an installable UPM folder from a fixed checkout. The editable `importers/unity-template` is not a complete package; generate the package before using its distribution path. Product version, native source fingerprint and payload hashes are generated automatically. Never change those fields to force mismatched tools to load.

### Full distribution installation

Alternatively extract the matching ZIP and add its `devcel-unity/` folder as a local UPM dependency (`file:../path/to/devcel-unity`), embed it in `Packages/`, or copy it under `Assets/`. This distribution already contains the CLI and runtime; no companion is needed. GitHub source archives are not binary installation packages.

Follow the [Unity manual](../../docs/manual/unity.md) to register a source and perform the first import. Generated code and bundles remain under project `Assets`, never in `Packages` or `PackageCache`. Each Editor OS/CPU and Player target needs a supported matching native runtime; the installer does not substitute another platform's binary.

## Default outputs

For a source named `MyGame`, the defaults are:

- C#: `Assets/DevcelGenerated/MyGame/Devcel.cs`.
- JSON: `Assets/StreamingAssets/Devcel/MyGame/master.json`.
- Namespace: `Devcel.Generated.MyGame`.
- Root class: `DevcelDatabase`.

Configure these in the importer before the first import. Code output must remain under `Assets`. **Import before build** is off by default.

## Typed Inspector references and live handles

For a table `enemies` implementing `Damageable`, declare fields directly:

```csharp
[SerializeField] EnemiesReference enemy;
[SerializeField] IDamageableReference target;
[SerializeField] EnemiesReference[] wave;
[SerializeField] List<IDamageableReference> targets;

void UseData(GameDatabase database)
{
    var row = database.Get(enemy); // EnemiesHandle, or null when empty/missing
    var named = database.Get(EnemiesReferences.Slime);
    var damageable = database.Get(EnemiesReferences.Slime.AsDamageable());
    if (row != null && row.Exists) Debug.Log(row.Name);
}
```

The Inspector searches imported candidates, offers Clear, and retains missing UUIDs for repair. Ordinary fields and picker entries show authored row labels, or `Row N` for the 1-based row in the imported source table when no label exists. Filtering and pagination do not renumber rows; reimport/reorder updates the displayed number without changing the saved identity. Interface choices include the implementing table name. UUIDs remain searchable and serialized internally, but are not displayed in fields, picker rows, tooltips, or a details dialog. Table references are bound to the generated table UUID; interface references store both table and record UUIDs. A generated database type must identify one importer source: ambiguous sources produce an explicit Inspector error. Runtime resolution always uses the database instance you supply.

The typed field's **View** button opens a read-only record preview. It reads resolved values through the generated database and the selected table/interface contract, including interface overrides. Values are refreshed on opening, explicit Refresh, or an imported file change, rather than reopening the database on every Inspector repaint. Short values are right-aligned opposite their field labels; long or multiline values wrap in the value column and can be expanded, nested references are summaries rather than recursive editors, and missing targets produce a warning without clearing the serialized reference. This Editor-only preview does not change the runtime acquisition allocation contract.

Named keys preserve nonempty row labels exactly. Empty labels produce no symbol. Invalid, reserved or colliding symbols produce generation diagnostics instead of renaming records. A label rename changes code symbols but not serialized UUID identity. To author an Inspector object in code, explicitly use `EnemiesReferences.Slime.ToReference()`; this allocates an authoring object and is not the preferred runtime acquisition path.

`Get` acquires a read lock and looks up the UUID in a dictionary. In hot paths such as per-frame updates, resolve a reference once and retain the handle when practical; check `Exists` when a record may have been removed. Profile initialization time, peak memory and hot-path access with your actual data and target Player.

Keep the handle across successful database updates: properties read the current published values, even after row reorder. Strings and scalar values already copied out remain ordinary snapshots. A retained nested handle follows its original record UUID; reread its parent's property after the relationship changes. `Exists` becomes false for deleted records or detached interface views; property access throws rather than returning stale data. Disposal invalidates handles.

Managed objects, strings, indexes and interface views are prepared during load/reload. `Get`, successful property reads, `TryGet`, expected-missing checks and concrete collection traversal allocate zero managed bytes, including the first acquisition after publication. Concrete `foreach` uses a struct enumerator; casting to `IEnumerable<T>` boxes the enumerator, so prefer the concrete collection/indexer. Exception creation, Inspector construction, logging, and load/reload preparation are outside this acquisition guarantee. See the [allocation and regression harness](Tests~/TypedReferences/README.md) for measured coverage.

Generated reload/dispose APIs synchronize with reads. Direct external mutation/close through the low-level native `Handle` bypasses this contract and is unsupported. An invalid native bundle reload retains the last good data. A managed publication failure blocks reads until retry succeeds. Failure during database-owner replacement closes both native owners and leaves the original owner disposed; construct a new owner to recover. These failure modes never return partially published values.

## Read with generated code

```csharp
using Devcel.Generated.MyGame; // Configured namespace; default Devcel.Generated.<projectName>.
using Devcel.Unity;            // DevcelBundle helpers.

// Desktop, where StreamingAssets is a real filesystem path.
var db = DevcelDatabase.Open(
    DevcelBundle.ResolveStreamingAssetsPath("Devcel/MyGame/master.json"));
var hero = db.Heroes.ById("hero-uuid");
int hp = hero.Value.Hp; // Typed, O(1), allocation-free access.
if (db.ReloadIfChanged()) { /* New data is available. */ }
db.Dispose();
```

For environments where StreamingAssets cannot be opened directly, this helper retrieves text:

```csharp
yield return DevcelBundle.LoadText("Devcel/MyGame/master.json", json => {
    var db = DevcelDatabase.FromJson(json);
});
```

Generated complete Git packages and release UPM tarballs contain Android ARMv7/ARM64/x86/x86_64 and iOS device/Simulator runtimes after the next release; v0.0.2 contains Android ARM64 only. Use `LoadText` and `FromJson` on Android, where StreamingAssets may live inside the APK. See [mobile Players](Documentation~/MOBILE.md) for settings, native linking, build prerequisites and device acceptance. Newly generated releases also include a WebGL runtime; see [WebGL Player](Documentation~/WEBGL.md). Newly generated distributions include iOS Simulator runtimes; v0.0.2 does not.

## Color32 / ColorFloat

Runtime bundles use schema `1`; the native runtime uses API `1`. Generate the CLI, C#, SDK, and native library against the same contract. Importer settings and CLI package manifests also use schema `1`.

Generated properties return `DevcelColor32` (byte R/G/B/A) or `DevcelColorFloat` (float R/G/B/A). Saved/full-bundle cells contain JSON-array strings. Color32 components are integers in 0..255; ColorFloat components are finite f32, with negative/HDR RGB allowed and alpha in 0..1. White is used only when both the column default and cell value are omitted. An explicit empty string is invalid.

```csharp
var bytes = hero.Value.Color32;
UnityEngine.Color32 tint = DevcelBundle.ToUnityColor32(bytes.R, bytes.G, bytes.B, bytes.A);
var hdr = hero.Value.ColorFloat;
UnityEngine.Color hdrTint = DevcelBundle.ToUnityColor(hdr.R, hdr.G, hdr.B, hdr.A);
```

Conversion copies components explicitly, preserving RGB at alpha 0. It performs no sRGB/linear conversion, clamping, or premultiplication. To convert Color32 to floating-point Unity Color, explicitly divide each component by 255. Editor previews use type-specific C ABI getters rather than string/HTML color parsing.

## Manage multiple projects with ScriptableObjects

Create a `DevcelDatabaseAsset` through **Assets → Create → Devcel → Runtime Database**. For each project name, choose either a JSON `TextAsset` or a StreamingAssets-relative path. Reference the asset from a component and provide the generated factories:

```csharp
[SerializeField] private DevcelDatabaseAsset databaseAsset;
[SerializeField] private DevcelRecordReference heroReference;

void Start()
{
    var db = databaseAsset.GetDatabase("MyGame",
        Devcel.Generated.MyGame.DevcelDatabase.Open,
        Devcel.Generated.MyGame.DevcelDatabase.FromJson);
    if (heroReference.ProjectName != "MyGame" || heroReference.TableName != "heroes")
        throw new System.InvalidOperationException("Reference project/table does not match.");
    var hero = db.Heroes.ById(heroReference.Uuid);
}
```

The asset owns and shares each generated DB; callers must not dispose it. `CloseProject`, `CloseAll`, or asset disable releases it. On successful reload or `ReopenDatabase`, retained live handles follow the updated owner; raw generation-bound `Row` values must be reacquired. Malformed replacement bundles rejected before ownership transfer preserve the last good database. If managed publication fails after ownership transfer, both native resources are closed and the owner is disposed; construct a new owner to recover. File-backed DBs participate in Play-mode reload; TextAsset-backed DBs need an explicit reopen.

## Automatic import and reload

`syncMode` options:

- **Auto**, the default for new settings: `watch --ensure-server --parent-stdin` starts or shares a source server and subscribes to changes. FileWatch continues importing saved data while disconnected.
- **P2P:** uses the same server startup/subscription plus saved-file watching while connected. Automatic imports wait while disconnected.
- **FileWatch:** watches saved files without starting a server.
- **Off:** disables automatic import. Existing saved Off settings remain Off.

Auto/P2P import saved sources, never unsaved snapshots. Connection retries use 1/2/4/8/16/30-second backoff. Auto fallback still shows the cause as an Importer warning, with details in the Console. Settings changes, disabling a source's auto import, domain reload, and Editor shutdown stop only this importer's watch. Automatically started servers stop about five seconds after their last user, including other importers/Studio, disconnects. Pre-existing Studio/manual servers remain running. Main-thread notifications are debounced; failed imports retry after five seconds.

Schema changes regenerate code and require recompilation. Data-only updates regenerate the bundle and notify all matching open file-backed generated DBs with `ReloadIfChanged` during Play. Disable `reloadInPlayMode` to manage reload explicitly. `FromJson` DBs have no source file and receive no automatic notification. Use generated code supporting `ReloadOpenDatabases` for multiple namespaces/open DBs.

Notifications run on Unity's main thread. If other threads read a DB, disable automatic reload and synchronize access yourself. Old row handles become invalid after reload; obtain them again by ID.

## Editor preview and record references

Each source's **Preview** opens the bundle without Play. It provides table/UUID/value search and 25-row pages, read-only. Counts, UUID resolution, and cell values use the native runtime, so the Editor library must be installed. Reload the bundle after importing.

A serialized `DevcelRecordReference` field provides Project → Table → record selection, with label/ID search and pagination. Use `db.Heroes.ById(hero.Uuid)` and check `hero.ProjectName`/`TableName` against the intended DB/table. Only identifiers are stored. Deleted or version-filtered targets make `ById` return null. Existing UUIDs remain unchanged until explicitly cleared.

## Validation and pre-build import

Settings define the selected environment's numeric version and any additional environments. Import validates versions/environment registration, source existence, unique project names/namespaces/outputs, valid namespace/class, unambiguous project folders, and a single `.json` bundle filename. Generated code must be under this project's `Assets`. Saving applies changes to watches.

If **Import before build** is enabled, any failed source stops the Player build to prevent shipping stale data. Changed C# also stops the first build; rebuild after Unity compiles.

Build artifacts such as `devcel.exe` and native libraries are ignored by Git and must be packaged through `scripts/package-importers.py` with its mandatory checks.

## Editor / Player packaging

See [DISTRIBUTION.md](Documentation~/DISTRIBUTION.md). Managed code is constrained by asmdefs, native code by PluginImporter. The read-only runtime supports desktop Players and the [bundled mobile targets](Documentation~/MOBILE.md); the CLI stays in `Tools~`, settings in `Assets/DevcelUnity/Editor`.

Settings use schema `1` and long `contentVersion`; missing/mismatched schemas are rejected without modifying the asset. Bundled `.meta` files and idempotent repair cover Windows x64, Linux x64, macOS universal, Android ARMv7/ARM64/x86/x86_64 and iOS device/Simulator runtimes. Missing libraries, wrong CPUs, and invalid settings stop builds. Numeric versions are `0..4294967295`; only `-1` means all content. Release builds keep the selected environment.

## Tests

See [Tests~/README.md](Tests~/README.md) for the automatic-sync harness, prerequisites, and native Editor/Player checks.

## Per-source tag filters

In the source settings, select project tag presets for row include/exclude and column include/exclude. The choices come from that source's saved `.devcelproj.toml`; refresh presets after editing the project vocabulary. Filters are stored per source as `row_include_tags`, `row_exclude_tags`, `column_include_tags`, and `column_exclude_tags`. Empty include lists include all; multiple includes match any tag, and exclusions win. Content Version is applied in addition to these filters.

Names missing from the project's presets remain visible and editable after a merge. Correct them to a preset or explicitly remove them; they are never silently cleared. Import fails if an exported reference requires an excluded row, preserving the last good output. Save and import again after changing filters.

### Managed live-read memory

Live publication shares identical table views by both table UUID and required interface UUID. It deduplicates equal strings within that database publication, reuses stable record UUIDs across reloads, and shares table/interface state only through the same generated column binding. It does not use global string interning. Acquisition still uses the prepared read model; no string pooling or view creation is deferred to `Get` or getters.

`Dispose` clears managed record states, indexes and view registries as well as closing the native owner. Retaining one live handle after disposal does not retain the complete published dataset; accesses still throw `ObjectDisposedException`. Externally held missing handles keep their identity if the same record UUID reappears before disposal. Dead weak view entries are pruned during publication.

String deduplication uses temporary publication storage. Retained-memory savings depend on data repetition, and a smaller retained model does not guarantee a lower load-time peak or faster loading. Managed measurements exclude native runtime storage. Concrete collection iteration remains allocation-free; boxing through `IEnumerable`, explicit authoring reference construction and exception paths retain their documented allocation behavior.
