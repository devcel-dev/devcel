# RGBA Color Sample

Open `Colors.devcelproj.toml` in Studio and select the table displayed as `Color Practice`.

- `srgb_byte`: Color32 RGBA. The middle red value is 128; transparent blue has alpha 0.
- `normalized`: divides components by 255. Middle-red R is approximately 0.50196.
- `linear`: converts normalized sRGB to linear; R is approximately 0.21586.
- `encoded`: converts linear back to sRGB; R is approximately 0.50196.
- `hdr`: ColorFloat RGBA, preserving negative/above-one values and RGB at alpha 0.
- `red`: accesses the component through `hdr.r`.

Float previews default to linear interpretation. `normalized`/`encoded` contain sRGB values, so choose sRGB display when comparing their appearance. Display settings leave the values unchanged. See [colors](../../docs/manual/colors.md).

