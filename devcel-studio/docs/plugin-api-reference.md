# Devcel Plugin API reference

Plugin API matching is exact: `2.0.0`. Use the [SDK definitions](../templates/plugin-template/src/types/pluginTypes.ts) and [table DTOs](../templates/plugin-template/src/types/tableTypes.ts). Follow the [ZIP format](../../docs/development/plugin-packaging.md) for packaging.

## PluginAPI

`api` exposes `i18n`, `app`, `project`, `ui`, `data`, `settings`, `fs`, and `events`. Plugin code runs inside the trusted host; type definitions and permission labels are not a sandbox.

## Application API

- `app.version: string` and `app.name: string` identify the application.
- `app.getState()` returns `{ hasProject, activeTable }`.
- `activeTable` is null or `{ uuid, projectSession }`. Capture it before an operation and keep that target fixed across asynchronous work.

## Project API

- `getCurrent(): Promise<PluginProject | null>`
- `getAll(): Promise<PluginProject[]>`: zero or one project in this window.
- `create(config)`, `open(path)`, `save()`, `close()`: each returns `Promise<void>`.

PluginProject contains sessionId, path, name, description, and headerColor. Await getCurrent and getAll. Results reflect the current window; backend failures reject the promise.

## Data API

Table operations use UUIDs and the project's open-instance session. Preserve the session captured during reading; closed or mismatched sessions are rejected.

```typescript
const target = api.app.getState().activeTable;
if (!target) throw new Error('No active table');
const { uuid: tableUuid, projectSession } = target;
const { table, revision } = await api.data.getTableSnapshot(tableUuid, projectSession);
table.description = 'Updated by plugin';
await api.data.updateTable(tableUuid, table, projectSession, revision);

const createdUuid = await api.data.createTable({ path: 'new_table.table.toml' }, projectSession);
await api.data.deleteTable(createdUuid, projectSession);
```

- `getTable(tableUuid, expectedProjectSession): Promise<TableData>`
- `getTableSnapshot(tableUuid, expectedProjectSession): Promise<{table: TableData; revision: string}>`
- `updateTable(tableUuid, data, expectedProjectSession, expectedRevision): Promise<void>`
- `createTable({path}, expectedProjectSession): Promise<string>`
- `deleteTable(tableUuid, expectedProjectSession): Promise<void>`

Preserve required TableData root uuid, display_name, description, metadata, schema, records, and interface_implementations. Interface order belongs to metadata.interface_order. Table tooltip is not supported; column tooltip remains available. Zero `min_version` and empty authoring labels, tags, memos and optional value maps are omitted on the wire and restored to defaults by the Studio/SDK receive boundary. Root table identity and description remain explicit. Interface cells use `interface_values[columnUuid]`.

Rust handles types, input rules, references, warning approval, revisions, atomic saves, rollback, Undo/Redo, and P2P. Submit the complete retrieved DTO. A successful update is one Undo/Redo unit. Validation or persistence failure preserves the original state. Read a current snapshot before updating and resolve revision conflicts explicitly.


### Raw cells and inheritance

A stored raw value is a local override. An absent key follows the parent chain,
then the column default. Ordinary columns use `values[column.data_name]`;
interface-owned columns use `interface_values[column.uuid]`.

Use the template's `setEffectiveCellValue(record, column, rawInput)` helper.
An exact empty input deletes the key and restores natural inheritance. Whitespace
and formula expressions are preserved; a formula evaluating to empty is still a
local formula. Raw `updateTable` also removes exact-empty input keys.

Preserve unchanged raw values and parent links. Do not write resolved display
values back into the snapshot. The record-only getter cannot resolve parent
chains or evaluate formulas. Use the host's parent/detach controls for semantic
detach; clearing `parent_uuid` alone does not materialize inherited inputs.

### Table replacement contract

```typescript
const target = api.app.getState().activeTable;
if (!target) throw new Error('No active table');
const { uuid: tableUuid, projectSession } = target;
const { table, revision } = await api.data.getTableSnapshot(tableUuid, projectSession);
table.description = 'Updated by plugin';
await api.data.updateTable(tableUuid, table, projectSession, revision);
```

- Supply uuid, display_name, description, metadata (including interface_order), schema.columns, records, and interface_implementations.
- Ordinary columns/records and metadata support edits, additions, deletions, and reordering.
- Table UUID/parent remain fixed; file paths are not supplied through this DTO.
- Validate new/renamed column names, duplicate UUIDs, cell/settings types, parent existence, and parent cycles.
- Values must target known columns. Remove deleted ordinary columns' cells from the submitted data.
- Rust normalizes numbers, removes exact-empty authoring inputs to restore parent/default fallback, and preserves whitespace and formula expressions.
- Preserve interface-derived definitions and implementation metadata. Presentation color, width, font, tooltip, and memo remain editable.
- Interface cell values use `record.interface_values[columnUuid]`.
- Record constraints such as required/unique/min/max/pattern follow the existing lint/export and cell-editing policy. Dedicated reference checks retain their own API semantics; UUID format and settings types are validated.
- One update creates one Undo/Redo unit.
- Success follows completed persistence. Validation/save errors reject the promise.
- Writes replace from a same-directory temporary file. Failed saves preserve the original file, memory, and Undo history and remove temporary files.
- This is a complete replacement. Read a current snapshot with its revision and resolve conflicts explicitly.


## UI API

- `showNotification(message, type?)`: info/success/warning/error.
- `showDialog(dialogId, props?)`: opens a registered dialog.
- `showSaveDialog(options?)`: returns `Promise<string | null>`.
- `showModal(component, props?)`: the host handles onClose/onConfirm.
- `registerCommand(id, handler)` / `executeCommand(id, ...args)`.

Side-panel/dialog components are ReactNode values: pass React elements. Use host `react` and `react/jsx-runtime`.

## Settings API

Settings are declared by each package, not by core per-plugin code. Edit their ordinary typed tables in View → Options. There is no `settings.set` or hidden free-form JSON store.

```typescript
const preferences = api.settings.getTable<{ prefix: string }>('preferences');
const prefix: string = preferences.prefix;
const stop = api.settings.watchTable('preferences', next => {
  console.log(next.prefix);
});
// Equivalent scalar access uses a local tableId.columnName key.
const value = api.settings.get('preferences.prefix');
const all = api.settings.getAll();
// For a manifest table declared cardinality: "rows":
const profiles = api.settings.getRows<{ name: string; enabled: boolean }>('profiles');
const stopProfiles = api.settings.watchRows('profiles', rows => { console.log(rows); });
```

The API is permanently scoped to the plugin's authenticated owner ID. There is no owner argument, cross-owner lookup or prototype lookup. Returned objects are frozen copies; subscriptions are released at deactivation. Compatible updates preserve user cells and deleted defaults, add newly declared columns/rows, and reject identity/type changes.

Translation tables use `key`, `locale`, `text` columns. `api.i18n.t('title')` reads the active locale and configured app fallback chain, then English. `api.i18n.subscribe` tracks locale changes; table edits publish atomically through the same settings snapshot. `registerMessages` remains available for runtime dictionaries but cannot replace keys already declared in a translation table. Runtime dictionaries are released on stop; authored tables are retained.

For settings-grid labels, provide `<tableId>.title`, `<tableId>.<columnName>`, or `<tableId>.<columnName>.option.x<UTF-8 value hex>` translation keys. For these keys, add an optional String `source` column to the translation table containing the original authored label (the same in each locale). Only matching original labels are translated, so user-renamed metadata stays verbatim. No `source` value means the table label is left unchanged.

See the [complete independent resource fixture](../../examples/plugin-owned-tables) and [package declaration](../../docs/development/plugin-packaging.md).

## File System API

`readFile(path): Promise<string>`, `writeFile(path, content): Promise<void>`, `exists(path): Promise<boolean>`, `mkdir(path): Promise<void>`, and `readDir(path): Promise<string[]>`.

Validate intended targets and describe the requested operation. The API does not make arbitrary writes safe automatically.

## Events API

`on(event, handler)` returns an unsubscribe function. `once(event, handler)` and `emit(event, ...args)` are also available. Events, commands, settings/locale subscriptions, and extension callbacks follow enabled state and settings/dependency conditions. Manage already-running callbacks and plugin-owned timers separately.

## Localization API

Use `i18n.getLocale()`, `subscribe(callback)`, `registerMessages(messages)`, and `t(key, values?, fallback?)`. Retain unsubscribe/unregister functions and call them when stopping. Resources are scoped by plugin ID.

## Extensions

Declare menus, toolbarButtons, contextMenus, sidePanels, dialogs, dataProcessors, exporters, importers, and themes using the SDK's exact structures.

Theme.colors requires all 20 ThemeColorToken values. Additional cssVariables start with `--` and cannot replace semantic colors.

## Errors

Catch asynchronous failures and display them as errors. For stale session/revision failures, reacquire the target and resolve the conflict while preserving user input. Approval tokens are bound to their original values and targets.

### Table identity and file-tree discovery

Saved table TOML begins with `uuid`, `display_name`, then `description`.
`data_name` and `interface_order` belong to `[metadata]`. The file tree uses the
loaded table's unsaved display name first; otherwise it reads the root identity
without loading records. An empty display name falls back to the metadata internal
name, then the filename. This fallback can read past a long description; the
bounded early read applies to a nonempty root display name in standard output.
Strict reference discovery still validates the full table contract.
