extends SceneTree
## Runtime preparation and explicit sample-data validation have separate contracts.
const Model = preload("res://rpg_model.gd")
const Database = preload("res://addons/devcel/runtime/devcel_database.gd")
const Compiler = preload("res://canonical_policy.gd")
const Saves = preload("res://save_game.gd")
const Gathering = preload("res://gathering_rules.gd")
var failures: int = 0
var checks: int = 0
var temporary_paths: Array[String] = []

func check(value: bool, label: String) -> bool:
	checks += 1
	if not value:
		failures += 1
		printerr("FAIL: ", label)
	return value

func table(bundle: Dictionary, name: String) -> Dictionary:
	for item in bundle.tables:
		if item.name == name: return item
	return {}

func fixture(bundle: Dictionary, name: String) -> String:
	var path: String = "user://catalog-loading-%d-%s.json" % [OS.get_process_id(), name]
	var file = FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify(bundle))
	file.close()
	temporary_paths.append(path)
	return path

func index_value(value: Dictionary) -> Dictionary:
	var result: Dictionary = value.duplicate()
	var rows: Dictionary = {}
	for key in value.get("condition_rows", {}):
		var ids: Array = []
		for row in value.condition_rows[key]: ids.append(row.id())
		rows[key] = ids
	result["condition_rows"] = rows
	return result

func _initialize():
	var model = Model.new()
	model.set_grand_offer_seed(1234)
	model.set_gather_seed(5678)
	model.set_discovery_seed(456)
	if not check(model.load_main().ok, "normal catalog loads"):
		quit(1)
		return
	var original: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(model.main_path))
	var authored: Dictionary = model.validate_authoring_data(model.database)
	check(authored.ok, "normal catalog passes explicit authoring validation")
	var compiled: Dictionary = Compiler.new().build(model.database)
	var validated: Dictionary = Compiler.new().validate_authoring(model.database)
	check(compiled.ok and validated.ok and JSON.stringify(index_value(compiled.indexes)) == JSON.stringify(index_value(validated.indexes)), "preparation preserves every derived index")
	check(JSON.stringify(compiled.policy) == JSON.stringify(validated.policy), "preparation preserves authored policy")
	check(model.choose_purpose(str(model.progression_policy.grand_objectives[0].id)), "normal objective is playable")
	var saves = Saves.new()
	for mode in ["cycle", "disconnected", "gathering", "rarity", "discovery", "quest_count"]:
		var changed: Dictionary = original.duplicate(true)
		changed.manifest.content_hash = "catalog-loading-" + mode
		match mode:
			"cycle":
				var equipment: Dictionary = table(changed, "equipment").records[0]
				var profile: String = "catalog-loading-profile"
				table(changed, "access_profiles").records.append({"id":profile, "values":{"key":"cycle", "name":"Cycle"}})
				equipment.values.access_profile = profile
				table(changed, "access_requirements").records.append({"id":"catalog-loading-cycle", "values":{"profile":profile, "condition_kind":"owned_equipment", "equipment":equipment.id}})
			"disconnected": table(changed, "region_connections").records = []
			"gathering": table(changed, "gather_stages").records[0].values.draw_count = "0"
			"rarity": table(changed, "materials").records[0].values.rarity_ref = "missing-rarity"
			"discovery": table(changed, "regions").records[0].values.discovery_chance_percent = "101"
			"quest_count": table(changed, "quest_conditions").records[0].values.count = "0"
		var path: String = fixture(changed, mode)
		var fresh = Model.new()
		fresh.set_grand_offer_seed(1234)
		check(fresh.load_main(path).ok, mode + " is not an initial-load gate")
		var updated: Dictionary = model.load_main(path)
		if not check(updated.ok and updated.changed, mode + " is not a live-load gate"): continue
		var generation: int = model.generation
		var rng_state: int = model._grand_offer_rng.state
		var lint: Dictionary = model.validate_authoring_data(model.database)
		check(not lint.ok, mode + " remains an explicit authoring error")
		check(model.generation == generation and model._grand_offer_rng.state == rng_state, "lint cannot change live state: " + mode)
		# Prerequisite checks are nonrecursive; route search has a visited set.
		for region in model.destinations(): model.planned_route(region.id())
		for item in model.database.table("equipment").ids(): model.content_available("equipment", item)
		check(model.progression_ready(), "content lint does not disable play: " + mode)
		var payload: Dictionary = saves.snapshot(model, "")
		check(payload.version == Saves.VERSION and saves.restore(payload, path, model).ok, "Current save format survives content issues: " + mode)
		if mode == "gathering":
			var rng = RandomNumberGenerator.new()
			check(Gathering.new().draw([], 0, rng).is_empty(), "empty gathering is bounded")
		print("CATALOG_CONTENT_CASE ", mode)
	var previous = model.database
	var generation: int = model.generation
	var broken: Dictionary = original.duplicate(true)
	for index in range(broken.tables.size()):
		if broken.tables[index].name == "access_profiles":
			broken.tables.remove_at(index)
			break
	check(not model.load_main(fixture(broken, "structure")).ok, "unconstructible structure is rejected")
	check(is_same(model.database, previous) and model.generation == generation, "structural failure retains old snapshot")
	var malformed_path: String = fixture({}, "syntax")
	var malformed = FileAccess.open(malformed_path, FileAccess.WRITE)
	malformed.store_string("{")
	malformed.close()
	check(not model.load_main(malformed_path).ok and is_same(model.database, previous), "unreadable JSON is rejected atomically")
	for path in temporary_paths: DirAccess.remove_absolute(path)
	print("CATALOG_LOADING_TESTS checks=", checks, " failures=", failures)
	quit(0 if failures == 0 else 1)
