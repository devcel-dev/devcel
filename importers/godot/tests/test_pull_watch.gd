extends SceneTree
const PullSync = preload("res://addons/devcel/editor/devcel_pull_sync.gd")
const Runner = preload("res://addons/devcel/editor/devcel_pull_runner.gd")
const Database = preload("res://addons/devcel/runtime/devcel_database.gd")
var sync = PullSync.new()
var runner = Runner.new()
var cli := ""
var config_path := ""
var config: Dictionary
var mode := "FileWatch"
var phase := 0
var elapsed := 0.0
var stopped_at := 0.0
var server: Dictionary = {}
var baseline_hash := ""
var active_id := ""

func _initialize():
	var args := OS.get_cmdline_user_args()
	if args.size() < 1: fail("Usage: -- CONFIG [FileWatch|Auto|P2P]"); return
	var prepared: Dictionary = Runner.prepare_cli()
	if not prepared.ok: fail(str(prepared.error)); return
	cli = prepared.path; config_path = args[0]
	if args.size() > 1: mode = args[1]
	config = JSON.parse_string(FileAccess.get_file_as_string(config_path))
	baseline_hash = FileAccess.get_sha256(resolved(config.sources[0].runtime_out))
	if mode == "P2P": server = OS.execute_with_pipe(cli, PackedStringArray(["--project", resolved(config.sources[1].project), "serve"]), false)
	sync.configure(config.sources, {"base": "Off", "event": mode}, config_path)

func resolved(path: String) -> String:
	return path if path.is_absolute_path() else ProjectSettings.globalize_path(config_path).get_base_dir().path_join(path)

func mutate(value: String) -> bool:
	var output: Array = []
	var execution_mode := "client" if mode == "P2P" else "local"
	var exit_code := OS.execute(cli, PackedStringArray(["--mode", execution_mode, "--project", resolved(config.sources[1].project), "cell", "set", "Items", "11111111-1111-4111-8111-111111111111", "hp", value]), output, false)
	return exit_code == 0

func _process(delta: float) -> bool:
	elapsed += delta
	if elapsed > 30: fail("watch timeout phase=" + str(phase) + " state=" + JSON.stringify(sync.state("event"))); return false
	sync.tick()
	if phase == 2:
		if not sync.next_source().is_empty(): fail("Off/stop queued an import"); return false
		if elapsed - stopped_at > 1.5:
			var db = Database.new()
			if not db.load_file(resolved(config.sources[1].runtime_out)) or db.by_id("Items", "11111111-1111-4111-8111-111111111111").get_int("hp") != 777: fail("stop changed output"); return false
			finish(); return false
		return false
	if runner.running():
		var result: Dictionary = runner.poll()
		if not result.get("done", false): return false
		sync.completed(active_id, bool(result.get("ok", false)))
		if not result.get("ok", false): fail("pull failed " + JSON.stringify(result)); return false
		if phase == 0:
			if not mutate("777"): fail("source mutation failed"); return false
			phase = 1
		elif phase == 1:
			var db = Database.new()
			if not db.load_file(resolved(config.sources[1].runtime_out)): fail(db.last_error); return false
			# A P2P notification may precede delayed disk save. The saved-file watcher
			# must queue another pull after the source actually reaches disk.
			if db.by_id("Items", "11111111-1111-4111-8111-111111111111").get_int("hp") != 777: return false
			if FileAccess.get_sha256(resolved(config.sources[0].runtime_out)) != baseline_hash: fail("Off source was rewritten"); return false
			sync.stop(); phase = 2; stopped_at = elapsed
			if not mutate("888"): fail("stop mutation failed"); return false
	else:
		active_id = sync.next_source()
		if not active_id.is_empty():
			if active_id != "event": fail("wrong source queued " + active_id); return false
			if not runner.start(config_path, active_id): fail(runner.last_error)
	return false

func close_server():
	if not server.is_empty():
		if OS.is_process_running(server.pid): OS.kill(server.pid)
		for key in ["stdio", "stderr"]:
			if server.get(key) != null: server[key].close()
		server = {}

func finish():
	sync.stop(); close_server()
	print("DEVCEL_PULL_WATCH_OK: ", mode, "; saved-source change -> isolated automatic Pull; Off/stop keeps output")
	quit(0)

func fail(message: String):
	if not server.is_empty():
		for key in ["stdio", "stderr"]:
			var stream = server.get(key)
			if stream != null and stream.get_length() > 0: print("SERVER ", key, ": ", stream.get_buffer(mini(65536, stream.get_length())).get_string_from_utf8())
	sync.stop(); close_server(); push_error(message); quit(1)
