# Your First Devcel Sample

This saved project has one table and two records, with formulas and column/row Content Versions.

[Manual](../../docs/manual/README.md) · [CLI](../../docs/manual/cli.md) · [Godot](../../docs/manual/godot.md) · [Unity](../../docs/manual/unity.md)

## Open it

Copy this folder before experimenting. Open `ManualBasics.devcelproj.toml` in Studio and select `enemies`, whose saved display name is `Enemy Data`.

| Column data_name | Type | Version | Meaning |
|---|---|---|---|
| `name` | String | 0 | Enemy name |
| `hp` | I32 | 0 | HP |
| `double_hp` | I32 | 0 | Formula `=hp * 2` |
| `reward` | I32 | 2 | Reward included from version 2 |

The project contains two records:

| Record | UUID | Version | hp | double_hp result | reward |
|---|---|---|---|---|---|
| Slime | `11111111-1111-4111-8111-111111111111` | 1 | 100 | 200 | 5 |
| Dragon | `22222222-2222-4222-8222-222222222222` | 2 | 500 | 1000 | 50 |

Export includes rows/columns at or below the selected version, leaving saved source data intact. `double_hp` is stored as a formula; runtime JSON contains its evaluated string value.

## Inspect CLI output

Run from the repository root. Replace `devcel` with your executable path if needed.

```sh
devcel -p ./examples/manual-basics/ManualBasics.devcelproj.toml --mode local table get enemies
devcel -p ./examples/manual-basics/ManualBasics.devcelproj.toml --mode local export runtime --version 1 --out ./manual-output/v1.json
devcel -p ./examples/manual-basics/ManualBasics.devcelproj.toml --mode local export runtime --version 2 --out ./manual-output/v2.json
devcel -p ./examples/manual-basics/ManualBasics.devcelproj.toml --mode local export code csharp --namespace Game.Master --version 1 --out ./manual-output/v1.cs
devcel -p ./examples/manual-basics/ManualBasics.devcelproj.toml --mode local export code csharp --namespace Game.Master --version 2 --out ./manual-output/v2.cs
```

Expected results:

- `v1.json`: `manifest.content_version` is 1. One Slime row; columns name/hp/double_hp. `double_hp` is `"200"`; reward is excluded.
- `v2.json`: version 2, both rows, all four columns. Dragon `double_hp` is `"1000"` and reward is `"50"`.
- `v1.cs`: typed `Game.Master.DevcelDatabase` and `Enemies` API, without a Reward property.
- `v2.cs`: includes Reward. Pair code and runtime with the same Content Version.
- Omitting `--version` exports all rows/columns.

The two C# files define identical namespace/type names for comparison; do not install both in the same Unity project. Use one configured importer output for a game.

## Import and edit

Follow the [Godot](../../docs/manual/godot.md) or [Unity](../../docs/manual/unity.md) guide using the copied `ManualBasics.devcelproj.toml`. Set Content Version to 1 and confirm **Save and Import**.

In Studio, change Slime's `hp` from 100 to 150, commit the cell, and wait for saving to finish. Auto import produces JSON `hp: "150"` and `double_hp: "300"`. Then save importer Content Version 2 and check that Dragon and the reward column appear.
