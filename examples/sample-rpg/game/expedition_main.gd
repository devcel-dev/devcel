extends Control
## Functional text-spec composition. No external artwork or reference matching.
const RpgModel = preload("res://rpg_model.gd")
const SaveGame = preload("res://save_game.gd")
const RegionMap = preload("res://region_map.gd")
const FieldView = preload("res://field_view.gd")
const PAGE_SIZE: int = 8
var game = RpgModel.new()
var _save_store = SaveGame.new()
var _save_button: Button
var _load_button: Button
var _progress_dialog: ConfirmationDialog
var _root: VBoxContainer
var _body: VBoxContainer
var _header: Label
var _status: Label
var _hp_bar: ProgressBar
var _craftable_only: bool = false
var _equippable_only: bool = false
var _inventory_dialog: AcceptDialog
var _inventory_button: Button
var _save_status: Label
var _shop_quantity: int = 1
var _pinned_recipe_id: String = ""
var _inventory_rows: VBoxContainer
var _notice: Label
var _notice_panel: PanelContainer
var _last_notice: String = ""
var _screen: String = "base"
var _selected: Dictionary = {}
var _queries: Dictionary = {}
var _pages: Dictionary = {}
var _available_only: Dictionary = {"recipes": true, "materials": true, "quests": true}
var _owned_only: Dictionary = {}
var _region_filter: Dictionary = {}
var _quality_id: String = ""
var _tracked_quest_id: String = ""
var _map_view_state: Dictionary = {}
var _map_first_neighborhood_shown: bool = false
var _quest_filters: Dictionary = {"ready": true}
var _quest_view_active: bool = false
var _quest_context_open: bool = false
var _return_journal: bool = false
var _message: String = ""
var _error: String = ""
var _debug: bool = false
var _watch: bool = true
var _watch_elapsed: float = 0.0
var _main_hash: String = ""
var _capture_dir: String = ""
var _feedback_tween: Tween
var _gain_panel: PanelContainer
var _gain_rows: VBoxContainer
var _gain_tween: Tween
var _pending_gains: Dictionary = {}
var _gain_extra: int = 0
var _scroll_refresh_generation: int = 0
var _pending_discoveries: int = 0
var _visible_discoveries: int = 0

func _ready() -> void:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture-dir="): _capture_dir = argument.trim_prefix("--capture-dir=")
	_build_theme()
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for edge in ["left", "right", "top", "bottom"]: margin.add_theme_constant_override("margin_" + edge, 22)
	add_child(margin)
	_root = VBoxContainer.new()
	_root.add_theme_constant_override("separation", 12)
	margin.add_child(_root)
	var title_row := HBoxContainer.new()
	_root.add_child(title_row)
	_header = _label(title_row, "FORGE & FIELD", 28)
	_header.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_save_button = _button(title_row,"Save",_save_progress)
	_load_button = _button(title_row,"Load",_confirm_load)
	_button(title_row,"New game",_confirm_new_game)
	for control in title_row.get_children():
		if control is Button:
			control.size_flags_horizontal = Control.SIZE_FILL
			control.custom_minimum_size.x = 112 if control.text == "New game" else 80
	var status_row := _row(_root)
	_status = _label(status_row, "", 18, Color("ccd7e4"))
	_save_status = _label(status_row, "Not saved on this device", 14, Color("b7c6d7"))
	_inventory_button = _button(status_row,"Inventory",_open_inventory)
	_inventory_button.size_flags_horizontal = Control.SIZE_FILL
	_inventory_button.custom_minimum_size.x = 130
	_hp_bar = ProgressBar.new()
	_hp_bar.show_percentage = false
	_hp_bar.custom_minimum_size.y = 16
	_hp_bar.add_theme_stylebox_override("background", _style(Color("25364a")))
	_hp_bar.add_theme_stylebox_override("fill", _style(Color("42b99f")))
	_root.add_child(_hp_bar)
	_notice_panel = PanelContainer.new()
	_notice_panel.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_RIGHT)
	_notice_panel.offset_left = -380
	_notice_panel.offset_right = -26
	_notice_panel.offset_top = -180
	_notice_panel.offset_bottom = -100
	_notice_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_notice_panel.add_theme_stylebox_override("panel",_style(Color("18303bed")))
	add_child(_notice_panel)
	_notice = _label(_notice_panel, "", 18, Color("ffd166"))
	_notice.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_notice.max_lines_visible = 3
	_notice.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_notice.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_notice_panel.hide()
	_body = VBoxContainer.new()
	_body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_root.add_child(_body)
	_build_gain_overlay()
	_reload_data(true)
	var checkpoint: Dictionary = _save_store.checkpoint_info()
	if checkpoint.ok: _save_status.text = "Last saved: " + _saved_time(checkpoint.saved_at)

func _build_theme() -> void:
	var t := Theme.new()
	var font := SystemFont.new()
	font.font_names = PackedStringArray(["Yu Gothic UI", "Meiryo", "Arial"])
	t.default_font = font
	t.default_font_size = 17
	t.set_color("font_color", "Label", Color("f2f6fb"))
	t.set_color("font_color", "Button", Color("f2f6fb"))
	t.set_color("font_hover_color", "Button", Color.WHITE)
	t.set_color("font_disabled_color", "Button", Color("a3afbd"))
	for state in ["normal", "hover", "pressed", "disabled", "focus"]:
		var fill: Color = Color("25364a")
		if state == "hover": fill = Color("3b536e")
		elif state == "pressed": fill = Color("376c65")
		elif state == "disabled": fill = Color("19232f")
		var style := _style(fill)
		if state == "focus":
			style.bg_color = Color(0,0,0,0)
			style.border_color = Color.WHITE
			style.set_border_width_all(2)
		t.set_stylebox(state, "Button", style)
		t.set_stylebox(state, "OptionButton", style)
	t.set_stylebox("normal", "LineEdit", _style(Color("111e2c")))
	t.set_color("font_color", "LineEdit", Color.WHITE)
	t.set_stylebox("background", "ProgressBar", _style(Color("344357")))
	t.set_stylebox("fill", "ProgressBar", _style(Color("65d8bb")))
	t.set_constant("separation", "VBoxContainer", 10)
	t.set_constant("separation", "HBoxContainer", 12)
	theme = t

func _style(color: Color) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = color
	style.set_corner_radius_all(8)
	style.content_margin_left = 14
	style.content_margin_right = 14
	style.content_margin_top = 10
	style.content_margin_bottom = 10
	return style

func _label(parent: Node, text: String, font_size: int = 17, color: Color = Color("f2f6fb")) -> Label:
	var label := Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	parent.add_child(label)
	return label

func _button(parent: Node, text: String, action: Callable, enabled: bool = true, primary: bool = false) -> Button:
	var button := Button.new()
	button.text = text
	button.tooltip_text = text
	button.clip_text = true
	button.custom_minimum_size.y = 44
	button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	button.disabled = not enabled
	button.pressed.connect(action)
	if primary:
		button.add_theme_stylebox_override("normal", _style(Color("f0c564")))
		button.add_theme_color_override("font_color", Color("15202d"))
	parent.add_child(button)
	return button

func _row(parent: Node) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	parent.add_child(row)
	return row

func _panel(parent: Node, width: float = 0.0) -> VBoxContainer:
	var panel := PanelContainer.new()
	panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	panel.size_flags_vertical = Control.SIZE_EXPAND_FILL
	panel.custom_minimum_size.x = width
	panel.add_theme_stylebox_override("panel", _style(Color("172432")))
	parent.add_child(panel)
	var column := VBoxContainer.new()
	panel.add_child(column)
	return column

func _scroll(parent: Node) -> VBoxContainer:
	var scroll := ScrollContainer.new()
	scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	parent.add_child(scroll)
	var column := VBoxContainer.new()
	column.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(column)
	return column

func _bar(parent: Node, value: int, maximum: int, caption: String) -> void:
	_label(parent, caption, 18)
	var bar := ProgressBar.new()
	bar.max_value = maxi(1, maximum)
	bar.value = clampi(value, 0, maxi(0, maximum))
	bar.show_percentage = false
	bar.custom_minimum_size.y = 16
	parent.add_child(bar)

func _rarity(table: String, id: String) -> Dictionary:
	if not game.has_method("item_rarity"): return {"name":"", "color":""}
	if table == "recipes":
		var recipe = game.database.by_id(table,id)
		if recipe == null: return {"name":"", "color":""}
		var output = recipe.get_reference("equipment")
		if output != null: return game.item_rarity("equipment",output.id())
		output = recipe.get_reference("output_material")
		return game.item_rarity("materials",output.id()) if output != null else {"name":"", "color":""}
	return game.item_rarity(table,id)

func _item_color(table: String, id: String) -> Color:
	var value: String = str(_rarity(table,id).get("color",""))
	return Color(value) if Color.html_is_valid(value) else Color("f2f6fb")

func _tint_item(control: Control, table: String, id: String) -> void:
	var color: Color = _item_color(table,id)
	for state in ["font_color","font_hover_color","font_pressed_color","font_focus_color","font_hover_pressed_color"]:
		control.add_theme_color_override(state,color)
	var rarity: String = str(_rarity(table,id).get("name",""))
	if not rarity.is_empty(): control.tooltip_text += ("\n" if not control.tooltip_text.is_empty() else "") + "Rarity: " + rarity

func _rarity_detail(parent: Node, table: String, id: String) -> void:
	var rarity: String = str(_rarity(table,id).get("name",""))
	if not rarity.is_empty(): _label(parent,"Rarity: " + rarity,16,_item_color(table,id))

func _choose_quality(choices: Array) -> void:
	var dialog := AcceptDialog.new()
	dialog.title = "Quality material"
	dialog.ok_button_text = "Cancel"
	add_child(dialog)
	var scroll := ScrollContainer.new()
	scroll.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	scroll.offset_left = 16
	scroll.offset_right = -16
	scroll.offset_top = 16
	scroll.offset_bottom = -58
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	dialog.add_child(scroll)
	var list := VBoxContainer.new()
	list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(list)
	for material in choices:
		var id: String = material.id()
		var choice := _button(list,"%s ×%d" % [game.row_name(material),game.inventory_count(material)],func():
			_quality_id = id
			dialog.queue_free()
			_refresh_preserving_scroll())
		choice.alignment = HORIZONTAL_ALIGNMENT_LEFT
		_tint_item(choice,"materials",id)
	dialog.confirmed.connect(dialog.queue_free)
	dialog.canceled.connect(dialog.queue_free)
	dialog.popup_centered_clamped(Vector2i(580,440),0.9)

func _build_gain_overlay() -> void:
	var layer := CanvasLayer.new()
	layer.layer = 20
	add_child(layer)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	layer.add_child(center)
	_gain_panel = PanelContainer.new()
	_gain_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_gain_panel.add_theme_stylebox_override("panel",_style(Color("111e2cf5")))
	center.add_child(_gain_panel)
	_gain_rows = VBoxContainer.new()
	_gain_rows.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_gain_panel.add_child(_gain_rows)
	resized.connect(_resize_gain_overlay)
	_gain_panel.hide()

func _resize_gain_overlay() -> void:
	if not is_instance_valid(_gain_rows): return
	for child in _gain_rows.get_children():
		if child is Label: child.custom_minimum_size.x = minf(480,maxf(120,size.x-88))

func _gain_snapshot() -> Dictionary:
	var snapshot: Dictionary = {}
	var inventory: Dictionary = game._inventory_snapshot()
	for id in inventory: snapshot["materials:"+str(id)] = int(inventory[id])
	for item in game.owned_instances(): snapshot["instance:"+str(item.id)] = 1
	return snapshot

func _show_item_gains(before: Dictionary) -> void:
	var after: Dictionary = _gain_snapshot()
	var changed: bool = false
	for key in after:
		var amount: int = int(after[key])-int(before.get(key,0))
		if amount <= 0: continue
		changed = true
		if not _pending_gains.has(key) and _pending_gains.size() >= 64:
			_pending_gains.erase(_pending_gains.keys()[0])
			_gain_extra += 1
		var previous: int = int(_pending_gains.get(key,0))
		# Dictionary insertion order tracks the most recent receipt of each item.
		_pending_gains.erase(key)
		_pending_gains[key] = mini(game.MAX_AMOUNT-amount,previous)+amount
	if not changed: return
	_pending_discoveries = mini(99, _pending_discoveries + _visible_discoveries)
	_visible_discoveries = 0
	if _gain_tween != null: _gain_tween.kill()
	for child in _gain_rows.get_children():
		_gain_rows.remove_child(child)
		child.queue_free()
	var title := _label(_gain_rows,"Obtained",18)
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var shown: int = 0
	var newest_first: Array = _pending_gains.keys()
	newest_first.reverse()
	for key in newest_first:
		if shown >= 4: break
		var parts: PackedStringArray = str(key).split(":",true,1)
		var table: String = parts[0]
		var id: String = parts[1]
		var name: String
		if table == "instance":
			name = _instance_name(id)
			table = "equipment"
			id = str(game.equipment_instances.get(id,{}).get("definition_id",""))
		else: name = _name(table,id)
		var label := _label(_gain_rows,"+%d  %s" % [int(_pending_gains[key]),name],18,_item_color(table,id))
		label.custom_minimum_size.x = minf(480,maxf(120,size.x-88))
		label.max_lines_visible = 2
		label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		shown += 1
	if _pending_gains.size()+_gain_extra > shown:
		var more := _label(_gain_rows,"+%d more gains — see Inventory" % (_pending_gains.size()-shown+_gain_extra),15)
		more.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_resize_gain_overlay()
	_gain_panel.modulate.a = 1.0
	_gain_panel.show()
	_gain_tween = create_tween()
	_gain_tween.tween_interval(2.0)
	_gain_tween.tween_property(_gain_panel,"modulate:a",0.0,0.35)
	_gain_tween.tween_callback(_clear_item_gains)

func _clear_item_gains() -> void:
	_pending_gains.clear()
	_gain_extra = 0
	if is_instance_valid(_gain_panel): _gain_panel.hide()
	_show_discovery_notice()

func _rest_button(parent: Node) -> void:
	var button := _button(parent,"Rest  %d G" % mini(game.gold,game.rest_cost()),_rest,game.hp < game.max_hp() and game.loadout_available())
	button.tooltip_text = "Current rate: %d G. Pay up to your available gold. Every stay raises the next rate." % game.rest_cost()
	_label(parent,"Rest rate: %d G · Completed stays: %d" % [game.rest_cost(),game.rest_count],14,Color("b7c6d7"))

func _rest() -> void:
	var before_gold: int = game.gold
	var ok: bool = game.rest()
	_message = "HP restored. Paid %d G. Next rest: %d G (stay %d completed)." % [before_gold-game.gold,game.rest_cost(),game.rest_count] if ok else (str(game.logs[-1]).trim_prefix("TIP  ") if not game.logs.is_empty() else "Rest is unavailable.")
	_refresh()

func _act(action: Callable, success: String = "") -> void:
	var before: Dictionary = _gain_snapshot()
	var ok: bool = bool(action.call())
	if ok: _show_item_gains(before)
	_message = success if ok else (str(game.logs[-1]) if not game.logs.is_empty() else "This action is unavailable.")
	if not ok: _message = _message.trim_prefix("TIP  ")
	_refresh()

func _open(screen: String) -> void:
	if _in_town() and screen not in ["base","forge","equipment","shop","jobs","quests","map","gather"]: screen="base"
	_screen = "base" if screen == "shop" and _known_shops().is_empty() else screen
	_message = ""
	_refresh()

func _rows(table_name: String) -> Array:
	var result: Array = []
	var table = game.database.table(table_name)
	if table != null:
		for index in range(table.count()): result.append(table.at(index))
	return result

func _name(table_name: String, id: String) -> String:
	return game.row_name(game.database.by_id(table_name, id))

func _goal_name() -> String:
	var goal: Dictionary = game.selected_objective()
	if goal.is_empty(): return ""
	return str(goal.name) + ("  Completed" if game.grand_objective_completed else "")

func _collect_discovery_notices() -> void:
	if not game.has_method("take_discovery_notifications"): return
	var discovered: Array = game.take_discovery_notifications()
	_pending_discoveries = mini(99, _pending_discoveries + discovered.size())
	_show_discovery_notice()

func _show_discovery_notice() -> void:
	if _pending_discoveries <= 0 or not is_instance_valid(_gain_panel) or _gain_panel.visible: return
	_visible_discoveries = _pending_discoveries
	_pending_discoveries = 0
	for child in _gain_rows.get_children():
		_gain_rows.remove_child(child)
		child.queue_free()
	var text: String = "Discovered a nearby region." if _visible_discoveries == 1 else "Discovered %d nearby regions." % _visible_discoveries
	var label := _label(_gain_rows,text,20,Color("79e2cc"))
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	label.custom_minimum_size.x = minf(480,maxf(120,size.x-88))
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_resize_gain_overlay()
	_gain_panel.modulate.a = 1.0
	_gain_panel.show()
	_gain_tween = create_tween()
	_gain_tween.tween_interval(2.0)
	_gain_tween.tween_property(_gain_panel,"modulate:a",0.0,0.35)
	_gain_tween.tween_callback(func():
		_visible_discoveries = 0
		_gain_panel.hide()
		_show_discovery_notice())

func _body_scrolls(node: Node) -> Array:
	var result: Array = []
	if node is ScrollContainer: result.append(node)
	for child in node.get_children(): result.append_array(_body_scrolls(child))
	return result

func _refresh_preserving_scroll() -> void:
	var offsets: Array = []
	for scroll in _body_scrolls(_body): offsets.append(Vector2i(scroll.scroll_horizontal,scroll.scroll_vertical))
	_refresh()
	_restore_scroll_offsets(offsets,_scroll_refresh_generation)

func _restore_scroll_offsets(offsets: Array, generation: int) -> void:
	await get_tree().process_frame
	if generation != _scroll_refresh_generation or not is_instance_valid(_body): return
	var scrolls: Array = _body_scrolls(_body)
	for index in range(mini(offsets.size(),scrolls.size())):
		scrolls[index].scroll_horizontal = offsets[index].x
		scrolls[index].scroll_vertical = offsets[index].y

func _refresh() -> void:
	_scroll_refresh_generation += 1
	if _body == null: return
	_collect_discovery_notices()
	_save_button.disabled = not _save_store.can_save(game)
	_save_button.tooltip_text = "Save to this device. Finish or retreat from battle before saving."
	_load_button.disabled = not _save_store.has_save()
	var quest_view: bool = (game.activity == game.BASE and _screen == "quests") or (game.activity == game.RETURN and _return_journal)
	if quest_view and not _quest_view_active:
		_quest_filters = {"ready": true}
		_pages.quests = 0
	_quest_view_active = quest_view
	_validate_tracking()
	for child in _body.get_children():
		_body.remove_child(child)
		child.queue_free()
	_header.text = "FORGE & FIELD  /  " + _place_title()
	_status.text = "%s   HP %d / %d   ATK %d   %d G" % [game.title("jobs", ""), game.hp, game.max_hp(), game.attack_power(), game.gold]
	_status.visible = game.activity != game.PURPOSE
	_hp_bar.visible = _status.visible
	_hp_bar.max_value = maxi(1, game.max_hp())
	_hp_bar.value = clampi(game.hp, 0, maxi(0, game.max_hp()))
	_refresh_inventory()
	_show_notice(_error if not _error.is_empty() else _message)
	if _debug:
		_debug_view()
		return
	if not _error.is_empty() and not game.database.is_loaded():
		_label(_body, "Could not load game data.", 25)
		_button(_body, "Reload", func(): _reload_data())
		return
	match game.activity:
		game.PURPOSE: _purpose_view()
		game.BASE:
			match _screen:
				"map": _map_view()
				"forge": _forge_view()
				"equipment": _equipment_view()
				"shop": _shop_view()
				"jobs": _jobs_view()
				"gather": _town_gather_view()
				"quests": _quests_view(_body)
				_: _base_view()
		game.EXPLORE: _explore_view()
		game.BATTLE: _battle_view()
		game.VICTORY: _victory_view()
		game.RETURN:
			if _return_journal: _quests_view(_body)
			else: _return_view()
func _open_inventory() -> void:
	if not is_instance_valid(_inventory_dialog):
		_inventory_dialog = AcceptDialog.new()
		_inventory_dialog.title = "Inventory"
		_inventory_dialog.ok_button_text = "Close"
		_inventory_dialog.exclusive = true
		_inventory_dialog.unresizable = false
		add_child(_inventory_dialog)
		var scroll := ScrollContainer.new()
		scroll.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		scroll.offset_left = 18
		scroll.offset_top = 16
		scroll.offset_right = -18
		scroll.offset_bottom = -60
		scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
		_inventory_dialog.add_child(scroll)
		_inventory_rows = VBoxContainer.new()
		_inventory_rows.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		_inventory_rows.add_theme_constant_override("separation",12)
		scroll.add_child(_inventory_rows)
	_refresh_inventory()
	_inventory_dialog.popup_centered_clamped(Vector2i(800,520),0.9)

func _refresh_inventory() -> void:
	_inventory_button.visible = game.activity != game.PURPOSE
	if not is_instance_valid(_inventory_rows): return
	for child in _inventory_rows.get_children():
		_inventory_rows.remove_child(child)
		child.queue_free()
	var entries: Array = []
	var counts: Dictionary = game._inventory_snapshot()
	for id in counts:
		var count: int = int(counts[id])
		if count <= 0: continue
		var material = game.database.by_id("materials",str(id))
		if material != null: entries.append({"name":game.row_name(material),"count":count,"table":"materials","id":str(id)})
	for instance in game.owned_instances():
		var id: String = str(instance.id)
		entries.append({"name":_instance_name(id)+( "  [Equipped]" if id==game.equipped_instance_id else ""),"count":1,"table":"equipment","id":str(instance.definition_id)})
	entries.sort_custom(func(a,b): return str(a.name).naturalnocasecmp_to(str(b.name))<0)
	if entries.is_empty(): _label(_inventory_rows,"None",16,Color("b7c6d7"))
	for entry in entries:
		var line := HBoxContainer.new()
		line.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_inventory_rows.add_child(line)
		var name_label := _label(line,str(entry.name),16,_item_color(str(entry.table),str(entry.id)))
		_tint_item(name_label,str(entry.table),str(entry.id))
		name_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		name_label.text_overrun_behavior = TextServer.OVERRUN_NO_TRIMMING
		name_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		name_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		var count_label := _label(line,str(entry.count),16,Color("79e2cc"))
		count_label.size_flags_horizontal = Control.SIZE_FILL
		count_label.custom_minimum_size.x = 100
		count_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
		count_label.mouse_filter = Control.MOUSE_FILTER_IGNORE

func _show_notice(text: String) -> void:
	if text == _last_notice: return
	_last_notice = text
	if _feedback_tween != null: _feedback_tween.kill()
	_notice_panel.visible = not text.is_empty()
	if text.is_empty(): return
	_notice.text = text
	_notice_panel.modulate.a = 1.0
	_feedback_tween = create_tween()
	_feedback_tween.tween_interval(1.6)
	_feedback_tween.tween_property(_notice_panel,"modulate:a",0.0,0.4)
	_feedback_tween.tween_callback(_notice_panel.hide)

func _place_title() -> String:
	match game.activity:
		game.PURPOSE: return "Choose a goal"
		game.BASE:
			if _in_town(): return {"map":"Destinations","forge":game.region_name+" / Forge","equipment":game.region_name+" / Equipment","jobs":game.region_name+" / Jobs","gather":game.region_name+" / Gather","shop":game.region_name+" / Shop","quests":"Quests"}.get(_screen,game.region_name)
			return {"map":"Destinations", "forge":"Base / Forge", "equipment":"Base / Equipment", "shop":"Base / Shop", "jobs":"Base / Jobs", "quests":"Quests"}.get(_screen,"Base")
		game.EXPLORE: return game.region_name + " / Explore - Depth %d" % game.exploration_depth
		game.BATTLE: return game.region_name + " / Battle"
		game.VICTORY: return "Victory"
		game.RETURN: return "Expedition report"
	return ""

func _purpose_view() -> void:
	var top_space := Control.new()
	top_space.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_body.add_child(top_space)
	var choices := VBoxContainer.new()
	choices.add_theme_constant_override("separation",16)
	_body.add_child(choices)
	for objective in game.progression_policy.get("grand_objectives", []):
		var panel := _panel(choices)
		panel.get_parent().size_flags_vertical = Control.SIZE_SHRINK_BEGIN
		var row := _row(panel)
		var text := VBoxContainer.new()
		text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		text.size_flags_stretch_ratio = 2.6
		text.add_theme_constant_override("separation",6)
		row.add_child(text)
		_label(text,_story_text(str(objective.name)),24)
		var quest = game.database.by_id("quests",str(objective.get("quest_id","")))
		if quest != null:
			var purpose: String = _story_text(quest.get_string("brief")).strip_edges()
			if not purpose.is_empty():
				var summary := _label(text,purpose,17,Color("b7c6d7"))
				summary.max_lines_visible = 3
				summary.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
				summary.tooltip_text = purpose
		var id: String = str(objective.id)
		_button(row,"Start this quest",func(): _act(func(): return game.choose_purpose(id)),true,true)
	var bottom_space := Control.new()
	bottom_space.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_body.add_child(bottom_space)
	if choices.get_child_count() == 0:
		_label(_body,"Goal data is unavailable.",20)
		_button(_body,"Reload",func(): _reload_data())

func _in_town() -> bool:
	var region = game.database.by_id("regions",game.region_id)
	return region != null and region.get_string("region_kind") == "settlement"

func _base_view() -> void:
	var main := _panel(_body)
	_label(main, _goal_name(), 26, Color("ffd166"))
	_label(main, game.region_name if _in_town() else "Prepare for an expedition", 23)
	var region = game.database.by_id("regions",game.region_id)
	var purpose := _label(main,region.get_string("purpose") if _in_town() and region != null else "",18,Color("b7c6d7"))
	purpose.custom_minimum_size.y = 28
	var attributes: Dictionary = game.bare_attributes()
	_label(main, "STR %d   DEX %d   INT %d   Mastery %d" % [attributes.strength, attributes.dexterity, attributes.intelligence, game.mastery_for()])
	var equipped_label := _label(main, "Equipment: " + (_instance_name(game.equipped_instance_id) if not game.equipped_instance_id.is_empty() else "None"))
	for instance in game.owned_instances():
		if str(instance.id) == game.equipped_instance_id:
			_tint_item(equipped_label,"equipment",str(instance.definition_id))
			break
	var facilities := _row(main)
	for entry in [["forge","Forge & equipment"],["shop","Shop"],["jobs","Jobs"],["quests","View quests"]]:
		var screen: String = entry[0]
		if screen == "shop" and _known_shops().is_empty():
			var empty_slot := Control.new()
			empty_slot.size_flags_horizontal = Control.SIZE_EXPAND_FILL
			facilities.add_child(empty_slot)
			continue
		_button(facilities, entry[1], func(): _open(screen))
	var ready: Array = _visible_ready_quests()
	if not _visible_unaccepted_ready_quests().is_empty(): _label(main,"Some unaccepted quests are ready to complete.",19,Color("79e2cc"))
	if not ready.is_empty(): _label(main, "Quests ready to report: %d" % ready.size(), 19, Color("79e2cc"))
	var spacer := Control.new()
	spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
	main.add_child(spacer)
	var actions := _row(main)
	_rest_button(actions)
	if _in_town(): _button(actions,"Gather",func(): _open("gather"))
	else:
		var gather_slot := Control.new()
		gather_slot.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		actions.add_child(gather_slot)
	_button(actions, "Choose destination", func(): _open("map"), game.hp > 0 and game.loadout_available(), true)

func _town_gather_view() -> void:
	if not _in_town(): _base_view(); return
	_back(_body)
	var content := _row(_body)
	content.size_flags_vertical = Control.SIZE_EXPAND_FILL
	var pool := _panel(content,300)
	_label(pool,"Available here",22)
	for item in game.gathering_pool():
		if int(item.remaining)>0: _label(pool,"%s ×%d" % [item.name,item.remaining],18,_item_color("materials",str(item.id)))
	var remaining: bool = game.gathering_pool().any(func(item): return int(item.remaining)>0)
	if not remaining: _label(pool,"This gathering spot is depleted.",18)
	_gather_probability_view(_panel(content,360))
	_button(_body,"Gather",func(): _act(game.gather),remaining,true)

func _back(parent: Node, caption: String = "Back to base") -> void:
	if _in_town() and caption=="Back to base": caption="Back to town"
	_button(parent, caption, func(): _open("base"))

func _map_view() -> void:
	var top := _row(_body)
	var back := _button(top,"Back to town" if _in_town() else "Back to base",func(): _open("base"))
	back.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	back.custom_minimum_size.x = 180
	_label(top,_tracked_title(),21,Color("ffd166"))
	var split := _row(_body)
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	var map = RegionMap.new()
	map.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	map.size_flags_vertical = Control.SIZE_EXPAND_FILL
	map.size_flags_stretch_ratio = 2.6
	split.add_child(map)
	var graph: Dictionary = game.progression_policy.get("region_graph",{})
	var nodes: Array = []
	for node in graph.get("nodes",[]):
		var disclosure: Dictionary = game.region_disclosure(str(node.id))
		nodes.append({"id":str(node.id),"position":node.position,"name":_region_label(str(node.id)),"discovered":disclosure.get("discovered",false),"visited":disclosure.get("visited",false)})
	map.set_graph(nodes,graph.get("edges",[]))
	if not _map_view_state.is_empty(): map.set_view_state(_map_view_state)
	_map_view_state = map.get_view_state()
	map.viewport_changed.connect(func(state: Dictionary): _map_view_state=state)
	var selected_id: String = str(_selected.get("regions",graph.get("start_region_id","")))
	if not _map_region_visible(selected_id): selected_id = str(graph.get("start_region_id",""))
	_selected.regions = selected_id
	var goal: Dictionary = game.selected_objective()
	var goal_id: String = str(goal.get("region_id",""))
	var route_target: String=game.quest_route_target_region_id(_tracked_quest_id) if not _tracked_quest_id.is_empty() else game.grand_route_target_region_id()
	var route: Array = game.planned_route(route_target)
	if not _tracked_quest_id.is_empty(): goal_id=route_target
	map.set_state(game.reachable_region_ids(),"",goal_id if game.is_region_visited(goal_id) else "",selected_id,route)
	var anchor_id: String=game.region_id if game.is_region_visited(game.region_id) else str(graph.get("start_region_id",""))
	map.set_map_anchor(anchor_id,"You are here","You are at this region's base. Selecting a destination does not move you there until you depart.")
	if not _map_first_neighborhood_shown and game.discovered_region_ids().size()>1:
		map.frame_neighborhood(selected_id)
		_map_view_state=map.get_view_state()
		_map_first_neighborhood_shown=true
	map.region_selected.connect(func(id: String):
		if _map_region_visible(id):
			_selected.regions = id
			_refresh())
	var detail := _panel(split,280)
	detail.get_parent().size_flags_stretch_ratio = 1.0
	var region = game.database.by_id("regions",selected_id)
	if region == null or not _map_region_visible(selected_id): return
	if not game.is_region_discovered(selected_id):
		_label(detail,"?",30)
		_label(detail,"Undiscovered region",20)
		_label(detail,"Explore nearby regions to discover a route here.",17,Color("b7c6d7"))
		var chance := _label(detail,"%d%% per exploration action nearby" % game.discovery_chance_percent(selected_id),17,Color("79e2cc"))
		chance.tooltip_text = "Each successful gathering action or battle victory in an adjacent region rolls this chance independently. Several regions may be discovered at once."
		var unknown_spacer := Control.new()
		unknown_spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
		detail.add_child(unknown_spacer)
		_button(detail,"Depart",func(): pass,false,true)
		return
	_label(detail,_region_label(selected_id),25)
	var allowed: bool = game.is_region_discovered(selected_id) and not game.destination_route(selected_id).is_empty()
	var current_town: bool = _in_town() and selected_id == game.region_id
	_label(detail,"Current town" if current_town else ("Ready to depart" if allowed else "Preparation required"),19,Color("79e2cc") if allowed else Color("ffd166"))
	if not allowed: _label(detail,_unlock_reason("regions",selected_id),16)
	if not game.is_region_visited(selected_id):
		_label(detail,"Clue to your goal" if route.has(selected_id) else "Explore a new route",20)
		_label(detail,"Visit this region to learn more about it.",17,Color("b7c6d7"))
	else:
		var purpose: String = region.get_string("purpose")
		if not purpose.is_empty(): _label(detail,purpose,19)
		var ids: Array = game.progression_policy.get("region_materials",{}).get(selected_id,[])
		var families: Dictionary = {}
		for id in ids:
			var material = game.database.by_id("materials",str(id))
			if material != null:
				var family: String = material.get_string("family","Material")
				families[family] = material.get_string("family_name",family)
		if not families.is_empty():
			_label(detail,"Gatherable materials: %d families" % families.size(),19)
			_label(detail," / ".join(families.values()),16,Color("b7c6d7"))
	var spacer := Control.new()
	spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
	detail.add_child(spacer)
	var toll: Dictionary = game.town_entry_quote(region.id())
	if int(toll.fee)>0: _label(detail,"First entry: %d G / Available: %d G" % [toll.fee,game.gold],17)
	if not toll.ok: _label(detail,str(toll.error),16,Color("ffd166"))
	var leave: Callable = func():
		if not game.is_region_discovered(region.id()): return
		if game.depart(region.get_string("key"),_goal_name(),int(toll.fee)):
			_screen="base"
			_message=""
		else: _message=str(game.logs[-1]).trim_prefix("TIP  ") if not game.logs.is_empty() else "Cannot depart."
		_refresh()
	var confirm_leave: Callable = func():
		if int(toll.fee)>0:
			_confirm_progress_action("Pay the entry toll?","Pay %d G once to enter? Available: %d G." % [toll.fee,game.gold],leave,"Pay and enter")
		else: leave.call()
	_button(detail,"Depart",confirm_leave,allowed and not current_town and toll.ok and game.hp>0 and game.loadout_available(),true)

func _map_region_visible(id: String) -> bool:
	if game.is_region_discovered(id): return true
	for edge in game.progression_policy.get("region_graph",{}).get("edges",[]):
		if edge[0] == id and game.is_region_visited(str(edge[1])): return true
		if edge[1] == id and game.is_region_visited(str(edge[0])): return true
	return false

func _region_label(id: String) -> String:
	return _name("regions",id) if game.is_region_visited(id) else "Unexplored region"

func _unlock_reason(table_name: String, id: String) -> String:
	var rules: Dictionary = game.progression_policy.get("rules", {}).get(table_name, {})
	if not rules.has(id): return "Not available yet."
	var rule: Dictionary = rules[id]
	var reasons: Array[String] = []
	if game.wins < int(rule.get("min_wins", 0)): reasons.append("Victories %d / %d" % [game.wins, int(rule.min_wins)])
	for key in rule.get("region_wins", {}):
		if int(game.wins_by_region.get(key, 0)) < int(rule.region_wins[key]): reasons.append("%s victories %d / %d" % [_region_label(str(key)), int(game.wins_by_region.get(key,0)), int(rule.region_wins[key])])
	for quest_id in rule.get("claimed_quests", []):
		if not game.claimed_quests.has(quest_id):
			var quest = game.database.by_id("quests",str(quest_id))
			reasons.append("Complete quest: " + game.row_name(quest) if _content_discovered("quests",quest) else "Complete quests in visited regions")
	for equipment_id in rule.get("owned_equipment", []):
		if not game.owned_equipment.has(equipment_id): reasons.append("Craft equipment: " + _name("equipment", equipment_id))
	var counts: Dictionary={}
	for reason in reasons: counts[reason]=int(counts.get(reason,0))+1
	var compact: Array[String]=[]
	for reason in counts: compact.append(str(reason)+(" (%d requirements)"%int(counts[reason]) if int(counts[reason])>1 else ""))
	return "\n".join(compact) if not compact.is_empty() else "Unlock a connected region first."

func _scene(parent: Node) -> void:
	var view = FieldView.new()
	view.game = game
	view.custom_minimum_size.y = 220
	view.size_flags_vertical = Control.SIZE_EXPAND_FILL
	view.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	parent.add_child(view)

func _explore_view() -> void:
	_label(_body, _tracked_title(), 21, Color("ffd166"))
	var content := _row(_body)
	content.size_flags_vertical = Control.SIZE_EXPAND_FILL
	var scene_column := VBoxContainer.new()
	scene_column.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scene_column.size_flags_stretch_ratio = 1.4
	content.add_child(scene_column)
	_scene(scene_column)
	_gather_probability_view(_panel(content,360))
	var row := _row(_body)
	_button(row, "Gather", func(): _gather(), true, true)
	_button(row, "Return to base", func(): _act(game.return_to_base))
	var contextual := _row(_body)
	var added: Dictionary = {}
	var tracked_enemy: String=_tracked_enemy()
	if not tracked_enemy.is_empty(): _context_encounter(contextual,tracked_enemy,"Find quest enemies",added)
	var objective: Dictionary = game.selected_objective()
	if str(objective.get("region_id", "")) == game.region_id:
		_context_encounter(contextual, str(objective.get("enemy_id", "")), "Challenge your goal", added)
	for job in _rows("jobs"):
		var parent_job = job.get_reference("parent_job")
		if parent_job == null or parent_job.id() != str(game.selected_ids.get("jobs", "")): continue
		for trial in game.job_trial_enemies(job.id()):
			if trial.get_string("region") == game.region_key: _context_encounter(contextual, trial.id(), "Trial: " + game.row_name(trial), added)
	if contextual.get_child_count() == 0: contextual.hide()

func _sorted_gathering_candidates() -> Array:
	var candidates: Array = []
	var material_rules: Dictionary = game.progression_policy.get("rules",{}).get("materials",{})
	for candidate in game.gathering_probabilities():
		var rule: Dictionary = material_rules.get(str(candidate.id),{})
		# Global experience unlocks visibility; local depth still displays 0%.
		if game.wins >= int(rule.get("min_wins",0)): candidates.append(candidate)
	var ranks: Dictionary = {}
	for candidate in candidates:
		var material = game.database.by_id("materials",str(candidate.id))
		var rarity = material.get_reference("rarity_ref") if material != null else null
		ranks[str(candidate.id)] = rarity.get_int("rank",0) if rarity != null else 0
	candidates.sort_custom(func(a,b):
		if float(a.percent)!=float(b.percent): return float(a.percent)>float(b.percent)
		if ranks[str(a.id)]!=ranks[str(b.id)]: return ranks[str(a.id)]>ranks[str(b.id)]
		var order: int = str(a.name).naturalnocasecmp_to(str(b.name))
		return order<0 if order!=0 else str(a.id)<str(b.id))
	return candidates

func _gather_probability_view(parent: Node) -> void:
	_label(parent,"Gather chance",19)
	var list := _scroll(parent)
	var candidates: Array = _sorted_gathering_candidates()
	if candidates.is_empty():
		var authored: Array = game.progression_policy.get("region_materials",{}).get(game.region_id,[])
		_label(list,"No gatherable materials in this region." if authored.is_empty() else "Gathering information is unavailable.",16,Color("b7c6d7"))
	for candidate in candidates:
		var line := HBoxContainer.new()
		list.add_child(line)
		var name_label := _label(line,str(candidate.name),16,_item_color("materials",str(candidate.id)))
		name_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		name_label.text_overrun_behavior = TextServer.OVERRUN_NO_TRIMMING
		name_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		name_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		var percent: float = float(candidate.percent)
		var caption: String = "0%" if percent<=0.0 else ("<0.01%" if percent<0.01 else "%.2f%%" % percent)
		if bool(candidate.get("probability_unavailable",false)): caption = "Unavailable"
		elif bool(candidate.get("probability_estimated",false)): caption = "~" + caption
		var chance := _label(line,caption,16,Color("79e2cc") if percent>0.0 else Color("aab9ca"))
		chance.tooltip_text = "Obtain chance is unavailable. Gathering is still available." if bool(candidate.get("probability_unavailable",false)) else "Chance of obtaining this material in one Gather action. ~ indicates a numerical estimate."
		if bool(candidate.get("available_next_stop",false)): chance.tooltip_text = "Added by a data update; eligible for the next gathering stop. This saved pool is unchanged."
		chance.size_flags_horizontal = Control.SIZE_FILL
		chance.custom_minimum_size.x = 110
		chance.autowrap_mode = TextServer.AUTOWRAP_OFF
		chance.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
		chance.mouse_filter = Control.MOUSE_FILTER_STOP

	var foes: Array = game.regional_enemies() if not _in_town() else []
	if not foes.is_empty():
		_label(list,"Enemy drops — on victory",19)
		for foe in foes:
			var loot: Dictionary = game.encounter_loot_preview(foe)
			if loot.is_empty() or int(loot.amount)<=0: continue
			_label(list,game.row_name(foe),15,Color("b7c6d7"))
			_label(list,"%s ×%d · %.0f%% on victory" % [loot.name,loot.amount,loot.percent],16,_item_color("materials",str(loot.id)))

func _validate_tracking() -> void:
	if _tracked_quest_id.is_empty(): return
	var quest=game.database.by_id("quests",_tracked_quest_id)
	if quest==null or game.quest_claimed(quest):
		_tracked_quest_id=""

func _tracked_title() -> String:
	if _tracked_quest_id.is_empty(): return _goal_name()
	return "Tracking: "+_story_text(_name("quests",_tracked_quest_id))

func _track_quest(id: String) -> void:
	var quest=game.database.by_id("quests",id)
	if quest==null or game.quest_claimed(quest) or not _content_discovered("quests",quest): return
	_tracked_quest_id=id
	_refresh()

func _tracked_conditions() -> Array:
	var id: String=_tracked_quest_id
	if id.is_empty(): id=str(game.selected_objective().get("quest_id",""))
	if id.is_empty() or not game.content_available("quests",id): return []
	return game.quest_condition_summaries(id)

func _tracked_enemy() -> String:
	for condition in _tracked_conditions():
		if str(condition.kind)!="kill" or bool(condition.ready): continue
		var id: String=str(condition.get("target_enemy_id",""))
		if id.is_empty(): continue
		for enemy in game.regional_enemies():
			if enemy.id()==id and game.content_available("enemies",id): return id
	return ""

func _context_encounter(parent: Node, id: String, caption: String, seen: Dictionary) -> void:
	if seen.has(id) or not game.content_available("enemies", id): return
	seen[id] = true
	_button(parent, caption, func(): _act(func(): return game.advance(id)))

func _gather() -> void:
	var before: Dictionary = _gain_snapshot()
	var ok: bool = game.gather_and_advance()
	if ok: _show_item_gains(before)
	_message = "" if ok else str(game.logs[-1]).trim_prefix("TIP  ")
	_refresh()

func _battle_view() -> void:
	var enemy: Dictionary = game.enemy
	_label(_body, str(enemy.get("name", "")), 28)
	_bar(_body, int(enemy.get("hp",0)), int(enemy.get("max_hp",1)), "Enemy HP %d / %d" % [int(enemy.get("hp",0)),int(enemy.get("max_hp",1))])
	_scene(_body)
	var controls := _row(_body)
	_button(controls, "Attack  %d" % game.attack_power(), _attack, game.hp > 0, true)
	_button(controls, "Retreat to base", func(): _act(game.retreat))

func _attack() -> void:
	var before: Dictionary = _gain_snapshot()
	var ok: bool = game.attack()
	if ok: _show_item_gains(before)
	if ok:
		_message = "%d damage!" % int(game.last_exchange.get("damage",0))
		if int(game.last_exchange.get("received",0)) > 0: _message += "  Damage received: %d" % int(game.last_exchange.received)
	else: _message = str(game.logs[-1]).trim_prefix("TIP  ")
	_refresh()

func _victory_view() -> void:
	var card := _panel(_body)
	_label(card, "Victory!", 40, Color("ffd166"))
	_label(card, str(game.last_victory.get("enemy_name", "")) + " defeated", 25)
	_label(card, "+%d G" % int(game.last_victory.get("gold",0)), 32, Color("79e2cc"))
	_label(card, "+%d %s" % [int(game.last_victory.get("amount",0)),str(game.last_victory.get("material_name",""))], 24,_item_color("materials",str(game.last_victory.get("material_id",""))))
	_label(card, "Job mastery: %d" % game.mastery_for(), 18)
	if game.grand_objective_defeated and not game.grand_objective_completed: _label(card, "Your target is defeated. Return to base to report your success.", 22, Color("ffd166"))
	var spacer := Control.new()
	spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
	card.add_child(spacer)
	var controls := _row(card)
	_button(controls, "Keep exploring", func(): _act(game.continue_exploration), true, true)
	_button(controls, "Return to base", func(): _act(game.return_to_base))

func _return_view() -> void:
	var summary: Dictionary = game.return_summary
	var title: String = "Returned from expedition"
	if summary.get("reason") == "defeat": title = "Returned after defeat"
	elif summary.get("reason") == "retreated": title = "Retreated from battle"
	_label(_body, title, 32)
	var columns := _row(_body)
	columns.size_flags_vertical = Control.SIZE_EXPAND_FILL
	var loot := _scroll(_panel(columns))
	_label(loot, str(summary.get("region_name","")), 24)
	_label(loot, "%+d G   %d victories" % [int(summary.get("gold",0)),int(summary.get("wins",0))], 23, Color("79e2cc"))
	if int(summary.get("gold_lost",0)) > 0:
		_label(loot,"Lost %d G on defeat" % int(summary.gold_lost),19,Color("ffb4a8"))
	for material in summary.get("materials",[]): _label(loot, "+%d %s" % [int(material.amount),str(material.name)], 17,_item_color("materials",str(material.id)))
	_label(loot, "New crafting options", 22)
	for id in summary.get("newly_craftable_ids",[]): _label(loot, _catalog_name("recipes",game.database.by_id("recipes",id)), 17,_item_color("recipes",str(id)))
	var rewards := _scroll(_panel(columns))
	_label(rewards, "Complete quests", 24)
	var ready: Array=_visible_ready_quests()
	if not _visible_unaccepted_ready_quests().is_empty():
		_label(rewards,"Some unaccepted quests are ready to complete.",19,Color("79e2cc"))
		_button(rewards,"View quests",func(): _return_journal=true;_refresh())
	var shown: Array=_return_priority_quests(ready)
	for id in shown:
		var quest = game.database.by_id("quests",id)
		var quote: Dictionary=game.quest_claim_quote(str(id),true)
		var deliveries: Dictionary=quote.get("deliveries",{})
		_label(rewards,game.row_name(quest),19)
		if not deliveries.is_empty():
			_label(rewards,"Delivery consumes:",16,Color("ffd166"))
			for material_id in deliveries:
				_label(rewards,"%s ×%d"%[_name("materials",str(material_id)),int(deliveries[material_id])],16,_item_color("materials",str(material_id)))
		_button(rewards,("Deliver and complete - " if not deliveries.is_empty() else "Complete - ")+_quest_reward_label(quest),func(): _claim(id),true,true)
	if ready.size()>shown.size():
		_label(rewards,"%d more quests are ready to complete."%(ready.size()-shown.size()),17)
		_button(rewards,"Open quest journal",func(): _return_journal=true;_refresh())
	if ready.is_empty(): _label(rewards, "No rewards to collect.", 17)
	if bool(summary.get("grand_objective_ready_to_report",false)):
		_label(rewards, "Grand quest target defeated", 25, Color("ffd166"))
		_label(rewards, _goal_name(), 21)
	_button(_body, "Report and return to base" if bool(summary.get("grand_objective_ready_to_report",false)) else "To base", func(): _screen = "base"; _act(game.close_return), true, true)

func _claim(id: String) -> void:
	if not game.select_row("quests",id): _act(func(): return false); return
	var before: Dictionary = _gain_snapshot()
	var ok: bool=game.claim_quest()
	if ok: _show_item_gains(before)
	_message="Quest completed." if ok else str(game.logs[-1]).trim_prefix("TIP  ")
	if ok and str(game.last_quest_claim.get("quest_id",""))==id:
		var outcome: String=str(game.last_quest_claim.get("outcome",""))
		if not outcome.is_empty(): _message=_story_text(outcome)
	_refresh()

func _row_available(kind: String, row) -> bool:
	if kind == "recipes": return game.recipe_available(row.id())
	return game.content_available(kind,row.id())

func _row_owned(kind: String, row) -> bool:
	if kind == "materials": return game.inventory_count(row) > 0
	if kind == "recipes":
		var equipment = row.get_reference("equipment")
		return equipment != null and game.owns_equipment(equipment)
	if kind == "quests": return game.quest_claimed(row)
	return false

func _row_region(kind: String, row) -> String:
	if kind == "recipes":
		var material = row.get_reference("material")
		return material.get_string("region_key") if material != null else ""
	return row.get_string("region_key",row.get_string("region"))

func _catalog(parent: Node, kind: String, caption: String) -> Array:
	var split := _row(parent)
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	var left := _panel(split,380)
	var right_panel := _panel(split,400)
	var right := _scroll(right_panel)
	var actions := VBoxContainer.new()
	if kind in ["recipes","materials"]:
		actions.name = "ForgeActions" if kind == "recipes" else "ShopActions"
		right_panel.add_child(HSeparator.new())
		right_panel.add_child(actions)
	else: actions.free()
	left.add_theme_constant_override("separation",6)
	_label(left,caption,20)
	var search_row := _row(left)
	var search := LineEdit.new()
	search.placeholder_text = "Search name or key"
	search.text = str(_queries.get(kind,""))
	search.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	search.custom_minimum_size.y = 40
	search_row.add_child(search)
	var apply_search: Callable = func(): _queries[kind] = search.text.strip_edges(); _pages[kind] = 0; _refresh()
	search.text_submitted.connect(func(_value: String): apply_search.call())
	_button(search_row,"Search",apply_search)
	var filters := _row(left)
	if kind == "recipes":
		for entry in [["Craftable",_craftable_only],["Equippable",_equippable_only]]:
			var toggle := CheckButton.new()
			toggle.text = entry[0]
			toggle.button_pressed = entry[1]
			toggle.tooltip_text = "Can craft at least one quality now" if entry[0] == "Craftable" else "Own a quality that this job can equip now"
			var crafting: bool = entry[0] == "Craftable"
			toggle.toggled.connect(func(on: bool):
				if crafting: _craftable_only = on
				else: _equippable_only = on
				_quality_id = ""; _pinned_recipe_id = ""; _pages[kind] = 0; _refresh())
			filters.add_child(toggle)
		_label(left,"Match either filter; neither shows unlocked recipes.",14,Color("aab9ca"))
	else:
		var available := CheckButton.new()
		available.text = "Available here" if kind == "materials" else "Unlocked"
		available.button_pressed = bool(_available_only.get(kind,false))
		available.toggled.connect(func(on: bool): _available_only[kind] = on; _pages[kind] = 0; _refresh())
		filters.add_child(available)
		if kind == "materials":
			var owned := CheckButton.new()
			owned.text = "Owned"
			owned.button_pressed = bool(_owned_only.get(kind,false))
			owned.toggled.connect(func(on: bool): _owned_only[kind] = on; _pages[kind] = 0; _refresh())
			filters.add_child(owned)
	if kind in ["recipes","materials"]:
		var area := OptionButton.new()
		area.add_item("All regions")
		area.set_item_metadata(0,"")
		for region in game.destinations():
			if not game.is_region_visited(region.id()): continue
			area.add_item(_region_label(region.id()))
			area.set_item_metadata(area.item_count-1,region.get_string("key"))
			if str(_region_filter.get(kind,"")) == region.get_string("key"): area.select(area.item_count-1)
		area.item_selected.connect(func(index: int): _region_filter[kind] = str(area.get_item_metadata(index)); _pages[kind] = 0; _refresh())
		left.add_child(area)
	var matches: Array = []
	var query: String = str(_queries.get(kind,"")).to_lower()
	var catalog_rows: Array = _catalog_rows(kind)
	for row in catalog_rows:
		if not query.is_empty() and not (_catalog_name(kind,row) + " " + row.get_string("key") + " " + row.id()).to_lower().contains(query): continue
		if kind == "recipes" and (_craftable_only or _equippable_only) and not ((_craftable_only and _recipe_ready(row)) or (_equippable_only and _recipe_equippable(row))): continue
		if bool(_available_only.get(kind,false)) and not (kind == "recipes" and (_craftable_only or _equippable_only)) and not _row_available(kind,row): continue
		if bool(_owned_only.get(kind,false)) and not _row_owned(kind,row): continue
		if not str(_region_filter.get(kind,"")).is_empty() and _row_region(kind,row) != str(_region_filter[kind]): continue
		matches.append(row)
	var page_count: int = maxi(1,int(ceil(float(matches.size()) / PAGE_SIZE)))
	var page: int = clampi(int(_pages.get(kind,0)),0,page_count-1)
	_pages[kind] = page
	_label(left,"%d items / Page %d" % [matches.size(),page+1],14,Color("aab9ca"))
	var list := _scroll(left)
	for index in range(page * PAGE_SIZE,mini(matches.size(),(page+1)*PAGE_SIZE)):
		var row = matches[index]
		var id: String = row.id()
		var badge: String = ""
		if kind == "recipes": badge = "  [Craftable]" if _recipe_ready(row) else ("  [Locked]" if not game.recipe_available(id) else "")
		elif kind == "jobs": badge = "  [Available]" if game.job_requirement_reason(id).is_empty() else "  [Requirements]"
		elif kind == "quests": badge = "  [Completed]" if game.quest_claimed(row) else ("  [Ready]" if game.quest_progress(row) >= game.quest_target(row) and game.content_available(kind,id) else "")
		elif kind == "materials": badge = "  ×%d" % game.inventory_count(row)
		var button := _button(list,_catalog_name(kind,row)+badge,func(): _select_catalog(kind,id))
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.clip_text = true
		button.tooltip_text = _catalog_name(kind,row)+badge
		if kind in ["recipes","materials","equipment"]: _tint_item(button,kind,id)
		if str(_selected.get(kind,"")) == id: button.add_theme_stylebox_override("normal",_style(Color("3a5867")))
	var navigation := _row(left)
	_button(navigation,"Previous",func(): _pages[kind] = page-1; _refresh(),page>0)
	_button(navigation,"Next",func(): _pages[kind] = page+1; _refresh(),page+1<page_count)
	var selected_id: String = str(_selected.get(kind,str(game.selected_ids.get(kind,""))))
	if (kind == "quests" or (kind == "materials" and _screen == "shop")) and not catalog_rows.any(func(item): return item.id() == selected_id): selected_id = ""
	if kind == "recipes" and (_craftable_only or _equippable_only) and selected_id != _pinned_recipe_id and not matches.any(func(item): return item.id() == selected_id): selected_id = ""
	if selected_id.is_empty() and not matches.is_empty(): selected_id = matches[0].id()
	_selected[kind] = selected_id
	var selection = game.database.by_id(kind,selected_id)
	if selection != null and not matches.any(func(item): return item.id() == selected_id): _label(right,"The selected item is outside the current filters.",14,Color("ffd166"))
	return [right,selection,actions if kind in ["recipes","materials"] else null]

func _select_catalog(kind: String, id: String) -> void:
	_selected[kind] = id
	_pinned_recipe_id = ""
	_quality_id = "" if kind == "recipes" else _quality_id
	if kind == "materials": _shop_quantity = 1
	_message = ""
	if kind != "jobs" and _row_available(kind,game.database.by_id(kind,id)) and game.activity == game.BASE:
		if kind == "materials" and _screen == "shop": game.select_shop_material(id)
		else: game.select_row(kind,id)
		if kind == "recipes" and not (_craftable_only or _equippable_only): _quality_id = game.selected_quality_id
	_refresh_preserving_scroll()

func _recipe_equippable(recipe) -> bool:
	if game.activity != game.BASE: return false
	if not game.loadout_job_available(): return false
	var equipment = recipe.get_reference("equipment")
	if equipment == null: return false
	for instance in game.owned_instances():
		if str(instance.definition_id) == equipment.id() and game.instance_requirement_reason(str(instance.id)).is_empty(): return true
	return false

func _recipe_ready(recipe) -> bool:
	if not game.recipe_available(recipe.id()): return false
	if recipe.get_string("quality_group_key").is_empty(): return bool(game.recipe_quote(recipe.id()).ok)
	for material in game.quality_choices(recipe.id(),true):
		if game.recipe_quote(recipe.id(),material.id()).ok: return true
	return false

func _forge_view() -> void:
	var header := _row(_body)
	_back(header)
	_button(header,"Equipment",func(): _open("equipment"))
	var parts: Array = _catalog(_body,"recipes","Forge & refine")
	var detail: VBoxContainer = parts[0]
	var recipe = parts[1]
	var actions: VBoxContainer = parts[2]
	if recipe == null: _label(detail,"No recipes match. Clear a filter or gather the required materials.",18); return
	_label(detail,"Selected: "+_catalog_name("recipes",recipe),25,_item_color("recipes",recipe.id()))
	_rarity_detail(detail,"recipes",recipe.id())
	if not game.recipe_available(recipe.id()): _label(detail,_unlock_reason("recipes",recipe.id()),17,Color("ffd166"))
	var choices: Array = game.quality_choices(recipe.id())
	if not choices.is_empty():
		_label(detail,"Quality material",17)
		var selected_index: int = -1
		for index in range(choices.size()):
			if choices[index].id() == _quality_id: selected_index = index
		if selected_index < 0 and (_craftable_only or _equippable_only):
			for index in range(choices.size()):
				var quality: String = choices[index].id()
				var owned_id: String = game._existing_variant(recipe.get_string("equipment"), quality)
				if (_craftable_only and game.recipe_quote(recipe.id(),quality).ok) or (_equippable_only and not owned_id.is_empty() and game.loadout_job_available() and game.instance_requirement_reason(owned_id).is_empty()):
					selected_index = index
					break
		if selected_index < 0:
			var default_quality = recipe.get_reference("default_quality")
			if default_quality != null:
				for index in range(choices.size()):
					if choices[index].id() == default_quality.id(): selected_index = index; break
		_quality_id = choices[selected_index].id() if selected_index >= 0 else ""
		var caption: String = "Choose quality material"
		if selected_index >= 0: caption = "%s ×%d" % [game.row_name(choices[selected_index]),game.inventory_count(choices[selected_index])]
		var picker := _button(detail,caption,func(): _choose_quality(choices))
		if not _quality_id.is_empty(): _tint_item(picker,"materials",_quality_id)
	else: _quality_id = ""
	var quote: Dictionary = game.recipe_quote(recipe.id(),_quality_id)
	_label(detail,"Materials  Owned / Required",19)
	var inputs: Dictionary = quote.get("inputs",{})
	if inputs.is_empty():
		var base_material = recipe.get_reference("material")
		if base_material != null: inputs[base_material.id()] = maxi(1,recipe.get_int("material_count",1))
	for id in inputs:
		var material = game.database.by_id("materials",id)
		var input_button := _button(detail,"%s  %d / %d  ›" % [game.row_name(material),game.inventory_count(material),int(inputs[id])],func(): _selected.material_info = id; _refresh())
		_tint_item(input_button,"materials",str(id))
	var material_info: String = str(_selected.get("material_info",""))
	if inputs.has(material_info): _material_places(detail,material_info)
	_label(detail,"Craft cost %d G / Available %d G" % [int(quote.get("cost",recipe.get_int("cost"))),game.gold],18)
	var equipment = recipe.get_reference("equipment")
	if equipment != null:
		_label(detail,"Equipped: "+_instance_name(game.equipped_instance_id),18)
		_label(detail,"Selected weapon: "+game.row_name(equipment),21,_item_color("equipment",equipment.id()))
		var preview: Dictionary = game.recipe_equipment_preview(recipe.id(),_quality_id)
		if preview.ok:
			_label(detail,"If equipped (preview)",17,Color("b7c6d7"))
			_label(detail,"Total ATK %d -> %d   Max HP %d -> %d" % [preview.before.attack,preview.after.attack,preview.before.max_hp,preview.after.max_hp],20,Color("79e2cc"))
			_label(detail,"STR %d -> %d   DEX %d -> %d   INT %d -> %d" % [preview.before.strength,preview.after.strength,preview.before.dexterity,preview.after.dexterity,preview.before.intelligence,preview.after.intelligence],16)
			_label(detail,"Quality: %.2fx weapon power" % (float(preview.quality_multiplier_permille)/1000.0),16)
		else: _label(detail,str(preview.error),16,Color("ffd166"))
		_label(detail,"Base weapon ATK %d" % equipment.get_int("attack"),18)
		_label(detail,"Scaling: STR %.2fx / DEX %.2fx / INT %.2fx" % [equipment.get_int("scale_strength")/1000.0,equipment.get_int("scale_dexterity")/1000.0,equipment.get_int("scale_intelligence")/1000.0],16)
		_label(detail,"Requires STR %d / DEX %d / INT %d" % [equipment.get_int("required_strength"),equipment.get_int("required_dexterity"),equipment.get_int("required_intelligence")],16)
		var required_job = equipment.get_reference("required_job")
		if required_job != null: _label(detail,"Required job: %s or a descendant" % game.row_name(required_job),16)
		var required_rank: int = equipment.get_int("required_job_tier",0)
		if required_rank > 0: _label(detail,"Required job rank: %d" % required_rank,16)
		var required_mastery: int = equipment.get_int("required_mastery",0)
		if required_mastery > 0:
			var mastery_job = game.database.by_id("jobs",game.equipment_mastery_job_id(equipment.id()))
			var mastery_label: String = game.row_name(required_job) if required_job != null else (game.row_name(mastery_job) if mastery_job != null else "Rank %d" % required_rank)
			_label(detail,"Required %s mastery: %d" % [mastery_label,game.equipment_mastery_required(equipment.id())],16)
		var reason: String = game.equipment_requirement_reason(equipment.id())
		if not reason.is_empty(): _label(detail,"Equip requirements: "+reason,15,Color("ffd166"))
	else:
		var output = recipe.get_reference("output_material")
		if output != null: _label(detail,"Result: %s x%d" % [game.row_name(output),recipe.get_int("output_count",1)],21,_item_color("materials",output.id()))
	if not quote.ok: _label(detail,str(quote.error),16,Color("ffd166"))
	var recipe_id: String = recipe.id()
	var action_title := _label(actions,_catalog_name("recipes",recipe),16,_item_color("recipes",recipe.id()))
	action_title.autowrap_mode = TextServer.AUTOWRAP_OFF
	action_title.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_button(actions,"Craft",func(): _craft(recipe_id),bool(quote.ok),true)
	if equipment == null or recipe.get_string("kind","equipment") != "equipment": return
	var recipe_instance_id: String = ""
	if equipment != null and recipe.get_string("kind","equipment") == "equipment":
		for instance in game.owned_instances():
			if str(instance.definition_id) == equipment.id() and str(instance.quality_material_id) == _quality_id:
				recipe_instance_id = str(instance.id)
				break
	var already_equipped: bool = not recipe_instance_id.is_empty() and game.equipped_instance_id == recipe_instance_id
	if equipment != null:
		_label(detail,"Selected quality: Equipped" if already_equipped else ("Selected quality: Owned, not equipped" if not recipe_instance_id.is_empty() else "Selected quality: Not owned"),17)
	var equip_reason: String = ""
	if equipment == null or recipe.get_string("kind","equipment") != "equipment": equip_reason = "This recipe does not produce equipment."
	elif recipe_instance_id.is_empty(): equip_reason = "Craft this equipment quality first."
	elif not game.loadout_job_available(): equip_reason = "Choose an available job first."
	else: equip_reason = game.instance_requirement_reason(recipe_instance_id)
	var equip_selected: Callable = func():
		if game.equipped_instance_id == recipe_instance_id: return
		_act(func(): return game.equip_instance(recipe_instance_id),"Equipment equipped.")
	var equip_button := _button(actions,"Equipped" if already_equipped else "Equip",equip_selected,equip_reason.is_empty() and not already_equipped,true)
	equip_button.tooltip_text = equip_reason
	if not equip_reason.is_empty(): _label(detail,equip_reason,15,Color("ffd166"))

func _select_equipment_instance(instance_id: String) -> void:
	if not game.equipment_instances.has(instance_id): return
	_selected.equipment_instance = instance_id
	_refresh_preserving_scroll()

func _equipment_view() -> void:
	if game.activity != game.BASE:
		_label(_body,"Return to a town or base to change equipment.",18)
		return
	_button(_body,"Back to Forge",func(): _open("forge"))
	var split := _row(_body)
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	var left := _panel(split,360)
	var right := _panel(split,400)
	_label(left,"Owned equipment",22)
	var list := _scroll(left)
	var detail := _scroll(right)
	var actions := VBoxContainer.new()
	actions.name = "EquipmentActions"
	right.add_child(HSeparator.new())
	right.add_child(actions)
	var instances: Array = game.owned_instances()
	if instances.is_empty():
		_selected.equipment_instance = ""
		_label(list,"No equipment owned yet.",18)
		_label(detail,"Craft a weapon in the Forge to add it here.",18)
		return
	var selected_id: String = str(_selected.get("equipment_instance",""))
	if not game.equipment_instances.has(selected_id):
		selected_id = game.equipped_instance_id if game.equipment_instances.has(game.equipped_instance_id) else str(instances[0].id)
		_selected.equipment_instance = selected_id
	for instance in instances:
		var id: String = str(instance.id)
		var caption: String = _instance_name(id)
		if id == game.equipped_instance_id: caption += "  [Equipped]"
		if id == selected_id: caption += "  [Selected]"
		var item := _button(list,caption,func(): _select_equipment_instance(id))
		item.toggle_mode = true
		item.set_pressed_no_signal(id == selected_id)
		_tint_item(item,"equipment",str(instance.definition_id))
	var selected: Dictionary = game.equipment_instances[selected_id]
	var equipment = game.database.by_id("equipment",str(selected.definition_id))
	if equipment == null:
		_label(detail,"This equipment definition is unavailable.",18)
		return
	_label(detail,"Selected: "+_instance_name(selected_id),23,_item_color("equipment",equipment.id()))
	_rarity_detail(detail,"equipment",equipment.id())
	_label(detail,"Equipped: "+_instance_name(game.equipped_instance_id),18)
	var already_equipped: bool = game.equipped_instance_id == selected_id
	_label(detail,"Equipped" if already_equipped else "Owned, not equipped",17)
	var multiplier: int = int(selected.get("quality_multiplier_permille",1000))
	_label(detail,"If equipped (preview)",17,Color("b7c6d7"))
	_label(detail,"Total ATK %d -> %d   Max HP %d -> %d" % [game.attack_power(),game._attack_with_equipment(equipment,multiplier),game.max_hp(),game.max_hp()],20,Color("79e2cc"))
	_label(detail,"Quality: %.2fx weapon power" % (float(multiplier)/1000.0),16)
	_label(detail,"Base weapon ATK %d" % equipment.get_int("attack"),18)
	_label(detail,"Scaling: STR %.2fx / DEX %.2fx / INT %.2fx" % [equipment.get_int("scale_strength")/1000.0,equipment.get_int("scale_dexterity")/1000.0,equipment.get_int("scale_intelligence")/1000.0],16)
	_label(detail,"Requires STR %d / DEX %d / INT %d" % [equipment.get_int("required_strength"),equipment.get_int("required_dexterity"),equipment.get_int("required_intelligence")],16)
	var required_job = equipment.get_reference("required_job")
	if required_job != null: _label(detail,"Required job: %s or a descendant" % game.row_name(required_job),16)
	var required_rank: int = equipment.get_int("required_job_tier",0)
	if required_rank > 0: _label(detail,"Required job rank: %d" % required_rank,16)
	if equipment.get_int("required_mastery",0) > 0:
		var mastery_job = game.database.by_id("jobs",game.equipment_mastery_job_id(equipment.id()))
		var mastery_label: String = game.row_name(required_job) if required_job != null else (game.row_name(mastery_job) if mastery_job != null else "Rank %d" % required_rank)
		_label(detail,"Required %s mastery: %d" % [mastery_label,game.equipment_mastery_required(equipment.id())],16)
	var reason: String = game.instance_requirement_reason(selected_id) if game.loadout_job_available() else "Choose an available job first."
	if not reason.is_empty(): _label(detail,"Equip requirements: "+reason,16,Color("ffd166"))
	var equip_selected: Callable = func():
		if game.equipped_instance_id == selected_id: return
		_act(func(): return game.equip_instance(selected_id),"Equipment equipped.")
	var equip_button := _button(actions,"Equipped" if already_equipped else "Equip",equip_selected,reason.is_empty() and not already_equipped,true)
	equip_button.tooltip_text = reason

func _craft(recipe_id: String) -> void:
	if not game.select_row("recipes",recipe_id): _act(func(): return false); return
	if not _quality_id.is_empty() and not game.select_quality(_quality_id): _act(func(): return false); return
	var before: Dictionary = _gain_snapshot()
	var crafted: bool = game.craft()
	if crafted: _show_item_gains(before)
	if crafted: _pinned_recipe_id = recipe_id
	_message = "Crafted successfully." if crafted else str(game.logs[-1]).trim_prefix("TIP  ")
	_refresh()

func _instance_name(id: String) -> String:
	if not game.equipment_instances.has(id): return "None"
	var instance: Dictionary = game.equipment_instances[id]
	var text: String = _name("equipment",str(instance.definition_id))
	if not str(instance.quality_material_id).is_empty(): text += " / " + _name("materials",str(instance.quality_material_id))
	return text

func _material_places(parent: Node, id: String) -> void:
	_label(parent,"Sources: " + _name("materials",id),18,_item_color("materials",id))
	_rarity_detail(parent,"materials",id)
	var found: bool = false
	for region_id in game.progression_policy.get("region_materials",{}):
		if id in game.progression_policy.region_materials[region_id]:
			found = true
			_label(parent,_region_label(str(region_id))+( "  [Reachable]" if game.is_region_discovered(str(region_id)) and not game.destination_route(region_id).is_empty() else ""),16)
	if not found:
		for recipe in _rows("recipes"):
			var output = recipe.get_reference("output_material")
			if output != null and output.id() == id: found = true; _label(parent,"Refine: "+game.row_name(recipe),16)
	if not found: _label(parent,"No gathering or refining source is registered.",16)

func _known_shops() -> Array:
	return _rows("shops").filter(func(shop):
		if not _content_discovered("shops",shop): return false
		var region = shop.get_reference("region_ref")
		return not _in_town() or (region != null and region.id()==game.region_id))

# Reject out-of-range decimal input before int conversion (no floating-point quantities).
func _quantity_value(text: String) -> int:
	var digits: String = text.strip_edges()
	if digits.is_empty(): return 0
	for character in digits:
		if character < "0" or character > "9": return 0
	while digits.length()>1 and digits.begins_with("0"): digits = digits.substr(1)
	var limit: String = str(game.MAX_AMOUNT)
	if digits.length()>limit.length() or (digits.length()==limit.length() and digits>limit): return 0
	return int(digits)

func _shop_view() -> void:
	var top := _row(_body)
	_back(top)
	var known_shops: Array = _known_shops()
	if known_shops.is_empty():
		_screen = "base"
		_base_view()
		return
	var selected_shop_id: String = str(game.selected_ids.get("shops",""))
	if not known_shops.any(func(shop): return shop.id()==selected_shop_id):
		for shop in known_shops:
			if game.content_available("shops",shop.id()): game.select_row("shops",shop.id());break
	var shop_choice := OptionButton.new()
	shop_choice.fit_to_longest_item = false
	shop_choice.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	for shop in known_shops:
		shop_choice.add_item(game.row_name(shop)+( "" if game.content_available("shops",shop.id()) else " [Locked]"))
		shop_choice.set_item_metadata(shop_choice.item_count-1,shop.id())
		shop_choice.set_item_disabled(shop_choice.item_count-1,not game.content_available("shops",shop.id()))
		if shop.id() == str(game.selected_ids.get("shops","")): shop_choice.select(shop_choice.item_count-1)
	shop_choice.item_selected.connect(func(index: int): _select_shop(str(shop_choice.get_item_metadata(index))))
	top.add_child(shop_choice)
	var parts: Array = _catalog(_body,"materials","Trade materials")
	var detail: VBoxContainer = parts[0]
	var material = parts[1]
	if material == null: return
	_label(detail,game.row_name(material),24,_item_color("materials",material.id()))
	_rarity_detail(detail,"materials",material.id())
	_label(detail,"Owned: %d" % game.inventory_count(material),22)
	if not game.content_available("materials",material.id()): _label(detail,_unlock_reason("materials",material.id()),17,Color("ffd166"))
	var selected: bool = str(game.selected_ids.get("materials","")) == material.id()
	if selected:
		_label(detail,"Buy %d G / Sell %d G" % [game.shop_price(),game.sell_price()],20)
		var actions: VBoxContainer = parts[2]
		var quantity_row := _row(actions)
		var quantity := LineEdit.new()
		quantity.placeholder_text = "Quantity"
		quantity.text = str(_shop_quantity)
		quantity.custom_minimum_size.x = 95
		quantity.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		var minus := _button(quantity_row,"-",func():
			quantity.text = str(maxi(1,_quantity_value(quantity.text)-1))
			quantity.text_changed.emit(quantity.text))
		minus.size_flags_horizontal = Control.SIZE_FILL
		minus.custom_minimum_size.x = 40
		quantity_row.add_child(quantity)
		var plus := _button(quantity_row,"+",func():
			quantity.text = str(mini(game.MAX_AMOUNT-1,_quantity_value(quantity.text))+1)
			quantity.text_changed.emit(quantity.text))
		plus.size_flags_horizontal = Control.SIZE_FILL
		plus.custom_minimum_size.x = 40
		var material_id: String = material.id()
		var shop_id: String = str(game.selected_ids.get("shops",""))
		var buy_unit: int = game.shop_price()
		var sell_unit: int = game.sell_price()
		_button(quantity_row,"Max buy",func(): quantity.text = str(maxi(1,int(game.trade_quote(1,true,material_id,shop_id).max_quantity)));quantity.text_changed.emit(quantity.text))
		_button(quantity_row,"Max sell",func(): quantity.text = str(maxi(1,int(game.trade_quote(1,false,material_id,shop_id).max_quantity)));quantity.text_changed.emit(quantity.text))
		var totals := _label(actions,"",16)
		var buttons := _row(actions)
		var buy := _button(buttons,"Buy",func(): _act(func(): return game.buy_quantity(_quantity_value(quantity.text),material_id,shop_id,buy_unit),"Purchase completed."),false,true)
		var sell := _button(buttons,"Sell",func(): _act(func(): return game.sell_quantity(_quantity_value(quantity.text),material_id,shop_id,sell_unit),"Sale completed."),false)
		var update: Callable = func(_value: String = ""):
			_shop_quantity = _quantity_value(quantity.text)
			var purchase: Dictionary = game.trade_quote(_shop_quantity,true,material_id,shop_id)
			var sale: Dictionary = game.trade_quote(_shop_quantity,false,material_id,shop_id)
			buy.disabled = not purchase.ok
			sell.disabled = not sale.ok
			buy.tooltip_text = str(purchase.error)
			sell.tooltip_text = str(sale.error)
			totals.text = ("Buy: %d G • owned %d → %d" % [purchase.total,purchase.owned,purchase.resulting_owned] if purchase.ok else "Buy: " + str(purchase.error)) + "\n" + ("Sell: %d G • owned %d → %d" % [sale.total,sale.owned,sale.resulting_owned] if sale.ok else "Sell: " + str(sale.error))
		quantity.text_changed.connect(update)
		update.call()
	else: _label(detail,"This material cannot be traded here.",17)
	_material_places(detail,material.id())

func _job_tree_entries(rows: Array) -> Array:
	var by_id: Dictionary = {}
	var children: Dictionary = {}
	var roots: Array = []
	for row in rows: by_id[row.id()] = row
	for row in rows:
		var parent = row.get_reference("parent_job")
		var parent_id: String = parent.id() if parent != null else ""
		if parent_id.is_empty() or not by_id.has(parent_id): roots.append(row.id())
		else:
			if not children.has(parent_id): children[parent_id] = []
			children[parent_id].append(row.id())
	var result: Array = []
	var seen: Dictionary = {}
	for id in roots: _append_job_branch(str(id),0,by_id,children,seen,result)
	# Invalid cyclic live data must not hang or silently hide an owned job.
	for id in by_id:
		if not seen.has(id): _append_job_branch(str(id),0,by_id,children,seen,result)
	return result

func _append_job_branch(id: String, depth: int, rows: Dictionary, children: Dictionary, seen: Dictionary, result: Array) -> void:
	if seen.has(id): return
	seen[id] = true
	result.append({"row": rows[id], "depth": depth})
	for child in children.get(id,[]): _append_job_branch(str(child),depth+1,rows,children,seen,result)

func _jobs_view() -> void:
	_back(_body)
	var split := _row(_body)
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	var left := _panel(split,380)
	_label(left,"Job paths",24)
	_label(left,"Current: " + game.title("jobs",""),18,Color("79e2cc"))
	var tree := _scroll(left)
	var right := _panel(split,400)
	var detail := _scroll(right)
	right.add_child(HSeparator.new())
	var actions := VBoxContainer.new()
	actions.name = "JobActions"
	right.add_child(actions)
	var entries: Array = _job_tree_entries(_rows("jobs"))
	var selected_id: String = str(_selected.get("jobs",game.selected_ids.get("jobs","")))
	if not entries.any(func(entry): return entry.row.id() == selected_id):
		selected_id = entries[0].row.id() if not entries.is_empty() else ""
	_selected.jobs = selected_id
	var buttons: Dictionary = {}
	for entry in entries:
		var row = entry.row
		var row_id: String = row.id()
		var line := HBoxContainer.new()
		tree.add_child(line)
		var indent := Control.new()
		indent.custom_minimum_size.x = mini(int(entry.depth),8)*18
		line.add_child(indent)
		var current: bool = row_id == str(game.selected_ids.get("jobs",""))
		var state: String = "Current" if current else ("Unlocked" if game.job_is_unlocked(row_id) else "Locked")
		var caption: String = ("→ " if int(entry.depth)>0 else "") + game.row_name(row) + "  [" + state + "]"
		var button := _button(line,caption,func(): _select_job_detail(row_id,detail,actions,buttons))
		buttons[row_id] = button
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.clip_text = true
		var parent_job = row.get_reference("parent_job")
		button.tooltip_text = game.row_name(row) + (" / From " + game.row_name(parent_job) if parent_job != null else " / Starting job")
		if current: button.add_theme_color_override("font_color",Color("79e2cc"))
		if row_id == selected_id: button.add_theme_stylebox_override("normal",_style(Color("3a5867")))
	var job = game.database.by_id("jobs",selected_id)
	if job == null: return
	_job_details(detail,actions,job)

func _select_job_detail(id: String, detail: VBoxContainer, actions: VBoxContainer, buttons: Dictionary) -> void:
	var job = game.database.by_id("jobs",id)
	if job == null: return
	_selected.jobs = id
	for key in buttons:
		if key == id: buttons[key].add_theme_stylebox_override("normal",_style(Color("3a5867")))
		else: buttons[key].remove_theme_stylebox_override("normal")
	for panel in [detail,actions]:
		for child in panel.get_children():
			panel.remove_child(child)
			child.queue_free()
	_job_details(detail,actions,job)

func _job_details(detail: VBoxContainer, actions: VBoxContainer, job) -> void:
	_label(detail,game.row_name(job),26)
	var attributes: Dictionary = game.bare_attributes(job.id())
	_label(detail,"HP %d   ATK %d\nSTR %d   DEX %d   INT %d" % [job.get_int("hp"),job.get_int("attack"),attributes.strength,attributes.dexterity,attributes.intelligence],20)
	_label(detail,"Job mastery: %d" % game.mastery_for(job.id()),19)
	_label(detail,"Total attack multiplier: x%.2f" % (float(job.get_int("damage_multiplier_permille",1000))/1000.0),17)
	var parent_job = job.get_reference("parent_job")
	if parent_job != null:
		_label(detail,"Required job: "+game.row_name(parent_job),18)
		_label(detail,"Mastery %d / %d" % [game.mastery_for(parent_job.id()),job.get_int("mastery_required")],18)
	var id: String = job.id()
	var cost: int = game.job_unlock_cost(id)
	_label(detail,"Unlocked" if game.job_is_unlocked(id) else "Promotion fee: %d G / Owned %d G" % [cost,game.gold],19)
	var discount: int = job.get_int("equipment_mastery_discount",0)
	if discount > 0: _label(detail,"Equipment mastery requirements: -%d%% (rank requirements still apply)" % discount,17)
	var gather_bonus: int = job.get_int("gather_quality_weight_permille",1000)
	if gather_bonus != 1000: _label(detail,"Eligible quality %d+ material weights: x%.2f" % [job.get_int("gather_quality_min",3),float(gather_bonus)/1000.0],17)
	var reason: String = game.job_requirement_reason(id)
	if not reason.is_empty(): _label(detail,_job_reason_for_display(job,reason),17,Color("ffd166"))
	var caption: String = "Switch to this job" if game.job_is_unlocked(id) else "Promote for %d G" % cost
	_label(actions,game.row_name(job),18,Color("b7c6d7"))
	_button(actions,caption,func():
		if game.job_is_unlocked(id): _act(func(): return game.select_row("jobs",id),"Job changed.")
		else: _confirm_progress_action("Promote to " + game.row_name(job) + "?", "Pay %d G to permanently unlock this job?" % cost, func():
			if game.job_unlock_cost(id) != cost:
				_message = "The promotion cost changed. Review the current requirements."
				_refresh()
				return
			_act(func(): return game.select_row("jobs",id),"Job unlocked."), "Promote"),reason.is_empty() and id != str(game.selected_ids.get("jobs","")),true)

func _quests_view(parent: Node) -> void:
	if game.activity==game.RETURN: _button(parent,"Back to expedition report",func(): _return_journal=false;_refresh())
	else: _back(parent)
	var split:=_row(parent)
	split.size_flags_vertical=Control.SIZE_EXPAND_FILL
	var list_panel:=_panel(split,400)
	var detail_panel:=_panel(split,440)
	var detail:=_scroll(detail_panel)
	detail_panel.add_child(HSeparator.new())
	var actions:=VBoxContainer.new()
	actions.name="QuestActions"
	detail_panel.add_child(actions)
	var statuses:=GridContainer.new()
	statuses.columns=2
	list_panel.add_child(statuses)
	for entry in [["ready","Ready"],["accepted","Accepted"],["claimed","Completed"],["unaccepted","Not accepted"]]:
		var key: String=entry[0]
		var toggle:=CheckButton.new()
		toggle.text="%s (%d)" % [entry[1],_quest_candidates({key:true}).size()]
		toggle.button_pressed=bool(_quest_filters.get(key,false))
		toggle.toggled.connect(func(on: bool):
			if on: _quest_filters[key]=true
			else: _quest_filters.erase(key)
			_pages.quests=0
			_refresh())
		statuses.add_child(toggle)
	_label(list_panel,"Match any selected status. None selected shows all.",14,Color("aab9ca"))
	var filter_row:=_row(list_panel)
	var search:=LineEdit.new()
	search.placeholder_text="Search quest or requester"
	search.text=str(_queries.get("quests",""))
	search.size_flags_horizontal=Control.SIZE_EXPAND_FILL
	search.custom_minimum_size.y=42
	filter_row.add_child(search)
	var apply: Callable=func(): _queries.quests=search.text.strip_edges();_pages.quests=0;_refresh()
	search.text_submitted.connect(func(_value: String): apply.call())
	_button(filter_row,"Search",apply)
	var matches: Array=_quest_candidates()
	var page_count: int=maxi(1,int(ceil(float(matches.size())/PAGE_SIZE)))
	var page: int=clampi(int(_pages.get("quests",0)),0,page_count-1)
	var retained_id: String = str(_selected.get("quests", ""))
	for index in range(matches.size()):
		if matches[index].id() == retained_id:
			page = index / PAGE_SIZE
			break
	_pages.quests=page
	var visible_matches: Array = matches.slice(page * PAGE_SIZE, mini(matches.size(), (page + 1) * PAGE_SIZE))
	var selected_id: String = str(_selected.get("quests", ""))
	if not visible_matches.any(func(row): return row.id() == selected_id):
		selected_id = visible_matches[0].id() if not visible_matches.is_empty() else ""
	_selected.quests = selected_id
	_label(list_panel,"%d quests / Page %d of %d"%[matches.size(),page+1,page_count],15,Color("aab9ca"))
	var list:=_scroll(list_panel)
	for index in range(page*PAGE_SIZE,mini(matches.size(),(page+1)*PAGE_SIZE)):
		var quest=matches[index]
		var id: String=quest.id()
		var badge: String={"claimed":"Completed","accepted":"Accepted","accepted_ready":"Accepted / Ready","available":"Not accepted","available_ready":"Not accepted / Ready","unavailable":"Locked"}.get(game.quest_state(id),"Not accepted")
		if id==str(game.selected_objective().get("quest_id","")): badge="Goal / "+badge
		var button:=_button(list,game.row_name(quest)+"  ["+badge+"]",func(): _selected.quests=id;_quest_context_open=false;_refresh_preserving_scroll())
		button.alignment=HORIZONTAL_ALIGNMENT_LEFT
		if id==str(_selected.get("quests","")): button.add_theme_stylebox_override("normal",_style(Color("3a5867")))
	if matches.is_empty():
		_label(list,"No quests are ready to complete." if _quest_filters == {"ready":true} else "No quests match these filters.",18)
		_button(list,"Browse quests",func(): _quest_filters.clear();_queries.quests="";_pages.quests=0;_refresh())
		if _quest_candidates({}).is_empty(): _label(list,"Visit a region to discover local requests.",16)
	var navigation:=_row(list_panel)
	_button(navigation,"Previous",func(): _pages.quests=page-1;_selected.erase("quests");_refresh(),page>0)
	_button(navigation,"Next",func(): _pages.quests=page+1;_selected.erase("quests");_refresh(),page+1<page_count)
	if selected_id.is_empty(): return
	var selected_quest=game.database.by_id("quests",selected_id)
	var action_title:=_label(actions,game.row_name(selected_quest),17,Color("b7c6d7"))
	action_title.autowrap_mode=TextServer.AUTOWRAP_OFF
	action_title.text_overrun_behavior=TextServer.OVERRUN_TRIM_ELLIPSIS
	action_title.tooltip_text=game.row_name(selected_quest)
	_quest_detail(detail,actions,selected_quest)

func _quest_candidates(status_filters: Variant = null) -> Array:
	if status_filters == null: status_filters = _quest_filters
	var candidates: Array=game.quest_catalog("",0,true)
	var query: String=str(_queries.get("quests","")).to_lower()
	var ready_candidates: Array=[]
	var remaining_candidates: Array=[]
	for quest in candidates:
		var region=quest.get_reference("region_ref")
		if quest.get_bool("grand_candidate",false) or game._is_grand_quest(quest.id()): continue
		if not game.quest_is_accepted(quest.id()) and region!=null and region.id()!=game.region_id: continue
		if not _content_discovered("quests",quest): continue
		var requester=quest.get_reference("requester")
		var searchable: String=game.row_name(quest)+" "+(game.row_name(requester) if requester!=null else "")
		if not query.is_empty() and not searchable.to_lower().contains(query): continue
		var claimed: bool=game.quest_claimed(quest)
		var available: bool=game.content_available("quests",quest.id())
		if not available and not game.quest_is_accepted(quest.id()): continue
		var ready: bool=bool(game.quest_claim_quote(quest.id(),true,true).ok)
		var accepted: bool=game.quest_is_accepted(quest.id()) and not claimed
		var matches_status: bool=status_filters.is_empty() or (bool(status_filters.get("ready",false)) and ready) or (bool(status_filters.get("accepted",false)) and accepted) or (bool(status_filters.get("claimed",false)) and claimed) or (bool(status_filters.get("unaccepted",false)) and not accepted and not claimed and available)
		if not matches_status: continue
		if ready: ready_candidates.append(quest)
		else: remaining_candidates.append(quest)
	# Stable partition before pagination; readiness never accepts or reports a quest.
	return ready_candidates + remaining_candidates

# Narrative copy is authored spoiler-safe; this bounded guard also masks location names
# accidentally included in a selected story. Typed conditions remain independently guarded.
func _story_text(value: String) -> String:
	var hidden: Array[String]=[]
	for region in game.destinations():
		if not game.is_region_visited(region.id()):
			var name: String=game.row_name(region)
			if not name.is_empty(): hidden.append(name)
	hidden.sort_custom(func(a: String,b: String): return a.length()>b.length())
	for name in hidden: value=value.replace(name,"Unvisited region")
	return value

func _quest_detail(detail: Node, actions: Node, quest, inspection_only: bool=false) -> void:
	_label(detail,_story_text(game.row_name(quest)),25)
	if quest.id()==str(game.selected_objective().get("quest_id","")):
		_label(detail,_story_text(quest.get_string("brief")),19)
		return
	var requester=quest.get_reference("requester")
	if requester!=null:
		var region=requester.get_reference("region")
		if region==null or game.is_region_visited(region.id()): _label(detail,"Requester: %s / %s"%[game.row_name(requester),requester.get_string("occupation")],18,Color("b7c6d7"))
	if not game.content_available("quests",quest.id()): _label(detail,_story_text(_unlock_reason("quests",quest.id())),17,Color("ffd166"))
	var brief: String=_story_text(quest.get_string("brief"))
	var claimed: bool=game.quest_claimed(quest)
	var conditions: Array=game.quest_condition_summaries(quest.id())
	_label(detail,"Requirements",21)
	var deliveries: Dictionary={}
	for condition in conditions:
		var kind: String=str(condition.kind)
		var caption: String={"kill":"Defeat","gather":"Gather","craft":"Craft","own_equipment":"Own equipment","deliver":"Deliver"}.get(kind,"Requirement")
		var target: String=_quest_condition_target(condition)
		var progress: String="Done" if claimed else ("%d / %d"%[int(condition.current),int(condition.target)])
		_label(detail,"%s：%s  %s"%[caption,target,progress],18,Color("79e2cc") if claimed or bool(condition.ready) else Color("f2f6fb"))
		var region_id: String=str(condition.get("target_region_id",""))
		if not region_id.is_empty(): _label(detail,"Location: "+_region_label(region_id),15,Color("b7c6d7"))
		if kind=="deliver":
			var material_id: String=str(condition.target_material_id)
			deliveries[material_id]=int(deliveries.get(material_id,0))+int(condition.target)
	if not deliveries.is_empty() and not claimed:
		_label(detail,"Completing this quest consumes the required delivery materials from your inventory.",17,Color("ffd166"))
		for material_id in deliveries:
			var material=game.database.by_id("materials",str(material_id))
			var material_name: String="Unknown material"
			for condition in conditions:
				if str(condition.get("target_material_id",""))==str(material_id): material_name=_quest_condition_target(condition);break
			_label(detail,"%s: Owned %d / Deliver %d"%[material_name,game.inventory_count(material),int(deliveries[material_id])],16,_item_color("materials",str(material_id)))
	var quote: Dictionary=game.quest_claim_quote(quest.id())
	_label(actions,_quest_reward_label(quest),17,Color("79e2cc"))
	var complete_count: int = conditions.filter(func(condition): return bool(condition.ready)).size()
	_label(actions,"Requirements: %d / %d met%s" % [complete_count,conditions.size()," • consumes delivery items" if not deliveries.is_empty() else ""],15)
	if not brief.is_empty(): _label(detail,brief,17)
	var context: String=_story_text(quest.get_string("context"))
	if not context.is_empty():
		_label(detail,"Background",19,Color("b7c6d7"))
		_label(detail,context,17)
	if not inspection_only and not claimed:
		var tracked_id: String=quest.id()
		if tracked_id==_tracked_quest_id: _button(detail,"Stop tracking",func(): _tracked_quest_id="";_refresh())
		else: _button(detail,"Track this quest",func(): _track_quest(tracked_id))
	if claimed:
		_label(detail,"Completed",20)
		var outcome: String=_story_text(quest.get_string("outcome"))
		if not outcome.is_empty(): _label(detail,outcome,19,Color("79e2cc"))
	elif not inspection_only and not game.quest_is_accepted(quest.id()):
		var id: String=quest.id()
		_button(actions,"Accept",func(): _act(func(): return game.accept_quest(id),"Quest accepted."),game.content_available("quests",id),true)
	elif not inspection_only:
		if game.content_available("quests",quest.id()) and not bool(quote.ok) and (game.quest_progress(quest)>=game.quest_target(quest) or bool(quote.get("unreachable",false))): _label(detail,str(quote.error),16,Color("ffd166"))
		var id: String=quest.id()
		_button(actions,"Deliver and complete" if not deliveries.is_empty() else "Complete and claim reward",func(): _claim(id),bool(quote.ok),true)

func _quest_condition_target(condition: Dictionary) -> String:
	var table: String=""
	var id: String=""
	for entry in [["target_enemy_id","enemies"],["target_material_id","materials"],["target_equipment_id","equipment"]]:
		if not str(condition.get(entry[0],"")).is_empty(): id=str(condition[entry[0]]);table=entry[1];break
	if id.is_empty(): return "Enemies in the target region" if str(condition.kind)=="kill" else "Required activity"
	var row=game.database.by_id(table,id)
	if row==null: return "Target unavailable"
	var region_id: String=str(condition.get("target_region_id",""))
	if region_id.is_empty():
		var region=row.get_reference("region_ref")
		if region==null: region=row.get_reference("source_region")
		if region!=null: region_id=region.id()
	var known: bool=region_id.is_empty() or game.is_region_visited(region_id)
	if table=="materials" and game.inventory_count(row)>0: known=true
	if table=="equipment" and game.owns_equipment(row): known=true
	return game.row_name(row) if known else {"enemies":"Unknown enemy","materials":"Unknown material","equipment":"Unknown equipment"}.get(table,"Unknown target")

func _reload_data(initial: bool = false) -> void:
	var main_result: Dictionary = game.load_main()
	_error = "" if main_result.ok else str(main_result.error)
	_main_hash = FileAccess.get_sha256(game.main_path) if FileAccess.file_exists(game.main_path) else ""
	if not initial: _message = "Data reloaded. Your progress is preserved." if main_result.ok else "Keeping the previous data."
	_refresh()

func _debug_view() -> void:
	_button(_body,"Back to game  F3",func(): _debug = false; _refresh())
	var column := _scroll(_panel(_body))
	_label(column,"DEVCEL / DEBUG",24)
	_label(column,"MAIN G%d / %d rows / %.1f ms\n%s\nState %s / Region %s\nManual save: user://progress (one local slot; compatible game data updates supported)." % [game.generation,game.total_rows,game.load_ms,str(game.database.manifest().get("content_hash","")),game.activity,game.region_key],16)
	var watch := CheckButton.new()
	watch.text = "Watch for file changes"
	watch.button_pressed = _watch
	watch.toggled.connect(func(on: bool): _watch = on)
	column.add_child(watch)
	_button(column,"Reload  R",func(): _reload_data())
	_label(column,"\n".join(game.logs),14,Color("b7c6d7"))

func _process(delta: float) -> void:
	if not _watch: return
	_watch_elapsed += delta
	if _watch_elapsed < 1.0: return
	_watch_elapsed = 0.0
	var current: String = FileAccess.get_sha256(game.main_path) if FileAccess.file_exists(game.main_path) else ""
	if current != _main_hash: _reload_data()

func _unhandled_key_input(event: InputEvent) -> void:
	if is_instance_valid(_inventory_dialog) and _inventory_dialog.visible: return
	if is_instance_valid(_progress_dialog): return
	if not event is InputEventKey or not event.pressed or event.echo: return
	if event.keycode == KEY_F3: _debug = not _debug; _refresh()
	elif event.keycode == KEY_R: _reload_data()
	elif event.keycode == KEY_F12: _capture()
	elif event.keycode == KEY_ESCAPE:
		if _debug: _debug = false; _refresh()
		elif game.activity == game.BASE and _screen != "base": _open("base")
		elif game.activity in [game.PURPOSE,game.BASE]: _confirm_exit()

func _confirm_exit() -> void:
	var dialog := ConfirmationDialog.new()
	dialog.title = "Quit game?"
	dialog.dialog_text = "Changes since your last manual save will be lost."
	dialog.ok_button_text = "Quit"
	dialog.cancel_button_text = "Continue"
	dialog.confirmed.connect(func(): get_tree().quit())
	dialog.canceled.connect(func(): dialog.queue_free())
	add_child(dialog)
	dialog.popup_centered(Vector2i(440,160))

func _capture() -> void:
	if _capture_dir.is_empty():
		_message = "No screenshot output directory is configured."
		_refresh()
		return
	var path: String = _capture_dir.path_join("forge-%s-%d.png" % [game.activity,Time.get_ticks_msec()])
	var result: int = get_viewport().get_texture().get_image().save_png(path)
	_message = "Screenshot saved." if result == OK else "Could not save screenshot: "+error_string(result)
	_refresh()

func _catalog_name(kind: String, row) -> String:
	if kind == "recipes":
		var equipment = row.get_reference("equipment")
		if equipment != null: return game.row_name(equipment)
	return game.row_name(row)

func _quest_reward_label(quest) -> String:
	var quote: Dictionary=game.quest_claim_quote(quest.id(),true)
	var gold_reward: int=maxi(0,quest.get_int("gold"))
	var mastery_reward: int=int(quote.get("mastery",0))
	return "Reward %d G"%gold_reward+(" / Mastery +%d"%mastery_reward if mastery_reward>0 else "")

func _select_shop(id: String) -> void:
	if game.select_row("shops",id):
		_selected["materials"] = ""
		_pages["materials"] = 0
		_message = ""
	else: _message = str(game.logs[-1]).trim_prefix("TIP  ")
	_refresh_preserving_scroll()

func _catalog_rows(kind: String) -> Array:
	if kind == "quests": return _rows(kind).filter(func(row): return _content_discovered(kind,row))
	if kind != "materials" or _screen != "shop": return _rows(kind)
	if not _content_discovered("shops",game.database.by_id("shops",str(game.selected_ids.get("shops","")))): return []
	var result: Array = []
	var seen: Dictionary = {}
	for offer in game.offers_for_shop():
		var material = offer.get_reference("material")
		if material == null or seen.has(material.id()): continue
		var buy_offer: bool = offer.get_bool("buy_enabled") and offer.get_int("buy_price") > 0
		var sell_offer: bool = offer.get_bool("sell_enabled") and offer.get_int("sell_price") > 0 and game.inventory_count(material) > 0
		if not buy_offer and not sell_offer: continue
		seen[material.id()] = true
		result.append(material)
	return result

func _row_region_label(row) -> String:
	var region = row.get_reference("region_ref")
	return _region_label(region.id()) if region != null else "All regions"

func _content_discovered(kind: String, row) -> bool:
	if row == null: return false
	var region = row.get_reference("region_ref")
	if region != null and not game.is_region_visited(region.id()): return false
	if kind == "shops" and region == null: return false
	if kind == "quests" and game.database.table("quest_conditions")==null:
		for reference in ["target_material","target_equipment"]:
			var target = row.get_reference(reference)
			if target == null: continue
			var source = target.get_reference("source_region")
			if source == null: source = target.get_reference("region_ref")
			if source != null and not game.is_region_visited(source.id()): return false
	return true

func _return_priority_quests(ready: Array) -> Array:
	var result: Array=ready.duplicate()
	var goal_id: String=str(game.selected_objective().get("quest_id",""))
	var rank: Callable=func(id):
		if str(id)==goal_id: return 0
		var quest=game.database.by_id("quests",str(id))
		var region=quest.get_reference("region_ref") if quest!=null else null
		if region==null: return 1
		return 2 if region.id()==game.region_id else 3
	result.sort_custom(func(a,b): return rank.call(a)<rank.call(b))
	return result.slice(0,4)

func _visible_unaccepted_ready_quests() -> Array:
	return game.available_unaccepted_quest_ids().filter(func(id): return _content_discovered("quests",game.database.by_id("quests",str(id))))

func _visible_ready_quests() -> Array:
	return game.ready_quest_ids().filter(func(id): return _content_discovered("quests",game.database.by_id("quests",str(id))))

func _job_reason_for_display(job, reason: String) -> String:
	var quest = job.get_reference("required_quest")
	if quest != null and not _content_discovered("quests",quest) and reason.contains(game.row_name(quest)): return "Complete quests in visited regions"
	for enemy in game.job_trial_enemies(job.id()):
		if not _content_discovered("enemies",enemy) and reason.contains(game.row_name(enemy)): return "Find the trial in an unexplored region"
	return reason

func _saved_time(value) -> String:
	return Time.get_datetime_string_from_unix_time(int(value)).replace("T"," ") + " UTC"

func _save_progress() -> void:
	var result: Dictionary = _save_store.save_game(game,_tracked_quest_id)
	_error = ""
	_message = "Progress saved on this device." if result.ok else str(result.error)
	_save_status.text = "Saved: " + _saved_time(_save_store.checkpoint_info().get("saved_at",0)) if result.ok else "Save failed: " + str(result.error)
	_save_status.add_theme_color_override("font_color",Color("79e2cc") if result.ok else Color("ffd166"))
	_refresh()

func _confirm_progress_action(title_text: String, text: String, action: Callable, confirm_text: String = "") -> void:
	if is_instance_valid(_progress_dialog): return
	_progress_dialog = ConfirmationDialog.new()
	_progress_dialog.title = title_text
	_progress_dialog.dialog_text = text
	_progress_dialog.ok_button_text = confirm_text if not confirm_text.is_empty() else ("Load" if title_text == "Load saved game?" else "New game")
	_progress_dialog.cancel_button_text = "Cancel"
	_progress_dialog.confirmed.connect(func():
		_progress_dialog.queue_free()
		_progress_dialog = null
		action.call())
	_progress_dialog.canceled.connect(func():
		_progress_dialog.queue_free()
		_progress_dialog = null)
	add_child(_progress_dialog)
	_progress_dialog.popup_centered(Vector2i(480,180))

func _confirm_load() -> void:
	var info: Dictionary = _save_store.checkpoint_info()
	if not info.ok:
		_save_status.text = "Save preview unavailable: " + str(info.error)
		if _save_store.has_save(): _confirm_progress_action("Load saved game?","The latest checkpoint preview is unavailable. Check for a recoverable save? Unsaved changes will be lost.",_load_progress)
		return
	var summary: String = "Saved: %s\n%s • HP %d / %d • %d G\n\nReplace current progress? Unsaved changes will be lost." % [_saved_time(info.saved_at),str(info.location),int(info.hp),int(info.max_hp),int(info.gold)]
	_confirm_progress_action("Load saved game?",summary,_load_progress)

func _confirm_new_game() -> void:
	_confirm_progress_action("Start a new game?","Discard current unsaved progress and choose a new grand quest? Your existing saved game will remain until you press Save.",_new_game)

func _reset_progress_view() -> void:
	if _gain_tween != null: _gain_tween.kill()
	_pending_discoveries = 0
	_visible_discoveries = 0
	_clear_item_gains()
	_selected.clear()
	_pinned_recipe_id = ""
	_queries.clear()
	_pages.clear()
	_map_view_state.clear()
	_map_first_neighborhood_shown = false
	_quality_id = game.selected_quality_id
	_quest_view_active = false
	_quest_context_open = false
	_return_journal = false
	_screen = "base"
	_debug = false
	_error = ""
	_main_hash = FileAccess.get_sha256(game.main_path)
	_refresh()

func _load_progress() -> void:
	var result: Dictionary = _save_store.load_game(game.main_path,game)
	if not result.ok:
		_message = str(result.error)
		_save_status.text = "Load failed: " + str(result.error)
		_refresh()
		return
	if result.get("recovered",false):
		_confirm_progress_action("Recover previous save?","The newest save is damaged. Load the previous valid checkpoint instead? Progress after that older save will not be restored.",func(): _apply_loaded_progress(result),"Recover")
		return
	_apply_loaded_progress(result)

func _apply_loaded_progress(result: Dictionary) -> void:
	game = result.model
	_tracked_quest_id = result.tracked
	_message = "Recovered the previous saved checkpoint." if result.get("recovered",false) else "Saved progress loaded."
	if not str(result.get("notice","")).is_empty(): _message += " " + str(result.notice)
	_reset_progress_view()

func _new_game() -> void:
	var next_game = RpgModel.new()
	var result: Dictionary = next_game.load_main(game.main_path)
	if not result.ok:
		_message = str(result.error)
		_save_status.text = "Load failed: " + str(result.error)
		_refresh()
		return
	game = next_game
	_tracked_quest_id = ""
	_message = "New game started. Your existing save has not been changed."
	_reset_progress_view()
