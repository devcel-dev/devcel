# Bundled Editor CLI

Installation ZIPs and the downloaded native companion include `Tools~/<rid>/devcel` (`devcel.exe` on Windows). The lightweight Git UPM package downloads the matching companion through **Devcel > Download Matching Native Tools**. Its native `manifest.json` declares the version, supported runtime identifiers (RIDs), and SHA-256 of each binary.

- The importer uses only the bundled CLI matching the OS and CPU.
- Unity excludes `Tools~` from its asset pipeline. Keep the CLI, corresponding source, and notices out of Player builds.
- The importer checks pull support in `devcel --help`. Only internal Pull operations launch the CLI; ordinary asset import does not.
- Build packages on the matching native OS with `python scripts/package-importers.py --out dist/importers --source-repository <owner/repo> --source-commit <commit>`. Keep generated binaries out of the source checkout.
- The CLI is MIT-licensed. Packages include `LICENSE-CLI-MIT.txt`, dependency notices under `ThirdPartyNotices`, and corresponding source. The native companion includes the shared notice aggregate and records a release ZIP URL, archive entry and SHA-256 for each RID's corresponding source in `Tools~/manifest.json`; the source archive is available inside the matching release ZIP. OS-specific packages keep the source archive directly under `Tools~`. These are separate from the Unity runtime's MIT license.

See [bundled CLI packaging](../../../docs/development/importer-packaging.md) for supported systems, verification coverage, executable permissions, and macOS restrictions.
