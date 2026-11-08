#!/bin/sh
# Launch from anywhere. Optional argument is the folder containing the .yyp file.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=${1:-"$PWD"}
case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) RID=linux-x64; HASH=sha256sum ;;
    Darwin/arm64) RID=osx-arm64; HASH=shasum ;;
    *) echo 'This OS/CPU is not supported by this release ZIP.' >&2; exit 1 ;;
esac
TOOLS="$HERE/tools"; BIN="$TOOLS/$RID/devcel"; MANIFEST="$TOOLS/manifest.json"
for path in "$HERE" "$TOOLS" "$TOOLS/$RID" "$BIN" "$MANIFEST"; do
    if [ -L "$path" ]; then echo 'Refusing a symlink in the bundled CLI paths.' >&2; exit 1; fi
done
[ -f "$BIN" ] && [ -f "$MANIFEST" ] || { echo 'Bundled CLI missing. Reinstall the matching ZIP.' >&2; exit 1; }
# Distribution manifests contain exactly one RID. Fail closed if the known manifest layout changes.
grep -q '"schema_version": 1' "$MANIFEST" || exit 1
grep -q '"path": "'"$RID"'/devcel"' "$MANIFEST" || { echo 'CLI platform mismatch.' >&2; exit 1; }
EXPECTED=$(sed -n 's/^[[:space:]]*"sha256": "\([0-9a-f]*\)"[,]\{0,1\}[[:space:]]*$/\1/p' "$MANIFEST")
[ "${#EXPECTED}" -eq 64 ] || { echo 'Invalid CLI checksum manifest.' >&2; exit 1; }
if [ "$HASH" = shasum ]; then ACTUAL=$(shasum -a 256 "$BIN"); else ACTUAL=$(sha256sum "$BIN"); fi
ACTUAL=${ACTUAL%% *}
[ "$ACTUAL" = "$EXPECTED" ] || { echo 'CLI checksum mismatch. Reinstall the ZIP.' >&2; exit 1; }
chmod u+x "$BIN"
exec "$BIN" importer-ui --engine gamemaker --root "$ROOT"
