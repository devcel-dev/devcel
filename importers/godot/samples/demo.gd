extends Control
const Database = preload("res://addons/devcel/runtime/devcel_database.gd")
const LiveDatabase = preload("res://addons/devcel/runtime/devcel_live_database.gd")
var _database = Database.new()
var _live
var _text: RichTextLabel
var _chart: Control
var _status: Label

class CurveChart extends Control:
	var curve
	func _draw():
		var area = Rect2(36, 20, maxf(1, size.x - 60), maxf(1, size.y - 46))
		draw_rect(area, Color("121d2b"))
		for i in range(5):
			var y = area.position.y + area.size.y * i / 4.0
			draw_line(Vector2(area.position.x, y), Vector2(area.end.x, y), Color("263446"), 1)
		if curve == null: return
		var points = PackedVector2Array()
		for i in range(201):
			var x = i / 200.0
			points.append(Vector2(area.position.x + area.size.x * x, area.end.y - area.size.y * curve.sample(x) / 10.0))
		draw_polyline(points, Color("42dab5"), 3.0, true)

func _ready():
	var margin = MarginContainer.new(); margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["left","right","top","bottom"]: margin.add_theme_constant_override("margin_" + side, 24)
	add_child(margin)
	var scroll = ScrollContainer.new(); scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED; margin.add_child(scroll)
	var layout = VBoxContainer.new(); layout.size_flags_horizontal = Control.SIZE_EXPAND_FILL; layout.size_flags_vertical = Control.SIZE_EXPAND_FILL; layout.add_theme_constant_override("separation", 12); scroll.add_child(layout)
	var title = Label.new(); title.text = "DEVCEL × GODOT"; title.add_theme_font_size_override("font_size", 32); title.add_theme_color_override("font_color", Color("42dab5")); layout.add_child(title)
	var subtitle = Label.new(); subtitle.text = "Load master data, resolve references, and play curves directly"; subtitle.add_theme_font_size_override("font_size",18); layout.add_child(subtitle)
	_text = RichTextLabel.new(); _text.custom_minimum_size.y = 118; _text.bbcode_enabled = true; _text.selection_enabled = true; _text.add_theme_font_size_override("normal_font_size", 19); layout.add_child(_text)
	var chart_title = Label.new(); chart_title.text = "Growth curve / Bezier and step evaluation in GDScript"; layout.add_child(chart_title)
	_chart = CurveChart.new(); _chart.custom_minimum_size.y = 140; _chart.size_flags_vertical = Control.SIZE_EXPAND_FILL; layout.add_child(_chart)
	var reload = Button.new(); reload.text = "Reload JSON changes"; reload.pressed.connect(_reload); layout.add_child(reload)
	_status = Label.new(); _status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; layout.add_child(_status)
	_live = LiveDatabase.new()
	_live.bundle_path = "res://samples/master.full.json"
	_database = _live.database
	_live.reloaded.connect(_refresh)
	_live.reload_failed.connect(func(message): _status.text = message + " (previous data retained)")
	add_child(_live)
	if not _database.is_loaded():
		_status.text = _database.last_error
		printerr("DEVCEL_DEMO_FAILED: " + _database.last_error)
		return
	_refresh()
	var hero = _hero()
	if hero != null: print("DEVCEL_DEMO_OK tables=%d hero_hp=%d" % [_database.tables().size(), hero.get_int("hp")])

func _hero():
	var hero = _database.by_id("Heroes", "hero-1")
	var heroes = _database.table("Heroes")
	return heroes.at(0) if hero == null and heroes != null else hero

func _refresh():
	var hero = _hero()
	if hero == null:
		_status.text = "This sample requires Heroes / hero-1"
		return
	var item = hero.get_reference("item")
	var drops = hero.get_table_reference("drops")
	_text.text = "[b]%s[/b]   HP %d   /   Speed %.1f\nEquipment: %s   /   Referenced table: %s\nLarge integer: %s\nMaximum U64: %s" % [hero.get_string("name"), hero.get_int("hp"), hero.get_float("speed"), item.get_string("label") if item != null else "Unresolved", drops.name() if drops != null else "Unresolved", str(hero.get_int("wide")), hero.get_u64_decimal("huge")]
	_chart.curve = hero.get_curve("growth"); _chart.queue_redraw()
	_status.text = "Loaded: %s   /   content version %s" % [_database.project_name(), str(_database.manifest().get("content_version", "All"))]

func _reload():
	var result = _database.reload_if_changed()
	if not result.ok:
		_status.text = result.error + " (previous data retained)"
	elif result.changed:
		_refresh()
	else:
		_status.text = "No changes"
