extends Control
var game
var pulse: float = 0.0

func _process(delta: float):
	pulse += delta
	queue_redraw()

func _draw():
	var w: float = size.x
	var h: float = size.y
	if w <= 0 or h <= 0: return
	draw_style_box(_rounded(Color("10283a")), Rect2(Vector2.ZERO, size))
	draw_circle(Vector2(w * 0.79, h * 0.19), 23, Color("dfb565"))
	draw_colored_polygon(PackedVector2Array([Vector2(0,h*.68),Vector2(w*.20,h*.30),Vector2(w*.44,h*.68)]), Color("1d4054"))
	draw_colored_polygon(PackedVector2Array([Vector2(w*.2,h*.7),Vector2(w*.57,h*.23),Vector2(w*.98,h*.7)]), Color("245066"))
	draw_colored_polygon(PackedVector2Array([Vector2(w*.52,h*.3),Vector2(w*.57,h*.23),Vector2(w*.64,h*.33)]), Color("52788b"))
	draw_rect(Rect2(0,h*.67,w,h*.33), Color("173632"))
	draw_colored_polygon(PackedVector2Array([Vector2(w*.27,h),Vector2(w*.47,h*.67),Vector2(w*.55,h*.67),Vector2(w*.68,h)]), Color("30564c"))
	for i in range(5):
		var x: float = w * .07 + i * w * .205
		draw_line(Vector2(x,h*.72),Vector2(x+6,h*.66),Color("568976"),2)
	# A small adventurer and a clearly different live enemy state.
	var hero := Vector2(w*.31,h*.67)
	draw_circle(hero + Vector2(0,-53),12,Color("ebc591"))
	draw_rect(Rect2(hero+Vector2(-12,-40),Vector2(24,31)),Color("e2b45f"))
	draw_line(hero+Vector2(-7,-9),hero+Vector2(-9,9),Color("19283c"),7)
	draw_line(hero+Vector2(7,-9),hero+Vector2(9,9),Color("19283c"),7)
	if game != null and game.sword_equipped:
		draw_line(hero+Vector2(19,-24),hero+Vector2(34,-65),Color("bce6eb"),5)
		draw_line(hero+Vector2(12,-30),hero+Vector2(29,-23),Color("dfb565"),4)
	if game != null and not game.enemy.is_empty():
		var bob: float = sin(pulse * 2.3) * 3.0
		var foe := Vector2(w*.70,h*.66+bob)
		draw_circle(foe+Vector2(0,-18),30,Color("72cfbd"))
		draw_rect(Rect2(foe+Vector2(-30,-18),Vector2(60,22)),Color("72cfbd"))
		draw_circle(foe+Vector2(-10,-22),3.5,Color("153332"))
		draw_circle(foe+Vector2(10,-22),3.5,Color("153332"))
		draw_line(foe+Vector2(-5,-10),foe+Vector2(5,-10),Color("153332"),2)
	else:
		var rock := Vector2(w*.71,h*.68)
		draw_colored_polygon(PackedVector2Array([rock+Vector2(-27,0),rock+Vector2(-18,-28),rock+Vector2(5,-36),rock+Vector2(26,-10),rock+Vector2(23,2)]),Color("52798a"))
		draw_line(rock+Vector2(-6,-25),rock+Vector2(3,-10),Color("9fdde0"),4)

func _rounded(color: Color) -> StyleBoxFlat:
	var box := StyleBoxFlat.new()
	box.bg_color = color
	box.corner_radius_top_left = 12
	box.corner_radius_top_right = 12
	box.corner_radius_bottom_left = 12
	box.corner_radius_bottom_right = 12
	return box
