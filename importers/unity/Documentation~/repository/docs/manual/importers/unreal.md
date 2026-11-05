# Unreal Engine 5 importer

## Capabilities

The UE Editor wizard registers a saved `.devcelproj.toml`, namespace, class name, and content version. It supports saved-settings reimport, multiple isolated sources, complete local loading, typed Blueprint/C++ access, and data reload during PIE.

`importers/unreal/` is a source plugin targeting UE 5.5+ APIs. Build and execution must be validated for the intended UE version and OS. Repository source alone does not include a CLI binary.

## Installation

1. Install Unreal Engine and its compatible C++ toolchain: Visual Studio C++/Game development on Windows, supported Xcode on macOS, or the UE Linux toolchain.
2. For a Blueprint-only project, add a C++ class through `Tools → New C++ Class…` so the project can build native modules.
3. Close the editor. Extract the importer ZIP for the editor's OS/CPU into this layout:

```text
MyGame/
  MyGame.uproject
  Plugins/
    Devcel/
      Devcel.uplugin
      Source/
      Tools/
        manifest.json
        linux-x64/devcel          # Windows: win-x64/devcel.exe
      Tests/fixtures/
```

4. Regenerate IDE project files and build the game's Editor target. Enable Devcel Importer under `Edit → Plugins` and restart if needed. Data reimport cannot replace an initial native module build.
5. Open `Tools → Devcel Importer`. Missing CLI or mismatched hash/version/OS/CPU stops import and requires the matching ZIP.

`Tools` is Editor-only. The runtime module does not depend on CLI, Studio, Rust runtime libraries, or a P2P server. Referenced `.uasset` files become game data through normal cooking.

## Add a source

`Add Source…` opens a separate three-step wizard:

1. **Choose source:** enter a unique source ID using letters, digits, `_`, or `-`, and select the `.devcelproj.toml` file.
2. **Import settings:** enter namespace, class name, and content version. Blank version means all content; zero is valid and the maximum is `4294967295`. Uncheck Minimal JSON for Full.
3. **Review and import:** review source, settings, and asset destination, then choose `Save and Import`.

Preset discovery reads the selected project before the final action. Settings are saved only when you choose Save and Import. Back/Cancel can discard the draft. Once save/import starts, closing the wizard does not cancel it. Use `Stop Import` in the main importer; this also disables Auto. An active configuration save/Pull reaches its safe commit/rollback boundary before later asset publication is canceled. Duplicate submissions are blocked. A stale draft cannot overwrite settings edited by another window without reloading/reediting.

Namespace and class name remain saved metadata. This importer uses common `UDevcelDataAsset` and `FDevcelValue` types; it does not generate per-source C++ classes, UCLASSes, or Blueprint types. New data columns use the same reader API.

## Settings and reimport

| Data | Location |
|---|---|
| Shared import configuration | `<game>/Config/Devcel.import.json` |
| Auto configuration | `<game>/Config/DevcelEditor.json` |
| CLI intermediate JSON | `<game>/Intermediate/Devcel/<source ID>/master.json` |
| Distributable asset | `/Game/Devcel/<source ID>/Database` |

```json
{
  "schema_version": 1,
  "sources": [
    {
      "id": "base",
      "project": "../../authoring/Main/Main.devcelproj.toml",
      "namespace": "Game.Base",
      "class_name": "BaseData",
      "runtime_out": "../Intermediate/Devcel/base/master.json",
      "mode": "full",
      "version": 0
    }
  ]
}
```

All relative paths are based on the configuration's `Config/` directory. Select the project file itself. Sources on a volume that cannot be represented relatively are rejected. Cloning the game and authoring project in the same relative layout preserves settings. See [CLI Pull](../../../devcel-cli/docs/importer-pull.md) for the shared configuration and protections.

`Edit…` changes one source; `Reimport` updates that source; `Reimport All` updates all registered sources. Source IDs are stable asset identities and cannot be edited; add another source instead. Class-name changes affect metadata, not asset paths.

Copies with identical project/table/record UUIDs are allowed when source IDs, namespaces, output paths, assets, and snapshots are distinct. Tables do not merge across sources. Namespace checks reject case variants, equivalent `.`/`::` separators, and ancestor/descendant collisions.

## Blueprint access

1. Add a `Devcel Data Asset` variable to an Actor Blueprint and assign its generated Database asset as a default or Instance Editable value.
2. Call `Load` and show Error if false. Getters also load internally, but explicit loading makes failure handling clearer.
3. Enumerate `Get Tables` and `Get Record Ids`. Record IDs are Devcel UUIDs, not display labels.
4. Call `Get Value` with table name, record ID, and column name. If successful, use `Break Devcel Value`.

| `FDevcelValue.Type` | Field |
|---|---|
| String / Select / DateTime / None / Reference / TableRef | `Raw` |
| I8 / I16 / I32 / I64 | `SignedInteger` |
| U8 / U16 / U32 / U64 | `UnsignedDecimal`, an exact decimal string because Blueprint integer pins cannot represent all U64 values |
| F32 / F64 | `Number`; F32 applies its wire-type rounding |
| Boolean | `Boolean` |
| Color32 | `Color32` (`FColor`), preserving RGBA bytes |
| ColorFloat | `ColorFloat` (`FLinearColor`), preserving negative/HDR RGB and RGB at zero alpha |
| Curve | `Raw`; `Sample Curve` evaluates stored Bezier tangents and constant/linear/auto/autoLength/free modes |

Import does not apply sRGB conversion, RGB clamping, or premultiplication. Apply display/material conversions deliberately in game code. ColorFloat alpha is validated within 0–1.

`Resolve Reference` resolves within the owning source. `Resolve Table Reference` also checks the required interface. Empty references or targets excluded by content version return false with Error; they never fall back to another source.

## C++ access

Add the runtime module in the game's `.Build.cs`:

```csharp
PublicDependencyModuleNames.Add("DevcelRuntime");
```

Hold an ordinary asset reference so the asset is also included in cooking:

```cpp
#include "DevcelDataAsset.h"
// In the Actor header, keep its .generated.h as the final include.
UPROPERTY(EditAnywhere, Category="Devcel")
TObjectPtr<UDevcelDataAsset> MasterData;
```

```cpp
FString Error;
FDevcelValue Hp;
if (MasterData && MasterData->GetValue(TEXT("Heroes"), HeroUuid, TEXT("hp"), Hp, Error))
{
    const int64 Health = Hp.SignedInteger;
}
uint64 ExactValue = 0;
if (MasterData)
    MasterData->GetUnsignedInteger(TEXT("Heroes"), HeroUuid, TEXT("huge"), ExactValue, Error);
```

Integers do not pass through JSON doubles, preserving values such as `9007199254740993` and `18446744073709551615`. `FDevcelValue` is a value copy; retrieve it again after reimport. Use load/get/replace on the game thread.

## Auto and live data reload

Auto defaults to polling CLI `pull --status` every five seconds for saved source/settings/output hashes and Pulls when needed. Long CLI operations run asynchronously, one at a time. Configuration save and Pull are not forcibly timed out; Editor shutdown waits for active mutations to finish. Read-only version/help probes have a fifteen-second timeout. Failures appear in logs/UI with increasing retry delays. A ready JSON result can be republished if a previous asset save failed.

Import fully parses and validates a new snapshot before publication. Only after successful asset saving does it notify the current asset. Matching PIE duplicate assets update and emit `OnReloaded(Revision)`; unrelated user duplicates and other sources remain unchanged. Refresh Blueprint caches/UI by calling getters from this event. Byte-identical JSON does not cause redundant notifications.

This is data reload, separate from C++ Live Coding. New data columns work through the generic reader, while plugin UCLASS/USTRUCT/header changes require normal native rebuilding with the editor closed. If using Live Coding, follow Epic's object-reinstancing and reference-update rules.

Auto reads saved local files only. It does not import Studio's unsaved edits, fetch another machine's data, or provide remote distribution/import in shipped games.

## Failure safety and recovery

- Shared `pull-config-save` validates all settings, locks, and atomically replaces the configuration. Invalid namespaces or versions preserve the old file.
- CLI publishes complete validated results. A failed source retains old JSON; separate sources are not one transaction.
- UE validates complete JSON before asset creation. It will not overwrite an unrelated asset type, mismatched ownership marker, unreadable asset, or package with unsaved edits.
- Asset saving writes a temporary file and uses same-directory OS atomic replacement without deleting the destination first. Failure restores old in-memory content/revision and emits no reload event. Multiple outputs are not a power-loss-safe transaction.
- If CLI JSON succeeds but UE asset saving fails, the last valid asset remains. Fix checkout/write permissions/disk space and choose Reimport; already-ready JSON can be republished without editing the source again.
- If settings change during import, asset publication stops. Reimport using current settings.
- Forced termination/power loss may interrupt CLI transactions. Check status and reimport after restart.
- Missing or mismatched CLI requires the correct OS/CPU ZIP. Do not bypass Gatekeeper, SmartScreen, or other security warnings.

Track shared configuration, optional Auto settings, and generated Content assets. Exclude intermediate outputs, state/owner/lock files, and temporary candidates:

```gitignore
Intermediate/
Config/*.devcel-state.json
Config/*.devcel-lock
Config/.devcel-candidate-*.json
```

## Game distribution

Cook Database assets referenced by maps, Blueprints, or C++ objects. For soft-only references, register additional cooking through Asset Manager or Packaging. Do not add raw authoring data, editor settings, CLI, or CLI source archives to game copies. Intermediate JSON is not the cooked asset. Runtime module dependencies are Core, CoreUObject, Engine, and Json.

## Verification

From the repository root:

```sh
python3 importers/unreal/Tests/verify_importer.py --static-only
python3 importers/unreal/Tests/verify_importer.py --cli /absolute/devcel --out /absolute/new-empty-evidence
```

Static checks and standalone integer/curve helpers do not establish UE native correctness. Build an isolated C++ project's Editor target, install the plugin including fixtures, and run:

```text
UnrealEditor-Cmd MyGame.uproject -unattended -NullRHI -ExecCmds="Automation RunTests Devcel.Integration.FullLoadIsolationReload" -TestExit="Automation Test Queue Empty" -ReportExportPath=/absolute/UEReport
```

Check complete loading, two-source isolation, 64-bit/HDR/reference/curve/Minimal behavior, and preservation after invalid JSON. Then verify in the actual Editor:

1. Every wizard Back/Cancel and canceled Browse; stale drafts in multiple windows; repeated submit; close/stop during import.
2. Two sources with identical UUIDs. Reimport one and verify the other's JSON/asset hashes remain unchanged.
3. Blueprint assignments, saved changes during PIE, `OnReloaded`, fresh lookups, exact U64 strings, and HDR values.
4. Unrelated same-name assets, read-only assets, invalid sources/settings, and CLI hash mismatches preserve the old asset.
5. Force asset-save failure, then recover from ready CLI JSON using Reimport.
6. Package and run without CLI. Verify complete runtime loading, source isolation, and exclusion of authoring/settings/Tools.

Report UHT/UBT, Slate UI, asset replacement, PIE, automation, cooking, packaged games, and each OS separately. CLI/helper results are not substitutes for these checks.

## Official API references

- [ToolMenus startup callback](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Developer/ToolMenus/UToolMenus/RegisterStartupCallback?application_version=5.5)
- [DesktopPlatform OpenFileDialog](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Developer/DesktopPlatform/IDesktopPlatform/OpenFileDialog)
- [FMonitoredProcess](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Core/Misc/FMonitoredProcess?application_version=5.5)
- [FJsonSerializer](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Json/Serialization/FJsonSerializer?application_version=5.5)
- [UPackage / SavePackage](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/CoreUObject/UPackage)
- [Live Coding and object reinstancing](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-live-coding-to-recompile-unreal-engine-applications-at-runtime)
- [Managing C++ game code](https://dev.epicgames.com/documentation/unreal-engine/managing-game-code-in-unreal-engine)

## Per-source tag filters

In the wizard's import settings, use **Refresh project tag presets**, then select row/column include/exclude presets. Each source stores its own `row_include_tags`, `row_exclude_tags`, `column_include_tags`, and `column_exclude_tags` arrays. Empty includes select all; multiple includes use OR (any matching tag); exclusions win. Content Version also applies. Unknown saved names remain editable: correct them to project presets or explicitly remove them. Save and Import applies the change. A reference to an excluded row fails the import and preserves the last good output.
