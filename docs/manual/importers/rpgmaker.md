# RPG Maker MV/MZ importer

See the [installation, import, runtime, and distribution guide](../../../importers/rpgmaker/README.md).

- Enable the plugin through PluginManager. Open its separate settings window using F6 in desktop test play or the MV/MZ plugin commands.
- The bundled OS/CPU-specific CLI is verified by SHA-256 and version.
- Save source ID, relative `.devcelproj.toml` path, namespace, class name, content version, Full/Minimal mode, and output destinations. Reimport one source or all sources.
- Runtime loads complete canonical schema-v1 JSON, preserving I64/U64 precision, HDR/straight-alpha colors, curve tangents, and references within the owning source.
- Standard Actors/Items/Enemies JSON and the existing game database are unchanged. Distributed games do not execute CLI/P2P or import authoring sources.
- There is no automatic live reload. Restart test play after a successful reimport.

Node, CLI, and browser fixtures do not verify actual MV/MZ/NW.js test play. Complete the README's native acceptance steps in the intended editor before production use.


## Per-source tag filters

Open the source in the test-play import settings window and configure its tag filters. Save the source and reimport.

The four filters are **row include**, **row exclude**, **column include**, and **column exclude**. Each source keeps its own selections. An empty include list includes all rows or columns; multiple includes use OR (any matching tag), and exclusions take priority. Content Version also applies.

Choose names from the source project’s saved tag presets. A saved name missing from those presets remains visible and editable: correct it to a preset or explicitly remove it. If an exported reference needs an excluded row, import fails and preserves the previous output.
