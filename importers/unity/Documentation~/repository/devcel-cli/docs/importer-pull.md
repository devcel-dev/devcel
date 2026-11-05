# Importing from an engine project

Save source projects, generation settings, and output paths in an import configuration. Engine importers and `devcel pull` use the same configuration.

## Configuration and commands

`devcel pull --config /title/devcel.import.json` imports every configured source. Add `--source base` to select one source, or `--status` to compare the saved source, configuration, and generated-output hashes.

```json
{
  "schema_version": 1,
  "sources": [
    {
      "id": "base",
      "project": "../authoring/base/Base.devcelproj.toml",
      "namespace": "Game.Base",
      "class_name": "BaseData",
      "runtime_out": "data/base.json",
      "code_out": "generated/Base.cs",
      "code_target": "csharp",
      "mode": "full"
    },
    {
      "id": "event",
      "project": "../authoring/event/Event.devcelproj.toml",
      "namespace": "Game.Event",
      "runtime_out": "data/event.json",
      "mode": "minimal",
      "version": 3
    }
  ]
}
```

- `id`: Stable identifier within the engine project, using letters, digits, `_`, and `-`. Identifiers must also be unique under case-insensitive comparison.
- `namespace`: Required generated-code namespace and, in Godot, the name identifying a source. Collision checks normalize `.` and `::` and compare case-insensitively. Ancestor/descendant pairs such as `Game` and `Game.Database` are rejected because they can collide with generated type names.
- `project`: Path to the `.devcelproj.toml` file. Relative paths are resolved from the configuration file.
- `runtime_out`: A `.json` path outside the source tree, relative to the configuration file. Parent-relative paths are supported. Validation resolves symlinks before checking collisions with sources, configuration, and other outputs.
- `code_out` / `code_target`: Supply both or neither. Targets are `csharp` (`.cs`), `cpp` (`.h`), and `typescript` (`.ts`). Godot's GDScript reader reads runtime data directly.
- `class_name`: Optional root database class name; omission or `null` selects C# `DevcelDatabase` or C++ `Database`. For example, `Game.Base` and `BaseData` produce `Game.Base.BaseData.Open(...)` in C#. Only the root type changes; table, row, and interface types and stored names/strings remain intact. The setting can be retained without code output. Validation checks ASCII identifiers, target-language reserved words, and generated type/API collisions. An explicit empty JSON string is invalid; an empty editor field is saved as omission. C++ checks known standard macros; consumer-defined macros require consumer-side review. Invalid names preserve existing outputs.
- `mode`: `full` or `minimal`; defaults to `full`.
- `version`: Omission or `null` includes all content. A value from 0 through 4294967295 includes content with `min_version <= N`; zero is valid. `schema_version` identifies the configuration format. Manual import and watch use the same source settings.

Successful responses have the form `{"ok":true,"data":{"success":true,"sources":[...]}}`. Source statuses are `pulled` (import succeeded), `ready` (source and outputs match), `needs_pull` (not imported, changed source/settings, or missing/modified outputs), and `error`. Failures return structured AppError data and a nonzero exit code. Partial success returns the complete sources list with `ok:false`.

## Source isolation and file safety

- Copies with the same project/table/row UUIDs can coexist when source IDs, namespaces, output paths, and runtime database instances are separate. Each source produces an independent database, read in full by its reader.
- Import reads saved files. Save Studio edits before importing them.
- Namespace and output collisions, ancestor/descendant output paths, source-tree overwrites, and aliases through symlinks are rejected before writing. Files and directories that are symlinks inside a source tree are rejected.
- An existing output without an ownership marker can be adopted after cloning when generated code matches byte-for-byte, or runtime content matches apart from generation time/update revision. Different existing content is rejected; choose a new output path.
- All runtime and code outputs for one source are generated and validated before replacement. Each file is replaced atomically. A replacement failure restores that source's previously replaced files and preserves successful outputs from other sources.
- Multi-file publication is not a power-loss transaction. Reload or compile after CLI success. After abnormal termination, check `--status` and import again.
- Concurrent imports are rejected using an OS advisory lock. Keep `.devcel-lock` in place so all processes use the same inode. Closing the handle or exiting releases the OS lock, including after a crash.
- The adjacent `.devcel-state.json` stores the last successful hashes and last error. Output-side `.devcel-owner.json` stores an opaque ownership hash, preventing another configuration from overwriting the same output. State, owner, and lock files are local caches tied to machine/location; exclude them from Git. Clone the configuration and sources with their relative layout intact, and the first import recreates caches. If moving a worktree with caches, inspect and explicitly remove the moved configuration's stale state/owner caches before importing. Keep an active lock file intact.
- `--status` is read-only. The last failure remains visible until a successful import.
- Exclude editor configuration, caches, CLI, and authoring sources from game builds. Godot's exporter performs these exclusions. Unity game builds consume the generated JSON/code and runtime library.

## Reproducible checks

```sh
python3 devcel-cli/tests/pull_workflow.py /absolute/devcel /absolute/new-evidence-dir
```

This real-CLI test creates two sources with identical UUIDs and checks formulas, full/minimal output, individual imports, status, namespace/output/source protection, symlinks, ownership conflicts, and preservation of previous outputs on invalid input or code-generation failure. Use a new fixture directory.

Run `devcel-cli/tests/pull_class_config.py` with the same arguments to check root-class renaming, namespace/table/string preservation, invalid names, Content Version boundaries, and compilation of a C++ consumer.

Run `devcel-cli/tests/pull_portability.py` to check cloning into another root, unrelated working directories, parent-relative outputs, reimport after source changes, and source-overwrite protection through symlinks and `..`.

## Saving engine-editor settings

`devcel pull-config-save --config <configuration.json> --input <candidate.json>` validates the complete configuration, acquires the import lock, and saves atomically. Supply `--expected-revision <SHA256-at-load>` to reject a save after another editor has changed the file; use `missing` for initial creation. Success returns `data.saved=true` and the new `data.revision`.

The installed GameMaker and WOLF launchers start `devcel importer-ui --engine gamemaker|wolf --root <game-project>`. The UI runs on 127.0.0.1 with a temporary token and serves only registered runtime JSON outputs. WOLF conversion follows a successful import; load the resulting CSV through the official editor's import operation.
