@tool
extends EditorPlugin
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
const Database = preload("res://addons/devcel/runtime/devcel_database.gd")
var importer: EditorPlugin
var checks := 0
var failures: Array[String] = []
var sources: Array
var cli := ""
var manual: Dictionary = {}
func _enter_tree(): call_deferred("run")
func _process(_delta: float):
	# This fixture owns serve's pipes; unread stderr eventually blocks it.
	if manual.is_empty(): return
	for key in ["stdio", "stderr"]:
		var stream = manual.get(key)
		if stream == null: continue
		var available := mini(64 * 1024, int(stream.get_length()))
		if available > 0: stream.get_buffer(available)
func find_plugin(node: Node) -> EditorPlugin:
	var script = node.get_script()
	if script != null and script.resource_path == "res://addons/devcel/editor/plugin.gd": return node
	for child in node.get_children():
		var found := find_plugin(child)
		if found != null: return found
	return null
func check(ok: bool, label: String):
	checks += 1
	print("AUTO_CHECK ", checks, ": ", label, " = ", ok)
	if not ok: failures.append(label)
func wait_for(condition: Callable, label: String, seconds := 20.0):
	var deadline := Time.get_ticks_msec() + int(seconds * 1000)
	while not condition.call() and Time.get_ticks_msec() < deadline: await get_tree().process_frame
	check(bool(condition.call()), label)
func pause(seconds: float): await get_tree().create_timer(seconds).timeout
func idle(): await wait_for(func(): return not importer._busy, "Pull idle")
func connected(id: String) -> bool: return bool(importer._sync.state(id).get("connected", false))
func path(source: Dictionary, key: String) -> String:
	return importer._absolute(str(source[key])) if str(source[key]).is_absolute_path() else ProjectSettings.globalize_path(importer.CONFIG).get_base_dir().path_join(str(source[key])).simplify_path()
func value(source: Dictionary) -> int:
	var db = Database.new()
	if not db.load_file(path(source,"runtime_out")): return -999
	return db.by_id("Items", "11111111-1111-4111-8111-111111111111").get_int("hp")
func call_cli(arguments: Array) -> Dictionary:
	var out: Array = []
	var result := OS.execute(cli, PackedStringArray(arguments), out, false)
	var parsed = JSON.parse_string("".join(out))
	return parsed if parsed is Dictionary else {"ok": false, "exit": result, "output": out}
func mutate(source: Dictionary, new_value: int, mode := "client"):
	var result := call_cli(["--mode", mode, "--project", path(source,"project"), "cell", "set", "Items", "11111111-1111-4111-8111-111111111111", "hp", str(new_value)])
	if not result.get("ok", false): print("MUTATION_ERROR ", JSON.stringify(result))
	check(result.get("ok", false), "saved mutation " + str(source.id) + ": " + str(new_value))
func server_running(source: Dictionary) -> bool:
	return call_cli(["--project", path(source,"project"), "status"]).get("data", {}).get("server_running", false)
func modes(values: Dictionary):
	var config := ConfigFile.new(); config.set_value("pull", "sync_modes", values); config.save(importer.EDITOR_CONFIG)
	importer._reload_if_changed()
func write_sources(values: Array):
	var file := FileAccess.open(importer.CONFIG, FileAccess.WRITE)
	file.store_string(JSON.stringify({"schema_version": 1, "sources": values})); file.close()
	importer._reload_if_changed()
func run():
	for i in 15: await get_tree().process_frame
	importer = find_plugin(get_tree().root)
	if importer == null: check(false, "importer present"); finish(); return
	sources = importer._sources.duplicate(true)
	cli = importer.PullRunner.resolve_cli()
	if "--auto-reload" in OS.get_cmdline_user_args():
		await pause(2)
		check(importer._sync_modes.get("base") == "Off" and importer._sync_modes.get("event") == "Off", "restart keeps saved Off")
		check(importer._sync._detectors.base._process.is_empty() and importer._sync._detectors.event._process.is_empty(), "restart with Off makes no watch demand")
		check(sources[0].version == 0 and sources[1].version == 4294967295 and sources[0].class_name == "BaseData" and sources[1].class_name == "EventData", "restart preserves metadata and version")
		finish(); return
	check(importer._sync_modes.is_empty(), "missing source modes remain absent on disk")
	await wait_for(func(): return connected("base") and connected("event"), "two absent-mode sources acquire servers automatically")
	await idle()
	importer._open_wizard(-1)
	check(is_instance_valid(importer._wizard) and importer._wizard._sync_mode.get_item_text(importer._wizard._sync_mode.selected) == "Auto", "new source wizard defaults Auto")
	importer._wizard._dismiss(); await get_tree().process_frame
	importer._select(0); importer._show_details()
	check(Locale.text("自動取り込み: Auto", "Automatic import: Auto") in importer._details.text, "missing mode is displayed as Auto")
	mutate(sources[0], 123); mutate(sources[1], 456)
	await wait_for(func(): return value(sources[0]) == 123 and value(sources[1]) == 456, "both sources automatically import saved edits")
	await idle()
	check("class BaseData" in FileAccess.get_file_as_string(path(sources[0],"code_out")), "C# custom class preserved")
	check("struct EventData" in FileAccess.get_file_as_string(path(sources[1],"code_out")) or "class EventData" in FileAccess.get_file_as_string(path(sources[1],"code_out")), "C++ custom class preserved")
	for source in sources:
		var db = Database.new(); db.load_file(path(source, "runtime_out"))
		check(db.manifest().get("content_version") == source.version and db.manifest().get("mode") == source.mode, "automatic Pull preserves version and full/minimal: " + str(source.id))
	var code_before := FileAccess.get_sha256(path(sources[1], "code_out"))
	var schema_result := call_cli(["--mode", "client", "--project", path(sources[0], "project"), "column", "add", "Items", "new_stat", "I32"])
	check(schema_result.get("ok", false), "add real source schema column")
	await wait_for(func(): return "NewStat" in FileAccess.get_file_as_string(path(sources[0], "code_out")), "Auto schema edit regenerates C# without Pull button")
	check(FileAccess.get_sha256(path(sources[1], "code_out")) == code_before, "schema change preserves other source generated code")
	await idle()
	var event_detector = importer._sync._detectors.event
	var event_watch_pid = event_detector._process.get("pid")
	modes({"base":"Off"})
	check(importer._sync._detectors.event == event_detector and event_detector._process.get("pid") == event_watch_pid, "Off releases only selected source watcher")
	await pause(6)
	check(not server_running(sources[0]) and server_running(sources[1]), "last base demand stops auto-server without touching event")
	var held := FileAccess.get_sha256(path(sources[0],"runtime_out"))
	mutate(sources[0], 124, "local"); mutate(sources[1], 457)
	await wait_for(func(): return value(sources[1]) == 457, "other source continues after Off")
	check(FileAccess.get_sha256(path(sources[0],"runtime_out")) == held, "explicit Off preserves runtime")
	await idle(); modes({"base":"FileWatch"})
	mutate(sources[0], 125, "local")
	await wait_for(func(): return value(sources[0]) == 125, "FileWatch still imports saved data")
	check(not server_running(sources[0]), "FileWatch makes no server demand")
	await idle(); modes({"base":"P2P"})
	await wait_for(func(): return connected("base"), "P2P also starts server automatically")
	mutate(sources[0], 126)
	await wait_for(func(): return value(sources[0]) == 126, "P2P auto-server changes import")
	await idle()
	var base_detector = importer._sync._detectors.base
	write_sources([sources[0]])
	check(not importer._sync._detectors.has("event") and importer._sync._detectors.base == base_detector, "removal releases only removed source watcher")
	await pause(6)
	check(not server_running(sources[1]) and server_running(sources[0]), "removed source auto-server stops; retained source remains")
	# Re-add an invalid independent source; the healthy source must still publish.
	var bad_project := path(sources[1],"project")
	var original := FileAccess.get_file_as_string(bad_project)
	var f := FileAccess.open(bad_project, FileAccess.WRITE); f.store_string("malformed TOML ["); f.close()
	write_sources(sources)
	await pause(2)
	check(not connected("event") and not str(importer._sync.state("event").get("error", "")).is_empty(), "invalid source shows independent startup failure")
	mutate(sources[0], 127)
	await wait_for(func(): return value(sources[0]) == 127, "healthy source continues during other source failure")
	f = FileAccess.open(bad_project, FileAccess.WRITE); f.store_string(original); f.close()
	await wait_for(func(): return connected("event"), "failed source automatically recovers after repair")
	await idle(); modes({"base":"Off", "event":"Off"}); await pause(6)
	check(not server_running(sources[0]) and not server_running(sources[1]), "Off releases all automatic demand")
	manual = OS.execute_with_pipe(cli, PackedStringArray(["--project", path(sources[0],"project"), "serve"]), false)
	await pause(2)
	check(not manual.is_empty() and OS.is_process_running(int(manual.get("pid", -1))), "manual server starts")
	modes({"base":"Auto", "event":"Off"})
	await wait_for(func(): return connected("base"), "Auto reuses existing manual server")
	await idle(); modes({"base":"Off", "event":"Off"}); await pause(6)
	check(server_running(sources[0]) and OS.is_process_running(int(manual.get("pid", -1))), "Off leaves manual server running")
	# Malformed settings must not silently replace explicit Off with default Auto.
	var saved := FileAccess.get_file_as_string(importer.EDITOR_CONFIG)
	f = FileAccess.open(importer.EDITOR_CONFIG, FileAccess.WRITE); f.store_string("[pull]\nsync_modes=\"broken\"\n"); f.close(); importer._reload_if_changed()
	check(not importer._config_error.is_empty() and importer._sync._detectors.is_empty(), "malformed local modes fail closed")
	f = FileAccess.open(importer.EDITOR_CONFIG, FileAccess.WRITE); f.store_string(saved); f.close(); importer._reload_if_changed()
	check(importer._sync_modes.get("base") == "Off" and importer._sync_modes.get("event") == "Off", "explicit Off is restored unchanged")
	for cycle in 20:
		modes({"base":"Auto", "event":"Off"})
		await wait_for(func(): return connected("base"), "repeat Auto connected " + str(cycle))
		await idle()
		modes({"base":"Off", "event":"Off"})
		await pause(0.2)
	await pause(1)
	var process_out: Array = []
	OS.execute("/bin/ps", PackedStringArray(["-o", "stat=", "--ppid", str(OS.get_process_id())]), process_out)
	var zombie_count := 0
	for row in "".join(process_out).split("\n"):
		if row.strip_edges().begins_with("Z"): zombie_count += 1
	check(zombie_count == 0, "20 Auto/Off cycles leave no zombie children")
	finish()
func finish():
	if importer != null: importer._sync.stop()
	if not manual.is_empty():
		# This still-running pipe child belongs solely to this disposable test.
		if OS.is_process_running(manual.pid): OS.kill(manual.pid)
		for key in ["stdio", "stderr"]:
			if manual.get(key) != null: manual[key].close()
	var f := FileAccess.open("res://auto-reload-result.json" if "--auto-reload" in OS.get_cmdline_user_args() else "res://auto-result.json", FileAccess.WRITE)
	f.store_string(JSON.stringify({"checks":checks,"failures":failures,"ok":failures.is_empty()}, "  ")); f.close()
	print("GODOT_AUTO_RESULT ", checks, "; failures=", failures)
	get_tree().quit(0 if failures.is_empty() else 1)
