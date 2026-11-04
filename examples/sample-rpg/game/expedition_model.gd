extends "res://game_model.gd"
## A location/activity boundary around the canonical Devcel-backed game model.
## Progression gates are explicit policy data; checkpoints are handled by save_game.gd.
const CanonicalPolicy = preload("res://canonical_policy.gd")
const GatheringRules = preload("res://gathering_rules.gd")
var _canonical_policy_owned: bool = false
var _candidate_prepared_rules = null
var _candidate_policy: Dictionary = {}
# Temporary handoff of derived data from this synchronous candidate validation.
# The RPG subclass consumes it before load_main returns; it is not a persistent cache.
var _candidate_shop_offers: Dictionary = {}
var _loaded_shop_offers: Dictionary = {}
var _candidate_indexes: Dictionary = {}
var _loaded_catalog_indexes: Dictionary = {}
var _grand_offer_rng = RandomNumberGenerator.new()
var _pending_offer_rng_state: int = 0
var _grand_offer_drawn: bool = false

const BASE: String = "base"
const PURPOSE: String = "purpose"
const EXPLORE: String = "explore"
const BATTLE: String = "battle"
const VICTORY: String = "victory"
const RETURN: String = "return"

# Discovery is runtime player progress, not an unlock rule or authored flag.
# Only successful departure records a visit; retained UUIDs survive data reload.
var _discovered_region_ids: Dictionary = {}
var discovery_visit_wins: int = 0
var _discovery_rng = RandomNumberGenerator.new()
var _discovery_notifications: Array = []
var _visited_region_ids: Dictionary = {}
var visited_region_ids: Dictionary:
	get:
		var result: Dictionary = _visited_region_ids.duplicate()
		result.make_read_only()
		return result

var activity: String = PURPOSE
var selected_purpose_id: String = ""
var _progression_policy: Dictionary = {}
var progression_policy: Dictionary:
	get:
		return _progression_policy
	set(config):
		configure_progression(config)
var _policy_checked_generation: int = -1
var _policy_cached_error: String = "Progression is not configured."
var _eligible_quest_progress: Dictionary = {}
var grand_objective_defeated: bool = false
var grand_objective_completed: bool = false
var _pending_grand_victory: bool = false
var region_id: String = ""
var region_key: String = ""
var region_name: String = ""
var expedition_purpose: String = "Explore"
var return_summary: Dictionary = {}
var last_victory: Dictionary = {}
var last_gather: Dictionary = {}
# Finite stock at this exploration stop, keyed by stable material UUID.
var _paid_town_entry_ids: Dictionary = {}
var _gather_remaining: Dictionary = {}
var exploration_depth: int = 0
var gathering_stage_name: String = ""
var gathering_draw_count: int = 0
var _gather_victory_receipt: int = 0
var _gather_turn_created: bool = false
var _gather_probabilities: Array = []
var _gather_rng = RandomNumberGenerator.new()
var _gather_rules = GatheringRules.new()
var last_exchange: Dictionary = {}
var _start_gold: int = 0
var _start_wins: int = 0
var _start_materials: Dictionary = {}
var _start_craftable: Dictionary = {}
var _last_enemy_by_region: Dictionary = {}
var _last_material_by_region: Dictionary = {}

func _init():
	_grand_offer_rng.randomize()
	_gather_rng.randomize()
	_discovery_rng.randomize()
	_progression_policy.make_read_only()

func set_grand_offer_seed(seed_value: int) -> bool:
	# Testing/host setup only. A live game's choices cannot be rerolled.
	if database.is_loaded() or _grand_offer_drawn: return false
	_grand_offer_rng.seed = seed_value
	return true

func _prepare_grand_offers(policy: Dictionary) -> String:
	if not policy.has("grand_candidates"): return ""
	var pool = policy.grand_candidates
	if typeof(pool) != TYPE_ARRAY or pool.size() < 3: return "At least three grand candidates are required."
	var offers: Array = []
	_pending_offer_rng_state = _grand_offer_rng.state
	if _grand_offer_drawn:
		for previous in progression_policy.grand_objectives:
			var found: bool = false
			for candidate in pool:
				if candidate.id == previous.id:
					offers.append(candidate)
					found = true
					break
			if not found: return "An offered grand quest was removed from the candidate pool; start a new game to draw again."
	else:
		# Partial Fisher-Yates: unbiased distinct sampling, with no score gate.
		# Use a local generator so a rejected reload cannot consume the live draw.
		var random = RandomNumberGenerator.new()
		random.state = _grand_offer_rng.state
		var remaining: Array = pool.duplicate()
		for index in range(3):
			var selected: int = random.randi_range(index, remaining.size() - 1)
			var temporary = remaining[index]
			remaining[index] = remaining[selected]
			remaining[selected] = temporary
			offers.append(remaining[index])
		_pending_offer_rng_state = random.state
	policy.grand_objectives = offers
	return ""

func destinations() -> Array:
	var result: Array = []
	var table = database.table("regions")
	if table != null:
		for index in range(table.count()):
			result.append(table.at(index))
	return result

func is_region_visited(id: String) -> bool:
	return database.by_id("regions", id) != null and _visited_region_ids.has(id)

func discovered_region_ids() -> Array:
	# Queries never roll, reveal neighbors, or change persistent player progress.
	var result: Array = []
	for id in _discovered_region_ids:
		if database.by_id("regions", str(id)) != null: result.append(str(id))
	return result

func is_region_discovered(id: String) -> bool:
	return database.by_id("regions", id) != null and _discovered_region_ids.has(id)

func set_discovery_seed(seed_value: int) -> bool:
	if database.is_loaded(): return false
	_discovery_rng.seed = seed_value
	return true

func take_discovery_notifications() -> Array:
	var result: Array = _discovery_notifications.duplicate()
	_discovery_notifications.clear()
	return result

func _adjacent_region_ids(origin_id: String) -> Array:
	var result: Array = []
	# Travel edges are undirected, matching _graph_route and the rendered map.
	for edge in progression_policy.get("region_graph", {}).get("edges", []):
		var neighbor: String = str(edge[1]) if str(edge[0]) == origin_id else (str(edge[0]) if str(edge[1]) == origin_id else "")
		if not neighbor.is_empty() and database.by_id("regions", neighbor) != null and neighbor not in result:
			result.append(neighbor)
	return result

func seed_discovered_regions_from_progress() -> void:
	# Legacy checkpoint migration and accepted data reloads never consume RNG.
	# A merely discovered town is not an anchor: no cascade through hidden towns.
	for id in _discovered_region_ids.keys():
		if database.by_id("regions", str(id)) == null: _discovered_region_ids.erase(id)
	for id in _visited_region_ids.keys():
		if database.by_id("regions", str(id)) == null: _visited_region_ids.erase(id)
	var anchors: Dictionary = _visited_region_ids.duplicate()
	var start: String = str(progression_policy.get("region_graph", {}).get("start_region_id", ""))
	if database.by_id("regions", start) != null: anchors[start] = true
	if database.by_id("regions", region_id) != null: anchors[region_id] = true
	for id in anchors:
		_discovered_region_ids[str(id)] = true
	# Knowing the start/current place is not itself a visit. Only a town
	# actually entered by the player exposes its adjacent destinations.
	for id in _visited_region_ids:
		if not is_settlement_region(str(id)): continue
		for neighbor in _adjacent_region_ids(str(id)):
			_discovered_region_ids[neighbor] = true
	var retained: Array = []
	for id in _discovery_notifications:
		if is_region_discovered(str(id)): retained.append(id)
	_discovery_notifications = retained

func discovery_chance_percent(id: String) -> int:
	var region = database.by_id("regions", id)
	if region == null: return 0
	# Old catalogs without the per-region column retain a 33% compatibility rate.
	return clampi(region.get_int("discovery_chance_percent", 33), 0, 100)

func discovery_min_battles() -> int:
	var settings = database.table("game_settings")
	if settings == null or settings.count() != 1 or "discovery_min_battles" not in settings.columns(): return 3
	return settings.at(0).get_int("discovery_min_battles", 3)

func discovery_ready() -> bool:
	return discovery_visit_wins >= discovery_min_battles()

func _try_discover_adjacent(origin_id: String) -> void:
	if origin_id != region_id or not discovery_ready(): return
	if database.by_id("regions", origin_id) == null or not is_region_visited(origin_id): return
	# Snapshot candidates before rolling: discoveries do not cascade within an event.
	var candidates: Array = []
	for id in _adjacent_region_ids(origin_id):
		if not is_region_discovered(str(id)): candidates.append(id)
	for id in candidates:
		var chance: int = discovery_chance_percent(str(id))
		if chance <= 0: continue
		if _discovery_rng.randi_range(1, 100) > chance: continue
		_discovered_region_ids[str(id)] = true
		_discovery_notifications.append(str(id))
		# Names and content remain masked until the player actually visits.
		log_event("Discovered a nearby region.")

func _validate_discovery_settings(candidate) -> String:
	var settings = candidate.table("game_settings")
	if settings != null and "discovery_min_battles" in settings.columns():
		if settings.count() != 1: return "Exactly one game_settings row is required."
		var row = settings.at(0)
		var count: int = row.get_int("discovery_min_battles", -1)
		if not row.last_error.is_empty() or count < 0 or count > MAX_AMOUNT: return "discovery_min_battles must be a nonnegative bounded integer."
	var table = candidate.table("regions")
	if table == null or "discovery_chance_percent" not in table.columns(): return ""
	for index in range(table.count()):
		var row = table.at(index)
		var chance: int = row.get_int("discovery_chance_percent")
		if not row.last_error.is_empty() or chance < 0 or chance > 100:
			return "Region discovery_chance_percent must be an integer in 0..100: " + row.id()
	return ""

func region_disclosure(id: String) -> Dictionary:
	# This view deliberately contains no enemy/material catalog or hidden name.
	# Grand-objective cards are a separate, explicitly public design contract.
	var discovered: bool = is_region_discovered(id)
	var visited: bool = is_region_visited(id)
	var label: String = ""
	if visited: label = row_name(database.by_id("regions", id))
	elif discovered: label = "Unexplored region"
	return {"id": id, "discovered": discovered, "visited": visited, "name": label}

func regional_enemies(requested_region: String = "") -> Array:
	var key: String = region_key if requested_region.is_empty() else requested_region
	var result: Array = []
	var table = database.table("enemies")
	if table != null:
		for index in range(table.count()):
			var row = table.at(index)
			if row_region(row) == key and content_available("enemies", row.id()) and _encounter_reward_available(row):
				result.append(row)
	return result

func _encounter_reward_available(row) -> bool:
	# Use the same eligibility condition for the public encounter list and the
	# action guard, so exploration never advertises a fight it cannot start.
	var material = row.get_reference("material")
	if material == null: material = core_rows.get("materials")
	return material != null and content_available("materials", material.id())

func regional_materials(requested_region: String = "") -> Array:
	# Gathering geography is an explicit approved policy, never inferred from
	# names, tiers, or the core-ore fallback used by legacy combat rewards.
	var result: Array = []
	var key: String = region_key if requested_region.is_empty() else requested_region
	var region = key_row(database, "regions", key)
	if region == null or not content_available("regions", region.id()): return result
	var ids: Array = progression_policy.get("region_materials", {}).get(region.id(), [])
	for id in ids:
		var material = database.by_id("materials", id)
		if material != null and content_available("materials", id): result.append(material)
	return result

func acquisition_regions(material_id: String) -> Array:
	# Acquisition hints describe the authored geography even before it unlocks.
	# Actual gathering still uses regional_materials and all gameplay gates.
	var result: Array = []
	var mappings: Dictionary = progression_policy.get("region_materials", {})
	for region in destinations():
		if material_id in mappings.get(region.id(), []): result.append(region)
	return result

func depart(destination_key: String, purpose: String = "Explore", confirmed_fee: int = -1) -> bool:
	if activity != BASE: return fail("Return to base before starting another expedition.")
	if not database.is_loaded(): return fail("Load valid game data before departing.")
	if not progression_ready(): return fail("The expedition progression policy is not ready.")
	if hp <= 0: return fail("Rest at base before departing.")
	if not loadout_available(): return fail("Prepare an available job and equipment at base.")
	var region = key_row(database, "regions", destination_key)
	if region == null: return fail("This destination is no longer available in the live data.")
	if not is_region_discovered(region.id()): return fail("Discover a route to this destination before departing.")
	if not content_available("regions", region.id()): return fail("This destination has not been unlocked.")
	if destination_route(region.id()).is_empty(): return fail("There is no unlocked route from base to this destination.")
	if is_settlement_region(region.id()) and region.id() == region_id: return fail("You are already in this town. Leave for another region before returning.")
	var entry_quote: Dictionary = town_entry_quote(region.id())
	if not entry_quote.ok: return fail(str(entry_quote.error))
	if int(entry_quote.fee) > 0 and confirmed_fee != int(entry_quote.fee): return fail("Confirm the current town entry fee before entering.")
	# No fallible validation remains before payment and transition.
	if is_settlement_region(region.id()):
		gold -= int(entry_quote.fee)
		_paid_town_entry_ids[region.id()] = true
	_reset_gathering_expedition()
	region_id = region.id()
	region_key = region.get_string("key")
	region_name = row_name(region)
	expedition_purpose = purpose
	_start_gold = gold
	_start_wins = wins
	_start_materials = _inventory_snapshot()
	_start_craftable = craftable_recipe_ids()
	return_summary = {}
	last_victory = {}
	last_gather = {}
	last_exchange = {}
	_pending_grand_victory = false
	enemy = {}
	_visited_region_ids[region_id] = true
	seed_discovered_regions_from_progress()
	if is_settlement_region():
		activity = BASE
		_begin_gathering_stop()
	else:
		activity = EXPLORE
		_begin_gathering_stop()
	log_event("DEPART  " + region_name)
	return true

func town_entry_quote(destination_id: String) -> Dictionary:
	var quote: Dictionary = {"ok": false, "fee": 0, "already_paid": false, "error": "This destination no longer exists."}
	var region = database.by_id("regions", destination_id)
	if region == null: return quote
	quote.already_paid = _paid_town_entry_ids.has(destination_id)
	var fee: int = 0
	if is_settlement_region(destination_id) and not quote.already_paid and "town_entry_fee" in database.table("regions").columns():
		fee = region.get_int("town_entry_fee", -1)
		if fee < 0 or not region.last_error.is_empty():
			quote.error = "This town has an invalid entry fee."
			return quote
	quote.fee = fee
	quote.ok = gold >= fee
	quote.error = "" if quote.ok else "You need %d gold to enter this town." % fee
	return quote

func ensure_town_gathering_stop() -> bool:
	# Migration/arrival helper only: spent pools remain created and cannot reroll.
	if activity != BASE or not is_settlement_region() or _gather_turn_created: return false
	if not _gather_remaining.is_empty() or not _gather_probabilities.is_empty(): return false
	if _gather_rules.stage_for(database, region_id, exploration_depth) == null: return false
	_begin_gathering_stop()
	return _gather_turn_created

func is_settlement_region(requested_region_id: String = "") -> bool:
	var id: String = region_id if requested_region_id.is_empty() else requested_region_id
	var region = database.by_id("regions", id)
	return region != null and region.get_string("region_kind") == "settlement"

func _current_region_valid() -> bool:
	return progression_ready() and content_available("regions", region_id)

func _next_row(candidates: Array, previous_id: String):
	if candidates.is_empty(): return null
	for index in range(candidates.size()):
		if candidates[index].id() == previous_id:
			return candidates[(index + 1) % candidates.size()]
	return candidates[0]

func set_gather_seed(seed_value: int) -> bool:
	if database.is_loaded(): return false
	_gather_rng.seed = seed_value
	return true

func _reset_gathering_expedition() -> void:
	discovery_visit_wins = 0
	exploration_depth = 0
	gathering_stage_name = ""
	gathering_draw_count = 0
	_gather_victory_receipt = 0
	_gather_turn_created = false
	_gather_remaining = {}
	_gather_probabilities = []

func _begin_gathering_stop(after_victory: bool = false) -> void:
	# Only depart and the one-way VICTORY -> EXPLORE transition call this.
	# Local expedition depth is independent of world/region victory totals.
	var receipt: int = int(wins_by_region.get(region_id, 0))
	if after_victory:
		if activity != VICTORY or receipt <= _gather_victory_receipt: return
		exploration_depth = mini(MAX_AMOUNT - 1, exploration_depth) + 1
	elif (activity != EXPLORE and not (activity == BASE and is_settlement_region())) or _gather_turn_created:
		return
	_gather_victory_receipt = receipt
	_gather_turn_created = true
	var authored: Dictionary = _gather_rules.vector(self, exploration_depth)
	gathering_stage_name = str(authored.name)
	gathering_draw_count = int(authored.draw_count)
	_gather_probabilities = authored.entries.duplicate(true)
	_gather_remaining = _gather_rules.draw(_gather_probabilities, int(authored.draw_count), _gather_rng)

func gathering_probabilities() -> Array:
	# Freeze the actual turn's draw vector, including zeroes. Reload/UI never
	# consumes RNG or silently changes the probability behind an existing pool.
	var result: Array = _gather_probabilities.duplicate(true)
	var shown: Dictionary = {}
	for entry in result:
		shown[str(entry.id)] = true
		var material = database.by_id("materials", str(entry.id))
		if material != null: entry.name = row_name(material)
	# Newly authored sources did not participate in this frozen turn. Show them
	# explicitly at 0%, without changing the pool, RNG, or saved draw vector.
	for id in progression_policy.get("region_materials", {}).get(region_id, []):
		if shown.has(id): continue
		var material = database.by_id("materials", id)
		if material == null: continue
		result.append({"id": id, "name": row_name(material), "quantity": maxi(0, material.get_int("mine_yield", 0)), "weight": 0.0, "percent": 0.0, "probability_estimated": false, "probability_unavailable": false, "available_next_stop": true})
	return result

func gathering_pool() -> Array:
	var result: Array = []
	var legal: Dictionary = {}
	for material in regional_materials(): legal[material.id()] = material
	for material_id in _gather_remaining:
		if legal.has(material_id):
			result.append({"id": material_id, "name": row_name(legal[material_id]), "remaining": maxi(0, int(_gather_remaining[material_id]))})
	return result

func gathering_remaining(material_id: String) -> int:
	return int(_gather_remaining.get(material_id, 0))

func gather_and_advance(material_id: String = "") -> bool:
	if is_settlement_region(): return fail("Gathering and battles are outside settlements.")
	if not material_id.is_empty(): return fail("Gather the current pool; material selection cannot create a gathering spot.")
	if activity != EXPLORE: return fail("Gather only while exploring, outside combat.")
	if hp <= 0 or not loadout_available() or not _current_region_valid() or not enemy.is_empty(): return fail("Prepare a valid expedition before gathering.")
	var next_enemy = _next_row(regional_enemies(), str(_last_enemy_by_region.get(region_id, "")))
	if next_enemy == null: return fail("No lawful encounter is available to continue this gathering turn.")
	var has_material: bool = false
	for item in gathering_pool():
		if int(item.remaining) > 0: has_material = true
	# Gather validates the whole pool before any inventory/stock mutation. The
	# already-admitted encounter remains legal after adding gathered resources.
	if has_material and not gather(): return false
	if not advance(next_enemy.id()): return false
	if not has_material: last_gather = {"id": "", "name": "", "amount": 0, "items": []}
	return true

func gather(material_id: String = "") -> bool:
	if activity != EXPLORE and not (activity == BASE and is_settlement_region()): return fail("Gather only while exploring, outside combat.")
	if hp <= 0: return fail("Return to base to recover.")
	if not loadout_available(): return fail("Your loadout changed. Return to base to prepare.")
	if not _current_region_valid(): return fail("This region changed. Return to base and choose a destination.")
	if not material_id.is_empty() and not _gather_remaining.has(material_id): return fail("That material is not in the current gathering pool.")
	var legal: Dictionary = {}
	for material in regional_materials(): legal[material.id()] = material
	var collected: Array = []
	for id in _gather_remaining:
		var amount: int = int(_gather_remaining[id])
		if amount <= 0: continue
		if not legal.has(id): return fail("This gathering pool no longer meets the authored access requirements.")
		var material = legal[id]
		if inventory_count(material) > MAX_AMOUNT - amount: return fail("The whole gathering pool will not fit. Nothing was collected.")
		collected.append({"id": id, "name": row_name(material), "amount": amount})
	if collected.is_empty(): return fail("This gathering pool is empty. Continue or return to base.")
	var total: int = 0
	for item in collected:
		_add_material(legal[item.id], int(item.amount))
		_gather_remaining[item.id] = 0
		total = mini(MAX_AMOUNT - int(item.amount), total) + int(item.amount)
	actions += 1
	log_event("GATHER  +%d units from the current pool" % total)
	_last_material_by_region[region_id] = str(collected.back().id)
	last_gather = {"id": str(collected[0].id), "name": str(collected[0].name) if collected.size() == 1 else "Materials", "amount": total, "items": collected}
	_try_discover_adjacent(region_id)
	return true

func advance(enemy_id: String = "") -> bool:
	if is_settlement_region(): return fail("Battles are outside settlements.")
	if activity != EXPLORE: return fail("Continue exploring before looking for another encounter.")
	if hp <= 0: return fail("Return to base to recover.")
	if not loadout_available(): return fail("Your loadout changed. Return to base to prepare.")
	if not _current_region_valid(): return fail("This region changed. Return to base and choose a destination.")
	# A contextual boss/trial action may request an exact UUID, but it has the
	# same regional/policy/reward guards as ordinary exploration. Empty keeps
	# rotation through the complete eligible catalog, remembering UUIDs.
	var candidates: Array = regional_enemies()
	var row = null
	if enemy_id.is_empty():
		row = _next_row(candidates, str(_last_enemy_by_region.get(region_id, "")))
	else:
		for candidate in candidates:
			if candidate.id() == enemy_id:
				row = candidate
				break
		if row == null: return fail("This encounter is not available in your current region.")
	if row == null: return fail("No encounters are defined for this region. You can return to base.")
	if not _encounter_reward_available(row): return fail("This encounter's reward is not available under the progression policy.")
	rows.enemies = row
	selected_ids.enemies = row.id()
	if not super.encounter(): return false
	_last_enemy_by_region[region_id] = row.id()
	last_exchange = {}
	activity = BATTLE
	return true

func encounter() -> bool:
	# Older callers cannot bypass destination selection with a global enemy row.
	return advance()

func attack() -> bool:
	if activity != BATTLE: return fail("There is no active battle.")
	if not loadout_available(): return fail("Your loadout changed. Retreat to base to prepare.")
	var before: Dictionary = enemy.duplicate(true)
	var old_hp: int = hp
	var old_gold: int = gold
	var eligible_quests: Array = []
	var quest_table = database.table("quests")
	# The RPG condition index owns progress for canonical multi-condition quests.
	if quest_table != null and database.table("quest_conditions") == null:
		for index in range(quest_table.count()):
			var quest = quest_table.at(index)
			if content_available("quests", quest.id()): eligible_quests.append(quest)
	if not super.attack(): return false
	last_exchange = {"damage": last_damage, "received": old_hp - hp, "enemy_name": str(before.get("name", "Enemy"))}
	if enemy.is_empty():
		# Only quests eligible before this victory gain progress. Global victory
		# counters cannot retroactively complete a quest that was still locked.
		for quest in eligible_quests:
			var quest_area: String = quest_region_id(quest)
			if quest_area.is_empty() or quest_area == str(before.get("region_id", "")):
				_eligible_quest_progress[quest.id()] = int(_eligible_quest_progress.get(quest.id(), 0)) + 1
		last_victory = {"enemy_id": before.id, "enemy_name": before.name, "gold": before.bounty, "material_id": before.loot_id, "material_name": before.loot_name, "amount": before.loot_amount}
		var objective: Dictionary = selected_objective()
		if not grand_objective_completed and not objective.is_empty() and str(before.id) == str(objective.enemy_id) and (not str(objective.get("quest_id", "")).is_empty() or region_id == str(objective.region_id)):
			_pending_grand_victory = true
			grand_objective_defeated = true
		activity = VICTORY
		# Check the previous completed count: victory three itself cannot roll.
		_try_discover_adjacent(str(before.get("region_id", region_id)))
		discovery_visit_wins = mini(MAX_AMOUNT - 1, discovery_visit_wins) + 1
	elif hp <= 0:
		_finish_expedition("defeat")
		return_summary["gold_lost"] = old_gold
	return true

func continue_exploration() -> bool:
	if activity != VICTORY: return fail("Finish the battle before continuing.")
	if not _current_region_valid(): return fail("This region changed. Return to base and choose a destination.")
	_begin_gathering_stop(true)
	activity = EXPLORE
	return true

func return_to_base() -> bool:
	if activity not in [EXPLORE, VICTORY]: return fail("Leave the current battle with Retreat, or finish the return summary.")
	_finish_expedition("returned")
	return true

func retreat() -> bool:
	if activity != BATTLE: return fail("Retreat is only available during battle.")
	_finish_expedition("retreated")
	return true

func _finish_expedition(reason: String):
	_reset_gathering_expedition()
	# Rewards were granted by gather/attack once. This is a frozen report, not
	# a second payment or a free heal. A second click cannot enter this method.
	enemy = {}
	activity = RETURN
	var gains: Array = []
	var current: Dictionary = _inventory_snapshot()
	for id in current:
		var amount: int = int(current[id]) - int(_start_materials.get(id, 0))
		if amount > 0:
			var material = database.by_id("materials", id)
			gains.append({"id": id, "name": row_name(material) if material != null else id, "amount": amount})
	var newly_craftable: Array = []
	for id in craftable_recipe_ids():
		if not _start_craftable.has(id): newly_craftable.append(id)
	return_summary = {"reason": reason, "region_id": region_id, "region_key": region_key, "region_name": region_name, "purpose": expedition_purpose, "gold": gold - _start_gold, "wins": wins - _start_wins, "materials": gains, "ready_quest_ids": ready_quest_ids(), "newly_craftable_ids": newly_craftable}
	# Preserve a lawful target victory even if the player is defeated later.
	# Reporting is an explicit close_return action, never an automatic reward.
	return_summary["grand_objective_ready_to_report"] = grand_objective_ready_to_report()
	return_summary["grand_objective_reported"] = false
	return_summary["grand_objective_id"] = selected_purpose_id
	log_event("RETURN  %s: %s" % [region_name, reason])

func _grand_quest_conditions_ready(_quest_id: String) -> bool:
	# The RPG layer implements linked multi-condition quests. Fail closed here.
	return false

func _report_selected_grand_quest() -> bool:
	# Enemy-only legacy goals have no separate quest reward to pay.
	return str(selected_objective().get("quest_id", "")).is_empty()

func grand_objective_ready_to_report() -> bool:
	if grand_objective_completed: return false
	var objective: Dictionary = selected_objective()
	if objective.is_empty(): return false
	var quest_id: String = str(objective.get("quest_id", ""))
	if not quest_id.is_empty(): return _grand_quest_conditions_ready(quest_id)
	return _pending_grand_victory

func close_return() -> bool:
	if activity != RETURN: return fail("There is no return summary to close.")
	if grand_objective_ready_to_report():
		if not _report_selected_grand_quest(): return false
		grand_objective_completed = true
		return_summary["grand_objective_reported"] = true
	_pending_grand_victory = false
	activity = BASE
	return true

func _inventory_snapshot() -> Dictionary:
	var result: Dictionary = material_inventory.duplicate()
	if core_rows.has("materials"): result[core_rows.materials.id()] = ore
	return result

func craftable_recipe_ids() -> Dictionary:
	var result: Dictionary = {}
	var table = database.table("recipes")
	if table == null: return result
	for index in range(table.count()):
		var recipe = table.at(index)
		var material = recipe.get_reference("material")
		var equipment = recipe.get_reference("equipment")
		if recipe_available(recipe.id()) and material != null and equipment != null and not owns_equipment(equipment) and inventory_count(material) >= maxi(1, recipe.get_int("material_count", 3)) and gold >= maxi(0, recipe.get_int("cost", 4)):
			result[recipe.id()] = true
	return result

func ready_quest_ids() -> Array:
	var result: Array = []
	var table = database.table("quests")
	if table != null:
		for index in range(table.count()):
			var quest = table.at(index)
			if content_available("quests", quest.id()) and not quest_claimed(quest) and quest_progress(quest) >= quest_target(quest): result.append(quest.id())
	return result

func select_row(table_name: String, record_id: String) -> bool:
	if table_name == "enemies": return fail("Encounters are chosen by exploring your destination.")
	if table_name != "quests" and activity != BASE: return fail("Prepare equipment and use facilities at base.")
	if table_name != "shops" and not content_available(table_name, record_id): return fail("This choice has not been unlocked.")
	if table_name == "recipes" and not recipe_available(record_id): return fail("This recipe's equipment or material has not been unlocked.")
	if table_name == "jobs" and hp > 0 and record_id != str(selected_ids.get("jobs", "")):
		var candidate = database.by_id("jobs", record_id)
		var damage_taken: int = maxi(0, max_hp() - hp)
		var candidate_max_hp: int = maxi(1, candidate.get_int("hp", value("balance", "hp", 80)))
		if candidate_max_hp <= damage_taken:
			return fail("Rest before changing to this job; its maximum HP cannot cover your current wounds.")
	return super.select_row(table_name, record_id)

func loadout_available() -> bool:
	# Recheck at each combat/gather/recovery boundary, not just when a selector
	# was clicked. Live-data and policy updates may invalidate a selected row.
	return content_available("jobs", str(selected_ids.get("jobs", ""))) and (equipped_id.is_empty() or content_available("equipment", equipped_id))

func _revalidate_equipment():
	if not equipped_id.is_empty() and not content_available("equipment", equipped_id):
		equipped_id = ""
		_sync_equipment_flags()
		log_event("GEAR  Equipment became unavailable; item retained and slot cleared.")

func mine() -> bool:
	return fail("Gather materials while exploring a destination.")

func can_craft() -> bool:
	return activity == BASE and recipe_available(str(selected_ids.get("recipes", ""))) and super.can_craft()

func craft() -> bool:
	if activity != BASE: return fail("Return to the base forge to craft equipment.")
	if not recipe_available(str(selected_ids.get("recipes", ""))): return fail("This recipe has not been unlocked.")
	return super.craft()

func equip() -> bool:
	if activity != BASE: return fail("Change equipment at base before departing.")
	if not content_available("equipment", str(selected_ids.get("equipment", ""))): return fail("This equipment has not been unlocked.")
	return super.equip()

func can_buy() -> bool:
	return activity == BASE and content_available("materials", str(selected_ids.get("materials", ""))) and super.can_buy()

func can_sell() -> bool:
	return activity == BASE and content_available("materials", str(selected_ids.get("materials", ""))) and super.can_sell()

func buy() -> bool:
	if activity != BASE: return fail("The shop is at base.")
	if not content_available("materials", str(selected_ids.get("materials", ""))): return fail("This material has not been unlocked.")
	return super.buy()

func sell() -> bool:
	if activity != BASE: return fail("The shop is at base.")
	if not content_available("materials", str(selected_ids.get("materials", ""))): return fail("This material has not been unlocked.")
	return super.sell()

func rest() -> bool:
	if activity != BASE: return fail("Return to base before resting.")
	if not loadout_available(): return fail("Select an available job before resting.")
	if hp == max_hp(): return fail("You are already fully rested.")
	return super.rest()

func can_claim_quest() -> bool:
	return activity in [BASE, RETURN] and content_available("quests", str(selected_ids.get("quests", ""))) and super.can_claim_quest()

func claim_quest() -> bool:
	if activity not in [BASE, RETURN]: return fail("Receive quest rewards after returning to base.")
	if not content_available("quests", str(selected_ids.get("quests", ""))): return fail("This quest has not been unlocked.")
	return super.claim_quest()

# Explicit authoring check. Never called by load_main or live reload.
func validate_authoring_data(candidate) -> Dictionary:
	var discovery_error: String = _validate_discovery_settings(candidate)
	if not discovery_error.is_empty(): return {"ok": false, "error": discovery_error}
	var gathering_error: String = GatheringRules.new().validate(candidate)
	if not gathering_error.is_empty(): return {"ok": false, "error": gathering_error}
	var built: Dictionary = CanonicalPolicy.new().validate_authoring(candidate)
	if not built.ok or not built.present: return built
	# Grand-offer selection uses a disposable model, never the live RNG/state.
	var inspector = get_script().new()
	var draw_error: String = inspector._prepare_grand_offers(built.policy)
	if not draw_error.is_empty(): return {"ok": false, "error": draw_error}
	var problem: String = inspector._validate_policy(built.policy, candidate, built.prepared_rules)
	return {"ok": problem.is_empty(), "error": problem}

func _validate_candidate(candidate) -> Dictionary:
	_candidate_policy = {}
	_candidate_prepared_rules = null
	_candidate_indexes = {}
	_candidate_shop_offers = {}
	# Shop preparation is independent; publish only after both builders finish.
	var output: Array = [null]
	var task: int = -1
	if OS.has_feature("nothreads"):
		_compile_candidate_shop(candidate, output)
	else:
		task = WorkerThreadPool.add_task(_compile_candidate_shop.bind(candidate, output), false, "Compile shop index")
	var built: Dictionary = CanonicalPolicy.new().build(candidate)
	if task >= 0: WorkerThreadPool.wait_for_task_completion(task)
	if not output[0] is Dictionary:
		return {"ok": false, "error": "Shop index worker did not complete."}
	if database.table("quest_conditions") != null and candidate.table("quest_conditions") == null:
		return {"ok": false, "error": "Canonical quest condition tables cannot be removed during play."}
	if not built.ok: return built
	_candidate_shop_offers = output[0]
	if not built.present:
		if _canonical_policy_owned: return {"ok": false, "error": "Canonical progression tables cannot be removed."}
		return {"ok": true, "error": ""}
	var draw_error: String = _prepare_grand_offers(built.policy)
	if not draw_error.is_empty(): return {"ok": false, "error": draw_error}
	if not selected_purpose_id.is_empty():
		var previous: Dictionary = selected_objective()
		var retained: bool = false
		for objective in built.policy.grand_objectives:
			if objective.id != selected_purpose_id: continue
			var quest_id: String = str(objective.get("quest_id", ""))
			if not quest_id.is_empty():
				retained = quest_id == str(previous.get("quest_id", ""))
			else:
				retained = objective.enemy_id == previous.get("enemy_id") and objective.region_id == previous.get("region_id") and str(previous.get("quest_id", "")).is_empty()
		if not retained: return {"ok": false, "error": "The selected grand objective and target must be retained during play."}
	_candidate_prepared_rules = built.prepared_rules
	_candidate_policy = built.policy
	_candidate_indexes = built.get("indexes", {})
	return {"ok": true, "error": ""}

func load_main(path: String = "") -> Dictionary:
	_candidate_policy = {}
	_candidate_prepared_rules = null
	_candidate_indexes = {}
	_loaded_catalog_indexes = {}
	_candidate_shop_offers = {}
	_loaded_shop_offers = {}
	var result: Dictionary = super.load_main(path)
	if not result.ok or not result.changed:
		# Validation may have built a candidate that the semantic-change check did not adopt.
		_candidate_policy = {}
		_candidate_prepared_rules = null
		_candidate_indexes = {}
		_candidate_shop_offers = {}
		return result
	_policy_checked_generation = -1
	_loaded_shop_offers = _candidate_shop_offers
	_candidate_shop_offers = {}
	if not _candidate_policy.is_empty():
		_loaded_catalog_indexes = _candidate_indexes
		_candidate_indexes = {}
		_progression_policy = _candidate_policy
		_freeze_policy(_progression_policy, _candidate_prepared_rules)
		_policy_cached_error = ""
		_policy_checked_generation = generation
		_canonical_policy_owned = true
		if _candidate_policy.has("grand_candidates"):
			_grand_offer_drawn = true
			_grand_offer_rng.state = _pending_offer_rng_state
		_candidate_policy = {}
	_candidate_prepared_rules = null
	seed_discovered_regions_from_progress()
	_revalidate_equipment()
	if activity in [EXPLORE, BATTLE, VICTORY]:
		var region = database.by_id("regions", region_id)
		if region != null:
			region_key = region.get_string("key")
			region_name = row_name(region)
		elif activity != BATTLE:
			_finish_expedition("region_removed")
		# An active enemy remains its encounter-start snapshot, even if its
		# region disappears. Finish/retreat, then return; do not erase the fight.
		if hp <= 0 and activity != RETURN:
			_finish_expedition("recovery_needed")
	ensure_town_gathering_stop()
	return result

func quest_progress(row = null) -> int:
	if row == null: row = rows.get("quests")
	return int(_eligible_quest_progress.get(row.id(), 0)) if row != null else 0

func recipe_available(recipe_id: String) -> bool:
	if not content_available("recipes", recipe_id): return false
	var recipe = database.by_id("recipes", recipe_id)
	var material = recipe.get_reference("material")
	var equipment = recipe.get_reference("equipment")
	return material != null and equipment != null and content_available("materials", material.id()) and content_available("equipment", equipment.id())

func selected_objective() -> Dictionary:
	for objective in progression_policy.get("grand_objectives", []):
		if str(objective.id) == selected_purpose_id: return objective.duplicate(true)
	return {}

func progression_ready() -> bool:
	return not progression_policy.is_empty() and not selected_objective().is_empty() and _policy_validation_error().is_empty()

func _policy_validation_error() -> String:
	# The complete structural/reference scan runs once per accepted immutable
	# policy and canonical data generation, not once per action or map node.
	# Dynamic win/item/quest conditions remain checked by content_available.
	if _policy_checked_generation != generation:
		_policy_cached_error = _validate_policy(_progression_policy)
		_policy_checked_generation = generation
	return _policy_cached_error

func choose_purpose(objective_id: String) -> bool:
	if activity != PURPOSE: return fail("A grand quest is chosen at the start of a new game.")
	if progression_policy.is_empty() or not _policy_validation_error().is_empty(): return fail("Grand quests and progression are not configured yet.")
	for objective in progression_policy.grand_objectives:
		if str(objective.id) == objective_id:
			selected_purpose_id = objective_id
			expedition_purpose = str(objective.name)
			activity = BASE
			return true
	return fail("Choose one of the three configured grand quests.")

func configure_progression(config: Dictionary) -> bool:
	# Configuration is supplied by approved game design, never inferred from
	# record names or numeric tiers. Invalid replacements leave accepted policy
	# and all play state untouched. This API is not exposed as a player action.
	if _canonical_policy_owned: return fail("Progression is authored in the canonical Devcel tables.")
	if activity not in [PURPOSE, BASE]: return fail("Progression policy can only be configured before departure.")
	var problem: String = _validate_policy(config)
	if not problem.is_empty(): return fail(problem)
	if not selected_purpose_id.is_empty():
		var retained: bool = false
		for objective in config.grand_objectives:
			if str(objective.id) == selected_purpose_id: retained = true
		if not retained: return fail("The selected grand quest must remain in the policy.")
	_progression_policy = config.duplicate(true)
	_freeze_policy(_progression_policy)
	_policy_cached_error = ""
	_policy_checked_generation = generation
	seed_discovered_regions_from_progress()
	_revalidate_equipment()
	return true

func _freeze_policy(value_to_freeze, prepared = null):
	if prepared is CanonicalPolicy.PreparedRules and prepared.matches(database, value_to_freeze): return
	# Dictionary.make_read_only is shallow. Freeze every nested container so
	# callers cannot mutate a rule/edge behind the validated-generation cache.
	if typeof(value_to_freeze) == TYPE_DICTIONARY:
		for child in value_to_freeze.values(): _freeze_policy(child, prepared)
		value_to_freeze.make_read_only()
	elif typeof(value_to_freeze) == TYPE_ARRAY:
		for child in value_to_freeze: _freeze_policy(child, prepared)
		value_to_freeze.make_read_only()

func content_available(table_name: String, record_id: String) -> bool:
	if progression_policy.is_empty() or record_id.is_empty() or database.by_id(table_name, record_id) == null: return false
	var rules: Dictionary = progression_policy.get("rules", {})
	var table_rules: Dictionary = rules.get(table_name, {})
	if not table_rules.has(record_id): return false
	var rule: Dictionary = table_rules[record_id]
	if wins < int(rule.get("min_wins", 0)): return false
	for key in rule.get("region_wins", {}):
		if int(wins_by_region.get(key, 0)) < int(rule.region_wins[key]): return false
	for id in rule.get("owned_equipment", []):
		if not owned_equipment.has(id): return false
	for id in rule.get("claimed_quests", []):
		if not claimed_quests.has(id): return false
	return true

func destination_route(destination_id: String) -> Array:
	if not progression_ready() or not is_region_discovered(destination_id) or not content_available("regions", destination_id): return []
	return _graph_route(progression_policy, destination_id, true)

func planned_route(destination_id: String) -> Array:
	if progression_policy.is_empty(): return []
	return _graph_route(progression_policy, destination_id, false)

func reachable_region_ids() -> Array:
	var result: Array = []
	for region in destinations():
		if not destination_route(region.id()).is_empty(): result.append(region.id())
	return result

func _graph_route(config: Dictionary, destination_id: String, apply_gates: bool) -> Array:
	var graph: Dictionary = config.get("region_graph", {})
	var start: String = str(graph.get("start_region_id", ""))
	if start.is_empty() or (apply_gates and (not content_available("regions", start) or not is_region_discovered(start))): return []
	var connections: Dictionary = {}
	for edge in graph.get("edges", []):
		if not connections.has(edge[0]): connections[edge[0]] = []
		if not connections.has(edge[1]): connections[edge[1]] = []
		connections[edge[0]].append(edge[1])
		connections[edge[1]].append(edge[0])
	var pending: Array = [[start]]
	var visited: Dictionary = {start: true}
	while not pending.is_empty():
		var path: Array = pending.pop_front()
		var current: String = str(path[-1])
		if current == destination_id: return path
		for neighbor in connections.get(current, []):
			if visited.has(neighbor) or (apply_gates and (not content_available("regions", neighbor) or not is_region_discovered(str(neighbor)))): continue
			visited[neighbor] = true
			var next: Array = path.duplicate()
			next.append(neighbor)
			pending.append(next)
	return []

func _valid_count(value_to_check) -> bool:
	if typeof(value_to_check) == TYPE_INT: return value_to_check >= 0
	# Godot's JSON parser represents JSON numbers as floats. Accept integral
	# counts only within the exact integer range, before any int conversion.
	if typeof(value_to_check) == TYPE_FLOAT:
		return is_finite(value_to_check) and value_to_check >= 0.0 and value_to_check <= 9007199254740991.0 and floor(value_to_check) == value_to_check
	return false

func _validate_policy(config: Dictionary, candidate_database = null, prepared = null) -> String:
	var policy_database = database if candidate_database == null else candidate_database
	if not policy_database.is_loaded(): return "Load valid data before configuring progression."
	var identities: Dictionary = {}
	for table_name in policy_database.tables():
		var ids: Dictionary = {}
		for id in policy_database.table(table_name).ids(): ids[id] = true
		identities[table_name] = ids
	for key in config:
		if key not in ["grand_objectives", "grand_candidates", "rules", "region_materials", "region_graph"]: return "Unknown progression setting: " + str(key)
	if typeof(config.get("grand_objectives")) != TYPE_ARRAY or config.grand_objectives.size() != 3: return "Exactly three grand objectives must be configured."
	if typeof(config.get("rules")) != TYPE_DICTIONARY: return "Explicit content rules are required."
	if typeof(config.get("region_graph")) != TYPE_DICTIONARY: return "An explicit region graph is required."
	var graph: Dictionary = config.region_graph
	if typeof(graph.get("start_region_id")) != TYPE_STRING or not identities.get("regions", {}).has(graph.start_region_id): return "A valid starting region is required."
	if typeof(graph.get("nodes")) != TYPE_ARRAY or typeof(graph.get("edges")) != TYPE_ARRAY: return "Region graph requires node and edge arrays."
	if typeof(config.get("region_materials", {})) != TYPE_DICTIONARY: return "Region materials must be explicit UUID lists."
	var definitions: Array = config.grand_objectives
	if config.has("grand_candidates"):
		if typeof(config.grand_candidates) != TYPE_ARRAY or config.grand_candidates.size() < 3: return "At least three grand candidates are required."
		definitions = config.grand_candidates
		var offered_ids: Dictionary = {}
		for offer in config.grand_objectives:
			if typeof(offer) != TYPE_DICTIONARY or not offer.has("id") or offered_ids.has(offer.id): return "Grand offers must be three distinct candidates."
			offered_ids[offer.id] = true
			if offer not in definitions: return "Grand offer is outside the candidate pool."
	var objective_ids: Dictionary = {}
	var legacy_enemy_ids: Dictionary = {}
	for objective in definitions:
		if typeof(objective) != TYPE_DICTIONARY: return "Invalid grand objective."
		for key in ["id", "name", "region_id"]:
			if typeof(objective.get(key)) != TYPE_STRING or str(objective[key]).is_empty(): return "Grand objectives require id, name and region_id strings."
		if typeof(objective.get("quest_id", "")) != TYPE_STRING or typeof(objective.get("enemy_id", "")) != TYPE_STRING: return "Grand quest and enemy bindings must be UUID strings."
		var quest_id: String = str(objective.get("quest_id", ""))
		var enemy_id: String = str(objective.get("enemy_id", ""))
		if not quest_id.is_empty() and not identities.get("quests", {}).has(quest_id): return "Grand objective refers to a missing quest."
		if objective_ids.has(objective.id): return "Grand objectives require distinct IDs."
		objective_ids[objective.id] = true
		var region = policy_database.by_id("regions", objective.region_id)
		if region == null: return "Grand objective region is missing."
		var target = policy_database.by_id("enemies", enemy_id)
		if not enemy_id.is_empty() and target == null: return "Grand objective enemy is missing."
		if quest_id.is_empty():
			if target == null or row_region_id(target) != region.id(): return "An enemy-only grand objective requires a target in its configured region."
			if legacy_enemy_ids.has(enemy_id): return "Enemy-only grand objectives require distinct enemies."
			legacy_enemy_ids[enemy_id] = true
	if not (prepared is CanonicalPolicy.PreparedRules and prepared.matches(policy_database, config.rules)):
		for table_name in config.rules:
			if table_name not in ["regions", "materials", "equipment", "recipes", "enemies", "jobs", "quests"] or typeof(config.rules[table_name]) != TYPE_DICTIONARY: return "Unknown or malformed content-rule table."
			for id in config.rules[table_name]:
				if typeof(id) != TYPE_STRING or not identities.get(table_name, {}).has(id): return "Content rule refers to a missing UUID."
				var rule = config.rules[table_name][id]
				if typeof(rule) != TYPE_DICTIONARY: return "A content rule must be a dictionary."
				for key in rule:
					if key not in ["min_wins", "region_wins", "owned_equipment", "claimed_quests"]: return "Unknown rule condition."
				if not _valid_count(rule.get("min_wins", 0)): return "Minimum wins must be a nonnegative integer."
				if typeof(rule.get("region_wins", {})) != TYPE_DICTIONARY: return "Region wins must be a dictionary."
				for key in rule.get("region_wins", {}):
					if typeof(key) != TYPE_STRING or not identities.get("regions", {}).has(key) or not _valid_count(rule.region_wins[key]): return "Invalid region-win condition."
				for field in ["owned_equipment", "claimed_quests"]:
					if typeof(rule.get(field, [])) != TYPE_ARRAY: return "Prerequisites must be UUID arrays."
					var reference_table: String = "equipment" if field == "owned_equipment" else "quests"
					for reference in rule.get(field, []):
						if typeof(reference) != TYPE_STRING or not identities.get(reference_table, {}).has(reference): return "Prerequisite refers to a missing UUID."
	for id in config.get("region_materials", {}):
		if typeof(id) != TYPE_STRING or not identities.get("regions", {}).has(id) or typeof(config.region_materials[id]) != TYPE_ARRAY: return "Invalid gathering region."
		var seen: Dictionary = {}
		for material_id in config.region_materials[id]:
			if typeof(material_id) != TYPE_STRING or not identities.get("materials", {}).has(material_id) or seen.has(material_id): return "Invalid or duplicate gathering material."
			seen[material_id] = true
	var node_ids: Dictionary = {}
	for node in graph.nodes:
		if typeof(node) != TYPE_DICTIONARY or typeof(node.get("id")) != TYPE_STRING or not identities.get("regions", {}).has(node.id) or node_ids.has(node.id): return "Invalid or duplicate region graph node."
		if typeof(node.get("position")) != TYPE_ARRAY or node.position.size() != 2: return "A graph node requires two coordinates."
		for coordinate in node.position:
			if typeof(coordinate) not in [TYPE_INT, TYPE_FLOAT] or not is_finite(float(coordinate)): return "Invalid graph coordinate."
		node_ids[node.id] = true
	if not node_ids.has(graph.start_region_id): return "Starting region must be a graph node."
	for edge in graph.edges:
		if typeof(edge) != TYPE_ARRAY or edge.size() != 2: return "An undirected graph edge requires two region UUIDs."
		if typeof(edge[0]) != TYPE_STRING or typeof(edge[1]) != TYPE_STRING or not node_ids.has(edge[0]) or not node_ids.has(edge[1]) or edge[0] == edge[1]: return "Graph edge references invalid nodes."
	for objective in config.grand_objectives:
		if not node_ids.has(objective.region_id): return "Grand objective region must be a graph node."
	# All authored regions are playable. Validate the complete undirected graph,
	# independent of unlock conditions; loops and arbitrary branching are valid.
	var adjacency: Dictionary = {}
	for id in node_ids: adjacency[id] = []
	for edge in graph.edges:
		adjacency[edge[0]].append(edge[1])
		adjacency[edge[1]].append(edge[0])
	var connected: Dictionary = {graph.start_region_id: true}
	var pending: Array = [graph.start_region_id]
	var cursor: int = 0
	while cursor < pending.size():
		var current: String = pending[cursor]
		cursor += 1
		for neighbor in adjacency[current]:
			if not connected.has(neighbor):
				connected[neighbor] = true
				pending.append(neighbor)
	if connected.size() != node_ids.size(): return "Every region needs a connected route from the starting region."
	return ""

func grand_route_target_region_id() -> String:
	# Legacy enemy-only objectives have one authored destination. This is a
	# navigation hint, not an access rule, discovery event, or automatic visit.
	if grand_objective_completed: return ""
	return str(selected_objective().get("region_id", ""))

func _compile_candidate_shop(candidate, output: Array):
	output[0] = _build_shop_offers(candidate)

func _build_shop_offers(candidate) -> Dictionary:
	var _shop_offers: Dictionary = {}
	var table = candidate.table("shop_offers")
	if table == null: return _shop_offers
	var shop_column: Dictionary = table.column_info("shop")
	var material_column: Dictionary = table.column_info("material")
	if shop_column.get("data_type") != "Reference" or material_column.get("data_type") != "Reference": return _shop_offers
	var shops = candidate.table_by_uuid(shop_column.get("reference_config", {}).get("target_table_uuid", ""))
	var materials = candidate.table_by_uuid(material_column.get("reference_config", {}).get("target_table_uuid", ""))
	if shops == null or materials == null: return _shop_offers
	var shop_ids: Dictionary = {}
	var material_ids: Dictionary = {}
	for id in shops.ids(): shop_ids[id] = true
	for id in materials.ids(): material_ids[id] = true
	for index in range(table.count()):
		var offer = table.at(index)
		var shop_id: String = offer.get_raw("shop")
		var material_id: String = offer.get_raw("material")
		if not shop_ids.has(shop_id) or not material_ids.has(material_id): continue
		if not _shop_offers.has(shop_id): _shop_offers[shop_id] = {}
		# Duplicate stock definitions are ambiguous regardless of row order.
		if _shop_offers[shop_id].has(material_id):
			_shop_offers[shop_id][material_id] = ""
		else:
			_shop_offers[shop_id][material_id] = offer.id()
	return _shop_offers
