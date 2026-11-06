# Android and iOS Players

Install the complete package using the [Git URL instructions](../README.md#package-installation). One release tag includes all desktop Editor CLIs/runtimes and both mobile targets below. Older desktop ZIPs and desktop-only tarballs lack mobile libraries and fail the mobile build check.

Release v0.0.2 includes the Git-installable package and Windows, Linux and macOS importer distributions. The older v0.0.1 release contains Windows/Linux importer ZIPs only.

| Player target | Bundled library | Required settings |
|---|---|---|
| Android ARMv7, ARM64, x86 and x86_64 | `Plugins/Android/<abi>/libdevcel_runtime.so` | Select the desired bundled ABIs, minimum API 23 or later |
| iOS ARM64 device | `Plugins/iOS/libdevcel_runtime.a` | Device SDK, minimum iOS 13.0 or later |

iOS Simulator and WebGL are not included. Android x86 (32-bit) requires a Unity version that supports that architecture. Existing v0.0.2 distributions only contain Android ARM64; the additional Android ABIs require a later release. Native binary/header checks and successful CI compilation are not device execution acceptance.

## Import in the Editor

Install Unity's Android or iOS Build Support module for your Unity version. Android building also requires the matching Unity SDK/NDK/JDK installation. iOS device linking, signing and deployment require a supported macOS/Xcode installation and your Apple signing configuration.

Run **Devcel > Importer** in the desktop Editor to generate the C# accessors and JSON bundle. Regenerate C# when upgrading from a desktop-only SDK: the generated P/Invokes must select `__Internal` for `UNITY_IOS && !UNITY_EDITOR`. Keep all generated C# under Assets. The CLI, watchers, authoring project and source archives are not part of the Player; mobile code only reads the exported bundle.

Do not copy an Android/iOS library into the Editor's desktop plugin directory. The package supplies platform-specific PluginImporter metadata and verifies it before building. Restart the Editor after replacing a native package.

## Read the bundle on a phone

On Android, StreamingAssets is commonly inside an APK and cannot be opened as a filesystem path by the native runtime. Load its text through the managed helper, then create the generated database:

```csharp
yield return DevcelBundle.LoadText("Devcel/Master/master.json", json => {
    if (json == null) throw new System.IO.IOException("Devcel bundle unavailable");
    database = Game.Master.DevcelDatabase.FromJson(json);
});
```

Replace the namespace/root class with your generated names and retain/dispose the database through your application's lifecycle. This also works on iOS. For downloaded updates, load the JSON into the database explicitly or store it in `Application.persistentDataPath` before using file-backed APIs. StreamingAssets is read-only in the installed app. Editor file watching and Play-mode automatic reload do not run on phones.

## Build the Player

For Android, select **ARMv7**, **ARM64** **x86** (where supported), and/or **x86_64**, minimum API 23+, and use IL2CPP for a release build. The runtime is built with Android NDK 28.2.13676358 and 16 KB-compatible load segment alignment. The final APK/AAB also depends on Unity and every other plugin meeting current Android packaging/page-size requirements; inspect and test the final app on the intended devices.

For iOS, choose **Device SDK** and minimum iOS 13.0+. Export the Xcode project on macOS. The static library is linked into UnityFramework; `DevcelIosLinker` adds the system libraries reported by the matching Rust build. Set your signing team, build/archive and deploy through Xcode. Simulator libraries are intentionally absent. No CLI or dynamically loaded macOS dylib is used inside the iOS app.

The build gate rejects missing libraries, altered runtime hashes, incorrect platform metadata, wrong binary architecture and unsupported target settings. A failed build gate must be fixed by installing the correct complete package or changing the target settings; do not edit fingerprint/hash fields to bypass it.

## Build distributable mobile libraries

Use the repository's pinned Rust toolchain from a clean recorded commit. For Android, install NDK 28.2.13676358 and `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`; for iOS on macOS/Xcode, install `rustup target add aarch64-apple-ios`.

```sh
python scripts/unity_mobile.py --system android --ndk /path/to/ndk/28.2.13676358 --out mobile/android --source-repository devcel-dev/devcel --source-commit <full-sha>
python scripts/unity_mobile.py --system ios --out mobile/ios --source-repository devcel-dev/devcel --source-commit <full-sha>
python scripts/unity_upm.py dist/devcel-unity-<version>-<editor-rid>.zip --out dist/upm --version <version> --platform <editor-rid> --mobile-android mobile/android/unity-mobile-android.zip --mobile-ios mobile/ios/unity-mobile-ios.zip
```

The mobile ZIPs are internal build inputs, not installable packages. Publication verifies that their version, repository, commit and native source fingerprint match the desktop package, validates binary formats and hashes, and adds them to the common Git package and each OS-specific release tarball. The source desktop CLI archive contains the same runtime source and pinned Rust dependency sources. Android NDK original notices are also bundled. The native mobile manifest records target toolchains, minimum OS/API and iOS link libraries. Recovering a release requires both mobile job artifacts as well as all four desktop build artifacts.

## Acceptance on actual devices

Install the Git package in a clean project, import a small source, and build/install each target Player. Confirm bundle loading, scalar/string/reference reads and disposal. Test a missing bundle and a data update. Inspect the APK/AAB or Xcode product to confirm the correct runtime is present and CLI/authoring files are absent. Test the final Android app on a 16 KB page-size environment and verify iOS linking/signing on a device.

Automated archive and C# header-validator tests use synthetic files. They cannot establish Unity import behavior, IL2CPP marshalling, Xcode linkage, signing, device ABI correctness or runtime loading. Complete those device checks before treating a mobile release as production-ready.
