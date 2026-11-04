# Forge & Field: A Devcel-Driven Godot RPG

Choose a long-term objective, prepare at the base, and travel to a connected region. Gather materials, fight, return with rewards, and craft equipment or qualify for a new job. The game reads its content and progression from the complete Devcel runtime export.

## Play

1. Open `game/project.godot` in Godot 4.6.3 and press F5.
2. Choose one of the three grand objectives.
3. Use the destination map to inspect regions and their requirements, then depart.
4. Gather the remaining material at the stop and automatically advance to an encounter. After victory, continue exploring or return.
5. Report completed quests, forge and equip items, and prepare for another expedition.

Facilities operate at the base. The map reveals adjacent unknown places after a visit; selecting an unknown place does not reveal its contents. Choosing a locked discovered region only inspects its requirements; choosing a grand objective does not unlock its route. See [controls](game/README.md).

**Use Save and Load for one local progress slot.** Saves live in Godot's `user://progress` folder, outside this repository. Save after a completed action; during battle, finish or retreat first. Loading asks before replacing current progress. New game keeps the existing save until you explicitly press Save. There is no autosave.

Checkpoints retain inventory and equipment instances, mastery, accepted/completed/tracked quests, the grand goal, visited regions, exploration depth, and the already drawn gathering pool and random state. Save format 2 accepts name and numeric balance updates using the current definitions. Item IDs, ownership, quest progress, rewards already paid, and the frozen gathering pool/RNG remain intact. Equipment stats and quality multipliers use current values; HP is capped at the current maximum without healing. Loading reports these adjustments. Missing referenced IDs, changed column types, changed quest condition sets/kinds/targets, unavailable current equipment or changed grand-quest targets are rejected without changing progress. Format 1 saves can be loaded with their original data and upgraded by pressing Save; they did not record the objective compatibility information required to safely interpret progress after a data change.

A completed new save is published without replacing the previous file. If the newest generation is damaged, Load offers an explicit confirmation to recover the previous valid checkpoint. A later successful Save preserves that validated backup. Unsupported newer save formats and read errors never trigger fallback or overwrite; genuine structural incompatibility is reported rather than silently loading an older game. Playing needs Godot only; no network, Rust, Node.js or Studio installation is required.

## Edit content

Open `authoring/GrowthRPG/GrowthRPG.devcelproj.toml` in Devcel Studio, edit the tables, save, and Full-export runtime JSON to `game/data/live.json` with prefix `GrowthRPG`. Press R in the game, or enable file watching in the F3 debug view. Formula results are evaluated by Devcel during export.

The authoring project is the source of truth. Normal content editing does not require changing GDScript. Keep existing record UUIDs when editing content so current selections and earned progress remain associated with the same records. Use new UUIDs for new records.

The bundled content includes 11,108 materials, 1,100 enemies, 1,110 equipment definitions, 1,210 recipes, 28 jobs, 5,000 regional requests plus two shared introductory requests, 501 residents, and 12 shops across 100 independent regions with 124 connections. Each region offers 20 beginner, 15 intermediate, 10 advanced and five highest-local-difficulty requests. Grand objectives designate three of these requests rather than adding duplicate quest rows. These are sample content counts, not runtime limits. Quality is stored on a crafted equipment instance rather than by cloning each equipment definition ten times.

See [adding content](CONTENT.md) for table contracts and direct CLI authoring and export commands.

## Live updates

The loader validates a candidate export and its progression references before adopting it. Invalid candidates retain the last valid data and show an error. Valid updates reconcile same-UUID selections and ownership. An active encounter retains its admitted enemy stats and rewards. An equipped item that no longer meets its requirements is unequipped without deleting ownership.

Loading and validation are synchronous. Large changed exports can briefly pause interaction. Test exported PCKs/executables on each target platform; this sample's local verification uses Godot on Windows.
