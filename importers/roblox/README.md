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

The exporter converts the string cells in Devcel's JSON bundle to typed values. Booleans and up to 32-bit integers and floating-point fields become Luau booleans and numbers. `I64` and `U64` remain decimal strings to preserve all bits because Luau numbers cannot exactly represent every 64-bit integer. Strings, Select and DateTime remain strings.

Color fields are RGBA tables with numeric `r`, `g`, `b`, `a` fields: Color32 components are 0–255; ColorFloat preserves the exported float components, including HDR values, with alpha in 0–1. They are not Roblox `Color3` values, which do not include alpha. Curves provide `value:Sample(x)` with Devcel's interpolation and configured endpoints. Configured row references and table references provide `value:Resolve()`, returning the referenced record or table, or `nil` if empty or absent. An unconfigured row reference retains its ID but cannot resolve without a target. Table references with interface constraints reject incompatible tables during export.

The module decodes its data once when required; this allocates and keeps the decoded data in memory. These are dynamically typed tables rather than generated Luau type declarations. Inspect the [runtime bundle contract](../../docs/reference/runtime-export.md) for its source structure. The generated module includes the Devcel MIT notice.

Author and version the TOML source in Git, then regenerate and publish the module with the game. This does not migrate or version player save data in DataStore. Do not place secrets or server-only data in ReplicatedStorage. There is no Studio plugin, automatic import or live reload yet. Rojo 7.7.1 has been checked locally by building a place and inspecting its generated ModuleScript. The typed converter was tested with the official Luau CLI using a mocked HttpService, including references, RGBA values and curve samples against the Devcel runtime. A local Studio smoke test on Windows with Studio 0.746.0.7461269 loaded a Rojo-built place and executed the generated ModuleScript. Published-game behavior, large-data performance and platform limits still need validation before relying on this experimental integration.

The Devcel exporter is MIT licensed; see [LICENSE](LICENSE). Rojo and Roblox Studio are separate tools and are not included in this adapter.

## Local Studio smoke test

After signing in to Roblox Studio, run the optional local test with official Studio and Rojo executables:

```sh
python importers/roblox/test_studio.py --studio /path/to/RobloxStudio --rojo /path/to/rojo
```

The test creates a temporary place with an exported ModuleScript, opens it with Studio's `RunScript` CLI and checks typed colors, references, curves, numeric values and 64-bit strings. It does not publish a place. Studio must be signed in and able to open local places. This smoke test does not replace testing a deployed game, large data sets or device-specific behavior.
