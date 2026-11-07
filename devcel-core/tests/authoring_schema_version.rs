use devcel_core::{interface::Interface, table::TableData};

const LEGACY_TABLE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../examples/manual-basics/Tables/enemies.table.toml"
));
const LEGACY_INTERFACE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../examples/plugin-owned-tables/preferences.interface.toml"
));

#[test]
fn legacy_documents_read_as_v1_and_write_explicit_metadata() {
    let table = TableData::from_toml(LEGACY_TABLE).unwrap();
    assert_eq!(table.metadata.schema_version, 1);
    let encoded = toml::to_string(&table).unwrap();
    let value: toml::Value = toml::from_str(&encoded).unwrap();
    assert_eq!(value["metadata"]["schema_version"].as_integer(), Some(1));
    assert_eq!(
        TableData::from_toml(&encoded).unwrap().records.len(),
        table.records.len()
    );

    let interface: Interface = toml::from_str(LEGACY_INTERFACE).unwrap();
    assert_eq!(interface.metadata.schema_version, 1);
    let encoded = toml::to_string(&interface).unwrap();
    let value: toml::Value = toml::from_str(&encoded).unwrap();
    assert_eq!(value["metadata"]["schema_version"].as_integer(), Some(1));
    let reloaded: Interface = toml::from_str(&encoded).unwrap();
    assert_eq!(reloaded.uuid, interface.uuid);
    assert_eq!(reloaded.current_version_id, interface.current_version_id);
}

#[test]
fn unknown_versions_are_rejected_on_read_and_write() {
    let mut table = TableData::from_toml(LEGACY_TABLE).unwrap();
    table.metadata.schema_version = 2;
    assert!(toml::to_string(&table)
        .unwrap_err()
        .to_string()
        .contains("unsupported Devcel authoring schema version"));
    let future_table = LEGACY_TABLE.replacen("[metadata]", "[metadata]\nschema_version = 2", 1);
    assert!(TableData::from_toml(&future_table).is_err());

    let mut interface: Interface = toml::from_str(LEGACY_INTERFACE).unwrap();
    interface.metadata.schema_version = 2;
    assert!(toml::to_string(&interface)
        .unwrap_err()
        .to_string()
        .contains("unsupported Devcel authoring schema version"));
    // In TOML, root fields cannot follow [metadata]; use a parsed tree instead.
    let mut value: toml::Value = toml::from_str(LEGACY_INTERFACE).unwrap();
    value.as_table_mut().unwrap().insert(
        "metadata".into(),
        toml::Value::Table(
            [("schema_version".into(), toml::Value::Integer(2))]
                .into_iter()
                .collect(),
        ),
    );
    let future_interface = toml::to_string(&value).unwrap();
    assert!(toml::from_str::<Interface>(&future_interface).is_err());
}
