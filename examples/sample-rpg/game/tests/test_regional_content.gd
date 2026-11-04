extends SceneTree
## Whole-catalog contracts for the authored map, regional work and supply hints.
const Model = preload("res://rpg_model.gd")
var failures: int = 0
var checks: int = 0
var source_stages: Dictionary = {}
var tier_weights: Dictionary = {}
var quality_weights: Dictionary = {}

func reachable_weight(model, material, region_id: String) -> bool:
	for stage in source_stages.get(region_id, []):
		if model.is_settlement_region(region_id) and stage.get_int("min_depth") != 0: continue
		if int(tier_weights.get(stage.id(), {}).get(material.get_int("tier"), 0)) > 0 and int(quality_weights.get(stage.id(), {}).get(material.get_int("quality_index"), 0)) > 0:
			return true
	return false

func check(value: bool, label: String) -> void:
	checks += 1
	if not value:
		failures += 1
		printerr("FAIL: ", label)

func ref(row, field: String) -> String:
	var target = row.get_reference(field)
	return target.id() if target != null else ""

func _initialize() -> void:
	var model = Model.new()
	check(model.load_main().ok, "catalog loads")
	if failures: quit(1); return
	check(model.validate_authoring_data(model.database).ok, "complete authoring validation")
	for id in model.database.table("gather_stages").ids():
		var stage = model.database.by_id("gather_stages", id)
		var region_id: String = stage.get_string("region")
		if not source_stages.has(region_id): source_stages[region_id] = []
		source_stages[region_id].append(stage)
	for spec in [["gather_tier_weights", "tier", tier_weights], ["gather_quality_weights", "quality_index", quality_weights]]:
		for id in model.database.table(spec[0]).ids():
			var weight = model.database.by_id(spec[0], id)
			var stage_id: String = weight.get_string("stage")
			if not spec[2].has(stage_id): spec[2][stage_id] = {}
			spec[2][stage_id][weight.get_int(spec[1])] = weight.get_int("weight")
	var graph: Dictionary = model.progression_policy.region_graph
	var adjacency: Dictionary = {}
	for edge in graph.edges:
		for pair in [[edge[0], edge[1]], [edge[1], edge[0]]]:
			if not adjacency.has(pair[0]): adjacency[pair[0]] = []
			adjacency[pair[0]].append(pair[1])
	check(adjacency.size() == 100 and graph.edges.size() == 124, "approved graph size")
	for region in model.destinations():
		check(ref(region, "quest_neighbor") in adjacency.get(region.id(), []), "adjacent story partner: " + region.id())
		check(not model.planned_route(region.id()).is_empty(), "reachable region: " + region.id())
	var conditions = model.database.table("quest_conditions")
	for id in conditions.ids():
		var condition = conditions.by_id(id)
		var quest = condition.get_reference("quest")
		var source: String = ref(quest, "region_ref")
		var target: String = ref(condition, "target_region")
		if quest.get_int("local_difficulty") == 3 and not target.is_empty():
			check(target == source or target in adjacency.get(source, []), "field-review distance: " + id)
		if condition.get_string("kind") == "kill" and not ref(condition, "target_enemy").is_empty():
			check(target.is_empty() or model.row_region_id(condition.get_reference("target_enemy")) == target, "enemy/region agreement: " + id)
		if condition.get_string("kind") == "gather":
			var material = condition.get_reference("target_material")
			var sources: Array = model.acquisition_regions(material.id())
			var possible: bool = false
			for region in sources:
				if (target.is_empty() or target == region.id()) and reachable_weight(model, material, region.id()): possible = true
			check(possible and material.get_int("mine_yield") > 0, "gather source: " + id)
	var materials = model.database.table("materials")
	for id in materials.ids():
		check(not model.acquisition_regions(id).is_empty(), "material source: " + id)
		for source in model.acquisition_regions(id):
			check(reachable_weight(model, materials.by_id(id), source.id()), "source has an attainable positive-weight stage: " + id + ":" + source.id())
	var recipes = model.database.table("recipes")
	for id in recipes.ids():
		var recipe = recipes.by_id(id)
		check(not ref(recipe, "material").is_empty() and recipe.get_int("material_count") > 0, "recipe input: " + id)
		if not recipe.get_string("quality_group_key").is_empty():
			var quality = recipe.get_reference("default_quality")
			check(quality != null and quality.get_string("quality_group_key") == recipe.get_string("quality_group_key"), "recipe quality: " + id)
	var pairs: Dictionary = {}
	var offers = model.database.table("shop_offers")
	for id in offers.ids():
		var offer = offers.by_id(id)
		var key: String = ref(offer, "shop") + ":" + ref(offer, "material")
		check(not pairs.has(key), "unique shop/material: " + id)
		pairs[key] = true
		check(not ref(offer, "material").is_empty() and not ref(offer, "shop").is_empty(), "offer references: " + id)
		if offer.get_bool("buy_enabled") and offer.get_bool("sell_enabled"):
			check(offer.get_int("buy_price") > offer.get_int("sell_price"), "no buy/sell profit loop: " + id)
	# Test-only visited/discovered state isolates routing from the discovery RNG.
	model.choose_purpose(str(model.progression_policy.grand_objectives[0].id))
	for region in model.destinations():
		model._visited_region_ids[region.id()] = true
		model._discovered_region_ids[region.id()] = true
	var secondary_tested: bool = false
	for id in materials.ids():
		var sources: Array = model.acquisition_regions(id)
		if sources.size() < 2: continue
		var primary: String = ref(materials.by_id(id), "source_region")
		for source in sources:
			if source.id() == primary: continue
			model.region_id = source.id()
			check(model._supply_route_region(id, 1, false) == source.id(), "gather hint uses current secondary source")
			secondary_tested = true
			break
		if secondary_tested: break
	check(secondary_tested, "secondary-source fixture exists")
	model.gold = 100000
	var merchant_tested: bool = false
	for id in offers.ids():
		var offer = offers.by_id(id)
		if not offer.get_bool("buy_enabled"): continue
		var material: String = ref(offer, "material")
		if model.offer_for_material(material, ref(offer, "shop")) == null: continue
		check(model._supply_route_region(material, 1, true).is_empty(), "delivery hint permits known remote merchant")
		check(not model._supply_route_region(material, 1, false).is_empty(), "merchant cannot satisfy gather event")
		merchant_tested = true
		break
	check(merchant_tested, "merchant fixture exists")
	# Towns have a finite gathering pool in current gameplay. They are valid
	# sources even though the automatic gather-and-battle action is field-only.
	var town_tested: bool = false
	for region in model.destinations():
		if not model.is_settlement_region(region.id()): continue
		for material_id in model.progression_policy.region_materials.get(region.id(), []):
			model.region_id = region.id()
			check(model._supply_route_region(str(material_id), 1, false) == region.id(), "town gathering source remains a navigation target")
			town_tested = true
			break
		if town_tested: break
	check(town_tested, "town gathering fixture exists")
	# A newly unlocked prerequisite request must first be accepted at its
	# source, even when that source was visited before the preceding report.
	var followup_id: String = "a3106f58-03c7-56c5-b640-128158c3b74a"
	var prerequisite_id: String = "4023d855-3ea6-5e1b-bcbe-6cd739cb02a8"
	var followup = model.database.by_id("quests", followup_id)
	var source_id: String = ref(followup, "region_ref")
	model.claimed_quests[prerequisite_id] = true
	model.region_id = str(graph.start_region_id)
	check(model.quest_route_target_region_id(followup_id) == source_id, "newly unlocked request routes back for acceptance")
	model.region_id = source_id
	check(model.accept_quest(followup_id), "followup can be accepted at its source")
	check(model.quest_route_target_region_id(followup_id) != source_id, "accepted followup routes onward to its actual objective")
	print("REGIONAL_CONTENT_TESTS checks=%d failures=%d" % [checks, failures])
	quit(1 if failures else 0)
