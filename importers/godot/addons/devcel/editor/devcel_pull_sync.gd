@tool
extends RefCounted
const Locale = preload("res://addons/devcel/editor/devcel_editor_locale.gd")
## Source-scoped editor watchers. Notifications request saved-file Pull; snapshots are never imported.
const Sync = preload("devcel_sync.gd")
var _detectors: Dictionary = {}
var _pending: Dictionary = {}
var _states: Dictionary = {}
var _signatures: Dictionary = {}

func configure(sources: Array, modes: Dictionary, config_path: String):
	var retained: Dictionary = {}
	for source in sources:
		var id := str(source.get("id", ""))
		if id.is_empty(): continue
		retained[id] = true
		# Missing preferences use Auto. An explicitly saved Off stays Off.
		var mode := str(modes.get(id, "Auto"))
		var path := str(source.get("project", ""))
		if not path.is_absolute_path(): path = ProjectSettings.globalize_path(config_path).get_base_dir().path_join(path).simplify_path()
		var signature := JSON.stringify([source, mode, path])
		if _signatures.get(id) == signature: continue
		_remove_source(id)
		var detector = Sync.new()
		detector.configure(path, mode, 500)
		_detectors[id] = detector
		_signatures[id] = signature
	for id in _detectors.keys():
		if not retained.has(id): _remove_source(id)

func _remove_source(source_id: String):
	# Only release this source's watcher lease; other source connections stay alive.
	if _detectors.has(source_id): _detectors[source_id].stop()
	_detectors.erase(source_id)
	_signatures.erase(source_id)
	_pending.erase(source_id)
	_states.erase(source_id)

func tick():
	for id in _detectors:
		var state: Dictionary = _detectors[id].tick()
		_states[id] = state
		if state.get("changed", false): _pending[id] = Time.get_ticks_msec()

func next_source() -> String:
	for id in _pending:
		if Time.get_ticks_msec() >= int(_pending[id]):
			_pending.erase(id)
			return str(id)
	return ""

func completed(source_id: String, ok: bool):
	if not ok and _detectors.has(source_id):
		_pending[source_id] = Time.get_ticks_msec() + 5000

func state(source_id: String) -> Dictionary:
	return _states.get(source_id, {"status": Locale.text("同期: Off", "Sync: Off"), "error": ""})

func stop():
	for detector in _detectors.values(): detector.stop()
	_detectors.clear(); _pending.clear(); _states.clear(); _signatures.clear()
