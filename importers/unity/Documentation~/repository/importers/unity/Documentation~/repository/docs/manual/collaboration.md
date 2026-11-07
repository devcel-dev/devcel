# Synchronization, multiple windows, and saved files

[Manual](README.md) / [Godot](godot.md) / [Unity](../../../../INSTALL.md) / [CLI](cli.md) / [Troubleshooting](troubleshooting.md)

Devcel's P2P connection coordinates Studio and CLI instances using the same project on the **same computer**.

## 1. Three kinds of updates

| Update | Input | Result |
| --- | --- | --- |
| Studio/CLI editing synchronization | Server-committed editing state | Authoritative state shared with connected instances |
| Unity/Godot import | Saved source-project files | Game JSON and optional generated code |
| Game hot reload | Changed generated JSON | Reloaded game database |

Importer P2P notifications trigger imports, but pull reads saved files. Uncommitted editor input is not an import source.

## 2. Use Studio and CLI together

### Normal workflow

1. Open the project in Studio. P2P connects to its server or starts one if needed.
2. Point the CLI at the same manifest and check status.
3. With server_running true, normal CLI auto mode connects to that server.

```sh
devcel -p ./Master/Master.devcelproj.toml status
devcel -p ./Master/Master.devcelproj.toml --mode client table list
```

Client mode requires a connection. Auto falls back to local operations only when no server is discovered; failing to connect to a discovered server is an error.

Multiple Studio instances share server-committed state through authoritative snapshots. A separate clone or path is a separate dataset. The server listens on loopback `127.0.0.1`.

Local-mode writes during a live server can cause save conflicts and stale views. They may proceed after a warning, so stop active users before intentional direct-file editing.

### Run a server without Studio

Terminal A:

```sh
devcel -p ./Master/Master.devcelproj.toml serve
```

Terminal B:

```sh
devcel -p ./Master/Master.devcelproj.toml status
devcel -p ./Master/Master.devcelproj.toml --mode client info
devcel -p ./Master/Master.devcelproj.toml watch
```

Serve emits initial status and continues until Ctrl+C; it joins an existing server when present. Watch streams JSON Lines: connected, committed snapshot events containing project_state, and disconnected. It receives authoritative snapshots rather than operation replays.

A standalone watcher exits on disconnect. Importers manage reconnection. Their Auto/P2P modes acquire a server automatically; manual serve is useful when you want to retain one independently. Each distinct source project needs its own server.

## 3. Choose an automatic import mode

New sources default to Auto. Existing saved modes are retained. Select Off for manual imports.

| Mode | Trigger | When no server is available |
| --- | --- | --- |
| Off | Manual import | Manual import remains available |
| FileWatch | Changes to saved project/table/interface files | Continue importing saved files |
| P2P | Notifications and saved-file changes while connected | Acquire/reconnect; pause automatic import until connected |
| Auto | P2P notifications plus file watching | Acquire/reconnect while continuing saved-file imports |

P2P also watches files while connected to catch save completion after a notification. Only Auto continues file-based automatic imports while disconnected.

See [Godot automatic import](godot.md#7-automatic-import) and [Unity automatic import](../../../../INSTALL.md#7-automatic-import).

### Shared behavior

- Notifications are coalesced.
- Sources can be watched concurrently, while output-changing imports are serialized.
- Transient automatic-import failures retry after approximately five seconds.
- Off, source removal, plugin deactivation, and editor exit stop that importer's own watcher. A managed server exits about five seconds after its last importer or editor leaves. A server previously started by Studio or manual serve is not stopped by the importer.
- Manual and automatic imports share content version, namespace, class name, and destination settings.

## 4. Try synchronization

Use a practice copy:

1. Complete the engine's first-import wizard and choose **Save and import**.
2. Check import success and the expected row/value in JSON.
3. Change the value in Studio, confirm the cell, and wait for saving to finish.
4. Without pressing Import, check the automatic import result and updated JSON.
5. If game hot reload is enabled, check the displayed value too. A database loaded once with load_file needs a reload mechanism. The [Godot](godot.md#4-read-imported-data-in-the-game) and [Unity](../../../../INSTALL.md#4-read-imported-data-in-the-game) examples include this.

If output stays unchanged, first check whether the row and column belong to the selected [content version](versions.md).

## 5. Project files and local state

### Source project

Keep these together:

- The `.devcelproj.toml` manifest
- Table and interface TOML files under Tables, with their directory structure
- Project Markdown, related material, and required auxiliary files

Tables includes data, UUIDs, references, and interface history. Undo history is not guaranteed to survive Studio/server restarts.

### Game-side files

See [Godot paths](godot.md#5-settings-and-paths) and [Unity paths](../../../../INSTALL.md#5-settings-and-paths) for shared configuration and local state.

Generated JSON/code can be used without source projects or the CLI. Regeneration requires the configuration, source, and matching CLI.

Exclude temporary save files `.*.devcel-write.lock` and `.devcel-write-*.tmp` from version control. Preserve active locks. Use bundled CLI/runtime packages with their matching manifests and hashes rather than mixing platform binaries.

### Clone or switch branches

1. Stop editing and automatic import; allow active saves/imports to finish.
2. Perform the version-control operation while preserving relative source/game layout.
3. Reopen Studio to load changed files.
4. Review source settings, content version, and Auto import status. Use manual Import for Off mode or retries.
5. Recompile changed generated code and restart the game when required.

Resolve TOML conflict markers and UUID/interface-history inconsistencies before importing. Interface branches and merges use interface preview-merge/merge; they are distinct from file-level version-control conflicts.

## 6. Status and recovery

Use the importer's status view or pull --status:

| Status | Meaning | Next step |
| --- | --- | --- |
| Imported / pulled | This import succeeded | Check generated values and game loading |
| Up to date / ready | Saved content, configuration, and outputs match | No import needed |
| Needs import / needs_pull | New source, changed content/configuration, missing or modified output | Import the source |
| Error / error | Import or verification failed | Correct the reported cause and retry |

Status is read-only and leaves outputs/state intact. A previous error can remain visible until a successful import.

### Crashes and locks

- Concurrent pulls using one configuration are rejected by an OS lock. Wait for the active operation.
- An existing .devcel-lock file alone does not prove a live process; OS locks release at process exit. Removing the filename is not a lock-recovery strategy.
- .devcel-state.json records successful hashes/errors. .devcel-owner.json beside an output identifies its owner. Both are local to the machine/layout.
- Moving old caches with a project can trigger owner mismatch. Verify the outputs are not in use elsewhere, stop watchers/CLI, back up and remove only that configuration's stale cache/owner state, then reimport. Preserve active locks.
- Failure in one source leaves other successful sources' outputs intact. Inspect per-source results.

### After restarting

Saved Auto/P2P settings reconnect. Temporary connection state and last-import displays are refreshed. For manual diagnosis, temporarily select Off, verify a manual import, then restore the desired mode.

If data remains old, compare source path, save completion, content version, output path, and the JSON path loaded by the game. See [Troubleshooting](troubleshooting.md).
