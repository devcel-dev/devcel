# Authoring TOML format: version 1

This describes the source files that carry project data, not the exported runtime bundle. Tables (`*.table.toml`) and interfaces (`*.interface.toml`) each use `[metadata] schema_version = 1`. A missing version means 1 for files created before the version field existed. Readers must reject versions they do not understand rather than rewrite them. `min_version`, interface history UUIDs, and the runtime bundle manifest schema version serve different purposes.

## Stability and migration policy

Version 1 is the stable authoring contract. Compatible additions must preserve the meaning of existing data. A breaking format change requires a new schema version and an automatic migration supplied with the release that introduces it. Migration must preserve identities, values, expressions, interface history and references, retain a recoverable original, and fail without publishing partial files. Each supported upgrade path must be tested. No version 2 exists today and the version 1 reader cannot interpret future versions.

Older Devcel releases predate this version field. In particular, v0.0.3 rejects table metadata containing `schema_version`, and older interface readers may discard metadata when saving. Back up source files before upgrading and do not edit upgraded files with older versions.

## Tables

The top-level table contains `uuid`, `display_name`, `description`, `metadata`, `interface_implementations`, `schema`, and `records`. Metadata contains `data_name`, `interface_order` (interface UUIDs in display order), `initial_transposed`, optional `parent_uuid`, `edit_permissions`, and `schema_version`. Permissions have boolean `add_columns`, `delete_columns`, `add_rows`, `delete_rows`, and `edit_cells` fields. Interface implementations are keyed by interface UUID and contain the synchronized interface version and synchronization metadata.

`schema.columns` is an ordered array of column definitions. A column has a stable `uuid`, `data_name`, `data_type`, `read_only`, `default_value`, and `style` (`color`, `font_size`, `width`); optional fields include display text, tags, `min_version`, reference, curve, select and table-reference settings, interface origin, constraints, input validation, and conditional formatting. Column UUIDs, not display names, identify inherited interface columns. See the [data types](../manual/data-types.md), [interfaces](../manual/interfaces.md), and [formulas](../manual/formulas.md) guides for the semantics of these fields.

Each record has a `uuid` and a `values` map, with optional `parent_uuid`, `label`, `min_version`, `tags`, `interface_values`, and `memo_texts`. `values` is keyed by ordinary column `data_name`; `interface_values` is keyed by the originating column UUID. Values are strings even for numeric columns and may be expressions beginning with `=`. Missing cells, explicit values, inheritance, defaults, and evaluated values are distinct; do not replace the source with the exported result. Parent links refer to record UUIDs and must form an acyclic graph. Preserve column order, record order, identifiers, expressions and metadata when migrating.

## Interfaces

An interface contains `uuid`, `name`, `current_version_id`, optional `description`, ordered `columns`, `extends` (interface UUIDs), `history`, and `metadata.schema_version`. A history entry is keyed by version UUID and has `version_id`, optional `parent_version_id`, `timestamp`, ordered `changes`, and optional `author`, `comment`, and `merge_info`. Merge information retains the second parent, conflict resolutions and changes relative to that parent. Column definitions use the same structure as table columns. Preserve unknown fields when extracting data for migration, even if your own reader does not interpret them.

## Independent recovery

TOML is a text format. For example, Python 3.11's standard `tomllib` can inspect a file without Devcel:

```python
import pathlib, tomllib
path = pathlib.Path("Tables/enemies.table.toml")
with path.open("rb") as f:
    table = tomllib.load(f)
if table.get("metadata", {}).get("schema_version", 1) != 1:
    raise ValueError("unsupported authoring schema")
for record in table["records"]:
    print(record["uuid"], record["values"], record.get("interface_values", {}))
```

This inspects stored inputs, not formula evaluation or inherited values. Preserve the complete original TOML files and their project-relative paths for recovery. Concrete examples are in [ManualBasics](https://github.com/devcel-dev/devcel/tree/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/examples/manual-basics) and [plugin-owned tables](https://github.com/devcel-dev/devcel/tree/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/examples/plugin-owned-tables); the Rust definitions in [`table.rs`](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/table.rs), [`column.rs`](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/column.rs), [`record.rs`](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/record.rs), and [`interface.rs`](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-core/src/interface.rs) define the detailed v1 representation.
