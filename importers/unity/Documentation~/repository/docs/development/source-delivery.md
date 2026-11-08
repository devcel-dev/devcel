# Release source access

[Building Studio](build-studio.md) · [Releasing](releasing.md) · [Third-party notices](../../third-party/README.md)

## Find the source for a binary

The matching GitHub Release contains source and rebuild directions beside its binary downloads. Use the full commit in `SOURCE-ACCESS.json`, not the current `main` branch. Release tags are checked against that commit before publication; the actual source/archive/documentation URLs pin the commit, because a tag can otherwise be moved.

Download that commit's source ZIP/tar.gz or clone the repository and check out the recorded commit. GitHub's automatic **Source code** downloads contain this repository only, not its registry dependencies. `SOURCE-ACCESS.json` supplies the exact registry URLs/checksums and separate preferred-source references. Downloading source is optional for people who only want the binaries; the release does not force everyone to download a combined source/dependency archive.

Follow [Building Studio](build-studio.md#rebuild-a-release) for pinned toolchains, platform prerequisites and commands. The checkout includes the editable first-party code, vendored code, license notices, build scripts, configuration, catalog inputs, examples and tests. Retain their notices when copying or modifying the source.

## Dependency source, not just installed artifacts

- `Cargo.lock` pins crate versions and SHA-256 checksums. `SOURCE-ACCESS.json` lists direct `.crate` downloads for all locked registry crates. Cargo retrieves and verifies these with `cargo fetch --locked`; `cargo vendor --locked` can preserve a local copy with the original notices.
- [`preferred-sources.json`](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/third-party/preferred-sources.json) separately records all five currently selected MPL-2.0 crates, their exact publisher commits, source directories and checked source-file evidence. Those files remain available under their original MPL terms; keep the license texts. The entries include `selectors`' generator script, not only its generated output.
- Both npm lockfiles pin registry artifacts using integrity digests. These reproduce the installed build inputs, but a transpiled/minified JS package or native binary is not automatically preferred source. The manifest separately covers every lock-classified runtime npm name/version, including conservative type-only entries. It points to full immutable upstream source trees and build scripts, or records editable source paths in a verified registry tarball. Package metadata/provenance is checked against the exact lockfile artifact, not a similarly named version or a moving default branch.
- Unmodified general-purpose build tools such as Node, npm, TypeScript, Vite, esbuild and Lightning CSS remain documented build prerequisites. Lightning CSS and its native npm artifacts are dev-only in these locks, not shipped Studio runtime components. The source index still records their locked registry artifacts for reproducible installation. Platform SDKs, WebView2 and system libraries are handled by the platform prerequisites and native-distribution review, not assumed to be covered by npm/Cargo inventories.

Two current npm publishing commits are unavailable upstream: `react-remove-scroll-bar@2.3.8` and `react-style-singleton@2.2.3`. Their manifest entries instead pin accessible predecessor source trees. Every non-package.json file in each locked tarball is byte-identical to the verified predecessor release (26 and 27 files respectively); only documented package.json metadata changed. Each entry includes per-file hashes, the exact old/new metadata changes and patch directions. Apply those changes to the pinned source tree, or use its source together with the locked current package.json. These entries do not claim that the missing publishing commits were retrieved.

These are bounded engineering checks, not a legal certification or a claim of bit-for-bit reproducibility. Review actual distribution changes, modified dependencies, unusual linking, newly embedded binaries, and any additional installation-information obligations before release.

## Public and private repositories

The workflow reads the repository's actual visibility at publication. It never changes visibility or claims that a private repository is public. Private GitHub Release recipients normally have repository read access and can use the matching source links with that same access.

Before giving binaries to anyone outside that audience, provide equivalent no-additional-charge access to the exact source and dependency directions, for example an accessible matching source mirror or source copy. An inaccessible private URL is not a source offer. Do not limit recipients' license rights to modify or redistribute by adding an NDA or other incompatible restriction. A plan to make the repository public later is not current access.

The distributor remains responsible for continued source availability even when source is hosted upstream. Preserve the exact commits and notices; do not remove needed sources while distributing the binaries. The release build checks the reviewed upstream source URLs anonymously. A missing upstream source must be restored or mirrored and the evidence updated before proceeding; a successful availability check today is not a future retention guarantee.

## Maintaining the source references

Run from the repository root:

```sh
python scripts/test-release-source.py
python scripts/release_source.py --check
```

The manifest is tied to normalized hashes of both npm locks and `Cargo.lock`. On dependency changes, review the changed runtime packages and selected Cargo copyleft packages, update their exact-version source evidence, and refresh the hashes. Do not just mark a generated registry artifact as editable source to satisfy the check. Build-only dependencies do not require hundreds of manual runtime-source entries. Source/reference changes are reviewed with the same PR as the code.

The Linux release job generates compact `SOURCE-ACCESS.json` and checks the referenced upstream locations. Publication compares that file with the checked-out commit's manifest and locks; missing or mismatched source information stops before draft creation. It then inserts the source links and actual visibility notice into the Release body.

## Optional local dependency cache archive

For environments that benefit from local Cargo/npm build inputs, create a cache archive:

```sh
python scripts/package-studio-source.py --out devcel-source.tar.gz --source-commit <full-commit>
```

This is opt-in and is not uploaded by the release workflow. It copies the repository, Cargo vendor tree and integrity-verified npm distribution tarballs. Seed an npm cache from `npm-tarballs/`, then use the archived build instructions. The preferred upstream source trees listed in `third-party/preferred-sources.json` are **not** automatically included by this helper: fetch/preserve those too when a fully offline editable-source copy is required. Do not describe this cache archive alone as complete preferred source merely because it is large.

Importer ZIPs include MIT CLI/core/runtime source in `cli-source.tar.gz`; see the [importer packaging contract](../../../../Tools~/README.md).

## References

- [GNU GPLv3, section 1 and section 6(d)](https://www.gnu.org/licenses/gpl.en.html)
- [GNU FAQ: source in version control](https://www.gnu.org/licenses/gpl-faq.en.html#SourceInCVS)
- [Mozilla MPL FAQ, Q8 and Q16](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
