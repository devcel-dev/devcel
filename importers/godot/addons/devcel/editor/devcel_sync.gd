@tool
extends RefCounted
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
## Editor-only change detection. The caller performs exports; existing Studio/serve instances are not stopped.
## The caller pulls the saved source after receiving a change notification from tick().
const WatchReaper = preload("devcel_watch_reaper.gd")
const SCAN_INTERVAL_MS = 500
const SCAN_BUDGET_USEC = 2000
const SCAN_ENTRIES_PER_TICK = 64
const SCAN_BYTES_PER_TICK = 256 * 1024
const READ_CHUNK = 16 * 1024
const PIPE_BYTES_PER_TICK = 64 * 1024
const MAX_LINE_BYTES = 256 * 1024
const SNAPSHOT_PREFIX = '{"event":"snapshot",'
const MAX_STDERR_BYTES = 32 * 1024
const CONNECT_TIMEOUT_MS = 15000
const RETRY_MIN_MS = 500
const RETRY_MAX_MS = 30000

var connected: bool = false
var status: String = Locale.text("同期: Off", "Sync: Off")
var last_error: String = ""
var _mode: String = "Off"
var _project: String = ""
var _root: String = ""
var _debounce_ms: int = 500
var _config_error: String = ""
var _file_error: String = ""
var _p2p_error: String = ""
var _pending: bool = false
var _changed_at: int = 0
var _process: Dictionary = {}
var _phase: String = ""
var _stdout = PackedByteArray()
var _stderr = PackedByteArray()
var _large_snapshot: bool = false
var _process_started: int = 0
var _next_probe: int = 0
var _retry_ms: int = RETRY_MIN_MS
var _next_scan: int = 0
var _scanning: bool = false
var _baseline_ready: bool = false
var _baseline: Dictionary = {}
var _snapshot: Dictionary = {}
var _scan_changed: bool = false
var _directories: Array[String] = []
var _directory: DirAccess
var _file: FileAccess
var _hash: HashingContext
var _hash_path: String = ""
var _hash_size: int = 0
var _hash_remaining: int = 0

func configure(project: String, mode: String, debounce_ms: int):
	stop()
	_mode = mode
	if _mode not in ["Off", "FileWatch", "P2P", "Auto"]:
		_config_error = Locale.text("同期モードはOff / FileWatch / P2P / Autoです", "Sync mode must be Off / FileWatch / P2P / Auto")
		_mode = "Off"
	if _mode == "Off":
		_refresh_status()
		return
	_project = _absolute(project)
	_debounce_ms = clampi(debounce_ms, 0, 60000)
	if _project.is_empty():
		_config_error = Locale.text("監視するDevcelプロジェクトを指定してください", "Specify a Devcel project to watch")
	elif not FileAccess.file_exists(_project):
		_config_error = Locale.text("Devcelプロジェクトが見つかりません: ", "Devcel project not found: ") + _project
	else:
		_root = _project.get_base_dir()
	_refresh_status()

func tick() -> Dictionary:
	var now = Time.get_ticks_msec()
	if _mode != "Off" and _config_error.is_empty():
		_tick_files(now)
		if _mode in ["P2P", "Auto"]: _tick_p2p(now)
	_refresh_status()
	var changed = _pending and now - _changed_at >= _debounce_ms
	# P2P requires a connection. Do not start a local export from stale notifications after disconnection.
	if _mode == "P2P" and not connected: changed = false
	if changed: _pending = false
	return {"changed": changed, "connected": connected,
		"status": status, "error": last_error}

func stop():
	_close_process()
	_close_scan()
	_mode = "Off"
	connected = false
	_pending = false
	_baseline_ready = false
	_baseline.clear()
	_snapshot.clear()
	_next_scan = 0
	_next_probe = 0
	_retry_ms = RETRY_MIN_MS
	_config_error = ""
	_file_error = ""
	_p2p_error = ""
	last_error = ""
	status = Locale.text("同期: Off", "Sync: Off")

func _notification(what):
	if what != NOTIFICATION_PREDELETE: return
	# During shutdown, avoid calling self methods so cleanup does not depend on the script's release order.
	if not _process.is_empty():
		# stdin EOF ends only our CLI watcher, including abrupt Editor shutdown.
		for key in ["stdio", "stderr"]:
			if _process.get(key) != null: _process[key].close()
		WatchReaper.retire(int(_process.get("pid", -1)))
	if _file != null: _file.close()
	if _directory != null: _directory.list_dir_end()

func _queue_change():
	_pending = true
	_changed_at = Time.get_ticks_msec()

func _tick_files(now: int):
	if not _scanning:
		if now < _next_scan: return
		_scanning = true
		_snapshot = {}
		_scan_changed = not _baseline_ready
		_directories = [_root]
	var started = Time.get_ticks_usec()
	var entries = 0
	var bytes_read = 0
	while entries < SCAN_ENTRIES_PER_TICK and bytes_read < SCAN_BYTES_PER_TICK and Time.get_ticks_usec() - started < SCAN_BUDGET_USEC:
		if _file != null:
			var bytes = _file.get_buffer(mini(READ_CHUNK, _hash_remaining))
			if bytes.is_empty() and _hash_remaining > 0:
				_file_failure(Locale.text("監視中にファイルが変更されたか読めなくなりました: ", "A watched file changed or became unreadable: ") + _hash_path)
				return
			if not bytes.is_empty(): _hash.update(bytes)
			bytes_read += bytes.size()
			_hash_remaining -= bytes.size()
			if _hash_remaining > 0: continue
			if _file.get_length() != _hash_size or not FileAccess.file_exists(_hash_path):
				_file_failure(Locale.text("監視中にファイルが更新されました。再走査します: ", "A watched file changed. Scanning again: ") + _hash_path)
				return
			var digest = _hash.finish().hex_encode()
			_snapshot[_hash_path] = digest
			if _baseline.get(_hash_path, "") != digest: _scan_changed = true
			_file.close()
			_file = null
			_hash = null
			entries += 1
			continue
		if _directory == null:
			if _directories.is_empty():
				_finish_scan(now)
				return
			var path = _directories.pop_back()
			_directory = DirAccess.open(path)
			if _directory == null:
				_file_failure(Locale.text("監視フォルダを読めません: ", "Cannot read watched folder: ") + path)
				return
			_directory.include_hidden = false
			_directory.include_navigational = false
			if _directory.list_dir_begin() != OK:
				_file_failure(Locale.text("監視フォルダを列挙できません: ", "Cannot list watched folder: ") + path)
				return
		var name = _directory.get_next()
		entries += 1
		if name.is_empty():
			_directory.list_dir_end()
			_directory = null
			continue
		# Do not follow hidden items, symlinks, or junctions, preventing cycles and traversal outside the watched scope.
		if name.begins_with(".") or _directory.is_link(name): continue
		var path = _directory.get_current_dir().path_join(name)
		if _directory.current_is_dir():
			_directories.append(path)
			continue
		if not (name.ends_with(".table.toml") or name.ends_with(".interface.toml") or name.ends_with(".devcelproj.toml")): continue
		_file = FileAccess.open(path, FileAccess.READ)
		if _file == null:
			_file_failure(Locale.text("監視ファイルを読めません: ", "Cannot read watched file: ") + path)
			return
		_hash_path = path
		_hash_size = _file.get_length()
		_hash_remaining = _hash_size
		_hash = HashingContext.new()
		_hash.start(HashingContext.HASH_SHA256)

func _finish_scan(now: int):
	var changed = _scan_changed or _snapshot.size() != _baseline.size()
	_baseline = _snapshot
	_snapshot = {}
	_baseline_ready = true
	_file_error = ""
	_close_scan()
	_next_scan = now + SCAN_INTERVAL_MS
	if changed: _queue_change()

func _file_failure(message: String):
	_file_error = message
	_close_scan()
	_snapshot.clear()
	_next_scan = Time.get_ticks_msec() + SCAN_INTERVAL_MS

func _close_scan():
	if _file != null: _file.close()
	if _directory != null: _directory.list_dir_end()
	_file = null
	_hash = null
	_directory = null
	_directories.clear()
	_scanning = false

func _tick_p2p(now: int):
	if _process.is_empty():
		if now < _next_probe: return
		_start_process()
		return
	_drain_stdout()
	if _process.is_empty(): return
	_drain_stderr()
	_consume_watch_lines()
	if _process.is_empty(): return
	if not connected and now - _process_started >= CONNECT_TIMEOUT_MS:
		_retry(Locale.text("P2Pサーバーの自動起動・接続がタイムアウトしました", "P2P server startup or connection timed out") + _diagnostic())
		return
	if OS.is_process_running(_process.pid): return
	# Drain final output across multiple frames within the budget.
	if _pipe_available("stdio") > 0 or _pipe_available("stderr") > 0: return
	if _stdout.find(10) >= 0: return
	if not _stdout.is_empty() and not _large_snapshot:
		_watch_line(_stdout.get_string_from_utf8())
		if _process.is_empty(): return
	_retry(Locale.text("P2P接続が終了しました", "P2P connection ended") + _diagnostic())

func _start_process():
	WatchReaper.ensure_started()
	var prepared: Dictionary = preload("devcel_pull_runner.gd").prepare_cli()
	if not prepared.ok:
		_retry(str(prepared.error)); return
	var executable := str(prepared.path)
	_phase = "watch"
	_process_started = Time.get_ticks_msec()
	# The CLI acquires/reuses a project-scoped server and owns lease cleanup.
	# Never spawn or stop serve from the importer itself.
	_process = OS.execute_with_pipe(executable, PackedStringArray(["--project", _project, "watch", "--ensure-server", "--parent-stdin"]), false)
	if _process.is_empty(): _retry(Locale.text("同梱CLIを起動できません。現在のOS/CPUに対応するアドオンを入れ直してください: ", "Cannot launch the bundled CLI. Reinstall the addon for this OS/CPU: ") + executable)

func _drain_stdout():
	var stream = _process.get("stdio")
	if stream == null: return
	var room = MAX_LINE_BYTES + PIPE_BYTES_PER_TICK - _stdout.size()
	var available = mini(mini(PIPE_BYTES_PER_TICK, room), int(stream.get_length()))
	if available > 0: _stdout.append_array(stream.get_buffer(available))

func _drain_stderr():
	var stream = _process.get("stderr")
	if stream == null: return
	var available = mini(PIPE_BYTES_PER_TICK, int(stream.get_length()))
	if available > 0: _stderr.append_array(stream.get_buffer(available))
	if _stderr.size() > MAX_STDERR_BYTES:
		_stderr = _stderr.slice(_stderr.size() - MAX_STDERR_BYTES)
		# Keep diagnostic UTF-8 valid even when the ring boundary splits Japanese text.
		while not _stderr.is_empty() and (_stderr[0] & 0xc0) == 0x80:
			_stderr = _stderr.slice(1)

func _consume_watch_lines():
	for _line_index in range(128):
		var newline = _stdout.find(10)
		if newline < 0:
			if _large_snapshot:
				_stdout.clear()
			elif _stdout.size() > MAX_LINE_BYTES:
				# The current CLI emits event first; parsing the entire large snapshot is unnecessary.
				if _stdout.slice(0, SNAPSHOT_PREFIX.length()) == SNAPSHOT_PREFIX.to_utf8_buffer():
					_large_snapshot = true
					_stdout.clear()
				else:
					_retry(Locale.text("P2P watchのJSONL一行が上限を超えました", "P2P watch JSONL line exceeded the limit"))
			return
		var line = _stdout.slice(0, newline)
		_stdout = _stdout.slice(newline + 1)
		if _large_snapshot:
			_large_snapshot = false
			if connected: _queue_change()
		else:
			_watch_line(line.get_string_from_utf8())
			if _process.is_empty(): return

func _watch_line(line: String):
	if line.strip_edges().is_empty(): return
	var parser = JSON.new()
	if parser.parse(line) != OK or not parser.data is Dictionary:
		_retry(Locale.text("P2P watchから不正なJSONLを受信しました", "Received invalid JSONL from P2P watch"))
		return
	var event = parser.data
	match str(event.get("event", "")):
		"connected":
			connected = true
			_p2p_error = ""
			_retry_ms = RETRY_MIN_MS
			_queue_change()
		"snapshot":
			if connected: _queue_change()
		"disconnected":
			_retry(Locale.text("P2Pサーバーとの接続が切れました", "Disconnected from the P2P server"))
		_:
			if event.get("ok") == false:
				_retry(Locale.text("P2P watch失敗: ", "P2P watch failed: ") + str(event.get("error", Locale.text("不明なエラー", "Unknown error"))))

func _retry(message: String):
	var was_connected = connected
	_close_process()
	connected = false
	_p2p_error = message
	_next_probe = Time.get_ticks_msec() + _retry_ms
	_retry_ms = mini(RETRY_MAX_MS, _retry_ms * 2)
	# Auto returns to saved files after the server stops and exports again on reconnection.
	if was_connected and _mode == "Auto": _queue_change()

func _close_process():
	if not _process.is_empty():
		# Closing stdio releases this watcher's parent-stdin lease. Never kill a
		# numeric PID: Godot cannot distinguish a reused PID from our old child.
		# The CLI owns bounded shutdown and shared-server lease cleanup.
		for key in ["stdio", "stderr"]:
			if _process.get(key) != null: _process[key].close()
		WatchReaper.retire(int(_process.get("pid", -1)))
	_process = {}
	_phase = ""
	_stdout.clear()
	_stderr.clear()
	_large_snapshot = false

func _pipe_available(key: String) -> int:
	var stream = _process.get(key)
	return int(stream.get_length()) if stream != null else 0

func _diagnostic() -> String:
	var text = _stderr.get_string_from_utf8().strip_edges()
	return "\n" + text.right(2048) if not text.is_empty() else ""

func _refresh_status():
	last_error = _config_error
	if not _file_error.is_empty(): last_error += ("\n" if not last_error.is_empty() else "") + _file_error
	if not _p2p_error.is_empty(): last_error += ("\n" if not last_error.is_empty() else "") + _p2p_error
	if _mode == "Off": status = Locale.text("同期: Off", "Sync: Off")
	elif not _config_error.is_empty(): status = Locale.text("同期設定を確認してください", "Check the sync settings")
	elif _mode == "FileWatch": status = Locale.text("FileWatch: 保存ファイルを監視中", "FileWatch: Watching saved files")
	elif connected: status = _mode + Locale.text(": P2P接続中", ": P2P connected")
	elif not _p2p_error.is_empty():
		var seconds := maxi(0, int(ceil(float(_next_probe - Time.get_ticks_msec()) / 1000.0)))
		status = _mode + ": " + (Locale.text("保存ファイルを監視中 / ", "Watching saved files / ") if _mode == "Auto" else "") + (Locale.text("%d秒後に自動再試行", "Retrying automatically in %d seconds") % seconds if _process.is_empty() else Locale.text("接続を再試行中", "Retrying connection"))
	else: status = _mode + Locale.text(": サーバーを自動準備・接続中", ": Starting server and connecting") + (Locale.text("（保存ファイルも監視）", " (also watching saved files)") if _mode == "Auto" else "")

static func _absolute(path: String) -> String:
	if path.strip_edges().is_empty(): return ""
	if path.begins_with("res://") or path.begins_with("user://"):
		return ProjectSettings.globalize_path(path).simplify_path()
	return path.simplify_path() if path.is_absolute_path() else ProjectSettings.globalize_path("res://" + path).simplify_path()

