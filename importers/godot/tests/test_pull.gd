extends SceneTree
const Runner = preload("res://addons/devcel/editor/devcel_pull_runner.gd")
const Projects = preload("res://addons/devcel/runtime/devcel_project_set.gd")
var runner = Runner.new()
var config := ""
var phase := 0
var elapsed := 0.0
var dbs = Projects.new()

func _initialize():
	var args := OS.get_cmdline_user_args()
	if args.size() != 1: push_error("Usage: -- <config>"); quit(1); return
	config = args[0]
	if not runner.start(config, "event"): push_error(runner.last_error); quit(1)

func _process(delta: float) -> bool:
	elapsed += delta
	if elapsed > 30: push_error("pull timeout"); quit(1); return false
	var result: Dictionary = runner.poll()
	if not result.get("done", false): return false
	if not result.get("ok", false): push_error(JSON.stringify(result)); quit(1); return false
	if phase == 0:
		phase = 1
		if not runner.start(config, "event", true): push_error(runner.last_error); quit(1)
		return false
	if result.data.sources[0].status != "ready": push_error("expected ready"); quit(1); return false
	var settings: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(config))
	if not dbs.add_source("base", "Game.Base", settings.sources[0].runtime_out) or not dbs.add_source("event", "Game.Event", settings.sources[1].runtime_out): push_error(dbs.last_error); quit(1); return false
	var row := "11111111-1111-4111-8111-111111111111"
	if dbs.source("base").by_id("Items", row).get_int("hp") != 7 or dbs.source("event").by_id("Items", row).get_int("hp") != 123: push_error("same UUID source isolation failed"); quit(1); return false
	if dbs.add_source("collision", "game.base", settings.sources[1].runtime_out): push_error("namespace collision accepted"); quit(1); return false
	print("DEVCEL_PULL_OK: CLI pull/status, full/minimal readers, same UUID isolation, namespace collision")
	quit(0)
	return false
