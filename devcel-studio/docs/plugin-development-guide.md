# Devcel plugin development

Use the [template](../templates/plugin-template/README.md) and [SDK types](../templates/plugin-template/src/types/pluginTypes.ts). The required `metadata.apiVersion` is `2.0.0`.

## Minimal plugin

Default-export a Plugin from the template's `src/index.ts`:

```typescript
import type { Plugin } from './types/pluginTypes';

const plugin: Plugin = {
  metadata: {
    id: 'my-plugin', name: 'My Plugin', version: '1.0.0',
    description: 'Project tools', author: 'Your Name', apiVersion: '2.0.0'
  },
  activate: async (api) => {
    api.ui.showNotification('My Plugin is active', 'info');
  },
  deactivate: async () => {}
};
export default plugin;
```

## Build and test

1. Set the template's identity, description, author, and package information.
2. Run `npm install`, `npm run lint`, and `npm run build`.
3. Implement extensions with the SDK and [API reference](plugin-api-reference.md).
4. Bind table operations to UUID, project session, and revision, retaining complete TableData.
5. Release subscriptions, timers, and resources when deactivating.
6. Build a ZIP, inspect its manifest/permissions/hash in Plugin Manager, install disabled, then approve execution and enable it.

The TypeScript build emits ES modules. For the ZIP, bundle executable CommonJS exporting the Plugin object through module.exports. Include dependencies other than host React; remove TypeScript syntax and ESM imports from the bundled output.

## Lifecycle

Provide activate and deactivate. Optional hooks include onInstall, onActivate, onDeactivate, onUninstall, and project/table hooks. The host invokes hooks; avoid invoking onActivate again from activate.

Reread current settings when execution resumes. Updates received while disabled may not be replayed. Explicitly stop owned timers and validate targets in callbacks already running.

## Extensions and settings

Declare menus, toolbarButtons, contextMenus, sidePanels, dialogs, processors, exporters/importers, and themes using SDK structures. Pass ReactNode values to side panels/dialogs. Theme.colors requires all 20 semantic tokens; additional cssVariables must not override them.

Settings are edited in ordinary Devcel tables. The API provides read/watch for predefined keys. Arbitrary third-party key/value schemas are outside this settings contract. PluginStates.enabled, package approval, and execution permission are separate checks.

## Packaging and trust

Follow the [offline ZIP format](../../docs/development/plugin-packaging.md): plugin.json and bundle at the root, formatVersion=1, apiVersion=2.0.0, matching code/manifest IDs and versions, dependencies, permissions, and SHA-256.

Plugins execute with substantial authority inside the host. Permission labels do not create a sandbox. Clearly describe data reads, writes, and transmission, and restrict them to the requested purpose.

Verify enable/disable/restart, dependency disablement, callback failures, table/project switching, warning approval, failed saves, and subscription cleanup. Record source checks and native Studio results separately.
