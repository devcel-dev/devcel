# JavaScript / TypeScript Setup

## First import

1. Extract the JavaScript SDK ZIP. Check that it contains `bin/manifest.json` and a CLI executable for your OS and CPU. The source-only ZIP does not include the executable.
2. Install [Node.js](https://nodejs.org/) 20 or later. Node is used by the settings server; browser game builds do not need it. The SDK needs no additional npm packages.
3. In your game folder, run `node /path/to/sdk/editor/server.cjs --config ./devcel.import.json`. Open the displayed `http://127.0.0.1:...` URL. Keep it private: it grants permission to edit the configuration.
4. Click **Add Source** and enter the path to the `.devcelproj.toml` file itself. Relative paths are always based on the directory containing `devcel.import.json`, for example `../Authoring/Game.devcelproj.toml`.
5. Enter the source ID, namespace, class name, Content Version, JSON output, and TypeScript output, then reimport that source. Leave Content Version blank to include all content; `0` is valid. Settings persist across restarts.
6. Add the generated JSON and TypeScript to your game. `devcel-runtime.js` and `devcel-runtime.d.ts` are placed next to the TypeScript output. If an existing file with the same name differs from the SDK copy, generation stops without overwriting it. Review the file or choose another code-output folder.

For JavaScript-only use, copy `runtime/devcel-runtime.js` into the game:

```js
import {DevcelDatabase} from './devcel-runtime.js';
const db = new DevcelDatabase();
const readText = async () => {
  const response = await fetch('./data/base.json', {cache: 'no-store'});
  if (!response.ok) throw new Error(`Devcel: HTTP ${response.status}`);
  return response.text();
};
await db.reload(readText);
const hero = db.table('Heroes')?.byId('hero-1');
console.log(hero?.getNumber('hp'));
```

With namespace `Game.Base` and class name `BaseData`, use `import {Game} from './generated/base/BaseData'`, then call `Game.Base.BaseData.FromRuntime(db)`. The generated API follows the schema, for example `typed.Items.ById(id)?.Hp`.

Serve browser games over HTTP because `file://` has browser-specific loading restrictions. Point JSON output to a served directory such as `public/data`. In Node, `runtime/node.js` provides `openFile(path)` for file loading, reload, and watching.

## Live reload

Enable both saved-source import and runtime reload:

- In the import UI, enable **Watch saved changes and import automatically**. Every two seconds, the server calls the bundled CLI's `pull --status` and reimports changed sources. Only saved Studio files are read. Failures appear in status and are retried. Pressing Ctrl+C to stop the server also stops this watch.
- In the game, call `db.watch(readText)`. The runtime validates every table and cell before replacing the snapshot. Loading errors or invalid JSON preserve the previous snapshot. Rebuild the relevant game UI after notification.

```js
const unsubscribe = db.subscribe(current => {
  console.log('new data', current.manifest?.content_hash);
  // Obtain fresh rows with current.table(...).byId(...).
});
const stop = db.watch(readText, {intervalMs: 1000, onError: console.error});
// When the screen or game closes:
// stop(); unsubscribe();
```

Concurrent reloads are coalesced. Existing Table/Row handles and references retain their old snapshot. File contents are compared, so equal-size changes are detected. Exceptions in reload subscribers are reported to the console without rolling back a validated snapshot.

Changes to TypeScript schemas or generated APIs also require the game's normal recompilation/page reload. Exclude the import CLI, settings, authoring data, and local HTTP server from release builds.

## Values, references, and multiple sources

- The runtime loads the whole project into local memory. Both full and minimal exports are supported; omitted minimal cells are reconstructed from column defaults. Formulas arrive as values evaluated by the Rust exporter.
- I64/U64 use ES2020 `bigint`. Converting them to JavaScript `Number` can lose precision, so preserve the type for IDs and currency. Use `row.raw(name)` for the canonical string.
- Color32 is integer RGBA in 0..255. ColorFloat is floating-point HDR RGBA. Negative and above-one RGB values and transparent alpha are retained without clamping, gamma conversion, or premultiplication. TypeScript distinguishes both types.
- Evaluate curves with `getCurve(column).sample(x)`, which uses the stored tangents. Resolve records with `row.reference('item', 'Items')`; generated TypeScript supplies the schema's target table. TableRef resolves tables by UUID and interface within the same snapshot.
- Copies containing identical project/table UUIDs can coexist with distinct source IDs, namespaces, output paths, and Database instances. `DevcelProjectSet` holds one DB per ID and rejects namespace collisions. Tables are kept within their source.
- The runtime has no Node, DOM, or Cocos dependency. Phaser, PixiJS, Babylon.js, and other hosts can supply a reader returning JSON text. That reader is responsible for engine-specific asset-cache invalidation. ES2020 and `bigint` support are required.

## Safety and troubleshooting

The SDK checks the bundled CLI's manifest, version, and SHA-256 before invoking it without a shell. The shared Rust CLI validates sources, ownership, namespaces, and outputs, and handles runtime/code generation and replacement. A failed CLI run preserves existing output. Removing a source from settings leaves its generated files in place.

- **Missing CLI or hash mismatch:** extract the official SDK ZIP again. The importer does not fall back to an unknown executable.
- **Import failed:** read the UI error, correct the saved source or output path, and reimport that source.
- **Stale output:** inspect the source with the status action.
- **JSON changed but the game did not:** check HTTP/engine caching and that the runtime watch is running.
- `.devcel-state.json`, `.devcel-owner.json`, and `.devcel-lock` are local caches. Exclude them from Git and game builds. Leave active lock files in place.

## Verification

From the SDK root, run `node tests/workflow.mjs`. Coverage includes full/minimal data, I64/U64, HDR/transparent colors, Reference/TableRef, 195 curve samples, old-snapshot preservation, source isolation, HTTP UI authentication, settings loading, failure preservation, CLI hashes, and symlink rejection.

For real-CLI checks, run `node tests/cli-workflow.mjs /absolute/devcel /absolute/new-evidence-dir`. This checks output protection, per-source reimport, and preservation after failure. Verify the game's browser, desktop, mobile, and other target environments separately.

References: [Node.js filesystem](https://nodejs.org/api/fs.html), [Node.js child processes](https://nodejs.org/api/child_process.html), [MDN setTimeout](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout).

## Per-source tag filters

In the source settings, select project tag presets for row include/exclude and column include/exclude. The choices come from that source's saved `.devcelproj.toml`; refresh presets after editing the project vocabulary. Filters are stored per source as `row_include_tags`, `row_exclude_tags`, `column_include_tags`, and `column_exclude_tags`. Empty include lists include all; multiple includes match any tag, and exclusions win. Content Version is applied in addition to these filters.

Names missing from the project's presets remain visible and editable after a merge. Correct them to a preset or explicitly remove them; they are never silently cleared. Import fails if an exported reference requires an excluded row, preserving the last good output. Save and import again after changing filters.

The JavaScript settings server loads the same registry-only tag selector as the shared importer UI. Use **Reload project tags** to refresh choices. A project switch keeps existing filters and marks names absent from the new project as unregistered. Save settings before inspecting saved status. Automatic watching uses the Rust saved-file fingerprint, including all four filter arrays and project tag metadata; changing filters triggers reimport even when timestamps or output sizes match.

Real filter regression: `node tests/tag-filters.mjs /absolute/devcel /absolute/new-evidence-dir` verifies the authenticated registry endpoint, four-array persistence, unknown-name repair, source-isolated vocabulary, fingerprint-driven automatic reimport, and previous-output preservation after rejected settings.
