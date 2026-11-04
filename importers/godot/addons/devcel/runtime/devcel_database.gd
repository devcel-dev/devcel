@tool
extends RefCounted
## Runtime reading Devcel schema v1 JSON using only standard Godot APIs.
## Loading swaps in a separate snapshot only after validation. Existing Table/Row handles retain the old snapshot.

const CurveReader = preload("devcel_curve.gd")
const TEXT_TYPES = ["None", "String", "Select", "DateTime", "Curve", "Reference", "TableRef"]
const INT_LIMITS = {
	"U8": ["0", "255"], "I8": ["-128", "127"],
	"U16": ["0", "65535"], "I16": ["-32768", "32767"],
	"U32": ["0", "4294967295"], "I32": ["-2147483648", "2147483647"],
	"U64": ["0", "18446744073709551615"], "I64": ["-9223372036854775808", "9223372036854775807"]
}
var last_error: String = ""
var _source_path: String = ""
# Fingerprint the actual successfully validated bytes, never the producer manifest.
# Timestamp/size alone miss same-size writes and coarse filesystem timestamps.
var _source_digest: String = ""
var _snapshot: Snapshot = null

## Stored channels are straight alpha; conversion only changes numeric scale.
## No sRGB/linear transfer, RGB clamp, or premultiplication is performed.
class Color32 extends RefCounted:
	var r: int
	var g: int
	var b: int
	var a: int
	func _init(red: int = 255, green: int = 255, blue: int = 255, alpha: int = 255):
		r = red; g = green; b = blue; a = alpha
	func to_color() -> Color:
		return Color(r / 255.0, g / 255.0, b / 255.0, a / 255.0)
	func to_array() -> PackedByteArray:
		return PackedByteArray([r, g, b, a])

class ColorFloat extends RefCounted:
	var r: float
	var g: float
	var b: float
	var a: float
	func _init(red: float = 1.0, green: float = 1.0, blue: float = 1.0, alpha: float = 1.0):
		r = red; g = green; b = blue; a = alpha
	func to_color() -> Color:
		return Color(r, g, b, a)
	func to_array() -> PackedFloat32Array:
		return PackedFloat32Array([r, g, b, a])

class Snapshot extends RefCounted:
	var manifest: Dictionary = {}
	var project_name: String = ""
	var tables: Dictionary = {}
	var table_order: Array = []
	var uuid_index: Dictionary = {}

class Table extends RefCounted:
	var _snapshot: Snapshot
	var _data: Dictionary
	func _init(snapshot: Snapshot, data: Dictionary):
		_snapshot = snapshot
		_data = data
	func name() -> String:
		return _data.name
	func uuid() -> String:
		return _data.uuid
	func count() -> int:
		return _data.record_order.size()
	func ids() -> Array:
		return _data.record_order.duplicate()
	func columns() -> Array:
		return _data.column_order.duplicate()
	func implements_interface(interface_uuid: String) -> bool:
		return interface_uuid in _data.interfaces
	func column_info(column_name: String) -> Dictionary:
		return _data.columns.get(column_name, {}).duplicate(true)
	func by_id(record_id: String) -> Row:
		if not _data.records.has(record_id):
			return null
		return Row.new(_snapshot, _data, record_id)
	func at(index: int) -> Row:
		if index < 0 or index >= count():
			return null
		return by_id(_data.record_order[index])

class Row extends RefCounted:
	var last_error: String = ""
	var _snapshot: Snapshot
	var _table: Dictionary
	var _id: String
	var _values: Dictionary
	func _init(snapshot: Snapshot, data: Dictionary, record_id: String):
		_snapshot = snapshot
		_table = data
		_id = record_id
		_values = data.records[record_id]
	func id() -> String:
		return _id
	func table_name() -> String:
		return _table.name
	func get_raw(column_name: String, fallback: String = "") -> String:
		last_error = ""
		var value = _values.raw.get(column_name)
		if value == null:
			last_error = "Column not found: " + column_name
			return fallback
		return value
	func get_string(column_name: String, fallback: String = "") -> String:
		return get_raw(column_name, fallback)
	# Accepted rows contain only declared columns. A correctly typed value
	# proves presence; failure paths retain the missing-column diagnostic.
	func get_int(column_name: String, fallback: int = 0) -> int:
		last_error = ""
		var value = _values.typed.get(column_name)
		if not value is int:
			if not _has(column_name): return fallback
			last_error = "Not an integer type or outside the signed 64-bit range: " + column_name
			return fallback
		return value
	func get_float(column_name: String, fallback: float = 0.0) -> float:
		last_error = ""
		var value = _values.typed.get(column_name)
		if not value is float and not value is int:
			if not _has(column_name): return fallback
			last_error = "Not a numeric type: " + column_name
			return fallback
		return float(value)
	func get_bool(column_name: String, fallback: bool = false) -> bool:
		last_error = ""
		var value = _values.typed.get(column_name)
		if not value is bool:
			if not _has(column_name): return fallback
			last_error = "Not a Boolean type: " + column_name
			return fallback
		return value
	func get_u64_decimal(column_name: String, fallback: String = "0") -> String:
		last_error = ""
		if not _has(column_name):
			return fallback
		if _table.columns[column_name].data_type != "U64":
			last_error = "Not a U64 type: " + column_name
			return fallback
		return _values.raw[column_name]
	func get_color32(column_name: String, fallback: Color32 = null) -> Color32:
		last_error = ""
		if not _has(column_name):
			return fallback
		if _table.columns[column_name].data_type != "Color32":
			last_error = "Not a Color32 type: " + column_name
			return fallback
		var value = _values.typed[column_name]
		return Color32.new(value[0], value[1], value[2], value[3])
	func get_color_float(column_name: String, fallback: ColorFloat = null) -> ColorFloat:
		last_error = ""
		if not _has(column_name):
			return fallback
		if _table.columns[column_name].data_type != "ColorFloat":
			last_error = "Not a ColorFloat type: " + column_name
			return fallback
		var value = _values.typed[column_name]
		return ColorFloat.new(value[0], value[1], value[2], value[3])
	func get_curve(column_name: String):
		last_error = ""
		if not _has(column_name):
			return null
		if _table.columns[column_name].data_type != "Curve":
			last_error = "Not a Curve type: " + column_name
			return null
		return _values.typed[column_name]
	func get_reference(column_name: String) -> Row:
		last_error = ""
		var column = _table.columns.get(column_name)
		if column == null:
			last_error = "Column not found: " + column_name
			return null
		if column.data_type != "Reference":
			last_error = "Not a Reference type: " + column_name
			return null
		var record_id = get_raw(column_name)
		if record_id.is_empty():
			return null
		var config = column.get("reference_config", {})
		var target_name = _snapshot.uuid_index.get(config.get("target_table_uuid", ""), "")
		if target_name.is_empty():
			last_error = "Reference target UUID is unresolved"
			return null
		var table_data = _snapshot.tables[target_name]
		if not table_data.records.has(record_id):
			last_error = "Referenced record not found; it may have been excluded by version: " + record_id
			return null
		return Row.new(_snapshot, table_data, record_id)
	func get_table_reference(column_name: String) -> Table:
		last_error = ""
		var column = _table.columns.get(column_name)
		if column == null:
			last_error = "Column not found: " + column_name
			return null
		if column.data_type != "TableRef":
			last_error = "Not a TableRef type: " + column_name
			return null
		var target_uuid = get_raw(column_name)
		if target_uuid.is_empty():
			return null
		var target_name = _snapshot.uuid_index.get(target_uuid, "")
		if target_name.is_empty():
			last_error = "No metadata for the TableRef target UUID: " + target_uuid
			return null
		var target = _snapshot.tables[target_name]
		var config = column.get("table_ref_config", {})
		var required = config.get("interface_uuid", "")
		if not required.is_empty() and required not in target.interfaces:
			last_error = "TableRef target does not implement the required interface: " + required
			return null
		return Table.new(_snapshot, target)
	func _has(column_name: String) -> bool:
		if not _table.columns.has(column_name):
			last_error = "Column not found: " + column_name
			return false
		return true

func is_loaded() -> bool:
	return _snapshot != null

func source_path() -> String:
	return _source_path

func manifest() -> Dictionary:
	return {} if _snapshot == null else _snapshot.manifest.duplicate(true)

func project_name() -> String:
	return "" if _snapshot == null else _snapshot.project_name

func tables() -> Array:
	return [] if _snapshot == null else _snapshot.table_order.duplicate()

func table(name: String) -> Table:
	if _snapshot == null or not _snapshot.tables.has(name):
		return null
	return Table.new(_snapshot, _snapshot.tables[name])

func table_by_uuid(uuid: String) -> Table:
	return null if _snapshot == null else table(_snapshot.uuid_index.get(uuid, ""))

func by_id(table_name: String, record_id: String) -> Row:
	if _snapshot == null or not _snapshot.tables.has(table_name): return null
	var data: Dictionary = _snapshot.tables[table_name]
	return Row.new(_snapshot, data, record_id) if data.records.has(record_id) else null

func load_json(text: String) -> bool:
	var candidate = _parse(text)
	if candidate == null:
		return false
	_snapshot = candidate
	_source_path = ""
	_source_digest = ""
	return true

func load_file(path: String) -> bool:
	var text = _read(path)
	if not last_error.is_empty():
		return false
	var candidate = _parse(text)
	if candidate == null:
		return false
	_snapshot = candidate
	_source_path = path
	_source_digest = text.sha256_text()
	return true

func reload_if_changed() -> Dictionary:
	if _source_path.is_empty():
		last_error = "Only data loaded from a file with load_file can be reloaded"
		return {"ok": false, "changed": false, "error": last_error}
	var text = _read(_source_path)
	if not last_error.is_empty():
		return {"ok": false, "changed": false, "error": last_error}
	var digest = text.sha256_text()
	if digest == _source_digest:
		return {"ok": true, "changed": false, "error": ""}
	var candidate = _parse(text)
	if candidate == null:
		return {"ok": false, "changed": false, "error": last_error}
	var changed = _snapshot == null or candidate.project_name != _snapshot.project_name
	for key in ["content_hash", "content_version", "schema_version", "mode"]:
		if _snapshot == null or candidate.manifest.get(key) != _snapshot.manifest.get(key):
			changed = true
	if changed:
		_snapshot = candidate
	# Keep the existing manifest-based semantic change contract, but avoid
	# repeatedly rebuilding an unchanged, successfully validated file.
	_source_digest = digest
	return {"ok": true, "changed": changed, "error": ""}

func _read(path: String) -> String:
	last_error = ""
	var file = FileAccess.open(path, FileAccess.READ)
	if file == null:
		last_error = "Cannot read file (%s): %s" % [path, error_string(FileAccess.get_open_error())]
		return ""
	var text = file.get_as_text()
	var error = file.get_error()
	if error != OK and error != ERR_FILE_EOF:
		last_error = "Failed to load: " + path
	return text

func _reject(message: String):
	last_error = message
	return null

func _parse(text: String) -> Snapshot:
	last_error = ""
	var parser = JSON.new()
	if parser.parse(text) != OK:
		return _reject("JSON line %d: %s" % [parser.get_error_line(), parser.get_error_message()])
	var bundle = parser.data
	if not bundle is Dictionary or not bundle.get("manifest") is Dictionary or not bundle.get("tables") is Array:
		return _reject("A manifest object and tables array are required")
	var metadata = bundle.manifest
	if not _whole_number(metadata.get("schema_version")) or metadata.schema_version != 1:
		return _reject("Supported schema_version is 1")
	if not metadata.get("content_hash") is String or metadata.content_hash.is_empty():
		return _reject("manifest.content_hash is required")
	if metadata.has("content_version") and metadata.content_version != null:
		if not _whole_number(metadata.content_version) or metadata.content_version < 0 or metadata.content_version > 4294967295:
			return _reject("content_version must be an integer from 0 to 4294967295")
	if not _whole_number(metadata.get("data_revision")) or metadata.data_revision < 0:
		return _reject("manifest.data_revision must be a nonnegative integer")
	if not _name(metadata.get("generated_at")):
		return _reject("manifest.generated_at is required")
	if metadata.get("mode") not in ["full", "minimal"]:
		return _reject("manifest.mode must be full or minimal")
	if not bundle.get("project_name") is String:
		return _reject("project_name must be a string")
	var snapshot = Snapshot.new()
	snapshot.manifest = metadata.duplicate(true)
	snapshot.project_name = bundle.get("project_name")
	# Each worker exclusively owns one parsed table and its decoder state.
	# Results are preallocated; no shared container is resized during execution.
	var jobs = TableBuildJobs.new(bundle.tables, _build_table)
	if OS.has_feature("nothreads") or jobs.sources.size() < 2:
		for index in range(jobs.sources.size()): jobs.run(index)
	else:
		var task = WorkerThreadPool.add_group_task(jobs.run, jobs.sources.size(), 4, false, "Build candidate tables")
		WorkerThreadPool.wait_for_group_task_completion(task)
	# All workers have joined, including on malformed input. Aggregate in source
	# order so simultaneous defects retain the serial diagnostic priority.
	for index in range(jobs.sources.size()):
		var source_table = jobs.sources[index]
		if not source_table is Dictionary or not _name(source_table.get("name")):
			return _reject("A table name is required")
		if snapshot.tables.has(source_table.name):
			return _reject("Duplicate table name: " + source_table.name)
		if not source_table.get("columns") is Array or not source_table.get("records") is Array:
			return _reject("columns and records arrays are required: " + source_table.name)
		var uuid = source_table.get("uuid")
		if not _name(uuid) or snapshot.uuid_index.has(uuid):
			return _reject("Invalid or duplicate table UUID")
		var interfaces = source_table.get("interfaces", [])
		if not interfaces is Array:
			return _reject("An interfaces array is required")
		for item in interfaces:
			if not _name(item):
				return _reject("interface UUID must be a nonempty string")
		var result = jobs.results[index]
		if not result is Dictionary: return _reject("Table worker did not complete")
		if not result.error.is_empty(): return _reject(result.error)
		var built = result.table
		snapshot.tables[built.name] = built
		snapshot.table_order.append(built.name)
		snapshot.uuid_index[built.uuid] = built.name
	return snapshot

static func _name(value) -> bool:
	return value is String and not value.is_empty()

static func _whole_number(value) -> bool:
	return (value is int or value is float) and is_finite(float(value)) and floor(float(value)) == float(value)

static func _decode(raw: String, column: Dictionary) -> Dictionary:
	var type = column.data_type
	if INT_LIMITS.has(type):
		var normalized = _canonical_integer(raw.strip_edges() if not raw.is_empty() else "0")
		if normalized.is_empty() or _compare_integer(normalized, INT_LIMITS[type][0]) < 0 or _compare_integer(normalized, INT_LIMITS[type][1]) > 0:
			return {"ok": false, "error": type + " integer is out of range: " + raw}
		var value = normalized if type == "U64" and _compare_integer(normalized, "9223372036854775807") > 0 else normalized.to_int()
		return {"ok": true, "raw": normalized, "value": value}
	if type in ["F32", "F64"]:
		var normalized = raw.strip_edges() if not raw.is_empty() else "0"
		if not normalized.is_valid_float() or not is_finite(normalized.to_float()):
			return {"ok": false, "error": type + " requires a finite number: " + raw}
		var value = normalized.to_float()
		if type == "F32":
			value = PackedFloat32Array([value])[0]
			if not is_finite(value): return {"ok": false, "error": "Outside the F32 range"}
		return {"ok": true, "raw": normalized, "value": value}
	if type == "Boolean":
		var normalized = raw.strip_edges().to_lower() if not raw.is_empty() else "false"
		if normalized not in ["true", "false"]:
			return {"ok": false, "error": "Boolean must be true or false: " + raw}
		return {"ok": true, "raw": normalized, "value": normalized == "true"}
	if type in ["Color32", "ColorFloat"]:
		return _decode_color(raw, type)
	if type == "Curve":
		var decoded = CurveReader.parse_text(raw, column.get("curve_config", {}))
		if not decoded.ok: return decoded
		return {"ok": true, "raw": raw, "value": decoded.curve}
	return {"ok": true, "raw": raw, "value": raw}

static func _type_default(type: String) -> String:
	if type == "Color32": return "[255,255,255,255]"
	if type == "ColorFloat": return "[1.0,1.0,1.0,1.0]"
	return ""

static func _decode_color(raw: String, type: String) -> Dictionary:
	var source = raw
	# Godot's JSON parser accepts non-JSON syntax and represents all numbers as
	# doubles. Match the strict numeric array grammar before decoding, including
	# the unsigned integer token requirement of the Color32 wire contract.
	var number = "(?:0|[1-9][0-9]*)" if type == "Color32" else "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?"
	var pattern = RegEx.new()
	pattern.compile("^[ \\t\\r\\n]*\\[[ \\t\\r\\n]*" + number + "(?:[ \\t\\r\\n]*,[ \\t\\r\\n]*" + number + "){3}[ \\t\\r\\n]*\\][ \\t\\r\\n]*$")
	if pattern.search(source) == null:
		return {"ok": false, "error": type + " requires a JSON array of four numbers"}
	var parser = JSON.new()
	if parser.parse(source) != OK or not parser.data is Array or parser.data.size() != 4:
		return {"ok": false, "error": type + " requires a JSON array of four numbers"}
	var channels = parser.data
	for index in range(4):
		var value = channels[index]
		if not (value is float or value is int) or not is_finite(value):
			return {"ok": false, "error": type + " components must be finite numbers"}
		if type == "Color32":
			if not _whole_number(value) or value < 0 or value > 255:
				return {"ok": false, "error": "Color32 components must be integers from 0 to 255"}
			channels[index] = int(value)
		else:
			if index == 3 and (value < 0.0 or value > 1.0):
				return {"ok": false, "error": "ColorFloat alpha must be between 0 and 1"}
			channels[index] = PackedFloat32Array([value])[0]
			if not is_finite(channels[index]):
				return {"ok": false, "error": "ColorFloat component is outside the F32 range"}
	var typed = PackedByteArray(channels) if type == "Color32" else PackedFloat32Array(channels)
	return {"ok": true, "raw": raw, "value": typed}

static func _canonical_integer(raw: String) -> String:
	if raw.is_empty(): return ""
	var negative = raw.begins_with("-")
	var digits = raw.substr(1) if negative or raw.begins_with("+") else raw
	if digits.is_empty(): return ""
	for character in digits:
		if character < "0" or character > "9": return ""
	while digits.length() > 1 and digits.begins_with("0"):
		digits = digits.substr(1)
	return ("-" if negative and digits != "0" else "") + digits

static func _compare_integer(left: String, right: String) -> int:
	var left_negative = left.begins_with("-")
	var right_negative = right.begins_with("-")
	if left_negative != right_negative: return -1 if left_negative else 1
	var a = left.substr(1) if left_negative else left
	var b = right.substr(1) if right_negative else right
	var sign = -1 if left_negative else 1
	if a.length() != b.length(): return sign * (-1 if a.length() < b.length() else 1)
	if a == b: return 0
	return sign * (-1 if a < b else 1)

static func _build_table(source_table) -> Dictionary:
	if not source_table is Dictionary or not _name(source_table.get("name")):
		return {"error": "A table name is required"}
	if not source_table.get("columns") is Array or not source_table.get("records") is Array:
		return {"error": "columns and records arrays are required: " + source_table.name}
	var uuid = source_table.get("uuid")
	if not _name(uuid):
		return {"error": "Invalid or duplicate table UUID"}
	var interfaces = source_table.get("interfaces", [])
	if not interfaces is Array:
		return {"error": "An interfaces array is required"}
	for item in interfaces:
		if not _name(item):
			return {"error": "interface UUID must be a nonempty string"}
	var built = {"name": source_table.name, "uuid": uuid, "interfaces": interfaces.duplicate(),
		"columns": {}, "column_order": [], "records": {}, "record_order": []}
	var column_plans: Array = []
	for source_column in source_table.columns:
		if not source_column is Dictionary or not _name(source_column.get("name")):
			return {"error": "A column name is required"}
		if built.columns.has(source_column.name):
			return {"error": "Duplicate column name: " + source_column.name}
		var column = source_column.duplicate(true)
		var type = column.get("data_type")
		if type not in TEXT_TYPES and not INT_LIMITS.has(type) and type not in ["F32", "F64", "Boolean", "Color32", "ColorFloat"]:
			return {"error": "Unknown data_type: " + str(type)}
		column.data_type = type
		if column.has("default_value") and column.default_value != null and not column.default_value is String:
			return {"error": "default_value must be a string"}
		if type in ["Color32", "ColorFloat"] and column.get("default_value") != null:
			var default_result = _decode_color(column.default_value, type)
			if not default_result.ok:
				return {"error": "%s/%s default: %s" % [source_table.name, column.name, default_result.error]}
		for key in ["reference_config", "table_ref_config", "curve_config"]:
			if column.has(key) and column[key] == null: column.erase(key)
			if column.has(key) and not column[key] is Dictionary:
				return {"error": key + " must be an object"}
		if column.has("reference_config") and not column.reference_config.get("target_table_uuid", "") is String:
			return {"error": "target_table_uuid must be a string"}
		if column.has("table_ref_config") and not column.table_ref_config.get("interface_uuid", "") is String:
			return {"error": "interface_uuid must be a string"}
		if column.has("curve_config"):
			var curve_config_result = CurveReader.parse_text("", column.curve_config)
			if not curve_config_result.ok:
				return {"error": curve_config_result.error}
		built.columns[column.name] = column
		built.column_order.append(column.name)
		var default_raw = column.get("default_value", _type_default(type))
		if default_raw == null: default_raw = _type_default(type)
		# Decode repeated scalar values once per column and candidate snapshot.
		# Mutable Color/Curve values are never shared through this cache.
		column_plans.append({"name": column.name, "column": column, "default": default_raw,
			"text": type in TEXT_TYPES and type != "Curve", "cache": {}})
	for source_record in source_table.records:
		if not source_record is Dictionary or not _name(source_record.get("id")):
			return {"error": "A record ID is required"}
		if built.records.has(source_record.id):
			return {"error": "Duplicate record ID: " + source_record.id}
		var values = source_record.get("values")
		if not values is Dictionary:
			return {"error": "record.values must be an object"}
		for key in values.keys():
			if not values[key] is String:
				return {"error": "Cell value must be a string: " + str(key)}
			# Unknown strings were previously ignored; do not retain them in the reused map.
			if not built.columns.has(key): values.erase(key)
		# JSON.parse owns this dictionary exclusively. Reuse its validated strings;
		# native Dictionary.duplicate seeds typed text without two scripted inserts per cell.
		var row = {"raw": values, "typed": values.duplicate()}
		for plan in column_plans:
			var column_name: String = plan.name
			var raw: String = values.get(column_name, plan.default)
			if plan.text:
				if not values.has(column_name):
					row.raw[column_name] = raw
					row.typed[column_name] = raw
				continue
			var cache: Dictionary = plan.cache
			var decoded: Dictionary
			if cache.has(raw):
				decoded = cache[raw]
			else:
				decoded = _decode(raw, plan.column)
				if not decoded.ok:
					return {"error": "%s/%s/%s: %s" % [source_table.name, source_record.id, column_name, decoded.error]}
				if cache.size() < 256 and (INT_LIMITS.has(plan.column.data_type) or plan.column.data_type in ["Boolean", "F32", "F64"]):
					cache[raw] = decoded
			row.raw[column_name] = decoded.raw
			row.typed[column_name] = decoded.value
		built.records[source_record.id] = row
		built.record_order.append(source_record.id)
	return {"table": built, "error": ""}

class TableBuildJobs extends RefCounted:
	var sources: Array
	var results: Array = []
	var build_table: Callable
	func _init(tables: Array, builder: Callable):
		sources = tables
		build_table = builder
		results.resize(sources.size())
	func run(index: int):
		results[index] = build_table.call(sources[index])
