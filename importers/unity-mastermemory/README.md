# Unity and MasterMemory: experimental proof of concept

This .NET example converts an exported Devcel full bundle into a MasterMemory database for one example table, then checks indexed reads. It is not yet a general Devcel-to-MasterMemory generator or a Unity integration package. The mapping from a Devcel table to a `[MemoryTable]` C# model is currently written by hand. Install and configure MasterMemory and MessagePack separately; see [MasterMemory](https://github.com/Cysharp/MasterMemory), including its Unity/IL2CPP resolver instructions.

```sh
dotnet run --project importers/unity-mastermemory/MasterMemoryExample.csproj -- path/to/bundle.json
```

The example expects an `enemies` table with string `name` and uses the Devcel row UUID as the primary key. The data is decoded and copied while building a new immutable database. Rebuild and replace it at a controlled point after export to observe changes; a previously held database remains a snapshot. This path has different memory and reload behavior from Devcel's generated live handles. Test performance and allocations in your target Player. Unity Editor and IL2CPP have not yet been validated for this example.
