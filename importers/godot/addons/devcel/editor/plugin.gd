@tool
extends EditorPlugin
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
## Saved sources are managed here; the three-step window owns disposable drafts.
const PullRunner = preload("devcel_pull_runner.gd")
const ExportPlugin = preload("devcel_export_plugin.gd")
const PullSync = preload("devcel_pull_sync.gd")
const ImportWizard = preload("devcel_import_wizard.gd")
const CONFIG := "res://.devcel/devcel.import.json"
const EDITOR_CONFIG := "res://.devcel/pull-editor.cfg"
var _sync = PullSync.new()
var _runner = PullRunner.new()
var _export_plugin = ExportPlugin.new()
var _dock: ScrollContainer
var _body: VBoxContainer
var _list: ItemList
var _details: RichTextLabel
var _status: RichTextLabel
var _sync_status: Label
var _sources: Array = []
var _sync_modes: Dictionary = {}
var _statuses: Dictionary = {}
var _buttons: Array[Button] = []
var _selected := -1
var _busy := false
var _config_error := ""
var _automatic_source := ""
var _last_status_only := false
var _loaded_text := ""
var _loaded_editor_text := ""
var _next_reload_time := 0
var _wizard: Window
var _wizard_index := -1
var _wizard_baseline := ""
var _wizard_editor_baseline := ""
var _transaction: Dictionary = {}

func _enter_tree():
	add_export_plugin(_export_plugin)
	_dock = ScrollContainer.new(); _dock.name = "Devcel"; _dock.custom_minimum_size = Vector2(300, 280)
	_dock.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED; _dock.follow_focus = true
	_body = VBoxContainer.new(); _body.size_flags_horizontal = Control.SIZE_EXPAND_FILL; _body.add_theme_constant_override("separation", 10); _dock.add_child(_body)
	var title := Label.new(); title.text = Locale.text("取り込み元プロジェクト", "Source projects"); title.add_theme_font_size_override("font_size", 20); _body.add_child(title)
	_button(_body, Locale.text("+ 取り込み元プロジェクトを追加…", "+ Add source project…"), _add)
	_list = ItemList.new(); _list.custom_minimum_size.y = 130; _list.item_selected.connect(_select); _list.item_activated.connect(func(index): _select(index); _edit_source()); _body.add_child(_list)
	var row := HBoxContainer.new(); _body.add_child(row)
	_button(row, Locale.text("選択を編集…", "Edit selected…"), _edit_source)
	_button(row, Locale.text("登録解除…", "Remove source…"), _remove)
	_details = RichTextLabel.new(); _details.fit_content = true; _details.scroll_active = false; _details.selection_enabled = true; _body.add_child(_details)
	_sync_status = Label.new(); _sync_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; _body.add_child(_sync_status)
	_body.add_child(HSeparator.new())
	_button(_body, Locale.text("取り込み", "Import"), func(): _run(false, true))
	_button(_body, Locale.text("すべて取り込む", "Import all"), func(): _run(false, false))
	_button(_body, Locale.text("状態とエラーを確認", "Check status and errors"), func(): _run(true, false))
	_status = RichTextLabel.new(); _status.custom_minimum_size.y = 130; _status.fit_content = true; _status.scroll_active = false; _status.selection_enabled = true; _body.add_child(_status)
	_load()
	var exporting := false
	for argument in OS.get_cmdline_args():
		if argument in ["--export-pack", "--export-debug", "--export-release", "--export-patch"]: exporting = true
	if _config_error.is_empty() and not exporting: _sync.configure(_sources, _sync_modes, CONFIG)
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, _dock)
	set_process(true)

func _button(parent: Control, label: String, action: Callable):
	var button := Button.new(); button.text = label; button.pressed.connect(action); parent.add_child(button); _buttons.append(button)
func _absolute(path: String) -> String:
	return ProjectSettings.globalize_path(path) if path.begins_with("res://") or path.begins_with("user://") else path

func _portable_path(path: String) -> String:
	if path.is_empty(): return path
	var base := ProjectSettings.globalize_path(CONFIG).get_base_dir()
	var absolute := _absolute(path)
	if not absolute.is_absolute_path(): return absolute.replace("\\", "/")
	return _relative_path(base, absolute)

func _relative_path(base: String, path: String) -> String:
	base = base.replace("\\", "/").simplify_path()
	path = path.replace("\\", "/").simplify_path()
	if (":" in base) != (":" in path): return path
	var windows := ":" in base or base.begins_with("//")
	# A relative path cannot cross a drive or UNC share.
	var base_parts := base.split("/", false)
	var path_parts := path.split("/", false)
	if base.begins_with("//") != path.begins_with("//"): return path
	var root_parts := 2 if base.begins_with("//") else 1 if windows else 0
	if path_parts.size() < root_parts: return path
	for index in range(root_parts):
		if base_parts[index].to_lower() != path_parts[index].to_lower(): return path
	var common := 0
	while common < mini(base_parts.size(), path_parts.size()):
		var equal := base_parts[common].to_lower() == path_parts[common].to_lower() if windows else base_parts[common] == path_parts[common]
		if not equal: break
		common += 1
	var relative := PackedStringArray()
	for _index in range(common, base_parts.size()): relative.append("..")
	for index in range(common, path_parts.size()): relative.append(path_parts[index])
	return "/".join(relative) if not relative.is_empty() else "."

func _config_text() -> String:
	return FileAccess.get_file_as_string(CONFIG) if FileAccess.file_exists(CONFIG) else ""

func _editor_text() -> String:
	return FileAccess.get_file_as_string(EDITOR_CONFIG) if FileAccess.file_exists(EDITOR_CONFIG) else ""

func _load():
	_sources = []; _selected = -1; _config_error = ""; _sync_modes = {}
	_loaded_text = _config_text(); _loaded_editor_text = _editor_text()
	var local := ConfigFile.new()
	if FileAccess.file_exists(EDITOR_CONFIG):
		if local.load(EDITOR_CONFIG) != OK:
			_load_error(Locale.text("自動取り込み設定を読めません。既存のOff設定を保持するため、設定が直るまで同期を停止します。", "Cannot read automatic import settings. Sync is stopped until the settings are fixed, preserving existing Off settings.")); return
		var modes = local.get_value("pull", "sync_modes", {})
		if not modes is Dictionary:
			_load_error(Locale.text("自動取り込み設定はsource別の辞書で指定してください。設定が直るまで同期を停止します。", "Automatic import settings must be a dictionary keyed by source. Sync is stopped until the settings are fixed.")); return
		for id in modes:
			if not id is String or modes[id] not in ["Off", "FileWatch", "P2P", "Auto"]:
				_load_error(Locale.text("自動取り込み設定はOff / FileWatch / P2P / Autoで指定してください。", "Automatic import must be Off / FileWatch / P2P / Auto.")); return
		_sync_modes = modes
	if _loaded_text.is_empty() and not FileAccess.file_exists(CONFIG): _refresh_list(); return
	var parser := JSON.new()
	if parser.parse(_loaded_text) != OK or not parser.data is Dictionary or parser.data.get("schema_version") != 1 or not parser.data.get("sources") is Array:
		_load_error(Locale.text("取り込み設定を読めません。既存設定を確認してください。自動変更は行いません。", "Cannot read import settings. Check the existing configuration. No automatic changes will be made.")); return
	for key in parser.data:
		if key not in ["schema_version", "sources"]: _load_error(Locale.text("未知の取り込み設定項目: ", "Unknown import setting: ") + str(key)); return
	for source in parser.data.sources:
		if not source is Dictionary: _load_error(Locale.text("sourceの形式が不正です。設定を確認してください。", "Invalid source format. Check the configuration.")); return
		for key in source:
			if key not in ["id", "project", "namespace", "runtime_out", "code_out", "code_target", "class_name", "mode", "version"]:
				_load_error(Locale.text("未知のsource設定項目: ", "Unknown source setting: ") + str(key)); return
		for key in ["id", "project", "namespace", "runtime_out"]:
			if not source.get(key) is String: _load_error(key + Locale.text("は文字列で指定してください", " must be a string")); return
		for key in ["code_out", "code_target", "class_name", "mode"]:
			if source.get(key) != null and not source[key] is String: _load_error(key + Locale.text("は文字列またはnullで指定してください", " must be a string or null")); return
		if source.has("mode") and source.get("mode") not in ["full", "minimal"]: _load_error(Locale.text("modeはfull/minimalのみです", "mode must be full or minimal")); return
		if source.get("code_target") != null and source.code_target not in ["csharp", "cpp"]: _load_error(Locale.text("code_targetはcsharp/cppのみです", "code_target must be csharp or cpp")); return
		for key in ["row_include_tags", "row_exclude_tags", "column_include_tags", "column_exclude_tags"]:
			if not source.get(key, []) is Array: return key + Locale.text(" は配列で指定してください。", " must be an array.")
			for tag in source.get(key, []):
				if not tag is String: return key + Locale.text(" は文字列配列で指定してください。", " must be a string array.")
		var version = source.get("version")
		if version != null:
			if not (version is int or version is float) or version < 0 or version > 4294967295 or float(version) != floor(float(version)):
				_load_error(Locale.text("Content versionはnullまたは0..4294967295の整数で指定してください", "Content version must be null or an integer from 0 to 4294967295")); return
			source.version = int(version)
	_sources = parser.data.sources
	_selected = 0 if not _sources.is_empty() else -1
	_refresh_list()

func _load_error(message: String):
	_config_error = message; _status.text = message; _sync.stop(); _refresh_list()

func _status_label(value: String) -> String:
	return str({"pulled": Locale.text("取り込み済み", "Imported"), "ready": Locale.text("一致確認済み", "Verified"), "needs_pull": Locale.text("取り込みが必要", "Import needed"), "error": Locale.text("エラー", "Error")}.get(value, value))

func _refresh_list():
	_list.clear()
	for source in _sources:
		var id := str(source.get("id", Locale.text("未設定", "Not configured")))
		_list.add_item(id + "  ·  " + _status_label(str(_statuses.get(id, Locale.text("未確認", "Not checked")))))
	if _selected >= 0 and _selected < _sources.size(): _list.select(_selected)
	_show_details()

func _select(index: int):
	if _busy or is_instance_valid(_wizard):
		if _selected >= 0: _list.select(_selected)
		return
	_selected = index if index >= 0 and index < _sources.size() else -1
	_show_details()

func _show_details():
	if _selected < 0 or _selected >= _sources.size():
		_details.text = Locale.text("取り込み元プロジェクトはまだ登録されていません。\n「+ 取り込み元プロジェクトを追加…」から始めましょう。", "No source projects are registered yet.\nStart with “+ Add source project…”."); _sync_status.text = ""; return
	var source: Dictionary = _sources[_selected]
	_details.text = Locale.text("%s\n取り込み元プロジェクト: %s\nNamespace: %s\nRuntime: %s\n形式: %s  /  版: %s\n自動取り込み: %s", "%s\nSource project: %s\nNamespace: %s\nRuntime: %s\nFormat: %s  /  Version: %s\nAutomatic import: %s") % [source.id, source.project, source.namespace, source.runtime_out, source.get("mode", "full"), Locale.text("全件", "All") if source.get("version") == null else str(source.version), _sync_modes.get(source.id, "Auto")]
	if source.get("code_out") != null: _details.text += Locale.text("\nコード: ", "\nCode: ") + str(source.code_out)

func _reload_if_changed():
	if _loaded_text == _config_text() and _loaded_editor_text == _editor_text(): return
	var previous := str(_sources[_selected].id) if _selected >= 0 and _selected < _sources.size() else ""
	_load()
	for index in _sources.size():
		if str(_sources[index].id) == previous: _selected = index
	_refresh_list()
	if _config_error.is_empty(): _sync.configure(_sources, _sync_modes, CONFIG)

func _add():
	_open_wizard(-1)

func _edit_source():
	if _selected >= 0: _open_wizard(_selected)

func _open_wizard(index: int):
	if _busy: return
	if is_instance_valid(_wizard): _wizard.grab_focus(); return
	var intended_id := str(_sources[index].id) if index >= 0 and index < _sources.size() else ""
	_reload_if_changed()
	if not _config_error.is_empty(): _status.text = _config_error; return
	if index >= 0:
		index = -1
		for candidate_index in _sources.size():
			if str(_sources[candidate_index].id) == intended_id: index = candidate_index; break
		if index < 0: _status.text = Locale.text("選択した取り込み元プロジェクトが変更されました。一覧から選び直してください。", "The selected source project has changed. Select it again from the list."); return
	var draft: Dictionary
	var original_id := ""
	if index >= 0 and index < _sources.size():
		draft = _sources[index].duplicate(true); original_id = str(draft.id)
	else:
		var number := 1
		var ids: Array = _sources.map(func(item): return str(item.id).to_lower())
		while ("source%d" % number).to_lower() in ids: number += 1
		draft = {"id": "Source%d" % number, "project": "", "namespace": "Game.Source%d" % number, "runtime_out": "res://data/source%d.json" % number, "mode": "full"}
		index = -1
	_wizard_index = index; _wizard_baseline = _loaded_text
	_wizard_editor_baseline = _loaded_editor_text
	_wizard = ImportWizard.new()
	_wizard.theme = get_editor_interface().get_base_control().theme
	_dock.add_child(_wizard)
	_wizard.setup(draft, _sources, original_id, str(_sync_modes.get(original_id, "Auto")), _portable_path, _validate_draft)
	_wizard.apply_requested.connect(_apply_wizard)
	_wizard.dismissed.connect(func(): _wizard = null; _set_controls(false); _reload_if_changed())
	_set_controls(true)
	_wizard.popup_centered_clamped(Vector2i(720, 680), 0.9)

func _validate_draft(draft: Dictionary) -> String:
	var candidates := _sources.duplicate(true)
	if _wizard_index >= 0 and _wizard_index < candidates.size(): candidates[_wizard_index] = draft
	else: candidates.append(draft)
	return _validate_sources(candidates)

func _matches(value: String, pattern: String) -> bool:
	var regex := RegEx.new(); regex.compile(pattern); return regex.search(value) != null

func _path_identity(path: String) -> String:
	path = _absolute(path)
	if not path.is_absolute_path(): path = ProjectSettings.globalize_path(CONFIG).get_base_dir().path_join(path)
	return path.replace("\\", "/").simplify_path().to_lower()

func _validate_sources(sources: Array) -> String:
	var ids: Array[String] = []; var namespaces: Array[String] = []; var outputs: Array[String] = []; var roots: Array[String] = []
	for source in sources:
		var id := str(source.get("id", ""))
		if not _matches(id, "^[A-Za-z0-9_-]+$") or id.to_lower() in ids: return Locale.text("Source IDは英数字・_・-で一意にしてください: ", "Source IDs must be unique and use letters, numbers, _ or -: ") + id
		ids.append(id.to_lower())
		var namespace_value := str(source.get("namespace", "")).strip_edges().replace("::", ".")
		if not _matches(namespace_value, "^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$"): return Locale.text("Namespaceを識別子のドット区切りで入力してください: ", "Enter a namespace of dot-separated identifiers: ") + id
		for existing in namespaces:
			if namespace_value.to_lower() == existing or namespace_value.to_lower().begins_with(existing + ".") or existing.begins_with(namespace_value.to_lower() + "."): return Locale.text("Namespaceが他の取り込み元プロジェクトと衝突しています: ", "Namespace conflicts with another source project: ") + namespace_value
		namespaces.append(namespace_value.to_lower())
		var class_name_value = source.get("class_name")
		if class_name_value != null and not _matches(str(class_name_value), "^[A-Za-z_][A-Za-z0-9_]*$"): return Locale.text("ルートクラス名は有効な識別子で指定してください: ", "Root class name must be a valid identifier: ") + id
		for key in ["row_include_tags", "row_exclude_tags", "column_include_tags", "column_exclude_tags"]:
			if not source.get(key, []) is Array: return key + Locale.text(" は配列で指定してください。", " must be an array.")
			for tag in source.get(key, []):
				if not tag is String: return key + Locale.text(" は文字列配列で指定してください。", " must be a string array.")
		var version = source.get("version")
		if version != null and (not (version is int or version is float) or version < 0 or version > 4294967295 or float(version) != floor(float(version))): return Locale.text("Content versionは空欄または0..4294967295の整数です: ", "Content version must be blank or an integer from 0 to 4294967295: ") + id
		if str(source.get("mode", "full")) not in ["full", "minimal"]: return Locale.text("形式はfullまたはminimalです: ", "Format must be full or minimal: ") + id
		var project := str(source.get("project", ""))
		if not project.ends_with(".devcelproj.toml"): return Locale.text("取り込み元プロジェクト .devcelproj.tomlを指定してください: ", "Specify a source project .devcelproj.toml file: ") + id
		var original_path := _absolute(project)
		if not original_path.is_absolute_path(): original_path = ProjectSettings.globalize_path(CONFIG).get_base_dir().path_join(original_path).simplify_path()
		if not FileAccess.file_exists(original_path): return Locale.text("取り込み元プロジェクトが見つかりません: ", "Source project not found: ") + project
		roots.append(_path_identity(project).get_base_dir())
		if str(source.get("runtime_out", "")).get_extension() != "json": return Locale.text("Runtimeの配置先には.jsonファイルを指定してください: ", "Runtime output must be a .json file: ") + id
		if source.get("code_out") != null or source.get("code_target") != null:
			var target := str(source.get("code_target", ""))
			if target not in ["csharp", "cpp"]: return Locale.text("コード言語はcsharpまたはcppです: ", "Code language must be csharp or cpp: ") + id
			if str(source.get("code_out", "")).get_extension() != ("cs" if target == "csharp" else "h"): return Locale.text("コード配置先には.cs / .hを指定してください: ", "Code output must be a .cs or .h file: ") + id
		for key in ["project", "runtime_out", "code_out"]:
			if source.get(key) == null: continue
			var path := _portable_path(str(source[key]))
			if path.is_empty() or path.is_absolute_path() or ":" in path: return Locale.text("取り込み元プロジェクトと出力先は同じドライブに配置し、相対パスで保存できるようにしてください: ", "Keep source projects and outputs on the same drive so their paths can be saved as relative paths: ") + id
			if key == "project": continue
			var absolute := _path_identity(path)
			if absolute in outputs or absolute == _path_identity(CONFIG) or absolute == _path_identity(EDITOR_CONFIG) or DirAccess.dir_exists_absolute(absolute): return Locale.text("出力先が重複、設定ファイル、またはフォルダです: ", "Output path is duplicated, a configuration file, or a directory: ") + path
			outputs.append(absolute)
	for output in outputs:
		for root in roots:
			if output == root or output.begins_with(root + "/"): return Locale.text("出力先はすべての取り込み元プロジェクトフォルダの外に配置してください。", "All output paths must be outside every source project folder.")
		for other in outputs:
			if output != other and (other.begins_with(output + "/") or other == output + ".devcel-owner.json" or other == output + ".devcel-lock"): return Locale.text("出力先と別の出力先・管理ファイルが衝突しています。", "An output path conflicts with another output or management file.")
	return ""

func _write_atomic(path: String, content: String) -> bool:
	var temporary := path + ".wizard-tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null: return false
	file.store_string(content); file.flush(); file.close()
	var result := DirAccess.rename_absolute(ProjectSettings.globalize_path(temporary), ProjectSettings.globalize_path(path))
	if result != OK: DirAccess.remove_absolute(ProjectSettings.globalize_path(temporary))
	return result == OK

func _save_values(sources: Array, modes: Dictionary) -> bool:
	if DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://.devcel")) != OK: _status.text = Locale.text("設定フォルダを作成できません", "Cannot create the configuration folder"); return false
	var previous_editor_exists := FileAccess.file_exists(EDITOR_CONFIG)
	var previous_editor := _editor_text()
	var local := ConfigFile.new(); local.set_value("pull", "sync_modes", modes)
	if not _write_atomic(EDITOR_CONFIG, local.encode_to_text()): _status.text = Locale.text("Editor同期設定を保存できません", "Cannot save editor sync settings"); return false
	if not _transaction.is_empty(): _transaction.written_editor = local.encode_to_text()
	if not _write_atomic(CONFIG, JSON.stringify({"schema_version": 1, "sources": sources}, "  ")):
		_status.text = Locale.text("取り込み設定を保存できません", "Cannot save import settings")
		if _transaction.is_empty() and _editor_text() == local.encode_to_text():
			if not _restore_file(EDITOR_CONFIG, previous_editor_exists, previous_editor): _status.text += Locale.text("\n同期設定の復元にも失敗しました。設定ファイルを確認してください。", "\nRestoring sync settings also failed. Check the configuration file.")
		return false
	return true

func _restore_file(path: String, existed: bool, content: String) -> bool:
	if existed: return _write_atomic(path, content)
	return not FileAccess.file_exists(path) or DirAccess.remove_absolute(ProjectSettings.globalize_path(path)) == OK

func _apply_wizard(draft: Dictionary, sync_mode: String):
	if _busy or not is_instance_valid(_wizard): return
	var prepared := PullRunner.prepare_cli()
	if not prepared.ok: _wizard.show_error(str(prepared.error)); return
	var editor_text := _editor_text()
	if _config_text() != _wizard_baseline or editor_text != _wizard_editor_baseline: _wizard.show_error(Locale.text("設定が別の場所で変更されました。キャンセルして、最新の設定を開き直してください。", "Settings were changed elsewhere. Cancel and reopen the latest settings.")); return
	var error := _validate_draft(draft)
	if not error.is_empty(): _wizard.show_error(error); return
	var candidates := _sources.duplicate(true); var modes := _sync_modes.duplicate(true)
	if _wizard_index >= 0:
		var old_id := str(candidates[_wizard_index].id)
		if old_id != str(draft.id): modes.erase(old_id)
		candidates[_wizard_index] = draft
	else: candidates.append(draft)
	for source in candidates:
		for key in ["project", "runtime_out", "code_out"]:
			if source.get(key) != null: source[key] = _portable_path(str(source[key]))
	modes[draft.id] = sync_mode
	_transaction = {"config_exists": FileAccess.file_exists(CONFIG), "config": _wizard_baseline, "editor_exists": FileAccess.file_exists(EDITOR_CONFIG), "editor": FileAccess.get_file_as_string(EDITOR_CONFIG) if FileAccess.file_exists(EDITOR_CONFIG) else "", "sources": candidates, "modes": modes, "id": str(draft.id)}
	_transaction.output_before = _output_fingerprints(draft)
	_sync.stop()
	if not _save_values(candidates, modes): _fail_transaction(_status.text); return
	_transaction.written_config = _config_text()
	_transaction.written_editor = FileAccess.get_file_as_string(EDITOR_CONFIG)
	if not _runner.start(CONFIG, str(draft.id), false): _fail_transaction(_runner.last_error); return
	_busy = true; _last_status_only = false; _set_controls(true)
	_wizard.set_busy(true, Locale.text("保存済み取り込み元プロジェクトを検証して取り込んでいます…", "Validating and importing the saved source project…"))
	_status.text = Locale.text("取り込み中: ", "Importing: ") + str(draft.id)

func _output_fingerprints(source: Dictionary) -> Dictionary:
	var result: Dictionary = {}
	for key in ["runtime_out", "code_out"]:
		if source.get(key) == null: continue
		var path := _absolute(str(source[key]))
		if not path.is_absolute_path(): path = ProjectSettings.globalize_path(CONFIG).get_base_dir().path_join(path).simplify_path()
		for candidate in [path, path + ".devcel-owner.json"]:
			result[candidate] = FileAccess.get_sha256(candidate) if FileAccess.file_exists(candidate) else "<absent>"
	return result

func _fail_transaction(message: String):
	if not _transaction.is_empty():
		# An unreadable response or state-sidecar failure can follow successful publication.
		# Roll back settings only while every selected output is demonstrably unchanged.
		for path in _transaction.get("output_before", {}):
			var current_hash := FileAccess.get_sha256(path) if FileAccess.file_exists(path) else "<absent>"
			if current_hash != str(_transaction.output_before[path]):
				var source_id := str(_transaction.id)
				_transaction = {}; _busy = false
				if is_instance_valid(_wizard): _wizard.hide(); _wizard.queue_free(); _wizard = null
				_load()
				for index in _sources.size():
					if str(_sources[index].id) == source_id: _selected = index
				_refresh_list(); _set_controls(false)
				_status.text = Locale.text("完了を確認できませんでしたが、生成先の変更を検出しました。設定は保持し、自動取り込みを停止しました。状態を確認し、再取り込みが成功すると自動取り込みを再開します。\n", "Completion could not be confirmed, but output changes were detected. Settings were kept and automatic import was stopped. Check the status; automatic import resumes after a successful import.\n") + message
				get_editor_interface().get_resource_filesystem().scan()
				return
		message = _restore_transaction_settings(message)
	_transaction = {}; _busy = false
	_status.text = Locale.text("取り込みに失敗しました。\n", "Import failed.\n") + message
	if is_instance_valid(_wizard): _wizard.show_error(Locale.text("取り込みに失敗しました。設定は確定されていません。\n", "Import failed. Settings have not been committed.\n") + message)
	_reload_if_changed()
	if _config_error.is_empty(): _sync.configure(_sources, _sync_modes, CONFIG)
	_set_controls(is_instance_valid(_wizard))

func _restore_transaction_settings(message: String) -> String:
	var config_current := _config_text()
	var editor_current := FileAccess.get_file_as_string(EDITOR_CONFIG) if FileAccess.file_exists(EDITOR_CONFIG) else ""
	if config_current == str(_transaction.get("written_config", _transaction.config)):
		if not _restore_file(CONFIG, _transaction.config_exists, _transaction.config): message += Locale.text("\n元の取り込み設定を復元できませんでした。設定ファイルを確認してください。", "\nCould not restore the original import settings. Check the configuration file.")
	else: message += Locale.text("\n取り込み設定が外部で変更されたため上書きせず停止しました。開き直してください。", "\nImport settings changed externally. Stopped without overwriting them. Reopen the settings.")
	if editor_current == str(_transaction.get("written_editor", editor_current)):
		if not _restore_file(EDITOR_CONFIG, _transaction.editor_exists, _transaction.editor): message += Locale.text("\n元の同期設定を復元できませんでした。設定ファイルを確認してください。", "\nCould not restore the original sync settings. Check the configuration file.")
	else: message += Locale.text("\n同期設定が外部で変更されたため上書きしていません。開き直してください。", "\nSync settings changed externally and were not overwritten. Reopen the settings.")
	return message

func _remove():
	if _busy or is_instance_valid(_wizard) or _selected < 0: return
	_reload_if_changed()
	if _selected < 0 or not _config_error.is_empty(): return
	var index := _selected; var source_id := str(_sources[index].id); var baseline := _loaded_text; var editor_baseline := _loaded_editor_text
	var dialog := ConfirmationDialog.new(); dialog.title = Locale.text("取り込み元プロジェクトの登録解除", "Remove source project"); dialog.dialog_text = source_id + Locale.text("の登録を解除しますか？\n取り込み元プロジェクトと生成済みファイルは削除しません。", ": remove this source?\nThe source project and generated files will not be deleted."); dialog.ok_button_text = Locale.text("登録解除", "Remove"); dialog.cancel_button_text = Locale.text("キャンセル", "Cancel")
	dialog.confirmed.connect(func():
		if _busy or _config_text() != baseline or _editor_text() != editor_baseline: _status.text = Locale.text("設定が変わりました。開き直してください。", "Settings have changed. Reopen the settings."); dialog.queue_free(); return
		var candidates := _sources.duplicate(true); candidates.remove_at(index)
		var modes := _sync_modes.duplicate(true); modes.erase(source_id)
		if _save_values(candidates, modes):
			_sources = candidates; _sync_modes = modes; _selected = mini(index, _sources.size() - 1); _loaded_text = _config_text(); _loaded_editor_text = _editor_text(); _sync.configure(_sources, _sync_modes, CONFIG); _refresh_list(); _status.text = source_id + Locale.text("の登録を解除しました。", " was removed.")
		dialog.queue_free())
	dialog.canceled.connect(dialog.queue_free); _dock.add_child(dialog); dialog.popup_centered()

func _run(status_only: bool, selected_only: bool):
	if _busy or is_instance_valid(_wizard): return
	_reload_if_changed()
	if not _config_error.is_empty(): _status.text = _config_error; return
	if _sources.is_empty(): _status.text = Locale.text("先に取り込み元プロジェクトを追加してください。", "Add a source project first."); return
	if selected_only and _selected < 0: return
	_start_pull(status_only, str(_sources[_selected].id) if selected_only else "", false)

func _set_controls(disabled: bool):
	for button in _buttons: button.disabled = disabled
	_list.mouse_filter = Control.MOUSE_FILTER_IGNORE if disabled else Control.MOUSE_FILTER_STOP
	_list.focus_mode = Control.FOCUS_NONE if disabled else Control.FOCUS_ALL

func _start_pull(status_only: bool, source_id: String, automatic: bool):
	if automatic:
		_reload_if_changed()
		if not _config_error.is_empty() or str(_sync_modes.get(source_id, "Auto")) == "Off": return
	if not _runner.start(CONFIG, source_id, status_only):
		_status.text = _runner.last_error
		if automatic: _sync.completed(source_id, false)
		return
	_automatic_source = source_id if automatic else ""; _last_status_only = status_only; _busy = true; _set_controls(true)
	_status.text = Locale.text("状態を確認中…", "Checking status…") if status_only else Locale.text("自動取り込み中: ", "Auto-importing: ") + source_id if automatic else Locale.text("取り込み中…", "Importing…")

func _process(_delta: float):
	if not _busy and not is_instance_valid(_wizard) and Time.get_ticks_msec() >= _next_reload_time:
		_next_reload_time = Time.get_ticks_msec() + 1000
		_reload_if_changed()
	_sync.tick()
	if _selected >= 0 and _selected < _sources.size():
		var state: Dictionary = _sync.state(str(_sources[_selected].get("id", "")))
		_sync_status.text = str(state.get("status", ""))
		if not str(state.get("error", "")).is_empty(): _sync_status.text += "\n" + str(state.error)
	if not _busy:
		if is_instance_valid(_wizard): return
		var source_id: String = _sync.next_source()
		if not source_id.is_empty(): _start_pull(false, source_id, true)
		return
	var result: Dictionary = _runner.poll()
	if not result.get("done", false): return
	_busy = false
	if not _transaction.is_empty():
		if not result.get("ok", false): _fail_transaction(_runner.last_error); return
		var completed_source_id := str(_transaction.id)
		var externally_changed: bool = _config_text() != str(_transaction.written_config) or _editor_text() != str(_transaction.written_editor)
		_sources = _transaction.sources; _sync_modes = _transaction.modes
		for index in _sources.size():
			if str(_sources[index].id) == str(_transaction.id): _selected = index
		_transaction = {}; _loaded_text = _config_text(); _loaded_editor_text = _editor_text()
		if externally_changed:
			_load()
			for index in _sources.size():
				if str(_sources[index].id) == completed_source_id: _selected = index
		if is_instance_valid(_wizard): _wizard.hide(); _wizard.queue_free(); _wizard = null
		if _config_error.is_empty(): _sync.configure(_sources, _sync_modes, CONFIG)
	if result.get("ok", false) and not _last_status_only and _config_error.is_empty(): _sync.configure(_sources, _sync_modes, CONFIG)
	if not _automatic_source.is_empty(): _sync.completed(_automatic_source, bool(result.get("ok", false)))
	_automatic_source = ""; _set_controls(false)
	var lines := PackedStringArray()
	for source in result.get("data", {}).get("sources", []):
		_statuses[source.id] = source.status
		lines.append("%s · %s\n%s" % [source.id, _status_label(str(source.status)), source.runtime_out])
		if source.get("error") != null: lines.append(JSON.stringify(source.error, "  "))
	if lines.is_empty(): lines.append(_runner.last_error)
	if not _config_error.is_empty(): lines.append(_config_error)
	_status.text = "\n".join(lines); _refresh_list()
	get_editor_interface().get_resource_filesystem().scan()

func _exit_tree():
	# Probes have not started publication. Closing the Editor/addon cancels them and
	# rolls back only our unchanged draft settings, exactly like a preparation failure.
	var preparation_cancelled := _runner.cancel_preparation()
	if not _transaction.is_empty() and preparation_cancelled:
		var unchanged := true
		for path in _transaction.get("output_before", {}):
			var current_hash := FileAccess.get_sha256(path) if FileAccess.file_exists(path) else "<absent>"
			if current_hash != str(_transaction.output_before[path]): unchanged = false
		if unchanged:
			var restore_error := _restore_transaction_settings("")
			if not restore_error.is_empty(): push_warning(restore_error)
		else: push_warning(Locale.text("CLI準備中に生成先の変更を検出したため、設定を保持しました。状態を確認して再取り込みしてください。", "Output changes were detected while preparing the CLI, so settings were kept. Check the status and import again."))
		_transaction = {}
	_sync.stop(); remove_export_plugin(_export_plugin)
	# CLI publication is finite and atomic; do not kill it midway through publication.
	if is_instance_valid(_wizard): _wizard.queue_free()
	if is_instance_valid(_dock): remove_control_from_docks(_dock); _dock.queue_free()
