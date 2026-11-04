//! Two typed hops: catalog -> registration contract -> plugin-specific contract.
//! Each registration table owns one target column, so its TableRef has one
//! unambiguous interface without row-dependent type exceptions.
use crate::interface::{Interface, InterfaceChange, InterfaceRegistry};
use crate::plugin_resources::{ResourceCardinality, ResourceKind};
use crate::table::{TableMetadata, TableSchema};
use crate::{ColumnSchema, Record, Result, Table, TableData, ValueType};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

pub const REGISTRATION_CONTRACT: &str = "3af00752-cf43-4a47-9f8a-1a3e8f338fbd";
const REGISTRATION_VERSION: &str = "c5e418cd-de18-4b40-a17f-c73c62a2e4bd";
pub type Tables = HashMap<PathBuf, Table>;

fn invalid() -> crate::DevcelError {
    crate::app_error::diagnostic(
        "plugin.resources.error.registry",
        serde_json::json!({"owner":"","table":""}),
    )
}
pub fn identity(owner: &str, resource: &str, role: &str) -> String {
    let mut digest = Sha256::new();
    for part in ["devcel.resource-registration.v1", owner, resource, role] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part.as_bytes());
    }
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest.finalize()[..16]);
    bytes[6] = (bytes[6] & 15) | 0x80;
    bytes[8] = (bytes[8] & 63) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

pub fn registration_contract() -> Interface {
    let mut contract = Interface::new("PluginResourceRegistration".into(), Some("Identifies one plugin-owned resource and its cardinality. The local target column supplies the resource's own interface contract.".into()));
    contract.uuid = Uuid::parse_str(REGISTRATION_CONTRACT).unwrap();
    let mut version = contract
        .history
        .remove(&contract.current_version_id)
        .unwrap();
    version.version_id = Uuid::parse_str(REGISTRATION_VERSION).unwrap();
    version.timestamp = "2026-10-25T00:00:00Z".parse().unwrap();
    contract.current_version_id = version.version_id;
    for (name, options) in [
        ("owner", Vec::new()),
        ("tableId", Vec::new()),
        ("kind", vec!["settings", "translations"]),
        ("cardinality", vec!["singleton", "rows"]),
    ] {
        let mut c = ColumnSchema::new();
        c.uuid = identity("host", "registration", name);
        c.data_name = name.into();
        c.display_name = name.into();
        c.required = Some(true);
        c.data_type = if options.is_empty() {
            ValueType::String
        } else {
            ValueType::Select
        };
        if !options.is_empty() {
            c.select_config = Some(crate::SelectConfig {
                options: options
                    .into_iter()
                    .map(|v| crate::SelectOption {
                        value: v.into(),
                        label: v.into(),
                    })
                    .collect(),
            });
        }
        version
            .changes
            .push(InterfaceChange::AddColumn { column: c.clone() });
        contract.columns.push(c);
    }
    contract.history.insert(version.version_id, version);
    contract
}

fn column_contract(c: &ColumnSchema) -> serde_json::Value {
    serde_json::json!({"uuid":c.uuid,"name":c.data_name,"type":c.data_type,
        "required":c.required,"constraints":c.constraints,"reference":c.reference_config,
        "tableRef":c.table_ref_config,"select":c.select_config.as_ref().map(|s|s.options.iter().map(|o| &o.value).collect::<Vec<_>>())})
}

/// The package supplies an actual nonempty contract. A mere implementation UUID
/// or matching type name cannot substitute for the fields and their constraints.
pub fn validate_target(
    table: &TableData,
    contract: &Interface,
    registry: &InterfaceRegistry,
) -> Result<()> {
    contract.validate_storage_contract()?;
    table.validate_storage_contract()?;
    let mut names = std::collections::BTreeSet::new();
    if table
        .schema
        .columns
        .iter()
        .any(|c| !names.insert(c.data_name.as_str()))
    {
        return Err(invalid());
    }
    let columns = contract.get_effective_columns(registry)?;
    if columns.is_empty() || columns.len() > 128 {
        return Err(invalid());
    }
    let implementation = table
        .interface_implementations
        .get(&contract.uuid)
        .ok_or_else(invalid)?;
    if implementation.synced_version_id != contract.current_version_id {
        return Err(invalid());
    }
    for definition in columns {
        let actual = table
            .schema
            .columns
            .iter()
            .find(|c| c.uuid == definition.uuid)
            .ok_or_else(invalid)?;
        if actual.interface_origin != definition.interface_origin
            || column_contract(actual) != column_contract(&definition)
        {
            return Err(invalid());
        }
    }
    let view = Table {
        path: PathBuf::new(),
        is_dirty: false,
        data: table.clone(),
        undo_history: vec![],
        redo_history: vec![],
    };
    if !view.validate_interface(contract, registry)?.is_valid {
        return Err(invalid());
    }
    Ok(())
}

pub fn registration_table(
    owner: &str,
    id: &str,
    kind: ResourceKind,
    cardinality: ResourceCardinality,
    target: &TableData,
    contract: &Interface,
) -> Result<TableData> {
    let common = registration_contract();
    let mut interfaces = InterfaceRegistry::new();
    interfaces.add_interface(common.clone())?;
    let mut table = Table {
        path: PathBuf::new(),
        is_dirty: true,
        undo_history: vec![],
        redo_history: vec![],
        data: TableData {
            description: "One plugin resource registration".into(),
            uuid: identity(owner, id, "table"),
            display_name: format!("{owner} / {id}"),
            metadata: TableMetadata {
                interface_order: Vec::new(),
                parent_uuid: String::new(),
                data_name: format!(
                    "{}_Registration",
                    crate::plugin_resources::table_name(owner, id)
                ),
                initial_transposed: true,
                edit_permissions: crate::table::TableEditPermissions {
                    add_columns: false,
                    delete_columns: false,
                    add_rows: false,
                    delete_rows: false,
                    edit_cells: false,
                },
            },
            schema: TableSchema { columns: vec![] },
            records: vec![],
            interface_implementations: HashMap::new(),
        },
    };
    table.apply_interface(&common, &interfaces, true)?;
    let mut target_column = ColumnSchema::new();
    target_column.uuid = identity(owner, id, "target");
    target_column.data_name = "target".into();
    target_column.display_name = "Resource table".into();
    target_column.data_type = ValueType::TableRef;
    target_column.required = Some(true);
    target_column.table_ref_config = Some(crate::TableRefConfig {
        interface_uuid: contract.uuid.to_string(),
    });
    table.data.schema.columns.push(target_column);
    let mut row = Record::new();
    row.uuid = identity(owner, id, "row");
    row.label = id.into();
    for (name, value) in [
        ("owner", owner),
        ("tableId", id),
        (
            "kind",
            match kind {
                ResourceKind::Settings => "settings",
                ResourceKind::Translations => "translations",
            },
        ),
        ("cardinality", cardinality.name()),
        ("target", target.uuid.as_str()),
    ] {
        let column = table
            .data
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == name)
            .unwrap();
        row.set_cell_value(column, value.into());
    }
    table.data.records.push(row);
    validate_target(&table.data, &common, &interfaces)?;
    Ok(table.data)
}

#[derive(Debug)]
pub struct Binding {
    pub catalog_record_uuid: String,
    pub registration_uuid: String,
    pub owner: String,
    pub id: String,
    pub kind: ResourceKind,
    pub cardinality: ResourceCardinality,
    pub target_uuid: String,
    pub contract_uuid: Uuid,
}

fn table_by_id<'a>(tables: &'a Tables, id: &str) -> Result<&'a TableData> {
    let mut matching = tables.values().filter(|t| t.data.uuid == id);
    let result = &matching.next().ok_or_else(invalid)?.data;
    if matching.next().is_some() {
        return Err(invalid());
    }
    Ok(result)
}

pub fn bindings(
    catalog: &TableData,
    tables: &Tables,
    interfaces: &InterfaceRegistry,
) -> Result<Vec<Binding>> {
    use std::collections::BTreeSet;
    if catalog.schema.columns.len() != 1 {
        return Err(invalid());
    }
    let link = &catalog.schema.columns[0];
    if link.data_name != "registration"
        || link.data_type != ValueType::TableRef
        || link
            .table_ref_config
            .as_ref()
            .map(|c| c.interface_uuid.as_str())
            != Some(REGISTRATION_CONTRACT)
    {
        return Err(invalid());
    }
    let common = registration_contract();
    let stored = interfaces.get_interface(&common.uuid).ok_or_else(invalid)?;
    if stored
        .columns
        .iter()
        .map(column_contract)
        .collect::<Vec<_>>()
        != common
            .columns
            .iter()
            .map(column_contract)
            .collect::<Vec<_>>()
    {
        return Err(invalid());
    }
    let mut seen = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut registrations = BTreeSet::new();
    let resolver = crate::table::InheritanceResolver::new(catalog);
    catalog
        .records
        .iter()
        .map(|row| {
            let registration = table_by_id(tables, resolver.input(row, link)?)?;
            validate_target(registration, &common, interfaces)?;
            if registration.records.len() != 1 || registration.schema.columns.len() != 5 {
                return Err(invalid());
            }
            let r = &registration.records[0];
            let input = crate::table::InheritanceResolver::new(registration);
            let get = |name: &str| -> Result<String> {
                let c = registration
                    .schema
                    .columns
                    .iter()
                    .find(|c| c.data_name == name)
                    .ok_or_else(invalid)?;
                Ok(input.input(r, c)?.into())
            };
            let owner = get("owner")?;
            let id = get("tableId")?;
            if !crate::plugin_resources::valid_owner(&owner)
                || !crate::plugin_resources::valid_key(&id)
                || registration.uuid != identity(&owner, &id, "table")
                || !seen.insert((owner.clone(), id.clone()))
                || !registrations.insert(registration.uuid.clone())
            {
                return Err(invalid());
            }
            let kind = match get("kind")?.as_str() {
                "settings" => ResourceKind::Settings,
                "translations" => ResourceKind::Translations,
                _ => return Err(invalid()),
            };
            let cardinality = match get("cardinality")?.as_str() {
                "singleton" => ResourceCardinality::Singleton,
                "rows" => ResourceCardinality::Rows,
                _ => return Err(invalid()),
            };
            let target_column = registration
                .schema
                .columns
                .iter()
                .find(|c| c.data_name == "target")
                .ok_or_else(invalid)?;
            if target_column.data_type != ValueType::TableRef
                || target_column.interface_origin.is_some()
            {
                return Err(invalid());
            }
            let contract_id = Uuid::parse_str(
                &target_column
                    .table_ref_config
                    .as_ref()
                    .ok_or_else(invalid)?
                    .interface_uuid,
            )
            .map_err(|_| invalid())?;
            if contract_id == common.uuid {
                return Err(invalid());
            }
            let contract = interfaces.get_interface(&contract_id).ok_or_else(invalid)?;
            if !contract
                .name
                .starts_with(&crate::plugin_resources::table_name(&owner, ""))
            {
                return Err(invalid());
            }
            let target_uuid = get("target")?;
            let target = table_by_id(tables, &target_uuid)?;
            if target.metadata.data_name != crate::plugin_resources::table_name(&owner, &id)
                || !targets.insert(target_uuid.clone())
            {
                return Err(invalid());
            }
            if cardinality == ResourceCardinality::Singleton && target.records.len() != 1 {
                return Err(invalid());
            }
            validate_target(target, contract, interfaces)?;
            Ok(Binding {
                catalog_record_uuid: row.uuid.clone(),
                registration_uuid: registration.uuid.clone(),
                owner,
                id,
                kind,
                cardinality,
                target_uuid,
                contract_uuid: contract_id,
            })
        })
        .collect()
}

/// New-format empty root catalog. Its rows point to typed registration tables.
pub fn catalog_table() -> TableData {
    let mut column = ColumnSchema::new();
    column.uuid = identity("host", "catalog", "registration");
    column.data_name = "registration".into();
    column.display_name = "Resource registration".into();
    column.data_type = ValueType::TableRef;
    column.required = Some(true);
    column.table_ref_config = Some(crate::TableRefConfig {
        interface_uuid: REGISTRATION_CONTRACT.into(),
    });
    TableData {
        description: "Plugin resources with per-resource interface contracts".into(),
        uuid: crate::plugin_resources::REGISTRY_UUID.into(),
        display_name: "Plugin resources".into(),
        metadata: TableMetadata {
            interface_order: Vec::new(),
            parent_uuid: String::new(),
            data_name: crate::plugin_resources::REGISTRY_NAME.into(),
            initial_transposed: false,
            edit_permissions: crate::table::TableEditPermissions {
                add_columns: false,
                delete_columns: false,
                add_rows: false,
                delete_rows: false,
                edit_cells: false,
            },
        },
        schema: TableSchema {
            columns: vec![column],
        },
        records: vec![],
        interface_implementations: HashMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn resource(owner: &str, id: &str, kind: ValueType, value: &str) -> (Interface, TableData) {
        let mut contract = Interface::new(
            format!(
                "{}_Contract",
                crate::plugin_resources::table_name(owner, id)
            ),
            None,
        );
        let mut c = ColumnSchema::new();
        c.data_name = "value".into();
        c.data_type = kind;
        c.required = Some(true);
        contract
            .create_new_version(vec![InterfaceChange::AddColumn { column: c }], None, None)
            .unwrap();
        let mut interfaces = InterfaceRegistry::new();
        interfaces.add_interface(contract.clone()).unwrap();
        let mut data = catalog_table();
        data.uuid = Uuid::new_v4().to_string();
        data.metadata.data_name = crate::plugin_resources::table_name(owner, id);
        data.schema.columns.clear();
        let mut table = Table {
            path: PathBuf::new(),
            data,
            is_dirty: false,
            undo_history: vec![],
            redo_history: vec![],
        };
        table.apply_interface(&contract, &interfaces, true).unwrap();
        let mut row = Record::new();
        row.set_cell_value(&table.data.schema.columns[0], value.into());
        table.data.records.push(row);
        (contract, table.data)
    }
    fn fixture() -> (TableData, Tables, InterfaceRegistry) {
        let mut catalog = catalog_table();
        let mut tables = Tables::new();
        let mut interfaces = InterfaceRegistry::new();
        interfaces.add_interface(registration_contract()).unwrap();
        for (owner, kind, value) in [
            ("org.alpha", ValueType::String, "hello"),
            ("org.beta", ValueType::Boolean, "true"),
        ] {
            let (contract, target) = resource(owner, "settings", kind, value);
            let registration = registration_table(
                owner,
                "settings",
                ResourceKind::Settings,
                ResourceCardinality::Singleton,
                &target,
                &contract,
            )
            .unwrap();
            interfaces.add_interface(contract).unwrap();
            let mut row = Record::new();
            row.set_cell_value(&catalog.schema.columns[0], registration.uuid.clone());
            catalog.records.push(row);
            for data in [registration, target] {
                let path = PathBuf::from(format!("{}.table.toml", data.uuid));
                tables.insert(
                    path.clone(),
                    Table {
                        path,
                        data,
                        is_dirty: false,
                        undo_history: vec![],
                        redo_history: vec![],
                    },
                );
            }
        }
        (catalog, tables, interfaces)
    }
    #[test]
    fn heterogeneous_contracts_use_distinct_typed_registration_columns() {
        let (catalog, tables, interfaces) = fixture();
        let records = bindings(&catalog, &tables, &interfaces).unwrap();
        assert_eq!(records.len(), 2);
        assert_ne!(records[0].contract_uuid, records[1].contract_uuid);
        assert_ne!(records[0].registration_uuid, records[1].registration_uuid);
        assert_eq!(
            serde_json::to_value(registration_contract()).unwrap(),
            serde_json::to_value(registration_contract()).unwrap()
        );
    }
    #[test]
    fn rejects_cross_owner_targets_wrong_contracts_and_duplicate_registrations() {
        let (catalog, mut tables, interfaces) = fixture();
        let records = bindings(&catalog, &tables, &interfaces).unwrap();
        let registration = tables
            .values_mut()
            .find(|t| t.data.uuid == records[0].registration_uuid)
            .unwrap();
        registration.data.records[0]
            .values
            .insert("target".into(), records[1].target_uuid.clone());
        assert!(bindings(&catalog, &tables, &interfaces).is_err());
        let (mut duplicate_catalog, duplicate_tables, duplicate_interfaces) = fixture();
        duplicate_catalog
            .records
            .push(duplicate_catalog.records[0].clone());
        assert!(bindings(&duplicate_catalog, &duplicate_tables, &duplicate_interfaces).is_err());
        let (fresh_catalog, mut fresh_tables, fresh_interfaces) = fixture();
        let fresh_bindings = bindings(&fresh_catalog, &fresh_tables, &fresh_interfaces).unwrap();
        let registration = fresh_tables
            .values_mut()
            .find(|t| t.data.uuid == fresh_bindings[0].registration_uuid)
            .unwrap();
        registration
            .data
            .schema
            .columns
            .iter_mut()
            .find(|c| c.data_name == "target")
            .unwrap()
            .table_ref_config
            .as_mut()
            .unwrap()
            .interface_uuid = fresh_bindings[1].contract_uuid.to_string();
        assert!(bindings(&fresh_catalog, &fresh_tables, &fresh_interfaces).is_err());
    }
    #[test]
    fn rejects_empty_marker_and_missing_required_field_values() {
        let (mut contract, mut data) =
            resource("org.alpha", "settings", ValueType::String, "hello");
        let mut interfaces = InterfaceRegistry::new();
        interfaces.add_interface(contract.clone()).unwrap();
        data.records[0].set_cell_value(&data.schema.columns[0], String::new());
        assert!(validate_target(&data, &contract, &interfaces).is_err());
        contract.columns.clear();
        assert!(validate_target(&data, &contract, &interfaces).is_err());
    }
    #[test]
    fn registration_and_resource_singletons_are_checked_independently() {
        for registration in [true, false] {
            for count in [0, 2] {
                let (catalog, mut tables, interfaces) = fixture();
                let binding = bindings(&catalog, &tables, &interfaces).unwrap().remove(0);
                let id = if registration {
                    binding.registration_uuid
                } else {
                    binding.target_uuid
                };
                let table = &mut tables
                    .values_mut()
                    .find(|t| t.data.uuid == id)
                    .unwrap()
                    .data;
                let row = table.records[0].clone();
                table.records.clear();
                for _ in 0..count {
                    let mut row = row.clone();
                    row.uuid = Uuid::new_v4().to_string();
                    table.records.push(row);
                }
                assert!(
                    bindings(&catalog, &tables, &interfaces).is_err(),
                    "registration={registration}, count={count}"
                );
            }
        }
    }
    #[test]
    fn effective_metadata_survives_serialization_without_raw_duplicates() {
        let (catalog, mut tables, interfaces) = fixture();
        let expected = bindings(&catalog, &tables, &interfaces).unwrap().remove(0);
        let table = &mut tables
            .values_mut()
            .find(|t| t.data.uuid == expected.registration_uuid)
            .unwrap()
            .data;
        assert!(!table.records[0].values.contains_key("owner"));
        for column in &mut table.schema.columns {
            column.default_value = table.records[0].get_cell_value(column).unwrap().clone();
            table.records[0].remove_cell_value(column);
        }
        *table = toml::from_str(&toml::to_string(table).unwrap()).unwrap();
        let actual = bindings(&catalog, &tables, &interfaces).unwrap().remove(0);
        assert_eq!(actual.owner, expected.owner);
        assert_eq!(actual.target_uuid, expected.target_uuid);
        assert_eq!(actual.contract_uuid, expected.contract_uuid);
        let table = &mut tables
            .values_mut()
            .find(|t| t.data.uuid == expected.registration_uuid)
            .unwrap()
            .data;
        let owner = table
            .schema
            .columns
            .iter_mut()
            .find(|c| c.data_name == "owner")
            .unwrap();
        owner.default_value.clear();
        assert!(bindings(&catalog, &tables, &interfaces).is_err());
    }
    #[test]
    fn implementation_marker_cannot_hide_wrong_origin_type_or_ambiguous_names() {
        for corruption in 0..3 {
            let (catalog, mut tables, interfaces) = fixture();
            let id = bindings(&catalog, &tables, &interfaces).unwrap()[0]
                .target_uuid
                .clone();
            let table = &mut tables
                .values_mut()
                .find(|t| t.data.uuid == id)
                .unwrap()
                .data;
            match corruption {
                0 => table.schema.columns[0].interface_origin = Some(Uuid::new_v4().to_string()),
                1 => table.schema.columns[0].data_type = ValueType::I32,
                _ => {
                    let mut duplicate = table.schema.columns[0].clone();
                    duplicate.uuid = Uuid::new_v4().to_string();
                    duplicate.interface_origin = None;
                    table.schema.columns.push(duplicate);
                }
            }
            assert!(bindings(&catalog, &tables, &interfaces).is_err());
        }
    }

    #[test]
    fn authoring_cannot_unregister_retarget_or_unlock_registration() {
        let (catalog, tables, interfaces) = fixture();
        let binding = bindings(&catalog, &tables, &interfaces).unwrap().remove(0);
        let registration = &tables
            .values()
            .find(|t| t.data.uuid == binding.registration_uuid)
            .unwrap()
            .data;
        for before in [&catalog, registration] {
            for corruption in 0..5 {
                let mut after = before.clone();
                match corruption {
                    0 => {
                        after.records.remove(0);
                    }
                    1 => after.records.push(after.records[0].clone()),
                    2 => after.records[0].set_cell_value(&after.schema.columns[0], "other".into()),
                    3 => after.metadata.edit_permissions.edit_cells = true,
                    _ => {
                        after.interface_implementations.clear();
                        after.metadata.interface_order.clear();
                        after.schema.columns.clear();
                    }
                }
                assert!(crate::edit_controls::validate_transition(before, &after, true).is_err());
            }
            let mut display = before.clone();
            display.display_name = "Readable label".into();
            assert!(crate::edit_controls::validate_transition(before, &display, true).is_ok());
        }
    }
}
