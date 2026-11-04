# Typed color and DateTime accessors

## RGBA contract

`Color32` and `ColorFloat` are distinct first-class data types. The bundle schema version and native runtime API version are both 1.

- Color32 is four `u8` components in RGBA order, each 0–255, for example `[18,171,239,0]`.
- ColorFloat is four finite `f32` components in RGBA order. RGB preserves negative and HDR values; alpha is 0–1, for example `[-0.25,4,0.5,0]`.
- Straight alpha preserves RGB at alpha zero. There is no automatic premultiplication, clamping, or sRGB/linear conversion.
- Defaults are opaque white: `[255,255,255,255]` and `[1.0,1.0,1.0,1.0]`.
- Precision and encoding are distinct. Display defaults are sRGB for Color32 and linear for ColorFloat, without changing saved/exported/runtime numbers or adding an encoding tag.
- Under the existing string-valued cell contract, JSON/MessagePack stores a canonical RGBA-array string. Schema `data_type` distinguishes the precision types. Full and Minimal preserve the same effective values.
- Fractional byte values, incorrect component counts, nonfinite/out-of-range floats, out-of-range alpha, nonarray strings, and explicit empty strings fail on load.

## Generated APIs and C ABI

A Color32 `tint` column generates `DevcelColor32 row.Tint` in C# and `DevcelColor32 row.tint()` in C++17/20. A ColorFloat `light` column generates `DevcelColorFloat row.Light` and `DevcelColorFloat row.light()`. Generated interfaces return the same dedicated types.

| API | Contract |
|---|---|
| C# | Readonly sequential-layout `R/G/B/A` fields, using `byte` or `float` |
| C++ | `r/g/b/a` fields, using `uint8_t` or `float` |
| Rust | `Color32`, `ColorFloat`, `ColumnSnapshot::color32_at`, and `color_float_at`; mismatched types or missing rows return `None` |
| C ABI | `devcel-runtime/include/devcel_runtime.h`; `devcel_rt_api_version()` returns 1 |

`devcel_rt_get_color32` and `devcel_rt_get_color_float` copy into a caller-owned output structure. They require a live database handle and a valid writable output structure. They return 1 on success, or 0 for null database/output pointers, invalid indices, or mismatched types without changing the output. Nonnull dangling or otherwise invalid pointers are outside the C ABI contract. ABI sizes are 4 bytes and 16 bytes. The copied values remain valid after reload; row wrappers retain their stale/closed checks. Generated SDKs verify the ABI before opening a database. Getters do not implicitly convert String values or color precision types.

For a DateTime column `when`:

- C#: `row.When` is `string`; `row.WhenRfc3339` is `System.DateTimeOffset?`.
- C++17/20: `row.when()` is `std::string_view`; `row.when_rfc3339()` is `std::optional<DevcelDateTimeOffset>`.
- The C++ value contains `unix_seconds` (floor seconds since 1970-01-01 UTC), `fraction_ticks` (0–9,999,999 at 100 ns per tick), and the original `offset_minutes`.
- Saved DateTime values remain arbitrary strings. Only the helper API applies the RFC3339 subset below.

Generated interfaces and C++20 concepts support these helpers. A helper-name collision with a raw column name is a generation error.

## Accepted datetime subset

Use `YYYY-MM-DD[Tt]hh:mm:ss`, optionally followed by 1–7 fractional digits, then mandatory `Z`, `z`, `+HH:MM`, or `-HH:MM`.

- Valid Gregorian dates, years 0001–9999, hours 00–23, minutes/seconds 00–59.
- Offsets up to ±14:00; a 14-hour offset requires zero minutes.
- `-00:00` means unknown offset and is rejected. Known UTC is `Z`, `z`, or `+00:00`.
- Both the input datetime and UTC-converted datetime must fit years 0001–9999.
- More than seven fractional digits are rejected, never rounded or truncated.
- Leap seconds, missing offsets, date-only values, whitespace, and locale-dependent forms are not converted.
- Behavior does not depend on the OS timezone or current culture.

`2000-02-29T23:59:59.1234567+09:30` succeeds. `1900-02-29T00:00:00Z`, `2026-10-01T12:00:00`, and `2026-10-01T12:00:00-00:00` return null/nullopt.

For arbitrary strings use C# `DevcelScalarParsers.TryParseRfc3339` or C++ `DevcelScalarParsers::try_parse_rfc3339`. Failure returns false/nullopt.

