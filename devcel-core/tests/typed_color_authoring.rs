use devcel_core::{
    cell_rules,
    json_export::{ExportMode, ExportTable},
    table_mutation::{self, TableMutation},
    *,
};
use serde_json::json;

fn fixture() -> (tempfile::TempDir, Project, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Colors", dir.path().to_str().unwrap(), "", "#242A30").unwrap();
    let path = project.create_table("Colors.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns = vec![
        ColumnSchema {
            data_name: "byte_tint".into(),
            data_type: ValueType::Color32,
            memo_text: "preserve memo".into(),
            ..Default::default()
        },
        ColumnSchema {
            data_name: "hdr_tint".into(),
            data_type: ValueType::ColorFloat,
            min_version: 2,
            ..Default::default()
        },
    ];
    table.data.records = vec![Record::new()];
    std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    (dir, project, path)
}
fn patch(data: &TableData, index: usize, value: &str) -> TableMutation {
    serde_json::from_value(json!({"table_uuid":data.uuid,"expected_revision":cell_rules::revision(data),"cells":[{"record_uuid":data.records[0].uuid,"column_uuid":data.schema.columns[index].uuid,"value":value}]})).unwrap()
}
#[test]
fn rgba_mutation_atomicity_history_storage_and_memos() {
    let (_dir, mut project, path) = fixture();
    let before = project.tables_data[&path].data.clone();
    table_mutation::apply(
        &mut project,
        patch(&before, 1, "[ -2.25, 4.125, 0.100000001, 0 ]"),
        None,
    )
    .unwrap();
    let saved = project.tables_data[&path].data.clone();
    assert_eq!(
        saved.records[0]
            .get_cell_value(&saved.schema.columns[1])
            .unwrap(),
        "[-2.25,4.125,0.1,0.0]"
    );
    assert_eq!(saved.schema.columns[0].memo_text, "preserve memo");
    assert!(table_mutation::apply(&mut project, patch(&before, 0, "[1,2,3,4]"), None).is_err());
    for bad in [
        "[1,2,3]",
        "#FFFFFF",
        "[NaN,0,0,1]",
        "[0,0,0,1.01]",
        "[1e40,0,0,1]",
    ] {
        let current = project.tables_data[&path].data.clone();
        let disk = std::fs::read(&path).unwrap();
        let history = project.tables_data[&path].undo_history.len();
        assert!(table_mutation::apply(&mut project, patch(&current, 1, bad), None).is_err());
        assert_eq!(
            cell_rules::revision(&current),
            cell_rules::revision(&project.tables_data[&path].data)
        );
        assert_eq!(disk, std::fs::read(&path).unwrap());
        assert_eq!(history, project.tables_data[&path].undo_history.len());
    }
    let id = saved.uuid.clone();
    project.undo_command(&id).unwrap();
    assert!(project.tables_data[&path].data.records[0]
        .get_cell_value(&saved.schema.columns[1])
        .is_none());
    project.redo_command(&id).unwrap();
    let mut reopened = Project::open_project(project.path.to_str().unwrap()).unwrap();
    reopened.load_table(&path).unwrap();
    assert_eq!(
        cell_rules::revision(&saved),
        cell_rules::revision(&reopened.tables_data[&path].data)
    );
    let mut invalid = saved;
    let c = invalid.schema.columns[1].clone();
    invalid.records[0].set_cell_value(&c, "[-2.25,4.125,0.100000001,0]".into());
    assert!(invalid.validate_storage_contract().is_err());
    assert!(toml::from_str::<TableData>(&toml::to_string(&invalid).unwrap()).is_err());
}
#[test]
fn defaults_exports_versions_and_current_type_contract() {
    let (_dir, mut project, path) = fixture();
    let mut data = project.tables_data[&path].data.clone();
    let full = ExportTable::from_table_data(&mut data, ExportMode::Full).unwrap();
    let minimal = ExportTable::from_table_data(&mut data, ExportMode::Minimal).unwrap();
    assert_eq!(full.records[0].values["byte_tint"], "[255,255,255,255]");
    assert_eq!(full.records[0].values["hdr_tint"], "[1.0,1.0,1.0,1.0]");
    assert!(minimal.records[0].values.is_empty());
    assert_eq!(
        minimal.columns[0].default_value.as_deref(),
        Some("[255,255,255,255]")
    );
    assert_eq!(
        minimal.columns[1].default_value.as_deref(),
        Some("[1.0,1.0,1.0,1.0]")
    );
    let old = ExportTable::from_table_data_filtered(&mut data, ExportMode::Full, Some(1)).unwrap();
    assert_eq!(old.columns.len(), 1);
    assert!(!old.records[0].values.contains_key("hdr_tint"));
    assert!(operations::value_type_from_string("Color").is_err());
    assert!(serde_json::from_str::<ValueType>("\"Color\"").is_err());
    assert_eq!(json_export::RUNTIME_SCHEMA_VERSION, 1);
    let id = data.uuid.clone();
    project
        .execute_command(
            AddColumnCommand::new(id.clone(), "new_tint", ValueType::Color32, None, None, None),
            None,
        )
        .unwrap();
    let column = project.tables_data[&path]
        .data
        .schema
        .columns
        .last()
        .unwrap();
    assert_eq!(column.default_value, "[255,255,255,255]");
    let cid = data.schema.columns[1].uuid.clone();
    project
        .execute_command(
            SetColumnDefaultValueCommand::new(id.clone(), cid.clone(), "[-1,2,0.1,0]".into()),
            None,
        )
        .unwrap();
    assert_eq!(
        project.tables_data[&path].data.schema.columns[1].default_value,
        "[-1.0,2.0,0.1,0.0]"
    );
    project
        .execute_command(SetColumnDefaultValueCommand::new(id, cid, "".into()), None)
        .unwrap();
    assert_eq!(
        project.tables_data[&path].data.schema.columns[1].default_value,
        "[1.0,1.0,1.0,1.0]"
    );
}
#[test]
fn interface_defaults_history_revert_and_serialization() {
    let dir = tempfile::tempdir().unwrap();
    let mut interface = Interface::new("Tint".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "tint".into(),
                    data_type: ValueType::ColorFloat,
                    default_value: "[-2,4,0.100000001,0]".into(),
                    memo_text: "keep me".into(),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    let first = interface.current_version_id;
    assert_eq!(interface.columns[0].default_value, "[-2.0,4.0,0.1,0.0]");
    let encoded = serde_json::to_string(&interface.history[&first]).unwrap();
    assert!(encoded.contains("[-2.0,4.0,0.1,0.0]"));
    interface.validate_storage_contract().unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::ChangeDefault {
                column_name: "tint".into(),
                new_default: None,
            }],
            None,
            None,
        )
        .unwrap();
    assert_eq!(interface.columns[0].default_value, "[1.0,1.0,1.0,1.0]");
    let before = interface.current_version_id;
    assert!(interface
        .create_new_version(
            vec![InterfaceChange::ChangeDefault {
                column_name: "tint".into(),
                new_default: Some("[0,0,0,2]".into())
            }],
            None,
            None
        )
        .is_err());
    assert_eq!(interface.current_version_id, before);
    interface.revert_to_version(first, None, None).unwrap();
    assert_eq!(interface.columns[0].default_value, "[-2.0,4.0,0.1,0.0]");
    let path = dir.path().join("Tint.interface.toml");
    interface.save_to_file(&path).unwrap();
    let loaded = Interface::load_from_file(&path).unwrap();
    assert_eq!(
        loaded.columns[0].default_value,
        interface.columns[0].default_value
    );
    assert_eq!(loaded.columns[0].memo_text, "keep me");
}
#[test]
fn interface_type_edit_normalizes_existing_values() {
    let (_dir, mut project, path) = fixture();
    let mut interface = Interface::new("Contract".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "tint".into(),
                    data_type: ValueType::String,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    let mut registry = InterfaceRegistry::new();
    registry.add_interface(interface.clone()).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns.clear();
    table.apply_interface(&interface, &registry, true).unwrap();
    let column = table.data.schema.columns[0].clone();
    table.data.records[0].set_cell_value(&column, "[-1, 2, 0.1, 0]".into());
    interface
        .create_new_version(
            vec![
                InterfaceChange::ModifyColumn {
                    column_name: "tint".into(),
                    old_type: ValueType::String,
                    new_type: ValueType::ColorFloat,
                },
                InterfaceChange::ChangeDefault {
                    column_name: "tint".into(),
                    new_default: None,
                },
            ],
            None,
            None,
        )
        .unwrap();
    *registry.get_interface_mut(&interface.uuid).unwrap() = interface.clone();
    interface.reconcile_table(table, &registry).unwrap();
    let column = &table.data.schema.columns[0];
    assert_eq!(column.data_type, ValueType::ColorFloat);
    assert_eq!(
        table.data.records[0].get_cell_value(column).unwrap(),
        "[-1.0,2.0,0.1,0.0]"
    );
    table.data.validate_storage_contract().unwrap();
}

#[test]
fn messagepack_schema_preserves_color_identity_rgba_and_rejects_unsupported_type() {
    let (_dir, project, path) = fixture();
    let mut original = project.tables_data[&path].data.clone();
    let rgba32 = Color32::new([7, 128, 255, 0]);
    let rgba_float = ColorFloat::from_f64([-2.25, 4.125, 0.1, 0.0]).unwrap();
    for (index, value) in [rgba32.canonical_string(), rgba_float.canonical_string()]
        .into_iter()
        .enumerate()
    {
        let column = original.schema.columns[index].clone();
        original.records[0].set_cell_value(&column, value);
    }

    // Production MessagePack transport uses named maps, including schema enums.
    let bytes = rmp_serde::to_vec_named(&original).unwrap();
    let decoded: TableData = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(decoded.schema.columns[0].data_type, ValueType::Color32);
    assert_eq!(decoded.schema.columns[1].data_type, ValueType::ColorFloat);
    assert_eq!(
        cell_rules::revision(&decoded),
        cell_rules::revision(&original)
    );
    assert_eq!(
        Color32::parse(
            decoded.records[0]
                .get_cell_value(&decoded.schema.columns[0])
                .unwrap()
        )
        .unwrap()
        .channels(),
        [7, 128, 255, 0]
    );
    assert_eq!(
        ColorFloat::parse(
            decoded.records[0]
                .get_cell_value(&decoded.schema.columns[1])
                .unwrap()
        )
        .unwrap()
        .channels()
        .map(f32::to_bits),
        rgba_float.channels().map(f32::to_bits)
    );

    // Reject the retired enum both on its own and inside a complete table schema.
    let unsupported_type = rmp_serde::to_vec_named("Color").unwrap();
    assert!(rmp_serde::from_slice::<ValueType>(&unsupported_type).is_err());
    let mut invalid_table = serde_json::to_value(&original).unwrap();
    invalid_table["schema"]["columns"][0]["data_type"] = json!("Color");
    let invalid_bytes = rmp_serde::to_vec_named(&invalid_table).unwrap();
    assert!(rmp_serde::from_slice::<TableData>(&invalid_bytes).is_err());
}

#[cfg(feature = "p2p")]
#[test]
fn messagepack_mutation_and_committed_broadcast_preserve_typed_colors() {
    use devcel_core::{operations::DevcelOperation, p2p_messages::P2PMessage};

    let (_dir, mut project, path) = fixture();
    let before = project.tables_data[&path].data.clone();
    let mut request = patch(&before, 0, "[7, 128, 255, 0]");
    request
        .cells
        .extend(patch(&before, 1, "[-2.25, 4.125, 0.100000001, 0]").cells);
    let operation = DevcelOperation::ApplyTableMutation { request };
    let bytes = rmp_serde::to_vec_named(&P2PMessage::request(73, operation.clone())).unwrap();
    let decoded: P2PMessage = rmp_serde::from_slice(&bytes).unwrap();
    let P2PMessage::Request {
        id,
        operation: decoded_operation,
    } = decoded
    else {
        panic!("MessagePack request envelope changed");
    };
    assert_eq!(id, 73);
    assert_eq!(decoded_operation, operation);
    let DevcelOperation::ApplyTableMutation { request } = decoded_operation else {
        panic!("MessagePack operation identity changed");
    };
    table_mutation::apply(&mut project, request, None).unwrap();

    // The actual broadcast carries the authoritative snapshot, not a replayed edit.
    let committed = replication::capture(&project).unwrap();
    let broadcast = rmp_serde::to_vec_named(&P2PMessage::broadcast(committed.clone())).unwrap();
    let decoded: P2PMessage = rmp_serde::from_slice(&broadcast).unwrap();
    let P2PMessage::Broadcast { project_state } = decoded else {
        panic!("MessagePack broadcast envelope changed");
    };
    assert_eq!(project_state, committed);
    let table: TableData = serde_json::from_value(
        project_state["tables"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(table.schema.columns[0].data_type, ValueType::Color32);
    assert_eq!(table.schema.columns[1].data_type, ValueType::ColorFloat);
    assert_eq!(
        table.records[0]
            .get_cell_value(&table.schema.columns[0])
            .unwrap(),
        "[7,128,255,0]"
    );
    assert_eq!(
        table.records[0]
            .get_cell_value(&table.schema.columns[1])
            .unwrap(),
        "[-2.25,4.125,0.1,0.0]"
    );
    assert_eq!(
        cell_rules::revision(&table),
        cell_rules::revision(&project.tables_data[&path].data)
    );
}
