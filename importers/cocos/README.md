# Cocos Creator 3.8 LTS Setup

## Install and import

1. Extract the Devcel Cocos SDK ZIP into your game's `extensions/devcel-importer/`. Its root should contain `package.json`, `dist/`, and `bin/`. The ZIP includes the compiled extension, so installation needs no npm install or TypeScript build.
2. Enable Devcel Importer in **Extension → Extension Manager**. Refresh the extension list if Creator was already open.
3. Open **Extensions → Devcel Import** and add a source.
4. Use the file picker to choose the `.devcelproj.toml`. The saved path is relative to `devcel.import.json` in the game root; for example, `../Authoring/Game.devcelproj.toml` keeps authoring data outside the game.
5. Set the source ID, namespace, class name, and Content Version. Blank includes all content; `0` is valid. Choose separate JSON and TypeScript outputs, such as `assets/resources/devcel/base.json` and `assets/devcel/base/GameData.ts`.
6. Reimport the source. The shared Rust CLI creates the complete JSON and typed TypeScript, then the extension refreshes the Asset Database. `devcel-runtime.js`, its declarations, and `DevcelCocos.ts` are placed beside the generated code. Existing files with different contents are protected from overwrite.

Add each source separately. Copies with identical project/table UUIDs stay isolated when they use different source IDs, namespaces, output paths, and runtime instances. Settings, Content Version, and class name persist in the game-root JSON. Removing a source from settings keeps its generated files.

## Load data in the game

Use this in a game Component. `resourcePath` is relative to `assets/resources/` and omits the extension.

```ts
import {Component, _decorator} from 'cc';
import {CocosDevcelSource} from './devcel/base/DevcelCocos';
const {ccclass} = _decorator;

@ccclass('Example')
export class Example extends Component {
  private source = new CocosDevcelSource('devcel/base');
  private unsubscribe?: () => void;
  private destroyed = false;
  async start() {
    this.unsubscribe = this.source.database.subscribe(db => {
      const hero = db.table('Heroes')?.byId('hero-1');
      console.log(hero?.getNumber('hp'));
    });
    await this.source.reload();
    if (this.destroyed) return;
    this.source.watch(); // Development; reload explicitly as needed in production.
  }
  onDestroy() {
    this.destroyed = true;
    this.source.stop();
    this.unsubscribe?.();
  }
}
```

With namespace `Game.Base` and class name `BaseData`, connect the typed API:

```ts
import {Game} from './devcel/base/BaseData';
const typed = Game.Base.BaseData.FromRuntime(this.source.database);
console.log(typed.Items.ById('item-id')?.Hp);
```

Use the table and column names from your schema; see the generated comments.

## Live reload

- Enable **Watch saved changes and import automatically** in the import panel. Every two seconds it checks the CLI's saved-file fingerprint and pulls changed sources. Save in Studio first. Manual reimport uses the same generation path.
- `CocosDevcelSource.watch()` releases only the Devcel JsonAsset cache entry and reloads it with `resources.load(..., JsonAsset)`. It validates the complete data before replacing the Database and notifying subscribers. Invalid JSON or loading errors preserve the previous Database.
- Existing Table/Row handles retain the old snapshot. Obtain new rows after notification. Access the Devcel JsonAsset through this adapter rather than sharing the asset itself with other Components.
- In development Preview, verify an HP change and reload notification after reimport. Code/schema changes also require Creator's normal recompilation and Preview restart. Updating released games requires an asset-bundle/hot-update workflow and a reader for published JSON; local authoring changes are not delivered directly to installed games.
- Disabling or closing the extension stops its source watch. Stop runtime watching in the Component's `onDestroy()`.

## Types and rendering

The runtime loads complete canonical schema-v1 full/minimal exports, preserving evaluated formulas, defaults, integers, booleans, strings, references, and curves. I64/U64 use ES2020 `bigint`; verify support on each Cocos target. Older JavaScript engines may not support it through transpilation alone.

Color32 uses 0..255 RGBA; ColorFloat uses floating-point RGBA. Negative/above-one RGB and transparent alpha are preserved. Conversion to Cocos's 8-bit `Color` is explicit and loses HDR range. Use float shader uniforms when appropriate. Apply gamma conversion, clamping, and premultiplication explicitly to match the game's rendering design.

## Safety and game builds

The extension verifies the bundled CLI's OS/CPU, manifest, version, and SHA-256. The Rust CLI validates the input tree, namespaces, outputs, and ownership before replacing completed output. Invalid sources or code-generation failures preserve previous results. JSON output is limited to `assets/resources/`, code to `assets/`; unrelated images, Prefabs, and Materials are protected.

Game builds need the generated JSON, required generated TypeScript, and runtime. Keep `extensions/`, `bin/`, authoring projects, import settings, and caches out of game data. For a missing CLI, extract the official SDK ZIP again; arbitrary executables and PATH fallbacks are not supported.

## Verification coverage

- `npm run verify` checks extension messages/refresh calls, path restrictions, watch shutdown, and packaged-runtime consistency at mocked boundaries, plus DOM-driven tag additions, unknown repair, independent source arrays and project-registry invalidation.
- Strict TypeScript compilation covers `source/*.ts`. `assets/runtime/DevcelCocos.ts` is type-checked against a stub matching the public API.
- These checks do not establish native Creator or device-build behavior. Native engine verification remains required.
- On the target engine, check first import, two sources with identical UUIDs, Content Version `0`, per-source reimport, HP updates in Preview, preservation after a malformed source, panel-close behavior, and watch shutdown when the extension is disabled.

Official references: [Extension Manager](https://docs.cocos.com/creator/3.8/manual/en/editor/extension/extension-manager.html), [Extension Panel](https://docs.cocos.com/creator/3.8/manual/en/editor/extension/panel.html), [Message System](https://docs.cocos.com/creator/3.8/manual/en/editor/extension/messages.html), [Asset Loading](https://docs.cocos.com/creator/3.8/manual/en/asset/dynamic-load-resources.html). The extension uses `refresh-asset` from the [official asset-db types](https://github.com/cocos/creator-types/blob/main/editor/packages/asset-db/%40types/message.d.ts). Creator's **Developer → Message Manager** also lists asset-db messages.

## Per-source tag filters

In the source settings, click **Load / refresh project tag presets**, then select project tag presets for row include/exclude and column include/exclude. The choices come from that source's saved `.devcelproj.toml`; refresh presets after editing the project vocabulary. Filters are stored per source as `row_include_tags`, `row_exclude_tags`, `column_include_tags`, and `column_exclude_tags`. Empty include lists include all; multiple includes match any tag, and exclusions win. Content Version is applied in addition to these filters.

Names missing from the project's presets remain visible after a merge. After loading the registry, existing unknown entries are editable; entering an exact registered name restores the preset selector. Changing the source project requires loading its registry again. A failed registry load never clears saved filters. Correct them to a preset or explicitly remove them; they are never silently cleared. Import fails if an exported reference requires an excluded row, preserving the last good output. Save and import again after changing filters.
