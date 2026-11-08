# Devcel user manual

Devcel lets you edit game data, such as item names, prices, and statistics, in tables. This manual walks through the application controls, from creating a project to using its data in a game.

![Devcel Studio editing Items with formulas, material references, and growth curves](images/studio-curve-applied.png)

## Start here

1. [Install and open Studio](installation.md).
2. [Create your first project](getting-started.md) and a practice table.
3. [Edit tables](studio.md), add columns and rows, and save your work.

## Find a task

| Task | Guide |
| --- | --- |
| Prepare and open the app | [Installation](installation.md) |
| Create, save, and reopen a project | [Getting started](getting-started.md) |
| Copy/paste, rows, search, CSV, and input rules | [Studio controls](studio.md) |
| Tags, notes, and parent records | [Metadata and inheritance](metadata-and-inheritance.md) |
| Types, references, choices, and curves | [Types and references](data-types.md) |
| Share column definitions across tables | [Interfaces](interfaces.md) |
| Colors, opacity, HDR, and color-space conversion | [RGBA colors](colors.md) |
| Write formulas, override cells, and diagnose errors | [Formulas](formulas.md) |
| Function arguments, results, and examples | [Function reference](formula-reference.md) |
| Summarize drops, select rows, and combine prices | [Calculate rewards across tables](formula-collections.md) |
| Collection syntax, types, and limits | [Collection reference](formula-collections-reference.md) |
| Version badges, release previews, and versioned output | [Versions](versions.md) |
| Language, plugins, and app updates | [Settings and plugins](settings-and-plugins.md) |
| Write, build, test, and package a plugin | [Plugin development](plugin-development.md) |
| Diagnose saving, export, or import failures | [Troubleshooting](troubleshooting.md) |

## Use the data in a game

The engine guides cover initial setup, automatic import after editing in Studio, and reading the imported values in a game.

| Task | Guide |
| --- | --- |
| Godot setup and automatic import | [Godot](godot.md) |
| Unity setup and automatic import | [Unity](../../../../INSTALL.md) |
| Command-line editing, validation, and export | [CLI reference](cli.md) |
| Multiple windows, synchronization, and project files | [Synchronization and saved files](collaboration.md) |

## Key terms

- **Devcel Studio:** the desktop application for editing data.
- **Devcel project:** a folder containing a game's tables. Open its `.devcelproj.toml` file.
- **Importer:** an engine extension that prepares Devcel tables for a game.
- **Devcel CLI:** the `devcel` command for editing, validation, and export.

## Build and development documentation

To build or modify Studio, see [Studio development and builds](../development/build-studio.md). Other technical material is listed in the [documentation index](../README.md).

Authoring source compatibility and migration: [TOML format version 1](../reference/authoring-format-v1.md).
