# Automate editing, export, and import with the CLI

[Manual](README.md) / [Getting started](getting-started.md) / [Godot](godot.md) / [Unity](../../../../INSTALL.md) / [Synchronization](collaboration.md)

`devcel` reads and edits projects, generates runtime JSON and C#/C++/TypeScript access code, and imports saved projects. Normal results are JSON for scripts and CI. The CLI is MIT-licensed and uses the current project format.

## 1. Run the CLI and get help

If the executable is not on PATH, replace `devcel` with its full path. Windows uses `devcel.exe`.

To build from source, use the repository's pinned Rust 1.99.0 toolchain:

```sh
cargo build --locked -p devcel-cli
./target/debug/devcel --help
```

Engine importer packages include their matching CLI; see [Godot](godot.md) or [Unity](../../../../INSTALL.md).

```sh
devcel --help
devcel help export
devcel export runtime --help
devcel interface column add --help
devcel pull --help
```

## 2. Common options and connection modes

```text
devcel [-p PROJECT] [--mode auto|client|local] [--pretty] COMMAND
```

| Option | Meaning |
| --- | --- |
| `-p`, `--project` | Project manifest or containing directory; an explicit manifest avoids ambiguity |
| `DEVCEL_PROJECT` | Alternative project-path environment variable |
| `--mode auto` | Default: use an available P2P server, otherwise operate on saved files |
| `--mode client` | Require a running server |
| `--mode local` | Operate directly on files; concurrent server writes can conflict |
| `--pretty` | Pretty-print result JSON |
| `-h`, `--help` | Command help |

`export ... --version N` selects a content version.

`init`, `pull`, and `localization init` select targets through their arguments or configuration. Pull reads the saved project paths in its config; localization works on saved files. Status, serve, and watch have dedicated connection behavior.

Specify `-p` or DEVCEL_PROJECT; projects are not automatically selected from the working directory. If a directory contains multiple manifests, specify one file.

### Read command results

Normal success:

```json
{"ok":true,"data":{"name":"Demo"}}
```

Normal failure:

```json
{"ok":false,"error":{"kind":"text","text":"Error details"}}
```

- Normal execution exits 0 on success and 1 on failure. Results use stdout and logs use stderr.
- Errors may use text, code, input_validation, diagnostics, or other structured kinds.
- Help and software-version output are text. Argument parsing errors are also outside the normal JSON envelope and exit nonzero.
- Watch streams JSON Lines. Serve continues running after its initial status result.
- Pull can return `ok:false` with per-source results in `data.sources`, rather than a top-level error, when only some sources fail.

Check both exit status and `ok` before using a result downstream.

## 3. Create a small dataset

Run where `./authoring/Demo` does not already exist:

```sh
devcel init Demo --dir ./authoring --description "CLI tutorial"
devcel -p ./authoring/Demo/Demo.devcelproj.toml table create enemies --display-name "Enemies"
devcel -p ./authoring/Demo/Demo.devcelproj.toml column add enemies name String
devcel -p ./authoring/Demo/Demo.devcelproj.toml column add enemies hp I32
devcel -p ./authoring/Demo/Demo.devcelproj.toml record add enemies --uuid 11111111-1111-4111-8111-111111111111
devcel -p ./authoring/Demo/Demo.devcelproj.toml cell set enemies 11111111-1111-4111-8111-111111111111 name "Slime"
devcel -p ./authoring/Demo/Demo.devcelproj.toml cell set enemies 11111111-1111-4111-8111-111111111111 hp 100
devcel -p ./authoring/Demo/Demo.devcelproj.toml --pretty table get enemies
```

`table get` returns **`{table, revision}`** in data. Inspect data.table.records for the UUID, name Slime, and hp 100.

Add a formula and export:

```sh
devcel -p ./authoring/Demo/Demo.devcelproj.toml column add enemies double_hp I32
devcel -p ./authoring/Demo/Demo.devcelproj.toml cell set enemies 11111111-1111-4111-8111-111111111111 double_hp "=hp * 2"
devcel -p ./authoring/Demo/Demo.devcelproj.toml export runtime --out ./game/data/master.json
```

The saved input is `=hp * 2`; the runtime value is `200`. Use `--out` to write a reader-ready bundle. Redirecting the command's stdout would also include the ok/data response envelope.

The [ManualBasics sample](../../examples/manual-basics/README.md) includes saved inputs and expected results for two content versions.

## 4. Command reference

Examples use this project variable:

```sh
P=./authoring/Demo/Demo.devcelproj.toml
```

In PowerShell use `$P = "./authoring/Demo/Demo.devcelproj.toml"`. Replace table UUIDs and history IDs with values returned by your project. The reference's modification/deletion examples are independent examples, not a sequence to run in full.

### Project, connection, and undo history

| Command | Example and behavior |
| --- | --- |
| `init NAME` | `devcel init Demo --dir ./authoring --description "Practice" --header-color "#6495ed"`; creates DIR/NAME; defaults are dir `.`, empty description, color #6495ed |
| `status` | `devcel -p "$P" status`; inspect server_running |
| `serve` | `devcel -p "$P" serve`; run headless until Ctrl+C, or join an existing server |
| `info` | `devcel -p "$P" info`; project information |
| `entries` | `devcel -p "$P" entries`; tables, folders, and other entries |
| `undo TABLE` | `devcel -p "$P" --mode client undo enemies`; undo server-held history |
| `redo TABLE` | `devcel -p "$P" --mode client redo enemies` |
| `watch` | `devcel -p "$P" watch`; subscribe to authoritative snapshots as JSON Lines |
| `op JSON` | `devcel -p "$P" op '{"op":"GetProjectName"}'`; execute a public operation |
| `help [COMMAND]...` | `devcel help interface column add` |

Watch emits connected/disconnected lifecycle events and committed `snapshot` events containing `project_state`. It observes authoritative server state rather than replaying operations into a local editor. It exits on disconnection or Ctrl+C. `--ensure-server` acquires a server automatically; `--parent-stdin` ends the watcher when its parent stdin pipe closes, for importer-managed lifetimes.

Local CLI invocations do not retain undo history between commands. Use a client connection for history held by Studio or serve.

### Tables, columns, records, and cells

TABLE resolves by UUID, path, or name within a path; ambiguous results fail. Prefer UUIDs from table list in automation. RECORD is a row UUID; COLUMN is a column data_name.

| Command | Example and behavior |
| --- | --- |
| `table list` | `devcel -p "$P" table list`; table paths and UUIDs |
| `table get TABLE` | `devcel -p "$P" table get enemies`; schema, records, revision |
| `table create NAME` | `devcel -p "$P" table create enemies --display-name "Enemies" --parent ""`; parent is root-relative and defaults to root |
| `column add TABLE NAME [TYPE]` | `devcel -p "$P" column add enemies hp I32`; default type String |
| `column remove TABLE NAME` | `devcel -p "$P" column remove enemies hp` |
| `column curve-config TABLE COLUMN` | `devcel -p "$P" column curve-config enemies growth --start 0 --end 100`; both endpoints required |
| `column table-ref-config TABLE COLUMN INTERFACE` | `devcel -p "$P" column table-ref-config enemies rewards reward_table` |
| `column select-config TABLE COLUMN CONFIG` | `devcel -p "$P" column select-config enemies rarity '{"options":[{"value":"normal","label":"Normal"}]}'`; null clears configuration |
| `record add TABLE` | `devcel -p "$P" record add enemies`; returns data.record_uuid; optional --uuid supplies one |
| `record delete TABLE RECORD` | `devcel -p "$P" record delete enemies 11111111-1111-4111-8111-111111111111` |
| `cell set TABLE RECORD COLUMN VALUE` | `devcel -p "$P" cell set enemies 11111111-1111-4111-8111-111111111111 hp 100` |

Types include String, U8/I8, U16/I16, U32/I32, U64/I64, F32/F64, Boolean, Color32/ColorFloat, Select, DateTime, Curve, Reference, and TableRef. Configuration commands require an existing column of the corresponding type. Edit interface-owned structure in the interface.

For a value beginning with a hyphen, insert `--` before it:

```sh
devcel -p "$P" cell set enemies 11111111-1111-4111-8111-111111111111 hp -- -10
```

### Interfaces

INTERFACE accepts a UUID, name, or path. Use parent UUIDs from interface list/get for extends.

| Command | Example and behavior |
| --- | --- |
| `interface list` | `devcel -p "$P" interface list` |
| `interface get INTERFACE` | `devcel -p "$P" interface get common`; fields, inheritance, history, implementations |
| `interface create PATH` | `devcel -p "$P" interface create common --description "Shared fields"`; creates Tables-relative common.interface.toml |
| `interface delete INTERFACE` | `devcel -p "$P" interface delete common` |
| `interface extends INTERFACE [PARENTS]...` | `devcel -p "$P" interface extends advanced PARENT_UUID`; replaces all parents; no parent arguments clears them |
| `interface apply TABLE INTERFACE` | `devcel -p "$P" interface apply enemies common`; adds missing fields unless --no-auto-add |
| `interface unapply TABLE INTERFACE` | `devcel -p "$P" interface unapply enemies common`; review affected columns/values first |
| `interface sync TABLE INTERFACE` | `devcel -p "$P" interface sync enemies common`; reconcile with the definition |
| `interface validate TABLE INTERFACE` | `devcel -p "$P" interface validate enemies common` |
| `interface table-list TABLE` | `devcel -p "$P" interface table-list enemies` |
| `interface branches INTERFACE` | `devcel -p "$P" interface branches common` |
| `interface preview-merge INTERFACE OURS THEIRS` | `devcel -p "$P" interface preview-merge common OURS THEIRS` |
| `interface merge INTERFACE OURS THEIRS` | `devcel -p "$P" interface merge common OURS THEIRS --resolve "hp=TakeOurs"`; --resolve is repeatable |
| `interface revert INTERFACE VERSION` | `devcel -p "$P" interface revert common VERSION_ID`; restore as new history |
| `interface import INTERFACE SOURCE_PATH` | `devcel -p "$P" interface import common /absolute/path/common.interface.toml`; import history |

Same-named local and interface columns do not imply shared ownership or storage. Test apply/unapply/sync on a copy before changing important data. Interface history IDs differ from numeric content versions.

#### Interface columns

| Command | Example and behavior |
| --- | --- |
| `interface column add INTERFACE NAME [TYPE]` | `devcel -p "$P" interface column add common hp I32 --default 10 --required`; defaults: String, empty default, optional |
| `interface column remove INTERFACE NAME` | `devcel -p "$P" interface column remove common hp` |
| `interface column rename INTERFACE OLD NEW` | `devcel -p "$P" interface column rename common hp health` |
| `interface column type INTERFACE NAME TYPE` | `devcel -p "$P" interface column type common hp I64` |
| `interface column default INTERFACE NAME VALUE` | `devcel -p "$P" interface column default common hp 10`; empty text clears it |
| `interface column required INTERFACE NAME true/false` | `devcel -p "$P" interface column required common hp true`; use `false` to make it optional |
| `interface column constraints INTERFACE NAME` | `devcel -p "$P" interface column constraints common hp --unique --min 0 --max 999`; patterns use --pattern |
| `interface column curve-config INTERFACE NAME` | `devcel -p "$P" interface column curve-config common growth --start 0 --end 100` |
| `interface column table-ref-config INTERFACE NAME TARGET_INTERFACE` | `devcel -p "$P" interface column table-ref-config common rewards reward_table` |
| `interface column select-config INTERFACE NAME CONFIG` | `devcel -p "$P" interface column select-config common rarity '{"options":[{"value":"normal","label":"Normal"}]}'`; null clears it |

Constraints replaces the entire constraint set: omitted constraints are removed. Include an existing minimum when updating only the maximum.

In released CLI v0.0.2, `interface column required` can fail due to an argument-parser assertion. For that version, obtain `data.uuid` from `interface get` and use the direct operation instead:

```sh
devcel -p "$P" op '{"op":"SetInterfaceColumnRequired","data":{"interface_uuid":"REPLACE_WITH_INTERFACE_UUID","column_name":"hp","required":false}}'
```


### Export

| Command | Example |
| --- | --- |
| `export runtime` | `devcel -p "$P" export runtime --version 2 --out ./game/data/master.json` |
| `export code TARGET` | `devcel -p "$P" export code csharp --namespace Game.Master --version 2 --out ./game/generated/Master.cs` |
| `export run` | `devcel -p "$P" export run --config ./devcel.export.toml` |

- Runtime supports --minimal and explicit --allow-invalid for accepted constraint violations.
- Content versions range from 0 to 4,294,967,295. Omit --version for all content.
- Align runtime/code versions. Code targets are `csharp`, `cpp`, and `typescript`.
- Default code namespaces are `Devcel.Generated` for C# and TypeScript, and `devcel` for C++, distinct from Unity Importer defaults.
- Use pull's class_name setting for a custom root database class.
- Without --out, runtime data is returned in data; code is returned as data.code.
- Inspect and fix validation failures before choosing an allow-invalid override.

For TypeScript output, use the same content version as the runtime bundle:

```sh
devcel -p "$P" export code typescript --namespace Game.Master --version 2 --out ./game/generated/Master.ts
```

See the [JavaScript/TypeScript importer guide](../../importers/javascript/README.md) for including the reader and generated access code in a game.

```sh
devcel -p "$P" op '{"op":"LintProject","data":{"table_uuid":null,"version":2}}'
```

Example export configuration:

```toml
[[runtime]]
out = "game/data/master.json"
mode = "full"
version = 2

[[code]]
out = "game/generated/Master.cs"
target = "csharp"
namespace = "Game.Master"
version = 2
```

Out paths are relative to the TOML's parent directory. Runtime mode defaults to full; allow_invalid can be set explicitly. Without --config, export run searches the project root, then the current directory, for devcel.export.toml.

Export run writes sequentially; a later failure leaves earlier outputs. Use pull for a reusable engine import configuration and its per-source replacement checks.

### Pull imports

Pull uses the same saved-project JSON configuration as importers:

```sh
devcel pull --config ./game/.devcel/devcel.import.json
devcel pull --config ./game/.devcel/devcel.import.json --source master
devcel pull --config ./game/.devcel/devcel.import.json --status
devcel pull --config ./game/.devcel/devcel.import.json --source master --status
```

Config defaults to devcel.import.json in the current directory. Source restricts the operation to one ID. Status is read-only and reports ready, needs_pull, or error.

```json
{
  "schema_version": 1,
  "sources": [
    {
      "id": "master",
      "project": "../../authoring/Demo/Demo.devcelproj.toml",
      "namespace": "Game.Master",
      "class_name": "MasterDatabase",
      "runtime_out": "../data/master.json",
      "code_target": "csharp",
      "code_out": "../generated/Master.cs",
      "mode": "full",
      "version": 2
    }
  ]
}
```

| Key | Contract |
| --- | --- |
| schema_version | 1 |
| id | Required; letters/digits/underscore/hyphen, unique ignoring case |
| project | Required manifest file |
| namespace | Required even without code; case and dot/colon spelling cannot evade collision checks |
| runtime_out | Required .json outside the source project |
| code_target/code_out | Both present or both omitted; csharp/.cs, cpp/.h, or typescript/.ts |
| class_name | Optional; absent/null defaults to DevcelDatabase in C#/TypeScript, Database in C++; empty string is invalid |
| mode | full or minimal, default full |
| version | Integer 0–4,294,967,295; absent/null includes all |

All relative paths use the configuration JSON's parent. Parent components are allowed, but output/source overlap, output collisions, and symlink bypasses are rejected. Source-tree symlinks are rejected too.

Pull generates and validates one source's JSON/code before replacement, rolling back earlier replacements if that source's replacement fails. It does not guarantee simultaneous visibility of all files or power-loss transactions. Check success before reimporting or compiling.

See [Synchronization](collaboration.md), [Godot](godot.md), and [Unity](../../../../INSTALL.md) for source separation, local cache files, and UI setup.

### Studio localization

These commands edit Studio's translation data. Before import/reconcile, disable automatic import for that settings project, close Studio and manual serve processes using it, allow managed connections to exit, then confirm status reports server_running false.

| Command | Example and behavior |
| --- | --- |
| localization init | `devcel localization init --dir ./translations --name sample`; create a separate translation project with standard tables and minimal ja/en keys |
| localization import FILE | `devcel -p ./devcel-studio/app-settings/studio.devcelproj.toml localization import ./messages.json`; upsert entries |
| localization reconcile | Compare source revisions and mark changed translations for review |
| localization validate | Check structure, references, required translations, review state, and ICU arguments |
| localization export | `devcel -p ./devcel-studio/app-settings/studio.devcelproj.toml localization export --out ./generated-i18n`; validate and write catalog.json/keys.ts |
| localization export --check | Verify generated content without writing |

Use the same -p project on reconcile and validate. Example import data intentionally retains Japanese source text:

```json
[
  {"key":"example.greeting","ja":"こんにちは","en":"Hello","translations":{"fr":"Bonjour"},"context":"Greeting","usage":"Screen text"}
]
```

Key and ja are required. Ja updates both Japanese source and translation. En, translations, context, and usage are optional. Translations maps registered Locales codes to text. Unknown locales, translations.ja, and duplicate en/translations.en are rejected. Omitted translation text is retained; a changed Japanese source marks existing translations needs_review. All translations' ICU arguments and references are validated before atomic saving.

To add a language to a custom settings project, back it up and stop its users as above, then:

1. Inspect Locales with table get. Add a row using record add and set code, display_name, fallback_locale, direction, enabled, and required with cell set. Fallback is the target locale row's UUID, not its code. Arabic uses rtl; other bundled locales use ltr.
2. Read the current UserSettings locale Select configuration and replace it with a complete option list including the new language. Preserve system and all existing/custom choices. The saved selected-value row can remain unchanged.
3. Preserve each current Japanese source in import data. When using bundled translations, include only keys whose source matches your customized project, supply only added languages in translations, and omit en. Translate customized-source keys separately.
4. While intentionally falling back for unfinished keys, enable the added locale with required=false. After completing and reviewing all keys, set required=true and validate. New bundled settings include complete translations.
5. After import, run localization validate and app-catalog validate for that project.

Default export output is devcel-studio/src/app/i18n/generated. Use an explicit separate destination for experiments. See [Studio localization](../development/localization.md).

## 5. Direct operations

Operations use `{"op":"OperationName","data":{...}}`. Fieldless operations omit data; operations with fields, such as LintProject, require it. See [operations.rs](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/operations.rs).

For easier shell quoting, save operation.json and read it from stdin:

```sh
devcel -p "$P" op - < operation.json
```

```powershell
Get-Content -Raw -Encoding UTF8 operation.json | devcel -p $P op -
```

Bulk updates such as UpdateTableData require expected_revision from the original read. Follow any returned confirmation candidate/revision/acknowledgement contract. Prefer a dedicated subcommand when one exists.

## 6. Common failures

- Ambiguous table: use a UUID from table list or its complete relative path.
- No P2P server: client and ordinary watch require one; watch --ensure-server can acquire one. Auto/P2P importers use the same mechanism. Stop other editors/watchers before deliberate local editing.
- Formula not evaluated: quote the entire formula and use column data names, for example `"=hp * 2"`.
- Runtime reader rejects JSON: use an --out bundle rather than the stdout response envelope.
- Missing versioned column: align runtime/code versions; omit --version for all content.
- Stale import: verify save completion, source ID, relative paths, and pull --status.
- Syntax error: compare with the installed CLI's help. Custom root class names belong in pull configuration.

See [Troubleshooting](troubleshooting.md).
