# Plugin maintenance and verification

## Contracts

- PluginMetadata.apiVersion is the required literal `2.0.0`; package versions have separate meaning.
- Keep producers, consumers, SDK types, templates, manifests, and fixtures consistent.
- Table mutations use UUIDs, the session captured during reading, the accompanying revision, and complete TableData.
- Preserve required min_version, type-specific settings, interface values, and history. Rust validates incomplete or invalid data.
- Theme.colors contains all 20 semantic colors. Additional cssVariables start with `--` and cannot override semantic tokens.
- Validate settings-table enabled state, digest approval, installation execution permission, and dependencies independently.

## Code and packages

Use the [template](../templates/plugin-template/README.md), its TypeScript 7.0.2 checks, and [SDK types](plugin-api-reference.md). Release lifecycle subscriptions/resources and manage owned timers and in-flight callbacks explicitly. Read settings again when resuming.

Check ZIP IDs, versions, API, permissions, dependencies, and JavaScript exports against the [package format](../../docs/development/plugin-packaging.md). Bundle dependencies other than host React. Document the host-level trust required by plugin execution.

## Checklist

1. Install, approve, enable, disable, restart, and disable a dependency.
2. Exercise each callback's success, exception, late completion, and cleanup.
3. Switch project A → B → A, including matching UUIDs, stale sessions/revisions, and expired warning tokens.
4. Check failed saves, external changes, Undo/Redo, and type conversion preserve data/input.
5. Apply settings, locale, and theme changes. Reject unknown keys and missing tokens.
6. Package updates and restored packages must satisfy current API, dependency, and approval requirements.
7. Record type/contract checks separately from native Studio execution.
