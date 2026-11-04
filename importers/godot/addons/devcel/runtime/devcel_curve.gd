@tool
extends RefCounted
## Devcel Bezier curves. Evaluate saved tangents directly without approximating them as Godot Curve objects.

const MODES = ["constant", "linear", "auto", "autoLength", "free"]
const EPS = 1.0e-9
var _points: Array = []

static func parse_text(text: String, config: Dictionary = {}) -> Dictionary:
	var points: Array = []
	if not config.is_empty():
		for key in ["start_value", "end_value"]:
			if not config.has(key) or not _number(config[key]):
				return {"ok": false, "error": "curve_config.%s must be a finite number" % key}
	if text.is_empty():
		points = [{"x": 0.0, "y": config.get("start_value", 0.0), "mode": "auto"},
			{"x": 1.0, "y": config.get("end_value", 1.0), "mode": "auto"}]
	else:
		var parser = JSON.new()
		if parser.parse(text) != OK:
			return {"ok": false, "error": "Curve JSON: " + parser.get_error_message()}
		if not parser.data is Dictionary or not parser.data.get("points") is Array:
			return {"ok": false, "error": "A Curve.points array is required"}
		points = parser.data.points.duplicate(true)
	if points.size() < 2:
		return {"ok": false, "error": "Curve requires at least two points"}
	var previous = -1.0
	for i in range(points.size()):
		var point = points[i]
		if not point is Dictionary:
			return {"ok": false, "error": "Curve points must be objects"}
		if not _number(point.get("x")) or not _number(point.get("y")):
			return {"ok": false, "error": "Curve x/y must be finite numbers"}
		if point.x < 0.0 or point.x > 1.0 or point.x <= previous:
			return {"ok": false, "error": "Curve x must be strictly ascending within 0..1"}
		previous = point.x
		if point.get("mode") not in MODES:
			return {"ok": false, "error": "Invalid Curve tangent mode"}
		for key in ["outSlope", "inSlope", "outLen", "inLen"]:
			if point.has(key) and not _number(point[key]):
				return {"ok": false, "error": "Curve %s must be a finite number" % key}
		for key in ["outLen", "inLen"]:
			if point.has(key) and (point[key] < 0.0 or point[key] > 3.0):
				return {"ok": false, "error": "Curve %s must be between 0 and 3" % key}
	if points[0].x != 0.0 or points[-1].x != 1.0:
		return {"ok": false, "error": "Curve endpoint x values must be 0 and 1"}
	if not config.is_empty():
		points[0].y = config.start_value
		points[-1].y = config.end_value
	var curve = load("res://addons/devcel/runtime/devcel_curve.gd").new()
	curve._points = points
	return {"ok": true, "curve": curve, "error": ""}

static func _number(value) -> bool:
	return (value is float or value is int) and is_finite(float(value))

func points() -> Array:
	return _points.duplicate(true)

func sample(x: float) -> float:
	if _points.is_empty() or is_nan(x):
		return 0.0
	if x <= _points[0].x:
		return float(_points[0].y)
	if x >= _points[-1].x:
		return float(_points[-1].y)
	var i = 0
	# Advance to the next segment upon reaching a control point; do not retain the old value at a constant segment's right endpoint.
	while i < _points.size() - 2 and _points[i + 1].x <= x:
		i += 1
	var a = _points[i]
	var b = _points[i + 1]
	if a.mode == "constant" or x == a.x:
		return float(a.y)
	var span = float(b.x - a.x)
	var outgoing = _handle(i, true)
	var incoming = _handle(i + 1, false)
	var out_length = span / 3.0 * outgoing[1]
	var in_length = span / 3.0 * incoming[1]
	var c1 = [a.x + out_length, a.y + outgoing[0] * out_length]
	var c2 = [b.x - in_length, b.y - incoming[0] * in_length]
	var low = 0.0
	var high = 1.0
	for _iteration in range(40):
		var middle = (low + high) * 0.5
		var sample_x = _bezier(a.x, c1[0], c2[0], b.x, middle)
		if sample_x == x:
			return _bezier(a.y, c1[1], c2[1], b.y, middle)
		if sample_x < x:
			low = middle
		else:
			high = middle
	return _bezier(a.y, c1[1], c2[1], b.y, (low + high) * 0.5)

func _auto_slope(i: int) -> float:
	var left = maxi(0, i - 1)
	var right = mini(_points.size() - 1, i + 1)
	return float(_points[right].y - _points[left].y) / maxf(EPS, _points[right].x - _points[left].x)

func _handle(i: int, outgoing: bool) -> Array:
	var point = _points[i]
	if point.mode == "constant":
		return [0.0, 1.0]
	if point.mode == "linear":
		var other = _points[i + (1 if outgoing else -1)]
		return [float(other.y - point.y) / float(other.x - point.x), 1.0]
	var prefix = "out" if outgoing else "in"
	var slope = float(point.get(prefix + "Slope", _auto_slope(i))) if point.mode == "free" else _auto_slope(i)
	return [slope, float(point.get(prefix + "Len", 1.0))]

static func _bezier(a: float, b: float, c: float, d: float, t: float) -> float:
	var u = 1.0 - t
	return u*u*u*a + 3.0*u*u*t*b + 3.0*u*t*t*c + t*t*t*d

