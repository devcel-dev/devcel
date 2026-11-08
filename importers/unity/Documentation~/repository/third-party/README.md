# Third-party licenses

Builds collect the original third-party license/NOTICE/copyright texts into ignored `generated/licenses/`; `generated/THIRD-PARTY-NOTICES.txt` combines those texts for offline reading. `generated/inventory.json` records exact versions, lockfile checksums/integrity, evidence identities and scope. Devcel's own component licenses remain in each component's `LICENSE` and are summarized in `../LICENSE-NOTICE`.

Embedded source-comment notices use `embedded-notices/source-sha256-<digest>.COPYRIGHT` as their display and inventory label. The digest is SHA-256 over UTF-8 canonical JSON with sorted keys, no optional whitespace, and unescaped Unicode. Its fields are `ecosystem`, `package`, `version`, `source_url`, `original_path`, `original_line`, and `body_sha256`. The original package-relative path and 1-based line number come from the extractor's source reference; the body hash covers the exact UTF-8 notice bytes. The source URL is the evidence URL/source, package source, or bundled registry source, in that order. All embedded source references use this rule, regardless of their names. Repeated references to the same source intentionally share an identity; different canonical identities sharing a digest fail generation. Regenerating from the locked package archives reproduces the IDs. Dedicated license-file paths, original notice bodies, copyright statements, and upstream URLs remain unchanged.

## Regenerate and verify

Use the repository's pinned Node/npm/Rust versions and Python 3.11 or newer:

```sh
npm ci --prefix devcel-studio
cargo fetch --locked
python3 scripts/generate-third-party-notices.py
python3 scripts/generate-third-party-notices.py --check
python3 scripts/generate-third-party-notices.py --check-locks
```

The full check reads actual registry package contents. Missing platform-optional npm packages are fetched from their lockfile registry URLs and verified against lockfile integrity. No application source is uploaded. Review regenerated notices alongside every dependency update, but commit only dependency locks, source manifests, and required upstream license inputs. `generated/` and the Studio public legal copy are ignored build outputs; build entry points generate them automatically with `--ensure`, including their hashes. `--check-locks` is an offline packaging gate: lock/manifests and evidence must match the generated inventory. Unknown declarations or missing license texts fail the gate rather than being silently allowed.

`cargo-upstream.json` and `npm-upstream.json` hold reviewed supplements when publishers omit license files from their archives. Each supplement identifies an original file and its immutable upstream revision where available. Do not copy a license from an unrelated package, invent a copyright holder, or replace an unresolved declaration with an SPDX guess. Standard texts referenced by an upstream license declaration are explicitly identified as standard texts, with upstream placeholders preserved. Copyright statements remain in original notices and sources.

`assets.json` covers copied source, icons, fonts and templates outside package-manager resolution. Review it when introducing assets or copying code. Lockfile checks cannot discover a newly pasted code fragment's origin; that remains a code-review responsibility.

## Scope and license choices

- Cargo includes the complete lockfile graph, across target-specific normal dependencies. Each package names the workspace components that can reach it. Remaining packages are classified as build/test-only. Procedural macros and generated code can cross this boundary, so this is a conservative inventory, not a proof that a package contributes bytes to a binary.
- npm includes the root and Studio lockfiles, including development and platform-optional packages. Runtime means potentially distributed; tree-shaking can remove code. Development-only means build/test tooling, with emitted helper code requiring case-by-case review.
- Template manifests describe downstream users' future builds. Their uninstalled dependencies are not represented as if Devcel shipped their binaries.
- Where Cargo explicitly offers MIT using `OR`, Devcel selects MIT and records that basis. Legacy slash-separated declarations are preserved and flagged for review, without silently interpreting the slash as `OR`. All original alternative texts are retained. `AND` obligations are never discarded. Other original expressions remain unchanged.
- MPL and other copyleft entries are retained as review items. Attribution files alone do not discharge source-availability or other distribution obligations.

## Distribution

Studio embeds the readable notices under `public/legal/`, accessible through Help → OSS. The packaged `legal` resource contains the verified aggregate notices, including all required original text bodies. The generated inventory and individual evidence files remain in the matching source checkout; they are not separately promised as Studio payload files.

`scripts/package-importers.py` builds a separate Cargo-only inventory from the actual isolated CLI/core/runtime dependency graph. All engine ZIPs contain `ThirdPartyNotices/` beside the addon/package, plus the MIT CLI license (`LICENSE-CLI-MIT.txt`) and `cli-source.tar.gz` containing exact source, the lockfile, complete Cargo vendor tree with original notices, and the same inventory. ZIP extraction verifies every notice byte. The bundled CLI is editor tooling; CLI, core, runtime and engine SDK first-party code are MIT licensed; Studio remains GPL-3.0. Third-party dependencies retain their own terms.

Releases provide immutable commit source links, build/rebuild instructions and `SOURCE-ACCESS.json` instead of a mandatory combined archive. [`preferred-sources.json`](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/third-party/preferred-sources.json) binds the exact locked MPL crates and runtime npm dependencies to editable source evidence, not just generated registry artifacts. See [Source delivery](../docs/development/source-delivery.md) for public/private access, availability and update requirements. `scripts/package-studio-source.py` remains an optional local dependency-cache archive helper; it does not automatically copy the separately referenced upstream preferred-source trees. Verify source builds on each supported platform and retain notices in any source/vendor copies. Review platform runtime redistributables (including WebView2, system libraries and SDK-derived bindings) for the actual release method; they are not npm/Cargo packages and are not blanket-covered by this inventory.

Pinned Cargo/npm, Rust standard-library and copied-asset license evidence authenticates the recorded original bytes. LF and CRLF checkout differences (including mixed LF/CRLF) are compared as LF; the generator recovers the exact original LF or CRLF bytes matching the recorded SHA for emitted notices and input fingerprints. It does not strip whitespace, change text, remove a BOM or accept lone CR. The same rule works without Git metadata in a source archive. Compressed artifacts and generated distribution hashes remain byte-exact. No `core.autocrlf` setting change is required.

## Explicit review items

- objc2-family upstream `LICENSE.md` explicitly describes uncertainty concerning Apple SDK-derived declarations. The upstream caveat is reproduced in full. This inventory does not resolve Apple's SDK terms or claim that a macOS release has received legal review.
- Standard MIT/MPL texts included through upstream references are verbatim upstream texts, not reconstructed license prose. Unfilled template placeholders are left unchanged rather than inventing copyright ownership.
- See each package's `review`, `errors` and original license texts, and `assets.json` for third-party copied-source and asset findings.

## Rust standard library

`rust-standard-library.json` pins the official installed toolchain’s complete standard-library copyright report and accompanying original license texts. Cargo.lock does not enumerate the standard library. These notices are included in Studio and importer distributions and are invalidated when rust-toolchain.toml changes.

## Declared standard-license supplements

For `react-remove-scroll-bar@2.3.8`, the published package.json explicitly declares MIT and names its author, but the package and its documented source project have no dedicated license-text file. The original package.json and README are retained byte-for-byte. The separately labeled MIT standard text comes from SPDX license-list-data v3.27.0, with its placeholders unchanged. The missing publisher file remains a review item; no author metadata is turned into an invented copyright notice. npm explicitly supports SPDX license identifiers in its license field: https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#license . SPDX explains the identifier-to-standard-text mapping at https://spdx.dev/learn/handling-license-info/ .
