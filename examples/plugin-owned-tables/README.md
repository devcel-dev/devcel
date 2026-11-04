# Plugin-owned tables SDK fixture

This is an independent, locally authored fixture, not an automatically loaded/bundled plugin. Export this folder through Plugin Manager to inspect its ZIP. Installation is disabled by default and does not run `main.js`.

The manifest declares only `settings-tables` and `translation-tables`; these capabilities allow declarative data registration, not plugin execution. Execution still requires digest-bound full-app-access approval and the user's enabled setting.

After installation, open View → Options to edit the values in `Tables/Plugins/report-tools` resource tables. `PluginResources` and the registration tables are host-managed and read-only. `preferences.prefix` stays in the source project through restart, disable/enable, update and removal. Removing the package deliberately does not delete this data. English supplies the fallback when the selected app locale has no plugin translation.

Table data names use `Plugin_` + the lowercase UTF-8 hex of the owner ID + `_` + table ID. Table/column/row UUIDs must be stable across compatible updates. Updates may add fields/translation rows, but cannot change a stored field's identity or type or silently reset user edits.

Each resource declares its `.interface.toml` contract in `plugin.json`. The resource table implements that contract and stores its interface fields in `interface_values` by column UUID. Include both table and contract files in the ZIP. This format supports nonempty flat contracts (no `extends` dependencies); a meaningful identical contract can be shared by multiple resources of the same package. General project interface inheritance is unaffected.

The host publishes contracts, registrations, resources and the package index together. The catalog points to a singleton registration, whose `target` TableRef uses the resource's own contract. Registration metadata cannot be edited independently or redirected through ordinary grid edits. A singleton resource keeps exactly one row; its values remain editable.
