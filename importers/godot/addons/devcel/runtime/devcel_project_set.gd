extends RefCounted
## Explicit title-owned database instances. Identical table/row UUIDs in different sources stay isolated.
const Database = preload("devcel_database.gd")
var last_error := ""
var _sources: Dictionary = {}
var _namespaces: Dictionary = {}

func _namespace_key(value: String) -> String:
	return value.strip_edges().replace("::", ".").to_lower()

func add_source(source_id: String, namespace_name: String, bundle_path: String) -> bool:
	if source_id.strip_edges().is_empty() or _namespace_key(namespace_name).is_empty() or _sources.has(source_id) or _namespaces.has(_namespace_key(namespace_name)):
		last_error = "Source ID and Namespace must be nonempty and unique"
		return false
	var database = Database.new()
	if not database.load_file(bundle_path):
		last_error = database.last_error
		return false
	_sources[source_id] = database
	_namespaces[_namespace_key(namespace_name)] = source_id
	last_error = ""
	return true

func source(source_id: String):
	return _sources.get(source_id)

func by_namespace(namespace_name: String):
	return source(str(_namespaces.get(_namespace_key(namespace_name), "")))

func reload_source(source_id: String) -> Dictionary:
	var database = source(source_id)
	if database == null: return {"ok": false, "changed": false, "error": "Source ID not found"}
	return database.reload_if_changed()
