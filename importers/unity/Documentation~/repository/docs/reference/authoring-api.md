# Authoring API

## Authoritative definitions

- [Tauri commands](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/src-tauri/src/lib.rs): native GUI entry points.
- [Frontend API](https://github.com/devcel-dev/devcel/tree/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/src/api): TypeScript calls and DTOs.
- [Operations](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/operations.rs): CLI, P2P and authoring FFI operations/responses.
- [Columns](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/column.rs): `ColumnSchema`, type settings and required `min_version` / `read_only` fields.
- [Cell types](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/types.rs): String, Boolean, integers, floats, Color32/ColorFloat, references and curves.

Use the same checkout's definitions for every parameter.

## Results and errors

Tauri returns `Result<T, AppError>`. Errors use a `kind`-tagged variant: `code` with `code`/`params`, `text` with `text`, `input_validation` with `report`, or `diagnostics` with `diagnostics`. Handle the matching payload and display errors through `localizeError`; successful strings are not error envelopes.

## Reads and mutations

Use UUID identities, not display names or visual row/column indices. Capture the open project session when creating each project-bound asynchronous call and retain that same session through confirmation or retry. A session identifies one open instance, even when a project is reopened at the same path. Whole-table updates use the table/revision obtained together and pass `expected_revision`.

Send complete column DTOs, including required `min_version` and `read_only`, and delegate input/conflict validation to Rust. Warning approval uses backend tokens and cannot be reused after target/revision changes. Cancellation, failure and stale replies cannot advance success notifications, history or persistence.

See [CLI](../manual/cli.md), [plugin SDK](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/README.md), [runtime export](runtime-export.md) and [interfaces](../manual/interfaces.md).

## Row labels and deletion

`SetRecordLabel { table_uuid, record_uuid, label }` changes the human-readable row label and preserves the row UUID. The native command is `set_record_label`; row UUIDs are stable identities.

Row deletion is restricted when any surviving row references it. Validation uses the transaction's final state, including unopened incoming-reference tables, interface-owned Reference columns, inherited inputs, defaults, and evaluated formulas. An unresolved reference formula blocks deletion rather than guessing that deletion is safe. Surviving child rows also prevent deleting their parent. TableRef points to an entire table and does not reference an individual row.

A single transaction may delete mutually referencing rows, or a parent and all its children, when no references remain outside the selection. Rejection leaves files, row data, and history unchanged. Undo/Redo and incoming P2P snapshots recheck deletion against the current surviving references. Integrity previews report `Restrict`; deletion does not clear reference cells or cascade to other rows.

## Editing controls

Persisted/API table metadata includes `initial_transposed` and `edit_permissions`; columns include `read_only`. New tables start in the normal view with all permissions enabled. Runtime export excludes these editor controls.

Table row/cell-editing permission covers saved cell values and row metadata. Column read-only protects raw values in that column. Reading, copying, recalculation and temporary transpose remain available. Structural row/column additions and deletions use separate permissions; deleting a table or folder requires both row- and column-deletion permission. Table-local protection of interface columns survives interface synchronization.

These rules apply to CLI/P2P, plugins, whole-table mutations and Undo/Redo. A whole-table update cannot combine removing protection with changing values. They are application editing rules, not filesystem access controls.

## P2P integrations

All connected processes must use the same operation contract. Requests carry a `DevcelOperation` inside a request-ID `P2PMessage` envelope; responses return that ID and a `DevcelResponse`. Errors use the typed `AppError` variants above.

Server notifications contain committed `project_state` snapshots. Clients apply the snapshot instead of replaying the generating operation. Failed transactions do not publish a successful snapshot. Validate message limits and incoming data, and handle disconnection/reconnection explicitly.

Start `devcel --project <project-path> serve`, then issue operations from another process with `devcel --project <project-path> --mode client op '<operation-json>'`. The `watch` command emits JSON Lines such as `{"event":"snapshot","project_state":{...}}`; handle connection and error events separately.

Keep authoring code and native editing libraries out of game builds; game builds use the read-only runtime.
