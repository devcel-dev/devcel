@tool
extends EditorPlugin
var importer: EditorPlugin
func _enter_tree(): call_deferred("run")
func find_plugin(node: Node) -> EditorPlugin:
	var script = node.get_script()
	if script != null and script.resource_path == "res://addons/devcel/editor/plugin.gd": return node
	for child in node.get_children():
		var found := find_plugin(child)
		if found != null: return found
	return null
func run():
	for i in 15: await get_tree().process_frame
	importer = find_plugin(get_tree().root)
	var deadline := Time.get_ticks_msec() + 20000
	while (not importer._sync.state("base").get("connected", false) or not importer._sync.state("event").get("connected", false) or importer._busy) and Time.get_ticks_msec() < deadline: await get_tree().process_frame
	if not importer._sync.state("base").get("connected", false) or not importer._sync.state("event").get("connected", false): get_tree().quit(1); return
	var marker := FileAccess.open("res://lifecycle-ready.json", FileAccess.WRITE)
	marker.store_string(JSON.stringify({"watchers": [importer._sync._detectors.base._process.pid, importer._sync._detectors.event._process.pid]})); marker.close()
	if "--disable" in OS.get_cmdline_user_args():
		get_editor_interface().set_plugin_enabled("devcel", false)
		await get_tree().create_timer(7).timeout
		var out: Array = []
		OS.execute("/bin/ps", PackedStringArray(["-o", "stat=", "--ppid", str(OS.get_process_id())]), out)
		var clean := true
		for row in "".join(out).split("\n"):
			if row.strip_edges().begins_with("Z"): clean = false
		marker = FileAccess.open("res://lifecycle-disabled.json", FileAccess.WRITE)
		marker.store_string(JSON.stringify({"no_zombies":clean,"plugin_removed":find_plugin(get_tree().root) == null})); marker.close()
		get_tree().quit(0 if clean else 1)
	elif "--exit" in OS.get_cmdline_user_args(): get_tree().quit(0)
