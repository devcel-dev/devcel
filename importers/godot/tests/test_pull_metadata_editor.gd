@tool
extends EditorPlugin
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
## Standalone Editor workflow integration, installed by prepare_pull_metadata_qa.py.
var checks := 0
var failures: Array[String] = []
var importer: EditorPlugin
var started := 0
var reload_check := false
var clean_check := false

func _enter_tree(): call_deferred("_verify")
func _find(node: Node) -> EditorPlugin:
	var script = node.get_script()
	if script != null and script.resource_path == "res://addons/devcel/editor/plugin.gd": return node
	for child in node.get_children():
		var found := _find(child)
		if found != null: return found
	return null
func check(condition: bool, label: String):
	checks += 1
	if not condition: failures.append(label); push_error("FAIL: " + label)
func bytes() -> String: return FileAccess.get_file_as_string(importer.CONFIG)
func editor_bytes() -> String: return FileAccess.get_file_as_string(importer.EDITOR_CONFIG)
func wait_pull():
	var deadline := Time.get_ticks_msec() + 20000
	while importer._busy and Time.get_ticks_msec() < deadline: await get_tree().process_frame
	check(not importer._busy, "Pull completes")
func open_wizard(index: int) -> Window:
	importer._open_wizard(index)
	return importer._wizard
func to_settings(wizard: Window):
	check(wizard._step == 0 and wizard._pages.size() == 3, "source-first three-step wizard")
	check(not wizard._fields.has("cli") and wizard._next.disabled == false, "no CLI field or manual verification gate")
	wizard._advance(); check(wizard._step == 1, "source to settings")
func _verify():
	for _index in 15: await get_tree().process_frame
	started = Time.get_ticks_msec(); importer = _find(get_tree().root)
	if importer == null: check(false, "plugin found"); finish(); return
	clean_check = "--wizard-clean" in OS.get_cmdline_user_args()
	if clean_check:
		await verify_clean_project(); finish(); return
	reload_check = "--metadata-reload" in OS.get_cmdline_user_args()
	if reload_check:
		check(importer._sources.size() == 3, "restart restores all sources")
		check(importer._config_error.is_empty(), "restart schema accepted")
		importer._select(1)
		var reopened: Window = open_wizard(1)
		check(reopened._fields.class_name.text == "EventData", "restart custom root class")
		check(reopened._fields.version.text == "0", "restart content version zero")
		check(reopened._sync_mode.selected == 0, "restart Off preference")
		check(reopened._target.selected == 1, "restart C# generation")
		to_settings(reopened)
		reopened._advance(); reopened._advance(); await wait_pull()
		check(not is_instance_valid(importer._wizard), "restart repeated Pull succeeds")
		finish(); return
	check(importer._sources.size() == 2, "two sources loaded")
	check(importer._relative_path("C:/repo/title/.devcel", "D:/data/a.devcelproj.toml").is_absolute_path(), "cross drive cannot become relative")
	check(importer._relative_path("//host/share/title/.devcel", "//host/share/source/a.devcelproj.toml") == "../../source/a.devcelproj.toml", "UNC same share relative")
	var local := ConfigFile.new(); local.load(importer.EDITOR_CONFIG)
	local.set_value("pull", "sync_modes", {"base": "Off", "event": "Off", "independent": "P2P"}); local.save(importer.EDITOR_CONFIG)
	importer._reload_if_changed()
	var original := bytes(); var local_original := editor_bytes()
	var base_source: Dictionary = importer._sources[0].duplicate(true)
	var event_source: Dictionary = importer._sources[1].duplicate(true)
	var base_hash := FileAccess.get_sha256(base_source.runtime_out)
	var event_hash := FileAccess.get_sha256(event_source.runtime_out)
	var wizard: Window = open_wizard(-1)
	check(wizard != null and wizard._step == 0, "new wizard step0")
	check(importer._sources.size() == 2, "new draft stays out of registered sources")
	wizard._advance(); check(wizard._step == 0, "empty source cannot advance")
	wizard._fields.project.text = base_source.project
	wizard._fields.id.text = "draft"
	wizard._advance(); check(wizard._step == 1, "new draft source validated")
	wizard._fields.namespace.text = "Game.Draft"
	wizard._fields.runtime_out.text = "res://data/draft.json"
	wizard._fields.class_name.text = "DraftData"
	wizard._fields.version.text = "0"
	wizard._advance(); check(wizard._step == 2, "new draft review")
	check(Locale.text("全3件", "3 total") in wizard._summary.text and "base" in wizard._summary.text and "event" in wizard._summary.text, "summary includes all sources")
	wizard._previous(); check(wizard._step == 1 and wizard._fields.class_name.text == "DraftData", "back preserves draft")
	check(bytes() == original and editor_bytes() == local_original, "back never persists")
	wizard._dismiss(); await get_tree().process_frame
	check(not is_instance_valid(importer._wizard), "cancel closes window")
	check(importer._sources.size() == 2 and bytes() == original and editor_bytes() == local_original, "cancel discards draft and settings")
	check(not FileAccess.file_exists("res://data/draft.json"), "cancel never creates output")
	importer._select(1); wizard = open_wizard(1)
	check(wizard._fields.id.text == "event" and wizard._fields.version.text == "", "edit prefills correct selection")
	check(wizard._sync_mode.item_count == 4 and wizard._pages.size() == 3, "three pages and four sync modes")
	to_settings(wizard)
	wizard._fields.namespace.text = "game.base"
	wizard._advance(); check(wizard._step == 1 and not wizard._error.text.is_empty(), "namespace collision blocked")
	wizard._fields.namespace.text = "Game.Event"
	for invalid in ["-1", "4294967296", "nope", "2.5"]:
		wizard._fields.version.text = invalid; wizard._advance(); check(wizard._step == 1 and bytes() == original, "invalid version unchanged: " + invalid)
	wizard._fields.version.text = "4294967295"
	wizard._fields.class_name.text = "bad-name"; wizard._advance(); check(wizard._step == 1, "invalid class blocked")
	wizard._fields.class_name.text = "EventData"
	wizard._fields.runtime_out.text = base_source.runtime_out; wizard._advance(); check(wizard._step == 1, "output collision blocked")
	wizard._fields.runtime_out.text = event_source.runtime_out
	wizard._target.select(1); wizard._update_target(); wizard._fields.code_out.text = "res://generated/EventData.cs"
	wizard._advance(); check(wizard._step == 2, "valid settings reach review")
	check(wizard._next.text == Locale.text("保存して取り込む", "Save and import"), "explicit final action label")
	check(bytes() == original and FileAccess.get_sha256(event_source.runtime_out) == event_hash, "review remains draft-only")
	var double_click := InputEventMouseButton.new(); double_click.button_index = MOUSE_BUTTON_LEFT; double_click.pressed = true; double_click.double_click = true
	wizard._next_input(double_click); wizard._advance()
	check(wizard._step == 2 and not importer._busy and bytes() == original, "double-click second press cannot skip review and apply")
	wizard._advance(); wizard._advance(); wizard._dismiss()
	check(importer._busy and is_instance_valid(importer._wizard), "double-click and cancel blocked during Pull")
	await wait_pull()
	check(not is_instance_valid(importer._wizard), "successful Pull closes wizard")
	check(importer._sources.size() == 2 and importer._selected == 1, "commit preserves all sources and selection")
	var config: Dictionary = JSON.parse_string(bytes())
	for source in config.sources:
		for key in ["project", "runtime_out", "code_out"]:
			if source.has(key): check(not str(source[key]).is_absolute_path() and not ":" in str(source[key]), "all source paths portable: " + source.id + "/" + key)
	check(not "cli=" in editor_bytes() and importer._sync_modes.get("independent") == "P2P", "save stores no CLI key and preserves independent sync preferences")
	check(config.sources[1].class_name == "EventData" and config.sources[1].version == 4294967295, "metadata committed")
	var header := FileAccess.get_file_as_string("res://generated/EventData.cs")
	check("class EventData" in header and "namespace Game.Event" in header, "real C# generated with custom root")
	var runtime: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(event_source.runtime_out))
	check(runtime.manifest.content_version == 4294967295, "u32 max runtime manifest")
	check(FileAccess.get_sha256(base_source.runtime_out) == base_hash, "other source output unchanged")
	original = bytes(); local_original = editor_bytes(); event_hash = FileAccess.get_sha256(event_source.runtime_out)
	var code_hash := FileAccess.get_sha256("res://generated/EventData.cs")
	wizard = open_wizard(1); to_settings(wizard)
	check(wizard._fields.class_name.text == "EventData" and wizard._fields.version.text == "4294967295", "reopen saved metadata")
	wizard._fields.class_name.text = "class"; wizard._advance(); check(wizard._step == 2, "core reserved name reaches authoritative validation")
	wizard._advance(); await wait_pull()
	check(is_instance_valid(importer._wizard) and not wizard._busy, "failed Core validation is retryable")
	check(bytes() == original and editor_bytes() == local_original, "Core failure restores both settings byte-for-byte")
	check(FileAccess.get_sha256(event_source.runtime_out) == event_hash and FileAccess.get_sha256("res://generated/EventData.cs") == code_hash, "Core failure preserves runtime and code")
	wizard._previous(); wizard._fields.class_name.text = "ItemsTable"; wizard._advance(); wizard._advance(); await wait_pull()
	check(is_instance_valid(importer._wizard), "generated type collision rejected")
	check(bytes() == original and FileAccess.get_sha256(event_source.runtime_out) == event_hash, "generated collision restores settings and preserves output")
	wizard._previous(); wizard._fields.class_name.text = "EventData"; wizard._fields.version.text = "0"; wizard._advance(); wizard._advance(); await wait_pull()
	check(not is_instance_valid(importer._wizard), "retry after failure succeeds")
	config = JSON.parse_string(bytes()); check(config.sources[1].version == 0, "version 0 retained")
	original = bytes(); wizard = open_wizard(1); to_settings(wizard); wizard._advance()
	importer._write_atomic(importer.CONFIG, original + "\n")
	wizard._advance(); check(not importer._busy and Locale.text("変更", "changed") in wizard._error.text, "external config change rejects stale apply")
	check(bytes() == original + "\n", "stale apply preserves external bytes")
	wizard._dismiss(); await get_tree().process_frame
	check(importer._loaded_text == original + "\n", "cancel reloads latest settings")
	wizard = open_wizard(1); to_settings(wizard); wizard._advance()
	var current_local := editor_bytes(); importer._write_atomic(importer.EDITOR_CONFIG, current_local + "\n")
	wizard._advance(); check(not importer._busy and Locale.text("変更", "changed") in wizard._error.text, "external editor config change rejects stale apply")
	wizard._dismiss(); await get_tree().process_frame
	check(FileAccess.get_sha256(base_source.runtime_out) == base_hash, "all workflows preserve other source")
	# A corrupt or missing bundle is diagnosed only on the final action; drafts remain retryable.
	wizard = open_wizard(1); to_settings(wizard); wizard._advance()
	var before_cli_change := bytes(); var before_cli_editor := editor_bytes()
	var bundle_path: String = importer.PullRunner.resolve_cli()
	var cli_bytes := FileAccess.get_file_as_bytes(bundle_path)
	var changed_cli := FileAccess.open(bundle_path, FileAccess.READ_WRITE)
	changed_cli.seek_end(); changed_cli.store_8(0); changed_cli.close()
	wizard._advance()
	check(wizard._step == 2 and not importer._busy and "SHA256" in wizard._error.text, "corrupt bundled CLI stays on review with actionable error")
	check(Locale.text("入れ直", "Reinstall") in wizard._error.text, "corrupt bundle recommends reinstall")
	check(bytes() == before_cli_change and editor_bytes() == before_cli_editor, "corrupt CLI keeps both configs unchanged")
	changed_cli = FileAccess.open(bundle_path, FileAccess.WRITE); changed_cli.store_buffer(cli_bytes); changed_cli.close()
	check(DirAccess.rename_absolute(bundle_path, bundle_path + ".qa-held") == OK, "isolate missing bundled executable")
	wizard._advance()
	check(wizard._step == 2 and not importer._busy and Locale.text("不足", "missing") in wizard._error.text, "missing bundle cannot fall back to PATH")
	check(bytes() == before_cli_change and editor_bytes() == before_cli_editor, "missing bundle keeps both configs unchanged")
	check(DirAccess.rename_absolute(bundle_path + ".qa-held", bundle_path) == OK, "restore bundled executable")
	wizard._advance(); await wait_pull()
	check(not is_instance_valid(importer._wizard), "restored bundle retries directly without manual CLI verification")
	# External Off during the actual child process must win over pending FileWatch.
	wizard = open_wizard(1); to_settings(wizard)
	wizard._sync_mode.select(1); wizard._advance(); wizard._advance()
	var external_local := ConfigFile.new(); external_local.load(importer.EDITOR_CONFIG)
	var external_modes: Dictionary = external_local.get_value("pull", "sync_modes", {})
	external_modes["event"] = "Off"; external_local.set_value("pull", "sync_modes", external_modes)
	external_local.save(importer.EDITOR_CONFIG)
	await wait_pull()
	check(importer._sync_modes.get("event") == "Off", "external Off during Pull wins on success")
	check(importer._loaded_editor_text == editor_bytes(), "successful Pull tracks latest editor bytes")
	# A later editor-only change is picked up even when shared JSON is unchanged.
	external_modes["event"] = "FileWatch"; external_local.set_value("pull", "sync_modes", external_modes); external_local.save(importer.EDITOR_CONFIG)
	importer._reload_if_changed()
	check(importer._sync_modes.get("event") == "FileWatch", "editor-only change reloads without shared config change")
	external_modes["event"] = "Off"; external_local.set_value("pull", "sync_modes", external_modes); external_local.save(importer.EDITOR_CONFIG); importer._reload_if_changed()
	# Real FileWatch uses the same metadata and bundled CLI as the manual wizard Pull.
	wizard = open_wizard(1); to_settings(wizard)
	wizard._sync_mode.select(1); wizard._advance(); wizard._advance(); await wait_pull()
	check(importer._sync_modes.get("event") == "FileWatch", "watch mode saved by wizard")
	check(not JSON.parse_string(bytes()).sources[1].has("sync_mode"), "watch mode is editor-only")
	var cli: String = importer.PullRunner.resolve_cli()
	var output: Array = []
	check(OS.execute(cli, PackedStringArray(["--mode", "local", "--project", str(event_source.project), "cell", "set", "Items", "11111111-1111-4111-8111-111111111111", "hp", "919"]), output, false) == 0, "change saved source for watch")
	var database = load("res://addons/devcel/runtime/devcel_database.gd").new()
	var deadline := Time.get_ticks_msec() + 12000
	var value := -1
	while Time.get_ticks_msec() < deadline:
		await get_tree().process_frame
		if database.load_file(str(event_source.runtime_out)):
			value = database.by_id("Items", "11111111-1111-4111-8111-111111111111").get_int("hp")
			if value == 919 and not importer._busy: break
	check(value == 919, "FileWatch automatically updates selected source")
	check(FileAccess.get_sha256(base_source.runtime_out) == base_hash, "FileWatch preserves Off source")
	check("class EventData" in FileAccess.get_file_as_string("res://generated/EventData.cs"), "FileWatch keeps custom root class")
	check(JSON.parse_string(FileAccess.get_file_as_string(str(event_source.runtime_out))).manifest.content_version == 0, "FileWatch keeps content version zero")
	wizard = open_wizard(1); to_settings(wizard)
	check(wizard._sync_mode.selected == 1, "edit prefills FileWatch")
	wizard._sync_mode.select(0); wizard._advance(); wizard._advance(); await wait_pull()
	event_hash = FileAccess.get_sha256(event_source.runtime_out)
	check(OS.execute(cli, PackedStringArray(["--mode", "local", "--project", str(event_source.project), "cell", "set", "Items", "11111111-1111-4111-8111-111111111111", "hp", "920"]), output, false) == 0, "change saved source with Off")
	await get_tree().create_timer(1.7).timeout
	check(FileAccess.get_sha256(event_source.runtime_out) == event_hash, "Off keeps generated output unchanged")
	wizard = open_wizard(-1)
	wizard._fields.project.text = base_source.project; wizard._advance()
	wizard._fields.namespace.text = "Game.NewSource"; wizard._fields.runtime_out.text = "res://data/new-source.json"
	wizard._advance(); wizard._advance(); await wait_pull()
	check(not is_instance_valid(importer._wizard) and importer._sources.size() == 3, "new source commits once after final action")
	check(FileAccess.file_exists("res://data/new-source.json"), "new source generates runtime")
	check(JSON.parse_string(bytes()).sources.size() == 3, "new source persisted without replacing others")
	check(FileAccess.get_sha256(base_source.runtime_out) == base_hash and FileAccess.get_sha256(event_source.runtime_out) == event_hash, "new source leaves existing outputs unchanged")
	finish()
func verify_clean_project():
	var source_project: String = importer._sources[0].project
	importer._sync.stop()
	check(DirAccess.rename_absolute(ProjectSettings.globalize_path("res://.devcel"), ProjectSettings.globalize_path("res://.devcel-before-clean")) == OK, "isolate initial config for clean first-import")
	importer._load()
	check(importer._sources.is_empty() and not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path("res://.devcel")), "clean title has no config directory")
	for commit in [false, true]:
		var wizard: Window = open_wizard(-1)
		wizard._fields.project.text = importer._portable_path(source_project)
		wizard._advance(); check(wizard._step == 1, "relative source resolves before config directory exists")
		wizard._fields.namespace.text = "Game.Clean"
		wizard._fields.runtime_out.text = "res://data/clean-first.json"
		wizard._target.select(1); wizard._update_target()
		wizard._fields.code_out.text = "res://generated/CleanData.cs"
		wizard._fields.class_name.text = "CleanData"
		wizard._fields.version.text = "0"
		wizard._advance(); check(wizard._step == 2, "clean first-import reaches review")
		check(not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path("res://.devcel")), "review creates no config directory")
		if not commit:
			wizard._dismiss(); await get_tree().process_frame
			check(not FileAccess.file_exists("res://data/clean-first.json") and importer._sources.is_empty(), "cancel clean setup creates no output or source")
		else:
			wizard._advance(); await wait_pull()
			check(not is_instance_valid(importer._wizard) and importer._sources.size() == 1, "first import commits exactly one source")
			check(FileAccess.file_exists(importer.CONFIG) and FileAccess.file_exists("res://data/clean-first.json"), "first import creates config and runtime")
			check("class CleanData" in FileAccess.get_file_as_string("res://generated/CleanData.cs"), "first import creates requested code")
	importer._sync.stop()
	check(DirAccess.rename_absolute(ProjectSettings.globalize_path("res://.devcel"), ProjectSettings.globalize_path("res://.devcel-clean-result")) == OK, "retain clean config as evidence")
	check(DirAccess.rename_absolute(ProjectSettings.globalize_path("res://.devcel-before-clean"), ProjectSettings.globalize_path("res://.devcel")) == OK, "restore two-source fixture")
	importer._load()

func finish():
	var file := FileAccess.open("res://wizard-clean-result.json" if clean_check else "res://wizard-reload-result.json" if reload_check else "res://wizard-qa-result.json", FileAccess.WRITE)
	file.store_string(JSON.stringify({"checks": checks, "failures": failures, "ok": failures.is_empty(), "elapsed_ms": Time.get_ticks_msec() - started}, "  ")); file.close()
	print("DEVCEL_WIZARD_QA: ", checks, " checks; failures=", failures.size())
	get_tree().quit(0 if failures.is_empty() else 1)
