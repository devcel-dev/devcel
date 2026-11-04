extends SceneTree
const Database = preload("res://addons/devcel/runtime/devcel_database.gd")
const CurveReader = preload("res://addons/devcel/runtime/devcel_curve.gd")
var passed = 0
var failed = 0
var fixture: Dictionary

class ConstructedDatabase extends Database:
	var constructor_value: String
	func _init(value: String):
		constructor_value = value

func _initialize():
	fixture = JSON.parse_string(FileAccess.get_file_as_string("res://samples/master.full.json"))
	_test_basic()
	_test_accessor_errors()
	_test_column_decode_reuse()
	_test_table_error_order()
	_test_numbers()
	_test_colors()
	_test_references()
	_test_curves()
	_test_failures_and_reload()
	print("DEVCEL_RUNTIME_TESTS passed=%d failed=%d" % [passed, failed])
	quit(0 if failed == 0 else 1)

func check(value: bool, label: String):
	if value:
		passed += 1
	else:
		failed += 1
		printerr("FAIL: " + label)

func fresh():
	var database = Database.new()
	check(database.load_json(JSON.stringify(fixture)), "fixture load: " + database.last_error)
	return database

func _test_basic():
	var db = fresh()
	var hero = db.by_id("Heroes", "hero-1")
	check(db.project_name() == "Devcel Godot Sample", "project")
	check(db.manifest().content_version == 1, "version metadata")
	check(db.table("Heroes").count() == 2, "count")
	check(db.table_by_uuid("heroes-uuid").name() == "Heroes", "uuid index")
	check(hero.get_string("name") == "勇者", "unicode")
	check(hero.get_int("hp") == 100, "integer")
	check(is_equal_approx(hero.get_float("speed"), 1.5), "float")
	check(hero.get_bool("active"), "bool")
	check(hero.get_int("wide") == 9007199254740993, "int > 2^53 exact")
	check(hero.get_u64_decimal("huge") == "18446744073709551615", "u64 exact")
	check(hero.get_int("huge", -9) == -9 and not hero.last_error.is_empty(), "u64 does not wrap")
	check(hero.get_color32("color32").to_array() == PackedByteArray([18,171,239,0]), "color32")
	check(hero.get_color_float("color_float").to_array() == PackedFloat32Array([-0.25,2.0,0.5,0.0]), "color float")
	check(db.table("missing") == null and db.by_id("Heroes", "missing") == null, "missing lookup")
	check(db.table("Heroes").at(-1) == null and db.table("Heroes").at(99) == null, "index bounds")
	check(hero.get_int("name", -7) == -7 and not hero.last_error.is_empty(), "typed mismatch")
	check(hero.get_string("missing", "fallback") == "fallback" and not hero.last_error.is_empty(), "missing column")
	var metadata = db.manifest()
	metadata.content_version = 100
	check(db.manifest().content_version == 1, "manifest defensive copy")
	var ids = db.table("Heroes").ids(); ids.clear()
	check(db.table("Heroes").count() == 2, "ids defensive copy")
	var minimal = Database.new()
	check(minimal.load_file("res://samples/master.minimal.json"), "minimal load")
	for table_name in db.tables():
		for record_id in db.table(table_name).ids():
			for column in db.table(table_name).columns():
				check(db.by_id(table_name, record_id).get_raw(column) == minimal.by_id(table_name, record_id).get_raw(column), "full minimal: " + column)
	var optional = fixture.duplicate(true)
	optional.manifest.erase("content_version")
	optional.tables[0].erase("interfaces")
	check(db.load_json(JSON.stringify(optional)), "current optional content version and empty interfaces")

func _single(type: String, value: String) -> Dictionary:
	return {"manifest": {"schema_version":1,"content_hash":"number","data_revision":1,"generated_at":"2026-10-01T00:00:00Z","mode":"full"},"project_name":"Scalar contract","tables":[{"uuid":"11111111-1111-4111-8111-111111111111","name":"T","columns":[{"name":"v","data_type":type}],"records":[{"id":"r","values":{"v":value}}]}]}

func _test_numbers():
	var db = Database.new()
	for type in Database.INT_LIMITS:
		for value in Database.INT_LIMITS[type]:
			check(db.load_json(JSON.stringify(_single(type,value))), "boundary " + type + " " + value)
	check(db.by_id("T","r").get_int("v") == 9223372036854775807, "I64 max")
	check(db.load_json(JSON.stringify(_single("I64","-9223372036854775808"))), "I64 min load")
	check(str(db.by_id("T","r").get_int("v")) == "-9223372036854775808", "I64 min exact")
	for pair in [["U8","256"],["I8","-129"],["U64","-1"],["I64","9223372036854775808"],["U64","18446744073709551616"],["I32","1.5"],["I32","garbage"],["F32","1e100"],["F64","nan"],["F64","inf"],["Boolean","1"]]:
		check(not db.load_json(JSON.stringify(_single(pair[0],pair[1]))), "reject numeric " + pair[0] + " " + pair[1])
	for pair in [["I32",""],["F64",""],["Boolean",""]]:
		check(db.load_json(JSON.stringify(_single(pair[0],pair[1]))), "empty numeric default " + pair[0])
	check(db.load_json(JSON.stringify(_single("I32","+00042"))) and db.by_id("T","r").get_int("v") == 42, "canonical number")

func _test_colors():
	var db = fresh()
	var hero = db.by_id("Heroes", "hero-1")
	var bytes = hero.get_color32("color32")
	var hdr = hero.get_color_float("color_float")
	check(bytes.to_color().is_equal_approx(Color(18 / 255.0, 171 / 255.0, 239 / 255.0, 0)), "explicit byte scale preserves transparent RGB")
	check(hdr.to_color().is_equal_approx(Color(-0.25, 2.0, 0.5, 0.0)), "explicit float conversion preserves HDR and transparent RGB")
	bytes.r = 255; hdr.g = 0
	check(hero.get_color32("color32").r == 18 and hero.get_color_float("color_float").g == 2.0, "color getters return independent values")
	check(hero.get_color32("color_float") == null and not hero.last_error.is_empty(), "Color32 rejects ColorFloat")
	check(hero.get_color_float("color32") == null and not hero.last_error.is_empty(), "ColorFloat rejects Color32")
	for type in ["Color32", "ColorFloat"]:
		var omitted = _single(type, "")
		omitted.tables[0].records[0].values.erase("v")
		check(db.load_json(JSON.stringify(omitted)), "default white " + type)
		var row = db.by_id("T", "r")
		var value = row.get_color32("v").to_color() if type == "Color32" else row.get_color_float("v").to_color()
		check(value == Color.WHITE, "white channels " + type)
	for pair in [["Color32", "[0,127,255,128]"], ["ColorFloat", "[-3.5,8.0,0.5,0.25]"]]:
		check(db.load_json(JSON.stringify(_single(pair[0], pair[1]))), "valid typed color " + pair[0])
	for pair in [["Color32", ""], ["ColorFloat", ""], ["Color", "#12abef"], ["Color32", "#12abef"], ["Color32", "[0,1,2]"], ["Color32", "[0,1,2,3,4]"], ["Color32", "[0,1,2,256]"], ["Color32", "[-1,1,2,3]"], ["Color32", "[0,1.0,2,3]"], ["Color32", "[0,1e0,2,3]"], ["Color32", "[0,true,2,3]"], ["Color32", "[0,1,2,3,]"], ["ColorFloat", "[0,1,2,-0.1]"], ["ColorFloat", "[0,1,2,1.01]"], ["ColorFloat", "[1e100,1,2,1]"], ["ColorFloat", "[NaN,1,2,1]"], ["ColorFloat", "[0,1,2,1,]"]]:
		check(not db.load_json(JSON.stringify(_single(pair[0], pair[1]))), "reject color " + pair[0] + " " + pair[1])

	for type in ["Color32", "ColorFloat"]:
		var bad_default = _single(type, "")
		bad_default.tables[0].columns[0].default_value = ""
		bad_default.tables[0].records = []
		check(not db.load_json(JSON.stringify(bad_default)), "empty table invalid color default " + type)

func _test_references():
	var db = fresh()
	var hero = db.by_id("Heroes","hero-1")
	check(hero.get_reference("item").get_string("label") == "回復薬", "reference resolve")
	check(hero.get_table_reference("drops").name() == "Items", "table reference resolve")
	var broken = fixture.duplicate(true)
	broken.tables[1].records = []
	check(db.load_json(JSON.stringify(broken)), "version-excluded target bundle load")
	var row = db.by_id("Heroes","hero-1")
	check(row.get_reference("item") == null and not row.last_error.is_empty(), "dangling reference diagnostic")
	broken = fixture.duplicate(true); broken.tables[1].interfaces = []
	check(db.load_json(JSON.stringify(broken)), "interface mismatch can be inspected")
	row = db.by_id("Heroes","hero-1")
	check(row.get_table_reference("drops") == null and not row.last_error.is_empty(), "interface mismatch rejected")

func _test_curves():
	var db = fresh()
	var curve = db.by_id("Heroes","hero-1").get_curve("growth")
	check(abs(curve.sample(0.25) - 3.125) < 1e-6, "mixed linear/constant tangent curve")
	check(curve.sample(0.75) == 5.0, "step curve")
	check(curve.sample(-1) == 0.0 and curve.sample(2) == 10.0, "curve bounds")
	var default_curve = db.by_id("Heroes","hero-1").get_curve("empty_curve")
	check(abs(default_curve.sample(0.5) - 3.0) < 1e-6, "empty/config default curve")
	for mode in ["constant","linear","auto","autoLength","free"]:
		var source = {"points":[{"x":0,"y":0,"mode":mode},{"x":1,"y":1,"mode":mode}]}
		var result = CurveReader.parse_text(JSON.stringify(source))
		check(result.ok, "curve mode " + mode)
		check(abs(result.curve.sample(0.5) - (0.0 if mode == "constant" else 0.5)) < 1e-6, "curve mode evaluation " + mode)
	var step = {"points":[{"x":0,"y":0,"mode":"constant"},{"x":0.5,"y":5,"mode":"constant"},{"x":1,"y":10,"mode":"linear"}]}
	var parsed = CurveReader.parse_text(JSON.stringify(step))
	check(parsed.curve.sample(0.5) == 5.0, "step exact middle point")
	var config = CurveReader.parse_text(JSON.stringify(step),{"start_value":2,"end_value":8})
	check(config.curve.sample(0) == 2 and config.curve.sample(1) == 8, "curve endpoints fixed")
	var pts = parsed.curve.points(); pts[0].y = 999
	check(parsed.curve.sample(0) == 0, "curve data defensive copy")
	for invalid in [{"points":[{"x":0,"y":0},{"x":1,"y":1}]},{"points":[]},{"points":[{"x":0,"y":0,"mode":"linear"},{"x":0,"y":1,"mode":"linear"}]},{"points":[{"x":0,"y":0,"mode":"BAD"},{"x":1,"y":1,"mode":"linear"}]},{"points":[{"x":0,"y":0,"mode":"free","outLen":4},{"x":1,"y":1,"mode":"linear"}]}]:
		check(not CurveReader.parse_text(JSON.stringify(invalid)).ok, "invalid curve")

func write_bundle(path: String, data):
	var file = FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify(data) if data is Dictionary else data)
	file.close()

func _test_failures_and_reload():
	var path = "res://test-output/reload.json"
	write_bundle(path, fixture)
	var db = Database.new()
	check(db.load_file(path), "file load")
	var held = db.by_id("Heroes","hero-1")
	check(not db.reload_if_changed().changed, "unchanged")
	var changed = fixture.duplicate(true)
	changed.manifest.content_hash = "changed"
	changed.tables[0].records[0].values.hp = "777"
	write_bundle(path, changed)
	check(db.reload_if_changed().changed, "reload changed")
	check(db.by_id("Heroes","hero-1").get_int("hp") == 777, "new snapshot")
	check(held.get_int("hp") == 100, "held old snapshot")
	changed.manifest.content_version = 2
	write_bundle(path, changed)
	check(db.reload_if_changed().changed and db.manifest().content_version == 2, "metadata-only version change")
	write_bundle(path, '{"manifest":')
	check(not db.reload_if_changed().ok and db.by_id("Heroes","hero-1").get_int("hp") == 777, "partial write retains old")
	check(not db.load_file("res://not-found.json") and db.source_path() == path, "failed load retains source")
	for kind in ["schema", "duplicate_table", "duplicate_column", "duplicate_record", "bad_cell", "bad_type", "bad_curve", "bad_root", "bad_table", "bad_column", "bad_record", "bad_uuid", "bad_interfaces", "bad_default", "bad_config", "bad_version", "zero_schema", "bool_schema", "bad_mode", "empty_mode", "missing_mode", "missing_project", "missing_revision", "bad_revision", "missing_generated", "empty_generated", "missing_uuid", "empty_uuid", "missing_values", "alias_str", "alias_bool"]:
		var bad = fixture.duplicate(true)
		match kind:
			"schema": bad.manifest.schema_version = 99
			"duplicate_table": bad.tables.append(bad.tables[0].duplicate(true))
			"duplicate_column": bad.tables[0].columns.append(bad.tables[0].columns[0].duplicate(true))
			"duplicate_record": bad.tables[0].records.append(bad.tables[0].records[0].duplicate(true))
			"bad_cell": bad.tables[0].records[0].values.hp = 5
			"bad_type": bad.tables[0].columns[0].data_type = "unknown"
			"bad_curve": bad.tables[0].records[0].values.growth = "{}"
			"bad_root": bad.erase("tables")
			"bad_table": bad.tables[0] = null
			"bad_column": bad.tables[0].columns[0] = null
			"bad_record": bad.tables[0].records[0] = null
			"bad_uuid": bad.tables[0].uuid = 3
			"bad_interfaces": bad.tables[0].interfaces = [3]
			"bad_default": bad.tables[0].columns[0].default_value = 3
			"bad_config": bad.tables[0].columns[0].reference_config = "invalid"
			"bad_version": bad.manifest.content_version = 1.2
			"zero_schema": bad.manifest.schema_version = 0
			"bool_schema": bad.manifest.schema_version = true
			"bad_mode": bad.manifest.mode = "invalid"
			"empty_mode": bad.manifest.mode = ""
			"missing_mode": bad.manifest.erase("mode")
			"missing_project": bad.erase("project_name")
			"missing_revision": bad.manifest.erase("data_revision")
			"bad_revision": bad.manifest.data_revision = -1
			"missing_generated": bad.manifest.erase("generated_at")
			"empty_generated": bad.manifest.generated_at = ""
			"missing_uuid": bad.tables[0].erase("uuid")
			"empty_uuid": bad.tables[0].uuid = ""
			"missing_values": bad.tables[0].records[0].erase("values")
			"alias_str": bad.tables[0].columns[0].data_type = "Str"
			"alias_bool": bad.tables[0].columns[3].data_type = "Bool"
		check(not db.load_json(JSON.stringify(bad)), "reject " + kind)
		check(db.by_id("Heroes","hero-1").get_int("hp") == 777 and db.source_path() == path, "atomic " + kind)
	write_bundle(path, fixture)
	check(db.reload_if_changed().ok and db.by_id("Heroes","hero-1").get_int("hp") == 100, "reload recovery")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	check(not db.reload_if_changed().ok and db.is_loaded(), "missing file retains data")

func _test_column_decode_reuse():
	var data: Dictionary = fixture.duplicate(true)
	var heroes: Dictionary = data.tables[0]
	heroes.records = []
	for i in range(300):
		heroes.records.append({"id": "row-" + str(i), "values": {"hp": str(i), "active": " TRUE "}})
	var db = Database.new()
	check(db.load_json(JSON.stringify(data)), "more distinct values than the decode cache limit")
	var retained = db.by_id("Heroes", "row-299")
	check(retained.get_int("hp") == 299 and retained.get_bool("active"), "cached and uncached scalar conversion")
	check(retained.get_string("name") == "名無し", "precomputed column default")
	heroes.records[0].values.ignored_extra = "unused"
	check(db.load_json(JSON.stringify(data)), "unknown strings retain prior ignore behavior")
	check(db.by_id("Heroes", "row-0").get_raw("ignored_extra", "absent") == "absent", "unknown input does not become a column")
	heroes.records[299].values.hp = "2147483648"
	check(not db.load_json(JSON.stringify(data)), "uncached out-of-range scalar still rejected")
	check(db.by_id("Heroes", "row-299").get_int("hp") == 299, "failed candidate preserves accepted snapshot")
	heroes.records[299].values.hp = "42"
	heroes.columns[1].data_type = "String"
	check(db.load_json(JSON.stringify(data)), "column plan rebuilt when schema changes")
	check(db.by_id("Heroes", "row-299").get_string("hp") == "42", "new schema uses new decoding")
	check(retained.get_int("hp") == 299, "retained row keeps original snapshot values")
	heroes.columns[1].data_type = "I32"
	heroes.records[0].values.active = "not-a-boolean"
	check(not db.load_json(JSON.stringify(data)), "cached Boolean does not mask invalid input")

func _test_table_error_order():
	var derived = ConstructedDatabase.new("caller-owned")
	check(derived.load_json(JSON.stringify(fixture)) and derived.constructor_value == "caller-owned", "table jobs do not construct caller subclasses")
	var db = fresh()
	var retained = db.by_id("Heroes", "hero-1")
	var invalid: Dictionary = _single("I32", "invalid")
	check(not db.load_json(JSON.stringify(invalid)), "single invalid table")
	var first_error: String = db.last_error
	invalid.tables.append(invalid.tables[0].duplicate(true))
	check(not db.load_json(JSON.stringify(invalid)) and db.last_error == first_error, "earlier payload error precedes later duplicate table")
	invalid.tables[0].records[0].values.v = "1"
	check(not db.load_json(JSON.stringify(invalid)) and db.last_error == "Duplicate table name: T", "duplicate table header precedes its payload error")
	invalid.tables[1].name = "Second"
	check(not db.load_json(JSON.stringify(invalid)) and db.last_error == "Invalid or duplicate table UUID", "duplicate UUID precedes later payload error")
	check(db.by_id("Heroes", "hero-1").get_int("hp") == 100, "failed multi-table candidate remains unpublished")
	check(db.load_json(JSON.stringify(fixture)), "valid reload after multi-table failures")
	check(retained.get_int("hp") == 100, "old Row survives failed and accepted table builds")

func _test_accessor_errors():
	var db = fresh()
	var row = db.by_id("Heroes", "hero-1")
	var expected: String = "Column not found: missing"
	check(row.get_raw("missing", "fallback") == "fallback" and row.last_error == expected, "raw missing-column diagnostic")
	check(row.get_int("missing", -7) == -7 and row.last_error == expected, "integer missing-column diagnostic")
	check(row.get_float("missing", -7.5) == -7.5 and row.last_error == expected, "float missing-column diagnostic")
	check(row.get_bool("missing", true) and row.last_error == expected, "Boolean missing-column diagnostic")
	check(row.get_reference("missing") == null and row.last_error == expected, "reference missing-column diagnostic")
	check(row.get_table_reference("missing") == null and row.last_error == expected, "table reference missing-column diagnostic")
	check(row.get_int("hp") == 100 and row.last_error.is_empty(), "valid getter clears previous diagnostic")
