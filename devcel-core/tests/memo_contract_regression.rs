//! Memo metadata uses the same current names in storage, commands and exports.
use devcel_core::{
    json_export::{export_table_metadata_as_json, ExportMode, ExportTable},
    operations::DevcelOperation,
    ColumnSchema, CommandData, Project, Record, SetColumnMemoTextCommand, SetRecordMemoTextCommand,
    TableData,
};

#[test]
fn memo_commands_roundtrip_storage_export_and_undo() {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "MemoContract",
        directory.path().to_str().unwrap(),
        "",
        "#22a56a",
    )
    .unwrap();
    let path = project.create_table("Notes.table.toml".into()).unwrap();
    let column = ColumnSchema {
        data_name: "description".into(),
        display_name: "Description".into(),
        memo_text: "Original column memo".into(),
        ..Default::default()
    };
    let column_id = column.uuid.clone();
    let mut record = Record::new();
    let record_id = record.uuid.clone();
    record
        .memo_texts
        .insert(column_id.clone(), "Original cell memo".into());
    let table = project.tables_data.get_mut(&path).unwrap();
    let table_id = table.data.uuid.clone();
    table.data.schema.columns.push(column);
    table.data.records.push(record);
    let column_text = "Column memo\n日本語 📝";
    let cell_text = "Cell memo\n\"quoted\" \\ path";
    let mut column_command =
        SetColumnMemoTextCommand::new(table_id.clone(), column_id.clone(), column_text.into());
    let mut cell_command =
        SetRecordMemoTextCommand::new(table_id, record_id, column_id.clone(), cell_text.into());
    column_command.execute(&mut project).unwrap();
    cell_command.execute(&mut project).unwrap();
    Project::save_table(&project.tables_data[&path]).unwrap();
    let saved = std::fs::read_to_string(&path).unwrap();
    let reloaded: TableData = toml::from_str(&saved).unwrap();
    assert_eq!(reloaded.schema.columns[0].memo_text, column_text);
    assert_eq!(reloaded.records[0].memo_texts[&column_id], cell_text);
    let wire = serde_json::to_value(&reloaded).unwrap();
    assert_eq!(wire["schema"]["columns"][0]["memo_text"], column_text);
    assert_eq!(wire["records"][0]["memo_texts"][&column_id], cell_text);
    let metadata: serde_json::Value =
        serde_json::from_str(&export_table_metadata_as_json(&reloaded).unwrap()).unwrap();
    assert_eq!(metadata["columns"][0]["memo_text"], column_text);
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        let mut source = reloaded.clone();
        let exported = ExportTable::from_table_data_filtered(&mut source, mode, None).unwrap();
        let data = serde_json::to_value(exported).unwrap();
        assert!(data["columns"][0].get("memo_text").is_none());
        assert!(data["records"][0].get("memo_texts").is_none());
    }
    cell_command.undo(&mut project).unwrap();
    column_command.undo(&mut project).unwrap();
    assert_eq!(
        project.tables_data[&path].data.schema.columns[0].memo_text,
        "Original column memo"
    );
    assert_eq!(
        project.tables_data[&path].data.records[0].memo_texts[&column_id],
        "Original cell memo"
    );
    column_command.execute(&mut project).unwrap();
    cell_command.execute(&mut project).unwrap();
    assert_eq!(
        serde_json::to_value(&project.tables_data[&path].data).unwrap(),
        wire
    );
}

#[test]
fn memo_operations_use_named_json_and_messagepack_contracts() {
    for (name, operation) in [
        (
            "SetColumnMemoText",
            DevcelOperation::SetColumnMemoText {
                table_uuid: "table".into(),
                column_name: "description".into(),
                memo_text: "column".into(),
            },
        ),
        (
            "SetRecordMemoText",
            DevcelOperation::SetRecordMemoText {
                table_uuid: "table".into(),
                record_uuid: "record".into(),
                column_name: "description".into(),
                memo_text: "cell".into(),
            },
        ),
    ] {
        let value = serde_json::to_value(&operation).unwrap();
        assert_eq!(value["op"], name);
        assert!(value["data"].get("memo_text").is_some());
        assert_eq!(
            serde_json::from_value::<DevcelOperation>(value).unwrap(),
            operation
        );
        let encoded = rmp_serde::to_vec_named(&operation).unwrap();
        assert_eq!(
            rmp_serde::from_slice::<DevcelOperation>(&encoded).unwrap(),
            operation
        );
    }
}

#[test]
fn empty_memo_collections_are_omitted_and_default_on_read() {
    let record = serde_json::to_value(Record::new()).unwrap();
    assert!(record.get("memo_texts").is_none());
    assert!(serde_json::from_value::<Record>(record)
        .unwrap()
        .memo_texts
        .is_empty());
    let column = serde_json::to_value(ColumnSchema::default()).unwrap();
    assert!(column.get("memo_text").is_none());
    assert!(serde_json::from_value::<ColumnSchema>(column)
        .unwrap()
        .memo_text
        .is_empty());
}
