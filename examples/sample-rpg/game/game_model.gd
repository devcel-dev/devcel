extends RefCounted
## Runtime game state. Read master data only through the full canonical JSON reader.
const Database = preload("res://addons/devcel/runtime/devcel_database.gd")
const MAX_AMOUNT: int = 9223372036854775807
const CORE_REFERENCES = {
	"balance": "balance", "materials": "default_material", "equipment": "default_equipment", "jobs": "default_job",
	"enemies": "default_enemy", "recipes": "default_recipe", "shops": "default_shop", "rewards": "default_reward"
}
var database = Database.new()
var rows: Dictionary = {}
# UUIDs, not table indexes, identify selections and earned progress across reloads.
var core_rows: Dictionary = {}
var selected_ids: Dictionary = {}
var material_inventory: Dictionary = {}
var owned_equipment: Dictionary = {}
var equipped_id: String = ""
var claimed_quests: Dictionary = {}
var wins_by_region: Dictionary = {}
var generation: int = 0
var load_ms: float = 0.0
var total_rows: int = 0
var main_path: String = "res://data/live.json"
var last_error: String = ""
var gold: int = 20
var rest_count: int = 0
var current_rest_fee: int = 0
var ore: int = 0
var hp: int = 100
var sword_owned: bool = false
var sword_equipped: bool = false
var enemy: Dictionary = {}
var wins: int = 0
var actions: int = 0
var logs: Array[String] = []
var last_damage: int = 0
var check_ms: float = 0.0
var _main_digest: String = ""
var _main_source: String = ""

func _read_text(path: String) -> Dictionary:
	var file = FileAccess.open(path, FileAccess.READ)
	if file == null: return {"ok": false, "text": "", "error": "Cannot read " + path + ": " + error_string(FileAccess.get_open_error())}
	var text: String = file.get_as_text()
	var error: int = file.get_error()
	file.close()
	return {"ok": error == OK or error == ERR_FILE_EOF, "text": text, "error": error_string(error)}

func _semantic_change(candidate, current) -> bool:
	if not current.is_loaded() or candidate.project_name() != current.project_name(): return true
	for key in ["content_hash", "content_version", "schema_version", "mode"]:
		if candidate.manifest().get(key) != current.manifest().get(key): return true
	return false

func key_row(db, table_name: String, key: String):
	var table = db.table(table_name)
	if table == null: return null
	for i in range(table.count()):
		var row = table.at(i)
		if row.get_string("key") == key: return row
	return null

func resolve_game_settings(db) -> Dictionary:
	var settings_table = db.table("game_settings")
	if settings_table == null or settings_table.count() != 1:
		return {"ok": false, "error": "game_settings must contain exactly one row."}
	var settings = settings_table.at(0)
	var references: Dictionary = {}
	for table_name in CORE_REFERENCES:
		var row = settings.get_reference(CORE_REFERENCES[table_name])
		if row == null or row.table_name() != table_name:
			return {"ok": false, "error": "Invalid game_settings reference: " + CORE_REFERENCES[table_name]}
		references[table_name] = row
	var starting_gold: int = settings.get_int("starting_gold", -1)
	if starting_gold < 0 or not settings.last_error.is_empty():
		return {"ok": false, "error": "game_settings.starting_gold must be a nonnegative integer."}
	return {"ok": true, "error": "", "rows": references, "starting_gold": starting_gold}

func _validate_candidate(_candidate) -> Dictionary:
	return {"ok": true, "error": ""}

func row_region(row) -> String:
	if row == null: return ""
	var reference = row.get_reference("region_ref")
	if reference != null and reference.table_name() == "regions": return reference.get_string("key")
	return row.get_string("region")

func row_region_id(row) -> String:
	if row == null: return ""
	var reference = row.get_reference("region_ref")
	if reference != null and reference.table_name() == "regions": return reference.id()
	# Compatibility with explicit legacy region fields; never derive from names.
	var region = key_row(database, "regions", row.get_string("region"))
	return region.id() if region != null else ""

func quest_region_id(row) -> String:
	return row_region_id(row)

func load_main(path: String = "") -> Dictionary:
	var requested_path: String = main_path if path.is_empty() else path
	var start: int = Time.get_ticks_usec()
	var read: Dictionary = _read_text(requested_path)
	if not read.ok:
		last_error = read.error
		return {"ok": false, "changed": false, "error": last_error}
	var text: String = read.text
	# Only the first load overlaps hashing and parsing. Reloads hash first so
	# an unchanged file never pays for parsing and validation again.
	var digest: String = ""
	var digest_output: Array = [""]
	var digest_task: int = -1
	if not database.is_loaded() and not OS.has_feature("nothreads"):
		digest_task = WorkerThreadPool.add_task(_compute_source_digest.bind(text, digest_output), false, "Hash initial source")
	if digest_task < 0:
		digest = text.sha256_text()
	if digest_task < 0 and requested_path == _main_source and digest == _main_digest:
		check_ms = (Time.get_ticks_usec() - start) / 1000.0
		last_error = ""
		return {"ok": true, "changed": false, "error": ""}
	var candidate = Database.new()
	var parsed: bool = candidate.load_json(text)
	# Join before either publishing a candidate or returning a parse failure.
	if digest_task >= 0:
		WorkerThreadPool.wait_for_task_completion(digest_task)
		digest = digest_output[0]
	if not parsed:
		last_error = candidate.last_error
		return {"ok": false, "changed": false, "error": last_error}
	var settings: Dictionary = resolve_game_settings(candidate)
	if not settings.ok:
		last_error = settings.error
		return {"ok": false, "changed": false, "error": last_error}
	var candidate_rows: Dictionary = settings.rows
	if candidate_rows.recipes.get_reference("material") == null or candidate_rows.recipes.get_reference("equipment") == null:
		last_error = "Recipe Reference targets are missing"
		return {"ok": false, "changed": false, "error": last_error}
	var contract: Dictionary = _validate_candidate(candidate)
	if not contract.ok:
		last_error = contract.error
		return {"ok": false, "changed": false, "error": last_error}
	var was_loaded: bool = database.is_loaded()
	var changed: bool = _semantic_change(candidate, database)
	# Commit the watch path and digest only after canonical and game-contract validation.
	main_path = requested_path
	_main_source = requested_path
	_main_digest = digest
	if not changed:
		check_ms = (Time.get_ticks_usec() - start) / 1000.0
		last_error = ""
		return {"ok": true, "changed": false, "error": ""}
	var old_max: int = max_hp() if was_loaded else 0
	# Inventory belongs to UUIDs, even if authoring changes the default material.
	if was_loaded and core_rows.materials.id() != candidate_rows.materials.id():
		material_inventory[core_rows.materials.id()] = ore
		ore = int(material_inventory.get(candidate_rows.materials.id(), 0))
		material_inventory.erase(candidate_rows.materials.id())
	database = candidate
	core_rows = candidate_rows
	rows = candidate_rows.duplicate()
	_reconcile_selections()
	_sync_equipment_flags()
	generation += 1
	total_rows = 0
	for table_name in database.tables(): total_rows += database.table(table_name).count()
	load_ms = (Time.get_ticks_usec() - start) / 1000.0
	hp = max_hp() if not was_loaded else (0 if hp <= 0 else clampi(hp + max_hp() - old_max, 0, max_hp()))
	if not was_loaded:
		gold = int(settings.starting_gold)
		current_rest_fee = maxi(0, value("balance", "cost", 3))
	last_error = ""
	log_event("DATA  generation %d · %d tables / %d rows · %.1f ms" % [generation, database.tables().size(), total_rows, load_ms])
	return {"ok": true, "changed": true, "error": ""}

func table_count(table_name: String) -> int:
	var table = database.table(table_name)
	return table.count() if table != null else 0

func selected_row(table_name: String):
	return rows.get(table_name)

func _reconcile_selections():
	for table_name in ["jobs", "materials", "recipes", "equipment", "enemies", "shops", "quests"]:
		var table = database.table(table_name)
		if table == null or table.count() == 0:
			rows.erase(table_name)
			selected_ids.erase(table_name)
			continue
		var row = table.by_id(selected_ids.get(table_name, ""))
		if row == null: row = core_rows.get(table_name, table.at(0))
		rows[table_name] = row
		selected_ids[table_name] = row.id()
	if not equipped_id.is_empty() and database.by_id("equipment", equipped_id) == null:
		log_event("GEAR  Equipped row left this snapshot. Item kept in inventory; slot cleared.")
		equipped_id = ""

func select_row(table_name: String, record_id: String) -> bool:
	if table_name not in ["jobs", "materials", "recipes", "equipment", "enemies", "shops", "quests"]:
		return fail("This table does not have a gameplay selection.")
	var row = database.by_id(table_name, record_id)
	if row == null: return fail("That row is no longer in the live database. Refresh the list.")
	if selected_ids.get(table_name, "") == record_id and table_name != "recipes": return true
	if table_name == "jobs" and not enemy.is_empty():
		return fail("Finish the encounter or rest before changing jobs.")
	var old_max: int = max_hp()
	rows[table_name] = row
	selected_ids[table_name] = record_id
	if table_name == "jobs":
		# Preserve damage, including defeat; changing class cannot heal for free.
		hp = 0 if hp <= 0 else clampi(hp + max_hp() - old_max, 0, max_hp())
	if table_name == "recipes":
		var material = row.get_reference("material")
		if material != null:
			rows.materials = material
			selected_ids.materials = material.id()
	log_event("SELECT  %s · %s" % [table_name, row_name(row)])
	return true

func row_name(row) -> String:
	if row == null: return "Unavailable"
	var name: String = row.get_string("name")
	if not name.is_empty(): return name
	var key: String = row.get_string("key")
	return row.id() if key.is_empty() else key

func value(table_name: String, column: String, fallback: int = 0) -> int:
	return rows[table_name].get_int(column, fallback) if rows.has(table_name) else fallback

func max_hp() -> int:
	return maxi(1, value("jobs", "hp", value("balance", "hp", 80)))

func equipped_row():
	return database.by_id("equipment", equipped_id) if not equipped_id.is_empty() else null

func attack_power() -> int:
	var equipment = equipped_row()
	return maxi(1, value("jobs", "attack", value("balance", "attack", 8)) + (equipment.get_int("attack") if equipment != null else 0))

func mine_yield() -> int:
	return maxi(1, value("materials", "mine_yield", 1))

func craft_ore() -> int:
	return maxi(1, value("recipes", "material_count", 3))

func craft_cost() -> int:
	return maxi(0, value("recipes", "cost", 4))

func recipe_material():
	return rows.recipes.get_reference("material") if rows.has("recipes") else null

func recipe_equipment():
	return rows.recipes.get_reference("equipment") if rows.has("recipes") else null

func inventory_count(material = null) -> int:
	if material == null: material = rows.get("materials")
	if material == null: return 0
	if core_rows.has("materials") and material.id() == core_rows.materials.id(): return ore
	return int(material_inventory.get(material.id(), 0))

func _add_material(material, amount: int):
	if material == null: return
	if core_rows.has("materials") and material.id() == core_rows.materials.id():
		ore = maxi(0, ore + amount)
	else:
		material_inventory[material.id()] = maxi(0, inventory_count(material) + amount)

func material_total() -> int:
	var total: int = ore
	for amount in material_inventory.values(): total += int(amount)
	return total

func owns_equipment(row = null) -> bool:
	if row == null: row = rows.get("equipment")
	return row != null and owned_equipment.has(row.id())

func can_craft() -> bool:
	var material = recipe_material()
	var equipment = recipe_equipment()
	return material != null and equipment != null and not owns_equipment(equipment) and inventory_count(material) >= craft_ore() and gold >= craft_cost()

func _sync_equipment_flags():
	# Kept for the existing field renderer and small-phase integration workflow.
	sword_owned = core_rows.has("equipment") and owned_equipment.has(core_rows.equipment.id())
	sword_equipped = not equipped_id.is_empty()

func sell_price(material = null) -> int:
	if material == null: material = rows.get("materials")
	return maxi(1, material.get_int("value", 2)) if material != null else 2

func market_tariff(shop = null) -> int:
	if shop == null: shop = rows.get("shops")
	return maxi(1, shop.get_int("price", 3)) if shop != null else 3

func shop_price() -> int:
	# One quote drives the UI and transactions. A market tariff is a floor,
	# never a way to buy expensive materials below their resale value.
	var resale: int = sell_price()
	var marked_up: int = resale + 1 if resale < MAX_AMOUNT else MAX_AMOUNT
	return maxi(market_tariff(), marked_up)

func can_buy() -> bool:
	return database.is_loaded() and gold >= shop_price() and inventory_count() < MAX_AMOUNT

func can_sell() -> bool:
	return database.is_loaded() and inventory_count() > 0 and gold >= 0 and gold <= MAX_AMOUNT - sell_price()

func rest_cost() -> int:
	return current_rest_fee

func next_rest_fee(previous_fee: int) -> int:
	# ceil(fee * (1000 + rate) / 1000), with exact integer arithmetic.
	# Split both factors before multiplying so authored rates cannot overflow.
	var fee: int = maxi(0, previous_fee)
	var rate: int = maxi(0, value("balance", "rest_growth_permille", 40))
	if fee == 0 or rate == 0: return fee
	var room: int = MAX_AMOUNT - fee
	@warning_ignore("integer_division")
	var whole: int = fee / 1000
	@warning_ignore("integer_division")
	if whole > room / rate: return MAX_AMOUNT
	var increase: int = whole * rate
	var remainder: int = fee % 1000
	@warning_ignore("integer_division")
	var tail: int = remainder * (rate / 1000)
	var fraction: int = remainder * (rate % 1000)
	@warning_ignore("integer_division")
	var rounded: int = fraction / 1000 + (1 if fraction % 1000 != 0 else 0)
	if tail > room - increase: return MAX_AMOUNT
	increase += tail
	if rounded > room - increase: return MAX_AMOUNT
	return fee + increase + rounded

func title(table_name: String, fallback: String) -> String:
	return row_name(rows[table_name]) if rows.has(table_name) else fallback

func log_event(message: String):
	logs.push_back(message)
	if logs.size() > 60: logs.pop_front()

func mine() -> bool:
	if not database.is_loaded(): return fail("Load a valid canonical file first.")
	if hp <= 0: return fail("Rest before returning to the mine.")
	_add_material(rows.materials, mine_yield())
	actions += 1
	log_event("MINE  +%d %s · inventory %d" % [mine_yield(), title("materials", "Ore"), inventory_count()])
	return true

func craft() -> bool:
	var material = recipe_material()
	var equipment = recipe_equipment()
	if material == null or equipment == null: return fail("Recipe references are unresolved.")
	if owns_equipment(equipment): return fail("This equipment is already crafted. Select it in your loadout.")
	if inventory_count(material) < craft_ore() or gold < craft_cost():
		return fail("Need %d %s and %d gold to forge." % [craft_ore(), row_name(material), craft_cost()])
	# References resolve through the same immutable canonical snapshot.
	_add_material(material, -craft_ore())
	gold -= craft_cost()
	owned_equipment[equipment.id()] = true
	rows.equipment = equipment
	selected_ids.equipment = equipment.id()
	_sync_equipment_flags()
	actions += 1
	log_event("FORGE  %s created from %s. Equip it before combat." % [row_name(equipment), row_name(material)])
	return true

func equip() -> bool:
	var equipment = rows.get("equipment")
	if not owns_equipment(equipment): return fail("Forge this equipment first. Its recipe is in the workshop.")
	equipped_id = "" if equipped_id == equipment.id() else equipment.id()
	_sync_equipment_flags()
	actions += 1
	log_event("GEAR  %s · %s · attack %d" % [row_name(equipment), "equipped" if sword_equipped else "unequipped", attack_power()])
	return true

func buy() -> bool:
	if not database.is_loaded(): return fail("Load a valid canonical file first.")
	var price: int = shop_price()
	if gold < price: return fail("Not enough gold. Need %d gold to buy this material." % price)
	if inventory_count() >= MAX_AMOUNT: return fail("This material inventory is full. Purchase was not charged.")
	gold -= price
	_add_material(rows.materials, 1)
	actions += 1
	log_event("SHOP  bought 1 %s for %d gold" % [title("materials", "Ore"), price])
	return true

func sell() -> bool:
	if not database.is_loaded(): return fail("Load a valid canonical file first.")
	if inventory_count() <= 0: return fail("Mine this material first.")
	var price: int = sell_price()
	# Reject before touching either balance: overflowing must not lose the item
	# or wrap gold negative. Subtraction is safe because price is in 1..INT64_MAX.
	if gold < 0 or gold > MAX_AMOUNT - price: return fail("Gold balance cannot accept this sale. Material retained.")
	_add_material(rows.materials, -1)
	gold += price
	actions += 1
	log_event("SELL  1 %s → %d gold" % [title("materials", "Ore"), price])
	return true

func rest() -> bool:
	if not database.is_loaded(): return fail("Load a valid canonical file first.")
	if hp >= max_hp(): return fail("You are already fully rested.")
	# A defeated or broke player can always recover: no softlock.
	var cost: int = mini(gold, rest_cost())
	gold -= cost
	rest_count = mini(rest_count, MAX_AMOUNT - 1) + 1
	current_rest_fee = next_rest_fee(current_rest_fee)
	hp = max_hp()
	enemy = {}
	actions += 1
	log_event("CAMP  HP restored · paid %d gold · encounter cleared" % cost)
	return true

func encounter_loot_preview(row) -> Dictionary:
	# Used by both encounter admission and UI. Active battles retain the
	# admitted snapshot rather than recomputing after a catalog reload.
	if row == null: return {}
	var material = row.get_reference("material")
	if material == null: material = core_rows.get("materials")
	if material == null: return {}
	return {"id": material.id(), "name": row_name(material), "amount": maxi(0, value("rewards", "amount", 1)), "percent": 100.0}

func encounter() -> bool:
	if not database.is_loaded(): return fail("Load a valid canonical file first.")
	if hp <= 0: return fail("Rest at camp to recover.")
	if not enemy.is_empty(): return fail("Finish this fight, or rest to retreat.")
	var row = rows.enemies
	# The complete encounter reward/loot is pinned too, so a reload cannot mix
	# old enemy stats with new reward definitions halfway through a fight.
	var loot: Dictionary = encounter_loot_preview(row)
	if loot.is_empty(): return fail("This encounter has no valid loot definition.")
	enemy = {"id": row.id(), "name": row_name(row), "hp": maxi(1, row.get_int("hp", 28)), "max_hp": maxi(1, row.get_int("hp", 28)), "attack": maxi(0, row.get_int("attack", 4)), "reward": maxi(0, row.get_int("reward", 6)), "generation": generation, "region": row_region(row), "region_id": row_region_id(row), "bounty": maxi(0, row.get_int("reward", 6) + value("rewards", "gold", 3) + value("balance", "reward", 1)), "loot_amount": loot.amount, "loot_id": loot.id, "loot_name": loot.name}
	actions += 1
	log_event("FIELD  %s appeared · HP %d / ATK %d (snapshot G%d)" % [enemy.name, enemy.hp, enemy.attack, generation])
	return true

func attack() -> bool:
	if hp <= 0: return fail("You are down. Rest at camp.")
	if enemy.is_empty(): return fail("Find an encounter first.")
	last_damage = attack_power()
	enemy.hp = maxi(0, enemy.hp - last_damage)
	actions += 1
	if enemy.hp <= 0:
		var bounty: int = enemy.bounty
		var loot: int = enemy.loot_amount
		gold += bounty
		# Preserve a removed loot UUID in inventory without inventing a new row.
		if enemy.loot_id == core_rows.materials.id():
			ore += loot
		else:
			material_inventory[enemy.loot_id] = int(material_inventory.get(enemy.loot_id, 0)) + loot
		wins += 1
		var victory_region_id: String = str(enemy.get("region_id", ""))
		if not victory_region_id.is_empty():
			wins_by_region[victory_region_id] = int(wins_by_region.get(victory_region_id, 0)) + 1
		log_event("VICTORY  %d damage · +%d gold / +%d %s · wins %d" % [last_damage, bounty, loot, enemy.loot_name, wins])
		enemy = {}
		return true
	var incoming: int = enemy.attack
	hp = maxi(0, hp - incoming)
	log_event("FIGHT  dealt %d · received %d · HP %d" % [last_damage, incoming, hp])
	if hp == 0:
		var lost_gold: int = gold
		gold = 0
		log_event("DOWN  Lost %d gold. Rest at camp to recover. Items are retained." % lost_gold)
	return true

func quest_region(row) -> String:
	if row == null: return ""
	var region_row = row.get_reference("region_ref")
	if region_row != null and region_row.table_name() == "regions": return region_row.get_string("key")
	var region: String = row.get_string("region")
	return region

func quest_progress(row = null) -> int:
	if row == null: row = rows.get("quests")
	if row == null: return 0
	var region: String = quest_region_id(row)
	return wins if region.is_empty() else int(wins_by_region.get(region, 0))

func quest_target(row = null) -> int:
	if row == null: row = rows.get("quests")
	return maxi(1, row.get_int("target_count", 1)) if row != null else 1

func quest_claimed(row = null) -> bool:
	if row == null: row = rows.get("quests")
	return row != null and claimed_quests.has(row.id())

func can_claim_quest() -> bool:
	return rows.has("quests") and not quest_claimed() and quest_progress() >= quest_target()

func claim_quest() -> bool:
	var row = rows.get("quests")
	if row == null: return fail("No quests in this snapshot yet.")
	if quest_claimed(row): return fail("This quest reward has already been claimed.")
	if not can_claim_quest(): return fail("Keep exploring: %d / %d victories for this quest." % [quest_progress(row), quest_target(row)])
	var reward: int = maxi(0, row.get_int("gold"))
	gold += reward
	claimed_quests[row.id()] = true
	actions += 1
	log_event("QUEST  %s completed · +%d gold" % [row_name(row), reward])
	return true

func fail(message: String) -> bool:
	log_event("TIP  " + message)
	return false

func stats() -> Dictionary:
	return {"generation": generation, "tables": database.tables().size(), "rows": total_rows, "hp": hp, "max_hp": max_hp(), "attack": attack_power(), "gold": gold, "ore": ore, "materials": material_total(), "equipment_owned": owned_equipment.size(), "quests_claimed": claimed_quests.size(), "selected_ids": selected_ids.duplicate(), "wins": wins, "actions": actions, "load_ms": load_ms, "check_ms": check_ms, "content_version": database.manifest().get("content_version", "")}

func _compute_source_digest(text: String, output: Array):
	output[0] = text.sha256_text()
