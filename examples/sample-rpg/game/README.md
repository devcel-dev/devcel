# Controls and live data

Open `project.godot` in Godot 4.6.3 and press F5, or run `godot --path .` from this directory.

## Expedition cycle

- **Start:** choose one grand objective. Its route remains locked until ordinary progression requirements are met.
- **Base:** forge, equip, trade, inspect jobs and quests, or rest. Select a destination to open the map.
- **Town:** settlements open their existing local shop, rest, requests and travel actions. Gather collects the finite town gathering pool without starting a battle. Depleted pools stay depleted through menus and reload; leave for another region and visit again for a new stop. Encounters remain outside towns.
- **Map:** visited regions show their names; adjacent unexplored places remain unnamed until entered. Hidden regions cannot be selected or entered. The visible part of the goal route offers the next clue. Drag to pan, use the wheel or zoom buttons to zoom, use Current location to center on the current region, or fit the discovered extent. At base, Current location marks the region containing the current base, not the map selection. Dense overview markers zoom into their locations when clicked. The first revealed neighborhood is framed automatically once. Depart only when both discovery and progression requirements are met.
- **Explore:** the current region's candidates are sampled using its authored depth-stage weights. The fixed turn pool appears separately from the read-only probability list; zero-chance candidates remain visible as 0%. The sample defaults to one draw; data can configure multiple distinct draws and each material's `mine_yield` quantity. Percentages describe the first draw. Gather collects the whole remaining pool atomically and starts an encounter. If inventory capacity is insufficient, nothing is collected. Choosing Continue after victory advances exploration depth once and draws the next pool. Return, retreat or defeat resets depth to zero and discards the pool; the next departure draws a new entrance pool. Menus, tracking, redraw and data reload neither advance depth nor reroll the current pool. Relevant objective and job-trial encounters appear contextually.
- **Battle:** attack or retreat. A surviving enemy retaliates. Crafting, trading and changing jobs are unavailable here.
- **Victory:** review loot, then continue or return. Rewards are credited once.
- **Return:** review expedition gains and newly craftable items, claim completed ordinary quests, and report a completed grand objective.

The request journal combines shared requests and available requests at the current location, with search and paging. Accepted requests remain listed when traveling elsewhere. Select a request to read its resident's circumstances, exact conditions, rewards and reported outcome. Accept requests explicitly; multiple requests can remain accepted at once. Tracking changes navigation hints only and never replaces acceptance. A selected grand objective is accepted at game start. Unaccepted requests with satisfied conditions show a hint without consuming items or awarding rewards. Accepted requests can be reported from the return screen or journal. Existing eligible gathering, crafting and victory progress is retained when accepting; inventory-based conditions use current ownership. Reload retains accepted UUIDs and re-evaluates changed conditions. Delivery reports consume the listed materials once; equipment-proof requests retain the equipment. Requests remain optional except for explicitly authored progression requirements.

At the forge, lists support search, region filters and pagination. Select a recipe to see owned/needed materials, cost, quality and equipment requirements. Click an ingredient to inspect its acquisition regions. The default filter shows available recipes; the full catalog remains inspectable. After crafting, use Equip immediately below Craft to equip that exact item and quality; equipped items are marked.

Equipment requirements use the job's bare STR/DEX/INT. A weapon cannot satisfy its own requirements. Quality changes the weapon contribution; scaling coefficients and requirements are separate authored values. Switching jobs preserves damage taken and may unequip incompatible equipment while retaining the item.

Mastery comes from eligible first victories, first useful crafts and quest reports. Eligibility and reward amounts are authored data. Repeating the same enemy or equipment definition does not repeatedly grant mastery for the same job. Advanced jobs require the authored parent mastery, quest and trial conditions.

The compact inventory below character status lists only owned materials and equipment, with right-aligned counts. It is read-only and scrolls within a fixed height. Counts refresh after gathering, deliveries, crafting and trading.

## Keys

- **R:** reload game data.
- **F3:** open or close diagnostics and file-watch controls.
- **Esc:** return from a base facility; at the base/start, open the exit confirmation.
- **F12:** capture the viewport only when launched with an explicit `--capture-dir=<writable-directory>` user argument. No screenshots are written into the project by default.

Save and Load use a local manual checkpoint. New game starts a separate session without replacing the existing checkpoint until Save is chosen. Reloading data preserves the current session.

## Trading and recovery

Visit a merchant's region before trading with that merchant from the base. The shop entry appears only once a merchant is known. Unvisited merchants and their offers stay hidden, and direct model calls enforce the same visit requirement. Each shop lists explicitly authored `shop_offers`. Direction flags and positive buy/sell prices determine which transactions are available. The bundled offers use sale price `max(1, material.value)` and purchase price `max(shop.price, sale price + 1)`, with signed integer saturation. Keep buy price above sell price when adding offers if a buy/sell profit loop is not intended. Eligibility, displayed prices and transactions use the same model checks.

Rest is a base action. It charges up to the authored rest cost, limited by current funds, and restores HP. Retreat returns without awarding victory loot or healing. Changing jobs alone does not revive a defeated character.

## Editing and reload

Edit the main Devcel project, save, and Full-export to `data/live.json`. See [the authoring guide](../CONTENT.md). The F3 view shows generation, row count, hashes, load time and errors.

Invalid data retains the last accepted snapshot. Valid reloads keep inventory, quality instances, mastery, visited regions and claimed rewards by UUID. Selecting a map node or grand objective does not reveal a region; successful departure does. An active enemy retains its encounter-start snapshot. Removed or incompatible selections are reconciled before another action can use them.

## Catalog preparation and authoring checks

Normal loading reads raw JSON, builds typed tables, progression rules and lookup indexes, and publishes the completed snapshot. Invalid JSON or a structure needed by those builders fails loading; a failed live update retains the previous snapshot. Content issues such as cyclic unlock requirements, disconnected regions or gathering balance settings do not reject the entire game.

For data-authoring validation, call `model.validate_authoring_data(candidate_database)` explicitly. It checks the sample's progression, quest, gathering, rarity and discovery contracts without changing the live model or its random state. This is separate from `model.load_main()` and normal live reload. Generic Devcel export validation does not validate these game-specific rules.

Run the catalog loading regression locally with Godot: `godot --headless --path examples/sample-rpg/game --script res://tests/test_catalog_loading.gd`.
