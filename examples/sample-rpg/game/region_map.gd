extends Control
## Presentation only: all topology, access decisions and routes come from the model.
## Nodes: {id: region UUID, position: [x, y], name: optional display name}.
## Edges are explicit undirected pairs, matching region_graph in expedition_model.
signal region_selected(region_id: String)

const NODE_SIZE = Vector2(190.0, 112.0)
signal viewport_changed(state: Dictionary)
const OPEN_COLOR = Color("ecf2f7")
const MUTED_COLOR = Color("b6c2d0")
const ROUTE_COLOR = Color("ffd166")
const CURRENT_COLOR = Color("79e2cc")

var _nodes: Array[Dictionary] = []
var _edges: Array = []
var _buttons: Dictionary = {}
var _centres: Dictionary = {}
var _unlocked: Dictionary = {}
var _current_id: String = ""
var _goal_id: String = ""
var _selected_id: String = ""
var _route: Array[String] = []
var _legend: Label
var _hint: Label
var _canvas: Control
var _world_points: Array[Vector2] = []
var _camera: Vector2 = Vector2.ZERO
var _camera_initialized: bool = false
var _world_scale: float = 160.0
var _zoom: float = 1.0
var _dragging: bool = false
var _zoom_out: Button
var _zoom_in: Button
var _focus_button: Button
var _selected_button: Button
var _nearby_button: Button
var _min_zoom: float = 1.0
var _overview: bool = false
var _anchor_id: String = ""
var _anchor_caption: String = ""
var _clusters: Array[Dictionary] = []
var _cluster_buttons: Array[Button] = []
var _drag_distance: float = 0.0
var _suppress_click: bool = false
var _keyboard_navigation: bool = false
var _pending_frame_id: String = ""

func _ready() -> void:
	custom_minimum_size = Vector2(620.0, 380.0)
	mouse_filter = Control.MOUSE_FILTER_PASS
	clip_contents = true
	_canvas = Control.new()
	_canvas.clip_contents = true
	_canvas.mouse_filter = Control.MOUSE_FILTER_PASS
	_canvas.draw.connect(_draw_graph)
	_canvas.gui_input.connect(_map_input)
	add_child(_canvas)
	for button in _buttons.values(): button.reparent(_canvas)
	_legend = Label.new()
	_legend.text = "Exploration map"
	_legend.add_theme_font_size_override("font_size", 18)
	_legend.add_theme_color_override("font_color", OPEN_COLOR)
	_legend.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_legend.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_legend)
	_hint = Label.new()
	_hint.text = "Drag to pan, scroll to zoom / Yellow: clue to your goal"
	_hint.add_theme_font_size_override("font_size", 13)
	_hint.add_theme_color_override("font_color", MUTED_COLOR)
	_hint.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_hint)
	_zoom_out = _toolbar_button("－",func(): _set_zoom(_zoom / 1.2))
	_zoom_in = _toolbar_button("＋",func(): _set_zoom(_zoom * 1.2))
	_focus_button = _toolbar_button("Current",func(): focus_region(_anchor_id))
	_selected_button = _toolbar_button("Selected",func(): focus_region(_selected_id))
	_selected_button.tooltip_text = "Center and zoom to the selected region."
	_nearby_button = _toolbar_button("Overview",frame_discovered)
	_nearby_button.tooltip_text = "Show known regions and unexplored routes beside visited places. Dense areas are grouped by count."
	resized.connect(_layout_nodes)
	_layout_nodes()

func set_graph(nodes: Array, edges: Array) -> bool:
	# Validate atomically, so a rejected refresh does not destroy the visible map.
	var candidate: Array[Dictionary] = []
	var all_nodes: Array[Dictionary] = []
	var ids: Dictionary = {}
	var all_points: Array[Vector2] = []
	for raw in nodes:
		if not raw is Dictionary: return false
		var id_value = raw.get("id")
		var point = raw.get("position")
		if not id_value is String or id_value.is_empty() or ids.has(id_value): return false
		if not point is Array or point.size() != 2: return false
		if not _number(point[0]) or not _number(point[1]): return false
		var position_value := Vector2(float(point[0]), float(point[1]))
		if not position_value.is_finite() or all_points.has(position_value): return false
		all_points.append(position_value)
		var discovered: bool = bool(raw.get("discovered",true))
		var visited: bool = bool(raw.get("visited",true))
		var display_name: String = (str(raw.get("name", "Region")) if visited else "Unexplored region") if discovered else "?"
		all_nodes.append({"id": id_value, "name": display_name, "position": position_value, "visited": visited and discovered, "discovered": discovered})
		ids[id_value] = discovered
	var candidate_edges: Array = []
	var frontier: Dictionary = {}
	var visited_ids: Dictionary = {}
	for node in all_nodes: visited_ids[node.id] = node.visited
	for edge in edges:
		if not edge is Array or edge.size() != 2: return false
		if not edge[0] is String or not edge[1] is String: return false
		if not ids.has(edge[0]) or not ids.has(edge[1]): return false
		if (ids[edge[0]] and ids[edge[1]]) or visited_ids[edge[0]] or visited_ids[edge[1]]:
			candidate_edges.append(edge.duplicate())
			if not ids[edge[0]]: frontier[edge[0]] = true
			if not ids[edge[1]]: frontier[edge[1]] = true
	for node in all_nodes:
		if node.discovered or frontier.has(node.id): candidate.append(node)
	_world_points = all_points
	_world_scale = _minimum_world_scale(all_points)
	_nodes = candidate
	var visible_points: Array[Vector2] = []
	for node in _nodes: visible_points.append(node.position)
	_min_zoom = minf(1.0,_minimum_world_scale(visible_points)/_world_scale) if visible_points.size()>1 else 0.01
	if not _overview: _zoom = clampf(_zoom,_min_zoom,4.0)
	_edges = candidate_edges
	for old_button in _buttons.values():
		old_button.get_parent().remove_child(old_button)
		old_button.queue_free()
	_buttons.clear()
	for node in _nodes:
		var button := Button.new()
		button.name = "Region_%d" % _buttons.size()
		button.size = _node_size()
		button.focus_mode = Control.FOCUS_ALL
		button.clip_text = true
		button.add_theme_font_size_override("font_size", 18)
		var title := Label.new()
		title.name = "RegionTitle"
		title.position = Vector2(12, 10)
		title.size = Vector2(NODE_SIZE.x - 24, 54)
		title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		title.max_lines_visible = 2
		title.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		title.add_theme_font_size_override("font_size", 18)
		title.mouse_filter = Control.MOUSE_FILTER_IGNORE
		button.add_child(title)
		var status := Label.new()
		status.name = "RegionStatus"
		status.position = Vector2(12, 78)
		status.size = Vector2(NODE_SIZE.x - 24, 24)
		status.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		status.add_theme_font_size_override("font_size", 15)
		status.add_theme_color_override("font_color", MUTED_COLOR)
		status.mouse_filter = Control.MOUSE_FILTER_IGNORE
		button.add_child(status)
		var region_id: String = node.id
		button.pressed.connect(_select_region.bind(region_id))
		button.gui_input.connect(_node_input)
		(_canvas if _canvas != null else self).add_child(button)
		button.focus_entered.connect(_ensure_region_visible.bind(region_id))
		_buttons[region_id] = button
	if not _camera_initialized and not _nodes.is_empty():
		_camera = _nodes[0].position
		_camera_initialized = true
	_style_nodes()
	_layout_nodes()
	return true

func set_state(unlocked_ids: Array, current_id: String, goal_id: String,
		selected_id: String, route_ids: Array) -> void:
	_unlocked.clear()
	for id_value in unlocked_ids:
		if id_value is String: _unlocked[id_value] = true
	_current_id = current_id
	_goal_id = goal_id
	_selected_id = selected_id
	_route.clear()
	for id_value in route_ids:
		if id_value is String: _route.append(id_value)
	_style_nodes()
	if _selected_button != null: _selected_button.disabled = not _buttons.has(_selected_id)
	if _canvas != null: _canvas.queue_redraw()
	queue_redraw()

func focus_region(region_id: String) -> bool:
	if not _buttons.has(region_id): return false
	_pending_frame_id = ""
	_overview=false
	_zoom=maxf(_zoom,_min_zoom)
	for node in _nodes:
		if str(node.id) == region_id: _camera = node.position; break
	_layout_nodes()
	_emit_viewport()
	_buttons[region_id].grab_focus()
	return true

func _select_region(region_id: String) -> void:
	# A locked node is inspectable. This event never grants access or departs.
	if _suppress_click or not _buttons.has(region_id): return
	_selected_id = region_id
	if _selected_button != null: _selected_button.disabled = false
	_style_nodes()
	# Selection inspects a node. Framing is reserved for explicit toolbar actions.
	_emit_viewport()
	region_selected.emit(region_id)

func _number(value) -> bool:
	return value is int or value is float

func _style_nodes() -> void:
	for node in _nodes:
		var region_id: String = node.id
		if not _buttons.has(region_id): continue
		var button: Button = _buttons[region_id]
		var here: bool = node.discovered and (region_id == _current_id or region_id == _anchor_id)
		var available: bool = node.discovered and _unlocked.has(region_id)
		var status_text: String = "You are here" if here else ("Available" if available else "Locked")
		if not node.discovered: status_text = "Undiscovered"
		elif region_id == _goal_id: status_text += " / Goal"
		var title: Label = button.get_node("RegionTitle")
		title.text = str(node.name)
		title.add_theme_color_override("font_color", OPEN_COLOR if available or here else MUTED_COLOR)
		button.get_node("RegionStatus").text = status_text
		button.tooltip_text = "%s\n%s\nSelect to inspect" % [node.name, status_text]
		button.add_theme_color_override("font_color", OPEN_COLOR if available or here else MUTED_COLOR)
		button.add_theme_color_override("font_hover_color", Color.WHITE)
		button.add_theme_color_override("font_focus_color", Color.WHITE)
		button.add_theme_color_override("font_pressed_color", Color.WHITE)
		var outline: Color = Color("718196")
		if region_id == _current_id or region_id == _anchor_id: outline = CURRENT_COLOR
		if node.discovered and region_id == _goal_id: outline = ROUTE_COLOR
		if region_id == _selected_id: outline = Color.WHITE
		var fill: Color = Color("253244") if available else Color("17202b")
		button.add_theme_stylebox_override("normal", _style(fill, outline, 3 if region_id == _selected_id else 2))
		button.add_theme_stylebox_override("hover", _style(Color("36485e"), Color.WHITE, 2))
		button.add_theme_stylebox_override("pressed", _style(Color("405570"), Color.WHITE, 3))
		button.add_theme_stylebox_override("focus", _style(Color(0, 0, 0, 0), Color.WHITE, 3))

func _style(fill: Color, border: Color, width: int) -> StyleBoxFlat:
	var result := StyleBoxFlat.new()
	result.bg_color = fill
	result.border_color = border
	result.set_border_width_all(width)
	result.set_corner_radius_all(8)
	result.content_margin_left = 3
	result.content_margin_right = 3
	result.content_margin_top = 5
	result.content_margin_bottom = 5
	return result

func _layout_nodes() -> void:
	if _canvas == null: return
	_canvas.position = Vector2(0,58)
	_canvas.size = Vector2(size.x,maxf(1,size.y-94))
	if not _pending_frame_id.is_empty() and size.x >= custom_minimum_size.x and size.y >= custom_minimum_size.y:
		var pending: String = _pending_frame_id
		_pending_frame_id = ""
		frame_neighborhood(pending)
		return
	_legend.position = Vector2(18,15)
	_legend.size = Vector2(maxf(0,size.x-474),30)
	_hint.position = Vector2(18,maxf(0,size.y-28))
	_hint.size = Vector2(maxf(0,size.x-36),22)
	_zoom_out.position = Vector2(size.x-446,10)
	_zoom_out.size = Vector2(40,38)
	_zoom_out.disabled = _zoom <= 0.00001
	_zoom_in.position = Vector2(size.x-400,10)
	_zoom_in.size = Vector2(40,38)
	_zoom_in.disabled = _zoom >= 3.999
	_focus_button.position = Vector2(size.x-354,10)
	_focus_button.size = Vector2(98,38)
	_selected_button.position = Vector2(size.x-248,10)
	_selected_button.size = Vector2(110,38)
	_nearby_button.position = Vector2(size.x-130,10)
	_nearby_button.size = Vector2(112,38)
	_centres.clear()
	for node in _nodes:
		var point: Vector2 = _canvas.size*0.5 + (node.position-_camera)*_world_scale*_zoom
		_centres[node.id] = point
		var button: Button = _buttons[node.id]
		button.position = point-NODE_SIZE*0.5
		button.size = NODE_SIZE
		button.visible = not _overview
	_rebuild_overview()
	if is_inside_tree(): _set_focus_neighbours()
	_canvas.queue_redraw()
	queue_redraw()

func _minimum_world_scale(points: Array[Vector2]) -> float:
	# Keep authored relative coordinates and readable cards, even for large worlds.
	# Full data positions determine scale once; discovery never refits the map.
	var required: float = 1.0
	for first in range(points.size()):
		for second in range(first+1,points.size()):
			var delta: Vector2 = (points[first]-points[second]).abs()
			var x_scale: float = (NODE_SIZE.x+24)/delta.x if delta.x > 0 else INF
			var y_scale: float = (NODE_SIZE.y+24)/delta.y if delta.y > 0 else INF
			required = maxf(required,minf(x_scale,y_scale))
	return required if points.size()>1 else 160.0

func _toolbar_button(text: String, action: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.add_theme_font_size_override("font_size",18)
	button.pressed.connect(action)
	add_child(button)
	return button

func _set_zoom(value: float) -> void:
	_pending_frame_id = ""
	_zoom = clampf(value,0.00001,4.0)
	_overview = _zoom < _min_zoom-0.000001
	_layout_nodes()
	_emit_viewport()

func _begin_drag() -> void:
	_dragging=true
	_drag_distance=0.0
	_suppress_click=false

func _node_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index in [MOUSE_BUTTON_LEFT,MOUSE_BUTTON_MIDDLE] and event.pressed: _begin_drag()

func _map_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP and event.pressed: _set_zoom(_zoom*1.2);accept_event()
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN and event.pressed: _set_zoom(_zoom/1.2);accept_event()
		elif event.button_index in [MOUSE_BUTTON_LEFT,MOUSE_BUTTON_MIDDLE]:
			if event.pressed: _begin_drag()
			else: _dragging=false;call_deferred("_clear_click_suppression")
			accept_event()

func _clear_click_suppression() -> void:
	_suppress_click=false

func _ensure_region_visible(id: String) -> void:
	# Mouse focus must not pan a partially visible card out from under the pointer.
	if not _keyboard_navigation or _canvas == null or not _buttons.has(id): return
	var rect: Rect2 = _buttons[id].get_rect()
	if not Rect2(Vector2.ZERO,_canvas.size).encloses(rect):
		for node in _nodes:
			if str(node.id)==id: _camera=node.position;break
		_layout_nodes()
		_emit_viewport()

func get_view_state() -> Dictionary:
	return {"camera":[_camera.x,_camera.y],"zoom":_zoom,"overview":_overview}

func set_view_state(state: Dictionary) -> bool:
	var camera = state.get("camera")
	var zoom = state.get("zoom")
	if not camera is Array or camera.size()!=2 or not _number(camera[0]) or not _number(camera[1]) or not _number(zoom): return false
	var point := Vector2(float(camera[0]),float(camera[1]))
	if not point.is_finite() or not is_finite(float(zoom)): return false
	_pending_frame_id = ""
	_camera=point
	_camera_initialized=true
	_overview=bool(state.get("overview",false))
	_zoom=clampf(float(zoom),0.00001 if _overview else _min_zoom,4.0)
	_layout_nodes()
	return true

func _emit_viewport() -> void:
	viewport_changed.emit(get_view_state())

func _set_focus_neighbours() -> void:
	for index in range(_nodes.size()):
		var region_id: String = _nodes[index].id
		var button: Button = _buttons[region_id]
		button.focus_next = button.get_path_to(_buttons[_nodes[(index + 1) % _nodes.size()].id])
		button.focus_previous = button.get_path_to(_buttons[_nodes[posmod(index - 1, _nodes.size())].id])
		for direction in [Vector2.LEFT, Vector2.RIGHT, Vector2.UP, Vector2.DOWN]:
			var chosen: String = region_id
			var best: float = INF
			for other in _nodes:
				if other.id == region_id: continue
				var difference: Vector2 = _centres[other.id] - _centres[region_id]
				var forward: float = difference.dot(direction)
				if forward <= 0: continue
				var lateral: float = absf(difference.cross(direction))
				var score: float = difference.length() + lateral * 2.0
				if score < best:
					best = score
					chosen = other.id
			var path: NodePath = button.get_path_to(_buttons[chosen])
			if direction == Vector2.LEFT: button.focus_neighbor_left = path
			elif direction == Vector2.RIGHT: button.focus_neighbor_right = path
			elif direction == Vector2.UP: button.focus_neighbor_top = path
			else: button.focus_neighbor_bottom = path

func _route_edge(first: String, second: String) -> bool:
	for index in range(maxi(0, _route.size() - 1)):
		if (_route[index] == first and _route[index + 1] == second) or (_route[index] == second and _route[index + 1] == first): return true
	return false

func _draw() -> void:
	draw_style_box(_style(Color("101720"),Color("465468"),1),Rect2(Vector2.ZERO,size))

func _draw_graph() -> void:
	var drawn: Dictionary={}
	for edge in _edges:
		if not _centres.has(edge[0]) or not _centres.has(edge[1]): continue
		var first: Vector2=_centres[edge[0]]
		var second: Vector2=_centres[edge[1]]
		if _overview:
			first=_cluster_centre(str(edge[0]))
			second=_cluster_centre(str(edge[1]))
			if first==second: continue
			var key: String=str(first)+str(second)
			if drawn.has(key): continue
			drawn[key]=true
		var highlighted: bool = _route_edge(edge[0],edge[1])
		_canvas.draw_line(first,second,ROUTE_COLOR if highlighted else Color("718196"),4.0 if highlighted else 2.0,true)

func _node_size() -> Vector2:
	return NODE_SIZE

func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed:
		_keyboard_navigation = event.keycode in [KEY_TAB,KEY_LEFT,KEY_RIGHT,KEY_UP,KEY_DOWN]
	elif event is InputEventMouseButton:
		_keyboard_navigation = false
	if _dragging and event is InputEventMouseMotion:
		_drag_distance+=event.relative.length()
		if _drag_distance>6.0:
			_suppress_click=true
			_camera-=event.relative/(_world_scale*_zoom)
			_layout_nodes()
			_emit_viewport()
	if _dragging and event is InputEventMouseButton and not event.pressed and event.button_index in [MOUSE_BUTTON_LEFT,MOUSE_BUTTON_MIDDLE]:
		_dragging=false
		call_deferred("_clear_click_suppression")

func frame_neighborhood(id: String) -> bool:
	if not _buttons.has(id): return false
	if _canvas == null or size.x < custom_minimum_size.x or size.y < custom_minimum_size.y:
		_pending_frame_id = id
		return true
	_pending_frame_id = ""
	var wanted: Dictionary = {id:true}
	for edge in _edges:
		if edge[0]==id: wanted[edge[1]]=true
		elif edge[1]==id: wanted[edge[0]]=true
	var points: Array[Vector2] = []
	for node in _nodes:
		if wanted.has(str(node.id)): points.append(node.position)
	var minimum: Vector2=points[0]
	var maximum: Vector2=points[0]
	for point in points: minimum=minimum.min(point);maximum=maximum.max(point)
	var extent: Vector2=maximum-minimum
	var available: Vector2=(_canvas.size-NODE_SIZE-Vector2(48,48)).max(Vector2.ONE)
	var fit: float=4.0*_world_scale
	if extent.x>0: fit=minf(fit,available.x/extent.x)
	if extent.y>0: fit=minf(fit,available.y/extent.y)
	_camera=(minimum+maximum)*0.5
	_overview=false
	_zoom=clampf(fit/_world_scale,_min_zoom,4.0)
	_layout_nodes()
	_emit_viewport()
	return true

func set_map_anchor(id: String, caption: String, tooltip: String) -> void:
	_anchor_id=id
	_anchor_caption=caption
	if _focus_button!=null:
		_focus_button.tooltip_text="Center on the current region. " + tooltip
		_focus_button.disabled=not _buttons.has(id)
	_style_nodes()

func frame_discovered() -> bool:
	if _nodes.is_empty() or _canvas==null: return false
	_pending_frame_id = ""
	var minimum: Vector2=_nodes[0].position
	var maximum: Vector2=minimum
	for node in _nodes: minimum=minimum.min(node.position);maximum=maximum.max(node.position)
	var extent: Vector2=maximum-minimum
	var available: Vector2=(_canvas.size-Vector2(100,100)).max(Vector2.ONE)
	var fit: float=4.0*_world_scale
	if extent.x>0: fit=minf(fit,available.x/extent.x)
	if extent.y>0: fit=minf(fit,available.y/extent.y)
	_camera=(minimum+maximum)*0.5
	_zoom=clampf(fit/_world_scale,0.00001,4.0)
	_overview=_zoom<_min_zoom
	if not _overview:
		available=(_canvas.size-NODE_SIZE-Vector2(48,48)).max(Vector2.ONE)
		if extent.x>0: fit=minf(fit,available.x/extent.x)
		if extent.y>0: fit=minf(fit,available.y/extent.y)
		_zoom=clampf(fit/_world_scale,0.00001,4.0)
		_overview=_zoom<_min_zoom
	_layout_nodes()
	_emit_viewport()
	return true

func _rebuild_overview() -> void:
	for button in _cluster_buttons: button.get_parent().remove_child(button);button.queue_free()
	_cluster_buttons.clear()
	_clusters.clear()
	if not _overview: return
	var bins: Dictionary={}
	for node in _nodes:
		var point: Vector2=_centres[node.id]
		var cell:=Vector2i(floori(point.x/48),floori(point.y/48))
		if not bins.has(cell): bins[cell]=[]
		bins[cell].append(str(node.id))
	for cell in bins:
		var ids: Array=bins[cell]
		var centre: Vector2=Vector2(cell)*48+Vector2(24,24)
		_clusters.append({"ids":ids,"centre":centre})
		var button:=Button.new()
		button.position=centre-Vector2(20,20)
		button.size=Vector2(40,40)
		button.add_theme_font_size_override("font_size",18)
		button.text=str(ids.size()) if ids.size()>1 else "●"
		button.tooltip_text="%d regions - Click to zoom"%ids.size()
		if ids.size()==1:
			for node in _nodes:
				if str(node.id)==str(ids[0]): button.tooltip_text=str(node.name)
		var outline: Color=Color("718196")
		if ids.has(_anchor_id): outline=CURRENT_COLOR
		if ids.has(_selected_id): outline=Color.WHITE
		button.add_theme_stylebox_override("normal",_style(Color("253244"),outline,2))
		button.gui_input.connect(_node_input)
		button.pressed.connect(func(): _activate_cluster(ids))
		_canvas.add_child(button)
		_cluster_buttons.append(button)

func _activate_cluster(ids: Array) -> void:
	if _suppress_click: return
	if ids.size()==1:
		_select_region(str(ids[0]))
	else:
		var centre:=Vector2.ZERO
		for node in _nodes:
			if ids.has(str(node.id)): centre+=node.position
		_camera=centre/ids.size()
		_overview=false
		_zoom=_min_zoom
		_layout_nodes()
		_emit_viewport()

func _cluster_centre(id: String) -> Vector2:
	for cluster in _clusters:
		if cluster.ids.has(id): return cluster.centre
	return _centres.get(id,Vector2.ZERO)
