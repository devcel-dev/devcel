extends Node
## Same JSON database in Editor Play and shipped games. Only Editor Play polls.
const Database = preload("devcel_database.gd")
signal reloaded
signal reload_failed(message: String)
@export_file("*.json") var bundle_path = "res://data/master.json"
@export var editor_hot_reload = true
@export_range(0.1, 60.0) var poll_seconds = 0.5
var database = Database.new()
var _elapsed = 0.0
var _last_error = ""

func _ready():
	if not database.load_file(bundle_path):
		_last_error = database.last_error
		reload_failed.emit(_last_error)
	else:
		reloaded.emit()
	# Never watches source projects or starts CLI/network in any runtime.
	# The exported feature also keeps PCKs run with an editor binary inert.
	var enabled = editor_hot_reload and OS.has_feature("editor") and not OS.has_feature("devcel_exported") and not Engine.is_editor_hint()
	set_process(enabled)

func _process(delta: float):
	_elapsed += delta
	if _elapsed < maxf(0.1, poll_seconds): return
	_elapsed = 0.0
	reload_now()

func reload_now() -> Dictionary:
	if not database.is_loaded():
		if database.load_file(bundle_path):
			_last_error = ""
			reloaded.emit()
			return {"ok": true, "changed": true, "error": ""}
		if database.last_error != _last_error:
			_last_error = database.last_error
			reload_failed.emit(_last_error)
		return {"ok": false, "changed": false, "error": database.last_error}
	var result = database.reload_if_changed()
	if result.ok:
		var recovered = not _last_error.is_empty()
		_last_error = ""
		# Let game UI clear a prior error even when the repaired file has the
		# same content hash as the last good snapshot.
		if result.changed or recovered: reloaded.emit()
	elif result.error != _last_error:
		_last_error = result.error
		reload_failed.emit(_last_error)
	return result
