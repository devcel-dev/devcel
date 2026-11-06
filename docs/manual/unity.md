# Import data into Unity

[Manual](README.md) / [Getting started](getting-started.md) / [CLI](cli.md) / [Synchronization](collaboration.md)

Import saved Devcel tables into Unity and check Studio edits in a running game. Start with a working copy of [ManualBasics](../../examples/manual-basics/README.md).

## 1. Prepare the projects

You need a saved manifest and its Tables folder, plus the complete Git UPM package. A source-code archive does not include the required executable.

The Devcel Unity package declares Unity **2021.3** as its minimum. Packaging generates its `package.json` version and native manifest from the canonical Studio product version in `tauri.conf.json`. Its native source fingerprint and payload hashes bind the SDK to the bundled tools; the runtime's **API_VERSION is 1**.

### Folder layout

```text
repo/
  ManualBasics/
    ManualBasics.devcelproj.toml
    Tables/
  UnityGame/
    Assets/
```

Put generated JSON/code outside the source project and reserve its output paths for generated files.

## 2. Import for the first time

### Install the package

1. Open **Window > Package Manager > + > Add package from git URL** (or **Install package from Git URL**).
2. Enter `https://github.com/devcel-dev/devcel.git?path=/importers/unity`. To pin a release, append `#v<version>` using a published tag listed by [Releases](https://github.com/devcel-dev/devcel/releases). Git must be installed on your computer.
3. The same URL includes all four desktop Editor CLIs, desktop runtimes and Android/iOS ARM64 device runtimes. No native companion or PATH CLI is required.
4. Open **Devcel > Importer**.

Release v0.0.2 includes the Git-installable package and Windows, Linux and macOS importer distributions. The older v0.0.1 release contains Windows/Linux importer ZIPs only.

The default branch contains the most recently generated package after the first new release. The editable template is `importers/unity-template`. Preserve the Git dependency in `Packages/manifest.json` and its resolved commit in `Packages/packages-lock.json`.

![Importer after a successful reimport, with FileWatch enabled](images/unity-importer-overview.png)

For upgrades or rollback, select a different published `v<version>` in the Git URL, resolve packages, commit the manifest and lock file, restart Unity, and regenerate game sources. Remove older embedded/Assets SDK copies and an `org.devcel.native` companion when migrating. The [SDK installation guide](../../importers/unity/README.md) includes migration and offline ZIP/tarball alternatives.

The screenshots below show Devcel 0.0.2 in Unity 6.3 LTS on Windows. They use the same sample with content version 2 after the version-filter exercise; use version 1 for the initial steps below.

### Complete the three-step wizard

Choose **+ Add source project…**. **Devcel → Setup Wizard** opens the same workflow.

1. **Source selection**
   - Source ID: master
   - Select the saved .devcelproj.toml file
   - Choose Next
2. **Generation settings**
   - Namespace: Game.Master
   - Root class: MasterDatabase
   - Code output: Assets/DevcelGenerated/Master
   - JSON output: Assets/StreamingAssets/Devcel/Master
   - Bundle filename: master.json
   - Environment: Development
   - Content version: 1; use -1 for all content
3. **Review and import**
   - Review source, environment, version, type names, and destinations
   - Choose Save and import, then wait for import and Unity compilation

![Source selection with a project-relative path](images/unity-wizard-source.png)

![Generation destinations and type names](images/unity-wizard-generation.png)

![Review before saving and importing](images/unity-wizard-review.png)

Expected files:

```text
Assets/DevcelGenerated/Master/Devcel.cs
Assets/StreamingAssets/Devcel/Master/master.json
Assets/DevcelUnity/Editor/DevcelImporterSettings.asset
```

Unity's code destination is a **folder**; the generated filename is Devcel.cs. Check JSON manifest.content_version equals 1 and the generated C# namespace/class are Game.Master/MasterDatabase. See the [sample guide](../../examples/manual-basics/README.md) for expected data.

### Tag filters for this source

In the source wizard’s **Generation settings**, configure **Tag filters (this source only)**. Use **Refresh project tag presets** after changing the saved vocabulary, then review the filters and choose **Save and import**.

![Per-source tag filters and content version, reached by scrolling](images/unity-wizard-tag-filters.png)

The four filters are **row include**, **row exclude**, **column include**, and **column exclude**. Each source keeps its own selections. An empty include list includes all rows or columns; multiple includes use OR (any matching tag), and exclusions take priority. Content Version also applies.

Choose names from the source project’s saved tag presets. A saved name missing from those presets remains visible and editable: correct it to a preset or explicitly remove it. If an exported reference needs an excluded row, import fails and preserves the previous output.

## 3. Edit in Studio and check automatic import

Keep Unity Editor and Studio open:

1. Open the registered ManualBasics copy and its enemies table. Its saved display name is `Enemy Data`.
2. Find the Slime row, labeled `Slime`, and change hp from 100 to 150. Confirm with Enter.
3. Choose **File → Save project** and wait for completion.
4. Return to Unity and wait for import success. Compilation and asset refresh can delay processing.
5. Inspect Assets/StreamingAssets/Devcel/Master/master.json. If a bundle preview is already open, use **Reload bundle**.

Expected results:

- manifest.content_version remains 1.
- Slime hp is `"150"` and double_hp is `"300"`, evaluated strings in runtime JSON.
- Dragon and the reward column begin at version 2 and remain absent.
- A value-only edit may leave generated C# unchanged.

Use generated JSON for inspection; edit source values in Studio.

## 4. Read imported data in the game

### Run a test component

1. Create a separate C# script named ReadMaster.cs under Assets.
2. Replace it with the code below and save. Keep its filename and class name aligned.
3. Wait for compilation, create an empty GameObject, and attach the script.
4. Enable **Hot-reload in Play mode** in the importer's common settings and press Play. The Console should show **Slime HP: 150**.

```csharp
using Devcel.Unity;
using Game.Master;
using UnityEngine;

public class ReadMaster : MonoBehaviour
{
    private MasterDatabase db;
    private int? lastHp;

    void Start()
    {
        db = MasterDatabase.Open(
            DevcelBundle.ResolveStreamingAssetsPath("Devcel/Master/master.json"));
    }

    void Update()
    {
        if (db == null) return;
        var enemy = db.Enemies.ById("11111111-1111-4111-8111-111111111111");
        if (!enemy.HasValue) return;
        int hp = enemy.Value.Hp;
        if (lastHp != hp)
        {
            Debug.Log($"Slime HP: {hp}");
            lastHp = hp;
        }
    }

    void OnDestroy()
    {
        db?.Dispose();
    }
}
```

The component reacquires the row each frame and logs only changes. During Play, another Studio edit/save triggers Auto import, then hot reload updates the database.

- ById searches by row UUID. Missing or version-excluded rows return null.
- Open(path) reads a file; FromJson(text) reads supplied JSON. Both require the native runtime.
- Dispose databases you open yourself.
- After ReloadIfChanged, reacquire rows by UUID. A malformed update fails while preserving the current valid database.
- Importer Play hot reload targets file-backed databases. FromJson has no backing file and receives no automatic file notification.
- If generated C# or the class name changes, wait for compilation and restart Play.

Alternatively, create a DevcelDatabaseAsset through **Assets → Create → Devcel → Runtime Database**. For each source, set projectName and exactly one of a JSON TextAsset or StreamingAssets-relative path.

```csharp
var db = databaseAsset.GetDatabase("master",
    Game.Master.MasterDatabase.Open,
    Game.Master.MasterDatabase.FromJson);
```

The asset owns this database and disposes it through CloseProject, CloseAll, or asset deactivation. The caller leaves disposal to the asset. After replacing a TextAsset, use ReopenDatabase and reacquire rows.

## 5. Settings and paths

Settings are stored in projects within Assets/DevcelUnity/Editor/DevcelImporterSettings.asset. Paths are relative to the Unity project root, the parent of Assets. The example source is `../ManualBasics/ManualBasics.devcelproj.toml`.

An execution config is generated at Library/Devcel/devcel.import.json. Change persistent settings through the importer editor.

Source, JSON, and code paths save relatively. Windows cross-drive layouts that cannot be relativized are rejected. Preserve source/game relative positions after moving or cloning, including any external sibling folder.

Keep the settings asset and .meta, source manifest/Tables, any required generated JSON/C# and .meta, and package-version information. Library execution config/state/lock and adjacent *.devcel-state.json, *.devcel-owner.json, and *.devcel-lock are local state to exclude from version control. Regeneration needs the settings, source, and matching CLI.

### Versions by environment

Per-source environments[].contentVersion accepts 0–4,294,967,295; only -1 means all content.

- Environments can be Development, Staging, or Production.
- Initial registration creates Development. Add others through **Edit settings… → Generation settings → Versions for all environments**.
- Register the target environment on every source before changing **Common settings → Current environment**.
- Missing, duplicate, or out-of-range settings are rejected. Player builds retain the selected environment rather than automatically choosing Production.

Editing values does not increment content versions. See [Versions](versions.md).

## 6. Add multiple sources

Register the second source through the same wizard:

| Setting | master | event |
| --- | --- | --- |
| Source ID | master | event |
| Source | ../ManualBasics/ManualBasics.devcelproj.toml | ../Event/ManualBasics.devcelproj.toml |
| Namespace | Game.Master | Game.Event |
| Root class | MasterDatabase | EventDatabase |
| Development version | 1 | 2 |
| JSON folder | Assets/StreamingAssets/Devcel/Master | Assets/StreamingAssets/Devcel/Event |
| Bundle filename | master.json | event.json |
| Code folder | Assets/DevcelGenerated/Master | Assets/DevcelGenerated/Event |

IDs, namespaces, and output destinations must be distinct. Case-only ID/namespace changes, parent/child namespaces, and paths resolving to the same file are collisions. Separate projects can share table/row UUIDs; use a separate database instance for each source.

Automatic import updates changed sources only. Even a single-source import checks collisions across the full configuration, so another invalid registration can block it. Successful sources keep their outputs when an all-source import partly fails.

## 7. Automatic import

| Mode | Trigger | Server unavailable |
| --- | --- | --- |
| Off | Manual only | Manual import works |
| FileWatch | Saved project/table/interface changes | Continue from files |
| P2P | Notifications and file changes while connected | Acquire/reconnect; pause automatic import on failure |
| Auto | P2P notifications plus file watching | Acquire/reconnect and continue from files |

1. Open **Devcel → Importer → Common settings**.
2. Select **Automatic import mode**, shared across sources.
3. In a source's **Edit settings…**, enable **Automatic import** and confirm with Save and import.
4. Inspect its synchronization and import status.

A common mode of Off or a disabled source automatic-import checkbox stops automatic imports for the affected scope.

### Observe changes during Play mode

With FileWatch enabled and **Reload in Play mode** selected, keep a generated database open while entering Play mode. Save a source value and wait for import to complete. The importer reloads matching open native databases; reacquire row objects after a generation change before reading their values.

### P2P lifetime

Auto/P2P acquires a same-computer server per source through the bundled CLI. Existing Studio, manual CLI, or importer servers are shared. Connection failures retry with increasing delay up to 30 seconds; inspect the error cause.

Off, source removal, and editor exit close the importer's own connection. Managed servers stop about five seconds after the last importer/editor leaves; preexisting Studio/manual servers remain running. Temporary import failures retry after approximately five seconds.

## 8. Manual import and retry

Use a source's **Import**, **Import all**, or **Devcel → Import All**.

For manual-only operation, set the common automatic mode to Off. Save in Studio, then import when needed. Restore Auto through the same setting.

## 9. Build and runtime requirements

- Editor import platforms and Player targets are separate. A single-RID ZIP may not include the native runtime for another target OS.
- Native layouts currently cover Windows x64, Linux x64, and macOS universal. macOS needs both x86_64 and arm64 slices.
- Newly generated Git UPM packages include Android ARMv7, ARM64, x86 and x86_64 (API 23+) and iOS ARM64 device (iOS 13+) runtimes. Release v0.0.2 includes Android ARM64 only. Install the Unity target module and follow the [mobile Player guide](../../importers/unity/Documentation~/MOBILE.md). Android x86 (32-bit) requires a Unity version that supports it; iOS Simulator remains unsupported; WebGL in a newly generated distribution is described in the [WebGL guide](../../importers/unity-template/Documentation~/WEBGL.md). FromJson still requires the native runtime; CLI execution remains Editor-only.
- **Import before build** defaults to Off. When enabled, failed imports or changed generated C# stop the build; compile changed code before rebuilding.
- Configuration and runtime-layout validation still runs when pre-build import is off. Already imported JSON, generated code, and required runtime can build without source projects or the CLI.
- Player contents use runtime JSON, generated code, and runtime libraries. Keep editor CLI, source TOML, and authoring settings out of Resources and StreamingAssets.

### Platforms and verification

Release v0.0.2 includes the Git-installable package and Windows, Linux and macOS importer distributions. The older v0.0.1 release contains Windows/Linux importer ZIPs only. The build pipeline supports win-x64, linux-x64, osx-x64 and osx-arm64. Windows/Linux arm64 Editors are not supported. Linux requires the documented glibc 2.39 baseline; validate the actual artifact on the target system. Build success is not Editor or Player execution acceptance.

See [Unity package layout](../../importers/unity/Documentation~/DISTRIBUTION.md), [Bundled CLI](../development/importer-packaging.md).

## 10. Troubleshoot import

Saved Unity settings remain after an import failure. Correct the cause and retry.

| Symptom | Check |
| --- | --- |
| Missing CLI or hash mismatch | Complete matching OS/CPU package |
| Source missing | Manifest selection and relative layout |
| No automatic import | Mode, per-source enablement, connection, then manual import |
| Old JSON | Save completion, import success, eligible content version |
| Type/namespace error | ASCII identifiers, reserved words, generated-type collisions, other sources |
| Cannot switch environment | Valid target environment on every source |
| Import succeeds but reading fails | Native OS/CPU/layout, C# compilation, row UUID, content version |
| Not checked after restart | Refresh with Check status and errors |
| Output owned by another config | Duplicate destinations or copied local caches |

Wait for active imports before retrying. After a crash, check status, reimport, and compile generated code. Files replace individually, so interruption can leave a partial set.

**Check status and errors** distinguishes Imported, Verified (inputs/configuration match outputs), and Import needed.

For cache/owner conflicts, verify no other work uses the outputs, stop watchers/CLI, back up and remove only the affected configuration's stale cache/owner files, then reimport. Preserve active locks. See [Status and recovery](collaboration.md#6-status-and-recovery).
