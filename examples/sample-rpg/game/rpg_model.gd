extends "res://expedition_model.gd"
## RPG progression with stable instance identities. Definitions come from canonical Devcel rows;
## quality belongs to a crafted instance, not a duplicate equipment definition.
var equipment_instances: Dictionary = {}
var selected_instance_id: String = ""
var equipped_instance_id: String = ""
var selected_quality_id: String = ""
var job_mastery: Dictionary = {}
var unlocked_job_ids: Dictionary = {}
var defeated_by_job: Dictionary = {}
var _mastery_events: Dictionary = {}
var _instance_sequence: int = 0
var _quality_groups: Dictionary = {}
var last_craft: Dictionary = {}
var gathered_materials: Dictionary = {}
var _activity_quest_progress: Dictionary = {}
var _shop_offers: Dictionary = {}
var _conditions_by_quest: Dictionary = {}
var _condition_events: Dictionary = {}
var _condition_progress: Dictionary = {}
var _condition_signatures: Dictionary = {}
var _quests_by_source_region: Dictionary = {}
var last_quest_claim: Dictionary = {}
var accepted_quest_ids: Dictionary = {}

func item_rarity(table_name: String, record_id: String) -> Dictionary:
	# Rarity is authored supply information, independent of current gather odds.
	if table_name not in ["materials", "equipment"] or not database.is_loaded(): return {}
	var item = database.by_id(table_name, record_id)
	if item == null: return {}
	var rarity = item.get_reference("rarity_ref")
	if rarity == null: return {}
	var rarity_name: String = row_name(rarity).strip_edges()
	var rarity_color: String = rarity.get_string("color", "").strip_edges()
	if rarity_name.is_empty() or not Color.html_is_valid(rarity_color): return {}
	return {"name": rarity_name, "color": rarity_color}

func load_main(path: String = "") -> Dictionary:
	var legacy_progress: Dictionary = _legacy_quest_progress_snapshot()
	var result: Dictionary = super.load_main(path)
	if result.ok and result.changed:
		if _loaded_catalog_indexes.has("quality_groups"):
			_quality_groups = _loaded_catalog_indexes.quality_groups
		else:
			_index_quality_materials()
		# Instance identity and ownership persist; this cached stat follows live data,
		# just as it does when restoring a checkpoint against updated definitions.
		for item in equipment_instances.values():
			var quality_id: String = str(item.quality_material_id)
			var quality = database.by_id("materials", quality_id) if not quality_id.is_empty() else null
			if quality != null:
				item.quality_multiplier_permille = maxi(1, quality.get_int("quality_multiplier_permille", 1000))
			elif quality_id.is_empty(): item.quality_multiplier_permille = 1000
		_shop_offers = _loaded_shop_offers
		_loaded_shop_offers = {}
		_index_quest_conditions(_loaded_catalog_indexes)
		_loaded_catalog_indexes = {}
		_migrate_legacy_quest_progress(legacy_progress)
		for quest_id in accepted_quest_ids.keys():
			if database.by_id("quests", str(quest_id)) == null: accepted_quest_ids.erase(quest_id)
		for job_id in unlocked_job_ids.keys():
			if database.by_id("jobs", str(job_id)) == null: unlocked_job_ids.erase(job_id)
		_revalidate_equipment()
		if not selected_quality_id.is_empty() and database.by_id("materials", selected_quality_id) == null:
			selected_quality_id = ""
	return result

func choose_purpose(objective_id: String) -> bool:
	if not super.choose_purpose(objective_id): return false
	# Selecting a long-term goal accepts that request, without granting access to
	# its region, conditions or rewards. Other grand quests remain unaccepted.
	var quest_id: String = str(selected_objective().get("quest_id", ""))
	if not quest_id.is_empty() and database.by_id("quests", quest_id) != null:
		accepted_quest_ids[quest_id] = true
	return true

func quest_is_accepted(quest_id: String) -> bool:
	return database.by_id("quests", quest_id) != null and accepted_quest_ids.get(quest_id, false) == true

func _quest_available_here(quest_id: String) -> bool:
	var quest = database.by_id("quests", quest_id)
	if quest == null or not content_available("quests", quest_id): return false
	# Shared requests have no authored regional scope. A requester's home still
	# controls discovery through content_available, but is not a location filter.
	var source = quest.get_reference("region_ref")
	return source == null or (source.id() == region_id and is_region_visited(source.id()))

func accept_quest(quest_id: String) -> bool:
	if activity not in [BASE, RETURN]: return fail("Accept requests at base or when reporting your return.")
	var quest = database.by_id("quests", quest_id)
	if quest == null: return fail("This request is no longer available.")
	if claimed_quests.has(quest_id): return fail("This request has already been reported.")
	if quest_is_accepted(quest_id): return true
	if quest.get_bool("grand_candidate") or _is_grand_quest(quest_id): return fail("Choose your grand quest at the start of a new game.")
	var source_id: String = _quest_route_source(quest)
	if (not source_id.is_empty() and not is_region_discovered(source_id)) or not _quest_available_here(quest_id):
		return fail("Accept available requests from people at your current location.")
	accepted_quest_ids[quest_id] = true
	log_event("REQUEST  %s accepted" % row_name(quest))
	return true

func quest_state(quest_id: String) -> String:
	if database.by_id("quests", quest_id) == null: return "unavailable"
	if claimed_quests.has(quest_id): return "claimed"
	if quest_is_accepted(quest_id):
		return "accepted_ready" if quest_claim_quote(quest_id, true).ok else "accepted"
	if database.by_id("quests", quest_id).get_bool("grand_candidate") or _is_grand_quest(quest_id): return "unavailable"
	if not _quest_available_here(quest_id): return "unavailable"
	return "available_ready" if quest_claim_quote(quest_id, true, true).ok else "available"

func ready_quest_ids() -> Array:
	var result: Array = []
	for quest_id in accepted_quest_ids:
		var quest = database.by_id("quests", str(quest_id))
		if quest == null or quest.get_bool("grand_candidate") or _is_grand_quest(str(quest_id)): continue
		if quest_is_accepted(str(quest_id)) and quest_claim_quote(str(quest_id), true).ok: result.append(quest_id)
	return result

func available_unaccepted_quest_ids() -> Array:
	var result: Array = []
	for quest in quest_catalog():
		if quest.get_bool("grand_candidate") or _is_grand_quest(quest.id()): continue
		if not quest_is_accepted(quest.id()) and _quest_available_here(quest.id()) and quest_claim_quote(quest.id(), true, true).ok: result.append(quest.id())
	return result

func _index_quality_materials():
	_quality_groups.clear()
	var table = database.table("materials")
	if table == null: return
	for i in range(table.count()):
		var material = table.at(i)
		var group: String = material.get_string("quality_group_key")
		if group.is_empty() or material.get_int("quality_index", -1) < 0: continue
		if not _quality_groups.has(group): _quality_groups[group] = []
		_quality_groups[group].append(material.id())

func bare_attributes(job_id: String = "") -> Dictionary:
	var id: String = str(selected_ids.get("jobs", "")) if job_id.is_empty() else job_id
	var job = database.by_id("jobs", id)
	if job == null: return {"strength": 0, "dexterity": 0, "intelligence": 0}
	return {"strength": maxi(0, job.get_int("strength")), "dexterity": maxi(0, job.get_int("dexterity")), "intelligence": maxi(0, job.get_int("intelligence"))}

func mastery_for(job_id: String = "") -> int:
	var id: String = str(selected_ids.get("jobs", "")) if job_id.is_empty() else job_id
	return int(job_mastery.get(id, 0))

func job_lineage(job_id: String) -> Array[String]:
	# A malformed or cyclic lineage is never a shortcut to a profession or weapon.
	var lineage: Array[String] = []
	var current: String = job_id
	while not current.is_empty():
		if current in lineage: return []
		var job = database.by_id("jobs", current)
		if job == null or job.get_int("tier", 1) < 1: return []
		lineage.append(current)
		var parent = job.get_reference("parent_job")
		if parent == null:
			if not job.get_string("parent_job").is_empty() or job.get_int("tier", 1) > 1: return []
			return lineage
		if job.get_int("tier", 1) <= 1: return []
		current = parent.id()
	return []

func job_is_unlocked(job_id: String) -> bool:
	var lineage: Array[String] = job_lineage(job_id)
	if lineage.is_empty(): return false
	for index in range(lineage.size() - 1):
		if unlocked_job_ids.get(lineage[index], false) != true: return false
	return true

func job_unlock_cost(job_id: String) -> int:
	var job = database.by_id("jobs", job_id)
	if job == null or job_is_unlocked(job_id): return 0
	return job.get_int("promotion_cost")

func job_requirement_reason(job_id: String) -> String:
	var job = database.by_id("jobs", job_id)
	if job == null: return "This job is no longer in the live data."
	if job.get_int("damage_multiplier_permille", 1000) <= 0: return "This job has an invalid damage multiplier."
	if not super.content_available("jobs", job_id): return "This job's progression requirements have not been met."
	var lineage: Array[String] = job_lineage(job_id)
	if lineage.is_empty(): return "This job has an invalid or cyclic parent lineage."
	if job_is_unlocked(job_id): return ""
	var parent = job.get_reference("parent_job")
	if parent == null: return "This advanced job has no valid parent job."
	if not job_is_unlocked(parent.id()): return "Unlock %s first." % row_name(parent)
	var current_id: String = str(selected_ids.get("jobs", ""))
	if not job_is_unlocked(current_id) or parent.id() not in job_lineage(current_id):
		return "Switch to %s or one of its unlocked advanced jobs first." % row_name(parent)
	var required: int = job.get_int("mastery_required")
	if required < 0: return "This job has an invalid mastery requirement."
	if mastery_for(parent.id()) < required:
		return "%s mastery %d / %d required" % [row_name(parent), mastery_for(parent.id()), required]
	# Optional authored requirements remain supported, but absent references impose no trial.
	var required_quest = job.get_reference("required_quest")
	if required_quest == null and not job.get_string("required_quest").is_empty(): return "This job references an unavailable quest."
	if required_quest != null and not claimed_quests.has(required_quest.id()): return "Report %s first." % row_name(required_quest)
	if job.get_reference("trial_enemy") == null and not job.get_string("trial_enemy").is_empty(): return "This job references an unavailable trial enemy."
	var trial_table = database.table("job_trials")
	if trial_table != null:
		for index in range(trial_table.count()):
			var trial = trial_table.at(index)
			if trial.get_string("job") == job_id and trial.get_reference("enemy") == null: return "This job references an unavailable trial enemy."
	var trials: Array = job_trial_enemies(job_id)
	if not trials.is_empty():
		var trial_completed: bool = false
		for trial in trials:
			if defeated_by_job.get(parent.id(), {}).has(trial.id()): trial_completed = true
		if not trial_completed: return "Complete one of this job's trials as %s." % row_name(parent)
	var cost: int = job_unlock_cost(job_id)
	if cost < 0: return "This job has an invalid promotion cost."
	if gold < cost: return "Promotion costs %d G; you have %d G." % [cost, gold]
	return ""

func job_trial_enemies(job_id: String) -> Array:
	var result: Array = []
	var table = database.table("job_trials")
	if table != null:
		for i in range(table.count()):
			var trial = table.at(i)
			var job = trial.get_reference("job")
			var foe = trial.get_reference("enemy")
			if job != null and job.id() == job_id and foe != null and not result.any(func(existing): return existing.id() == foe.id()): result.append(foe)
	var job = database.by_id("jobs", job_id)
	if job != null:
		var fallback = job.get_reference("trial_enemy")
		if fallback != null and not result.any(func(existing): return existing.id() == fallback.id()): result.append(fallback)
	return result

func content_available(table_name: String, record_id: String) -> bool:
	if table_name == "shops":
		var shop = database.by_id("shops", record_id)
		if shop == null: return false
		var region = shop.get_reference("region_ref")
		return region != null and is_region_visited(region.id()) and super.content_available("regions", region.id())
	if not super.content_available(table_name, record_id): return false
	if table_name == "quests":
		var quest = database.by_id("quests", record_id)
		var source_region = quest.get_reference("region_ref")
		if source_region == null:
			var requester = quest.get_reference("requester")
			if requester != null: source_region = requester.get_reference("region")
		if source_region != null and (not is_region_visited(source_region.id()) or not super.content_available("regions", source_region.id())): return false
	if table_name == "jobs": return job_requirement_reason(record_id).is_empty()
	return true

func equipment_mastery_job_id(definition_id: String, job_id: String = "") -> String:
	var equipment = database.by_id("equipment", definition_id)
	var selected_job: String = str(selected_ids.get("jobs", "")) if job_id.is_empty() else job_id
	var lineage: Array[String] = job_lineage(selected_job)
	if equipment == null or lineage.is_empty(): return ""
	var required_job = equipment.get_reference("required_job")
	if required_job != null: return required_job.id()
	if not equipment.get_string("required_job").is_empty(): return ""
	var rank: int = equipment.get_int("required_job_tier")
	if rank == 0: return selected_job
	for id in lineage:
		if database.by_id("jobs", id).get_int("tier", 1) == rank: return id
	return ""

func equipment_mastery_required(definition_id: String, job_id: String = "") -> int:
	var equipment = database.by_id("equipment", definition_id)
	var selected_job: String = str(selected_ids.get("jobs", "")) if job_id.is_empty() else job_id
	var job = database.by_id("jobs", selected_job)
	if equipment == null or job == null: return -1
	var required: int = equipment.get_int("required_mastery")
	var discount: int = job.get_int("equipment_mastery_discount")
	if required < 0 or discount < 0 or discount > 100: return -1
	# Ceil(required * (100-discount) / 100), without overflowing INT64.
	var percent: int = 100 - discount
	@warning_ignore("integer_division")
	var whole: int = (required / 100) * percent
	@warning_ignore("integer_division")
	return whole + ((required % 100) * percent + 99) / 100

func equipment_requirement_reason(definition_id: String, job_id: String = "") -> String:
	var equipment = database.by_id("equipment", definition_id)
	if equipment == null: return "This equipment definition is no longer available."
	if not content_available("equipment", definition_id): return "This equipment has not been unlocked."
	var selected_job: String = str(selected_ids.get("jobs", "")) if job_id.is_empty() else job_id
	var job = database.by_id("jobs", selected_job)
	if job == null or job_lineage(selected_job).is_empty(): return "Choose a job with a valid lineage."
	var required_tier: int = equipment.get_int("required_job_tier")
	if required_tier < 0: return "This equipment has an invalid job tier requirement."
	if job.get_int("tier", 1) < required_tier: return "Requires a tier %d job; your current job is tier %d." % [required_tier, job.get_int("tier", 1)]
	var required_job = equipment.get_reference("required_job")
	if required_job == null:
		if not equipment.get_string("required_job").is_empty(): return "This equipment references an unavailable required job."
	else:
		if job_lineage(required_job.id()).is_empty(): return "This equipment requires a job with an invalid lineage."
		if required_job.id() not in job_lineage(selected_job): return "Requires %s or one of its advanced jobs." % row_name(required_job)
	var mastery_job = database.by_id("jobs", equipment_mastery_job_id(definition_id, selected_job))
	if mastery_job == null: return "This equipment has no matching trained job in your lineage."
	if not job_is_unlocked(selected_job): return "Unlock the selected job before equipping this item."
	var required_mastery: int = equipment_mastery_required(definition_id, selected_job)
	if required_mastery < 0: return "This equipment or job has an invalid mastery requirement or discount."
	if mastery_for(mastery_job.id()) < required_mastery:
		return "%s mastery %d / %d required" % [row_name(mastery_job), mastery_for(mastery_job.id()), required_mastery]
	var attributes: Dictionary = bare_attributes(selected_job)
	for attribute in ["strength", "dexterity", "intelligence"]:
		var required: int = maxi(0, equipment.get_int("required_" + attribute))
		if int(attributes[attribute]) < required:
			return "%s %d / %d required" % [attribute.capitalize(), int(attributes[attribute]), required]
	return ""

func quality_choices(recipe_id: String, owned_only: bool = false) -> Array:
	var result: Array = []
	var recipe = database.by_id("recipes", recipe_id)
	if recipe == null: return result
	var group: String = recipe.get_string("quality_group_key")
	for id in _quality_groups.get(group, []):
		var material = database.by_id("materials", id)
		if material == null: continue
		if owned_only and inventory_count(material) < maxi(1, recipe.get_int("quality_material_count", 1)): continue
		result.append(material)
	return result

func _standard_quality(recipe_id: String) -> String:
	var recipe = database.by_id("recipes", recipe_id)
	if recipe == null: return ""
	var preferred = recipe.get_reference("default_quality")
	if preferred == null: return ""
	for material in quality_choices(recipe_id):
		if material.id() == preferred.id(): return material.id()
	return ""

func select_quality(material_id: String) -> bool:
	if activity != BASE: return fail("Choose crafting materials at the base forge.")
	var recipe_id: String = str(selected_ids.get("recipes", ""))
	for material in quality_choices(recipe_id):
		if material.id() == material_id:
			if not content_available("materials", material_id): return fail("This quality material has not been unlocked.")
			selected_quality_id = material_id
			return true
	return fail("This material does not belong to the selected recipe's quality group.")

func recipe_available(recipe_id: String) -> bool:
	if not content_available("recipes", recipe_id): return false
	var recipe = database.by_id("recipes", recipe_id)
	if recipe == null: return false
	var material = recipe.get_reference("material")
	if material == null or not content_available("materials", material.id()): return false
	if recipe.get_string("kind") == "refine":
		var output = recipe.get_reference("output_material")
		return output != null and content_available("materials", output.id())
	var equipment = recipe.get_reference("equipment")
	return equipment != null and content_available("equipment", equipment.id())

func _existing_variant(definition_id: String, quality_id: String) -> String:
	for id in equipment_instances:
		var item: Dictionary = equipment_instances[id]
		if item.definition_id == definition_id and item.quality_material_id == quality_id: return str(id)
	return ""

func recipe_quote(recipe_id: String, quality_id: String = "") -> Dictionary:
	var result: Dictionary = {"ok": false, "error": "This recipe is unavailable.", "recipe_id": recipe_id}
	if not recipe_available(recipe_id): return result
	var recipe = database.by_id("recipes", recipe_id)
	var material = recipe.get_reference("material")
	var kind: String = recipe.get_string("kind", "equipment")
	var inputs: Dictionary = {material.id(): maxi(1, recipe.get_int("material_count", 1))}
	var cost: int = maxi(0, recipe.get_int("cost"))
	result.merge({"kind": kind, "cost": cost, "inputs": inputs, "quality_material_id": "", "quality_multiplier_permille": 1000}, true)
	if kind == "refine":
		var output = recipe.get_reference("output_material")
		var output_count: int = maxi(1, recipe.get_int("output_count", 1))
		result["output_material_id"] = output.id()
		result["output_count"] = output_count
		var net_input: int = int(inputs.get(output.id(), 0))
		if maxi(0, inventory_count(output) - net_input) > MAX_AMOUNT - output_count:
			result.error = "There is no inventory room for the refined material."
			return result
	else:
		var equipment = recipe.get_reference("equipment")
		result["definition_id"] = equipment.id()
		var group: String = recipe.get_string("quality_group_key")
		if not group.is_empty():
			var quality = database.by_id("materials", quality_id)
			if quality == null or quality.get_string("quality_group_key") != group or quality.get_int("quality_index", -1) < 0:
				result.error = "Choose a quality material for this recipe."
				return result
			if not content_available("materials", quality.id()):
				result.error = "The selected quality material has not been unlocked."
				return result
			var quality_count: int = maxi(1, recipe.get_int("quality_material_count", 1))
			if int(inputs.get(quality.id(), 0)) > MAX_AMOUNT - quality_count:
				result.error = "The recipe's input count is too large."
				return result
			inputs[quality.id()] = int(inputs.get(quality.id(), 0)) + quality_count
			result.quality_material_id = quality.id()
			result.quality_multiplier_permille = maxi(1, quality.get_int("quality_multiplier_permille", 1000))
		if not _existing_variant(equipment.id(), str(result.quality_material_id)).is_empty():
			result.error = "This equipment quality is already in your inventory."
			return result
	if gold < cost:
		result.error = "Not enough gold for this recipe."
		return result
	for id in inputs:
		var input_material = database.by_id("materials", id)
		if inventory_count(input_material) < int(inputs[id]):
			result.error = "Need %d %s (owned %d)." % [int(inputs[id]), row_name(input_material), inventory_count(input_material)]
			return result
	result.ok = true
	result.error = ""
	return result

func can_craft() -> bool:
	return activity == BASE and bool(recipe_quote(str(selected_ids.get("recipes", "")), selected_quality_id).ok)

func craft() -> bool:
	if activity != BASE: return fail("Return to the base forge to craft.")
	var quote: Dictionary = recipe_quote(str(selected_ids.get("recipes", "")), selected_quality_id)
	if not quote.ok: return fail(str(quote.error))
	var eligible_craft_quests: Array = _activity_quests("craft")
	var craft_definition = database.by_id("equipment", str(quote.get("definition_id", "")))
	var craft_region = craft_definition.get_reference("region_ref") if craft_definition != null else null
	var craft_region_id: String = craft_region.id() if craft_region != null else ""
	var eligible_craft_conditions: Array = _eligible_event_conditions("craft", str(quote.get("definition_id", "")), craft_region_id)
	# All references, eligibility, quantities, ownership and overflow checks have
	# passed before the first inventory or currency mutation.
	for id in quote.inputs: _add_material(database.by_id("materials", id), -int(quote.inputs[id]))
	gold -= int(quote.cost)
	actions += 1
	last_craft = quote.duplicate(true)
	if quote.kind == "refine":
		_add_material(database.by_id("materials", quote.output_material_id), int(quote.output_count))
		log_event("REFINE  +%d %s" % [int(quote.output_count), row_name(database.by_id("materials", quote.output_material_id))])
		return true
	_instance_sequence += 1
	var instance_id: String = "equipment-instance-%08d" % _instance_sequence
	var item: Dictionary = {"id": instance_id, "definition_id": quote.definition_id, "quality_material_id": quote.quality_material_id, "quality_multiplier_permille": quote.quality_multiplier_permille}
	equipment_instances[instance_id] = item
	owned_equipment[quote.definition_id] = true
	selected_instance_id = instance_id
	rows.equipment = database.by_id("equipment", quote.definition_id)
	selected_ids.equipment = quote.definition_id
	last_craft["instance_id"] = instance_id
	_sync_equipment_flags()
	var definition = rows.equipment
	if equipment_requirement_reason(definition.id()).is_empty() and _mastery_tier_appropriate(definition.get_int("tier", 1), definition.get_int("mastery_stage", 0)):
		_award_mastery("craft:" + definition.id(), maxi(0, definition.get_int("mastery_reward")))
	for quest in eligible_craft_quests:
		var target = quest.get_reference("target_equipment")
		if target != null and target.id() == definition.id():
			_activity_quest_progress[quest.id()] = mini(MAX_AMOUNT - 1, int(_activity_quest_progress.get(quest.id(), 0))) + 1
	_credit_conditions(eligible_craft_conditions, 1)
	log_event("FORGE  %s created; equip it at base." % row_name(definition))
	return true

func craftable_recipe_ids() -> Dictionary:
	var result: Dictionary = {}
	var table = database.table("recipes")
	if table == null: return result
	for i in range(table.count()):
		var recipe = table.at(i)
		if not recipe_available(recipe.id()): continue
		if recipe.get_string("quality_group_key").is_empty():
			if recipe_quote(recipe.id()).ok: result[recipe.id()] = true
		else:
			for quality in quality_choices(recipe.id(), true):
				if recipe_quote(recipe.id(), quality.id()).ok:
					result[recipe.id()] = true
					break
	return result

func owned_instances() -> Array:
	var result: Array = []
	for id in equipment_instances: result.append(equipment_instances[id].duplicate(true))
	return result

func select_instance(instance_id: String) -> bool:
	if activity != BASE: return fail("Choose equipment at base.")
	if not equipment_instances.has(instance_id): return fail("That equipment instance is not owned.")
	var item: Dictionary = equipment_instances[instance_id]
	if not super.select_row("equipment", str(item.definition_id)): return false
	selected_instance_id = instance_id
	return true

func instance_requirement_reason(instance_id: String) -> String:
	if not equipment_instances.has(instance_id): return "That equipment instance is not owned."
	var item: Dictionary = equipment_instances[instance_id]
	var reason: String = equipment_requirement_reason(str(item.definition_id))
	if not reason.is_empty(): return reason
	if not str(item.quality_material_id).is_empty():
		if database.by_id("materials", item.quality_material_id) == null or not content_available("materials", item.quality_material_id):
			return "This instance's quality material is no longer available."
	return ""

func equip_instance(instance_id: String) -> bool:
	if activity != BASE: return fail("Change equipment at base.")
	if not loadout_job_available(): return fail("Select an available job first.")
	var reason: String = instance_requirement_reason(instance_id)
	if not reason.is_empty(): return fail(reason)
	selected_instance_id = instance_id
	if equipped_instance_id == instance_id:
		equipped_instance_id = ""
		equipped_id = ""
	else:
		equipped_instance_id = instance_id
		equipped_id = str(equipment_instances[instance_id].definition_id)
	_sync_equipment_flags()
	actions += 1
	log_event("GEAR  Attack %d" % attack_power())
	return true

func equip() -> bool:
	var definition_id: String = str(selected_ids.get("equipment", ""))
	if equipment_instances.has(selected_instance_id) and str(equipment_instances[selected_instance_id].definition_id) == definition_id:
		return equip_instance(selected_instance_id)
	for id in equipment_instances:
		if str(equipment_instances[id].definition_id) == definition_id: return equip_instance(str(id))
	return fail("Forge this equipment before equipping it.")

func loadout_job_available() -> bool:
	var id: String = str(selected_ids.get("jobs", ""))
	return job_is_unlocked(id) and content_available("jobs", id)

func loadout_available() -> bool:
	return loadout_job_available() and (equipped_instance_id.is_empty() or instance_requirement_reason(equipped_instance_id).is_empty())

func _revalidate_equipment():
	if equipped_instance_id.is_empty():
		equipped_id = ""
		_sync_equipment_flags()
		return
	if not loadout_job_available() or not instance_requirement_reason(equipped_instance_id).is_empty():
		equipped_instance_id = ""
		equipped_id = ""
		_sync_equipment_flags()
		log_event("GEAR  Requirements changed; item retained and slot cleared.")

func _scale_damage(attack: int, multiplier: int) -> int:
	if multiplier <= 0: return 1
	attack = maxi(1, attack)
	# Rounded permille multiplication using bounded integer pieces, even at INT64_MAX.
	@warning_ignore("integer_division")
	var whole_units: int = attack / 1000
	@warning_ignore("integer_division")
	if whole_units > MAX_AMOUNT / multiplier: return MAX_AMOUNT
	var whole: int = whole_units * multiplier
	var remainder: int = attack % 1000
	@warning_ignore("integer_division")
	var fraction: int = remainder * (multiplier / 1000) + (remainder * (multiplier % 1000) + 500) / 1000
	if whole > MAX_AMOUNT - fraction: return MAX_AMOUNT
	return maxi(1, whole + fraction)

func _attack_with_equipment(definition, quality_multiplier: int = 1000) -> int:
	var base: int = maxi(1, value("jobs", "attack", value("balance", "attack", 8)))
	var unscaled: int = base
	if definition != null:
		var attributes: Dictionary = bare_attributes()
		var power: float = float(definition.get_int("attack"))
		for attribute in ["strength", "dexterity", "intelligence"]:
			power += float(attributes[attribute]) * float(definition.get_int("scale_" + attribute)) / 1000.0
		var bonus: float = power * float(quality_multiplier) / 1000.0
		if bonus >= float(MAX_AMOUNT - base): unscaled = MAX_AMOUNT
		elif bonus <= -float(base): unscaled = 1
		else: unscaled = maxi(1, base + int(round(bonus)))
	return _scale_damage(unscaled, value("jobs", "damage_multiplier_permille", 1000))

func attack_power() -> int:
	if equipped_instance_id.is_empty() or not equipment_instances.has(equipped_instance_id): return _attack_with_equipment(null)
	var item: Dictionary = equipment_instances[equipped_instance_id]
	return _attack_with_equipment(database.by_id("equipment", str(item.definition_id)), int(item.quality_multiplier_permille))

func recipe_equipment_preview(recipe_id: String, quality_id: String = "") -> Dictionary:
	# Read-only: preview unowned equipment without temporarily equipping it.
	var before: Dictionary = bare_attributes()
	before.merge({"attack": attack_power(), "max_hp": max_hp()})
	var result: Dictionary = {"ok": false, "error": "Select an equipment recipe.", "before": before, "after": before.duplicate(), "requirement_reason": ""}
	var recipe = database.by_id("recipes", recipe_id)
	if recipe == null or recipe.get_string("kind", "equipment") == "refine": return result
	var definition = recipe.get_reference("equipment")
	if definition == null: return result
	var multiplier: int = 1000
	var group: String = recipe.get_string("quality_group_key")
	if not group.is_empty():
		var quality = database.by_id("materials", quality_id)
		if quality == null or quality.get_string("quality_group_key") != group or quality.get_int("quality_index", -1) < 0:
			result.error = "Choose a quality material to preview this equipment."
			return result
		multiplier = maxi(1, quality.get_int("quality_multiplier_permille", 1000))
		if not content_available("materials", quality_id): result.requirement_reason = "This quality material has not been unlocked."
	var reason: String = equipment_requirement_reason(definition.id())
	if not reason.is_empty(): result.requirement_reason = reason
	if not loadout_job_available(): result.requirement_reason = "Choose an available job first."
	result.quality_multiplier_permille = multiplier
	result.after.attack = _attack_with_equipment(definition, multiplier)
	result.ok = true
	result.error = ""
	return result

func select_row(table_name: String, record_id: String) -> bool:
	var promotion_cost: int = 0
	var unlock_job: bool = false
	if table_name == "shops" and not content_available("shops", record_id): return fail("Visit this shop's region before selecting its merchant.")
	if table_name == "jobs":
		var reason: String = job_requirement_reason(record_id)
		if not reason.is_empty(): return fail(reason)
		unlock_job = not job_is_unlocked(record_id)
		promotion_cost = job_unlock_cost(record_id)
	if not super.select_row(table_name, record_id): return false
	if table_name == "jobs":
		# All model, activity and wound checks succeeded; charge only this first unlock.
		if unlock_job:
			gold -= promotion_cost
			unlocked_job_ids[record_id] = true
			log_event("JOB  Unlocked %s for %d G" % [title("jobs", "Job"), promotion_cost])
		_revalidate_equipment()
	if table_name == "recipes": selected_quality_id = _standard_quality(record_id)
	if table_name == "equipment":
		selected_instance_id = ""
		for id in equipment_instances:
			if str(equipment_instances[id].definition_id) == record_id:
				selected_instance_id = str(id)
				break
	return true

func _award_mastery(event_id: String, amount: int):
	var job_id: String = str(selected_ids.get("jobs", ""))
	if not loadout_job_available() or amount <= 0: return
	var key: String = job_id + ":" + event_id
	if _mastery_events.has(key): return
	_mastery_events[key] = true
	job_mastery[job_id] = mini(MAX_AMOUNT - amount, mastery_for(job_id)) + amount
	log_event("MASTERY  %s +%d" % [title("jobs", "Job"), amount])

func _mastery_tier_appropriate(content_tier: int, content_stage: int = 0) -> bool:
	return content_tier >= maxi(1, value("jobs", "mastery_enemy_tier_min", 1)) and content_stage >= maxi(0, value("jobs", "mastery_stage_min", 0))

func advance(enemy_id: String = "") -> bool:
	if not super.advance(enemy_id): return false
	var definition = database.by_id("enemies", str(enemy.id))
	enemy["mastery_reward"] = maxi(0, definition.get_int("mastery_reward"))
	enemy["mastery_tier"] = maxi(1, definition.get_int("tier", 1))
	enemy["mastery_stage"] = maxi(0, definition.get_int("mastery_stage", 0))
	var enemy_region = definition.get_reference("region_ref")
	enemy["quest_region_id"] = enemy_region.id() if enemy_region != null else region_id
	return true

func attack() -> bool:
	# Check the pinned reward before even the terminal hit mutates enemy HP.
	if activity == BATTLE and hp > 0 and not enemy.is_empty() and loadout_available() and int(enemy.hp) <= attack_power():
		var bounty: int = int(enemy.get("bounty", 0))
		var loot: int = int(enemy.get("loot_amount", 0))
		var loot_id: String = str(enemy.get("loot_id", ""))
		var held: int = ore if core_rows.has("materials") and loot_id == core_rows.materials.id() else int(material_inventory.get(loot_id, 0))
		if bounty < 0 or loot < 0 or gold < 0 or held < 0 or gold > MAX_AMOUNT - bounty or held > MAX_AMOUNT - loot:
			return fail("The victory reward will not fit. Retreat and make room at base.")
		if wins >= MAX_AMOUNT or int(wins_by_region.get(str(enemy.get("region_id", "")), 0)) >= MAX_AMOUNT:
			return fail("The victory counter is full. This attack was not applied.")
	var previous_enemy: Dictionary = enemy.duplicate(true)
	var before_wins: int = wins
	var job_id: String = str(selected_ids.get("jobs", ""))
	var eligible_kill_conditions: Array = _eligible_event_conditions("kill", str(previous_enemy.get("id", "")), str(previous_enemy.get("quest_region_id", region_id)))
	if not super.attack(): return false
	if wins == before_wins + 1 and not previous_enemy.is_empty():
		_credit_conditions(eligible_kill_conditions, 1)
		if not defeated_by_job.has(job_id): defeated_by_job[job_id] = {}
		defeated_by_job[job_id][str(previous_enemy.id)] = true
		if _mastery_tier_appropriate(int(previous_enemy.get("mastery_tier", 1)), int(previous_enemy.get("mastery_stage", 0))):
			_award_mastery("victory:" + str(previous_enemy.id), maxi(0, int(previous_enemy.get("mastery_reward", 0))))
	return true

func claim_quest() -> bool:
	if not quest_is_accepted(str(selected_ids.get("quests", ""))): return fail("Accept this request before reporting it.")
	if database.table("quest_conditions") != null:
		return _claim_quest_reward(str(selected_ids.get("quests", "")))
	var quest_id: String = str(selected_ids.get("quests", ""))
	var quest = rows.get("quests")
	if quest != null and can_claim_quest():
		var reward: int = maxi(0, quest.get_int("gold"))
		if gold < 0 or gold > MAX_AMOUNT - reward: return fail("The quest reward will not fit. Spend gold before claiming it.")
	if not super.claim_quest(): return false
	if quest.get_int("mastery_stage", 0) >= maxi(0, value("jobs", "mastery_stage_min", 0)):
		_award_mastery("quest:" + quest_id, maxi(0, quest.get_int("mastery_reward")))
	return true

func _activity_quests(kind: String) -> Array:
	var result: Array = []
	if database.table("quest_conditions") != null: return result
	var table = database.table("quests")
	if table == null: return result
	for i in range(table.count()):
		var quest = table.at(i)
		if quest.get_string("objective_kind", "victories") == kind and content_available("quests", quest.id()): result.append(quest)
	return result

func gather(material_id: String = "") -> bool:
	var eligible: Array = _activity_quests("gather")
	var eligible_by_material: Dictionary = {}
	for item in gathering_pool():
		if int(item.remaining) > 0:
			eligible_by_material[item.id] = _eligible_event_conditions("gather", str(item.id), region_id)
	if not super.gather(material_id): return false
	for item in last_gather.get("items", []):
		var id: String = str(item.id)
		var amount: int = int(item.amount)
		gathered_materials[id] = mini(MAX_AMOUNT - amount, int(gathered_materials.get(id, 0))) + amount
		_credit_conditions(eligible_by_material.get(id, []), amount)
		for quest in eligible:
			var target = quest.get_reference("target_material")
			var target_region = quest.get_reference("region_ref")
			if target != null and target.id() == id and (target_region == null or target_region.id() == region_id):
				_activity_quest_progress[quest.id()] = mini(MAX_AMOUNT - amount, int(_activity_quest_progress.get(quest.id(), 0))) + amount
	return true

func quest_progress(row = null) -> int:
	if row == null: row = rows.get("quests")
	if row == null: return 0
	if database.table("quest_conditions") != null:
		var completed: int = 0
		for condition in quest_condition_summaries(row.id()):
			if condition.ready: completed += 1
		return completed
	if row.get_string("objective_kind", "victories") in ["gather", "craft"]:
		return int(_activity_quest_progress.get(row.id(), 0))
	return super.quest_progress(row)

func _quest_ref_id(row, field: String) -> String:
	var target = row.get_reference(field)
	return target.id() if target != null else ""

func _legacy_quest_progress_snapshot() -> Dictionary:
	var result: Dictionary = {}
	if database.table("quest_conditions") != null: return result
	var table = database.table("quests")
	if table == null: return result
	for index in range(table.count()):
		var quest = table.at(index)
		var kind: String = quest.get_string("objective_kind", "victories")
		var progress: int = int(_eligible_quest_progress.get(quest.id(), 0)) if kind == "victories" else int(_activity_quest_progress.get(quest.id(), 0))
		if progress <= 0 or kind not in ["victories", "gather", "craft"]: continue
		var target: String = ""
		var target_region: String = quest_region_id(quest)
		if kind == "gather": target = _quest_ref_id(quest, "target_material")
		if kind == "craft":
			target = _quest_ref_id(quest, "target_equipment")
			var equipment = database.by_id("equipment", target)
			target_region = _quest_ref_id(equipment, "region_ref") if equipment != null else ""
		result[quest.id()] = {"kind": "kill" if kind == "victories" else kind, "target": target, "region": target_region, "progress": progress}
	return result

func _migrate_legacy_quest_progress(legacy: Dictionary):
	if legacy.is_empty() or database.table("quest_conditions") == null: return
	for quest_id in legacy:
		var previous: Dictionary = legacy[quest_id]
		for condition in quest_conditions(str(quest_id)):
			var kind: String = condition.get_string("kind")
			if kind != str(previous.kind): continue
			var target_field: String = "target_enemy" if kind == "kill" else ("target_material" if kind == "gather" else "target_equipment")
			if _quest_ref_id(condition, target_field) != str(previous.target): continue
			var required_region: String = _quest_ref_id(condition, "target_region")
			# Historical crafting already identifies the exact equipment, so a
			# matching authored equipment region adds no new historical obligation.
			if kind == "craft":
				if not required_region.is_empty() and required_region != str(previous.region): continue
			elif required_region != str(previous.region): continue
			_condition_progress[condition.id()] = int(previous.progress)

func _index_quest_conditions(prepared: Dictionary = {}):
	if prepared.has("condition_signatures"):
		var signatures: Dictionary = prepared.condition_signatures
		var next_progress: Dictionary = {}
		_condition_events.clear()
		_conditions_by_quest.clear()
		_quests_by_source_region = prepared.quest_regions
		for quest_id in prepared.condition_rows:
			var ids: Array = []
			for condition in prepared.condition_rows[quest_id]: ids.append(condition.id())
			_conditions_by_quest[quest_id] = ids
		for id in signatures:
			var signature: Array = signatures[id]
			if _condition_signatures.get(id, []) == signature:
				next_progress[id] = int(_condition_progress.get(id, 0))
			_index_condition_event(str(id), signature)
		_condition_signatures = signatures
		_condition_progress = next_progress
		return
	_conditions_by_quest.clear()
	_condition_events.clear()
	_quests_by_source_region.clear()
	var quests = database.table("quests")
	if quests != null:
		for index in range(quests.count()):
			var quest = quests.at(index)
			var source: String = _quest_ref_id(quest, "region_ref")
			if not _quests_by_source_region.has(source): _quests_by_source_region[source] = []
			_quests_by_source_region[source].append(quest.id())
	var table = database.table("quest_conditions")
	if table == null:
		_condition_signatures.clear()
		_condition_progress.clear()
		return
	var next_signatures: Dictionary = {}
	var next_progress: Dictionary = {}
	for index in range(table.count()):
		var condition = table.at(index)
		var quest_id: String = _quest_ref_id(condition, "quest")
		if quest_id.is_empty(): continue
		var kind: String = condition.get_string("kind")
		var signature: Array = [quest_id, kind]
		for field in ["target_enemy", "target_material", "target_equipment", "target_region"]:
			signature.append(_quest_ref_id(condition, field))
		next_signatures[condition.id()] = signature
		if _condition_signatures.get(condition.id(), []) == signature:
			next_progress[condition.id()] = int(_condition_progress.get(condition.id(), 0))
		if not _conditions_by_quest.has(quest_id): _conditions_by_quest[quest_id] = []
		_conditions_by_quest[quest_id].append(condition.id())
		_index_condition_event(condition.id(), signature)
	_condition_signatures = next_signatures
	_condition_progress = next_progress

func _index_condition_event(id: String, signature: Array):
	var kind: String = str(signature[1])
	if kind not in ["kill", "gather", "craft"]: return
	var target_index: int = 2
	if kind == "gather": target_index = 3
	elif kind == "craft": target_index = 4
	var target_id: String = str(signature[target_index])
	var target_region: String = str(signature[5])
	var event_key: String = kind + ":id:" + target_id
	if target_id.is_empty(): event_key = kind + ":region:" + target_region if not target_region.is_empty() else kind + ":any"
	if not _condition_events.has(event_key): _condition_events[event_key] = []
	_condition_events[event_key].append(id)

func quest_catalog(source_region_id: String = "", local_difficulty: int = 0, include_locked: bool = false) -> Array:
	var result: Array = []
	var sources: Array = _quests_by_source_region.keys() if source_region_id.is_empty() else [source_region_id]
	for source in sources:
		if not str(source).is_empty() and not is_region_visited(str(source)): continue
		for quest_id in _quests_by_source_region.get(source, []):
			var quest = database.by_id("quests", str(quest_id))
			if quest == null or (not include_locked and not content_available("quests", str(quest_id))): continue
			if local_difficulty > 0 and quest.get_int("local_difficulty") != local_difficulty: continue
			result.append(quest)
	return result

func quest_conditions(quest_id: String) -> Array:
	var result: Array = []
	for condition_id in _conditions_by_quest.get(quest_id, []):
		var condition = database.by_id("quest_conditions", str(condition_id))
		if condition != null: result.append(condition)
	return result

func _event_candidates(kind: String, target_id: String, target_region_id: String) -> Array:
	var result: Array = []
	for event_key in [kind + ":id:" + target_id, kind + ":region:" + target_region_id, kind + ":any"]:
		for condition_id in _condition_events.get(event_key, []):
			var condition = database.by_id("quest_conditions", str(condition_id))
			if condition == null: continue
			var required_region: String = _quest_ref_id(condition, "target_region")
			if required_region.is_empty() or required_region == target_region_id: result.append(condition_id)
	return result

func _eligible_event_conditions(kind: String, target_id: String, target_region_id: String) -> Array:
	var result: Array = []
	for condition_id in _event_candidates(kind, target_id, target_region_id):
		var condition = database.by_id("quest_conditions", str(condition_id))
		var quest_id: String = _quest_ref_id(condition, "quest")
		if not claimed_quests.has(quest_id) and content_available("quests", quest_id): result.append(condition_id)
	return result

func _credit_conditions(condition_ids: Array, amount: int):
	if amount <= 0: return
	for condition_id in condition_ids:
		_condition_progress[condition_id] = mini(MAX_AMOUNT - amount, int(_condition_progress.get(condition_id, 0))) + amount

func quest_condition_summaries(quest_id: String) -> Array:
	var result: Array = []
	var delivery_remaining: Dictionary = {}
	for condition in quest_conditions(quest_id):
		var kind: String = condition.get_string("kind")
		var required: int = condition.get_int("count")
		var current: int = int(_condition_progress.get(condition.id(), 0))
		var material_id: String = _quest_ref_id(condition, "target_material")
		if kind == "own_equipment": current = owned_equipment_count(_quest_ref_id(condition, "target_equipment"))
		if kind == "deliver":
			if not delivery_remaining.has(material_id): delivery_remaining[material_id] = inventory_count(database.by_id("materials", material_id))
			current = mini(maxi(0, required), int(delivery_remaining[material_id]))
			delivery_remaining[material_id] = maxi(0, int(delivery_remaining[material_id]) - current)
		result.append({"id": condition.id(), "kind": kind, "current": current, "target": required, "ready": required > 0 and current >= required,
			"target_enemy_id": _quest_ref_id(condition, "target_enemy"), "target_material_id": material_id,
			"target_equipment_id": _quest_ref_id(condition, "target_equipment"), "target_region_id": _quest_ref_id(condition, "target_region")})
	return result

func owned_equipment_count(definition_id: String) -> int:
	if database.by_id("equipment", definition_id) == null: return 0
	var variants: Dictionary = {}
	for item in equipment_instances.values():
		if typeof(item) != TYPE_DICTIONARY: continue
		if typeof(item.get("definition_id")) != TYPE_STRING or item.get("definition_id") != definition_id: continue
		var quality_id = item.get("quality_material_id", "")
		if typeof(quality_id) != TYPE_STRING: continue
		variants[quality_id] = true
	# Old session models tracked one owned definition, without instance records.
	# Do not add that compatibility flag again when real instances already exist.
	var legacy_owned = owned_equipment.get(definition_id, false)
	if variants.is_empty() and typeof(legacy_owned) == TYPE_BOOL and legacy_owned: return 1
	return variants.size()

func quest_target(row = null) -> int:
	if row == null: row = rows.get("quests")
	if row == null: return 1
	if database.table("quest_conditions") == null: return super.quest_target(row)
	return maxi(1, quest_conditions(row.id()).size())

func _is_grand_quest(quest_id: String) -> bool:
	for objective in progression_policy.get("grand_objectives", []):
		if str(objective.get("quest_id", "")) == quest_id: return true
	return false

func quest_claim_quote(quest_id: String, allow_grand: bool = false, allow_unaccepted: bool = false) -> Dictionary:
	var result: Dictionary = {"ok": false, "error": "This request is unavailable.", "quest_id": quest_id, "deliveries": {}, "gold": 0, "mastery": 0, "conditions": []}
	var quest = database.by_id("quests", quest_id)
	if quest == null or not content_available("quests", quest_id): return result
	result.gold = maxi(0, quest.get_int("gold"))
	if quest.get_int("mastery_stage", 0) >= maxi(0, value("jobs", "mastery_stage_min", 0)) and loadout_job_available():
		result.mastery = mini(MAX_AMOUNT - mastery_for(), maxi(0, quest.get_int("mastery_reward")))
	if claimed_quests.has(quest_id):
		result.error = "This request has already been reported."
		return result
	if not allow_unaccepted and not quest_is_accepted(quest_id):
		result.error = "Accept this request before reporting it."
		return result
	if _is_grand_quest(quest_id) and not allow_grand and activity != RETURN:
		result.error = "Report this grand quest on your return."
		return result
	if database.table("quest_conditions") == null:
		if quest_progress(quest) < quest_target(quest):
			result.error = "Complete this request's conditions before reporting it."
			return result
		if gold < 0 or gold > MAX_AMOUNT - int(result.gold):
			result.error = "The request reward will not fit. Spend gold before reporting."
			return result
		result.ok = true
		result.error = ""
		return result
	var conditions: Array = quest_conditions(quest_id)
	result.conditions = quest_condition_summaries(quest_id)
	if conditions.is_empty():
		result.error = "This request has no valid conditions."
		return result
	for condition in conditions:
		var kind: String = condition.get_string("kind")
		var count: int = condition.get_int("count")
		if kind not in ["kill", "gather", "craft", "deliver", "own_equipment"] or count <= 0:
			result.error = "This request has an invalid condition."
			return result
		for entry in [["target_enemy", "enemies"], ["target_material", "materials"], ["target_equipment", "equipment"], ["target_region", "regions"]]:
			var target_id: String = _quest_ref_id(condition, entry[0])
			if not target_id.is_empty() and not content_available(entry[1], target_id):
				result.error = "A required destination or item is not available yet."
				return result
		if kind == "deliver":
			var material_id: String = _quest_ref_id(condition, "target_material")
			if material_id.is_empty() or int(result.deliveries.get(material_id, 0)) > MAX_AMOUNT - count:
				result.error = "This delivery requirement is invalid."
				return result
			result.deliveries[material_id] = int(result.deliveries.get(material_id, 0)) + count
	# An earlier incomplete condition must not hide a later impossible craft.
	for condition in conditions:
		var impossible_reason: String = strict_craft_condition_reason(condition.id())
		if not impossible_reason.is_empty():
			result.error = impossible_reason
			result["unreachable"] = true
			return result
	for condition in conditions:
		var kind: String = condition.get_string("kind")
		var current: int = owned_equipment_count(_quest_ref_id(condition, "target_equipment")) if kind == "own_equipment" else int(_condition_progress.get(condition.id(), 0))
		if kind != "deliver" and current < condition.get_int("count"):
			result.error = "Complete every condition before reporting this request."
			return result
	for material_id in result.deliveries:
		if inventory_count(database.by_id("materials", str(material_id))) < int(result.deliveries[material_id]):
			result.error = "You do not have all the delivery materials."
			return result
	var reward: int = maxi(0, quest.get_int("gold"))
	result.gold = reward
	if gold < 0 or gold > MAX_AMOUNT - reward:
		result.error = "The request reward will not fit. Spend gold before reporting."
		return result
	result.ok = true
	result.error = ""
	return result

func can_claim_quest() -> bool:
	if activity not in [BASE, RETURN]: return false
	if not quest_is_accepted(str(selected_ids.get("quests", ""))): return false
	return bool(quest_claim_quote(str(selected_ids.get("quests", ""))).ok)

func _claim_quest_reward(quest_id: String, allow_grand: bool = false) -> bool:
	if activity not in [BASE, RETURN]: return fail("Report requests after returning to base.")
	if allow_grand and (activity != RETURN or quest_id != str(selected_objective().get("quest_id", ""))): return fail("This is not the selected grand quest's return report.")
	var quote: Dictionary = quest_claim_quote(quest_id, allow_grand)
	if not quote.ok: return fail(str(quote.error))
	var quest = database.by_id("quests", quest_id)
	# Every target, aggregate quantity, access rule and reward capacity has been
	# checked. No fallible operation remains between material consumption and claim.
	for material_id in quote.deliveries:
		_add_material(database.by_id("materials", str(material_id)), -int(quote.deliveries[material_id]))
	gold += int(quote.gold)
	claimed_quests[quest_id] = true
	actions += 1
	last_quest_claim = {"quest_id": quest_id, "gold": quote.gold, "deliveries": quote.deliveries.duplicate(), "outcome": quest.get_string("outcome")}
	if quest.get_int("mastery_stage", 0) >= maxi(0, value("jobs", "mastery_stage_min", 0)):
		_award_mastery("quest:" + quest_id, maxi(0, quest.get_int("mastery_reward")))
	log_event("REQUEST  %s reported; +%d gold" % [row_name(quest), int(quote.gold)])
	return true

func _grand_quest_conditions_ready(quest_id: String) -> bool:
	return claimed_quests.has(quest_id) or bool(quest_claim_quote(quest_id, true).ok)

func _report_selected_grand_quest() -> bool:
	var quest_id: String = str(selected_objective().get("quest_id", ""))
	if quest_id.is_empty(): return true
	if activity != RETURN: return false
	if claimed_quests.has(quest_id): return true
	return _claim_quest_reward(quest_id, true)

func _selected_shop_available() -> bool:
	return content_available("shops", str(selected_ids.get("shops", "")))

func _index_shop_offers():
	_shop_offers = _build_shop_offers(database)

func offer_for_material(material_id: String, shop_id: String = ""):
	var id: String = str(selected_ids.get("shops", "")) if shop_id.is_empty() else shop_id
	if not content_available("shops", id) or not content_available("materials", material_id): return null
	return database.by_id("shop_offers", str(_shop_offers.get(id, {}).get(material_id, "")))

func offers_for_shop(shop_id: String = "") -> Array:
	var result: Array = []
	var id: String = str(selected_ids.get("shops", "")) if shop_id.is_empty() else shop_id
	if not content_available("shops", id): return result
	for material_id in _shop_offers.get(id, {}):
		var offer = offer_for_material(str(material_id), id)
		if offer != null: result.append(offer)
	return result

func _offer_enabled(offer, buying: bool) -> bool:
	return offer != null and offer.get_bool("buy_enabled" if buying else "sell_enabled") and offer.get_int("buy_price" if buying else "sell_price") > 0

func select_shop_material(material_id: String) -> bool:
	if activity != BASE: return fail("The shop is at base.")
	var offer = offer_for_material(material_id)
	if not _offer_enabled(offer, true) and not _offer_enabled(offer, false): return fail("This shop does not trade that material.")
	return select_row("materials", material_id)

func shop_price() -> int:
	var offer = offer_for_material(str(selected_ids.get("materials", "")))
	return offer.get_int("buy_price") if _offer_enabled(offer, true) else 0

func sell_price(material = null) -> int:
	if material == null: material = rows.get("materials")
	var offer = offer_for_material(material.id()) if material != null else null
	return offer.get_int("sell_price") if _offer_enabled(offer, false) else 0

func trade_quote(quantity: int, buying: bool, material_id: String = "", shop_id: String = "") -> Dictionary:
	var selected_material: String = str(selected_ids.get("materials", ""))
	var selected_shop: String = str(selected_ids.get("shops", ""))
	var material = database.by_id("materials", selected_material)
	var owned: int = inventory_count(material) if material != null else 0
	var result: Dictionary = {"ok": false, "error": "This trade is unavailable.", "quantity": quantity,
		"unit_price": 0, "total": 0, "material_id": selected_material, "shop_id": selected_shop, "owned": owned, "resulting_owned": owned,
		"gold": gold, "resulting_gold": gold, "max_quantity": 0}
	if not database.is_loaded() or activity != BASE or not _selected_shop_available():
		result.error = "Select a merchant from a visited, unlocked region at base."
		return result
	if (not material_id.is_empty() and material_id != selected_material) or (not shop_id.is_empty() and shop_id != selected_shop):
		result.error = "The selected trade changed. Review the current item and quantity."
		return result
	var offer = offer_for_material(selected_material, selected_shop)
	if material == null or not _offer_enabled(offer, buying):
		result.error = "This shop does not sell that material." if buying else "This shop does not buy that material."
		return result
	var price: int = offer.get_int("buy_price" if buying else "sell_price")
	if price > MAX_AMOUNT or gold < 0 or gold > MAX_AMOUNT or owned < 0 or owned > MAX_AMOUNT:
		result.error = "This trade exceeds the supported inventory or gold limit."
		return result
	result.unit_price = price
	# Division bounds the multiplication before it happens, including hostile direct calls.
	@warning_ignore("integer_division")
	var affordable: int = gold / price if buying else (MAX_AMOUNT - gold) / price
	result.max_quantity = mini(MAX_AMOUNT - owned if buying else owned, affordable)
	if quantity < 1 or quantity > MAX_AMOUNT:
		result.error = "Enter a whole quantity of at least one within the inventory limit."
		return result
	@warning_ignore("integer_division")
	var multiplication_limit: int = MAX_AMOUNT / price
	if quantity <= multiplication_limit: result.total = quantity * price
	if quantity > int(result.max_quantity):
		result.error = "Not enough gold or inventory room for this purchase." if buying else "Not enough owned material or gold capacity for this sale."
		return result
	result.total = quantity * price
	result.resulting_owned = owned + quantity if buying else owned - quantity
	result.resulting_gold = gold - int(result.total) if buying else gold + int(result.total)
	result.ok = true
	result.error = ""
	return result

func max_buy_quantity() -> int:
	return int(trade_quote(1, true).max_quantity)

func max_sell_quantity() -> int:
	return int(trade_quote(1, false).max_quantity)

func can_buy() -> bool:
	return bool(trade_quote(1, true).ok)

func can_sell() -> bool:
	return bool(trade_quote(1, false).ok)

func _trade_quantity(quantity: int, buying: bool, material_id: String, shop_id: String, expected_unit_price: int) -> bool:
	var quote: Dictionary = trade_quote(quantity, buying, material_id, shop_id)
	if not quote.ok: return fail(str(quote.error))
	if expected_unit_price >= 0 and expected_unit_price != int(quote.unit_price): return fail("The price changed. Review the updated quote before trading.")
	# One validated mutation, never a loop of partially successful single trades.
	_add_material(database.by_id("materials", str(quote.material_id)), quantity if buying else -quantity)
	gold = int(quote.resulting_gold)
	actions += 1
	log_event("SHOP  %s %d %s for %d gold" % ["bought" if buying else "sold", quantity, title("materials", "Material"), int(quote.total)])
	return true

func buy_quantity(quantity: int, material_id: String = "", shop_id: String = "", expected_unit_price: int = -1) -> bool:
	return _trade_quantity(quantity, true, material_id, shop_id, expected_unit_price)

func sell_quantity(quantity: int, material_id: String = "", shop_id: String = "", expected_unit_price: int = -1) -> bool:
	return _trade_quantity(quantity, false, material_id, shop_id, expected_unit_price)

func buy() -> bool:
	return buy_quantity(1)

func sell() -> bool:
	return sell_quantity(1)

func _quest_route_source(quest) -> String:
	var source: String = _quest_ref_id(quest, "region_ref")
	if not source.is_empty(): return source
	var requester = quest.get_reference("requester")
	return _quest_ref_id(requester, "region") if requester != null else ""

func grand_route_target_region_id() -> String:
	# Empty means no field destination is needed: return/report at base, or an
	# authored requirement lacks a location. Never manufacture a destination.
	if grand_objective_completed: return ""
	var quest_id: String = str(selected_objective().get("quest_id", ""))
	if quest_id.is_empty(): return super.grand_route_target_region_id()
	return quest_route_target_region_id(quest_id)

func quest_route_target_region_id(quest_id: String) -> String:
	# Read-only navigation for a tracked request, including a currently locked
	# request. UI disclosure remains separate; this never accepts or unlocks it.
	if database.by_id("quests", quest_id) == null: return ""
	return str(_quest_route_step(quest_id, {}).region_id)

func _supply_route_region(material_id: String, quantity: int, allow_purchase: bool) -> String:
	# Gathering events cannot be replaced by purchases. Deliveries and recipe
	# inputs can use a known merchant from any base, without another journey.
	if allow_purchase:
		for shop_id in _shop_offers:
			var offer = offer_for_material(material_id, str(shop_id))
			if _offer_enabled(offer, true) and quantity <= gold / offer.get_int("buy_price"):
				return ""
	var graph: Dictionary = progression_policy.get("region_graph", {})
	var start: String = region_id if not region_id.is_empty() else str(graph.get("start_region_id", ""))
	var adjacency: Dictionary = {}
	for edge in graph.get("edges", []):
		for pair in [[edge[0], edge[1]], [edge[1], edge[0]]]:
			if not adjacency.has(pair[0]): adjacency[pair[0]] = []
			adjacency[pair[0]].append(pair[1])
	var distances: Dictionary = {start: 0}
	var pending: Array = [start]
	while not pending.is_empty():
		var current: String = str(pending.pop_front())
		for neighbor in adjacency.get(current, []):
			if not distances.has(neighbor):
				distances[neighbor] = int(distances[current]) + 1
				pending.append(neighbor)
	var chosen: String = ""
	var best: int = 2147483647
	for source in acquisition_regions(material_id):
		if not distances.has(source.id()): continue
		# Prefer a route already open to the player, then the nearest supply.
		var score: int = int(distances[source.id()]) + (0 if not destination_route(source.id()).is_empty() else 1000000)
		if score < best or (score == best and source.id() < chosen):
			chosen = source.id()
			best = score
	return chosen

func _equipment_supply_region(equipment_id: String) -> String:
	var recipes = database.table("recipes")
	if recipes == null: return ""
	var selected: String = ""
	var shortest: int = 2147483647
	for recipe_id in recipes.ids():
		var recipe = recipes.by_id(recipe_id)
		if _quest_ref_id(recipe, "equipment") != equipment_id or not recipe_available(recipe_id): continue
		var quality: String = _standard_quality(recipe_id)
		if not _existing_variant(equipment_id, quality).is_empty(): continue
		var quote: Dictionary = recipe_quote(recipe_id, quality)
		var missing_region: String = ""
		for material_id in quote.get("inputs", {}):
			var missing: int = int(quote.inputs[material_id]) - inventory_count(database.by_id("materials", material_id))
			if missing > 0:
				var source: String = _supply_route_region(str(material_id), missing, true)
				if not source.is_empty():
					missing_region = source
					break
		# All inputs are owned or purchasable at base: forge/job preparation is
		# the next action, not a trip to the equipment's catalog region.
		if missing_region.is_empty(): return ""
		var distance: int = planned_route(missing_region).size()
		if distance < shortest:
			selected = missing_region
			shortest = distance
	return selected

func _quest_route_step(quest_id: String, seen: Dictionary) -> Dictionary:
	var no_step: Dictionary = {"pending": false, "region_id": ""}
	if claimed_quests.has(quest_id): return no_step
	if seen.has(quest_id): return {"pending": true, "region_id": ""}
	seen[quest_id] = true
	var quest = database.by_id("quests", quest_id)
	if quest == null: return {"pending": true, "region_id": ""}
	var source_id: String = _quest_route_source(quest)
	if not source_id.is_empty() and not is_region_visited(source_id):
		return {"pending": true, "region_id": source_id}
	var rule: Dictionary = progression_policy.get("rules", {}).get("quests", {}).get(quest_id, {})
	for prerequisite in rule.get("claimed_quests", []):
		if not claimed_quests.has(prerequisite):
			var step: Dictionary = _quest_route_step(str(prerequisite), seen)
			if bool(step.pending): return step
	# Finishing a prerequisite elsewhere can unlock a request at an already
	# visited settlement or field. Acceptance still requires its requester;
	# completed conditions alone do not make it reportable remotely.
	if not quest_is_accepted(quest_id) and not source_id.is_empty():
		return {"pending": true, "region_id": source_id}
	for condition in quest_condition_summaries(quest_id):
		if bool(condition.ready): continue
		var target_region_id: String = str(condition.target_region_id)
		if target_region_id.is_empty() and not str(condition.target_enemy_id).is_empty():
			target_region_id = row_region_id(database.by_id("enemies", str(condition.target_enemy_id)))
		if target_region_id.is_empty() and not str(condition.target_material_id).is_empty():
			target_region_id = _supply_route_region(str(condition.target_material_id), maxi(1, int(condition.target) - int(condition.current)), str(condition.kind) == "deliver")
		if target_region_id.is_empty() and not str(condition.target_equipment_id).is_empty():
			target_region_id = _equipment_supply_region(str(condition.target_equipment_id))
		# An untargeted victory request is performed at its offered source.
		if target_region_id.is_empty() and str(condition.kind) == "kill": target_region_id = source_id
		if not target_region_id.is_empty() and database.by_id("regions", target_region_id) == null: target_region_id = ""
		return {"pending": true, "region_id": target_region_id}
	# All conditions met but not claimed: reporting is the next action.
	return {"pending": true, "region_id": ""}

func _remaining_craft_variants(definition_id: String) -> int:
	# Potential future variants ignore temporary resource/unlock shortages.
	# This count is a diagnostic, never permission to craft or claim.
	var variants: Dictionary = {}
	var recipes = database.table("recipes")
	if recipes == null: return 0
	for index in range(recipes.count()):
		var recipe = recipes.at(index)
		if recipe.get_string("kind") == "refine": continue
		var equipment = recipe.get_reference("equipment")
		if equipment == null or equipment.id() != definition_id: continue
		if recipe.get_string("quality_group_key").is_empty():
			variants[""] = true
		else:
			for quality in quality_choices(recipe.id()): variants[quality.id()] = true
	for item in equipment_instances.values():
		if str(item.definition_id) == definition_id: variants.erase(str(item.quality_material_id))
	return variants.size()

func strict_craft_condition_reason(condition_id: String) -> String:
	var condition = database.by_id("quest_conditions", condition_id)
	if condition == null or condition.get_string("kind") != "craft": return ""
	var required: int = condition.get_int("count")
	var credited: int = int(_condition_progress.get(condition_id, 0))
	if credited >= required: return ""
	var remaining: int = _remaining_craft_variants(_quest_ref_id(condition, "target_equipment"))
	if required - credited <= remaining: return ""
	return "This request cannot be completed in this game: %d new crafts are needed, but only %d uncrafted variants remain. Already owned equipment is not new crafting progress." % [required - credited, remaining]
