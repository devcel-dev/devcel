# Devcel plugin template

A TypeScript template for Devcel Plugin API `2.0.0`. Replace metadata in `src/index.ts` and the package ID, name, description, author, and URLs in `package.json` with your plugin's information.

## Development

Use the Node.js/npm versions declared by `package.json`, its pinned TypeScript version, and the SDK's React types and host API.

```sh
npm install
npm run lint
npm run build
npm test
```

`npm run dev` watches TypeScript sources. Build emits JavaScript and declarations to `dist`. Tests use Node's built-in runner; the template does not include a sample test.

## Implementation contract

- `metadata.devcelVersion` is the plugin author's supported-host range, not a copy of the product version. The template supports stable hosts by default. For a prerelease host, explicitly include the exact prerelease you tested; copying or building the template does not opt in automatically.
- `metadata.apiVersion` is required and must be `2.0.0`.
- Declare menu, toolbar, exporter, and other extensions using the SDK structures in `src/types/pluginTypes.ts`.
- Table operations use UUIDs, the read's project session, revision, and complete DTOs. Column `min_version` is a required number.
- Track unsubscribe callbacks and timers and release them on deactivation.
- Settings support reads/subscriptions for defined keys. `PluginStates.enabled` selection and package execution permission are separate.
- Themes provide all 20 semantic color tokens. Additional CSS variables cannot override semantic colors.

## Install in Studio

TypeScript output alone is not a distribution ZIP. Bundle JavaScript as CommonJS and return the plugin object through `module.exports`. Leave no TypeScript syntax or ESM imports. Use the host's `react` / `react/jsx-runtime`; bundle other dependencies.

Place `plugin.json` (`formatVersion=1`, `apiVersion=2.0.0`) and the bundle at the ZIP root. In Plugin Manager's ZIP installation interface, review metadata, permissions, and hashes. Installation starts disabled; activation requires the user's approval and execution permission.

See the [development guide](../../docs/plugin-development-guide.md), [API reference](../../docs/plugin-api-reference.md), and [ZIP distribution contract](../../../docs/development/plugin-packaging.md). Publishing to npm and installing in Studio are separate operations.

## Source checks

`npm run lint` performs TypeScript checking, unused-local diagnostics, and the safety rules in `scripts/check-source.cjs`. Generated SDK types are type-checked but excluded from style checks. Unused callback arguments are permitted. Explain type-check exceptions; use explicit object/function/primitive types, distinct enum values, safe optional chains, ES modules in source, and expression statements with effects.

## License

The template's package license is MIT; see [LICENSE](LICENSE). Before publication, replace year/copyright-holder placeholders with the actual rights holders and preserve third-party notices. The template's MIT license does not relicense GPL-3.0 Studio or third-party code you include.
