# Devcel brand assets

This directory contains the symbol, wordmark, combined logos, application icons, and favicons.

| Directory | Contents |
|---|---|
| `svg/` | Vector logos |
| `png/` | Raster logos |
| `icons/` | Application icons and favicons |

## Logos

Filenames identify the composition: `symbol` is the symbol alone, `wordmark` is the text alone, `lockup-horizontal` is the horizontal combination, and `lockup-stacked` is the stacked combination.

`white` has a light background; `black` has a dark background. `transparent` and `symbol-master` are transparent variants for light backgrounds. `inverse` is transparent for dark backgrounds. `wordmark-mono` is a single-color transparent variant.

Use SVG for vectors or PNG for raster images. Preserve the original aspect ratio.

## Icons

`devcel-app-icon-light` and `devcel-app-icon-dark` each have an SVG and a 1024 × 1024 PNG.

Favicon PNGs are square at 16, 32, 64, 128, 180, 256, and 512 pixels. `favicon.ico` includes 16, 32, and 64-pixel images. Use `devcel-favicon-small.svg` for SVG display at 64 pixels or smaller.

## Updating application copies

Studio uses distribution copies in `devcel-studio/public/brand/` and `devcel-studio/public/devcel.png`. Keep matching source and application assets synchronized. Preserve their colors, shapes, and aspect ratios.

To regenerate desktop application icons, run the locked Tauri CLI from `devcel-studio` after installing the repository's dependencies. Replace the output path with a writable temporary directory:

```sh
npx tauri icon ../assets/brand/icons/devcel-app-icon-dark.png --output /tmp/devcel-icons
```

Copy the generated top-level PNG, ICO, and ICNS files into `src-tauri/icons/`. The desktop application does not use the generated Android/iOS directories.

From `devcel-studio`, check asset copies, icon formats, and frontend references:

```sh
npm run check:brand-assets
```

Installed-app icon caches may update slowly. Check the final application icons on each target operating system.
