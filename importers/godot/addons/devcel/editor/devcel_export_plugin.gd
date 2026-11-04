@tool
extends EditorExportPlugin
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
## Runs before GDScript's bytecode exporter, otherwise skip() comes too late.
const Distribution = preload("devcel_distribution.gd")
var _saved_settings: Dictionary = {}
var _failed = false
var _pull_bundle_paths: Array[String] = []

func _get_name() -> String:
	return "000_DevcelDistribution"

func _supports_platform(_platform) -> bool:
	return true

func _get_export_features(_platform, _debug) -> PackedStringArray:
	return PackedStringArray(["devcel_exported"])

func _export_begin(_features, _is_debug, _path, _flags):
	_failed = false
	_saved_settings.clear()
	_pull_bundle_paths.clear()
	# Keep editor-only settings out of project.binary.
	for property in ProjectSettings.get_property_list():
		var name = str(property.name)
		if name.begins_with("devcel/"):
			_saved_settings[name] = ProjectSettings.get_setting(name)
	for name in _saved_settings: ProjectSettings.set_setting(name, null)
	var plugins = "editor_plugins/enabled"
	if ProjectSettings.has_setting(plugins):
		_saved_settings[plugins] = ProjectSettings.get_setting(plugins)
		var enabled = PackedStringArray(ProjectSettings.get_setting(plugins))
		if "res://addons/devcel/plugin.cfg" in enabled: enabled.remove_at(enabled.find("res://addons/devcel/plugin.cfg"))
		ProjectSettings.set_setting(plugins, enabled)
	var checked = Distribution.read_bundles()
	if not checked.ok:
		_reject(checked.error)
		return
	var license_path := "res://addons/devcel/LICENSE"
	if not FileAccess.file_exists(license_path):
		_reject(Locale.text("addonのLICENSEがありません", "The addon LICENSE is missing"))
		return
	for bundle in checked.bundles:
		add_file(bundle.path, bundle.bytes, false)
		_pull_bundle_paths.append(bundle.path)
	add_file(license_path, FileAccess.get_file_as_bytes(license_path), false)
	var nonce := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--devcel-prepared-export="): nonce = arg.trim_prefix("--devcel-prepared-export=")
	print("DEVCEL_EXPORT_READY:%s:%s" % [nonce, Distribution.manifest(checked.bundles).sha256_text()])

func _reject(message: String):
	_failed = true
	printerr("DEVCEL_EXPORT_REJECTED: " + message)
	get_export_platform().add_message(EditorExportPlatform.EXPORT_MESSAGE_ERROR, "Devcel", message + Locale.text("。この成果物を配布せず、取り込みエラーを解消して再度書き出してください。", ". Do not distribute this artifact. Resolve the import errors and export again."))

static func is_editor_file(path: String) -> bool:
	var lower = path.to_lower()
	if lower.begins_with("res://addons/devcel/editor/") or lower.begins_with("res://addons/devcel/bin/") or lower.begins_with("res://.devcel/"): return true
	if lower in ["res://addons/devcel/plugin.cfg", "res://project.godot", "res://export_presets.cfg"]: return true
	if ".devcel-owner.json" in lower or ".devcel-state.json" in lower or lower.ends_with(".devcel-lock") or lower.ends_with("devcel.import.json"): return true
	if lower.ends_with(".devcelproj.toml") or lower.ends_with(".table.toml") or lower.ends_with(".interface.toml") or lower.ends_with("devcel.export.toml"): return true
	if lower.get_file() in ["devcel", "devcel.exe", "devcel-cli", "devcel-cli.exe", "devcel_core.dll", "libdevcel_core.so", "libdevcel_core.dylib"]: return true
	return false

func _export_file(path: String, _type: String, _features: PackedStringArray):
	if is_editor_file(path) or path in _pull_bundle_paths or path == "res://addons/devcel/LICENSE" or _failed: skip()

func _export_end():
	for name in _saved_settings: ProjectSettings.set_setting(name, _saved_settings[name])
	_saved_settings.clear()

