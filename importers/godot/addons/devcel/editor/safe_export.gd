extends SceneTree
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
## Fail-closed PCK export. Editor dependencies are loaded only in the preparation process.
## Usage: godot --headless --path PROJECT --script res://addons/devcel/editor/safe_export.gd -- --preset NAME --output PATH.pck
const DISTRIBUTION_SCRIPT = "res://addons/devcel/editor/devcel_distribution.gd"
const DATABASE_SCRIPT = "res://addons/devcel/runtime/devcel_database.gd"
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const EXPORT_TIMEOUT_MS = 300000
const VERIFY_TIMEOUT_MS = 30000
var _stage_dir: String = ""
var _stage_pack: String = ""
var _cancel_file: String = ""

func _initialize():
	_run.call_deferred()

func _run():
	var parsed = _parse_arguments(OS.get_cmdline_user_args())
	if not parsed.ok:
		_fail(parsed.error)
		return
	var options: Dictionary = parsed.options
	if options.has("help"):
		print("Usage: godot --headless --path PROJECT --script res://addons/devcel/editor/safe_export.gd -- --preset NAME --output PATH.pck [--cancel-file PATH]")
		quit(0)
		return
	if options.has("verify-pack"):
		_verify_pack(options)
		return
	if options.has("cancel-file"): _cancel_file = _absolute(str(options["cancel-file"]))
	if _cancel_requested():
		_fail(Locale.text("配布PCK作成を取り消しました", "Distribution PCK creation was cancelled"))
		return
	await _prepare_and_export(options)

func _parse_arguments(arguments: PackedStringArray) -> Dictionary:
	var options: Dictionary = {}
	var value_keys = ["preset", "output", "bundles", "nonce", "cancel-file"]
	var index = 0
	while index < arguments.size():
		var argument = arguments[index]
		if argument in ["--help", "--verify-pack"]:
			var key = argument.trim_prefix("--")
			if options.has(key): return {"ok": false, "error": Locale.text("重複した引数: ", "Duplicate argument: ") + argument}
			options[key] = true
		elif argument.begins_with("--") and argument.trim_prefix("--") in value_keys:
			var key = argument.trim_prefix("--")
			if options.has(key) or index + 1 >= arguments.size():
				return {"ok": false, "error": Locale.text("引数が重複しているか値がありません: ", "Duplicate argument or missing value: ") + argument}
			index += 1
			if arguments[index].is_empty() or arguments[index].begins_with("--"):
				return {"ok": false, "error": Locale.text("引数の値が空です: ", "Argument value is empty: ") + argument}
			options[key] = arguments[index]
		else:
			return {"ok": false, "error": Locale.text("未知の引数: ", "Unknown argument: ") + argument}
		index += 1
	if options.has("help"): return {"ok": true, "options": options}
	var required = ["bundles", "nonce"] if options.has("verify-pack") else ["preset", "output"]
	for key in required:
		if not options.has(key): return {"ok": false, "error": Locale.text("必須の引数がありません: --", "Missing required argument: --") + key}
	for key in options:
		if key == "cancel-file" and not options.has("verify-pack"): continue
		if key != "verify-pack" and key not in required:
			return {"ok": false, "error": Locale.text("このmodeで使えない引数: --", "Argument is not supported in this mode: --") + key}
	return {"ok": true, "options": options}

func _prepare_and_export(options: Dictionary):
	var distribution = load(DISTRIBUTION_SCRIPT)
	if distribution == null or not distribution.can_instantiate():
		_fail(Locale.text("Devcel配布検証scriptを読み込めません", "Cannot load the Devcel distribution validation script"))
		return
	var checked = distribution.read_bundles()
	if not checked.ok:
		_fail(checked.error)
		return
	var destination = _absolute(str(options.output))
	if not destination.to_lower().ends_with(".pck"):
		_fail(Locale.text("安全な書出しは .pck のみ対応しています", "Safe export supports .pck files only"))
		return
	var protected: Array = [distribution.CONFIG, DISTRIBUTION_SCRIPT, get_script().resource_path, "res://project.godot", "res://export_presets.cfg", _cancel_file]
	for bundle in checked.bundles: protected.append(bundle.path)
	for source in protected:
		if not str(source).is_empty() and destination == _absolute(str(source)):
			_fail(Locale.text("PCK出力先を入力・設定・取消ファイルと同じ場所にはできません", "The PCK output cannot overwrite an input, configuration or cancellation file"))
			return
	var bundle_manifest: String = distribution.manifest(checked.bundles)
	var expected_hash := bundle_manifest.sha256_text()
	var nonce = Crypto.new().generate_random_bytes(16).hex_encode()
	if nonce.length() != 32:
		_fail(Locale.text("書出し検証nonceを生成できません", "Cannot generate the export validation nonce"))
		return
	_stage_dir = destination.get_base_dir().path_join(".devcel-export-" + nonce)
	var mkdir_error = DirAccess.make_dir_recursive_absolute(_stage_dir)
	if mkdir_error != OK:
		_fail(Locale.text("一時出力先を作成できません: ", "Cannot create temporary output: ") + error_string(mkdir_error))
		return
	_stage_pack = _stage_dir.path_join("export.pck")
	var root_path = ProjectSettings.globalize_path("res://")
	var export_args = PackedStringArray(["--headless", "--path", root_path, "--export-pack", str(options.preset), _stage_pack, "--", "--devcel-prepared-export=" + nonce])
	var exported = await _run_process(export_args, EXPORT_TIMEOUT_MS)
	if not exported.ok:
		_fail(Locale.text("Godot PCK書出しに失敗しました: ", "Godot PCK export failed: ") + exported.error + "\n" + exported.output)
		return
	var ready_marker = "DEVCEL_EXPORT_READY:%s:%s" % [nonce, expected_hash]
	if not _has_exact_line(exported.output, ready_marker):
		_fail(Locale.text("Devcel export pluginの成功確認がありません。プラグインの有効化と設定を確認してください\n", "No success confirmation from the Devcel export plugin. Check that the plugin is enabled and configured.\n") + exported.output)
		return
	if not FileAccess.file_exists(_stage_pack):
		_fail(Locale.text("GodotがPCKを生成しませんでした", "Godot did not generate a PCK"))
		return
	var script_path = ProjectSettings.globalize_path(get_script().resource_path)
	var verify_args = PackedStringArray(["--headless", "--main-pack", _stage_pack, "--script", script_path, "--", "--verify-pack", "--bundles", bundle_manifest, "--nonce", nonce])
	var verified = await _run_process(verify_args, VERIFY_TIMEOUT_MS)
	if not verified.ok or not _has_exact_line(verified.output, "DEVCEL_PACK_VERIFIED:" + nonce):
		_fail(Locale.text("生成PCKの検証に失敗しました: ", "Generated PCK validation failed: ") + verified.error + "\n" + verified.output)
		return
	if _cancel_requested():
		_fail(Locale.text("配布PCK作成を取り消しました", "Distribution PCK creation was cancelled"))
		return
	var replace_error = DirAccess.rename_absolute(_stage_pack, destination)
	if replace_error != OK:
		_fail(Locale.text("検証済みPCKを配置できません。既存PCKは保持されています: ", "Cannot publish the verified PCK. The existing PCK was kept: ") + error_string(replace_error))
		return
	_stage_pack = ""
	_cleanup()
	print("DEVCEL_SAFE_EXPORT_OK:" + destination)
	quit(0)

func _verify_pack(options: Dictionary):
	if not OS.has_feature("devcel_exported"):
		_fail(Locale.text("PCKにdevcel_exported featureがありません", "The PCK does not have the devcel_exported feature"))
		return
	var bundles = JSON.parse_string(str(options.bundles))
	if not bundles is Array or bundles.is_empty():
		_fail(Locale.text("PCK検証対象の一覧が不正です", "Invalid PCK validation target list"))
		return
	var database_script = load(DATABASE_SCRIPT)
	if database_script == null or not database_script.can_instantiate():
		_fail(Locale.text("PCK内Devcel runtimeを読み込めません", "Cannot load the Devcel runtime inside the PCK"))
		return
	for bundle in bundles:
		if not bundle is Dictionary or not bundle.get("path") is String or not bundle.get("sha256") is String:
			_fail(Locale.text("PCK検証対象が不正です", "Invalid PCK validation target"))
			return
		var path: String = bundle.path
		if not path.begins_with("res://") or not FileAccess.file_exists(path) or FileAccess.get_sha256(path) != bundle.sha256:
			_fail(Locale.text("PCK内bundleが検証済みJSONと一致しません: ", "Bundle inside the PCK does not match the verified JSON: ") + path)
			return
		var database = database_script.new()
		if not database.load_file(path):
			_fail(Locale.text("PCK内bundleが不正です: ", "Invalid bundle inside the PCK: ") + database.last_error)
			return
	for property in ProjectSettings.get_property_list():
		if str(property.name).begins_with("devcel/"):
			_fail(Locale.text("authoring設定がPCKのproject.binaryに含まれています: ", "Authoring settings are included in the PCK project.binary: ") + str(property.name))
			return
	if FileAccess.file_exists("res://project.godot"):
		var project_config = ConfigFile.new()
		if project_config.load("res://project.godot") != OK or project_config.has_section("devcel"):
			_fail(Locale.text("PCKに不正またはauthoring設定付きproject.godotが含まれています", "The PCK contains an invalid project.godot or one with authoring settings"))
			return
	var audit_error = _audit_directory("res://")
	if not audit_error.is_empty():
		_fail(audit_error)
		return
	print("DEVCEL_PACK_VERIFIED:" + str(options.nonce))
	quit(0)

func _audit_directory(path: String) -> String:
	var directory = DirAccess.open(path)
	if directory == null: return Locale.text("PCK内フォルダを検査できません: ", "Cannot inspect folder inside the PCK: ") + path
	directory.include_hidden = true
	for filename in directory.get_files():
		var full_path = path.path_join(filename)
		if _is_authoring_path(full_path): return Locale.text("editor/authoringファイルがPCKに含まれています: ", "Editor/authoring file is included in the PCK: ") + full_path
	for dirname in directory.get_directories():
		var full_path = path.path_join(dirname)
		if _is_authoring_path(full_path + "/"): return Locale.text("editor/authoringフォルダがPCKに含まれています: ", "Editor/authoring folder is included in the PCK: ") + full_path
		var error = _audit_directory(full_path)
		if not error.is_empty(): return error
	return ""

func _is_authoring_path(path: String) -> bool:
	var lower = path.to_lower()
	return lower.begins_with("res://addons/devcel/editor/") or lower.begins_with("res://.devcel/") or lower.begins_with("res://addons/devcel/bin/") \
		or lower in ["res://addons/devcel/plugin.cfg", "res://project.godot", "res://export_presets.cfg"] \
		or lower.ends_with(".devcelproj.toml") or lower.ends_with(".table.toml") \
		or lower.ends_with(".interface.toml") or lower.ends_with("devcel.export.toml") \
		or ".devcel-owner.json" in lower or ".devcel-state.json" in lower or lower.ends_with(".devcel-lock") or lower.ends_with("devcel.import.json") \
		or lower.get_file() in ["devcel", "devcel.exe", "devcel-cli", "devcel-cli.exe", "devcel_core.dll", "libdevcel_core.so", "libdevcel_core.dylib"]

func _run_process(arguments: PackedStringArray, timeout_ms: int) -> Dictionary:
	if _cancel_requested(): return {"ok": false, "error": Locale.text("配布PCK作成を取り消しました", "Distribution PCK creation was cancelled"), "output": ""}
	var process = OS.execute_with_pipe(OS.get_executable_path(), arguments, false)
	if process.is_empty(): return {"ok": false, "error": Locale.text("Godot processを起動できません", "Cannot launch the Godot process"), "output": ""}
	var stdout_bytes = PackedByteArray()
	var stderr_bytes = PackedByteArray()
	var started = Time.get_ticks_msec()
	var failure = ""
	while true:
		_drain_pipe(process.get("stdio"), stdout_bytes)
		_drain_pipe(process.get("stderr"), stderr_bytes)
		if stdout_bytes.size() + stderr_bytes.size() > MAX_OUTPUT_BYTES:
			failure = Locale.text("Godotの出力が8MiBを超えました", "Godot output exceeded 8 MiB")
			break
		if _cancel_requested():
			failure = Locale.text("配布PCK作成を取り消しました", "Distribution PCK creation was cancelled")
			break
		if not OS.is_process_running(process.pid):
			_drain_pipe(process.get("stdio"), stdout_bytes)
			_drain_pipe(process.get("stderr"), stderr_bytes)
			break
		if Time.get_ticks_msec() - started > timeout_ms:
			failure = Locale.text("Godotの処理がタイムアウトしました", "Godot operation timed out")
			break
		await create_timer(0.01).timeout
	if not failure.is_empty() and OS.is_process_running(process.pid):
		OS.kill(process.pid)
		var kill_deadline = Time.get_ticks_msec() + 2000
		while OS.is_process_running(process.pid) and Time.get_ticks_msec() < kill_deadline:
			await create_timer(0.01).timeout
		if OS.is_process_running(process.pid): failure += Locale.text("。子processの終了を確認できませんでした", ". Could not confirm the child process exited")
	var exit_code = OS.get_process_exit_code(process.pid)
	for key in ["stdio", "stderr"]:
		if process.get(key) != null: process[key].close()
	var output = stdout_bytes.get_string_from_utf8() + "\n" + stderr_bytes.get_string_from_utf8()
	if failure.is_empty() and exit_code != 0: failure = "exit=%d" % exit_code
	if failure.is_empty() and (output.contains("ERROR:") or output.contains("DEVCEL_EXPORT_REJECTED")):
		failure = Locale.text("GodotまたはDevcelがエラーを報告しました", "Godot or Devcel reported an error")
	return {"ok": failure.is_empty(), "error": failure, "output": output}

func _drain_pipe(pipe, buffer: PackedByteArray):
	if pipe == null: return
	for _chunk in range(32):
		var chunk = pipe.get_buffer(4096)
		if chunk.is_empty(): break
		buffer.append_array(chunk)
		if chunk.size() < 4096: break

func _has_exact_line(output: String, expected: String) -> bool:
	for line in output.split("\n"):
		if line.strip_edges() == expected: return true
	return false

func _absolute(path: String) -> String:
	if path.begins_with("res://") or path.begins_with("user://"):
		return ProjectSettings.globalize_path(path).simplify_path()
	if path.is_absolute_path(): return path.simplify_path()
	return ProjectSettings.globalize_path("res://" + path).simplify_path()

func _cancel_requested() -> bool:
	# The caller owns this marker. Never remove an arbitrary caller-supplied path.
	return not _cancel_file.is_empty() and FileAccess.file_exists(_cancel_file)

func _cleanup():
	if not _stage_pack.is_empty() and FileAccess.file_exists(_stage_pack): DirAccess.remove_absolute(_stage_pack)
	if not _stage_dir.is_empty() and DirAccess.dir_exists_absolute(_stage_dir): DirAccess.remove_absolute(_stage_dir)
	_stage_pack = ""
	_stage_dir = ""

func _fail(message: String):
	_cleanup()
	printerr("DEVCEL_SAFE_EXPORT_FAILED: " + message)
	quit(1)
