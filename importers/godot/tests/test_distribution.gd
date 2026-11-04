extends SceneTree
const Distribution = preload("res://addons/devcel/editor/devcel_distribution.gd")
var passed := 0
var failed := 0

func _initialize():
	_run.call_deferred()

func check(value: bool, label: String):
	if value: passed += 1
	else:
		failed += 1
		printerr("FAIL: " + label)

func write_config(config: Dictionary):
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://.devcel"))
	var file := FileAccess.open(Distribution.CONFIG, FileAccess.WRITE)
	file.store_string(JSON.stringify(config)); file.close()

func _run():
	var config := {"schema_version": 1, "sources": [
		{"id": "base", "namespace": "Game.Base", "project": "../authoring/base.devcelproj.toml", "runtime_out": "../samples/master.full.json", "mode": "full", "version": 1},
		{"id": "event", "namespace": "Game.Event", "project": "../authoring/event.devcelproj.toml", "runtime_out": "../samples/master.minimal.json", "mode": "minimal", "version": 1}
	]}
	write_config(config)
	var local := ConfigFile.new()
	local.set_value("pull", "sync_modes", {"base": "Off", "event": "Off"})
	local.save("res://.devcel/pull-editor.cfg")
	var checked := Distribution.read_bundles()
	check(checked.ok, "all source bundles validate")
	if not checked.ok: printerr(checked.error); quit(1); return
	check(checked.bundles.size() == 2, "all sources included")
	var manifest := Distribution.manifest(checked.bundles)
	check(JSON.parse_string(manifest).size() == 2, "complete pack verification manifest")
	for bundle in checked.bundles:
		check(bundle.sha256 == FileAccess.get_sha256(bundle.path), "exact bytes hashed " + bundle.path)
	var invalid := config.duplicate(true)
	invalid.sources[1].id = "base"
	write_config(invalid); check(not Distribution.read_bundles().ok, "duplicate source ID rejected")
	invalid = config.duplicate(true); invalid.sources[1].runtime_out = invalid.sources[0].runtime_out
	write_config(invalid); check(not Distribution.read_bundles().ok, "overlapping outputs rejected")
	invalid = config.duplicate(true); invalid.sources[0].version = 999
	write_config(invalid); check(not Distribution.read_bundles().ok, "content version mismatch rejected")
	invalid = config.duplicate(true); invalid.sources[0].runtime_out = "../.devcel/secret.json"
	write_config(invalid); check(not Distribution.read_bundles().ok, "editor-only output rejected")
	invalid = config.duplicate(true); invalid.sources[0].runtime_out = "../samples/missing.json"
	write_config(invalid); check(not Distribution.read_bundles().ok, "missing output rejected")
	invalid = config.duplicate(true); invalid.schema_version = 99
	write_config(invalid); check(not Distribution.read_bundles().ok, "unsupported config rejected")
	invalid = config.duplicate(true); invalid.schema_version = true
	write_config(invalid); check(not Distribution.read_bundles().ok, "boolean schema rejected")
	invalid = config.duplicate(true); invalid.sources[0].namespace = ""
	write_config(invalid); check(not Distribution.read_bundles().ok, "empty namespace rejected")
	invalid = config.duplicate(true); invalid.sources = []
	write_config(invalid); check(not Distribution.read_bundles().ok, "empty source list rejected")
	write_config(config)
	check(Distribution.manifest(Distribution.read_bundles().bundles) == manifest, "retry yields identical validated bytes")
	print("DEVCEL_DISTRIBUTION_TESTS passed=%d failed=%d" % [passed, failed])
	quit(0 if failed == 0 else 1)
