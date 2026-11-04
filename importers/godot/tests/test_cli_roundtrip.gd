extends SceneTree
const Database = preload("res://addons/devcel/runtime/devcel_database.gd")
const PullRunner = preload("res://addons/devcel/editor/devcel_pull_runner.gd")
var passed = 0
var failed = 0
var meta: Dictionary

func _initialize():
	_run.call_deferred()

func check(value: bool, label: String):
	if value: passed += 1
	else:
		failed += 1; printerr("FAIL: " + label)

func _wait(runner):
	var deadline = Time.get_ticks_msec() + 10000
	while runner.running() and Time.get_ticks_msec() < deadline:
		var result = runner.poll()
		if result.get("done", false): return result
		await create_timer(0.01).timeout
	return {"ok": false, "error": "test deadline"}

func _run():
	if not FileAccess.file_exists("res://test-output/cli-current.json"):
		printerr("Run create_cli_fixture.py first"); quit(1); return
	meta = JSON.parse_string(FileAccess.get_file_as_string("res://test-output/cli-current.json"))
	var full = Database.new(); var minimal = Database.new(); var v3 = Database.new(); var all = Database.new()
	check(full.load_file(meta.directory.path_join("full-v1.json")), "real full: " + full.last_error)
	check(minimal.load_file(meta.directory.path_join("minimal-v1.json")), "real minimal: " + minimal.last_error)
	check(v3.load_file(meta.directory.path_join("full-v3.json")), "real v3: " + v3.last_error)
	check(all.load_file(meta.directory.path_join("all.json")), "real all: " + all.last_error)
	if not full.is_loaded() or not minimal.is_loaded() or not v3.is_loaded():
		quit(1); return
	check(full.table("Heroes").count() == 1 and v3.table("Heroes").count() == 2, "real version filter")
	check(all.table("Heroes").count() == 2, "real all records")
	check(full.by_id("Heroes",meta.hero3) == null and v3.by_id("Heroes",meta.hero3) != null, "version exact IDs")
	check(full.table_by_uuid(meta.heroes_uuid).name() == "Heroes", "export table UUID")
	check(full.table_by_uuid(meta.items_uuid).implements_interface(meta.interface_uuid), "export ancestor interface")
	check(full.table_by_uuid(meta.items_uuid).implements_interface(meta.direct_interface_uuid), "export direct interface")
	for table_name in full.tables():
		for id in full.table(table_name).ids():
			for col in full.table(table_name).columns():
				check(full.by_id(table_name,id).get_raw(col) == minimal.by_id(table_name,id).get_raw(col), "real full/minimal " + table_name + "/" + col)
	var hero = minimal.by_id("Heroes",meta.hero1)
	check(hero.get_string("name") == "実CLIの勇者", "real Unicode")
	check(hero.get_int("hp") == 100 and hero.get_bool("active"), "real defaults")
	check(hero.get_int("computed") == 3, "real formula evaluated")
	check(hero.get_int("wide") == 9007199254740993, "real I64 exact")
	check(hero.get_u64_decimal("huge") == "18446744073709551615", "real U64 exact")
	check(hero.get_color32("color32").to_array() == PackedByteArray([18,171,239,0]), "real Color32 exact transparent RGB")
	check(hero.get_color_float("color_float").to_array() == PackedFloat32Array([-0.25,2.0,0.5,0.0]), "real ColorFloat HDR/negative/straight alpha")
	check(hero.get_color_float("color_float").to_color() == Color(-0.25,2.0,0.5,0.0), "real explicit color conversion")
	var item = hero.get_reference("item")
	check(item != null and item.get_string("label") == "回復薬", "real Reference metadata")
	var drops = hero.get_table_reference("drops")
	check(drops != null and drops.uuid() == meta.items_uuid, "real TableRef/interface metadata")
	var curve = hero.get_curve("growth")
	check(curve != null and curve.sample(0) == 2 and curve.sample(1) == 8 and curve.sample(0.75) == 6, "real Curve config/default")
	var output_path := "res://test-output/real-editor-export.json"
	var config_path := "res://test-output/devcel.import.json"
	var config = {"schema_version": 1, "sources": [{"id": "base", "namespace": "Game.Master", "project": meta.project, "runtime_out": ProjectSettings.globalize_path(output_path), "version": 1, "mode": "minimal"}]}
	var config_file := FileAccess.open(config_path, FileAccess.WRITE)
	config_file.store_string(JSON.stringify(config)); config_file.close()
	var runner = PullRunner.new()
	check(runner.start(config_path), "real editor runner start " + runner.last_error)
	var result = await _wait(runner)
	check(result.ok, "real editor runner success " + str(result.get("error", "")))
	var live = Database.new()
	check(live.load_file(output_path), "real editor output load " + live.last_error)
	var held = live.by_id("Heroes",meta.hero1)
	var output: Array = []
	var exit_code = OS.execute(PullRunner.resolve_cli(), ["--mode","local","--project",meta.project,"cell","set","Heroes",meta.hero1,"hp","500"], output)
	check(exit_code == 0 and JSON.parse_string("".join(output)).get("ok") == true, "real data mutation stdout single JSON")
	check(runner.start(config_path), "real repeat export")
	result = await _wait(runner)
	check(result.ok, "real repeat export completed " + str(result.get("error", "")))
	check(live.reload_if_changed().changed, "real data reload")
	check(live.by_id("Heroes",meta.hero1).get_int("hp") == 500, "real updated value")
	check(held.get_int("hp") == 100, "real old snapshot retained")
	# Restore this fixture to its initial values so UI checks and reruns can use the same expectations.
	output.clear()
	exit_code = OS.execute(PullRunner.resolve_cli(), ["--mode","local","--project",meta.project,"cell","set","Heroes",meta.hero1,"hp","100"], output)
	check(exit_code == 0 and JSON.parse_string("".join(output)).get("ok") == true, "restore own fixture")
	print("DEVCEL_REAL_CLI_ROUNDTRIP passed=%d failed=%d command_contracts=%d" % [passed,failed,meta.command_count])
	quit(0 if failed == 0 else 1)
