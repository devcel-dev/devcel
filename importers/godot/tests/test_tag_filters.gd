extends SceneTree
const Wizard = preload("res://addons/devcel/editor/devcel_import_wizard.gd")
var failures := 0
func check(ok: bool, label: String):
	if not ok: failures += 1; push_error(label)
func _initialize():
	var original := {"id": "one", "project": "../One.devcelproj.toml", "namespace": "Game.One", "runtime_out": "one.json", "row_include_tags": ["Client", "MergedUnknown"], "row_exclude_tags": ["Private"], "column_include_tags": [], "column_exclude_tags": ["Server"]}
	var wizard = Wizard.new()
	root.add_child(wizard)
	wizard.setup(original, [], "one", "Off", func(value): return value, func(_sources): return "")
	for key in Wizard.TAG_KEYS:
		check(wizard.source()[key] == original[key], "roundtrip retains " + key)
	wizard._tag_presets = ["Client", "Private", "Server"]
	wizard._render_tag_filters()
	check(wizard.source().row_include_tags == ["Client", "MergedUnknown"], "unknown names survive discovery")
	wizard._tag_values.row_include_tags[1] = "Server"
	check(original.row_include_tags[1] == "MergedUnknown", "draft changes do not mutate saved source")
	check(wizard.source().row_include_tags == ["Client", "Server"], "unknown names can be repaired")
	wizard._tag_presets = []
	wizard._render_tag_filters()
	check(wizard.source().column_exclude_tags == ["Server"], "failed/empty discovery never clears exclusions")
	wizard._update_summary()
	check("column_exclude_tags" in wizard._summary.text, "review includes filters")
	wizard.free()
	print("Tag filter wizard checks: ", "PASS" if failures == 0 else "FAIL")
	quit(0 if failures == 0 else 1)
