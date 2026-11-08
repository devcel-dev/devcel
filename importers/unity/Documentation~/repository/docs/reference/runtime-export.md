# Runtime export and generated-code development

This guide covers JSON bundles, C#/C++/TypeScript generation, and reader contracts for runtime development and custom editor integrations. For standard importers, see [Godot](../manual/godot.md), [Unity](../../../../INSTALL.md), and the [CLI reference](../manual/cli.md).

## Data flow

Studio/CLI editing → version-filtered, formula-evaluated export → Runtime JSON plus generated access code → runtime snapshot loading → typed table/row/interface/reference access in game code.

The native runtime parses a complete bundle into optimized snapshots. Generated scalar accessors avoid repeated parsing; string access may copy depending on the language. Standard importers use Auto to import saved changes after initial setup. Custom integrations can call `devcel export ...` or `devcel pull ...`.

## C# acquisition and marshalling

The generated C# has two distinct layers. `database.Get(key)` returns a managed live Handle; successful acquisition and handle property reads use the prepared read model and are designed to allocate zero managed bytes. Load/reload, Inspector reference creation, exceptions and boxed interface enumeration are outside that contract. Unity callers use the main thread; see the [Unity guide](../../../../INSTALL.md#allocation-and-threading-contract).

The low-level `Table.ById(string)` passes its input UUID to native code with UTF-8 marshalling and returns a nullable value-type Row. UTF-16 to UTF-8 conversion is work, but **marshalling does not by itself establish a managed GC allocation**. In a Windows Unity 6000.3.28f1 Mono Player test, 100,000 warmed-up `ById` calls with a pre-existing UUID string reported 0 managed bytes on the calling thread; this did not measure native buffers. Temporary buffer strategy and allocation behavior depend on runtime and platform, so profile IL2CPP and other targets before generalizing that result. A low-level scalar getter calls native code. A nonempty native string getter converts the result to a managed `string`; a low-level reference getter reads that string and then resolves the row. Empty strings may use `string.Empty`. Caching a Handle can avoid repeated dictionary lookup; caching a raw Row is only valid until reload or disposal. Do not infer end-to-end per-frame allocations just from a P/Invoke signature.

## CLI export

```bash
# Full bundle, all content versions.
devcel --project <proj> export runtime --out master.json

# Minimal bundle with rows/columns eligible through version 5.
devcel --project <proj> export runtime --minimal --version 5 --out master.json

# Typed C#, C++, and TypeScript access code.
devcel --project <proj> export code csharp --out Devcel.cs
devcel --project <proj> export code cpp --out Devcel.h
devcel --project <proj> export code typescript --out Devcel.ts
```

Place `devcel.export.toml` beside the project or specify another path:

```toml
# Paths are relative to this configuration file.
[[runtime]]
out = "Assets/StreamingAssets/master.json"
mode = "full"       # full or minimal; defaults to full
version = 3         # omit for all content

[[code]]
out = "Assets/Scripts/Generated/Devcel.cs"
target = "csharp"
version = 3

[[code]]
out = "Source/Game/Generated/Devcel.h"
target = "cpp"
version = 3
```

```bash
# Search project root, then current directory, for the configuration.
devcel --project <proj> export run
# Or select it explicitly.
devcel --project <proj> export run --config path/to/devcel.export.toml
```

Output parent directories are created. Results use JSON:

```json
{"ok":true,"data":{"config":"...","outputs":[
  {"kind":"runtime","out":"...","mode":"full","version":3,"content_hash":"..."},
  {"kind":"code","out":"...","target":"csharp","bytes":5147}
]}}
```

## Custom editor integrations

Standard importers validate their bundled CLI. A custom extension may use an explicit executable path or a deliberately configured PATH installation. The read-only `devcel-runtime` library does not export authoring data; launch the CLI as a subprocess.

A Unity editor integration should configure `ProcessStartInfo` with `UseShellExecute=false`, redirect stdout and stderr, and read both concurrently to avoid pipe deadlocks. Pass the project path as a properly escaped argument or through a supported argument-list API. Run `export run`, wait without freezing the editor, verify both exit status and JSON `ok`, then refresh assets on the editor thread. Never treat process creation alone as successful export.

An Unreal Editor module can use `FPlatformProcess::CreateProc` or its monitored-process abstraction to run:

```text
devcel --project <project-file> export run --config <export-config>
```

Ordinary command success exits 0; execution failure exits 1 with structured stdout. Logs are on stderr. `--project` or `DEVCEL_PROJECT` selects the source. Keeping export configuration in the engine project makes its relative destinations portable.

## Runtime loading

For C#/C++, install the target-compatible `devcel-runtime` native library where the game can load it, include generated `Devcel.cs`/`Devcel.h`, and open the bundle:

```csharp
using var db = Devcel.Generated.DevcelDatabase.Open("master.json");
var hero = db.Heroes.ById("hero-uuid");
int hp = hero.Value.Hp;
if (db.ReloadIfChanged())
{
    // Retrieve rows again after a snapshot replacement.
    hero = db.Heroes.ById("hero-uuid");
}
```

`ReloadIfChanged` replaces the snapshot when the content hash changes, after validation. See the [Godot addon](../../importers/godot/README.md) for a reader without a Rust native library or .NET dependency.

### Reader contracts

- Schema version 1 includes table UUIDs, implemented/inherited interface UUIDs, and typed Reference/TableRef/Curve settings.
- Minimal omissions restore from column defaults. Invalid numeric ranges, unknown types, and duplicate identities fail loading.
- Export uses same-directory atomic replacement and never silently omits unreadable tables.
- Successful native C#/C++ reload invalidates previously obtained rows from that database. Retrieve them again by UUID. Stale or closed/disposed rows fail instead of silently referring to another row.
- C++ Database is move-only RAII. Rows from references or temporary tables safely follow the moved database and reject use after close/destruction.
- `devcel_rt_get_str` pointers and C++ `string_view` are borrowed until reload/close. C# String getters copy into managed strings. Callers must synchronize concurrent reads with reload/close.
- Invalid namespaces and generated type/API name collisions fail generation rather than emitting uncompilable source.
- CLI success is not proof of engine import, Play Mode, or packaged-game success.

## Content Version and validation

Pass the same Content Version to runtime export and code generation. With target version `n`, rows and columns are included when `min_version <= n`; omitting the version includes all content. Output names are determined against the complete schema before projection, keeping generated names stable across versions.

An included formula can depend on an excluded column. That dependency is still evaluated, but it is not added to the output. Cross-table query rows follow the selected release. Invalid values in excluded columns do not block output unless an included formula needs them. An unevaluable formula cannot be exported with `--allow-invalid`; ordinary constraint warnings and formula errors are different failures. Failed validation preserves the previous output.

## Multiple projects in one application

Use one complete bundle and database instance per `.devcelproj.toml`, with separate output directories and explicit sibling namespaces:

```bash
devcel --project Alpha.devcelproj.toml export runtime --out data/Alpha/master.json
devcel --project Alpha.devcelproj.toml export code csharp --namespace Game.Alpha --out generated/Alpha/Devcel.cs
devcel --project Beta.devcelproj.toml export runtime --out data/Beta/master.json
devcel --project Beta.devcelproj.toml export code csharp --namespace Game.Beta --out generated/Beta/Devcel.cs
# Dot-separated namespaces generate C++ namespace scopes.
devcel --project Alpha.devcelproj.toml export code cpp --namespace Game.Alpha --out generated/Alpha/Devcel.h
devcel --project Beta.devcelproj.toml export code cpp --namespace Game.Beta --out generated/Beta/Devcel.h
```

Each `[[code]]` section also accepts `namespace = "Game.Alpha"`. Sharing default namespaces (`Devcel.Generated` for C#/TypeScript, `devcel` for C++) can cause type collisions. Do not target another project's output file. After a namespace change, update application references and remove obsolete generated code from the application build.

```csharp
using var alpha = Game.Alpha.DevcelDatabase.Open("data/Alpha/master.json");
using var beta = Game.Beta.DevcelDatabase.Open("data/Beta/master.json");
// Identical IDs still resolve within their owning database.
var alphaHero = alpha.Heroes.ById("22222222-2222-4222-8222-222222222222");
var betaHero = beta.Heroes.ById("22222222-2222-4222-8222-222222222222");
```

Cloned project/table/interface/record UUIDs remain safe when outputs, namespaces, and databases are separate. Reference/TableRef never implicitly cross projects.

Unity uses distinct `projectName` settings, normally producing `Assets/DevcelGenerated/<projectName>`, `Assets/StreamingAssets/Devcel/<projectName>`, and `Devcel.Generated.<projectName>`. Duplicate namespaces/code/bundle destinations are rejected. Install one shared importer package/runtime, not one per source.

Godot uses one addon with separate `devcel_database.gd.new()` instances and bundle paths. Each `devcel_live_database.gd` node receives its own `bundle_path`, such as `res://data/Alpha/master.json` and `res://data/Beta/master.json`.

Reloading or closing Alpha does not affect Beta. Native rows from the replaced Alpha snapshot become stale; Godot table/row objects retain their original snapshot safely. Retrieve fresh Godot rows when new values are needed.

## Typed colors

Color32 is RGBA `u8`; ColorFloat is RGBA `f32`. Defaults are opaque white. Both preserve RGB at alpha zero; ColorFloat also preserves negative/HDR RGB while alpha remains 0–1. String-valued cells contain canonical four-component JSON arrays, with schema type identifying precision. Export/runtime do not transform color space or premultiply. Default sRGB/linear interpretations are display conventions.

Bundle schema and native C API are both version 1. Generated C#/C++, Godot, and Unity expose dedicated types. See [typed scalar accessors](runtime-scalars.md).
