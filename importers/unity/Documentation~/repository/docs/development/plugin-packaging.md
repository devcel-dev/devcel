# Offline plugin packages and catalogs

## Creating a ZIP

Place `plugin.json` and bundled JavaScript together at the ZIP root, not inside an extra containing folder.

```json
{
  "formatVersion": 1,
  "metadata": {
    "id": "my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "description": "Offline distribution example",
    "author": "Your name",
    "devcelVersion": ">=0.1.0 <1.0.0",
    "apiVersion": "2.0.0",
    "dependencies": {}
  },
  "main": "main.js",
  "permissions": ["full-app-access"]
}
```

```js
module.exports = {
  metadata: {
    id: 'my-plugin', name: 'My Plugin', version: '1.0.0',
    description: 'Offline distribution example', author: 'Your name',
    devcelVersion: '>=0.1.0 <1.0.0', apiVersion: '2.0.0'
  },
  activate: async (api) => {
    await api.ui.showNotification('My Plugin activated', 'info');
  },
  deactivate: async () => {}
};
```

Code ID/version must match the manifest. The approved manifest controls dependency/compatibility declarations. Prebundle JavaScript without TypeScript syntax or ESM imports. Use host React through `require('react')` / `require('react/jsx-runtime')`; bundle other dependencies. Sidebar/dialog `component` is a ReactNode: pass `React.createElement(MyPanel)`, not the component function. `const React = require('react')` is supported.

Open ZIP management/installation from Plugin Manager and export a folder to ZIP, choosing an output outside the source folder. ZIPs made by other tools are also accepted.

## Review, approval and execution

1. Select and inspect a ZIP through the native picker.
2. Review self-declared name/version/author, permissions, compatibility, dependencies, conflicts and SHA-256 without executing code.
3. Explicitly confirm same-ID replacement and downgrading separately.
4. Install disabled; updating also stops the previous version.
5. Approve full-app-access only to permit execution. Both approval for the current content and settings-project `PluginStates.enabled` must be active before the main window runs it.

If bytes change after inspection, reject the SHA-256 mismatch. Approval applies to that content only; updates need fresh approval. A digest checks content identity, not publisher identity/signature. Plugins are not sandboxed and run with Devcel's permissions; do not approve untrusted code.

Approve/permit dependencies first and enable them in settings. A disabled dependency stops dependents while preserving their selected enabled preference. Before updating an execution-approved dependency, revoke dependents' execution permission. Reject deletion while dependents remain installed.

## Update failure, deletion, restoration and restart

- An activation failure restores the prior stored version. Within the same app run, a previously approved/execution-permitted version can resume only if current preferences/dependencies allow it.
- Restoration after restart and explicit Restore previous version remain disabled even if approval digests are retained; the user re-enables execution.
- Retain up to five prior versions per ID. Deleted-package listings survive restart.
- Load at startup only when the current digest has execution approval and the settings table enables it. Inspecting/installing a ZIP never implies execution.
- Report restoration failure explicitly and refresh version/approval/enabled state. An RPC timeout is not cancellation; inspect the main-window result before retrying.
- Release managed command/event/settings subscriptions on stop. Arbitrary external side effects of plugin code cannot be rolled back.

## Settings and execution permission

`PluginStates` in the ordinary View → Options project owns user enabled/disabled choices. False does not revoke content approval; true does not grant it. Install/update/restore clear execution permission, so stale true values cannot run new content automatically.

Permission operations, source retrieval and deletion require the inspected digest. Restoration checks both current digest (or uninstalled state for deleted items) and target digest.

Plugin API 2.0.0 supports plugin-owned settings and translation tables. See the independent [resource fixture](https://github.com/devcel-dev/devcel/tree/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/examples/plugin-owned-tables) and the [SDK settings contract](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/docs/plugin-api-reference.md#settings-api).

Add `capabilities: ["settings-tables", "translation-tables"]` only for the resource kinds actually declared, plus:

```json
"resources": {
  "settingsTables": [{ "id": "preferences", "path": "preferences.table.toml", "contract": "preferences.interface.toml", "cardinality": "singleton" }],
  "translationTables": [{ "id": "translations", "path": "translations.table.toml", "contract": "translations.interface.toml" }]
}
```

Paths are package-relative regular files. Traversal, symlinks, duplicate/case-colliding paths, undeclared capabilities, conflicting owner/table/UUID identities, invalid typed settings and duplicate translation keys are rejected before publication. Limits: 32 tables, 2 MiB per table or interface document, 8 MiB total declared resources, within the ZIP-wide limits.

Settings declarations choose `cardinality: "singleton"` (exactly one row, default) or `cardinality: "rows"` (zero or more rows), with typed scalar columns. Strings, selects, booleans and numbers are supported; 64-bit integers are returned as strings. Each translation table has String columns `key`, `locale`, and `text`. Keys are local to the package owner, cannot override core/other-plugin messages, and need an English fallback. ICU syntax is validated before installation. Table names are `Plugin_<UTF-8 owner hex>_<tableId>`.

Each declaration requires a nonempty `.interface.toml` contract and the table must actually implement its current version, with matching field origins, types, choices and constraints. Interface cells are stored in `interface_values` by column UUID. Contract names use `Plugin_<UTF-8 owner hex>_<contractName>_Contract` and stable package-owned UUIDs. Multiple resources in the same package may share an identical meaningful contract. This package format supports flat contracts; `extends` dependencies are rejected explicitly. General project interface inheritance is independent of this package restriction. Empty marker interfaces, forged implementation IDs and ambiguous duplicate field names are rejected.

Tables appear in View → Options under `Tables/Plugins/<owner>`. The host-managed `PluginResources` catalog contains typed references to one-row registration tables. Each registration implements the common owner/table ID/kind/cardinality contract and has a `target` TableRef whose interface is the package’s resource contract. Registration metadata has one authoritative copy; ordinary edits cannot unregister a resource or exchange its target. All resource validation and registration is one journaled transaction with package installation. Active settings editors block registration rather than being closed. Invalid updates keep previous user bytes; successful compatible updates add defaults without deleting/resetting authored values. Uninstall leaves all user tables intact.

API 1.x packages are rejected as incompatible. This contract does not automatically rewrite old profiles; preserve them and explicitly choose a new settings profile when upgrading incompatible schemas.

## Optional catalogs

No distribution service, account, signing key or API key is required. Catalog initially lists local packages. Load optional local JSON, or enter an HTTPS URL in `UserSettings.pluginCatalogUrl` and fetch explicitly from Catalog. There is no default server and no automatic startup/preferences-triggered retrieval.

```json
{
  "formatVersion": 1,
  "plugins": [{
    "metadata": {
      "id": "my-plugin", "name": "My Plugin", "version": "1.0.0",
      "description": "Distribution example", "author": "Your name",
      "devcelVersion": ">=0.1.0 <1.0.0", "apiVersion": "2.0.0"
    },
    "downloadUrl": "https://your-domain.example/my-plugin.zip"
  }]
}
```

Optional `digest` is the ZIP's real lowercase SHA-256. Limit catalogs to 1 MiB and 200 unique IDs. Require HTTPS URLs without credentials/fragments. Cache validated information for offline display and revalidate through Rust on reopening.

Open distribution links in an external browser only on user action. Inspect downloaded ZIPs in the dedicated window. Catalog loading does not download, install, approve or run packages automatically. Inspect actual ZIP dependencies/compatibility at import time.

## Profile upgrades

Profile upgrades retire the known Hello World sample settings table and activation row while keeping the previous profile untouched for recovery. Repurposed user tables and plugin rows are preserved.
