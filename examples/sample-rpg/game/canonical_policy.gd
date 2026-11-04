extends RefCounted
## Converts authored Devcel tables into the runtime policy. It neither reads
## sidecars nor infers geography, gates or objectives from display names.
const POLICY_TABLES: Array = ["access_profiles", "access_requirements", "region_connections", "grand_objectives"]
const GUARDED_TABLES: Array = ["regions", "materials", "equipment", "recipes", "enemies", "jobs", "quests"]
const CONDITION_TARGET_COLUMNS: Array = ["target_enemy", "target_material", "target_equipment", "target_region"]
const CONDITION_TARGET_TABLES: Dictionary = {"target_enemy":"enemies", "target_material":"materials", "target_equipment":"equipment", "target_region":"regions"}
const CONDITION_ALLOWED_TARGETS: Dictionary = {"kill":["target_enemy","target_region"], "craft":["target_equipment","target_region"], "gather":["target_material","target_region"], "deliver":["target_material"], "own_equipment":["target_equipment"]}

# Internal candidate handoff; never accepted from catalog data or manual config.
class PreparedRules extends RefCounted:
	var database
	var rules: Dictionary
	func _init(candidate, prepared: Dictionary):
		database = candidate
		rules = prepared
	func matches(candidate, value) -> bool:
		return is_same(database, candidate) and is_same(rules, value) and rules.is_read_only()

static func _freeze_prepared(value):
	if value is Dictionary:
		for child in value.values(): _freeze_prepared(child)
		value.make_read_only()
	elif value is Array:
		for child in value: _freeze_prepared(child)
		value.make_read_only()

var _db
var _error: String = ""
# Row wrappers are reused only within one candidate build, never across reloads.
var _row_lists: Dictionary = {}
var _reference_rows: Dictionary = {}
var _quality_groups: Dictionary = {}
var _condition_rows: Dictionary = {}
var _condition_signatures: Dictionary = {}
var _quest_regions: Dictionary = {}
var _quest_indexes_ready: bool = false

# Runtime preparation is independent of authoring lint. Both use the same raw
# database; no trusted-input flag is accepted from catalog data.
func build(db) -> Dictionary:
	return _build(db, false)

func validate_authoring(db) -> Dictionary:
	return _build(db, true)

func _build(db, check_content: bool) -> Dictionary:
	_db = db
	_row_lists.clear()
	_reference_rows.clear()
	# Returned indexes retain their containers across later builds.
	_quality_groups = {}
	_condition_rows = {}
	_condition_signatures = {}
	_quest_regions = {}
	_quest_indexes_ready = false
	_error = ""
	var quests = db.table("quests")
	var checkbox_candidates: bool = quests != null and "grand_candidate" in quests.columns()
	var policy_tables: Array = ["access_profiles", "access_requirements", "region_connections"] if checkbox_candidates else POLICY_TABLES
	var present: int = 0
	for table_name in policy_tables:
		if db.table(table_name) != null: present += 1
	if present == 0: return {"ok": true, "present": false, "policy": {}, "error": ""}
	if present != policy_tables.size(): return _failure("Canonical progression tables are incomplete.")
	var required: Dictionary = {
		"access_profiles": ["key", "name"],
		"access_requirements": ["profile", "condition_kind", "amount", "region", "quest", "equipment"],
		"region_connections": ["from_region", "to_region"],
		"grand_objectives": ["key", "name", "region", "enemy", "enabled"],
		"regions": ["key", "map_x", "map_y", "is_start", "access_profile"],
		"materials": ["source_region", "access_profile"]
	}
	if checkbox_candidates: required.erase("grand_objectives")
	for table_name in GUARDED_TABLES:
		if not required.has(table_name): required[table_name] = ["access_profile"]
	for table_name in required:
		var table = db.table(table_name)
		if table == null: return _failure("Missing progression table: " + table_name)
		for column in required[table_name]:
			if column not in table.columns(): return _failure("Missing progression column: %s.%s" % [table_name, column])
	# Candidate tables are read-only here. Each compiler owns its Row wrappers,
	# caches and diagnostic state; only this caller publishes the result.
	var quest_output: Array = [null]
	var quest_task: int = -1
	if OS.has_feature("nothreads"):
		_build_quest_contract(_db, quest_output, check_content)
	else:
		quest_task = WorkerThreadPool.add_task(_build_quest_contract.bind(_db, quest_output, check_content), false, "Compile quest contract")
	var rarity_error: String = _validate_item_rarities() if check_content else ""
	_error = ""
	var general: Dictionary = _build_general_policy(check_content)
	# Join even when general compilation failed. Preserve serial error priority.
	if quest_task >= 0: WorkerThreadPool.wait_for_task_completion(quest_task)
	if not quest_output[0] is Dictionary: return _failure("Quest contract worker did not complete.")
	var quest_error: String = quest_output[0].error
	if not quest_error.is_empty(): return _failure(quest_error)
	if not rarity_error.is_empty(): return _failure(rarity_error)
	if not general.ok: return general
	var prepared: Dictionary = quest_output[0]
	_quality_groups = prepared.quality_groups
	_condition_rows = prepared.condition_rows
	_condition_signatures = prepared.condition_signatures
	_quest_regions = prepared.quest_regions
	_quest_indexes_ready = prepared.ready
	var policy: Dictionary = general.policy
	if checkbox_candidates:
		var selected: Dictionary = _checkbox_grand_objectives()
		if not selected.ok: return _failure(selected.error)
		policy["grand_candidates"] = selected.objectives
		policy.grand_objectives = []
	else:
		for objective in _records("grand_objectives"):
			var enabled: bool = objective.get_bool("enabled")
			if not objective.last_error.is_empty(): return _failure("Invalid objective enabled value: " + objective.id())
			if not enabled: continue
			var region = _reference(objective, "region", "regions")
			var target = _reference(objective, "enemy", "enemies")
			if not _error.is_empty(): return _failure(_error)
			var definition: Dictionary = {"id": objective.id(), "name": objective.get_string("name"), "region_id": region.id(), "enemy_id": target.id()}
			if "quest" in db.table("grand_objectives").columns():
				var quest = _reference(objective, "quest", "quests", true)
				if not _error.is_empty(): return _failure(_error)
				if quest != null: definition["quest_id"] = quest.id()
			policy.grand_objectives.append(definition)
		if policy.grand_objectives.size() != 3: return _failure("Exactly three enabled grand objectives are required.")
	if check_content:
		var cycle: String = _prerequisite_cycle(policy)
		if not cycle.is_empty(): return _failure("Cyclic progression prerequisite: " + cycle)
	var indexes: Dictionary = {}
	if _quest_indexes_ready:
		indexes = {"quality_groups": _quality_groups, "condition_rows": _condition_rows,
			"condition_signatures": _condition_signatures, "quest_regions": _quest_regions}
	return {"ok": true, "present": true, "policy": policy, "indexes": indexes, "prepared_rules": PreparedRules.new(_db, policy.rules), "error": ""}

func _records(table_name: String) -> Array:
	if _row_lists.has(table_name): return _row_lists[table_name]
	var rows: Array = []
	var table = _db.table(table_name)
	if table != null:
		for index in range(table.count()): rows.append(table.at(index))
	_row_lists[table_name] = rows
	return rows

func _reference(row, column: String, target_table: String, allow_blank: bool = false):
	var raw: String = row.get_raw(column)
	if allow_blank and raw.strip_edges().is_empty(): return null
	var source: String = row.table_name()
	if not _reference_rows.has(source): _reference_rows[source] = {}
	var columns: Dictionary = _reference_rows[source]
	if not columns.has(column): columns[column] = {}
	var targets: Dictionary = columns[column]
	var target = targets.get(raw)
	if target == null: target = row.get_reference(column)
	if target == null or target.table_name() != target_table:
		_error = "Invalid reference %s.%s in record %s; expected %s." % [source, column, row.id(), target_table]
		return null
	targets[raw] = target
	return target

func _failure(message: String) -> Dictionary:
	return {"ok": false, "present": true, "policy": {}, "error": message}

func _prerequisite_cycle(policy: Dictionary) -> String:
	# These are directed prerequisite edges, not travel edges: map loops are
	# valid. This rejects explicit self/circular item/quest/region-win gates,
	# without inventing acquisition routes or claiming full balance feasibility.
	var dependencies: Dictionary = {}
	for table_name in policy.rules:
		for id in policy.rules[table_name]:
			var node: String = table_name + "/" + id
			var rule: Dictionary = policy.rules[table_name][id]
			var edges: Array = []
			for quest_id in rule.get("claimed_quests", []): edges.append("quests/" + quest_id)
			for equipment_id in rule.get("owned_equipment", []): edges.append("equipment/" + equipment_id)
			for key in rule.get("region_wins", {}):
				if int(rule.region_wins[key]) > 0: edges.append("regions/" + str(key))
			dependencies[node] = edges
	var marks: Dictionary = {}
	for node in dependencies:
		var found: String = _visit_dependency(node, dependencies, marks)
		if not found.is_empty(): return found
	return ""

func _visit_dependency(node: String, dependencies: Dictionary, marks: Dictionary) -> String:
	if int(marks.get(node, 0)) == 1: return node
	if int(marks.get(node, 0)) == 2: return ""
	marks[node] = 1
	for dependency in dependencies.get(node, []):
		var found: String = _visit_dependency(dependency, dependencies, marks)
		if not found.is_empty(): return found
	marks[node] = 2
	return ""

func _validate_item_rarities() -> String:
	var rarities = _db.table("item_rarities")
	# Catalogs authored before rarity support remain readable.
	for table_name in ["materials", "equipment"]:
		var items = _db.table(table_name)
		if items == null or "rarity_ref" not in items.columns(): continue
		if rarities == null: return "Missing item_rarities table for " + table_name
		for item in _records(table_name):
			var rarity = _reference(item, "rarity_ref", "item_rarities")
			if not _error.is_empty(): return _error
			if rarity == null: return "Missing item rarity: " + item.id()
	if rarities != null:
		for column in ["name", "color"]:
			if column not in rarities.columns(): return "Missing rarity column: " + column
		for rarity in _records("item_rarities"):
			if rarity.get_string("name").strip_edges().is_empty(): return "Empty rarity name: " + rarity.id()
			if not Color.html_is_valid(rarity.get_string("color")): return "Invalid rarity color: " + rarity.id()
	return ""

func _validate_quest_schema() -> String:
	var conditions = _db.table("quest_conditions")
	var requesters = _db.table("quest_requesters")
	# Old canonical samples may omit the complete multi-condition extension.
	# Once any extension surface exists, missing partners are malformed.
	var quests = _db.table("quests")
	var extended: bool = conditions != null or requesters != null or (quests != null and "requester" in quests.columns())
	if not extended: return ""
	var required: Dictionary = {
		"quest_conditions": ["quest", "kind", "target_enemy", "target_material", "target_equipment", "target_region", "count"],
		"quest_requesters": ["key", "name", "region", "occupation", "personality"],
		"quests": ["requester", "local_difficulty", "world_band", "challenge_score", "brief", "context", "outcome", "mastery_stage"]
	}
	for table_name in required:
		var table = _db.table(table_name)
		if table == null: return "Missing quest table: " + table_name
		for column in required[table_name]:
			if column not in table.columns(): return "Missing quest column: %s.%s" % [table_name, column]
	for requester in _records("quest_requesters"):
		_reference(requester, "region", "regions")
		if not _error.is_empty(): return _error
	for quest in _records("quests"):
		_reference(quest, "requester", "quest_requesters")
		if not _error.is_empty(): return _error
		for column in ["local_difficulty", "world_band", "challenge_score", "mastery_stage"]:
			var value: int = quest.get_int(column, -1)
			if not quest.last_error.is_empty() or value < 0: return "Invalid quest integer %s: %s" % [column, quest.id()]
			if column == "local_difficulty" and (value < 1 or value > 4): return "Quest local_difficulty must be 1..4: " + quest.id()
		var source = quest.get_reference("region_ref")
		var source_id: String = source.id() if source != null else ""
		if not _quest_regions.has(source_id): _quest_regions[source_id] = []
		_quest_regions[source_id].append(quest.id())
	var totals: Dictionary = {}
	var delivery_totals: Dictionary = {}
	var equipment_capacity: Dictionary = _equipment_variant_capacity()
	var quest_plan: Dictionary = _reference_plan("quest_conditions", "quest", "quests")
	var target_plans: Array = []
	for column in CONDITION_TARGET_COLUMNS:
		target_plans.append(_reference_plan("quest_conditions", column, CONDITION_TARGET_TABLES[column]))
	for condition in _records("quest_conditions"):
		var quest_id: String = _checked_reference_id(condition, "quest", quest_plan)
		if not _error.is_empty(): return _error
		var kind: String = condition.get_string("kind")
		if kind not in ["kill", "gather", "craft", "deliver", "own_equipment"]: return "Unsupported quest condition kind: " + kind
		var count: int = condition.get_int("count", -1)
		if not condition.last_error.is_empty() or count <= 0: return "Quest condition count must be a positive integer: " + condition.id()
		var condition_id: String = condition.id()
		var signature: Array = [quest_id, kind]
		var targets: Array = ["", "", "", ""]
		for index in range(4):
			var column: String = CONDITION_TARGET_COLUMNS[index]
			var target: String = _checked_reference_id(condition, column, target_plans[index], true)
			if not _error.is_empty(): return _error
			targets[index] = target
			signature.append(target)
		var allowed: Array = CONDITION_ALLOWED_TARGETS[kind]
		for index in range(4):
			var column: String = CONDITION_TARGET_COLUMNS[index]
			if column not in allowed and not targets[index].is_empty(): return "Irrelevant target in %s condition: %s" % [kind, column]
		if kind in ["gather", "deliver"] and targets[1].is_empty(): return "Material target required for " + kind
		if kind in ["craft", "own_equipment"] and targets[2].is_empty(): return "Equipment target required for " + kind
		if kind in ["craft", "own_equipment"] and count > int(equipment_capacity.get(targets[2], 0)):
			return "Equipment condition count exceeds distinct craftable variants: " + condition.id()
		if kind == "kill" and not targets[0].is_empty() and not targets[3].is_empty():
			var enemy_region = _db.by_id("enemies", targets[0]).get_reference("region_ref")
			if enemy_region == null or enemy_region.id() != targets[3]: return "Kill enemy and region targets disagree."
		_condition_signatures[condition_id] = signature
		if not _condition_rows.has(quest_id): _condition_rows[quest_id] = []
		_condition_rows[quest_id].append(condition)
		totals[quest_id] = true
		if kind == "deliver":
			var delivery_key: String = quest_id + "/" + signature[3]
			var previous: int = int(delivery_totals.get(delivery_key, 0))
			if previous > 9223372036854775807 - count: return "Aggregated quest delivery count exceeds inventory capacity."
			delivery_totals[delivery_key] = previous + count
	for quest in _records("quests"):
		if not totals.has(quest.id()): return "Quest has no conditions: " + quest.id()
	_quest_indexes_ready = true
	return ""

func _build_quality_groups() -> void:
	var quality_groups: Dictionary = {}
	for material in _records("materials"):
		var group: String = material.get_string("quality_group_key")
		if group.is_empty() or material.get_int("quality_index", -1) < 0: continue
		if not quality_groups.has(group): quality_groups[group] = []
		quality_groups[group].append(material.id())
	_quality_groups = quality_groups

func _build_quest_indexes() -> String:
	var conditions = _db.table("quest_conditions")
	var quests = _db.table("quests")
	if conditions == null:
		if _db.table("quest_requesters") != null or (quests != null and "requester" in quests.columns()):
			return "Missing quest table: quest_conditions"
		return ""
	# These fields are consumed by the runtime index and Save compatibility.
	# Content checks (counts, reachability, capacities and condition combinations)
	# belong to validate_authoring, not preparation of a playable snapshot.
	if quests == null: return "Missing quest table: quests"
	for column in ["quest", "kind", "count", "target_enemy", "target_material", "target_equipment", "target_region"]:
		if column not in conditions.columns(): return "Missing quest column: quest_conditions." + column
	var reference_tables: Dictionary = CONDITION_TARGET_TABLES.duplicate()
	reference_tables["quest"] = "quests"
	for column in reference_tables:
		var schema: Dictionary = conditions.column_info(column)
		var target = _db.table_by_uuid(schema.get("reference_config", {}).get("target_table_uuid", ""))
		if schema.get("data_type") != "Reference" or target == null or target.name() != reference_tables[column]:
			return "Invalid quest reference schema: quest_conditions." + column
	_build_quality_groups()
	for quest in _records("quests"):
		var source = quest.get_reference("region_ref")
		var source_id: String = source.id() if source != null else ""
		if not _quest_regions.has(source_id): _quest_regions[source_id] = []
		_quest_regions[source_id].append(quest.id())
	for condition in _records("quest_conditions"):
		var quest_id: String = condition.get_raw("quest")
		var signature: Array = [quest_id, condition.get_string("kind")]
		for column in CONDITION_TARGET_COLUMNS: signature.append(condition.get_raw(column))
		_condition_signatures[condition.id()] = signature
		if not _condition_rows.has(quest_id): _condition_rows[quest_id] = []
		_condition_rows[quest_id].append(condition)
	_quest_indexes_ready = true
	return ""

func _equipment_variant_capacity() -> Dictionary:
	# Runtime ownership is unique by equipment UUID + quality-material UUID,
	# not recipe row. Multiple recipes for the same variant cannot inflate this.
	_build_quality_groups()
	var quality_groups: Dictionary = _quality_groups
	var variants: Dictionary = {}
	for recipe in _records("recipes"):
		if recipe.get_string("kind") == "refine": continue
		var equipment = recipe.get_reference("equipment")
		if equipment == null: continue
		if not variants.has(equipment.id()): variants[equipment.id()] = {}
		var group: String = recipe.get_string("quality_group_key")
		if group.is_empty():
			variants[equipment.id()][""] = true
		else:
			for quality_id in quality_groups.get(group, []): variants[equipment.id()][quality_id] = true
	var counts: Dictionary = {}
	for equipment_id in variants: counts[equipment_id] = variants[equipment_id].size()
	return counts

func _checkbox_grand_objectives() -> Dictionary:
	var candidates: Array = []
	for quest in _records("quests"):
		var flagged: bool = quest.get_bool("grand_candidate")
		if not quest.last_error.is_empty(): return {"ok": false, "error": "Invalid quest grand_candidate Boolean: " + quest.id()}
		if flagged: candidates.append(quest)
	if candidates.size() < 3: return {"ok": false, "error": "Check grand_candidate on at least three quests; no unflagged fallback is allowed."}
	# Stable input order makes seeded tests reproducible; sampling belongs to the game.
	candidates.sort_custom(func(first, second): return first.id() < second.id())
	var conditions_by_quest: Dictionary = _condition_rows
	var objectives: Array = []
	for quest in candidates:
		var region = quest.get_reference("region_ref")
		if region == null:
			var requester = quest.get_reference("requester")
			if requester != null: region = requester.get_reference("region")
		var strongest = null
		for condition in conditions_by_quest.get(quest.id(), []):
			if region == null: region = condition.get_reference("target_region")
			var enemy = condition.get_reference("target_enemy")
			if region == null and enemy != null: region = enemy.get_reference("region_ref")
			var material = condition.get_reference("target_material")
			if region == null and material != null: region = material.get_reference("source_region")
			var equipment = condition.get_reference("target_equipment")
			if region == null and equipment != null: region = equipment.get_reference("region_ref")
			if condition.get_string("kind") == "kill" and enemy != null and (strongest == null or _stronger_goal_enemy(enemy, strongest)):
				strongest = enemy
		if region == null: return {"ok": false, "error": "Grand candidate needs a valid authored source or target region: " + quest.id()}
		objectives.append({"id": quest.id(), "quest_id": quest.id(), "name": quest.get_string("name"), "region_id": region.id(), "enemy_id": strongest.id() if strongest != null else ""})
	return {"ok": true, "objectives": objectives}

func _stronger_goal_enemy(first, second) -> bool:
	# Optional display context only. Quest conditions, not this hint, define
	# completion; compare authored tier, HP and attack without invented weights.
	for field in ["tier", "hp", "attack"]:
		var first_value: int = first.get_int(field)
		var second_value: int = second.get_int(field)
		if first_value != second_value: return first_value > second_value
	return first.id() < second.id()

func _build_general_policy(check_content: bool) -> Dictionary:
	var profiles: Dictionary = {}
	for row in _records("access_profiles"): profiles[row.id()] = {}
	for requirement in _records("access_requirements"):
		var profile = _reference(requirement, "profile", "access_profiles")
		if not _error.is_empty(): return _failure(_error)
		var rule: Dictionary = profiles[profile.id()]
		var kind: String = requirement.get_string("condition_kind")
		match kind:
			"min_wins", "region_wins":
				var amount: int = requirement.get_int("amount", -1)
				if amount < 0 or not requirement.last_error.is_empty(): return _failure("A win prerequisite needs a nonnegative integer amount: " + requirement.id())
				if kind == "min_wins":
					rule.min_wins = maxi(int(rule.get("min_wins", 0)), amount)
				else:
					var region = _reference(requirement, "region", "regions")
					if not _error.is_empty(): return _failure(_error)
					if not rule.has("region_wins"): rule.region_wins = {}
					var key: String = region.id()
					rule.region_wins[key] = maxi(int(rule.region_wins.get(key, 0)), amount)
			"claimed_quest", "owned_equipment":
				var column: String = "quest" if kind == "claimed_quest" else "equipment"
				var target_table: String = "quests" if kind == "claimed_quest" else "equipment"
				var target = _reference(requirement, column, target_table)
				if not _error.is_empty(): return _failure(_error)
				var field: String = "claimed_quests" if kind == "claimed_quest" else "owned_equipment"
				if not rule.has(field): rule[field] = []
				if target.id() not in rule[field]: rule[field].append(target.id())
			_: return _failure("Unknown prerequisite condition: " + kind)
	for rule in profiles.values(): _freeze_prepared(rule)
	var policy: Dictionary = {"rules": {}, "region_materials": {}, "region_graph": {"start_region_id": "", "nodes": [], "edges": []}, "grand_objectives": []}
	for table_name in GUARDED_TABLES:
		policy.rules[table_name] = {}
		for row in _records(table_name):
			var profile = _reference(row, "access_profile", "access_profiles", true)
			if not _error.is_empty(): return _failure(_error)
			# Blank is deliberately locked; a referenced empty profile is open.
			if profile != null: policy.rules[table_name][row.id()] = profiles[profile.id()]
	for table_rules in policy.rules.values(): table_rules.make_read_only()
	policy.rules.make_read_only()
	var region_keys: Dictionary = {}
	for region in _records("regions"):
		if check_content:
			var key: String = region.get_string("key")
			if key.is_empty() or region_keys.has(key): return _failure("Region keys must be nonempty and unique.")
			region_keys[key] = region.id()
		if "town_entry_fee" in _db.table("regions").columns():
			var entry_fee: int = region.get_int("town_entry_fee", -1)
			if entry_fee < 0 or not region.last_error.is_empty(): return _failure("Invalid town entry fee: " + region.id())
		var x: int = region.get_int("map_x")
		if not region.last_error.is_empty(): return _failure("Invalid region map_x: " + region.id())
		var y: int = region.get_int("map_y")
		if not region.last_error.is_empty(): return _failure("Invalid region map_y: " + region.id())
		policy.region_graph.nodes.append({"id": region.id(), "position": [x, y]})
		var is_start: bool = region.get_bool("is_start")
		if not region.last_error.is_empty(): return _failure("Invalid region is_start: " + region.id())
		if is_start:
			if not str(policy.region_graph.start_region_id).is_empty(): return _failure("Exactly one region must be the starting region.")
			policy.region_graph.start_region_id = region.id()
	if str(policy.region_graph.start_region_id).is_empty(): return _failure("Exactly one region must be the starting region.")
	var edge_ids: Dictionary = {}
	for connection in _records("region_connections"):
		var origin = _reference(connection, "from_region", "regions")
		var destination = _reference(connection, "to_region", "regions")
		if not _error.is_empty(): return _failure(_error)
		if check_content and origin.id() == destination.id(): return _failure("A region connection cannot link a region to itself.")
		var ids: Array = [origin.id(), destination.id()]
		ids.sort()
		var edge_key: String = "%s/%s" % ids
		if edge_ids.has(edge_key): continue
		edge_ids[edge_key] = true
		policy.region_graph.edges.append(ids)
	for material in _records("materials"):
		var source = _reference(material, "source_region", "regions", true)
		if not _error.is_empty(): return _failure(_error)
		if source != null:
			if not policy.region_materials.has(source.id()): policy.region_materials[source.id()] = []
			policy.region_materials[source.id()].append(material.id())
	# Additional explicitly authored sources never replace a material's primary
	# source. Union pairs so duplicate authoring cannot increase draw weight.
	var additional_sources = _db.table("gathering_sources")
	if additional_sources != null:
		for column in ["region", "material"]:
			if column not in additional_sources.columns(): return _failure("Missing gathering source column: " + column)
		for index in range(additional_sources.count()):
			var source = additional_sources.at(index)
			var region = _reference(source, "region", "regions")
			var material = _reference(source, "material", "materials")
			if not _error.is_empty(): return _failure(_error)
			if not policy.region_materials.has(region.id()): policy.region_materials[region.id()] = []
			if material.id() not in policy.region_materials[region.id()]: policy.region_materials[region.id()].append(material.id())
	return {"ok":true,"policy":policy}

func _build_quest_contract(db, output: Array, check_content: bool):
	var worker = get_script().new()
	worker._db = db
	var error: String = worker._validate_quest_schema() if check_content else worker._build_quest_indexes()
	output[0] = {"error":error,"quality_groups":worker._quality_groups,
		"condition_rows":worker._condition_rows,"condition_signatures":worker._condition_signatures,
		"quest_regions":worker._quest_regions,"ready":worker._quest_indexes_ready}

# Resolve immutable candidate column metadata once. Optional blank references
# still bypass target resolution; nonblank failures remain ordered by input row.
func _reference_plan(source: String, column: String, expected_table: String) -> Dictionary:
	var schema: Dictionary = _db.table(source).column_info(column)
	var target = _db.table_by_uuid(schema.get("reference_config", {}).get("target_table_uuid", ""))
	var ids: Dictionary = {}
	if schema.get("data_type") == "Reference" and target != null and target.name() == expected_table:
		for id in target.ids(): ids[id] = true
	return {"source": source, "target": expected_table, "ids": ids}

func _checked_reference_id(row, column: String, plan: Dictionary, allow_blank: bool = false) -> String:
	var raw: String = row.get_raw(column)
	if allow_blank and raw.strip_edges().is_empty(): return ""
	if not plan.ids.has(raw):
		_error = "Invalid reference %s.%s in record %s; expected %s." % [plan.source, column, row.id(), plan.target]
		return ""
	return raw
