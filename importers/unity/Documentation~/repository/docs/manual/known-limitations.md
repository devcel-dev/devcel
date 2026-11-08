# Known limitations

## Editor and platform verification

Native window, input-method, clipboard, accessibility, and scrolling behavior depend on the operating system and WebView. Verify the affected platform with the built application; component tests and browser-only checks cover different boundaries. See [Studio controls](studio.md).

## HDR color preview

An accepted WebGPU HDR rendering path reports API capability. Actual HDR output and luminance also depend on the display, operating-system configuration, and compositor. Grid swatches use SDR approximations. See [colors](colors.md).

## Settings and plugins

Plugins can declare owner-scoped settings tables and contracts, including singleton and multirow data, through the plugin resource and settings APIs. These APIs enforce package ownership and declared contracts; they do not grant unrestricted access to other plugins' settings. Plugins execute inside the host with substantial authority; review the package and its requested actions before enabling it. See [plugin development](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/docs/plugin-development-guide.md).

## Import and persistence boundaries

Engine imports read saved authoring files and produce independent complete databases per source. Runtime readers load a database in full. A source's files are individually replaced atomically with ordinary-failure rollback; multi-file publication is not a power-loss transaction. See [import configuration](../../devcel-cli/docs/importer-pull.md).

## CLI interface-field required flag in v0.0.2

The released v0.0.2 CLI can encounter a parser assertion for `interface column required`. For that version, use the [direct-operation workaround](cli.md#interface-columns). The positional Boolean parsing is fixed in the current source and will require a newer release.
