# Reproducible Lua Integration Checks

Run from the repository root:

```sh
python3 importers/defold/tests/runtime_workflow.py --require-lua
```

The harness uses only Python 3's standard library and an existing Lua **5.4** shared library loaded through `ctypes`. It downloads or installs nothing. Select a library with `--lua-library /path/to/liblua5.4.so` or `DEVCEL_LUA_LIBRARY`; an explicit library selection disables fallback.

- Exit 0: requested checks passed.
- Exit 1: failure, including a missing library with `--require-lua`.
- Exit 77: library unavailable without `--require-lua`; this is SKIP, not a CI pass.
- Python `-O` is rejected because it disables assertions.

Coverage includes canonical full/minimal equivalence, references, integer boundaries, I64/U64 precision, HDR/transparent colors, metadata copies, unknown-column rejection, old-snapshot preservation, sources with identical UUIDs, file reload, HTTP failure and callbacks after Stop, native-smoke-script logic, and all Lua/Editor-script syntax. CLI version matching handles LF, CRLF, and no trailing newline, and rejects other versions.

Python decodes JSON; `sys`, `http`, and `editor.execute` are explicit stubs. The harness runs the production runtime on Lua 5.4. It does not replace verification of Defold LuaJIT/Editor Lua VM, its built-in JSON parser, native UI, real HTTP, or target builds. File reload uses real files in a temporary directory. Run `samples/runtime-smoke.script` and the setup guide separately in Defold.

Stubbed Editor UI checks cover consistent labels, tooltips, cancellation without saving, disabled Save for an empty ID, blank/zero Content Version, and default output paths. They do not test native window rendering.

Tag-filter checks execute the verified CLI argument boundary and preset-control callbacks through stubs: all four persisted lists, unknown-name repair returning to the selector, removal, preset-only additions, registry-not-loaded retention, and preservation of other source fields. No native Defold window is exercised.
