use devcel_core::{
    AppError, ColumnSchema, DevcelError, Interface, InterfaceChange, InterfaceRegistry, Project,
    TableData, ValueType,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn wire(error: DevcelError) -> Value {
    let encoded = serde_json::to_value(AppError::from(error)).unwrap();
    let decoded: AppError = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), encoded);
    encoded
}

fn diagnostic(error: DevcelError) -> Value {
    let value = wire(error);
    assert_eq!(value["kind"], "diagnostics");
    value["diagnostics"][0].clone()
}

fn column(name: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        ..Default::default()
    }
}

fn table() -> TableData {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "StorageDiagnostics",
        directory.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let path = project.create_table("Values.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    project.tables_data[&path].data.clone()
}

#[test]
fn interface_authoring_retains_semantic_name_and_type_errors() {
    let mut interface = Interface::new("Definition".into(), None);
    let before = serde_json::to_value(&interface).unwrap();
    let error = interface
        .create_new_version(
            vec![InterfaceChange::AddColumn { column: column("") }],
            None,
            None,
        )
        .unwrap_err();
    assert_eq!(diagnostic(error)["code"], "column.validation.emptyName");
    assert_eq!(serde_json::to_value(&interface).unwrap(), before);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: column("value"),
            }],
            None,
            None,
        )
        .unwrap();
    let error = interface
        .create_new_version(
            vec![InterfaceChange::ConfigureColumn {
                column_name: "value".into(),
                reference_config: None,
                curve_config: None,
                table_ref_config: None,
                select_config: Some(devcel_core::types::SelectConfig { options: vec![] }),
            }],
            None,
            None,
        )
        .unwrap_err();
    assert_eq!(diagnostic(error)["code"], "error.rules.typeConfiguration");
}

#[test]
fn invalid_history_change_keeps_index_version_and_typed_child_without_rewriting() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("broken.interface.toml");
    let mut interface = Interface::new("Definition".into(), None);
    let version = interface.current_version_id;
    interface
        .history
        .get_mut(&version)
        .unwrap()
        .changes
        .push(InterfaceChange::AddColumn { column: column("") });
    std::fs::write(&path, toml::to_string(&interface).unwrap()).unwrap();
    let before = std::fs::read(&path).unwrap();
    let error = diagnostic(Interface::load_from_file(&path).unwrap_err());
    assert_eq!(error["code"], "error.interface.historyChange");
    assert_eq!(error["params"]["version"], version.to_string());
    assert_eq!(error["params"]["index"], 2);
    let cause = &error["params"]["error"];
    assert_eq!(cause["kind"], "diagnostics");
    assert_eq!(
        cause["diagnostics"][0]["code"],
        "column.validation.emptyName"
    );
    assert!(!error.to_string().contains("Validation error"));
    assert!(!error.to_string().contains("Name cannot be empty"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn history_integrity_failures_are_typed_and_keep_identifiers() {
    let mut interface = Interface::new("Definition".into(), None);
    let version = interface.current_version_id;
    let missing = Uuid::new_v4();
    interface
        .history
        .get_mut(&version)
        .unwrap()
        .parent_version_id = Some(missing);
    let error = diagnostic(interface.validate_storage_contract().unwrap_err());
    assert_eq!(error["code"], "error.interface.historyVersion");
    assert_eq!(error["params"]["version"], missing.to_string());
    interface
        .history
        .get_mut(&version)
        .unwrap()
        .parent_version_id = Some(version);
    assert_eq!(
        diagnostic(interface.validate_storage_contract().unwrap_err())["code"],
        "error.interface.historyCycle"
    );
    interface
        .history
        .get_mut(&version)
        .unwrap()
        .parent_version_id = None;
    interface.description = Some("user-authored English stays unchanged".into());
    let mismatch = diagnostic(interface.validate_storage_contract().unwrap_err());
    assert_eq!(mismatch["code"], "error.interface.historySnapshot");
    assert_eq!(mismatch["params"]["field"]["code"], "interface.description");
}

#[test]
fn missing_interface_and_column_are_semantic_and_keep_user_values() {
    let mut interface = Interface::new("Definition".into(), None);
    let missing = Uuid::new_v4();
    interface.extends.push(missing);
    let error = diagnostic(
        interface
            .get_effective_columns(&InterfaceRegistry::new())
            .unwrap_err(),
    );
    assert_eq!(error["code"], "error.interface.missingId");
    assert_eq!(error["params"]["id"], missing.to_string());
    let error = interface
        .create_new_version(
            vec![InterfaceChange::RemoveColumn {
                column_name: "UserLiteral".into(),
            }],
            None,
            None,
        )
        .unwrap_err();
    let error = diagnostic(error);
    assert_eq!(error["code"], "interface.dialog.missingColumn");
    assert_eq!(error["params"]["name"], "UserLiteral");
}

#[test]
fn native_table_decoders_do_not_flatten_storage_contract_errors() {
    let mut data = table();
    data.schema.columns.push(column(""));
    let source = toml::to_string(&data).unwrap();
    let error = match TableData::from_toml(&source) {
        Ok(_) => panic!("invalid table accepted"),
        Err(error) => error,
    };
    assert_eq!(diagnostic(error)["code"], "column.validation.emptyName");
    let error = match TableData::from_json_value(serde_json::to_value(&data).unwrap()) {
        Ok(_) => panic!("invalid table accepted"),
        Err(error) => error,
    };
    assert_eq!(diagnostic(error)["code"], "column.validation.emptyName");
    assert_eq!(data.schema.columns.last().unwrap().data_name, "");
}

#[test]
fn invalid_uuid_keeps_parser_detail_as_literal_data() {
    let mut interface = Interface::new("Definition".into(), None);
    let mut invalid = column("value");
    invalid.uuid = "literal-invalid-id".into();
    let error = diagnostic(
        interface
            .create_new_version(
                vec![InterfaceChange::AddColumn { column: invalid }],
                None,
                None,
            )
            .unwrap_err(),
    );
    assert_eq!(error["code"], "error.storage.invalidColumnId");
    assert_eq!(error["params"]["id"], "literal-invalid-id");
    assert!(error["params"]["error"]
        .as_str()
        .is_some_and(|text| !text.is_empty()));
}

#[test]
fn valid_interface_and_table_storage_roundtrip_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("valid.interface.toml");
    let mut interface = Interface::new("Definition".into(), Some("literal description".into()));
    let mut value = column("value");
    value.data_type = ValueType::I32;
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn { column: value }],
            None,
            None,
        )
        .unwrap();
    interface.save_to_file(&path).unwrap();
    let loaded = Interface::load_from_file(&path).unwrap();
    assert_eq!(
        serde_json::to_value(loaded).unwrap(),
        serde_json::to_value(&interface).unwrap()
    );
    let data = table();
    let loaded = TableData::from_toml(&toml::to_string(&data).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(loaded).unwrap(),
        serde_json::to_value(&data).unwrap()
    );
    let loaded = TableData::from_json_value(serde_json::to_value(&data).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(loaded).unwrap(),
        serde_json::to_value(data).unwrap()
    );
    assert_eq!(
        wire(DevcelError::Diagnostics(vec![
            devcel_core::types::Diagnostic::Text {
                text: "User literal English".into()
            }
        ]))["diagnostics"][0],
        json!({"kind":"text","text":"User literal English"})
    );
}
