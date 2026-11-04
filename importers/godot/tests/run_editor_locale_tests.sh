#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GODOT="${GODOT:-godot}"
python3 "$ROOT/tests/test_editor_locale_static.py"
mkdir -p "$ROOT/test-output"
WORK="$(mktemp -d "$ROOT/test-output/editor-locale.XXXXXX")"
cp -a "$ROOT/addons" "$WORK/"
mkdir -p "$WORK/addons/localization_checks" "$WORK/cache" "$WORK/data" "$WORK/config"
cp "$ROOT/tests/test_editor_locale.gd" "$WORK/addons/localization_checks/plugin.gd"
cat > "$WORK/addons/localization_checks/plugin.cfg" <<'CONFIG'
[plugin]
name="Importer localization checks"
description="Headless editor locale regression tests"
author="Devcel"
version="1.0"
script="plugin.gd"
CONFIG
cat > "$WORK/project.godot" <<'PROJECT'
config_version=5
[application]
config/name="Importer Localization Tests"
[editor_plugins]
enabled=PackedStringArray("res://addons/devcel/plugin.cfg", "res://addons/localization_checks/plugin.cfg")
[rendering]
renderer/rendering_method="gl_compatibility"
PROJECT
export XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config"
for language in en ja; do
  "$GODOT" --headless --editor --language "$language" --path "$WORK" > "$WORK/$language.log" 2>&1
  cat "$WORK/$language.log"
  if grep -E 'SCRIPT ERROR:|^ERROR:|^FAIL:' "$WORK/$language.log"; then exit 1; fi
  grep -q 'EDITOR_LOCALE_TESTS checks=.* failures=0' "$WORK/$language.log"
done
echo "Editor locale checks passed: $WORK"
