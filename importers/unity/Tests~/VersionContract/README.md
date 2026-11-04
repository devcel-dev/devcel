# Bundled CLI contract tests

This offline harness compiles the real `DevcelPaths.cs` and `DevcelCliRunner.cs` with an already installed Mono/C# compiler. No SDK or dependency is downloaded. Only Unity's package and asset lookup APIs are mocked; path, manifest, SHA-256 and subprocess validation use production code.

Run on Linux with a real matching CLI:

```sh
python3 'importers/unity/Tests~/VersionContract/run.py' \
  --mono /path/to/MonoBleedingEdge/bin/mono \
  --csc /path/to/MonoBleedingEdge/lib/mono/4.5/csc.exe \
  --cli /path/to/current/devcel \
  --work-dir /path/to/new-test-output
```

Checks cover local/embedded UPM lookup, complete package copies under Assets, actual CLI pull/watch capabilities, ignored manifest version metadata, and platform/schema/hash/path rejection. Production sources and the supplied CLI remain unchanged. Logs, source/CLI hashes and results are retained in the output directory.

These tests do not establish actual Unity Editor GUI, asset serialization/import, domain reload, Play mode or Player behavior. Native Editor acceptance is still required.
