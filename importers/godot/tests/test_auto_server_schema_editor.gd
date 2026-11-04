@tool
extends EditorPlugin
var importer: EditorPlugin
var failures: Array[String] = []
var checks := 0
func _enter_tree(): call_deferred("run")
func find_plugin(node: Node) -> EditorPlugin:
	var script = node.get_script()
	if script != null and script.resource_path == "res://addons/devcel/editor/plugin.gd": return node
	for child in node.get_children():
		var found := find_plugin(child)
		if found != null: return found
	return null
func check(ok: bool, label: String):
	checks += 1; print("SCHEMA_CHECK ", label, " = ", ok)
	if not ok: failures.append(label)
func wait_for(condition: Callable, label: String):
	var deadline := Time.get_ticks_msec() + 20000
	while not condition.call() and Time.get_ticks_msec() < deadline: await get_tree().process_frame
	check(bool(condition.call()), label)
func run():
	for i in 15: await get_tree().process_frame
	importer = find_plugin(get_tree().root)
	await wait_for(func(): return importer._sync.state("base").get("connected",false) and importer._sync.state("event").get("connected",false) and not importer._busy, "both sources live")
	var sources: Array = importer._sources.duplicate(true)
	var base: Dictionary = sources[0]; var event: Dictionary = sources[1]
	await wait_for(func(): return FileAccess.file_exists(base.code_out) and FileAccess.file_exists(event.code_out), "initial generated outputs exist")
	await wait_for(func(): return not importer._busy, "initial generation completes")
	var event_hash := FileAccess.get_sha256(event.code_out)
	var cli: String = importer.PullRunner.resolve_cli()
	var out: Array = []
	var code := OS.execute(cli,PackedStringArray(["--mode","client","--project",base.project,"column","add","Items","late_stat","I32"]),out,false)
	check(code == 0,"real CLI schema column added")
	await wait_for(func(): return "LateStat" in FileAccess.get_file_as_string(base.code_out),"column addition auto-regenerates C#")
	await wait_for(func(): return not importer._busy,"idle after schema generation")
	var table: String = str(base.project).get_base_dir().path_join("Tables/Items.table.toml")
	var toml := FileAccess.get_file_as_string(table)
	var blocks := toml.split("[[schema.columns]]")
	var found := false
	for index in range(1,blocks.size()):
		if 'data_name = "late_stat"' in blocks[index]:
			if "min_version = 0" in blocks[index]:
				blocks[index] = blocks[index].replace("min_version = 0", "min_version = 1")
			else:
				blocks[index] = "\nmin_version = 1" + blocks[index]
			found = true
	check(found,"saved column version located")
	var f := FileAccess.open(table,FileAccess.WRITE);f.store_string("[[schema.columns]]".join(blocks));f.close()
	await wait_for(func(): return not "LateStat" in FileAccess.get_file_as_string(base.code_out),"saved column version change auto-removes excluded code")
	check(FileAccess.get_sha256(event.code_out) == event_hash,"other namespace/output remains unchanged")
	await wait_for(func(): return not importer._busy,"idle before version change")
	base.version = 1
	f = FileAccess.open(importer.CONFIG,FileAccess.WRITE);f.store_string(JSON.stringify({"schema_version":1,"sources":sources}));f.close()
	await wait_for(func(): return "LateStat" in FileAccess.get_file_as_string(base.code_out),"source version switch auto-regenerates included code")
	check(JSON.parse_string(FileAccess.get_file_as_string(base.runtime_out)).manifest.content_version == 1,"new version reaches runtime manifest")
	check(FileAccess.get_sha256(event.code_out) == event_hash,"version switch leaves other output unchanged")
	f = FileAccess.open("res://schema-version-result.json",FileAccess.WRITE);f.store_string(JSON.stringify({"ok":failures.is_empty(),"checks":checks,"failures":failures},"  "));f.close()
	print("GODOT_SCHEMA_VERSION_RESULT ", checks, " failures=", failures)
	get_tree().quit(0 if failures.is_empty() else 1)
