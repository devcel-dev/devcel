//! Memo metadata survives identity remapping and interface history workflows.
use devcel_core::{
    operation_handler::{LocalOperationHandler, OperationHandler},
    operations::{DevcelOperation, DevcelResponse},
    ColumnSchema, Interface, InterfaceChange, Project, Record, TableData, ValueType,
};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;

fn project() -> (tempfile::TempDir, Project, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "MemoInterfaces",
        directory.path().to_str().unwrap(),
        "",
        "#22a56a",
    )
    .unwrap();
    let path = project.create_table("Values.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    (directory, project, path)
}

fn column(name: &str, memo: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: ValueType::String,
        memo_text: memo.into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn table_duplication_remaps_local_memo_keys_and_preserves_payloads() {
    let (_directory, mut project, path) = project();
    let mut interface = Interface::new("Stats".into(), None);
    let inherited = column("hp", "Inherited column memo");
    let inherited_id = inherited.uuid.clone();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn { column: inherited }],
            None,
            None,
        )
        .unwrap();
    project
        .interface_registry
        .add_interface_with_path("Stats.interface.toml".into(), interface.clone())
        .unwrap();
    interface
        .save_to_file(&path.parent().unwrap().join("Stats.interface.toml"))
        .unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table
        .apply_interface(&interface, &project.interface_registry, true)
        .unwrap();
    let local = column("note", "Local column memo");
    let local_id = local.uuid.clone();
    table.data.schema.columns.push(local);
    let parent = Record::new();
    let mut child = Record::new();
    child.parent_uuid = parent.uuid.clone();
    child.values.insert("note".into(), "stored value".into());
    child
        .interface_values
        .insert(inherited_id.clone(), "99".into());
    // Memo payloads can resemble identities without becoming references.
    child.memo_texts.insert(local_id.clone(), local_id.clone());
    child
        .memo_texts
        .insert(inherited_id.clone(), format!("日本語\n{local_id}"));
    table.data.records = vec![parent, child];
    project.save_project().unwrap();
    let source_before = serde_json::to_value(&project.tables_data[&path].data).unwrap();
    let source_bytes = std::fs::read(&path).unwrap();
    let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
    let response = handler
        .handle_operation(DevcelOperation::DuplicateTable {
            table_path: "Values.table.toml".into(),
            new_data_name: "MemoCopy".into(),
            new_display_name: "メモの複製".into(),
        })
        .await;
    let DevcelResponse::Ok(value) = response else {
        panic!("{response:?}");
    };
    let copied_path = PathBuf::from(value["new_path"].as_str().unwrap());
    let lock = handler.project.lock().await;
    let project = lock.as_ref().unwrap();
    let copied = &project.tables_data[&copied_path].data;
    let copied_local = copied
        .schema
        .columns
        .iter()
        .find(|column| column.data_name == "note")
        .unwrap();
    let copied_inherited = copied
        .schema
        .columns
        .iter()
        .find(|column| column.data_name == "hp")
        .unwrap();
    assert_ne!(copied_local.uuid, local_id);
    assert_eq!(copied_local.memo_text, "Local column memo");
    assert_eq!(copied_inherited.uuid, inherited_id);
    assert_eq!(copied_inherited.memo_text, "Inherited column memo");
    let copied_child = &copied.records[1];
    assert_eq!(copied_child.memo_texts.len(), 2);
    assert!(!copied_child.memo_texts.contains_key(&local_id));
    assert_eq!(copied_child.memo_texts[&copied_local.uuid], local_id);
    assert_eq!(
        copied_child.memo_texts[&inherited_id],
        format!("日本語\n{local_id}")
    );
    assert_eq!(copied_child.values["note"], "stored value");
    assert_eq!(copied_child.interface_values[&inherited_id], "99");
    assert_eq!(copied_child.parent_uuid, copied.records[0].uuid);
    copied.validate_storage_contract().unwrap();
    let reopened: TableData =
        toml::from_str(&std::fs::read_to_string(copied_path).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(reopened).unwrap(),
        serde_json::to_value(copied).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&project.tables_data[&path].data).unwrap(),
        source_before
    );
    assert_eq!(std::fs::read(path).unwrap(), source_bytes);
}

#[test]
fn interface_memo_history_reopens_rebuilds_and_reconciles_without_losing_cell_memos() {
    let (_directory, mut project, path) = project();
    let mut interface = Interface::new("Details".into(), None);
    let mut inherited = column("detail", "Initial memo");
    inherited.tooltip = "Independent tooltip".into();
    let column_id = inherited.uuid.clone();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn { column: inherited }],
            None,
            None,
        )
        .unwrap();
    let interface_path = path.parent().unwrap().join("Details.interface.toml");
    project
        .interface_registry
        .add_interface_with_path("Details.interface.toml".into(), interface.clone())
        .unwrap();
    interface.save_to_file(&interface_path).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table
        .apply_interface(&interface, &project.interface_registry, true)
        .unwrap();
    let mut record = Record::new();
    record
        .interface_values
        .insert(column_id.clone(), "value".into());
    record
        .memo_texts
        .insert(column_id.clone(), "Cell memo".into());
    table.data.records.push(record);
    project.save_project().unwrap();

    for text in ["変更したメモ\n\"quoted\" 📝", ""] {
        let change = InterfaceChange::ModifyColumnMeta {
            column_name: "detail".into(),
            display_name: None,
            tooltip: None,
            memo_text: Some(text.into()),
            style: None,
        };
        let serialized = serde_json::to_value(&change).unwrap();
        assert_eq!(serialized["ModifyColumnMeta"]["memo_text"], text);
        let change: InterfaceChange = serde_json::from_value(serialized).unwrap();
        interface
            .create_new_version(vec![change], None, None)
            .unwrap();
        interface.save_to_file(&interface_path).unwrap();
        let mut reopened = Interface::load_from_file(&interface_path).unwrap();
        assert_eq!(reopened.columns[0].memo_text, text);
        reopened.rebuild_current_columns().unwrap();
        assert_eq!(reopened.columns[0].memo_text, text);
        assert_eq!(reopened.columns[0].uuid, column_id);
        assert_eq!(reopened.columns[0].tooltip, "Independent tooltip");
        *project
            .interface_registry
            .get_interface_mut(&reopened.uuid)
            .unwrap() = reopened.clone();
        let table = project.tables_data.get_mut(&path).unwrap();
        reopened
            .reconcile_table(table, &project.interface_registry)
            .unwrap();
        assert_eq!(table.data.schema.columns[0].memo_text, text);
        assert_eq!(table.data.schema.columns[0].tooltip, "Independent tooltip");
        assert_eq!(table.data.records[0].memo_texts[&column_id], "Cell memo");
        assert_eq!(table.data.records[0].interface_values[&column_id], "value");
        Project::save_table(table).unwrap();
        let saved: TableData = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.schema.columns[0].memo_text, text);
        assert_eq!(saved.records[0].memo_texts[&column_id], "Cell memo");
        saved.validate_storage_contract().unwrap();
        interface = reopened;
    }
}
