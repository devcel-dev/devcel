# Roblox (experimental)

Export Devcel's full runtime JSON bundle with the [CLI](../../docs/manual/cli.md), then wrap it as a Luau ModuleScript:

```sh
python importers/roblox/export_module.py path/to/master.json path/to/roblox/src/DevcelData.luau
```

Add the file to your Rojo project tree as a ModuleScript and sync to Roblox Studio. For example, map a folder containing `DevcelData.luau` under `ReplicatedStorage` in your `.project.json`; see [Rojo's project format](https://rojo.space/docs/v7/project-format/). Alternatively, put the module on the server if the data must not be available to clients. In Luau:

```lua
local data = require(game:GetService("ReplicatedStorage").DevcelData)
for _, tableData in ipairs(data.tables) do
    print(tableData.name, #tableData.records)
end
```

The module decodes JSON once when required; this allocates and keeps the decoded data in memory. Record cell values in Devcel bundles are strings: applications must interpret them using the column `data_type`, and must handle 64-bit integers as strings where precision matters. This is a raw bundle reader, not generated typed accessors. Inspect the [runtime bundle contract](../../docs/reference/runtime-export.md) for its structure.

Author and version the TOML source in Git, then regenerate and publish the module with the game. This does not migrate or version player save data in DataStore. Do not place secrets or server-only data in ReplicatedStorage. There is no Studio plugin, automatic import or live reload yet. Rojo 7.7.1 has been checked locally by building a place and inspecting its generated ModuleScript. Studio import, large-data performance, platform limits and game execution still need validation before relying on this experimental integration.

The Devcel exporter is MIT licensed; see [LICENSE](LICENSE). Rojo and Roblox Studio are separate tools and are not included in this adapter.
