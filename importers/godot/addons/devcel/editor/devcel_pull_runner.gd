@tool
extends RefCounted
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
## Non-blocking title-side pull runner. CLI owns validation, source isolation and publication.
var last_error := ""
var _process: Dictionary = {}
var _stdout := PackedByteArray()
var _stderr := PackedByteArray()
var _arguments := PackedStringArray()
var _phase := ""
var _read_only_query := false
var _started := 0
var _binary_hash := ""
const PROBE_TIMEOUT_MS := 10000
const MAX_OUTPUT_BYTES := 4 * 1024 * 1024

static func cli_platform() -> String:
	var system := "win" if OS.get_name() == "Windows" else "osx" if OS.get_name() == "macOS" else "linux" if OS.get_name() == "Linux" else "unsupported"
	var machine := Engine.get_architecture_name()
	var architecture := "x64" if machine == "x86_64" else "arm64" if machine == "arm64" else "unsupported"
	return system + "-" + architecture

static func resolve_cli() -> String:
	return ProjectSettings.globalize_path("res://addons/devcel/bin/" + cli_platform() + ("/devcel.exe" if OS.get_name() == "Windows" else "/devcel"))

## Call immediately before every process launch, including internal probes and watch restarts.
## Only the exact manifest-verified bundled binary may have its owner execute bit restored.
static func prepare_cli() -> Dictionary:
	var platform := cli_platform()
	if "unsupported" in platform:
		return _cli_failure(Locale.text("このOS/CPUには同梱CLIが対応していません: ", "The bundled CLI does not support this OS/CPU: ") + platform + Locale.text("。対応する環境とアドオンを使用してください。", ". Use a supported environment and addon."))
	var root := ProjectSettings.globalize_path("res://addons/devcel").simplify_path()
	var bundled := root.path_join("bin")
	var absolute := resolve_cli().simplify_path()
	var manifest_path := bundled.path_join("manifest.json")
	for path in [manifest_path, absolute]:
		var path_error := _bundled_path_error(root, path)
		if not path_error.is_empty(): return _cli_failure(path_error)
	var parser := JSON.new()
	if parser.parse(FileAccess.get_file_as_string(manifest_path)) != OK or not parser.data is Dictionary:
		return _cli_failure(Locale.text("同梱CLIのmanifest.jsonが不正です。対応アドオンを入れ直してください。", "Invalid bundled CLI manifest.json. Reinstall the matching addon."))
	var manifest: Dictionary = parser.data
	if manifest.get("schema_version") != 1:
		return _cli_failure(Locale.text("同梱CLIのmanifestの形式が不正です。対応アドオンを入れ直してください。", "The bundled CLI manifest has an invalid schema. Reinstall the matching addon."))
	if not manifest.get("supportedPlatforms") is Array or platform not in manifest.supportedPlatforms or not manifest.get("binaries") is Dictionary:
		return _cli_failure(Locale.text("同梱CLIのmanifestが現在のOS/CPUに対応していません: ", "The bundled CLI manifest does not support this OS/CPU: ") + platform + Locale.text("。対応アドオンを入れ直してください。", ". Reinstall the matching addon."))
	var binary = manifest.binaries.get(platform)
	if not binary is Dictionary or binary.get("path") != platform + "/" + absolute.get_file():
		return _cli_failure(Locale.text("同梱CLIのmanifestに不正なpathがあります。対応アドオンを入れ直してください。", "Invalid path in the bundled CLI manifest. Reinstall the matching addon."))
	var expected_hash: String = str(binary.get("sha256", "")).to_lower()
	if expected_hash.length() != 64 or not expected_hash.is_valid_hex_number():
		return _cli_failure(Locale.text("同梱CLIのmanifestに不正なSHA256があります。対応アドオンを入れ直してください。", "Invalid SHA256 in the bundled CLI manifest. Reinstall the matching addon."))
	if FileAccess.get_sha256(absolute) != expected_hash:
		return _cli_failure(Locale.text("同梱CLIのSHA256がmanifestと一致しません。実行・権限変更を中止しました。対応アドオンを入れ直してください。", "The bundled CLI SHA256 does not match its manifest. Execution and permission changes were stopped. Reinstall the matching addon."))
	if OS.get_name() in ["Linux", "macOS"]:
		var permissions := FileAccess.get_unix_permissions(absolute)
		if (permissions & FileAccess.UNIX_EXECUTE_OWNER) == 0:
			var path_error := _bundled_path_error(root, absolute)
			if not path_error.is_empty(): return _cli_failure(path_error)
			var restored := permissions | FileAccess.UNIX_EXECUTE_OWNER
			# Preserve every other permission bit. Never touch quarantine, ACLs or Gatekeeper.
			if FileAccess.set_unix_permissions(absolute, restored) != OK or FileAccess.get_unix_permissions(absolute) != restored:
				return _cli_failure(Locale.text("検証済み同梱CLIの実行権限を復元できません。書き込み可能な場所に対応アドオンを入れ直してください。", "Cannot restore execute permission for the verified bundled CLI. Reinstall the matching addon in a writable location."))
	var final_path_error := _bundled_path_error(root, absolute)
	if not final_path_error.is_empty(): return _cli_failure(final_path_error)
	if FileAccess.get_sha256(absolute) != expected_hash:
		return _cli_failure(Locale.text("確認中に同梱CLIが変更されました。実行を中止しました。対応アドオンを入れ直してください。", "The bundled CLI changed during verification. Execution was stopped. Reinstall the matching addon."))
	return {"ok": true, "path": absolute, "error": ""}

static func _cli_failure(message: String) -> Dictionary:
	return {"ok": false, "path": "", "error": message}

static func _bundled_path_error(root: String, path: String) -> String:
	if not path.begins_with(root + "/"): return Locale.text("同梱CLIのパスがアドオン外を指しています。対応アドオンを入れ直してください。", "The bundled CLI path points outside the addon. Reinstall the matching addon.")
	# The project opened by Godot is the trust boundary (its chosen root may itself be a link).
	# Check every child starting at addons/, so an ancestor cannot redirect us outside the project.
	var project_root := ProjectSettings.globalize_path("res://").simplify_path().trim_suffix("/")
	if not path.begins_with(project_root + "/"): return Locale.text("同梱CLIのパスがプロジェクト外を指しています。対応アドオンを入れ直してください。", "The bundled CLI path points outside the project. Reinstall the matching addon.")
	var current := project_root
	for part in path.trim_prefix(project_root + "/").split("/"):
		var directory := DirAccess.open(current)
		if directory == null: return Locale.text("同梱CLIのフォルダを読み取れません: ", "Cannot read bundled CLI folder: ") + current + Locale.text("。対応アドオンを入れ直してください。", ". Reinstall the matching addon.")
		current = current.path_join(part)
		if directory.is_link(current): return Locale.text("同梱CLIのパスにシンボリックリンクは使えません: ", "Symbolic links are not allowed in the bundled CLI path: ") + current + Locale.text("。対応アドオンを入れ直してください。", ". Reinstall the matching addon.")
		if not FileAccess.file_exists(current) and not DirAccess.dir_exists_absolute(current):
			return Locale.text("同梱CLIのファイルが不足しています: ", "Bundled CLI file is missing: ") + current + Locale.text("。対応アドオンを入れ直してください。", ". Reinstall the matching addon.")
	return ""

func cancel_tag_query():
	if not _read_only_query: return
	if running() and OS.is_process_running(_process.pid): OS.kill(_process.pid)
	_close_process()

func running() -> bool:
	return not _process.is_empty()

func start(config_path: String, source_id := "", status_only := false) -> bool:
	if running():
		last_error = Locale.text("取り込み処理の完了を待ってください", "Wait for the current import to finish")
		return false
	_read_only_query = false
	_arguments = PackedStringArray(["pull", "--config", ProjectSettings.globalize_path(config_path)])
	if not source_id.is_empty(): _arguments.append_array(["--source", source_id])
	if status_only: _arguments.append("--status")
	_binary_hash = ""
	return _launch("help", PackedStringArray(["--help"]))

func start_tag_presets(project: String) -> bool:
	if running(): return false
	_read_only_query = true
	_arguments = PackedStringArray(["tag-presets", "--mode", "local", "--project", project])
	_binary_hash = ""
	return _launch("help", PackedStringArray(["--help"]))

func _launch(phase: String, arguments: PackedStringArray) -> bool:
	var prepared := prepare_cli()
	if not prepared.ok:
		last_error = prepared.error
		return false
	var binary_hash := FileAccess.get_sha256(str(prepared.path))
	if not _binary_hash.is_empty() and binary_hash != _binary_hash:
		last_error = Locale.text("確認中に同梱CLIが変更されました。実行を中止しました。対応アドオンを入れ直してください。", "The bundled CLI changed during verification. Execution was stopped. Reinstall the matching addon.")
		return false
	_binary_hash = binary_hash
	_stdout.clear(); _stderr.clear()
	_phase = phase; _started = Time.get_ticks_msec()
	_process = OS.execute_with_pipe(str(prepared.path), arguments, false)
	last_error = Locale.text("同梱CLIを起動できません。このOS/CPU向けアドオンを入れ直してください: ", "Cannot launch the bundled CLI. Reinstall the addon for this OS/CPU: ") + str(prepared.path) if _process.is_empty() else ""
	return running()

## Preparation is safe to stop on Editor shutdown. Never interrupt actual publication.
func cancel_preparation() -> bool:
	if _phase == "pull": return false
	if running():
		if OS.is_process_running(_process.pid): OS.kill(_process.pid)
		_close_process()
	return true

func _close_process():
	for key in ["stdio", "stderr"]:
		if _process.get(key) != null: _process[key].close()
	_process = {}

func _failure(message: String) -> Dictionary:
	last_error = message
	return {"done": true, "ok": false, "error": message}

func poll() -> Dictionary:
	if not running(): return {"done": false}
	for pair in [["stdio", true], ["stderr", false]]:
		var stream = _process.get(pair[0])
		if stream == null: continue
		for _chunk in range(32):
			var bytes = stream.get_buffer(4096)
			if bytes.is_empty(): break
			if pair[1]: _stdout.append_array(bytes)
			else: _stderr.append_array(bytes)
			if bytes.size() < 4096: break
	if (_phase != "pull" or _read_only_query) and (_stdout.size() + _stderr.size() > MAX_OUTPUT_BYTES or Time.get_ticks_msec() - _started > PROBE_TIMEOUT_MS):
		if OS.is_process_running(_process.pid): OS.kill(_process.pid)
		_close_process()
		return _failure(Locale.text("同梱CLIの確認が制限時間または出力上限を超えました。対応アドオンを入れ直してください。", "Bundled CLI verification exceeded the time or output limit. Reinstall the matching addon."))
	if OS.is_process_running(_process.pid): return {"done": false}
	# Drain a terminated child's remaining bytes over later frames without dropping its tail.
	for key in ["stdio", "stderr"]:
		if _process.get(key) != null and _process[key].get_length() > 0: return {"done": false}
	var exit_code := OS.get_process_exit_code(_process.pid)
	_close_process()
	if _phase != "pull":
		var output := _stdout.get_string_from_utf8().strip_edges()
		if exit_code != 0: return _failure(Locale.text("同梱CLIの確認に失敗しました。対応アドオンを入れ直してください。\n", "Bundled CLI verification failed. Reinstall the matching addon.\n") + _stderr.get_string_from_utf8().left(700))
		if _phase == "help":
			if not "Usage: devcel" in output or not "pull" in output: return _failure(Locale.text("同梱CLIがDevcelのpullに対応していません。対応アドオンを入れ直してください。", "The bundled CLI does not support Devcel pull. Reinstall the matching addon."))
			if not _launch("watch_help", PackedStringArray(["watch", "--help"])): return _failure(last_error)
		else:
			if not "--ensure-server" in output or not "--parent-stdin" in output: return _failure(Locale.text("同梱CLIが自動サーバー起動・終了に対応していません。対応アドオンを入れ直してください。", "The bundled CLI does not support automatic server startup and shutdown. Reinstall the matching addon."))
			if not _launch("pull", _arguments): return _failure(last_error)
		return {"done": false}
	var parser := JSON.new()
	if parser.parse(_stdout.get_string_from_utf8()) != OK or not parser.data is Dictionary:
		return _failure(Locale.text("CLIの応答を解析できません\n", "Cannot parse CLI response\n") + _stderr.get_string_from_utf8())
	var result: Dictionary = parser.data
	result.done = true
	result.ok = result.get("ok", false) and exit_code == 0
	if not result.ok: last_error = JSON.stringify(result.get("error", result.get("data", {})), "  ")
	return result
