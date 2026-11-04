# Native distribution gate

Cargo/npm inventories do not enumerate system libraries or installer bootstrappers. Before publishing a platform artifact, extract its entire install payload and run:

```
python3 scripts/check-native-distribution.py --root EXTRACTED_PAYLOAD --manifest third-party/native-distributions/PLATFORM.json --first-party EXACT_BUILT_DEVCEL_BINARY --report native-license-report.json
```

The gate hashes every ELF/PE/Mach-O file, rejects unreviewed binaries, and verifies that each third-party binary's original notices are physically present in the payload with the reviewed hashes. The first-party exception requires byte identity with a supplied build output, not a filename match. Do not include third-party libraries in `--first-party`.

Each platform manifest must identify the actual format and extraction evidence, and separately address installer/bootstrapper and system-runtime terms. For each shipped third-party binary, record name/version, exact hash, license, upstream source, source availability, linking/relinking details, and the original notice paths/hashes inside the installed payload. An empty or pending manifest never authorizes release.

Review Linux AppImage's included GTK/WebKit/media/system libraries; Windows NSIS/MSI runtime code, WebView2 distribution method and CRT; and macOS bundled dylibs/frameworks plus SDK-derived declarations. Merely checking the outer installer, Cargo package licenses or a clean vulnerability audit is insufficient. Unsupported or incomplete extraction remains a release blocker.

These platform manifests intentionally remain pending until actual artifacts and their original notices have been inspected. This does not assert that Windows/macOS validation or legal review has occurred.
