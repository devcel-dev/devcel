@tool
extends Node
## Reap released pipe children even after a source/plugin is removed.
## Never signal a numeric PID: only ask Godot to collect its child's exit status.
static var _instance: WeakRef
var _pids: Array[int] = []

static func ensure_started():
	if _instance != null and is_instance_valid(_instance.get_ref()): return
	var tree = Engine.get_main_loop() as SceneTree
	if tree == null: return
	# Called during a normal watcher tick, before creating a child process.
	# Attach now: a deferred add from _exit_tree would leak on Editor shutdown.
	var reaper = load("res://addons/devcel/editor/devcel_watch_reaper.gd").new()
	tree.root.add_child(reaper)
	_instance = weakref(reaper)

static func retire(pid: int):
	if pid <= 0 or not OS.is_process_running(pid): return
	# The root may already be tearing down on application exit. Do not create
	# a new Node then; process exit releases the OS parent/child relationship.
	if _instance == null or not is_instance_valid(_instance.get_ref()): return
	var reaper = _instance.get_ref()
	if pid not in reaper._pids: reaper._pids.append(pid)

func _process(_delta: float):
	for pid in _pids.duplicate():
		if not OS.is_process_running(pid):
			OS.get_process_exit_code(pid)
			_pids.erase(pid)
