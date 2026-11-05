# Automatic-Sync Tests

This Linux harness compiles Editor C# with .NET 8/C# 9 and minimal Unity API mocks, then exercises real child processes, filesystem notifications, and the CLI. `Tests~` keeps it outside Unity package import.

## Run

Use an existing Python 3.10+, .NET 8 SDK, and `devcel` CLI built from the source being verified:

```sh
python3 'importers/unity/Tests~/AutoSync/run.py' \
  --dotnet /path/to/dotnet \
  --cli /path/to/devcel
```

The harness downloads no SDK and stores no binaries in the package. Without `--cli`, it runs C# compilation, static contracts, and fake-CLI checks using real subprocesses. Use `--work-dir /tmp/new-directory` for a new output directory; otherwise it creates and reports a temporary directory. Output includes logs, compiled artifacts, isolated HOME, fixtures, and `manifest.json` with source/CLI SHA-256 values. The source tree remains free of generated output.

## Coverage

- Auto default, saved Off preservation, serialized enum values, and watch startup without a preliminary status call.
- Argument spaces/quotes/trailing backslashes, stdin EOF, and stopping only owned watches.
- A 15-second connection limit; 1/2/4/8/16/30-second backoff, short-lived connections, and reset after a stable connection.
- Brief startup/connection errors with Console details, and recovery from CLI-corruption-like failures.
- Real FileSystemWatcher source isolation, no watch process in FileWatch/Off, disconnected-P2P pull suppression, and Auto file fallback.
- autoSync disable, assembly-reload/quit cleanup, and ignoring notifications after shutdown.
- Real-CLI automatic startup without Studio, sharing among watchers, source isolation, and snapshot notifications.
- Multiple-source Pull, namespace/root-type preservation, C# regeneration on schema changes, and JSON updates for data changes.
- Reconnection after watch termination, managed-server shutdown after final demand, reuse/preservation of manual servers, and recovery after unexpected server exit.
- Forced .NET parent termination, confirming real-watch exit with `waitpid`, then managed-server shutdown.

Only the parent-exit check uses a Linux child subreaper to collect descendants it creates. It does not scan `/proc` or kill by process name. Real-CLI checks use a temporary HOME and leave the user's registry/projects untouched.

## Limits

`UnityApiMocks.cs` supplies test AssetDatabase/JsonUtility implementations. This does not validate actual asset serialization, Importer UI, Unity domain reload, Play/Player, Windows, or macOS. Successful mock compilation is not native Editor verification. CLI-harness Pull uses the real CLI; FileSystemWatcher Exporter calls are recorded by mocks.
