@tool
extends Window
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
## Draft-only native wizard. The importer owns validation, persistence and import.
signal apply_requested(source: Dictionary, sync_mode: String)
signal dismissed
var STEPS := [Locale.text("取り込み元の選択", "Select source"), Locale.text("生成設定", "Generation settings"), Locale.text("確認して取り込み", "Review and import")]
const TAG_KEYS := ["row_include_tags", "row_exclude_tags", "column_include_tags", "column_exclude_tags"]
const TagRunner = preload("res://addons/devcel/editor/devcel_pull_runner.gd")
var _tag_runner = TagRunner.new()
var _tag_values: Dictionary = {}
var _tag_panels: Dictionary = {}
var _tag_presets: Array = []
var _tag_status: Label
var _tag_project := ""
var _step := 0
var _fields: Dictionary = {}
var _mode: OptionButton
var _sync_mode: OptionButton
var _target: OptionButton
var _pages: Array[VBoxContainer] = []
var _chips: Array[Label] = []
var _error: Label
var _summary: RichTextLabel
var _back: Button
var _next: Button
var _cancel: Button
var _scroll: ScrollContainer
var _busy := false
var _next_double_click := false
var _others: Array = []
var _original_id := ""
var _portable: Callable
var _validate: Callable
var _buttons: Array[Button] = []

func _init():
	title = Locale.text("Devcel · 取り込み設定", "Devcel · Import settings")
	min_size = Vector2i(520, 430)
	size = Vector2i(720, 680)
	unresizable = false
	wrap_controls = false
	transient = true
	exclusive = true
	close_requested.connect(_dismiss)

func setup(source: Dictionary, sources: Array, original_id: String, sync_mode: String, portable: Callable, validate: Callable):
	_portable = portable; _validate = validate
	_others = sources.duplicate(true); _original_id = original_id
	var margin := MarginContainer.new(); margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right", "top", "bottom"]: margin.add_theme_constant_override("margin_" + side, 20)
	add_child(margin)
	var shell := VBoxContainer.new(); shell.add_theme_constant_override("separation", 12); margin.add_child(shell)
	var heading := Label.new(); heading.text = Locale.text("取り込み設定", "Import settings"); heading.add_theme_font_size_override("font_size", 24); shell.add_child(heading)
	var steps := HBoxContainer.new(); steps.add_theme_constant_override("separation", 8); shell.add_child(steps)
	for index in STEPS.size():
		var chip := Label.new(); chip.text = "%d  %s" % [index + 1, STEPS[index]]; chip.size_flags_horizontal = Control.SIZE_EXPAND_FILL; chip.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; steps.add_child(chip); _chips.append(chip)
	shell.add_child(HSeparator.new())
	_scroll = ScrollContainer.new(); _scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL; _scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED; _scroll.follow_focus = true; shell.add_child(_scroll)
	var content := VBoxContainer.new(); content.size_flags_horizontal = Control.SIZE_EXPAND_FILL; _scroll.add_child(content)
	for _index in STEPS.size():
		var page := VBoxContainer.new(); page.size_flags_horizontal = Control.SIZE_EXPAND_FILL; page.add_theme_constant_override("separation", 10); content.add_child(page); _pages.append(page)
	_build_source(source)
	_build_generation(source, sync_mode)
	_summary = RichTextLabel.new(); _summary.bbcode_enabled = false; _summary.fit_content = true; _summary.scroll_active = false; _summary.selection_enabled = true; _summary.size_flags_horizontal = Control.SIZE_EXPAND_FILL; _pages[2].add_child(_summary)
	_error = Label.new(); _error.max_lines_visible = 4; _error.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; _error.add_theme_color_override("font_color", Color("ffac92")); shell.add_child(_error)
	shell.add_child(HSeparator.new())
	var actions := HBoxContainer.new(); actions.add_theme_constant_override("separation", 10); shell.add_child(actions)
	_cancel = _button(actions, Locale.text("キャンセル", "Cancel"), _dismiss)
	var spacer := Control.new(); spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL; actions.add_child(spacer)
	_back = _button(actions, Locale.text("戻る", "Back"), _previous)
	_next = _button(actions, Locale.text("次へ", "Next"), _advance)
	_next.gui_input.connect(_next_input)
	_show_step()

func _note(parent: Control, text: String):
	var label := Label.new(); label.text = text; label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; parent.add_child(label)

func _field(parent: Control, key: String, label: String, value: String, placeholder := "") -> LineEdit:
	_note(parent, label)
	var field := LineEdit.new(); field.text = value; field.placeholder_text = placeholder; field.size_flags_horizontal = Control.SIZE_EXPAND_FILL; parent.add_child(field)
	field.text_submitted.connect(func(_value): _advance())
	_fields[key] = field
	return field

func _button(parent: Control, label: String, action: Callable) -> Button:
	var button := Button.new(); button.text = label; button.pressed.connect(action); parent.add_child(button); _buttons.append(button); return button

func _option(parent: Control, label: String, values: Array, current: String) -> OptionButton:
	_note(parent, label)
	var option := OptionButton.new()
	for value in values: option.add_item(value)
	option.select(maxi(0, values.find(current))); parent.add_child(option)
	return option

func _build_source(source: Dictionary):
	var page := _pages[0]
	_field(page, "project", Locale.text("取り込み元プロジェクト（.devcelproj.toml）", "Source project (.devcelproj.toml)"), str(source.get("project", "")))
	_button(page, Locale.text("参照…", "Browse…"), func(): _browse("project"))
	_field(page, "id", Locale.text("Source ID（英数字 / _ / -）", "Source ID (letters / numbers / _ / -)"), str(source.get("id", "")), Locale.text("例: master", "Example: master"))

func _build_generation(source: Dictionary, sync_mode: String):
	var page := _pages[1]
	_note(page, Locale.text("他の取り込み元プロジェクトと異なるNamespace・出力先を指定してください。", "Use a different namespace and output path for each source project."))
	_field(page, "namespace", "Namespace", str(source.get("namespace", "")), Locale.text("例: Game.Master", "Example: Game.Master"))
	_field(page, "runtime_out", Locale.text("Runtime JSONの配置先", "Runtime JSON output"), str(source.get("runtime_out", "")))
	_button(page, Locale.text("Runtime JSONの配置先を参照…", "Browse runtime JSON output…"), func(): _browse("runtime_out"))
	_mode = _option(page, Locale.text("形式", "Format"), ["full", "minimal"], str(source.get("mode", "full")))
	var version = source.get("version")
	_field(page, "version", Locale.text("Content version（空欄 = 全件、0..4294967295）", "Content version (blank = all, 0..4294967295)"), "" if version == null else str(int(version)))
	_note(page, Locale.text("タグフィルター（この取り込み元のみ）: include 空欄 = 全件、いずれか一致、exclude 優先。未登録名は自動削除しません。", "Tag filters (this source only): empty includes select all; includes match any tag; excludes win. Unregistered names are never removed automatically."))
	for key in TAG_KEYS:
		_tag_values[key] = source.get(key, []).duplicate() if source.get(key, []) is Array else source.get(key)
		var panel := VBoxContainer.new(); page.add_child(panel); _tag_panels[key] = panel
	_tag_status = Label.new(); _tag_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; page.add_child(_tag_status)
	_button(page, Locale.text("プロジェクトタグを更新", "Refresh project tag presets"), _load_tag_presets)
	_render_tag_filters()
	_target = _option(page, Locale.text("コード生成（任意）", "Code generation (optional)"), [Locale.text("生成しない", "None"), "csharp", "cpp"], str(source.get("code_target", Locale.text("生成しない", "None"))))
	_target.item_selected.connect(func(_index): _update_target())
	_field(page, "code_out", Locale.text("生成コードの配置先（コード生成時に必須）", "Generated code output (required for code generation)"), str(source.get("code_out", "")))
	_button(page, Locale.text("コードの配置先を参照…", "Browse code output…"), func(): _browse("code_out"))
	_field(page, "class_name", Locale.text("ルートクラス名（任意）", "Root class name (optional)"), "" if source.get("class_name") == null else str(source.class_name))
	_fields.class_name.tooltip_text = Locale.text("ルートDB型名だけを指定します。テーブル・行・interface型名は変わりません。", "Only the root database type is renamed. Table, row and interface type names are unchanged.")
	_sync_mode = _option(page, Locale.text("自動取り込み", "Automatic import"), ["Off", "FileWatch", "P2P", "Auto"], sync_mode)
	_note(page, Locale.text("Auto（既定）は保存済み変更を自動取り込みし、必要な接続サーバーも自動起動します。P2Pも自動起動に対応します。", "Auto (default) imports saved changes and starts the connection server when needed. P2P also supports automatic server startup."))
	_update_target()

func _load_tag_presets():
	if _tag_runner.running(): return
	_tag_project = _fields.project.text.strip_edges()
	var path := _tag_project
	if not path.is_absolute_path(): path = ProjectSettings.globalize_path("res://.devcel/devcel.import.json").get_base_dir().path_join(path).simplify_path()
	_tag_presets = []
	_tag_status.text = Locale.text("タグを読み込み中…", "Loading project tags…")
	if not _tag_runner.start_tag_presets(path): _tag_status.text = _tag_runner.last_error
	_render_tag_filters()

func _process(_delta):
	if _step == 1 and _tag_project != _fields.project.text.strip_edges() and not _tag_runner.running(): _load_tag_presets()
	if not _tag_runner.running(): return
	var response: Dictionary = _tag_runner.poll()
	if not response.get("done", false): return
	if _tag_project != _fields.project.text.strip_edges(): return
	if response.get("ok", false) and response.get("data", {}).get("presets") is Array:
		_tag_presets = response.data.presets
		_tag_status.text = ""
	else: _tag_status.text = Locale.text("タグを取得できません。既存フィルターを保持します。", "Cannot read project tags. Existing filters are retained.") + " " + str(response.get("error", ""))
	_render_tag_filters()

func _render_tag_filters():
	for key in TAG_KEYS:
		var panel: VBoxContainer = _tag_panels[key]
		for child in panel.get_children(): panel.remove_child(child); child.queue_free()
		_note(panel, key)
		if not _tag_values[key] is Array:
			_note(panel, Locale.text("不正な配列です。設定を修復してください。", "Invalid array. Repair settings before import.")); continue
		for index in _tag_values[key].size():
			var row := HBoxContainer.new(); panel.add_child(row)
			var field := LineEdit.new(); field.text = str(_tag_values[key][index]); field.size_flags_horizontal = Control.SIZE_EXPAND_FILL; field.editable = not _busy; row.add_child(field)
			field.text_changed.connect(func(value): _tag_values[key][index] = value)
			field.text_submitted.connect(func(_value): _render_tag_filters())
			var remove := Button.new(); remove.text = Locale.text("削除", "Remove"); remove.disabled = _busy; row.add_child(remove)
			remove.pressed.connect(func(): _tag_values[key].remove_at(index); _render_tag_filters())
			if _tag_values[key][index] not in _tag_presets: _note(panel, Locale.text("未登録タグ。プリセット名に修正するか、明示的に削除してください。", "Unregistered tag. Edit to a project preset or explicitly remove it."))
		var picker := OptionButton.new(); picker.disabled = _busy; picker.add_item(Locale.text("プロジェクトタグを追加…", "Add project preset…"))
		for tag in _tag_presets: picker.add_item(str(tag))
		panel.add_child(picker)
		picker.item_selected.connect(func(index):
			if index > 0 and _tag_presets[index - 1] not in _tag_values[key]: _tag_values[key].append(_tag_presets[index - 1])
			_render_tag_filters())

func _update_target():
	if not _fields.has("class_name"): return
	var target := _target.get_item_text(_target.selected)
	_fields.class_name.placeholder_text = "Database" if target == "cpp" else "DevcelDatabase" if target == "csharp" else "C#: DevcelDatabase / C++: Database"
	_fields.code_out.editable = not _busy and _target.selected != 0

func source() -> Dictionary:
	var result: Dictionary = {}
	for key in ["id", "project", "namespace", "runtime_out", "class_name", "code_out"]:
		var value: String = _fields[key].text.strip_edges()
		if key in ["class_name", "code_out"] and value.is_empty(): continue
		if key == "code_out" and _target.selected == 0: continue
		result[key] = _portable.call(value) if key in ["project", "runtime_out", "code_out"] else value
	for key in TAG_KEYS: result[key] = _tag_values[key].duplicate() if _tag_values[key] is Array else _tag_values[key]
	result.mode = _mode.get_item_text(_mode.selected)
	if _target.selected != 0: result.code_target = _target.get_item_text(_target.selected)
	var version: String = _fields.version.text.strip_edges()
	if not version.is_empty(): result.version = int(version) if version.is_valid_int() else version
	return result

func _page_error() -> String:
	if _step == 0:
		var draft := source()
		if str(draft.project).is_empty(): return Locale.text("取り込み元プロジェクト .devcelproj.tomlを選択してください。", "Select a source project .devcelproj.toml file.")
		if not str(draft.project).ends_with(".devcelproj.toml"): return Locale.text("取り込み元プロジェクトは .devcelproj.tomlを選択してください。", "The source project must be a .devcelproj.toml file.")
		var project_path: String = str(draft.project)
		if not project_path.is_absolute_path(): project_path = ProjectSettings.globalize_path("res://.devcel/devcel.import.json").get_base_dir().path_join(project_path).simplify_path()
		if not FileAccess.file_exists(project_path): return Locale.text("取り込み元プロジェクトが見つかりません。ファイルの場所を確認してください。", "The source project was not found. Check the file location.")
		if not _matches(str(draft.id), "^[A-Za-z0-9_-]+$"): return Locale.text("Source IDは英数字・_・-で入力してください。", "Use letters, numbers, _ or - for the Source ID.")
		for item in _others:
			if str(item.get("id", "")) != _original_id and str(item.get("id", "")).to_lower() == str(draft.id).to_lower(): return Locale.text("このSource IDは登録済みです。別のIDを指定してください。", "This Source ID is already registered. Choose a different ID.")
		return ""
	var version: String = _fields.version.text.strip_edges()
	if not version.is_empty() and (not version.is_valid_int() or int(version) < 0 or int(version) > 4294967295): return Locale.text("Content versionは空欄または0..4294967295の整数です。", "Content version must be blank or an integer from 0 to 4294967295.")
	return str(_validate.call(source()))

func _matches(value: String, pattern: String) -> bool:
	var regex := RegEx.new(); regex.compile(pattern); return regex.search(value) != null

func _next_input(event: InputEvent):
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		_next_double_click = event.double_click
	elif event is InputEventKey or event is InputEventJoypadButton:
		_next_double_click = false

func _advance():
	# A second click from the preceding page must not accept the review automatically.
	if _next_double_click:
		_next_double_click = false
		return
	if _busy: return
	var error := _page_error()
	if not error.is_empty(): _error.text = error; return
	if _step == 2:
		set_busy(true, Locale.text("全取り込み元プロジェクトの設定を検証しています…", "Validating all source project settings…"))
		apply_requested.emit(source(), _sync_mode.get_item_text(_sync_mode.selected))
		return
	_step += 1; _show_step()

func _previous():
	if _busy: return
	_step = maxi(0, _step - 1); _show_step()

func _show_step():
	_error.text = ""
	for index in _pages.size():
		_pages[index].visible = index == _step
		_chips[index].modulate = Color.WHITE if index == _step else Color(0.6, 0.65, 0.72)
	_back.disabled = _step == 0
	_next.text = Locale.text("保存して取り込む", "Save and import") if _step == 2 else Locale.text("次へ", "Next")
	_next.disabled = false
	_scroll.scroll_vertical = 0
	if _step == 2: _update_summary()
	var focus: Control = _fields.project if _step == 0 else _fields.namespace if _step == 1 else _next
	focus.call_deferred("grab_focus")

func _update_summary():
	var draft := source()
	var lines := PackedStringArray(["Source ID  ·  " + str(draft.id), "", Locale.text("取り込み元プロジェクト: ", "Source project: ") + str(draft.project), "Namespace: " + str(draft.namespace), "Runtime JSON: " + str(draft.runtime_out), Locale.text("形式: ", "Format: ") + str(draft.mode), "Content version: " + str(draft.get("version", Locale.text("全件", "All"))), Locale.text("コード: ", "Code: ") + str(draft.get("code_target", Locale.text("生成しない", "None")))])
	for key in TAG_KEYS: lines.append(key + ": " + JSON.stringify(draft[key]))
	if draft.has("code_out"): lines.append(Locale.text("コード配置先: ", "Code output: ") + str(draft.code_out))
	lines.append(Locale.text("ルートクラス: ", "Root class: ") + str(draft.get("class_name", _fields.class_name.placeholder_text)))
	lines.append(Locale.text("自動取り込み: ", "Automatic import: ") + _sync_mode.get_item_text(_sync_mode.selected))
	lines.append(Locale.text("\n保存される取り込み元プロジェクト一覧（全%d件）", "\nSources to save (%d total)") % (_others.size() + (1 if _original_id.is_empty() else 0)))
	for item in _others:
		if str(item.get("id", "")) == _original_id: item = draft
		lines.append("• %s  →  %s%s" % [item.get("id", ""), item.get("runtime_out", ""), Locale.text("  ［今回取り込み］", "  [Import now]") if item.id == draft.id else Locale.text("  ［設定を維持］", "  [Keep settings]")])
	if _original_id.is_empty(): lines.append(Locale.text("• %s  →  %s  ［追加して取り込み］", "• %s  →  %s  [Add and import]") % [draft.id, draft.runtime_out])
	lines.append(Locale.text("\n選択したプロジェクトの生成コードとJSONを更新します。", "\nThe selected project's generated code and JSON will be updated."))
	_summary.text = "\n".join(lines)

func set_busy(value: bool, message := ""):
	_busy = value
	_render_tag_filters()
	for button in _buttons: button.disabled = value
	_cancel.disabled = value
	for field in _fields.values(): field.editable = not value
	for option in [_mode, _target, _sync_mode]: option.disabled = value
	_error.text = message
	_error.tooltip_text = message
	if not value:
		_back.disabled = _step == 0
		_next.disabled = false
		_update_target()

func show_error(message: String):
	set_busy(false, message)

func _browse(key: String):
	if _busy: return
	var dialog := FileDialog.new(); dialog.access = FileDialog.ACCESS_FILESYSTEM
	dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILE if key == "project" else FileDialog.FILE_MODE_SAVE_FILE
	dialog.title = Locale.text("取り込み元プロジェクトを選択", "Select source project") if key == "project" else Locale.text("配置先を選択", "Select output path")
	dialog.filters = PackedStringArray(["*.devcelproj.toml ; Devcel project"] if key == "project" else ["*.json ; Runtime JSON"] if key == "runtime_out" else ["*.cs,*.h ; Generated code"])
	dialog.file_selected.connect(func(path):
		_fields[key].text = str(_portable.call(path))
		dialog.queue_free())
	dialog.canceled.connect(dialog.queue_free); add_child(dialog); dialog.popup_centered_ratio(0.8)

func _exit_tree():
	_tag_runner.cancel_tag_query()

func _dismiss():
	if _busy: return
	hide(); dismissed.emit(); queue_free()

func _unhandled_key_input(event: InputEvent):
	if event.is_action_pressed("ui_cancel") and not _busy:
		_dismiss(); set_input_as_handled()
