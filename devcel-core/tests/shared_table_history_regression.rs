//! Focused integration checks for immutable replacement/history sharing.
use devcel_core::{
    cell_rules::{self, InputRule, InputValidationSettings, ValidationMode},
    commands::Command,
    operation_handler::{LocalOperationHandler, OperationHandler},
    operations::DevcelResponse,
    table_mutation::{self, CellPatch, TableMutation},
    ColumnSchema, Project, Record, SetRecordValueCommand, TableData, TransactionCommand,
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

fn fixture(count: usize) -> (tempfile::TempDir, Project, Vec<PathBuf>) {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "SharedHistory",
        directory.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let mut paths = Vec::new();
    for index in 0..count {
        let path = project
            .create_table(format!("Values{index}.table.toml").into())
            .unwrap();
        project.load_table(&path).unwrap();
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.schema.columns = vec![ColumnSchema {
            data_name: "value".into(),
            display_name: "Value".into(),
            ..Default::default()
        }];
        let mut record = Record::new();
        record.set_value("value", "original".into());
        table.data.records = vec![record];
        std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
        table.is_dirty = false;
        paths.push(path);
    }
    (directory, project, paths)
}

fn edit(project: &mut Project, path: &Path, value: &str) -> devcel_core::Result<()> {
    let table = &project.tables_data[path].data;
    let request = TableMutation {
        table_uuid: table.uuid.clone(),
        expected_revision: cell_rules::revision(table),
        cells: vec![CellPatch {
            record_uuid: table.records[0].uuid.clone(),
            column_uuid: table.schema.columns[0].uuid.clone(),
            value: value.into(),
        }],
        versions: Vec::new(),
        column_versions: Vec::new(),
        create_records: Vec::new(),
        delete_record_uuids: Vec::new(),
        acknowledgement: None,
    };
    table_mutation::apply(project, request, None).map(|_| ())
}

fn value(data: &TableData) -> &str {
    data.records[0].values["value"].as_str()
}

fn assert_live_and_disk(project: &Project, path: &Path, expected: &str) {
    let live = &project.tables_data[path].data;
    let disk: TableData = toml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(value(live), expected);
    assert_eq!(value(&disk), expected);
    assert_eq!(cell_rules::revision(live), cell_rules::revision(&disk));
}

fn last_command(project: &Project, path: &Path) -> Command {
    project.tables_data[path]
        .undo_history
        .last()
        .unwrap()
        .clone()
}

fn batch(project: &Project, paths: &[PathBuf], value: &str) -> TransactionCommand {
    let mut command = TransactionCommand::new("Shared history batch".into());
    for path in paths {
        let table = &project.tables_data[path].data;
        command.add_command(Arc::new(Mutex::new(SetRecordValueCommand::new(
            table.uuid.clone(),
            table.records[0].uuid.clone(),
            table.schema.columns[0].uuid.clone(),
            value.into(),
        ))));
    }
    command
}

#[test]
fn replacement_history_shares_exact_states_and_preserves_multi_step_undo_redo() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    let id = project.tables_data[path].data.uuid.clone();
    edit(&mut project, path, "first").unwrap();
    let first = last_command(&project, path);
    let history = &first.table_snapshots[&id];
    let owned = first
        .data
        .lock()
        .unwrap()
        .shared_table_history_snapshot(&id)
        .unwrap();
    assert!(Arc::ptr_eq(&history.before, &owned.before));
    assert!(Arc::ptr_eq(&history.after, &owned.after));
    assert!(!std::ptr::eq(
        history.after.as_ref(),
        &project.tables_data[path].data
    ));

    // A live mutation cannot change either historical state, and must still
    // fail the history revision check rather than restore an unrelated state.
    project.tables_data.get_mut(path).unwrap().data.records[0]
        .set_value("value", "outside history".into());
    assert_eq!(value(&history.before), "original");
    assert_eq!(value(&history.after), "first");
    assert!(project.undo_command(&id).is_err());
    assert_eq!(project.tables_data[path].undo_history.len(), 1);
    project.tables_data.get_mut(path).unwrap().data.records[0].set_value("value", "first".into());

    edit(&mut project, path, "second").unwrap();
    assert_eq!(project.tables_data[path].undo_history.len(), 2);
    assert_eq!(value(&history.before), "original");
    assert_eq!(value(&history.after), "first");
    for expected in ["first", "original"] {
        project.undo_command(&id).unwrap();
        assert_live_and_disk(&project, path, expected);
    }
    for expected in ["first", "second"] {
        project.redo_command(&id).unwrap();
        assert_live_and_disk(&project, path, expected);
    }
    assert_eq!(value(&history.before), "original");
    assert_eq!(value(&history.after), "first");
}

#[test]
fn branch_edit_and_history_clear_release_shared_states_without_trimming_undo() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    let id = project.tables_data[path].data.uuid.clone();
    edit(&mut project, path, "first").unwrap();
    edit(&mut project, path, "second").unwrap();
    let discarded = {
        let second = last_command(&project, path);
        Arc::downgrade(&second.table_snapshots[&id].after)
    };
    project.undo_command(&id).unwrap();
    assert!(discarded.upgrade().is_some());
    edit(&mut project, path, "branch").unwrap();
    assert!(discarded.upgrade().is_none());
    assert_eq!(project.tables_data[path].undo_history.len(), 2);
    assert!(project.tables_data[path].redo_history.is_empty());
    assert!(project.redo_command(&id).is_err());
    project.undo_command(&id).unwrap();
    assert_live_and_disk(&project, path, "first");
    project.redo_command(&id).unwrap();
    assert_live_and_disk(&project, path, "branch");

    let cleared = {
        let branch = last_command(&project, path);
        Arc::downgrade(&branch.table_snapshots[&id].after)
    };
    project.clear_table_undo_redo_stacks(&id).unwrap();
    assert!(cleared.upgrade().is_none());
    assert!(project.tables_data[path].undo_history.is_empty());
    assert!(project.tables_data[path].redo_history.is_empty());
    assert_live_and_disk(&project, path, "branch");
}

#[test]
fn rejected_replacement_restores_live_state_dirty_flag_and_existing_history() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    project
        .tables_data
        .get_mut(path)
        .unwrap()
        .data
        .schema
        .columns[0]
        .input_validation = Some(InputValidationSettings {
        enabled: true,
        mode: ValidationMode::Reject,
        message: String::new(),
        hint: String::new(),
        rules: vec![InputRule::Required],
    });
    std::fs::write(
        path,
        toml::to_string(&project.tables_data[path].data).unwrap(),
    )
    .unwrap();
    edit(&mut project, path, "first").unwrap();
    let first = last_command(&project, path);
    let bytes = std::fs::read(path).unwrap();
    assert!(matches!(
        edit(&mut project, path, ""),
        Err(devcel_core::DevcelError::InputValidation(_))
    ));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert_live_and_disk(&project, path, "first");
    assert!(!project.tables_data[path].is_dirty);
    assert_eq!(project.tables_data[path].undo_history.len(), 1);
    assert!(project.tables_data[path].redo_history.is_empty());
    assert!(Arc::ptr_eq(&last_command(&project, path).data, &first.data));

    // Disk CAS failure occurs after execute/validation but before publication.
    let mut external = project.tables_data[path].data.clone();
    external.records[0].set_value("value", "external".into());
    let external_bytes = toml::to_string(&external).unwrap();
    std::fs::write(path, &external_bytes).unwrap();
    assert!(edit(&mut project, path, "second").is_err());
    assert_eq!(value(&project.tables_data[path].data), "first");
    assert_eq!(std::fs::read_to_string(path).unwrap(), external_bytes);
    assert!(!project.tables_data[path].is_dirty);
    assert_eq!(project.tables_data[path].undo_history.len(), 1);
    assert!(Arc::ptr_eq(&last_command(&project, path).data, &first.data));
}

#[test]
fn shared_batch_order_undo_redo_and_failed_multi_file_save_remain_atomic() {
    let (_directory, mut project, paths) = fixture(2);
    let ids: Vec<_> = paths
        .iter()
        .map(|path| project.tables_data[path].data.uuid.clone())
        .collect();
    let command = batch(&project, &paths, "batch");
    project.execute_command(command, None).unwrap();
    let first = last_command(&project, &paths[0]);
    let second = last_command(&project, &paths[1]);
    assert!(Arc::ptr_eq(&first.data, &second.data));
    assert!(Arc::ptr_eq(&first.table_snapshots, &second.table_snapshots));
    edit(&mut project, &paths[0], "later").unwrap();
    assert!(project.undo_command(&ids[1]).is_err());
    assert_live_and_disk(&project, &paths[0], "later");
    assert_live_and_disk(&project, &paths[1], "batch");
    project.undo_command(&ids[0]).unwrap();
    project.undo_command(&ids[1]).unwrap();
    for path in &paths {
        assert_live_and_disk(&project, path, "original");
    }
    project.redo_command(&ids[1]).unwrap();
    project.redo_command(&ids[0]).unwrap();
    assert_live_and_disk(&project, &paths[0], "later");
    assert_live_and_disk(&project, &paths[1], "batch");

    let before: Vec<_> = paths
        .iter()
        .map(|path| {
            (
                cell_rules::revision(&project.tables_data[path].data),
                std::fs::read(path).unwrap(),
                project.tables_data[path].undo_history.len(),
            )
        })
        .collect();
    let backup = paths[1].with_extension("backup");
    std::fs::rename(&paths[1], &backup).unwrap();
    std::fs::create_dir(&paths[1]).unwrap();
    let command = batch(&project, &paths, "must rollback");
    assert!(project.execute_command(command, None).is_err());
    for (path, (revision, _, history_len)) in paths.iter().zip(&before) {
        assert_eq!(
            cell_rules::revision(&project.tables_data[path].data),
            *revision
        );
        assert_eq!(project.tables_data[path].undo_history.len(), *history_len);
        assert!(!project.tables_data[path].is_dirty);
    }
    assert_eq!(std::fs::read(&paths[0]).unwrap(), before[0].1);
    assert_eq!(std::fs::read(&backup).unwrap(), before[1].1);
}

#[tokio::test]
async fn replication_echo_preserves_shared_history_and_changed_state_invalidates_it() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    let id = project.tables_data[path].data.uuid.clone();
    edit(&mut project, path, "local").unwrap();
    let first = last_command(&project, path);
    let old_after = first.table_snapshots[&id].after.clone();
    let snapshot = devcel_core::replication::capture(&project).unwrap();
    let persisted = std::fs::read(path).unwrap();
    let handler = LocalOperationHandler::new(Arc::new(tokio::sync::Mutex::new(Some(project))));
    assert!(matches!(
        handler.apply_server_snapshot(snapshot.clone()).await,
        DevcelResponse::Ok(_)
    ));
    {
        let guard = handler.project.lock().await;
        let project = guard.as_ref().unwrap();
        assert!(Arc::ptr_eq(&last_command(project, path).data, &first.data));
    }
    let mut invalid = snapshot.clone();
    invalid["format"] = serde_json::json!(999);
    assert!(matches!(
        handler.apply_server_snapshot(invalid).await,
        DevcelResponse::Error(_)
    ));
    let mut changed = snapshot;
    changed["tables"]["Values0.table.toml"]["records"][0]["values"]["value"] =
        serde_json::json!("remote");
    assert!(matches!(
        handler.apply_server_snapshot(changed).await,
        DevcelResponse::Ok(_)
    ));
    let mut guard = handler.project.lock().await;
    let project = guard.as_mut().unwrap();
    assert_eq!(value(&project.tables_data[path].data), "remote");
    assert!(project.tables_data[path].undo_history.is_empty());
    assert!(project.tables_data[path].redo_history.is_empty());
    assert!(project.undo_command(&id).is_err());
    assert_eq!(value(&old_after), "local");
    assert_eq!(std::fs::read(path).unwrap(), persisted);
}
