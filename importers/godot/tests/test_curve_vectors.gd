extends SceneTree
const CurveReader = preload("res://addons/devcel/runtime/devcel_curve.gd")
func _initialize():
	var vectors = JSON.parse_string(FileAccess.get_file_as_string("res://tests/curve_vectors.json"))
	var passed = 0
	var failed = 0
	for entry in vectors.curves:
		var result = CurveReader.parse_text(JSON.stringify(entry.data))
		if not result.ok:
			failed += 1; printerr("Curve parse: ", entry.name, ": ", result.error); continue
		for sample in entry.samples:
			var actual = result.curve.sample(sample.x)
			if abs(actual - sample.y) < 1e-8:
				passed += 1
			else:
				failed += 1; printerr("Curve mismatch: ", entry.name, " x=",sample.x," actual=",actual," expected=",sample.y)
	# Exact roots and knots must not be perturbed by further bisection.
	for mode in ["auto", "linear", "free"]:
		var exact = CurveReader.parse_text(JSON.stringify({"points": [{"x": 0, "y": 10, "mode": mode}, {"x": 1, "y": 30, "mode": mode}]}))
		if exact.ok and exact.curve.sample(0.5) == 20.0:
			passed += 1
		else:
			failed += 1; printerr("Exact midpoint: ", mode)
	var knot = CurveReader.parse_text('{"points":[{"x":0,"y":10,"mode":"linear"},{"x":0.4,"y":20,"mode":"linear"},{"x":1,"y":30,"mode":"linear"}]}')
	if knot.ok and knot.curve.sample(0.4) == 20.0:
		passed += 1
	else:
		failed += 1; printerr("Exact knot")
	print("DEVCEL_CURVE_DIFFERENTIAL passed=%d failed=%d" % [passed,failed])
	quit(0 if failed == 0 else 1)

