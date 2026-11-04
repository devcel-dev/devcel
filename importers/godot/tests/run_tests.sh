#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GODOT="${GODOT:-godot}"
CLI="${1:-}"
bash "$ROOT/tests/run_editor_locale_tests.sh"
if [[ -n "$CLI" ]]; then CLI="$(realpath "$CLI")"; fi
mkdir -p "$ROOT/test-output"
# All fixture generation and bundled CLI installation stays in disposable project copies.
WORK="$(mktemp -d "$ROOT/test-output/checks.XXXXXX")"
cp -a "$ROOT/addons" "$ROOT/samples" "$ROOT/tests" "$ROOT/project.godot" "$ROOT/export_presets.cfg" "$WORK/"
mkdir -p "$WORK/test-output" "$WORK/cache" "$WORK/data" "$WORK/config"
export XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config"
run_checked() {
  local name="$1"; shift
  "$GODOT" --headless --path "$WORK" --log-file "$WORK/test-output/$name.log" "$@" 2>&1 | tee "$WORK/test-output/$name.stdout"
  if grep -E 'SCRIPT ERROR:|^ERROR:|^FAIL:' "$WORK/test-output/$name.stdout"; then
    echo "Godot reported errors in $name" >&2; return 1
  fi
}
run_checked runtime --script res://tests/test_runtime.gd
run_checked curve-vectors --script res://tests/test_curve_vectors.gd
run_checked distribution --script res://tests/test_distribution.gd
# Runtime/build checks have no authoring project and must not launch a CLI.
run_checked editor-import --editor --quit
run_checked demo --quit-after 3
grep -q DEVCEL_DEMO_OK "$WORK/test-output/demo.stdout"
run_checked export-pack --script res://addons/devcel/editor/safe_export.gd -- --preset Linux --output "$WORK/test-output/sample.pck"
grep -q DEVCEL_SAFE_EXPORT_OK "$WORK/test-output/export-pack.stdout"
run_checked packed-demo --main-pack "$WORK/test-output/sample.pck" --quit-after 3
grep -q DEVCEL_DEMO_OK "$WORK/test-output/packed-demo.stdout"
# Distribution failures never replace an already verified multi-source PCK.
pack_hash="$(sha256sum "$WORK/test-output/sample.pck" | cut -d' ' -f1)"
cp "$WORK/samples/master.full.json" "$WORK/test-output/full.backup.json"
printf '{"invalid":true}' > "$WORK/samples/master.full.json"
if "$GODOT" --headless --path "$WORK" --script res://addons/devcel/editor/safe_export.gd -- --preset Linux --output "$WORK/test-output/sample.pck" > "$WORK/test-output/rejected-pack.log" 2>&1; then
  echo "Invalid source unexpectedly packaged" >&2; exit 1
fi
[[ "$(sha256sum "$WORK/test-output/sample.pck" | cut -d' ' -f1)" == "$pack_hash" ]]
mv "$WORK/test-output/full.backup.json" "$WORK/samples/master.full.json"
touch "$WORK/test-output/cancel-pack"
if "$GODOT" --headless --path "$WORK" --script res://addons/devcel/editor/safe_export.gd -- --preset Linux --output "$WORK/test-output/sample.pck" --cancel-file "$WORK/test-output/cancel-pack" > "$WORK/test-output/cancelled-pack.log" 2>&1; then
  echo "Cancelled pack unexpectedly succeeded" >&2; exit 1
fi
[[ "$(sha256sum "$WORK/test-output/sample.pck" | cut -d' ' -f1)" == "$pack_hash" ]]
rm "$WORK/test-output/cancel-pack"
run_checked export-pack-retry --script res://addons/devcel/editor/safe_export.gd -- --preset Linux --output "$WORK/test-output/sample.pck"
grep -q DEVCEL_SAFE_EXPORT_OK "$WORK/test-output/export-pack-retry.stdout"
if [[ -n "$CLI" ]]; then
  python3 "$WORK/tests/prepare_bundled_cli.py" "$CLI" "$WORK"
  python3 "$WORK/tests/create_cli_fixture.py" "$CLI" | tee "$WORK/test-output/fixture.stdout"
  run_checked cli-roundtrip --script res://tests/test_cli_roundtrip.gd
fi
echo "Devcel Godot checks passed: $WORK/test-output"
