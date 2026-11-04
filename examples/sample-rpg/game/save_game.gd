extends RefCounted
## One manual local slot. Immutable generations avoid replacing a good file on
## platforms where rename-over-existing is not an atomic replacement.
const Model = preload("res://rpg_model.gd")
const VERSION = 7
const MAX_BYTES = 8 * 1024 * 1024
const FIELDS = [
	"selected_ids", "material_inventory", "owned_equipment", "equipped_id", "claimed_quests", "wins_by_region",
	"gold", "ore", "hp", "wins", "actions", "logs", "last_damage",
	"_visited_region_ids", "_discovered_region_ids", "activity", "selected_purpose_id", "_eligible_quest_progress",
	"grand_objective_defeated", "grand_objective_completed", "_pending_grand_victory",
	"region_id", "region_key", "region_name", "expedition_purpose", "return_summary", "last_victory", "last_gather",
	"discovery_visit_wins", "_paid_town_entry_ids", "_gather_remaining", "exploration_depth", "gathering_stage_name", "gathering_draw_count", "_gather_victory_receipt",
	"_gather_turn_created", "_gather_probabilities", "last_exchange", "_start_gold", "_start_wins", "_start_materials",
	"_start_craftable", "_last_enemy_by_region", "_last_material_by_region", "equipment_instances",
	"selected_instance_id", "equipped_instance_id", "selected_quality_id", "job_mastery", "defeated_by_job",
	"_mastery_events", "_instance_sequence", "last_craft", "gathered_materials", "_activity_quest_progress",
	"_condition_progress", "last_quest_claim", "accepted_quest_ids",
	"rest_count", "current_rest_fee", "unlocked_job_ids"
]
var directory: String = "user://progress"

func _failure(reason: String, kind: String = "incompatible") -> Dictionary:
	return {"ok": false, "error": reason, "kind": kind}

func can_save(model) -> bool:
	return model.database.is_loaded() and model.activity in [model.PURPOSE, model.BASE, model.EXPLORE, model.VICTORY, model.RETURN] and model.enemy.is_empty()

func _entries() -> PackedStringArray:
	var result := PackedStringArray()
	var dir = DirAccess.open(directory)
	if dir == null: return result
	for file in dir.get_files():
		if not file.ends_with(".bin"): continue
		var parts: PackedStringArray = file.trim_suffix(".bin").split("-")
		if parts.size() != 3 or parts[0] != "save" or parts[1].length() != 20 or not parts[1].is_valid_int() or parts[2].length() != 32: continue
		var valid: bool = true
		for character in parts[2]:
			if character not in "0123456789abcdef": valid = false
		if valid: result.append(file)
	result.sort()
	return result

func has_save() -> bool:
	return not _entries().is_empty()

# Preview only: reading a checkpoint never restores state, advances RNG, or writes.
# Loading still performs the full compatibility and progression validation below.
func checkpoint_info() -> Dictionary:
	var entries: PackedStringArray = _entries()
	if entries.is_empty(): return _failure("No saved game on this device.", "missing")
	var path: String = directory.path_join(entries[-1])
	var read: Dictionary = _read(path)
	if not read.ok: return read
	return _checkpoint_summary(read.payload, path)

func _checkpoint_summary(payload: Dictionary, path: String) -> Dictionary:
	var state = payload.get("state")
	if not state is Dictionary: return _failure("The saved checkpoint has no valid summary.", "corrupt")
	for field in ["hp", "gold"]:
		if not state.get(field) is int or int(state[field]) < 0:
			return _failure("The saved checkpoint has an invalid " + field + ".", "corrupt")
	if not state.get("region_name") is String or not state.get("activity") is String:
		return _failure("The saved checkpoint has an invalid location.", "corrupt")
	var maximum: int = int(payload.get("max_hp", state.hp)) if payload.get("max_hp", state.hp) is int else int(state.hp)
	var saved_at: int = int(payload.get("saved_at", 0)) if payload.get("saved_at", 0) is int else 0
	if saved_at <= 0: saved_at = int(FileAccess.get_modified_time(path))
	var location: String = str(state.region_name)
	if location.is_empty(): location = "Choose a goal" if state.activity == "purpose" else "Base"
	return {"ok": true, "error": "", "path": path, "location": location,
		"activity": state.activity, "hp": state.hp, "max_hp": maximum, "gold": state.gold, "saved_at": saved_at}

func snapshot(model, tracked: String) -> Dictionary:
	var state: Dictionary = {}
	for field in FIELDS: state[field] = model.get(field)
	var offers: Array = []
	for offer in model.progression_policy.grand_objectives: offers.append(str(offer.id))
	return {"version": VERSION, "saved_at": int(Time.get_unix_time_from_system()), "catalog": model.database.manifest().get("content_hash", ""),
		"state": state.duplicate(true), "offers": offers, "gather_rng": model._gather_rng.state,
		"offer_rng": model._grand_offer_rng.state, "discovery_rng": model._discovery_rng.state, "tracked": tracked,
		"compatibility": _compatibility(model, state, offers, tracked), "max_hp": model.max_hp()}

# Compare structure and the meaning of earned quest progress, not names, prices,
# damage values, reward amounts, or numeric condition thresholds.
func _compatibility(model, state: Dictionary, offers: Array, tracked: String) -> Dictionary:
	var schemas: Dictionary = {}
	for name in model.database.tables():
		var table = model.database.table(name)
		var columns: Dictionary = {}
		for column in table.columns(): columns[column] = table.column_info(column).get("data_type")
		schemas[name] = {"uuid": table.uuid(), "columns": columns}
	var relevant: Dictionary = {}
	for field in ["accepted_quest_ids","claimed_quests","_eligible_quest_progress","_activity_quest_progress"]:
		for id in state[field]: relevant[id] = true
	if not tracked.is_empty(): relevant[tracked] = true
	for id in state._condition_progress:
		var signature: Array = model._condition_signatures.get(id,[])
		if not signature.is_empty(): relevant[signature[0]] = true
	var goals: Dictionary = {}
	for id in offers:
		for goal in model.progression_policy.grand_candidates:
			if goal.id != id: continue
			var quest_id: String = str(goal.get("quest_id",""))
			goals[id] = [quest_id,str(goal.region_id),str(goal.enemy_id) if quest_id.is_empty() else ""]
			if not quest_id.is_empty(): relevant[quest_id] = true
	var quests: Dictionary = {}
	for id in relevant:
		var quest = model.database.by_id("quests",id)
		if quest == null: continue
		var conditions: Dictionary = {}
		for condition_id in model._conditions_by_quest.get(id,[]):
			conditions[condition_id] = model._condition_signatures.get(condition_id,[]).duplicate()
		quests[id] = {"conditions": conditions, "legacy": [quest.get_string("objective_kind"),
			model._quest_ref_id(quest,"target_enemy"),model._quest_ref_id(quest,"target_material"),
			model._quest_ref_id(quest,"target_equipment"),model.quest_region_id(quest)]}
	return {"schemas": schemas, "quests": quests, "goals": goals, "default_material": model.core_rows.materials.id()}

func _compatibility_error(saved, current: Dictionary) -> String:
	if not saved is Dictionary or saved.keys().size() != 4: return "Missing save compatibility information."
	for field in ["schemas","quests","goals"]:
		if not saved.get(field) is Dictionary: return "Invalid save compatibility information."
	if saved.get("default_material") != current.default_material: return "The default inventory material identity changed."
	for name in saved.schemas:
		var before = saved.schemas[name]
		var after = current.schemas.get(name,{})
		if not before is Dictionary or not before.get("columns") is Dictionary or before.get("uuid") != after.get("uuid"): return "A saved table identity changed: " + str(name)
		for column in before.columns:
			if before.columns[column] != after.get("columns",{}).get(column): return "A saved column was removed or changed type: " + str(name) + "." + str(column)
	if saved.quests != current.quests: return "A saved quest's condition set, kind, target, or region changed. Progress was not reinterpreted."
	if saved.goals != current.goals: return "A saved grand quest's target or region changed."
	return ""

func _plain(value, depth: int = 0) -> bool:
	if depth > 24: return false
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING: return true
		TYPE_FLOAT: return is_finite(value)
		TYPE_ARRAY:
			for item in value:
				if not _plain(item, depth + 1): return false
			return true
		TYPE_DICTIONARY:
			for key in value:
				if (not key is String and not key is StringName) or not _plain(value[key], depth + 1): return false
			return true
	return false

func _id_map(model, state: Dictionary, field: String, table: String, flags: bool = false) -> bool:
	for id in state[field]:
		var value = state[field][id]
		if model.database.by_id(table, id) == null: return false
		if flags:
			if not value is bool or not value: return false
		elif not value is int or value < 0: return false
	return true

func _legacy_unlocked_jobs(model, state: Dictionary) -> Dictionary:
	var unlocked: Dictionary = {}
	if not state.get("selected_ids") is Dictionary: return unlocked
	var id: String = str(state.selected_ids.get("jobs", ""))
	while not id.is_empty() and not unlocked.has(id):
		var job = model.database.by_id("jobs", id)
		if job == null: break
		unlocked[id] = true
		var parent = job.get_reference("parent_job")
		id = parent.id() if parent != null else ""
	return unlocked

func restore(payload, data_path: String, source = null) -> Dictionary:
	if not payload is Dictionary or not _plain(payload): return _failure("The save contains invalid data.","corrupt")
	if not payload.get("version") is int: return _failure("The save version is missing or malformed.","corrupt")
	if payload.version not in [1,2,3,4,5,6,VERSION]: return _failure("This save version is not supported. The saved file will not be replaced.","unsupported")
	for key in ["state", "catalog", "offers", "gather_rng", "offer_rng", "tracked"]:
		if not payload.has(key): return _failure("The save is incomplete.","corrupt")
	if not payload.state is Dictionary or not payload.offers is Array or not payload.catalog is String or not payload.tracked is String or not payload.gather_rng is int or not payload.offer_rng is int:
		return _failure("The save has invalid field types.","corrupt")
	if payload.version >= 5 and not payload.get("discovery_rng") is int:
		return _failure("The discovery random state is missing or malformed.", "corrupt")
	var model = Model.new()
	if source != null and source.database.is_loaded():
		# Data and derived indexes are immutable during this synchronous operation.
		# Copy containers, retaining canonical row objects; never copy play state here.
		for field in ["database", "core_rows", "rows", "generation", "total_rows", "main_path", "_main_source", "_main_digest", "_canonical_policy_owned", "_policy_checked_generation", "_policy_cached_error", "_progression_policy", "_quality_groups", "_shop_offers", "_conditions_by_quest", "_condition_events", "_condition_signatures", "_quests_by_source_region"]:
			var value = source.get(field)
			model.set(field,value.duplicate(true) if value is Dictionary else value)
		model.selected_ids = source.selected_ids.duplicate()
	else:
		var loaded: Dictionary = model.load_main(data_path)
		if not loaded.ok: return _failure(str(loaded.error))
	var changed_catalog: bool = payload.catalog != model.database.manifest().get("content_hash", "")
	if payload.version == 1 and changed_catalog:
		return _failure("This legacy save lacks quest compatibility information. Load it with its original data and Save once to upgrade before changing data.")
	var state: Dictionary = payload.state.duplicate(true)
	if payload.version < 7:
		if state.has("discovery_visit_wins"): return _failure("Unexpected discovery battle count in an older save.", "corrupt")
		state.discovery_visit_wins = 0
	var legacy_entry_fees: bool = payload.version < 6
	if legacy_entry_fees:
		if state.has("_paid_town_entry_ids"): return _failure("Unexpected town fee state in an older save.", "corrupt")
		state._paid_town_entry_ids = {}
		if state.get("_visited_region_ids") is Dictionary:
			for id in state._visited_region_ids:
				if model.is_settlement_region(str(id)): state._paid_town_entry_ids[id] = true
	var legacy_discovery: bool = payload.version < 5
	if legacy_discovery:
		if state.has("_discovered_region_ids"): return _failure("Unexpected discovery state in a legacy save.", "corrupt")
		state._discovered_region_ids = {}
	var legacy_economy: bool = payload.version < 3
	if legacy_economy:
		# Old checkpoints never recorded payments. Preserve the selected profession
		# and its ancestors, without retroactively charging or inventing past rests.
		if state.size() != FIELDS.size() - 3: return _failure("The legacy save state is incomplete.", "corrupt")
		for field in ["rest_count", "paid_rest_count", "current_rest_fee", "unlocked_job_ids"]:
			if state.has(field): return _failure("Unexpected economy fields in a legacy save.", "corrupt")
		state.rest_count = 0
		state.current_rest_fee = maxi(0, model.value("balance", "cost", 3))
		state.unlocked_job_ids = _legacy_unlocked_jobs(model, state)
	if payload.version == 3:
		if not state.has("paid_rest_count") or state.has("rest_count"):
			return _failure("The legacy rest count is missing or ambiguous.", "corrupt")
		# Preserve recorded stays and the exact quoted fee; old free stays were not recorded.
		state.rest_count = state.paid_rest_count
		state.erase("paid_rest_count")
	if state.size() != FIELDS.size(): return _failure("The save state is incomplete.","corrupt")
	for field in FIELDS:
		if not state.has(field) or typeof(state[field]) != typeof(model.get(field)): return _failure("Invalid saved field: " + field,"corrupt")
		if state[field] is int and state[field] < 0: return _failure("Invalid negative progress: " + field,"corrupt")
	for line in state.logs:
		if not line is String: return _failure("Invalid saved log.")
	var mapping = {"material_inventory":"materials", "wins_by_region":"regions", "_eligible_quest_progress":"quests", "_gather_remaining":"materials", "_start_materials":"materials", "job_mastery":"jobs", "gathered_materials":"materials", "_activity_quest_progress":"quests", "_condition_progress":"quest_conditions"}
	for field in mapping:
		if not _id_map(model,state,field,mapping[field]): return _failure("Invalid saved progress references: " + field)
	var flags = {"_paid_town_entry_ids":"regions", "owned_equipment":"equipment", "claimed_quests":"quests", "_visited_region_ids":"regions", "_discovered_region_ids":"regions", "_start_craftable":"recipes", "accepted_quest_ids":"quests", "unlocked_job_ids":"jobs"}
	for field in flags:
		if not _id_map(model,state,field,flags[field],true): return _failure("Invalid saved references: " + field)
	if state.selected_ids.keys().size() != model.selected_ids.keys().size(): return _failure("Incomplete saved selections.")
	for table in state.selected_ids:
		if not model.selected_ids.has(table) or not state.selected_ids[table] is String or model.database.by_id(table,state.selected_ids[table]) == null: return _failure("A saved selection is missing from game data.")
	for field in ["_last_enemy_by_region", "_last_material_by_region"]:
		for region in state[field]:
			if model.database.by_id("regions",region) == null or not state[field][region] is String or model.database.by_id("enemies" if field == "_last_enemy_by_region" else "materials",state[field][region]) == null: return _failure("Invalid saved encounter rotation.")
	for job in state.defeated_by_job:
		if model.database.by_id("jobs",job) == null or not state.defeated_by_job[job] is Dictionary: return _failure("Invalid saved mastery.")
		for foe in state.defeated_by_job[job]:
			if model.database.by_id("enemies",foe) == null or state.defeated_by_job[job][foe] != true: return _failure("Invalid saved mastery target.")
	for event in state._mastery_events:
		if state._mastery_events[event] != true or model.database.by_id("jobs",event.get_slice(":",0)) == null: return _failure("Invalid mastery receipt.")
	if payload.version >= 2:
		var problem: String = _compatibility_error(payload.get("compatibility"),_compatibility(model,state,payload.offers,payload.tracked))
		if not problem.is_empty(): return _failure(problem)
		if not payload.get("max_hp") is int or payload.max_hp < 1 or state.hp > payload.max_hp: return _failure("Invalid saved HP baseline.","corrupt")
	var offer_ids: Dictionary = {}
	var offers: Array = []
	for id in payload.offers:
		if not id is String or offer_ids.has(id): return _failure("Invalid saved grand quests.")
		offer_ids[id] = true
		for candidate in model.progression_policy.grand_candidates:
			if candidate.id == id: offers.append(candidate)
	if offers.size() != 3 or offer_ids.size() != 3: return _failure("A saved grand quest no longer exists.")
	var policy: Dictionary = model.progression_policy.duplicate(true)
	policy.grand_objectives = offers
	model._freeze_policy(policy)
	model._progression_policy = policy
	for field in FIELDS:
		if field == "logs": model.logs.assign(state.logs)
		else: model.set(field, state[field].duplicate(true) if state[field] is Dictionary or state[field] is Array else state[field])
	model._grand_offer_rng.state = payload.offer_rng
	model._gather_rng.state = payload.gather_rng
	# Old checkpoints receive a stable independent stream without consuming a roll.
	model._discovery_rng.state = payload.discovery_rng if not legacy_discovery else (payload.gather_rng ^ 0x4d41505f464f47)
	if legacy_discovery: model.seed_discovered_regions_from_progress()
	for id in model._visited_region_ids:
		if not model._discovered_region_ids.has(id): return _failure("A visited region is absent from discovered regions.", "corrupt")
	if not model.region_id.is_empty() and not model._discovered_region_ids.has(model.region_id):
		return _failure("The current region has not been discovered.", "corrupt")
	if not legacy_discovery:
		# Restore deterministic knowledge even when an older checkpoint omitted
		# visited-town neighbors. This repairs derived flags, not earned visits,
		# and does not consume RNG or reveal neighbors of an unvisited town.
		model.seed_discovered_regions_from_progress()
	model._grand_offer_drawn = true
	model._pending_offer_rng_state = payload.offer_rng
	# Resolve validated selections without the hot-reload equipment repair path.
	model.rows = model.core_rows.duplicate()
	for table in model.selected_ids: model.rows[table] = model.database.by_id(table,model.selected_ids[table])
	model._sync_equipment_flags()
	if not can_save(model): return _failure("The save is not a completed action checkpoint.")
	if model.activity == model.PURPOSE:
		if not model.selected_purpose_id.is_empty(): return _failure("Invalid grand quest selection.")
	elif not offer_ids.has(model.selected_purpose_id) or not model.progression_ready(): return _failure("Invalid saved grand quest.")
	if not model.region_id.is_empty():
		var region = model.database.by_id("regions",model.region_id)
		if region == null or not model.is_region_visited(model.region_id) or not model.content_available("regions",model.region_id): return _failure("The saved region is unavailable.")
		model.region_key = region.get_string("key")
		model.region_name = model.row_name(region)
	elif model.activity in [model.EXPLORE,model.VICTORY,model.RETURN]: return _failure("The saved expedition has no region.")
	var owned_definitions: Dictionary = {}
	var variants: Dictionary = {}
	for id in model.equipment_instances:
		var item = model.equipment_instances[id]
		if not item is Dictionary or item.keys().size() != 4 or item.get("id") != id or not item.get("definition_id") is String or not item.get("quality_material_id") is String or not item.get("quality_multiplier_permille") is int: return _failure("Invalid saved equipment instance.")
		if not id.begins_with("equipment-instance-") or not id.trim_prefix("equipment-instance-").is_valid_int() or id.trim_prefix("equipment-instance-").to_int() > model._instance_sequence: return _failure("Invalid equipment instance identity.")
		if model.database.by_id("equipment",item.definition_id) == null or not model.owned_equipment.has(item.definition_id): return _failure("A saved equipment definition is missing.")
		var variant: String = item.definition_id + ":" + item.quality_material_id
		if variants.has(variant): return _failure("Duplicate saved equipment variant.")
		variants[variant] = true
		owned_definitions[item.definition_id] = true
		var quality = model.database.by_id("materials",item.quality_material_id) if not item.quality_material_id.is_empty() else null
		if not item.quality_material_id.is_empty() and quality == null: return _failure("A saved quality material is missing.")
		var current_multiplier: int = maxi(1,quality.get_int("quality_multiplier_permille",1000)) if quality != null else 1000
		if item.quality_multiplier_permille < 1 or (not changed_catalog and item.quality_multiplier_permille != current_multiplier): return _failure("Invalid saved equipment quality.")
		item.quality_multiplier_permille = current_multiplier
	if owned_definitions != model.owned_equipment: return _failure("Saved ownership does not match equipment instances.")
	for id in model.claimed_quests:
		if not model.accepted_quest_ids.has(id): return _failure("A completed quest has no acceptance record.")
	for field in ["selected_instance_id", "equipped_instance_id"]:
		if not model.get(field).is_empty() and not model.equipment_instances.has(model.get(field)): return _failure("A saved equipment instance is missing.")
	if not model.selected_quality_id.is_empty() and model.database.by_id("materials",model.selected_quality_id) == null: return _failure("A saved quality selection is missing.")
	if model.equipped_id != (str(model.equipment_instances[model.equipped_instance_id].definition_id) if not model.equipped_instance_id.is_empty() else ""): return _failure("Saved equipment does not match its instance.")
	var equipment_notice: String = ""
	if not model.loadout_job_available(): return _failure("The saved job is no longer available. Your current game and save have not been changed.")
	if not model.equipped_instance_id.is_empty() and not model.instance_requirement_reason(model.equipped_instance_id).is_empty():
		if not changed_catalog and not legacy_economy:
			return _failure("Current equipment requirements are not met. Your equipment and save have not been changed.")
		model.equipped_instance_id = ""
		model.equipped_id = ""
		model._sync_equipment_flags()
		equipment_notice = " Your previous equipment no longer meets its requirements. It was unequipped and kept in your inventory."
	if not model.loadout_available(): return _failure("Current job or equipment requirements are not met. Your equipment and save have not been changed.")
	if not changed_catalog and model.hp > model.max_hp(): return _failure("Invalid saved HP.","corrupt")
	# Never heal on load; a lower current maximum clamps HP, with an explicit notice.
	var hp_clamped: bool = model.hp > model.max_hp()
	model.hp = mini(model.hp,model.max_hp())
	var probability_ids: Dictionary = {}
	for entry in model._gather_probabilities:
		if not entry is Dictionary or not entry.get("id") is String or model.database.by_id("materials",entry.id) == null or probability_ids.has(entry.id): return _failure("Invalid saved gathering probabilities.")
		if not entry.get("percent") is float and not entry.get("percent") is int: return _failure("Invalid gathering chance.")
		probability_ids[entry.id] = true
	var eligible_materials: Dictionary = {}
	for material in model.regional_materials(): eligible_materials[material.id()] = true
	var remaining_draws: int = 0
	for id in model._gather_remaining:
		if model._gather_remaining[id] > 0:
			remaining_draws += 1
			if not eligible_materials.has(id): return _failure("A frozen gathering material is no longer available in this region. The checkpoint was not rerolled.")
		if not probability_ids.has(id): return _failure("Invalid saved gathering pool.")
	for entry in model._gather_probabilities:
		if not entry.get("name") is String or not entry.get("quantity") is int or entry.quantity < 0 or typeof(entry.get("weight")) not in [TYPE_INT,TYPE_FLOAT] or entry.weight < 0 or entry.percent < -1 or entry.percent > 100 or not entry.get("probability_estimated") is bool or not entry.get("probability_unavailable") is bool: return _failure("Invalid saved gathering entry.")
		if int(model._gather_remaining.get(entry.id,0)) > entry.quantity: return _failure("Invalid saved gathering quantity.")
	if remaining_draws > model.gathering_draw_count: return _failure("Invalid gathering draw count.")
	if model.gathering_draw_count > 100 or model._gather_victory_receipt > int(model.wins_by_region.get(model.region_id,0)): return _failure("Invalid gathering checkpoint receipt.")
	if model.activity == model.EXPLORE and (not model._gather_turn_created or model.hp <= 0): return _failure("Invalid exploration checkpoint.")
	if model.activity == model.RETURN:
		var report: Dictionary = model.return_summary
		for field in ["reason","region_id","region_key","region_name","purpose","grand_objective_id"]:
			if not report.get(field) is String: return _failure("Invalid return report.")
		for field in ["gold","wins"]:
			if not report.get(field) is int: return _failure("Invalid return report amount.")
		for field in ["materials","ready_quest_ids","newly_craftable_ids"]:
			if not report.get(field) is Array: return _failure("Invalid return report list.")
		for id in report.ready_quest_ids:
			if not id is String or model.database.by_id("quests",id) == null: return _failure("Invalid return report quest.")
		for id in report.newly_craftable_ids:
			if not id is String or model.database.by_id("recipes",id) == null: return _failure("Invalid return report recipe.")
		for item in report.materials:
			if not item is Dictionary or not item.get("id") is String or model.database.by_id("materials",item.id) == null or not item.get("name") is String or not item.get("amount") is int: return _failure("Invalid return report material.")
	if not payload.tracked.is_empty() and model.database.by_id("quests",payload.tracked) == null: return _failure("The tracked quest is missing.")
	for id in model._paid_town_entry_ids:
		if not model.is_settlement_region(str(id)) or not model.is_region_visited(str(id)): return _failure("Invalid paid town entry history.", "corrupt")
	var initialized_town_pool: bool = model.ensure_town_gathering_stop()
	var notice: String = ""
	if changed_catalog: notice = "Loaded with current names, stats, prices and requirements. Earned progress and the frozen gathering checkpoint were retained."
	if hp_clamped: notice += " HP was capped at the current maximum (%d)." % model.max_hp()
	if payload.version == 1: notice = "Legacy save loaded. Press Save to upgrade it before changing game data."
	if legacy_discovery: notice += " Known places were retained; further routes are discovered through exploration."
	if legacy_economy: notice += " Existing job access was retained; rest pricing starts at the current initial fee."
	if legacy_entry_fees: notice += " Previously visited towns retain free re-entry."
	if initialized_town_pool: notice += " This town now has one local gathering pool."
	notice += equipment_notice
	return {"ok": true, "model": model, "tracked": payload.tracked, "notice": notice}

func _read(path: String) -> Dictionary:
	var file = FileAccess.open(path,FileAccess.READ)
	if file == null: return _failure("Cannot read the saved game: " + error_string(FileAccess.get_open_error()),"io")
	var length: int = file.get_length()
	if length < 65 or length > MAX_BYTES: return _failure("The save file has an invalid size.","corrupt")
	var checksum: String = file.get_buffer(64).get_string_from_ascii()
	var bytes: PackedByteArray = file.get_buffer(length-64)
	var error: int = file.get_error()
	file.close()
	if error != OK: return _failure("Cannot finish reading the saved game: " + error_string(error),"io")
	if bytes.hex_encode().sha256_text() != checksum: return _failure("The save file is damaged. It was not loaded.","corrupt")
	var payload = bytes_to_var(bytes) # Never decode objects or scripts.
	if not payload is Dictionary: return _failure("The save file is malformed.","corrupt")
	return {"ok": true, "payload": payload}

# Only damage permits fallback. Unsupported versions, I/O failures, or a real
# structural incompatibility remain errors rather than silently rolling back.
func _candidate(data_path: String, source = null) -> Dictionary:
	var entries = _entries()
	if entries.is_empty(): return _failure("No saved game was found.","missing")
	var damaged: bool = false
	for index in range(entries.size()-1,maxi(-1,entries.size()-3),-1):
		var path: String = directory.path_join(entries[index])
		var read: Dictionary = _read(path)
		var result: Dictionary = restore(read.payload,data_path,source) if read.ok else read
		if result.ok:
			result.path = path
			result.recovered = damaged
			result.summary = _checkpoint_summary(read.payload, path)
			return result
		if result.get("kind") != "corrupt":
			result.path = path
			return result
		damaged = true
	return _failure("The available save generations are damaged. Current progress was not changed.","corrupt")

func load_game(data_path: String, source = null) -> Dictionary:
	return _candidate(data_path,source if source != null and FileAccess.get_sha256(data_path) == source._main_digest else null)

func save_game(model, tracked: String = "") -> Dictionary:
	if not can_save(model): return _failure("Finish or retreat from the battle before saving.")
	var payload: Dictionary = snapshot(model,tracked)
	var validation: Dictionary = restore(payload,model.main_path,model)
	if not validation.ok: return validation
	var bytes: PackedByteArray = var_to_bytes(payload)
	if bytes.size()+64 > MAX_BYTES: return _failure("The saved game is too large.")
	var error: int = DirAccess.make_dir_recursive_absolute(directory)
	if error != OK: return _failure("Cannot create the save folder: " + error_string(error))
	var previous = _entries()
	var backup: String = ""
	if not previous.is_empty():
		var existing: Dictionary = _candidate(model.main_path,model)
		if existing.get("kind") in ["unsupported","io"]: return existing
		if existing.ok: backup = str(existing.path)
		elif existing.get("kind") == "incompatible": backup = str(existing.path)
	var sequence: int = 1 if previous.is_empty() else previous[-1].get_slice("-",1).to_int()+1
	if sequence <= 0: return _failure("The save sequence is exhausted. Your existing save is unchanged.")
	var name: String = "save-%020d-%s.bin" % [sequence,Crypto.new().generate_random_bytes(16).hex_encode()]
	var path: String = directory.path_join(name)
	var temporary: String = path + ".tmp"
	var file = FileAccess.open(temporary,FileAccess.WRITE)
	if file == null: return _failure("Cannot write the save: " + error_string(FileAccess.get_open_error()))
	file.store_buffer(bytes.hex_encode().sha256_text().to_ascii_buffer())
	file.store_buffer(bytes)
	file.flush()
	error = file.get_error()
	file.close()
	if error != OK:
		DirAccess.remove_absolute(temporary)
		return _failure("Saving failed. Your previous save is unchanged: " + error_string(error))
	var verified: Dictionary = _read(temporary)
	if not verified.ok:
		DirAccess.remove_absolute(temporary)
		return verified
	# Destination is unique; never rename over the existing good save.
	error = DirAccess.rename_absolute(temporary,path)
	if error != OK:
		DirAccess.remove_absolute(temporary)
		return _failure("Could not finish saving. Your previous save is unchanged: " + error_string(error))
	# Preserve the validated backup, even when the newer generation was damaged.
	for file_name in previous:
		var old_path: String = directory.path_join(file_name)
		if old_path != backup: DirAccess.remove_absolute(old_path)
	return {"ok": true, "error": "", "path": path, "summary": _checkpoint_summary(payload, path)}
