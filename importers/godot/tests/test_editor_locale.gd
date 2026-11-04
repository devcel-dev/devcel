@tool
extends EditorPlugin
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
const Wizard = preload("res://addons/devcel/editor/devcel_import_wizard.gd")
const Runner = preload("res://addons/devcel/editor/devcel_pull_runner.gd")
const Sync = preload("res://addons/devcel/editor/devcel_sync.gd")
var failures: Array[String] = []
var checks := 0
func check(ok: bool, label: String):
	checks += 1
	if not ok: failures.append(label); push_error(label)
func find_importer(node: Node) -> Node:
	var script = node.get_script()
	if script != null and script.resource_path == "res://addons/devcel/editor/plugin.gd": return node
	for child in node.get_children():
		var found := find_importer(child)
		if found != null: return found
	return null
func check_english_nodes(node: Node):
	var values: Array[String] = []
	if node is Label or node is Button or node is RichTextLabel: values.append(node.text)
	if node is LineEdit: values.append(node.placeholder_text)
	if node is OptionButton:
		for index in node.item_count: values.append(node.get_item_text(index))
	for value in values:
		var regex := RegEx.new(); regex.compile("[\u3000-\u9fff]")
		check(regex.search(value) == null, "English UI text: " + value)
	for child in node.get_children(): check_english_nodes(child)
func _enter_tree(): call_deferred("verify")
func verify():
	await get_tree().create_timer(1.0).timeout
	var japanese := TranslationServer.get_tool_locale().begins_with("ja")
	print("EDITOR_LOCALE=", TranslationServer.get_tool_locale())
	check(Locale.text("日本語", "English") == ("日本語" if japanese else "English"), "locale selection")
	for name in ["plugin", "devcel_distribution", "devcel_export_plugin", "devcel_pull_sync", "safe_export"]:
		var script = load("res://addons/devcel/editor/" + name + ".gd")
		check(script != null and (script.can_instantiate() or name == "safe_export" and script.get_script_method_list().size() > 0), "script parses: " + name)
	var importer := find_importer(get_tree().root)
	check(importer != null, "importer plugin loaded")
	if importer != null:
		check(importer._buttons[0].text == ("+ 取り込み元プロジェクトを追加…" if japanese else "+ Add source project…"), "dock add action")
		check(importer._buttons[1].text == ("選択を編集…" if japanese else "Edit selected…"), "dock edit action")
		check(importer._buttons[2].text == ("登録解除…" if japanese else "Remove source…"), "dock remove action")
		check(importer._details.text.begins_with("取り込み元プロジェクトは" if japanese else "No source projects"), "empty dock")
		if not japanese: check_english_nodes(importer._dock)
	var wizard = Wizard.new()
	get_tree().root.add_child(wizard)
	wizard.setup({}, [], "", "Auto", func(value): return value, func(_source): return "")
	check(wizard.title == ("Devcel · 取り込み設定" if japanese else "Devcel · Import settings"), "wizard title")
	check(wizard.STEPS[0] == ("取り込み元の選択" if japanese else "Select source"), "source step")
	check(wizard.STEPS[1] == ("生成設定" if japanese else "Generation settings"), "generation step")
	check(wizard.STEPS[2] == ("確認して取り込み" if japanese else "Review and import"), "review step")
	check(wizard._cancel.text == ("キャンセル" if japanese else "Cancel"), "cancel")
	check(wizard._next.text == ("次へ" if japanese else "Next"), "next")
	wizard._advance()
	check(wizard._step == 0, "missing source cannot advance")
	check(wizard._error.text == ("取り込み元プロジェクト .devcelproj.tomlを選択してください。" if japanese else "Select a source project .devcelproj.toml file."), "source validation language")
	wizard._fields.id.text = "master"
	wizard._fields.project.text = "../../ManualBasics/ManualBasics.devcelproj.toml"
	wizard._fields.namespace.text = "Game.Master"
	wizard._fields.runtime_out.text = "../data/master.json"
	wizard._fields.version.text = "1"
	check(wizard._target.get_item_text(0) == ("生成しない" if japanese else "None"), "no code generation label")
	check(not wizard.source().has("code_target") and not wizard.source().has("code_out"), "no-code serialization unchanged")
	wizard._target.select(1)
	wizard._fields.code_out.text = "../generated/Master.cs"
	check(wizard.source().code_target == "csharp" and wizard.source().mode == "full", "code and mode tokens unchanged")
	check(wizard._sync_mode.get_item_text(wizard._sync_mode.selected) == "Auto", "sync token unchanged")
	wizard._step = 2
	wizard._show_step()
	check(wizard._next.text == ("保存して取り込む" if japanese else "Save and import"), "save and import")
	check(("追加して取り込み" if japanese else "Add and import") in wizard._summary.text, "summary action language")
	check("Game.Master" in wizard._summary.text and "../data/master.json" in wizard._summary.text, "summary data unchanged")
	var sync = Sync.new()
	check(sync.status == ("同期: Off" if japanese else "Sync: Off"), "sync status language")
	if not japanese: check_english_nodes(wizard)
	wizard.free()
	print("EDITOR_LOCALE_TESTS checks=", checks, " failures=", failures.size())
	get_tree().quit(0 if failures.is_empty() else 1)
