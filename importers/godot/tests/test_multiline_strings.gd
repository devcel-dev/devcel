extends SceneTree
## Verify actual Rust integration-test exports with both the Godot JSON parser and the real SDK.
## godot --headless --path <SDK project> --script <this file> -- <fixtures> <runtime.gd>
## Pass the current SDK runtime.gd with load_json/load_file/table/Row.get_raw/get_string.

var checks := 0
var failures := 0

func check(value: bool, label: String) -> void:
	checks += 1
	if not value:
		failures += 1
		printerr("MULTILINE: ", label)

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 2:
		printerr("usage: -- <fixture directory> <SDK runtime.gd resource path>")
		quit(2)
		return
	var directory: String = args[0]
	var runtime = load(args[1])
	if runtime == null:
		printerr("Cannot read the SDK runtime script: ", args[1])
		quit(2)
		return
	var expectations = JSON.parse_string(FileAccess.get_file_as_string(directory.path_join("expected.json")))
	if not expectations is Dictionary or expectations.size() != 13:
		printerr("expected.json must contain 13 cases")
		quit(2)
		return
	for name in expectations:
		# Also compare against the original UTF-8 bytes that have not passed through the JSON parser.
		var bytes := FileAccess.get_file_as_bytes(directory.path_join("expected/" + name + ".txt"))
		check(bytes == String(expectations[name]).to_utf8_buffer(), "expectation bytes: " + name)
	check(expectations.lf != expectations.literal_backslash_n, "Distinguish LF from literal backslash-n")
	for filename in ["full.json", "minimal.json", "full-stream.json", "minimal-stream.json"]:
		var path := directory.path_join(filename)
		var json := FileAccess.get_file_as_string(path)
		var parser := JSON.new()
		if parser.parse(json) != OK:
			check(false, filename + ": " + parser.get_error_message())
			continue
		var bundle = parser.data
		check(bundle.tables.size() == expectations.size(), filename + ": table count")
		for table in bundle.tables:
			var expected: String = expectations[table.name]
			for record in table.records:
				for column in table.columns:
					var value = record.values.get(column.name, column.get("default_value", ""))
					check(value is String and value.to_utf8_buffer() == expected.to_utf8_buffer(), filename + ": JSON " + table.name + "/" + column.name)
		for from_json in [false, true]:
			var db = runtime.new()
			var ok = db.load_json(json) if from_json else db.load_file(path)
			check(ok, filename + ": SDK load: " + db.last_error)
			if not ok:
				continue
			check(db.tables().size() == expectations.size(), filename + ": SDK table count")
			for name in expectations:
				var table = db.table(name)
				check(table != null, filename + ": SDK table " + name)
				if table == null:
					continue
				check(table.count() == 2 and table.columns().size() == 8, filename + ": SDK shape " + name)
				var expected: String = expectations[name]
				for index in range(table.count()):
					var row = table.at(index)
					for column in table.columns():
						check(row.get_raw(column).to_utf8_buffer() == expected.to_utf8_buffer(), filename + ": SDK raw " + name + "/" + column)
						check(row.get_string(column).to_utf8_buffer() == expected.to_utf8_buffer(), filename + ": SDK string " + name + "/" + column)
	print("DEVCEL_GODOT_MULTILINE checks=%d failed=%d" % [checks, failures])
	quit(0 if failures == 0 else 1)
