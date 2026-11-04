# Adding content through Devcel

Edit `authoring/GrowthRPG/GrowthRPG.devcelproj.toml` and export the complete runtime file to `game/data/live.json`. The game does not read table TOML directly and does not infer progression from display names, numbered names or table row order.

## CLI authoring and canonical saves

Use `devcel --mode local --project <project>` with `table create`, `column add`, `record add --uuid`, or `cell set` for content changes. For a bulk update, first run `table get <table>` and preserve the returned raw `table` object and `revision`. Submit the complete edited object through `op -` on standard input:

```json
{"op":"UpdateTableData","data":{"table_uuid":"<existing UUID>","expected_revision":"<revision from table get>","data":{}}}
```

Replace `data` with the complete returned TableData, retaining UUIDs, raw formulas and unrelated edits. A stale revision is rejected. Interface-owned structure must use the dedicated `interface` commands. Mutations save through the same canonical serializer as Devcel project saves; `export runtime` alone does not resave authoring TOML.

From this sample directory, export the saved authoring project directly with the Devcel CLI:

```sh
devcel --mode local --project authoring/GrowthRPG/GrowthRPG.devcelproj.toml export runtime --out game/data/live.json
```

The game needs only the authored project and its Full runtime export. Reload with R after exporting.

## Content contracts

| Data | Authoring responsibility |
|---|---|
| `game_settings` | Initial selections through references and starting gold |
| `balance` | Initial rest price and rest growth |
| `regions` | Region identity, map coordinates, starting-region flag, manual discovery chance, first-entry town fee and visible purpose text |
| `region_connections` | References to both ends of each map connection |
| `access_profiles` | Reusable sets of access requirements; an explicitly empty profile is open |
| `access_requirements` | Profile reference, condition kind, amount and the relevant region/quest/equipment reference |
| `materials` | Acquisition region, gathering yield, value, quality group and multiplier |
| `gathering_sources` | Additional region/material reference pairs; unioned with each material's primary source without duplicate weights |
| `gather_stages` | Region, minimum exploration depth and draw count |
| `gather_tier_weights` | Stage reference, material tier and appearance weight |
| `gather_quality_weights` | Stage reference, quality index and appearance weight |
| `equipment` | Bare-stat requirements, required job/rank/mastery, STR/DEX/INT scaling, power and craft-mastery metadata |
| `item_rarities` | Item rarity names, display colors and descriptions; materials and equipment reference these rows |
| `recipes` | Input/output references, quantities, cost, quality group and default-quality reference |
| `jobs` | Stats, damage multiplier, parent job, promotion fee/mastery, equipment mastery discount and gathering quality weights |
| `job_trials` | Job and enemy references; multiple rows provide alternative qualifying trials |
| `enemies` | Region, HP, attack, rewards, drop reference, role, combat profile and mastery metadata |
| `quests` | Requester, source region, local difficulty, world band, story, outcome, access profile, rewards and Boolean `grand_candidate` |
| `quest_requesters` | Resident identity, region, occupation and personality; no fixed residents-per-region limit |
| `quest_conditions` | Quest reference, kind, target references and positive count; every row must be satisfied |
| `shops` | Regional availability and price data |
| `shop_offers` | Shop/material references, buy/sell direction flags and prices |
| `grand_objectives` | Legacy objective definitions for exports without the quest candidate field |

Access condition types are implemented once in the runtime: total wins, regional wins, claimed quest and owned equipment. Content authors combine these through rows rather than adding branches to game code. Content-bearing tables reference an access profile. A blank profile keeps the content locked; a broken reference rejects the candidate export.

Check `grand_candidate` on a quest in Studio to include it in the starting goal pool. A new game draws three distinct candidates at random; exactly three candidates means all are offered. Redrawing the screen or reloading data does not reroll the offered UUIDs or selected goal. At least three checked candidates are required: an undersized pool is a configuration error, with no unchecked substitutes. Candidate status does not unlock a region, bypass quest conditions or change enemy stats. The sample flags its hardest authored requests, but authors may flag any valid quest, including delivery-only requests. Removing a currently offered or selected candidate during a session is rejected rather than silently replacing the player's goals.

## Example: add a reachable region

1. Add a region with a new UUID and map coordinates. Keep only the intended starting region flagged as the start.
2. Add a connection referencing the new region and an existing region.
3. Give the new region an access profile. For example, require a specific existing quest to have been reported; select that quest through its reference field.
4. Add a material whose acquisition region references the new region, or add a `gathering_sources` row for an existing material. Give it a valid access profile, gathering yield and an entrance gathering stage.
5. Add equipment and a recipe referencing that material and equipment. For quality crafting, use an explicit quality group and a default material from that group.
6. Add an enemy with a valid drop reference and access conditions consistent with that drop. It must not advertise a reward that remains locked when the encounter starts.
7. Add a regional quest with an explicit objective kind and target. Add a job or trial through parent-job, quest and enemy references if the extension needs them. Add a shop offer if the new material should be traded.
8. Save and Full-export. Reload in the game and play the prerequisite route. Discover the connection through a successful gathering turn or battle victory in an adjacent region; roads from a visited town are known automatically. The region name and local content are revealed only by entering it.

Coordinates and connections may be edited without game-code changes. Optional loops are valid; every node must remain connected to the starting region. The map pans and zooms rather than shrinking all labels to fit the entire graph. Discovery uses the same connections and stable region UUIDs.

When changing roads, also review `regions.quest_neighbor`, regional story text and the actual typed quest conditions. The neighbor field describes the story partner; it does not retarget objectives at runtime. Difficulty-three field reviews use the source region or an adjacent worksite. Their enemy and material references must agree with the explicit target region. Difficulty-four requests can deliberately require longer journeys. Recipe regions label their catalog origin; forging remains a base activity and does not require a visit to that label's region.

The current trading houses combine local supplies with specialist imports. A road change does not make imported stock invalid, and sale services can accept goods brought from farther away. Local replacement stock retains the material family and quality grade where an equivalent exists. Ashforge keeps its woodland trade, and Clay Brook retains its own gathering supplies and crafting purpose. Visiting a merchant once still enables trading from any base.

Quest navigation considers additional gathering sources as well as the primary source. A delivery or recipe ingredient available from an affordable, known merchant needs no new field journey. A gathering objective still requires the actual gathering event at its specified source. Equipment requests point toward missing ingredients rather than treating the equipment's catalog region as a forge-location restriction.

Retargeted conditions keep their UUIDs but have a new event signature. Live reload discards incompatible event progress without paying a reported quest again. A checkpoint involving a retargeted request is rejected with a compatibility explanation; a checkpoint that does not involve those requests can still load. Keep the previous game/data pair if continuing an affected older checkpoint is necessary.

Run the complete regional contracts and the loading/save regression after exporting:

```sh
godot --headless --path examples/sample-rpg/game --script res://tests/test_regional_content.gd
godot --headless --path examples/sample-rpg/game --script res://tests/test_catalog_loading.gd
```

The new records appear through the same generic map, lists and action evaluators. Do not edit generated JSON by hand or add region-name checks to GDScript.

## Discovering routes

Every region has an editable `discovery_chance_percent` integer from 0 to 100. New region records use the same column (default 30); authors can set a rare region to 1, disable random discovery with 0, or guarantee it with 100. Initial sample values range from 10 to 50: onward paths and junctions are generally easier to find than terminal side routes. These are stored authoring values, not runtime adjustments based on graph degree. Editing connections never silently changes a region's chance.

`game_settings.discovery_min_battles` sets the completed victories required in the current visit before random discovery can begin (sample: 3). Victories one through three do not roll, including the third victory itself. The next successful gathering turn or fourth victory can roll. Returning, retreating, defeat and a new departure reset this counter; menus and data reload do not.

On each eligible successful gathering turn or battle victory, each adjacent undiscovered region independently rolls its own percentage. A region set to 30 has a 30% chance on each qualifying action nearby, regardless of the number of other candidates. Several regions may be discovered together. Failed actions, empty gathering pools, arriving, returning, refreshing the screen and loading do not roll. No unknown neighbor means no roll or notification. The sample uses open access profiles for all regions: discovery and connected routes remain required, and towns may charge a first-entry fee.

The starting region is known immediately. Entering a town reveals its adjacent routes without a roll; discovering an unvisited town does not reveal roads beyond it. The map shows undiscovered neighbors of visited regions as non-traversable `?` nodes, with no recursive reveal of the distant graph. Discovered but unvisited regions are distinct from both `?` nodes and visited places. Unvisited names and local content remain masked. Travel requires a discovered route.

Version 7 saves also retain the current visit victory counter. Earlier saves start that counter at zero without losing discovered or visited regions. Version 5 and later saves retain discovery state and its independent random stream. Older saves retain visited/current places and the starting region, plus roads from visited towns. Further field connections must be discovered through play; loading does not grant every neighbor of a visited field or reroll exploration.

Condition kinds are `kill`, `gather`, `craft`, `deliver` and `own_equipment`. Kill conditions may select an enemy, a region, or any eligible victory. Gathering and crafting use explicit material/equipment references and an optional region. Delivery uses a material reference; repeated delivery rows for the same material are summed before checking inventory. Reporting checks all conditions, access rules and reward capacity before consuming any items or awarding anything. An `own_equipment` condition checks distinct owned equipment/quality variants without consuming them, so an item prepared before meeting its requester remains usable. Use it for equipment-proof requests; keep `craft` for an explicitly new crafting event and avoid late, unrepeatable crafting requirements. Previously owned legal inventory can satisfy delivery; historical event credit belongs only to conditions eligible when the event occurred.

Local difficulty describes a request within its region; world band describes the strength required by its actual targets. Use claimed-quest access requirements for optional follow-up stories. Do not make every regional request a mandatory travel gate. Story prose should explain the requester's circumstances and the outcome; target names and quantities belong in typed condition rows.

Craft objectives count successful new instances of their referenced equipment. Different qualities count separately; failed duplicate crafts and refinement do not count. Author target counts within the available distinct variants. Both crafting and ownership counts are validated against real equipment/quality variants; refinement outputs and non-quality materials do not increase that limit. A strict crafting request unlocked after too many variants were already crafted is shown as impossible in that session, without granting historical credit or allowing duplicates. Use `own_equipment` when prepared equipment should count. Gathering objectives count collected units, not button clicks or return reports.

## Balance and validation

Avoid circular prerequisites: a region cannot require a quest whose only completion route is inside that still-locked region. A recipe needed for a gate must have obtainable ingredients before that gate. Map connections alone do not establish that resource and quest conditions are satisfiable.

Keep a first usable encounter and gathering source in each newly unlocked region. Standard-quality builds should have a viable route; optional high-quality equipment should improve the margin rather than be required everywhere. For advanced-job mastery, author both tier and progression-stage eligibility so a high-numbered starter recipe cannot substitute for later content.

Preserve UUIDs when renaming records. Display names are independent of runtime rules. Technical keys may still be referenced by authored `LOOKUP`, `COUNTIF` or `SUMIF` formulas, including column defaults; update those formulas when changing a key. If removing content, update its references and consider existing session ownership and selections. Condition UUIDs preserve earned progress when the count alone changes. Retargeting or reparenting a condition resets that condition's progress after a valid reload; changing its meaning must not reuse unrelated historical credit. Reported quest UUIDs remain reported and never pay twice. Failed candidate loads should report the offending table/record instead of partially applying a snapshot.

## Town entry

`regions.town_entry_fee` is a nonnegative, one-time fee; zero means free entry. The game confirms the current price and available gold before departure, then charges only after route, health and loadout checks succeed. Paid towns are recorded by UUID in version 6 saves. Older saves retain visited towns without retroactive charges. Town fees do not bypass discovery or connected-route checks. No quest reports, crafted items or victory totals are required for regional entry in this sample.

## Gathering probabilities

Town arrival also creates a finite gathering pool. Gathering there stays in town, without starting combat. A spent pool is not replenished by menus, loading or selecting the same town; leave for another region before returning. Enemy drops are shown separately as conditional on defeating that enemy, not as gathering probabilities.

Town pools use depth zero. Register a town gathering source only when its entrance stage gives the material both a positive tier weight and a positive quality weight. A later-depth town stage is not reachable through repeat visits. Field gathering requests may use deeper stages; neighboring requests must still name an adjacent source where their exact material can actually appear.

Each gathering stage belongs to a region. The stage with the highest `min_depth` not exceeding the current expedition depth supplies the weights. A candidate's weight combines its authored material-tier and quality-index weights, with the normal regional and access checks. Tier and quality are separate fields; neither is inferred from the name. Quantity remains `materials.mine_yield`.

The sample sets `draw_count` to one per gathering turn. Authors can increase it to draw distinct materials without replacement; each selected material contributes its authored `mine_yield` quantity. The displayed percentage is the chance of inclusion in the turn. For multiple draws this uses the same weighted-without-replacement distribution, with numerical estimates explicitly marked when necessary. All current-region candidates remain listed, including 0% entries. The probability vector and result are frozen together for the turn. New content or weight changes take effect on a later draw; reloading does not reroll an existing pool.

Depth advances when the player continues exploring after a victory. Returning, retreating or being defeated resets it; new expeditions start at depth zero. Regional stages may give their lowest local tiers a positive entrance weight even when those tiers have high numeric labels. No universal cumulative-victory requirement is imposed on material tiers, recipes or equipment by this system.

## Promotions and equipment access

Advanced jobs use `parent_job`, `mastery_required` and `promotion_cost`. The first promotion requires an unlocked parent, a current job descended from that parent, its earned mastery and enough gold. Payment permanently unlocks the job; switching back is free. Optional quest/trial references remain available to authors, but the sample's normal promotions do not require them. Job HP remains the sole source of maximum HP. `damage_multiplier_permille` scales total attack including equipment (1000 is neutral).

Equipment may require an explicit `required_job` (descendants qualify), a minimum `required_job_tier`, and `required_mastery`. Mastery belongs to the explicit prerequisite job, or otherwise to the current job's ancestor at the required rank; rank zero uses the current job. `equipment_mastery_discount` is a percentage reduction rounded up, and never bypasses rank, lineage or attribute requirements. Promotion therefore preserves eligibility for previously mastered lower-rank equipment. An incompatible equipped item is retained in inventory and unequipped when loading an older save against changed requirements.

`gather_quality_min` and `gather_quality_weight_permille` adjust weights for eligible materials at or above the authored quality index. A multiplier of 1500 means 1.5 times the weight, not an additional 50 percentage points of probability. Other candidates are renormalized; zero-weight, inaccessible and wrong-region materials stay impossible. Sampling and displayed probabilities share the modified vector, frozen when the gathering turn begins.

## Rest, defeat and saved progress

The initial rest quote comes from `balance.cost`. `balance.rest_growth_permille` sets the increase per stay: 40 means 4%, so the next quote is `ceil(previous_quote * 104 / 100)`. Every successful rest updates the quote, calculated with integers and saturated at the maximum supported amount. Full-health or failed attempts do not change it. Recovery remains available when funds are insufficient: the player pays their remaining gold, including zero; these stays still increase the quote and stay count. Defeat removes all held gold; voluntary retreat does not.

Completed stay count, the current quote and unlocked jobs persist in saves. A changed growth rate applies to future stays without recalculating the saved quote. Version 3 saves preserve their recorded paid-stay count and quote; previously unrecorded free stays cannot be reconstructed. Earlier saves start at the current initial rest quote and retain their selected job and its ancestors without a retroactive charge. Existing item ownership, quest progress and frozen gathering turns are preserved.

## Item rarity

Materials and equipment reference `item_rarities` through `rarity_ref`. Each rarity defines its English `name` and HTML `color`; changing a palette entry updates all item-name displays. Details also show the rarity name. Keep these references separate from equipment quality and power: rarity describes natural supply, not a requirement or a combat bonus.

The sample labels reflect the best natural gathering availability within the source region and ordinary local enemy drops. Equipment labels reflect required base and default-quality ingredients. Current region, depth and job still determine the actual gathering percentages shown on screen; a rarity label never changes those probabilities. Preserve item UUIDs when changing labels. Older catalogs without rarity columns remain readable, while authored rarity references and colors are validated on load.
