# Build a plugin

[Manual](README.md) / [Install and configure plugins](settings-and-plugins.md)

This guide adds a feature to Devcel Studio: first a notification-only plugin, then a TypeScript button that counts table rows. Finally, package and test it in Studio. The current Plugin API is **2.0.0**.

## 1. Create a minimal plugin

The first example needs no Node.js or build tools. Create a `manual-hello` folder and save two UTF-8 files:

```text
manual-hello/
  plugin.json
  main.js
```

`plugin.json` supplies the metadata shown during package review:

```json
{
  "formatVersion": 1,
  "metadata": {
    "id": "manual-hello",
    "name": "Manual Hello",
    "version": "1.0.0",
    "description": "A practice plugin that notifies you when activated",
    "author": "Your Name",
    "devcelVersion": ">=0.0.0 <0.1.0",
    "apiVersion": "2.0.0"
  },
  "main": "main.js",
  "permissions": ["full-app-access"]
}
```

`main.js` defines the plugin and its activation behavior:

```js
module.exports = {
  metadata: {
    id: 'manual-hello',
    name: 'Manual Hello',
    version: '1.0.0',
    description: 'A practice plugin that notifies you when activated',
    author: 'Your Name',
    devcelVersion: '>=0.0.0 <0.1.0',
    apiVersion: '2.0.0'
  },
  activate: async (api) => {
    api.ui.showNotification('Manual Hello is active', 'info');
  },
  deactivate: async () => {}
};
```

Both `activate(api)` and `deactivate()` are required. The host supplies `api`; deactivate takes no arguments. Keep code metadata and the manifest consistent. Choose a unique ID; `csv-exporter` is the built-in ID.

You can already continue to [Package and test](#5-package-and-test-in-studio). A notification in the main window when enabled confirms the minimal example works.

### Execution format and trust

- `main` points to a single JavaScript bundle. Compile TypeScript and ESM imports/exports into a Plugin object exposed through `module.exports`. A bundler's CommonJS default export is also accepted.
- Host `require` supplies only `react` and `react/jsx-runtime`. Bundle other dependencies. This is a browser application environment rather than Node.js with `fs` or `path` modules.
- Plugins are unsandboxed and can access the app environment, files, network, and Tauri APIs after approval. `full-app-access` declares that trust boundary; it does not constrain capabilities.
- ZIP review reads metadata without execution. Self-declared authors and SHA-256 hashes are not author signatures.
- Make data changes or external transmissions clear in the UI. Use a practice project for initial testing.

## 2. Add a TypeScript button that reads a table

Copy the [plugin template](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/templates/plugin-template/README.md) from the same source version as your Studio build. Its entire `src/types/` directory is the SDK; retain those definitions.

Install the Node.js/npm versions specified by the template, then run in your copy:

```sh
npm install
npm install --save-dev esbuild@^0.28.2
```

These commands install development dependencies. Set package.json's name, version, description, and author for your plugin. Replace `src/index.ts` with the example below; it does not import the template's other extension files.

```typescript
import type { Plugin, PluginAPI } from './types/pluginTypes';

let api: PluginAPI | undefined;
let generation = 0;
let unsubscribe: (() => void) | undefined;

function cleanup(): void {
  generation += 1;
  unsubscribe?.();
  unsubscribe = undefined;
  api = undefined;
}

async function countRows(): Promise<void> {
  const current = api;
  const started = generation;
  const target = current?.app.getState().activeTable;
  if (!current || !target) return;
  try {
    const table = await current.data.getTable(target.uuid, target.projectSession);
    // Discard results after disabling, re-enabling, or switching tables.
    const now = current.app.getState().activeTable;
    if (generation !== started || api !== current ||
        now?.uuid !== target.uuid || now.projectSession !== target.projectSession) return;
    current.ui.showNotification(`${table.records.length} rows`, 'info');
  } catch (error) {
    if (generation !== started || api !== current) return;
    const detail = error instanceof Error ? error.message : JSON.stringify(error);
    current.ui.showNotification(`Could not read table: ${detail}`, 'error');
  }
}

const plugin: Plugin = {
  metadata: {
    id: 'manual-hello', name: 'Manual Hello', version: '1.0.0',
    description: 'A practice plugin that notifies you when activated', author: 'Your Name',
    devcelVersion: '>=0.0.0 <0.1.0', apiVersion: '2.0.0'
  },
  extensions: {
    toolbarButtons: [{
      id: 'count-rows', label: 'Count rows', tooltip: 'Count active table rows',
      position: 'right',
      isEnabled: () => Boolean(api?.app.getState().activeTable),
      onClick: countRows
    }]
  },
  activate: async (nextApi) => {
    cleanup();
    api = nextApi;
    // Retain the cleanup function for this namespaced event subscription.
    unsubscribe = nextApi.events.on('manual-hello:count', countRows);
    nextApi.ui.showNotification('Manual Hello is active', 'info');
  },
  deactivate: async () => { cleanup(); }
};
export default plugin;
```

Choose **Plugins → Manual Hello → Count rows** to report the active table's `records` count, including rows hidden by filters. The button is disabled when no table is active. Within the plugin, `api.events.emit('manual-hello:count')` invokes the same handler. Include your plugin ID in event and command names to avoid collisions.

### Type-check and bundle

Run in the copied template:

```sh
npm run lint
npm run build
npx esbuild src/index.ts --bundle --format=cjs --platform=browser --target=es2020 --external:react --external:react/jsx-runtime --outfile=package/main.js
```

The template's build uses `tsc` to type-check and write ESM to `dist/`. The final command creates the CommonJS ZIP entry `package/main.js`. React stays external because the host supplies it.

Save the first section's manifest as `package/plugin.json`. The metadata matches this example. Package the contents of `package/`; development sources, `node_modules/`, and `dist/` are unnecessary at runtime.

## 3. APIs and extension points

See [PluginAPI](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/templates/plugin-template/src/types/pluginTypes.ts) for exact signatures and [TableData](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/templates/plugin-template/src/types/tableTypes.ts) for table structures.

| API | Uses and constraints |
| --- | --- |
| `app` | `version`, `name`, `getState()`; activeTable is `{ uuid, projectSession }` or null |
| `project` | Await `getCurrent()`, `getAll()`, create/open/save/close; getAll returns zero or one project in this window |
| `data` | getTable, getTableSnapshot, updateTable, createTable, deleteTable; use explicit table UUID and project session |
| `ui` | Notifications, save dialogs, registered dialogs, modals, commands; showSaveDialog returns null on cancellation |
| `fs` | readFile, writeFile, exists, mkdir, readDir; explain affected paths to the user |
| `events` | on, once, emit; retain unsubscribe functions |
| `i18n` | Read/subscribe to locale, register plugin messages, translate; release returned registrations/subscriptions |
| `settings` | get, getAll, watch for defined keys |

Settings are declared by the plugin and restricted to its owner namespace. Use `getTable`/`watchTable` for declared singleton tables and `getRows`/`watchRows` for multirow tables. `get`/`watch` use local `tableId.columnName` keys. Declare editable settings and translation resources as shown in the [independent resource fixture](https://github.com/devcel-dev/devcel/tree/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/examples/plugin-owned-tables). This notification-only example declares no resources, so its `getAll()` is empty.

`extensions` can declare `menus`, `toolbarButtons`, `contextMenus`, `sidePanels`, `dialogs`, `dataProcessors`, `exporters`, `importers`, and `themes`. Consult the SDK for structures:

- Menus use `menus: { customId: { groups: [...] } }` and are grouped in Studio's plugin menu.
- Side-panel and dialog `component` values are React elements (`ReactNode`). The separate `ui.showModal` API accepts a component type.
- A theme's `colors` supplies all 20 `ThemeColorToken` values. Extra `cssVariables` cannot override semantic colors.

### Update a table safely

Read-only `getTable` has no revision. Updates use the complete DTO and revision from `getTableSnapshot`. The following changes only the description. Invoke it from an explicit user action and catch failures in the caller:

```typescript
async function updateDescription(api: PluginAPI, description: string): Promise<void> {
  const target = api.app.getState().activeTable;
  if (!target) throw new Error('No active table');
  const { uuid, projectSession } = target;
  const { table, revision } = await api.data.getTableSnapshot(uuid, projectSession);
  const now = api.app.getState().activeTable;
  if (now?.uuid !== uuid || now.projectSession !== projectSession) {
    throw new Error('Active table changed');
  }
  const next = structuredClone(table);
  next.description = description;
  await api.data.updateTable(uuid, next, projectSession, revision);
}
```

- UUID identifies the table, session identifies this project opening, and revision identifies the version read. Keep all three from the original snapshot; replacing a stale revision alone would discard concurrency protection.
- Conflicts, old sessions, and transitions reject updates. Refetch and reconcile the intended edit before retrying. Guard custom asynchronous work against deactivation too.
- Preserve the full DTO, including metadata, schema, records, description, interface_implementations, and interface_order. Required fields such as column min_version must remain. Interface cell values use `interface_values[columnUuid]`.
- Use the backend update path for validation, saving, undo/redo, and P2P. Editing restrictions, read-only columns, types, input rules, and references still apply.
- updateTable cannot change table UUID, parent UUID, interface application metadata/order, or protected interface-owned column structure.
- The host may show an input-rule warning confirmation. Report cancellation, rejection, or save failure as such. Approval tokens belong to that host flow.

For cell edits, use the template's `setEffectiveCellValue` helper. A nonempty
raw input overrides inheritance; an exact empty input deletes the key and follows
the parent, then the column default. Preserve unchanged raw inputs and parent
links. Whitespace and formula expressions remain intact. See the
[raw cell contract](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/docs/plugin-api-reference.md#raw-cells-and-inheritance).

## 4. Handle shutdown, reactivation, and errors

The host calls `activate` and `hooks.onActivate`. Register each subscription or command once rather than duplicating it across both hooks or manually calling one hook from the other.

Group cleanup in a helper such as `cleanup()` above. That is a plugin-defined function, not a required `dispose` method on Plugin.

- Retain and call cleanup functions from events.on, settings.watch, i18n.subscribe, and i18n.registerMessages.
- Stop timers, DOM listeners, and network work you create. A running Promise needs a generation check or cancellation mechanism to discard stale results.
- ui.registerCommand returns void; the host unregisters it on shutdown. There is no unregisterCommand API.
- The host releases scoped subscriptions/commands and suppresses disabled callbacks, but independent work already running still needs your guards.
- Read current state on reactivation. Events received while disabled are not guaranteed to replay.
- Await asynchronous APIs and handle errors, including values that are not Error objects. Preserve failure details in notifications.

## 5. Package and test in Studio

Studio can create and install the ZIP:

1. Open a practice project and **Tools → Plugin Manager → ZIP management & installation**.
2. Choose **Export folder to ZIP** and select `manual-hello/` or the TypeScript example's `package/`.
3. Save outside the input folder. Check the resulting name, version, and SHA-256.
4. Use **Select and review ZIP** to review metadata, permissions, compatibility, dependencies, and hash.
5. Choose **Install without enabling**.
6. After reviewing the code, acknowledge full-app-access and choose **Approve access and allow execution**.
7. Open settings tables → PluginStates. Add a row for `manual-hello` if needed, enter its Plugin ID, and check Enabled. The initial blank-ID validation error clears after entering the ID.
8. Confirm the activation notification and return to the main window. For TypeScript, open a table, choose **Plugins → Manual Hello → Count rows**, and compare the notification with the table's record count.

![Count rows reports 2 rows for the two-record Items table](images/studio-plugin-count-rows-en.jpg)

![Plugin Manager](images/studio-plugin-manager.png)

The ZIP root must contain plugin.json and main.js directly. Use formatVersion 1, API 2.0.0, and permissions `["full-app-access"]`. Declare dependencies as ID/version-range entries in metadata.dependencies.

Current limits are 16 MiB compressed ZIP, 64 MiB total expanded size, 256 entries, 64 KiB manifest, and 8 MiB entry JavaScript. Symlinks, absolute paths, and parent-traversal paths are rejected.

### Test checklist

- Disabled installation produces no notification or extension; enabling produces one activation notification.
- Repeated disable/enable cycles still produce one result per click.
- Deactivation removes extensions and prevents stale asynchronous results from appearing or saving afterward.
- Test no active table, switching tables, and closing/reopening projects to catch wrong-target work.
- Restart Studio and check approved/enabled versions resume while disabled versions stay stopped.
- For updates, test editing restrictions, input-rule rejection, warning cancellation, revision conflicts, and save failures. Confirm original values remain on failure. After success, test undo/redo and reopen the saved data.

Type-checking and bundling establish code/package validity. Test the plugin in Studio as well to verify runtime behavior.

## 6. Update and troubleshoot

Increment code and manifest versions together, rebuild, and recreate the ZIP. Replacing an existing ID requires confirmation. Changed contents need fresh approval before enabling; changing a reviewed ZIP also invalidates that review.

| Symptom | Check |
| --- | --- |
| ZIP cannot be reviewed | Root manifest, JSON syntax, main filename, sizes, paths |
| Compatibility or dependency error | devcelVersion, apiVersion, dependency IDs/ranges, installation/approval/enabled state |
| import/export syntax error | Bundle ESM into CommonJS rather than packaging dist directly |
| Module missing | Bundle non-React dependencies and avoid Node-only APIs |
| Activation fails | Metadata consistency, lifecycle methods, approval, Enabled, dependencies |
| Table update rejected | UUID, session, revision, restrictions, validation, navigation |
| Duplicate execution after reactivation | Duplicate hooks/subscriptions, timers, stale Promises |

Disable/restore does not roll back external file changes. See [Settings and plugins](settings-and-plugins.md), [Plugin API Reference](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/docs/plugin-api-reference.md).
