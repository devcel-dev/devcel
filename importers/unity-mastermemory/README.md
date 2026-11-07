# Unity and MasterMemory (experimental)

This prototype generates MasterMemory table types and a bundle-to-binary builder from a **full** Devcel runtime JSON bundle. Generate one bundle per assembly; generated assembly options and database type names are fixed. The generator uses Python 3. It handles multiple tables and stable record UUID primary keys. It does not yet integrate with the Unity importer UI, automatically rebuild assets, or provide live handles.

Install [MasterMemory](https://github.com/Cysharp/MasterMemory) 3.0.4, **MessagePack 3.1.11 or newer in the same 3.1 release line**, and Newtonsoft.Json into your Unity project. MasterMemory recommends NuGetForUnity; Newtonsoft.Json is available as Unity's Newtonsoft package. Follow MasterMemory's Unity and IL2CPP source-generator/resolver instructions, and check versions in your project. MasterMemory 3.0.4's minimum MessagePack 3.1.3 has known security vulnerabilities; do not use that minimum.

Export a full bundle with the [Devcel CLI](../../docs/manual/cli.md), then generate C# inside the Unity project:

```sh
python importers/unity-mastermemory/generate.py master.json Assets/Generated/DevcelMasterMemory.cs
```

For each table `enemies`, the generator defines `DevcelMasterMemory.DevcelRow_enemies`, a `RecordId` string primary key and `Value_<column_name>` properties. Numeric and Boolean fields use their C# types. String, Select, DateTime, Curve, Reference, TableRef, Color32 and ColorFloat are currently stored as their exact exported strings; no typed relationship, curve or color API is generated. Table and column names must be ASCII C# identifier-shaped names; unsupported names cause an error rather than silent renaming. JSON values and referenced schemas remain Devcel's export contract.

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

The builder checks bundle version, table count and UUID, column names, types and defaults against the generated schema, and rejects malformed or duplicate row IDs. Regenerate and recompile on schema changes. Never accept untrusted binary or JSON as game configuration without appropriate validation. Loading and conversion allocate; MasterMemory owns the resulting read-only snapshot. Rebuild and replace the database at a controlled point after export to observe updates. A previously held database remains a snapshot. Its performance and allocation behavior are separate from Devcel's generated live handles: profile on your target Player.

`MasterMemoryExample.csproj` is a separate hand-mapped .NET proof of concept. The generated code and Unity Roslyn source generators have been exercised in Unity 6000.3.28f1 Windows Mono and IL2CPP Players with MasterMemory 3.0.4 and MessagePack 3.1.11. The test placed NuGet DLLs and analyzers manually; installation through NuGetForUnity itself, other targets and large data still need validation. Unity integration and unsupported type representations remain experimental.

Run the reproducible .NET generator and runtime check with `python importers/unity-mastermemory/Tests/run.py` (requires a .NET SDK and NuGet access).
