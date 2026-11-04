# Reproducible Fixture, Static, and Launcher Checks

Run from the repository root:

```sh
python3 importers/gamemaker/tests/static_and_launcher.py --require-launcher
```

The harness uses Python 3's standard library and existing OS-provided POSIX tools. It checks full/minimal fixture equivalence, the unknown-column fixture, GML brackets/function names, and YY metadata. On POSIX, a temporary fake CLI verifies paths containing spaces, unrelated working directories, argument preservation, SHA validation, tampering rejection, and executable-permission restoration only after verification. Existing games and CLIs are left unchanged.

- Exit 0: requested checks passed.
- Exit 1: failure, including missing POSIX support with `--require-launcher`.
- Exit 77: launcher checks skipped because POSIX support is unavailable; distinguish this from a complete pass.
- `--static-only`: explicitly run only fixture/static checks; supported on Windows too.
- Python `-O` is rejected because it disables assertions.

The GML lexical check is not a compiler. This script does not validate GameMaker VM/YYC/IDE execution or the native PowerShell launcher. Run `samples/runtime-smoke.gml` and the setup-guide checks in the target environment.

## Unicode, spaces, and relative paths

`static_and_launcher.py` exercises the real POSIX launcher with SDK/game paths containing Japanese text, spaces, `[ ]`, and `&`. Roots include absolute paths, relative paths, parent-relative paths, and omitted roots using the current directory. The fake CLI verifies that arguments remain intact.

Check the GameMaker/WOLF Windows launcher contracts with:

```sh
python3 importers/gamemaker/tests/windows_launcher_contract.py
```

The five cases in `fixtures/launcher_paths.json` run for both engines. They check quoted `-File` paths, `-LiteralPath`, direct PowerShell `& $binary ... --root <variable>` invocation, and expected root normalization. This is static contract verification, not a Windows command-line parser implementation or native execution test. Result JSON explicitly contains `windows_native:false` and `powershell_executed:false`. Generate and verify Windows/macOS ZIPs on their respective native hosts.
