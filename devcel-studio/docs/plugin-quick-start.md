# Getting started with plugin development

1. Copy the [plugin template](../templates/plugin-template/README.md) into a working folder.
2. Set the ID, name, author, and description in package.json and src/index.ts. Set `metadata.apiVersion` to `2.0.0`.
3. Use the template's TypeScript 7.0.2 and SDK types. Run `npm install`, `npm run lint`, and `npm run build`.
4. Implement your feature using the [minimal plugin](plugin-development-guide.md#minimal-plugin) and SDK.
5. Bundle JavaScript as CommonJS, exposing the Plugin object through module.exports. The bundle must be executable JavaScript without TypeScript syntax or ESM imports.
6. Place plugin.json and the bundle at the ZIP root following the [package format](../../docs/development/plugin-packaging.md).
7. In Studio's ZIP installation manager, review the manifest, requested permissions, and SHA-256. Install disabled, then approve execution and enable the plugin to test it.

Use the host's `react` and `react/jsx-runtime` modules; bundle other dependencies.

Project/table operations use UUIDs, sessions, revisions, and complete DTOs from the [API reference](plugin-api-reference.md). Plugins declare their own typed singleton or multirow settings tables and translation tables; settings provide owner-scoped read/watch access. See the [resource fixture](../../examples/plugin-owned-tables). Themes specify all 20 semantic colors.

Follow the [maintenance checklist](plugin-maintenance-guidelines.md) for shutdown, restart, failure, and conflict handling.
