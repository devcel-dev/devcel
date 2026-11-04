//! Inheritance authoring survives operation transport, raw plugin IO and peer snapshots.
use devcel_core::{
    operation_handler::{LocalOperationHandler, OperationHandler},
    operations::{DevcelOperation, DevcelResponse},
    *,
};
use std::sync::Arc;
use tokio::sync::Mutex;

fn fixture() -> (
    tempfile::TempDir,
    Project,
    std::path::PathBuf,
    String,
    String,
    String,
) {
    let dir = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "InheritanceApi",
        dir.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let path = project.create_table("Values.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    let table = &mut project.tables_data.get_mut(&path).unwrap().data;
    let column = ColumnSchema {
        data_name: "value".into(),
        display_name: "Value".into(),
        default_value: "fallback".into(),
        ..Default::default()
    };
    let mut parent = Record::new();
    parent.set_cell_value(&column, "=1+2".into());
    let mut child = Record::new();
    child.parent_uuid = parent.uuid.clone();
    let result = (column.uuid.clone(), parent.uuid.clone(), child.uuid.clone());
    table.schema.columns.push(column);
    table.records.extend([parent, child]);
    Project::save_table(&project.tables_data[&path]).unwrap();
    (dir, project, path, result.0, result.1, result.2)
}

fn ok(response: DevcelResponse) {
    assert!(matches!(response, DevcelResponse::Ok(_)), "{response:?}");
}

#[tokio::test]
async fn input_clear_roundtrips_transport_and_undo() {
    let (_dir, project, path, _column, _parent, child) = fixture();
    let table_uuid = project.tables_data[&path].data.uuid.clone();
    let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
    for value in ["local", ""] {
        let op = DevcelOperation::SetRecordValue {
            table_uuid: table_uuid.clone(),
            record_uuid: child.clone(),
            column_name: "value".into(),
            value: value.into(),
        };
        let wire = rmp_serde::to_vec_named(&op).unwrap();
        let op = rmp_serde::from_slice(&wire).unwrap();
        ok(handler
            .handle_operation(DevcelOperation::ExecuteBatch {
                operations: vec![op],
            })
            .await);
    }
    {
        let p = handler.project.lock().await;
        let data = &p.as_ref().unwrap().tables_data[&path].data;
        assert!(!data.records[1].values.contains_key("value"));
        assert_eq!(
            data.effective_cell_input(&data.records[1], &data.schema.columns[0])
                .unwrap(),
            "=1+2"
        );
        let raw = serde_json::to_value(data).unwrap();
        let checked = plugin_data::validate_table_data(
            p.as_ref().unwrap(),
            &table_uuid,
            serde_json::from_value(raw.clone()).unwrap(),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(checked).unwrap(), raw);
        let mut cleared = data.clone();
        cleared.records[1]
            .values
            .insert("value".into(), String::new());
        let cleared =
            plugin_data::validate_table_data(p.as_ref().unwrap(), &table_uuid, cleared).unwrap();
        assert!(!cleared.records[1].values.contains_key("value"));
        assert_eq!(
            cleared
                .effective_cell_input(&cleared.records[1], &cleared.schema.columns[0])
                .unwrap(),
            "=1+2"
        );
        let mut invalid = data.clone();
        invalid.records[1].parent_uuid = "missing-parent".into();
        assert!(
            plugin_data::validate_table_data(p.as_ref().unwrap(), &table_uuid, invalid).is_err()
        );
    }
    ok(handler
        .handle_operation(DevcelOperation::UndoCommand { table_uuid })
        .await);
    let p = handler.project.lock().await;
    assert_eq!(
        p.as_ref().unwrap().tables_data[&path].data.records[1].values["value"],
        "local"
    );
}
#[tokio::test]
async fn cycle_rejection_and_detach_preserve_formula_input() {
    let (_dir, project, path, _column, parent, child) = fixture();
    let id = project.tables_data[&path].data.uuid.clone();
    let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
    assert!(matches!(
        handler
            .handle_operation(DevcelOperation::SetRecordParentUuid {
                table_uuid: id.clone(),
                record_uuid: parent,
                parent_uuid: child.clone()
            })
            .await,
        DevcelResponse::Error(_)
    ));
    ok(handler
        .handle_operation(DevcelOperation::SetRecordParentUuid {
            table_uuid: id,
            record_uuid: child,
            parent_uuid: String::new(),
        })
        .await);
    let p = handler.project.lock().await;
    let data = &p.as_ref().unwrap().tables_data[&path].data;
    assert_eq!(data.records[1].values["value"], "=1+2");
    assert!(data.records[1].parent_uuid.is_empty());
    let snapshot = replication::capture(p.as_ref().unwrap()).unwrap();
    drop(p);
    ok(handler.apply_server_snapshot(snapshot.clone()).await);
    let p = handler.project.lock().await;
    assert_eq!(replication::capture(p.as_ref().unwrap()).unwrap(), snapshot);
}
