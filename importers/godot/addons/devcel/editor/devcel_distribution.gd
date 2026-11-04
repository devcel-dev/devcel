@tool
extends RefCounted
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
## Validate the same saved source list used by the editor before packaging any bytes.
const CONFIG := "res://.devcel/devcel.import.json"
const Database = preload("../runtime/devcel_database.gd")

static func read_bundles() -> Dictionary:
	var parser := JSON.new()
	if parser.parse(FileAccess.get_file_as_string(CONFIG)) != OK or not parser.data is Dictionary:
		return _failure(Locale.text("取り込み設定を読み込めません", "Cannot read import settings"))
	var config: Dictionary = parser.data
	if not (config.get("schema_version") is int or config.get("schema_version") is float) or config.schema_version != 1 or not config.get("sources") is Array or config.sources.is_empty():
		return _failure(Locale.text("取り込み設定には1件以上のsourceが必要です", "Import settings must contain at least one source"))
	for key in config:
		if key not in ["schema_version", "sources"]: return _failure(Locale.text("未知の取り込み設定項目: ", "Unknown import setting: ") + str(key))
	var bundles: Array = []
	var ids: Dictionary = {}
	var paths: Dictionary = {}
	for source in config.sources:
		if not source is Dictionary or not source.get("id") is String or source.id.is_empty() or ids.has(source.id):
			return _failure(Locale.text("source IDが不正または重複しています", "Source ID is invalid or duplicated"))
		ids[source.id] = true
		for key in source:
			if key not in ["id", "project", "namespace", "runtime_out", "code_out", "code_target", "class_name", "mode", "version"]:
				return _failure(Locale.text("未知のsource設定項目: ", "Unknown source setting: ") + str(key))
		for key in ["project", "namespace"]:
			if not source.get(key) is String or source[key].strip_edges().is_empty(): return _failure(key + Locale.text("は空でない文字列で指定してください", " must be a nonempty string"))
		if source.has("mode") and source.mode not in ["full", "minimal"]: return _failure(Locale.text("modeはfull/minimalのみです", "mode must be full or minimal"))
		var version = source.get("version")
		if version != null and (not (version is int or version is float) or not is_finite(float(version)) or version < 0 or version > 4294967295 or float(version) != floor(float(version))):
			return _failure(Locale.text("Content Versionはnullまたは0..4294967295の整数です", "Content Version must be null or an integer from 0 to 4294967295"))
		if not source.get("runtime_out") is String or source.runtime_out.is_empty():
			return _failure(Locale.text("runtime JSONの出力先が必要です: ", "Runtime JSON output is required: ") + source.id)
		var output: String = source.runtime_out
		if not output.is_absolute_path(): output = ProjectSettings.globalize_path("res://.devcel").path_join(output).simplify_path()
		var path := ProjectSettings.localize_path(output)
		if not path.begins_with("res://") or not path.ends_with(".json") or path.begins_with("res://addons/devcel/"):
			return _failure(Locale.text("配布JSONはゲームのres://内、addonの外に配置してください: ", "Place distribution JSON inside the game's res://, outside the addon: ") + source.id)
		for part in path.trim_prefix("res://").split("/"):
			if part.begins_with(".") or part.to_lower() == "editor": return _failure(Locale.text("配布JSONは隠し・Editor専用フォルダへ配置できません", "Distribution JSON cannot be placed in hidden or editor-only folders"))
		if paths.has(path): return _failure(Locale.text("runtime JSONの出力先が重複しています", "Runtime JSON output paths are duplicated"))
		paths[path] = true
		var file := FileAccess.open(path, FileAccess.READ)
		if file == null: return _failure(Locale.text("配布JSONを読めません: ", "Cannot read distribution JSON: ") + path)
		var bytes := file.get_buffer(file.get_length())
		var error := file.get_error()
		file.close()
		if error != OK: return _failure(Locale.text("配布JSONの読み取りに失敗しました", "Failed to read distribution JSON"))
		var database = Database.new()
		if not database.load_json(bytes.get_string_from_utf8()): return _failure(database.last_error)
		if database.manifest().get("mode") != source.get("mode", "full") or database.manifest().get("content_version") != source.get("version"):
			return _failure(Locale.text("取り込み設定とruntime JSONが異なります。取り込みを実行してください", "Import settings and runtime JSON do not match. Run an import"))
		var hash := HashingContext.new()
		hash.start(HashingContext.HASH_SHA256)
		hash.update(bytes)
		bundles.append({"path": path, "sha256": hash.finish().hex_encode(), "bytes": bytes})
	return {"ok": true, "error": "", "bundles": bundles}

static func manifest(bundles: Array) -> String:
	var entries: Array = []
	for bundle in bundles: entries.append({"path": bundle.path, "sha256": bundle.sha256})
	return JSON.stringify(entries)

static func _failure(message: String) -> Dictionary:
	return {"ok": false, "error": message}
