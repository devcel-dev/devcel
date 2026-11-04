use devcel_core::{
    commands::check_reference_integrity,
    operation_handler::{LocalOperationHandler, OperationHandler},
    operations::{DevcelOperation, DevcelResponse},
    table_mutation::{self, TableMutation},
    *,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
fn fixture() -> (
    tempfile::TempDir,
    Project,
    PathBuf,
    PathBuf,
    String,
    String,
    String,
    String,
) {
    let dir = tempfile::tempdir().unwrap();
    let mut p =
        Project::create_project("References", dir.path().to_str().unwrap(), "", "#123456").unwrap();
    let a = p.create_table("Targets.table.toml".into()).unwrap();
    p.load_table(&a).unwrap();
    let b = p.create_table("Sources.table.toml".into()).unwrap();
    p.load_table(&b).unwrap();
    let target = Record::new();
    let target_id = target.uuid.clone();
    let source = Record::new();
    let source_id = source.uuid.clone();
    let aid = p.tables_data[&a].data.uuid.clone();
    let bid = p.tables_data[&b].data.uuid.clone();
    p.tables_data.get_mut(&a).unwrap().data.records = vec![target];
    let table = p.tables_data.get_mut(&b).unwrap();
    table.data.records = vec![source];
    table.data.schema.columns = vec![ColumnSchema {
        data_name: "target".into(),
        display_name: "Target".into(),
        data_type: ValueType::Reference,
        reference_config: Some(types::ReferenceConfig {
            target_table_uuid: aid.clone(),
            display_column_uuid: None,
        }),
        ..Default::default()
    }];
    table.data.records[0].set_value("target", target_id.clone());
    for path in [&a, &b] {
        std::fs::write(path, toml::to_string(&p.tables_data[path].data).unwrap()).unwrap();
        p.tables_data.get_mut(path).unwrap().is_dirty = false;
    }
    (dir, p, a, b, aid, bid, target_id, source_id)
}
#[test]
fn unopened_reference_refuses_atomically_and_preview_agrees() {
    let (_d, mut p, a, b, aid, _bid, rid, _) = fixture();
    let before = std::fs::read(&a).unwrap();
    p.tables_data.remove(&b);
    let preview = check_reference_integrity(&mut p, &aid, &rid).unwrap();
    assert!(!preview.can_delete);
    assert_eq!(preview.delete_impact.restrict_count, 1);
    assert!(p
        .execute_command(RemoveRecordCommand::new(aid, rid), None)
        .is_err());
    assert_eq!(p.tables_data[&a].data.records.len(), 1);
    assert!(p.tables_data[&a].undo_history.is_empty());
    assert_eq!(std::fs::read(&a).unwrap(), before);
}
#[test]
fn atomic_cross_table_delete_then_undo_redo() {
    let (_d, mut p, a, b, aid, bid, rid, sid) = fixture();
    let mut batch = TransactionCommand::new("Delete both".into());
    for (table, row) in [(aid.clone(), rid), (bid.clone(), sid)] {
        batch.add_command(Arc::new(Mutex::new(RemoveRecordCommand::new(table, row))));
    }
    p.execute_command(batch, None).unwrap();
    assert!(p.tables_data[&a].data.records.is_empty());
    assert!(p.tables_data[&b].data.records.is_empty());
    p.undo_command(&aid).unwrap();
    assert_eq!(p.tables_data[&a].data.records.len(), 1);
    assert_eq!(p.tables_data[&b].data.records.len(), 1);
    p.redo_command(&bid).unwrap();
    assert!(p.tables_data[&a].data.records.is_empty());
    assert!(p.tables_data[&b].data.records.is_empty());
}
#[test]
fn self_reference_and_selected_mutual_references_can_be_deleted() {
    let (_d, mut p, a, b, aid, _bid, rid, _) = fixture();
    p.tables_data.get_mut(&b).unwrap().data.records.clear();
    let mut second = Record::new();
    let sid = second.uuid.clone();
    second.set_value("target", rid.clone());
    let t = p.tables_data.get_mut(&a).unwrap();
    t.data.schema.columns = vec![ColumnSchema {
        data_name: "target".into(),
        display_name: "Target".into(),
        data_type: ValueType::Reference,
        reference_config: Some(types::ReferenceConfig {
            target_table_uuid: aid.clone(),
            display_column_uuid: None,
        }),
        ..Default::default()
    }];
    t.data.records[0].set_value("target", sid.clone());
    t.data.records.push(second);
    for path in [&a, &b] {
        std::fs::write(path, toml::to_string(&p.tables_data[path].data).unwrap()).unwrap();
    }
    let t = &p.tables_data[&a].data;
    let req = TableMutation {
        table_uuid: aid,
        expected_revision: cell_rules::revision(t),
        delete_record_uuids: vec![rid, sid],
        cells: vec![],
        versions: vec![],
        column_versions: vec![],
        create_records: vec![],
        acknowledgement: None,
    };
    table_mutation::apply(&mut p, req, None).unwrap();
    assert!(p.tables_data[&a].data.records.is_empty());
}
#[test]
fn default_formula_and_interface_values_are_references() {
    for mode in ["default", "formula", "interface"] {
        let (_d, mut p, a, b, aid, _bid, rid, _) = fixture();
        let t = p.tables_data.get_mut(&b).unwrap();
        match mode {
            "default" => {
                t.data.records[0].values.clear();
                t.data.schema.columns[0].default_value = rid.clone();
            }
            "formula" => {
                t.data.records[0].set_value("target", format!("=\"{rid}\""));
            }
            _ => {
                let c = &mut t.data.schema.columns[0];
                c.interface_origin = Some(uuid::Uuid::new_v4().to_string());
                t.data.records[0].values.clear();
                t.data.records[0]
                    .interface_values
                    .insert(c.uuid.clone(), rid.clone());
            }
        }
        std::fs::write(&b, toml::to_string(&t.data).unwrap()).unwrap();
        assert!(
            p.execute_command(RemoveRecordCommand::new(aid, rid), None)
                .is_err(),
            "{mode}"
        );
        assert_eq!(p.tables_data[&a].data.records.len(), 1);
    }
}
#[test]
fn surviving_child_refuses_direct_command() {
    let (_d, mut p, a, b, aid, _bid, rid, _) = fixture();
    p.tables_data.get_mut(&b).unwrap().data.records.clear();
    let mut child = Record::new();
    child.parent_uuid = rid.clone();
    p.tables_data.get_mut(&a).unwrap().data.records.push(child);
    for path in [&a, &b] {
        std::fs::write(path, toml::to_string(&p.tables_data[path].data).unwrap()).unwrap();
    }
    assert!(p
        .execute_command(RemoveRecordCommand::new(aid, rid), None)
        .is_err());
    assert_eq!(p.tables_data[&a].data.records.len(), 2);
}
#[tokio::test]
async fn unified_operations_refuse_delete_and_label_keeps_uuid() {
    let (_d, p, a, _b, aid, _bid, rid, _) = fixture();
    let h = LocalOperationHandler::new(Arc::new(tokio::sync::Mutex::new(Some(p))));
    assert!(matches!(
        h.handle_operation(DevcelOperation::DeleteRecord {
            table_uuid: aid.clone(),
            record_uuid: rid.clone()
        })
        .await,
        DevcelResponse::Error(_)
    ));
    assert!(matches!(
        h.handle_operation(DevcelOperation::SetRecordLabel {
            table_uuid: aid,
            record_uuid: rid.clone(),
            label: "Readable_label".into()
        })
        .await,
        DevcelResponse::Ok(_)
    ));
    let guard = h.project.lock().await;
    let record = &guard.as_ref().unwrap().tables_data[&a].data.records[0];
    assert_eq!(record.uuid, rid);
    assert_eq!(record.label, "Readable_label");
}
#[test]
fn redo_rechecks_new_surviving_references() {
    let (_d, mut p, a, b, aid, _bid, rid, _) = fixture();
    p.tables_data.get_mut(&b).unwrap().data.records[0].set_value("target", String::new());
    std::fs::write(&b, toml::to_string(&p.tables_data[&b].data).unwrap()).unwrap();
    p.execute_command(RemoveRecordCommand::new(aid.clone(), rid.clone()), None)
        .unwrap();
    p.undo_command(&aid).unwrap();
    p.tables_data.get_mut(&b).unwrap().data.records[0].set_value("target", rid);
    std::fs::write(&b, toml::to_string(&p.tables_data[&b].data).unwrap()).unwrap();
    assert!(p.redo_command(&aid).is_err());
    assert_eq!(p.tables_data[&a].data.records.len(), 1);
    assert_eq!(p.tables_data[&a].redo_history.len(), 1);
}
#[tokio::test]
async fn replicated_deletion_refuses_before_replacing_state() {
    let (_d, mut p, a, _b, _aid, _bid, _rid, _) = fixture();
    let mut snapshot = replication::capture(&p).unwrap();
    p.tables_data.remove(&a);
    snapshot["tables"]["Targets.table.toml"]["records"] = serde_json::json!([]);
    let h = LocalOperationHandler::new(Arc::new(tokio::sync::Mutex::new(Some(p))));
    assert!(matches!(
        h.apply_server_snapshot(snapshot.clone()).await,
        DevcelResponse::Error(_)
    ));
    assert_eq!(
        h.project.lock().await.as_ref().unwrap().tables_data[&a]
            .data
            .records
            .len(),
        1
    );
    snapshot["tables"]["Sources.table.toml"]["records"] = serde_json::json!([]);
    assert!(matches!(
        h.apply_server_snapshot(snapshot).await,
        DevcelResponse::Ok(_)
    ));
    assert!(h.project.lock().await.as_ref().unwrap().tables_data[&a]
        .data
        .records
        .is_empty());
}
#[test]
fn inherited_reference_preview_includes_child_after_clear() {
    let (_d, mut p, _a, b, aid, _bid, rid, sid) = fixture();
    let mut child = Record::new();
    child.parent_uuid = sid;
    let child_id = child.uuid.clone();
    p.tables_data.get_mut(&b).unwrap().data.records.push(child);
    let preview = check_reference_integrity(&mut p, &aid, &rid).unwrap();
    assert_eq!(preview.referencing_records.len(), 2);
    assert!(preview
        .referencing_records
        .iter()
        .any(|r| r.record_uuid == child_id));
    p.tables_data.get_mut(&b).unwrap().data.records[1].set_value("target", String::new());
    let preview = check_reference_integrity(&mut p, &aid, &rid).unwrap();
    assert_eq!(preview.referencing_records.len(), 2);
    assert!(preview
        .referencing_records
        .iter()
        .any(|r| r.record_uuid == child_id));
}
#[test]
fn reference_picker_labels_resolve_inherited_formulas_after_clear() {
    let (_d, mut p, a, b, _aid, bid, rid, _sid) = fixture();
    let column = ColumnSchema {
        data_name: "name".into(),
        display_name: "Name".into(),
        ..Default::default()
    };
    let col_id = column.uuid.clone();
    let mut child = Record::new();
    child.parent_uuid = rid;
    let table = p.tables_data.get_mut(&a).unwrap();
    table.data.schema.columns.push(column);
    table.data.records[0].set_value("name", "=\"Parent name\"".into());
    table.data.records.push(child);
    let table = p.tables_data.get_mut(&b).unwrap();
    let reference_id = table.data.schema.columns[0].uuid.clone();
    table.data.schema.columns[0]
        .reference_config
        .as_mut()
        .unwrap()
        .display_column_uuid = Some(col_id);
    let options = commands::get_reference_options(&mut p, &bid, &reference_id).unwrap();
    assert_eq!(options[0].display_value, "1: Parent name");
    assert_eq!(options[1].display_value, "2: Parent name");
    p.tables_data.get_mut(&a).unwrap().data.records[1].set_value("name", String::new());
    let options = commands::get_reference_options(&mut p, &bid, &reference_id).unwrap();
    assert_eq!(options[1].display_value, "2: Parent name");
}

#[test]
fn externally_added_reference_in_loaded_sibling_prevents_stale_delete() {
    let (_dir, mut a, target_path, source_path, target_uuid, source_uuid, target_row, source_row) =
        fixture();
    let column = a.tables_data[&source_path].data.schema.columns[0]
        .uuid
        .clone();
    a.execute_command(
        SetRecordValueCommand::new(
            source_uuid.clone(),
            source_row.clone(),
            column.clone(),
            String::new(),
        ),
        None,
    )
    .unwrap();
    let mut b = Project::open_project(&a.get_project_path()).unwrap();
    b.load_table(&source_path).unwrap();
    b.execute_command(
        SetRecordValueCommand::new(source_uuid, source_row, column, target_row.clone()),
        None,
    )
    .unwrap();
    let target_before = std::fs::read(&target_path).unwrap();
    let source_before = std::fs::read(&source_path).unwrap();
    let memory = serde_json::to_value(&a.tables_data[&target_path].data).unwrap();
    let history = a.tables_data[&target_path].undo_history.len();
    assert!(a
        .execute_command(RemoveRecordCommand::new(target_uuid, target_row), None)
        .is_err());
    assert_eq!(std::fs::read(&target_path).unwrap(), target_before);
    assert_eq!(std::fs::read(&source_path).unwrap(), source_before);
    assert_eq!(
        serde_json::to_value(&a.tables_data[&target_path].data).unwrap(),
        memory
    );
    assert_eq!(a.tables_data[&target_path].undo_history.len(), history);
}
