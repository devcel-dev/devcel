# In-app updates

## Standard-build behavior

Help → App updates opens a dedicated `WebviewWindow` from both the welcome screen and an open project.

Standard builds have no distribution endpoint or signing-verification public key, set `plugins.updater.active` to false and `bundle.createUpdaterArtifacts` to false. The window shows the current version/platform and why updating is disabled. Missing/invalid configuration or unsupported OS/CPU does not start the updater plugin, check or download. Normal project editing remains available.

Production update hosting, signed releases and actual installation on supported platforms require separate deployment and verification. Do not create/store private signing keys in application preferences or bypass signature verification; unsigned installation is not supported.

## Workflow

1. Check the configured HTTPS endpoint with a 15-second timeout, distinguishing no update from network failure.
2. Display version, release date and notes as plain text, never executable HTML.
3. Download the selected version with a 120-second timeout. Display received bytes; show a percentage only when total size is known.
4. A `Finished` event does not establish signature success. Enable installation only after Tauri's `Update.download()` succeeds.
5. Before installation, confirm saving work, closing other processes and the inability to cancel after installation starts. Cancelling confirmation retains the downloaded candidate.
6. Windows exits as the Tauri installer launches. If installation returns on macOS/Linux, offer restart now/later; later requires saving and restarting manually.

Prevent repeated check/download/install/restart submissions. Keep the same `Update` resource throughout; do not silently fetch another version just before installation.

### Cancellation and errors

The current API cannot abort in-flight communication. Cancel during check/download marks the result for disposal and waits for completion/timeout; it cannot lead to automatic installation. While waiting, block new operations and window close. There is no cancellation after installation begins.

Skipping disposes of the candidate/download. Signature/download errors permit retrying that candidate. After installation failure, native bytes may have been consumed: dispose of the resource and check again rather than asserting success. Restart failure retains the installed state and offers retry/manual restart. Release candidates on window disposal; the application cannot prevent force termination or OS shutdown.

## Startup preference

Opening the update window and checking at startup defaults off. When enabled, it works only with valid build configuration on a supported platform and never automatically installs. Store only this local UI preference. An unconfigured build cannot enable it; a previously enabled preference can be disabled after configuration becomes unavailable. When off, do not even call the startup configuration query.

## Configure an update-enabled build

Use build-time Tauri overrides; there is no end-user private-key form.

- `plugins.updater.active: true` is Devcel's own activation flag, not a standard Tauri v2 field.
- `plugins.updater.endpoints` contains HTTPS URLs without credentials or fragments.
- `plugins.updater.pubkey` contains the base64-encoded Tauri/minisign public-key file contents.
- Producing an update requires `bundle.createUpdaterArtifacts: true` and signing in the controlled build process.

Never put private keys/passwords in the repository, preferences or manifest. Rust checks public-key encoding/minisign structure; actual artifact/key matching is verified by Tauri at download. A structurally valid key can still reject an artifact signed by another key.

Reject `dangerousInsecureTransportProtocol`, weakened TLS validation and `allowDowngrades`. Candidate URLs also require HTTPS without credentials/fragments. Validate both standard OS/CPU candidates and preferred bundle-qualified candidates such as `linux-x86_64-appimage`. Tauri owns transport/signature verification and installation; do not add an independent binary-download/install path.

Provide supported Windows/macOS/Linux distribution formats, not arbitrary development executables or ZIPs. Verify signatures, permissions, upgrade from a prior release and post-restart version on actual target OS/CPU/installer combinations. Check Tauri/CLI/signature-format compatibility and pin versions as needed. See [Tauri updater documentation](https://v2.tauri.app/plugin/updater/).

