extends RefCounted
## Canonical regional depth tables; no content IDs or tier names in runtime.

func validate(db) -> String:
	var stages = db.table("gather_stages")
	if stages == null: return "Gathering depth stages are required."
	var ids: Dictionary = {}
	var starts: Dictionary = {}
	var depths: Dictionary = {}
	for i in range(stages.count()):
		var row = stages.at(i)
		var region = row.get_string("region")
		var depth: int = row.get_int("min_depth", -1)
		if db.by_id("regions", region) == null or depth < 0 or not row.last_error.is_empty(): return "Invalid gathering stage region or depth."
		var count: int = row.get_int("draw_count", -1)
		if count < 1 or count > 100 or not row.last_error.is_empty(): return "Gathering draw count must be 1..100."
		var key: String = region + ":" + str(depth)
		if depths.has(key): return "Duplicate regional gathering depth."
		depths[key] = true
		ids[row.id()] = true
		if depth == 0: starts[region] = true
	for table_name in ["gather_tier_weights", "gather_quality_weights"]:
		var weights = db.table(table_name)
		if weights == null: return "Gathering weight tables are required."
		var seen: Dictionary = {}
		for i in range(weights.count()):
			var row = weights.at(i)
			var stage: String = row.get_string("stage")
			var field: String = "tier" if table_name == "gather_tier_weights" else "quality_index"
			var value: int = row.get_int(field, -999)
			if not row.last_error.is_empty() or (field == "tier" and value < 0) or (field == "quality_index" and value < -1): return "Invalid gathering tier or quality."
			var weight: int = row.get_int("weight", -1)
			if weight < 0 or weight > 1000000 or not row.last_error.is_empty() or not ids.has(stage): return "Invalid gathering weight or stage reference."
			var key: String = stage + ":" + str(value)
			if seen.has(key): return "Duplicate gathering weight."
			seen[key] = true
	var jobs = db.table("jobs")
	if jobs != null:
		for index in range(jobs.count()):
			var job = jobs.at(index)
			if job.get_int("gather_quality_min", 3) < -1 or job.get_int("gather_quality_weight_permille", 1000) < 0:
				return "Invalid job gathering quality weight: " + job.id()
	var materials = db.table("materials")
	for i in range(materials.count()):
		var material = materials.at(i)
		if material.get_int("mine_yield", 0) > 0 and not starts.has(material.get_string("source_region")): return "Material source has no entrance gathering stage."
	var sources = db.table("gathering_sources")
	if sources != null:
		for column in ["region", "material"]:
			if column not in sources.columns(): return "Missing gathering source column: " + column
		for index in range(sources.count()):
			var source = sources.at(index)
			var region = source.get_reference("region")
			var material = source.get_reference("material")
			if region == null or material == null: return "Invalid additional gathering source reference."
			if material.get_int("mine_yield", 0) > 0 and not starts.has(region.id()): return "Additional material source has no entrance gathering stage."
	return ""

func stage_for(db, region: String, depth: int):
	var chosen = null
	var stages = db.table("gather_stages")
	if stages == null: return null
	for i in range(stages.count()):
		var row = stages.at(i)
		if row.get_string("region") != region or row.get_int("min_depth") > depth: continue
		if chosen == null or row.get_int("min_depth") > chosen.get_int("min_depth"): chosen = row
	return chosen

func weights_for(db, table_name: String, field: String, stage_id: String) -> Dictionary:
	var result: Dictionary = {}
	var table = db.table(table_name)
	if table == null: return result
	for i in range(table.count()):
		var row = table.at(i)
		if row.get_string("stage") == stage_id: result[row.get_int(field)] = row.get_int("weight")
	return result

func vector(model, depth: int) -> Dictionary:
	var db = model.database
	var stage = stage_for(db, model.region_id, depth)
	var tiers: Dictionary = weights_for(db, "gather_tier_weights", "tier", stage.id()) if stage != null else {}
	var qualities: Dictionary = weights_for(db, "gather_quality_weights", "quality_index", stage.id()) if stage != null else {}
	var entries: Array = []
	for id in model.progression_policy.get("region_materials", {}).get(model.region_id, []):
		var material = db.by_id("materials", id)
		if material == null: continue
		var quantity: int = maxi(0, material.get_int("mine_yield", 0))
		var weight: float = float(tiers.get(material.get_int("tier"), 0)) * float(qualities.get(material.get_int("quality_index"), 0))
		# Job bonuses change eligible quality weights before both sampling and display.
		# Zero-weight depth/region restrictions stay zero.
		var job = model.selected_row("jobs")
		if job != null and material.get_int("quality_index", -1) >= job.get_int("gather_quality_min", 3):
			weight *= float(maxi(0, job.get_int("gather_quality_weight_permille", 1000))) / 1000.0
		if quantity == 0 or not model.content_available("materials", id): weight = 0.0
		entries.append({"id": id, "name": model.row_name(material), "quantity": quantity, "weight": weight, "percent": 0.0})
	var count: int = stage.get_int("draw_count") if stage != null else 0
	set_inclusion_percentages(entries, count)
	return {"entries": entries, "draw_count": count, "name": stage.get_string("name") if stage != null else "Gathering stage unavailable"}

# An exponential race with rates equal to the weights has exactly the same
# ordered sample as successive weighted draws without replacement. Integrate
# rate*t*exp(-rate*t)*P(at most k-1 other arrivals) over log(t).
const INCLUSION_TOLERANCE: float = 0.00000005
const INCLUSION_WORK_LIMIT: int = 12000000
const INCLUSION_POINT_LIMIT: int = 2048

func set_inclusion_percentages(entries: Array, count: int) -> void:
	var weights := PackedFloat64Array()
	var total: float = 0.0
	var min_weight: float = INF
	var max_weight: float = 0.0
	for entry in entries:
		entry.percent = 0.0
		entry.probability_estimated = false
		entry.probability_unavailable = false
		if float(entry.weight) <= 0.0: continue
		min_weight = minf(min_weight, float(entry.weight))
		max_weight = maxf(max_weight, float(entry.weight))
		weights.append(float(entry.weight))
		total += float(entry.weight)
	var draws: int = clampi(count, 0, weights.size())
	if draws == 0: return
	if draws == 1 or draws == weights.size():
		for entry in entries:
			if float(entry.weight) > 0.0: entry.percent = 100.0 if draws == weights.size() else float(entry.weight) * 100.0 / total
		return
	if min_weight == max_weight:
		for entry in entries:
			if float(entry.weight) > 0.0: entry.percent = 100.0 * draws / weights.size()
		return
	# O(points * n^2) work and O(n) memory, never count-vector enumeration.
	# A work cap affects only the optional display, never valid data or draws.
	var point_limit: int = mini(INCLUSION_POINT_LIMIT, INCLUSION_WORK_LIMIT / maxi(1, weights.size() * weights.size()))
	var low: float = log(0.000000000001 / max_weight)
	var high: float = log(32.0 / min_weight)
	var intervals: int = 32
	while (high - low) / intervals > 0.4: intervals *= 2
	var probabilities := PackedFloat64Array()
	var converged: bool = false
	if intervals * 2 + 1 <= point_limit:
		var step: float = (high - low) / intervals
		probabilities.resize(weights.size())
		for point in range(intervals + 1):
			var values: PackedFloat64Array = _inclusion_density(weights, draws, low + point * step)
			var factor: float = 0.5 if point == 0 or point == intervals else 1.0
			for i in range(weights.size()): probabilities[i] += values[i] * step * factor
		while intervals * 2 + 1 <= point_limit:
			var refined: PackedFloat64Array = probabilities.duplicate()
			for i in range(weights.size()): refined[i] *= 0.5
			for point in range(intervals):
				var values: PackedFloat64Array = _inclusion_density(weights, draws, low + (point + 0.5) * step)
				for i in range(weights.size()): refined[i] += values[i] * step * 0.5
			converged = true
			var sum: float = 0.0
			for i in range(weights.size()):
				if absf(refined[i] - probabilities[i]) > INCLUSION_TOLERANCE: converged = false
				sum += refined[i]
			if absf(sum - draws) > INCLUSION_TOLERANCE * weights.size(): converged = false
			probabilities = refined
			intervals *= 2
			step *= 0.5
			if converged: break
	var index: int = 0
	for entry in entries:
		if float(entry.weight) <= 0.0: continue
		entry.probability_estimated = converged
		entry.probability_unavailable = not converged
		entry.percent = clampf(probabilities[index] * 100.0, 0.0, 100.0) if converged else -1.0
		index += 1

func _inclusion_density(weights: PackedFloat64Array, draws: int, log_time: float) -> PackedFloat64Array:
	var n: int = weights.size()
	var time: float = exp(log_time)
	var survival := PackedFloat64Array()
	var distribution := PackedFloat64Array()
	survival.resize(n)
	distribution.resize(n + 1)
	distribution[0] = 1.0
	for i in range(n):
		var q: float = exp(-weights[i] * time)
		survival[i] = q
		for j in range(i + 1, 0, -1): distribution[j] = distribution[j] * q + distribution[j - 1] * (1.0 - q)
		distribution[0] *= q
	var result := PackedFloat64Array()
	result.resize(n)
	for i in range(n):
		var q: float = survival[i]
		var p: float = 1.0 - q
		var cdf: float = 0.0
		var term: float = 0.0
		# Divide out this Bernoulli from the stable end of the polynomial.
		# The recurrence multiplier is <= 1 in either direction.
		if q >= 0.5:
			for j in range(draws):
				term = (distribution[j] - p * term) / q
				cdf += term
		else:
			cdf = 1.0
			for j in range(n - 1, draws - 1, -1):
				term = (distribution[j + 1] - q * term) / p
				cdf -= term
		result[i] = weights[i] * time * q * clampf(cdf, 0.0, 1.0)
	return result

func draw(entries: Array, count: int, rng: RandomNumberGenerator) -> Dictionary:
	var pool: Dictionary = {}
	var remaining: Array = entries.duplicate(true)
	for _draw in range(count):
		var total: float = 0.0
		for entry in remaining: total += float(entry.weight)
		if total <= 0.0: break
		var ticket: float = rng.randf() * total
		for index in range(remaining.size()):
			var entry: Dictionary = remaining[index]
			ticket -= float(entry.weight)
			if float(entry.weight) > 0.0 and ticket < 0.0:
				pool[entry.id] = int(entry.quantity)
				remaining.remove_at(index)
				break
	return pool
