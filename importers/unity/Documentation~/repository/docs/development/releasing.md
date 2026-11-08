# CI and releases

[Documentation index](../README.md) · [Building Studio](build-studio.md)

## Pull-request builds

Pull requests targeting `main` build release-mode Studio distributions on Windows x64, Linux x64, macOS Apple Silicon with pinned toolchains. Updates, reopening, marking ready, or retargeting to `main` start a build; a newer run cancels the preceding run. Ordinary branch pushes, schedules and manual dispatch do not start this workflow. macOS uses an Apple Silicon `macos-15` runner; Intel Mac is not supported for new releases.

For a final distribution candidate, add the `release-candidate` label before pushing the candidate commit. The PR build packages unpublished desktop artifacts from the exact PR head and retains them for seven days; the mobile workflow retains matching runtime inputs. These are build inputs for local packaging and runtime acceptance, not published releases or substitutes for running the software. Adding a label alone does not start a run. No tag or release is created by the PR build.

CI and Release run production builds, catalog/SDK generation, packaging, license-text inclusion and release identity/source metadata processing. They do not run lint, type checking, regressions, UI/Rust behavior tests, test compilation or native package inspections. The release frontend hook reuses the already-built CLI to generate catalogs, synchronizes the plugin SDK and runs Vite once.

## Explicit validation

Open **Actions → Manual validation → Run workflow**, select a branch and choose a group:

| Group | Work |
| --- | --- |
| `compact` | Toolchain-pin and packaging/release-script regressions |
| `frontend` | Frontend contracts, UI regressions, type checking and production-asset checks |
| `rust` | Workspace Rust tests and bounded regression groups |
| `lint` | Rust formatting/Clippy and frontend lint |
| `importers` | Build nine importer ZIPs, extract them and exercise each bundled CLI |
| `native` | Build Studio packages and inspect native payloads/licenses, including CLI smoke tests |
| `all` | All groups above |

This separate workflow has only `workflow_dispatch`; neither CI nor Release calls it. Native inspection reports are retained for seven days. Locally, use `python scripts/manual-checks.py <group>` after installing prerequisites and npm dependencies. The importer group requires `GITHUB_REPOSITORY=OWNER/REPO` for source attribution. The existing `python scripts/ci-release.py check` full local suite remains available.

## Product version configuration

`devcel-studio/src-tauri/tauri.conf.json` → `version` is the canonical product
SemVer. Frontend host/settings identity and packaging read this setting. Cargo
package versions remain independent and are not product-version inputs.

Use `python scripts/release_version.py VERSION` to change only this field atomically,
or edit the field directly. No other tracked file stores a copy of the current
product version. Importer manifests are source templates: packaging fills their
version fields in output directories. Bundled plugin prerelease compatibility is
rendered in memory during the frontend build; source declarations are unchanged.

`third-party/generated/` and the Studio public legal copy are ignored build
outputs. Build entry points generate them from locked dependencies and retained
upstream license materials. Input and output hashes are computed automatically;
never enter hashes by hand. Missing or unverifiable license text stops generation.
Dependency pins and preferred-source records remain tracked.

Resetting the product version does not delete saved profiles or override external
plugin compatibility ranges. Version-isolated settings and plugin stores retain
their ordinary upgrade-only selection rules; a lower version uses its own store.

## Create a release

The publish job generates the matching source and rebuild directions and writes
its description to a temporary UTF-8 file on the runner. Product change descriptions
are maintained on GitHub Releases, not in workflow configuration, scripts, or
repository documentation. Pull-request history is not used to generate release
notes. The publisher can accept externally supplied product text through
`PRODUCT_RELEASE_NOTES` and its matching `PRODUCT_RELEASE_NOTES_VERSION`; partial
input, a version mismatch, NUL, or more than 64 KiB stops publication.

1. Complete the native distribution checks below for Windows, Linux and both macOS architectures using locally built packages or manual validation. Commit required upstream license materials and reviewed dependency/source manifests to the same pull request.
2. Merge the change into `main` after its pull-request build passes.
3. Open **Actions → Release (tag or manual) → Run workflow**. Select **main**, enter the desired version **without** `v` (for example `0.0.2`), and click **Run workflow**.

The manual action changes only the canonical Tauri version. It generates and
validates license/source evidence as ignored build outputs, then commits only the
canonical setting to `main` through a normal fast-forward push. If `main` moved,
branch protection rejects the push, or a check fails, it stops without creating a
tag; it never force-pushes or bypasses protection.

The release validates the exact prepared source commit and builds all three desktop targets and Android, iOS and WebGL runtimes from it. After collection succeeds, it replaces `importers/unity` with a lightweight Git UPM package in a child release commit, creates the normal version tag there, and publishes the complete native distribution as a release asset. The Git package pins the archive SHA-256 and Unity installs its native companion on request. Only `importers/unity` changes; the editable source template remains in `importers/unity-template`. Main and the new release tag are updated atomically after checking that main still equals the build source. Selecting a different version next time repeats this preparation automatically; manually synchronizing version fields is not required. A source tree with already matching versions is verified without creating an unnecessary commit.

Repository write access is required. Other branches and tags are rejected before preparation. Enter a SemVer version such as `0.0.2` or `0.0.2-rc.1`; omit the leading `v`, whitespace and build metadata. Prerelease versions create a GitHub prerelease. Existing tags are never overwritten or deleted. Manual preparation checks for an existing tag before changing source files, and atomic tag creation also rejects a concurrent creator.

Alternatively, prepare the complete Unity package child release commit locally and create and push its normal version tag. The tagged source version must match the tag. A direct tag push on an ordinary source commit is rejected because it has no installable Git package. Both entry points pin builds to the generated release commit's verified source parent; the source need not be on main. Release runs are serialized to prevent concurrent version preparation on main.

To rebuild an existing unpublished tag with the current workflow, dispatch from `main`, enable `rebuild_existing_tag`, and provide its version and full expected commit SHA in `rebuild_commit`. Do not combine this mode with publication-recovery inputs. Trusted `main` verifies the unchanged tag, exact source commit, versions, license evidence and absence of a release before building all four OS/CPU targets from that exact source commit. It does not update versions or create, move or replace tags. Builds have a 240-minute limit; tagged build scripts remain unchanged. Before enabling the build jobs, trusted main compares the tagged build helpers and frontend hooks with its own build-only recipe. Older or differing recipes are rejected before execution, including tags created before this separation. This conservative check can also reject later tags whose build helpers differ. Use artifact-only publication recovery for an eligible completed build, or release a new integrated source revision; tags are never rewritten. A completed release cannot be overwritten through this mode. If this rebuild run fails, rerun its failed jobs; the artifact-only recovery inputs support the original tag/manual release paths, not this rebuild mode.

Importer packaging on GitHub-hosted runners leaves its final temporary source directory for disposal with the runner VM. Local and self-hosted packaging still removes that directory. Source inclusion and license-text generation are identical in both cases. Native execution checks run only when explicitly requested.

No personal access token or additional secret is needed. Source preparation and final publication use the built-in `GITHUB_TOKEN`. The earlier `create_tag` job now only checks that the new tag is absent; publication creates it after all builds and assembly. [Events created with this token do not start another push workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), so a manual release builds each platform once.

All three desktop native build jobs and the Android, iOS and WebGL runtime jobs must pass before publication. Desktop jobs build Studio packages and all nine importer packages with native bundled CLI binaries. The Android artifact contains ARM64, ARMv7, x86 and x86-64 runtimes; the iOS artifact contains device and Simulator libraries; the WebGL artifact contains a WebAssembly library. Publication verifies their provenance and adds them to the downloadable native archive and each offline Unity UPM tarball. The Linux job generates a compact `SOURCE-ACCESS.json` with immutable commit/source links, exact registry artifacts and reviewed preferred dependency-source locations, and checks the upstream source URLs. See [Source delivery](source-delivery.md). The publication job verifies the complete asset set, creates SHA-256 checksums and the immutable release commit/tag, creates a draft, uploads the assets, and publishes it after every upload succeeds. Existing generated tags must retain their exact build-source parent; no existing tag is moved. The Unity URL is `https://github.com/<release-repository>.git?path=/importers/unity#v<version>`. See [Git UPM generation](../../../../Tools~/README.md#git-upm-release-generation) for collision handling, size bounds and local preparation. Validation and build jobs have read-only repository permissions; only dispatch-only source preparation, tag creation and publication receive `contents: write`.

Published assets include:

- `devcel-studio-<version>-windows-x64.zip`: Windows x64 portable ZIP containing the directly runnable Studio EXE and license files
- `devcel-studio-<version>-linux-x64.deb`: Linux deb package for Ubuntu 24.04 x64 and Debian 13 x64
- `devcel-studio-<version>-macos-arm64.dmg`: ad-hoc-signed macOS app bundles; not Apple-notarized
- Windows, Linux and macOS packages for Unity, Godot, Unreal Engine, RPG Maker, WOLF RPG Editor, GameMaker, Defold, Cocos Creator and JavaScript
- `org.devcel.unity-<version>-git.zip` and `-git.json`: complete native distribution and its measured size/provenance report; the Git SDK pins and downloads this archive. OS-specific `.tgz` files remain offline alternatives.
- `SOURCE-ACCESS.json` and `SHA256SUMS.txt`; matching commit source downloads, rebuild instructions and dependency-source directions are linked prominently in the Release body

Studio filenames must match the exact release version and platform. The Linux publication copy is renamed without changing the native deb filename, package metadata or binary bytes. All four Studio assets are included in `SHA256SUMS.txt`.

Publication validates that source index against the exact built revision and reads actual repository visibility. A private release never claims public source access; every binary recipient must have equivalent source access, including when redistributing outside GitHub. The workflow does not change repository visibility. A combined dependency cache archive is available as an [optional local helper](source-delivery.md#optional-local-dependency-cache-archive); it is not a required Release attachment. Importer packages include their matching CLI source archives.

If preparation pushed its source commit but stopped before tag creation, start a new manual run from the current `main` with the same version; already matching source versions are verified without another commit. Do not rerun a preparation job pinned to an older `main` SHA.

If a build fails before final tag creation, open that same Actions run and choose **Re-run failed jobs**. This reuses successful validation/preflight jobs and their original source commit; do not start another manual run or choose **Re-run all jobs**, which may rerun source preparation from a stale main commit. A rerun after tag creation reconstructs the same release commit and may reuse only that exact existing tag without pushing it again. If an upload fails, the release remains a draft. Inspect and remove that incomplete draft before choosing **Re-run failed jobs**; the workflow does not overwrite an existing release. A failed API request with an uncertain tag-creation outcome requires inspection before retrying. Builds use the checked-in toolchains and lockfiles. Installation and application behavior still require testing on the destination OS.

## Release from a branch

New source-only tag pushes are rejected. Existing legacy source-only tags cannot become Git-installable through recovery; rebuilding an old tag is also subject to the trusted-recipe check above. For a new Git-installable branch release, fix the Tauri version and source commit, build the three desktop and three mobile artifacts from that commit, and use the [local Git package preparation](../../../../Tools~/README.md#local-preparation-and-publication-permissions) to create the child release commit before publishing its normal `vVERSION` tag. Do not tag the incomplete source and later move the tag. Prefer the manual release workflow for the complete automated sequence. Both approaches require release authorization; merging changes alone does not authorize publishing upstream.

## Recover publication from completed builds

Recovery requires an existing immutable tag. A failed new manual build before tag creation should resume its original failed jobs while artifacts are retained. For a generated release tag, recovery pins the tag identity and validates that only `importers/unity` was changed to the recorded build-source parent. Before publication, recovery and existing-tag rebuilds also compare the complete regenerated `importers/unity` tree with that immutable tag. A byte/path mismatch stops publication: reuse the original artifacts or publish a new version, never move the tag.

Use the release workflow on the current default branch with the existing release
version, `recovery_run_id`, and its exact latest `recovery_attempt` to publish
already-built artifacts. Leave both recovery inputs empty for a normal release.
Recovery does not prepare versions, create or replace tags, or build packages.

The selected run must belong to this repository's release workflow, originate
from a version-tag push or a default-branch manual release, and have successful
validation and all build jobs required by the original source: three desktop jobs (four for historical Intel-compatible releases) and its Android and iOS jobs, plus WebGL when that source supports it. Recovery reconstructs the original source-archive and notice layout; it does not add platforms to an old release. Recovery pins artifact IDs and digests
from that attempt and rejects missing, duplicate, expired, or changed artifacts.
A manual release's initial run commit can precede its version-preparation commit;
the built source is checked independently against the unchanged release tag,
artifact manifests, and matching source index.

Publisher code is pinned to the default-branch dispatch commit. The built source
is checked out separately and must remain clean and match the selected tag. Its versions,
locked license evidence, package identities, and source-access information are
validated before publication. Neither artifact files nor the older source's
scripts are executed. Release serialization and draft-first publication remain
in effect. Existing draft or published releases stop recovery for inspection;
a moved tag stops creation or publication rather than replacing any ref.

## Native distribution checks

The `native` manual validation group runs `scripts/check-native-release-artifacts.py` against final packages. It extracts them, checks native payloads against the platform manifests, verifies license evidence and executes bundled CLI smoke tests. These checks are independent of automatic build and publication.

Review bundled native files and keep original notices and reviewed manifests current. See [Third-party licenses](../../third-party/README.md) and [Debian verification](linux.md#debian-13-verification). Native startup, persistence and visual acceptance remain separate platform checks.

Workflow definitions: [CI](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/.github/workflows/ci.yml), [Release](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/.github/workflows/release.yml) and [Manual validation](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/.github/workflows/manual-checks.yml).

### Windows portable package

The Windows build passes `--no-bundle` to Tauri. `scripts/package-windows-studio.py` creates `devcel-studio-<version>-windows-x64.zip` from the original EXE, generated legal files, Studio license and startup instructions. Packaging copies an explicit file list. Byte comparison and PE import/delay-import inspection run in the separate manual native validation group. Tauri statically links the VC runtime and the MSVC WebView2 loader. The WebView2 browser runtime remains a host prerequisite; see [Installation](../manual/installation.md#open-on-windows).

The portable package checker does not establish native GUI behavior. Verify extracted-ZIP startup and project save/reopen on Windows before publishing.

### macOS distribution status

The existing macOS 13.3 minimum is retained for Studio and bundled native code.
Studio and importer CLIs are native per architecture; only Unity's dylib is
Universal (x86_64 + arm64). `toolchains` installs both Darwin Rust targets.
See [macOS local builds and acceptance](build-studio.md#macos-local-build).

These builds use ad-hoc signatures, not a Developer ID certificate or Apple
notarization. No signing credentials are configured in Actions. This permits
credential-free build validation but does not establish Gatekeeper acceptance.
Before general distribution, decide on the Apple Developer team, certificate
ownership and notarization credentials, then implement signing for both Studio's
nested CLI and all importer binaries before hashes/manifests are generated.
Do not re-sign packaged binaries without regenerating their manifests and sealing
the outer app again. See [Tauri signing](https://v2.tauri.app/distribute/sign/macos/).

The macOS native license manifest remains `pending` until final DMG payloads are
extracted and reviewed on macOS; manual native validation deliberately reports
this unresolved evidence. Do not replace it with invented extraction results.
CI build success is not native startup, editor integration or distribution approval.
Recovery requires both macOS artifact sets as well as Windows/Linux; older
Windows/Linux-only runs cannot be published by this four-target collector.
