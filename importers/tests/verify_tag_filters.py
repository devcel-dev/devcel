#!/usr/bin/env python3
"""Source-contract checks. Does not compile Unity or Unreal, or establish native support."""
from pathlib import Path
root = Path(__file__).resolve().parents[2]
keys = ("row_include_tags", "row_exclude_tags", "column_include_tags", "column_exclude_tags")
def read(path): return (root / path).read_text()
unity_settings = read("importers/unity-template/Editor/DevcelImporterSettings.cs")
unity_export = read("importers/unity-template/Editor/DevcelExporter.cs")
unity_wizard = read("importers/unity-template/Editor/DevcelSetupWizard.cs")
ue = read("importers/unreal/Source/DevcelEditor/Private/DevcelImporter.cpp")
ue_ui = read("importers/unreal/Source/DevcelEditor/Private/SDevcelImporter.cpp")
for key in keys:
    assert "List<string> " + key in unity_settings
    assert 'AppendTags(text, "' + key + '", source.' + key + ')' in unity_export
    assert "new List<string>(source." + key + ")" in unity_wizard
    assert 'SetStringArrayField(TEXT("' + key + '")' in ue
    assert 'TryGetStringArrayField(TEXT("' + key + '")' in ue
    assert "Draft." + key in ue_ui and "S." + key in ue_ui
assert "RequestTagPresets" in ue and "EOperation::Tags" in ue
assert "ExecProcess" not in ue
assert "importSettingsChanges" in read("importers/unity-template/Editor/DevcelChangeWatcher.cs")
assert "Existing filters are retained" in read("importers/unity-template/Editor/DevcelTagFilters.cs")
assert "tag-presets" in read("importers/godot/addons/devcel/editor/devcel_pull_runner.gd")
print("Native importer tag-filter source contracts: PASS (not native compilation)")
