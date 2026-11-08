# Unity and MasterMemory (experimental)

This prototype generates MasterMemory table types and a bundle-to-binary builder from a **full** Devcel runtime JSON bundle. Generate one bundle per assembly; generated assembly options and database type names are fixed. The generator uses Python 3. It handles multiple tables and stable record UUID primary keys. The optional Unity Editor integration rebuilds generated code and a binary asset after a successful import; it also generates update-following handles backed by a versioned row cache.

Install [MasterMemory](https://github.com/Cysharp/MasterMemory) 3.0.4, **MessagePack 3.1.11 or newer in the same 3.1 release line**, and Newtonsoft.Json into your Unity project. MasterMemory recommends NuGetForUnity; Newtonsoft.Json is available as Unity's Newtonsoft package. Follow MasterMemory's Unity and IL2CPP source-generator/resolver instructions, and check versions in your project. MasterMemory 3.0.4's minimum MessagePack 3.1.3 has known security vulnerabilities; do not use that minimum.

In Unity, configure one existing Devcel importer source for a **full** export. Open **Devcel → MasterMemory (Experimental)**, enter that source ID and a Python 3 executable, and enable **Build after import**. Import the source: the Editor generates `DevcelMasterMemory.cs` in that source's code-output folder, waits for successful script compilation when the schema changes, and writes `<bundle-name>.mastermemory.bytes` beside the JSON under Assets. Import errors and missing dependencies are reported in the Console. For Play-mode data reload, use the generated LiveDatabase as described below. After Play mode, the Editor regenerates the output asset from the latest export. Schema changes require leaving Play mode and recompiling the regenerated source. Existing raw row and database references remain snapshots.

The Editor records hashes of files it creates in local Editor preferences. It refuses to overwrite pre-existing or externally modified output. On a second machine, **Adopt matching existing outputs** only accepts files that exactly match a fresh generation and the current bundle; it does not modify them. If they differ, inspect them and select a clean output location rather than overwriting them. One MasterMemory source per assembly is supported because the generated database namespace is fixed.

The generator and its MIT license are included in the complete Unity package under `Tools~/MasterMemory`; MasterMemory, MessagePack, Newtonsoft.Json and Python are installed separately. As an alternative, export a full bundle with the [Devcel CLI](../../docs/manual/cli.md), then generate C# inside the Unity project:

```sh
python importers/unity-mastermemory/generate.py master.json Assets/Generated/DevcelMasterMemory.cs
```

For each table `enemies`, the generator defines `DevcelMasterMemory.DevcelRow_enemies`, a `RecordId` string primary key and `Value_<column_name>` properties. Numeric and Boolean fields use their C# types. Color32 and ColorFloat use `DevcelColor32` and `DevcelColorFloat` RGBA value types. Curve values use `DevcelCurve.Sample(x)` with the same tangent and interpolation rules as the Devcel runtime. Configured row references use a typed value with `Resolve(database)`; table references provide `As_<table>(database)` only for compatible tables. An unconfigured row reference exposes its identity without pretending a target type is known. String, Select and DateTime remain strings. Table and column names must be ASCII C# identifier-shaped names; unsupported names cause an error rather than silent renaming. JSON values and referenced schemas remain Devcel's export contract.

After Unity has compiled the generated source and MasterMemory source generator, register its resolver before reading or building data, especially for IL2CPP:

```csharp
[UnityEngine.RuntimeInitializeOnLoadMethod(UnityEngine.RuntimeInitializeLoadType.BeforeSceneLoad)]
static void ConfigureDevcelResolver()
{
    var resolver = MessagePack.Resolvers.StaticCompositeResolver.Instance;
    resolver.Register(DevcelMasterMemory.DevcelMasterMemoryResolver.Instance,
                      MessagePack.Resolvers.StandardResolver.Instance);
    MessagePack.MessagePackSerializer.DefaultOptions =
        MessagePack.MessagePackSerializerOptions.Standard.WithResolver(resolver);
}
```

If your project already configures MessagePack, compose the generated resolver into the existing configuration rather than replacing it or registering twice. For editor-time generation, configure the resolver in that editor process too. Then build the binary at an editor-controlled import step:

```csharp
byte[] data = DevcelMasterMemory.BuildData.FromJson(jsonText);
// Save the bytes as a game asset. At runtime:
var database = new DevcelMasterMemory.DevcelMemoryDatabase(data);
var enemy = database.DevcelRow_enemiesTable.FindByRecordId(recordUuid);
```

For optional Unity Editor Play-mode updates, enable **Build after import** above and **Hot-reload in Play mode** in the Devcel importer. Construct a `LiveDatabase` on the Unity main thread with the initial binary and the absolute path to the matching exported JSON bundle:

```csharp
var live = new DevcelMasterMemory.LiveDatabase(binaryBytes, sourceBundlePath);
var enemy = live.Get_enemies(recordUuid); // Create once and retain the handle.
var hp = enemy.Value_hp;                 // Cached row; follows later reloads.
// For the fastest reads, retain enemy.Current and reacquire it when live.Version changes.
```

The generated table-specific handle caches its row and re-resolves it only when `live.Version` changes. `TryGet(out row)` returns false for a deleted or missing record; field access and `Current` throw `KeyNotFoundException` in that case. A handle is allocated when created, not on each successful field access; profile on your target Player. A directly retained row is a snapshot and avoids handle checks until you reacquire it.

The matching successful import rebuilds a replacement database and swaps `Current` on the Editor main thread. A previously cached row stays a snapshot; compare `Version` at a controlled point and reacquire it to see changes. Dispose `live` on its owner thread when no longer needed. Invalid or incompatible input keeps the previous database. Schema changes require exiting Play mode, regenerating and recompiling. This prototype rebuilds the complete database synchronously on update and may pause the Editor or allocate substantial memory. It is not a background incremental update, a Player networking feature, or an automatic update of cached rows. Measure it with your own data.

The builder checks bundle version, table count and UUID, column names, types, defaults and reference/curve configurations against the generated schema, and rejects malformed values, incompatible table references and duplicate row IDs. Regenerate and recompile on schema changes. Never accept untrusted binary or JSON as game configuration without appropriate validation. Loading and conversion allocate; MasterMemory owns the resulting read-only snapshot. Outside the Editor live integration, rebuild and replace the database at a controlled point after export to observe updates. A previously held database remains a snapshot. Its performance and allocation behavior are separate from Devcel's generated live handles: profile on your target Player.

`MasterMemoryExample.csproj` is a separate hand-mapped .NET proof of concept. The initial generated scalar code and Unity Roslyn source generators have been exercised in Unity 6000.3.28f1 Windows Mono and IL2CPP Players with MasterMemory 3.0.4 and MessagePack 3.1.11. Typed references, colors and curves were also exercised in a Windows IL2CPP Player; 100,000 warmed-up reference resolutions and curve samples reported zero managed bytes on the calling thread. The test placed NuGet DLLs and analyzers manually; installation through NuGetForUnity itself, other targets and large data still need validation. The optional Unity import integration and remaining unsupported type representations are experimental.

Run the reproducible .NET generator and runtime check with `python importers/unity-mastermemory/Tests/run.py` (requires a .NET SDK and NuGet access).

For the optional Unity Editor smoke test, use a **disposable** Unity project with the complete Devcel package embedded and MasterMemory, MessagePack and Newtonsoft.Json dependencies/analyzers configured. Copy `examples/manual-basics` into `DevcelFixture` at the Unity project root, and create an empty `DevcelFixture/.devcel-mastermemory-smoke` marker. Copy `Tests/UnityEditorSmoke.cs.txt` to the embedded package `Editor/DevcelMasterMemorySmoke.cs`, set `DEVCEL_SMOKE_PYTHON` to the Python 3 executable, and run Unity in batch mode with `-executeMethod Devcel.Unity.Editor.DevcelMasterMemorySmoke.Run` (do not pass `-quit`; the test exits itself). It requires clean output paths, edits the marked fixture and tests generated binary overwrite protection; do not run it on a real project. A passing run logs `DEVCEL_MASTERMEMORY_EDITOR_SMOKE_PASS`.


## Licenses and dependencies

The Devcel adapter and the support code copied into generated C# are MIT licensed; generated C# includes the Devcel MIT notice. This repository does not bundle the MasterMemory, MessagePack, Newtonsoft.Json or NuGetForUnity binaries in this adapter. Install them separately and retain the applicable license and copyright notices when redistributing a game or a package containing them.

The versions used in the local checks were [MasterMemory 3.0.4](https://github.com/Cysharp/MasterMemory/blob/7b7a65da66749e3d49dabed7e087448bb19af549/LICENSE) (MIT), [MessagePack 3.1.11](https://github.com/MessagePack-CSharp/MessagePack-CSharp/blob/v3.1.11/LICENSE) (MIT), and [Newtonsoft.Json 13.0.3](https://github.com/JamesNK/Newtonsoft.Json/blob/13.0.3/LICENSE.md) (MIT). MasterMemory also uses its Annotations package; MessagePack uses its matching Annotations and source-generator packages and platform-dependent transitive dependencies. Resolve the full dependency graph with the package manager and preserve its own notices; this list is not an exhaustive third-party inventory. The separate Devcel Unity SDK distribution has its own bundled CLI/runtime notices.
