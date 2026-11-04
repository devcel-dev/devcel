//! Project vocabulary transactions must touch tags only, including unloaded tables and history.
use devcel_core::{
    cell_rules,
    edit_controls::{self, RecordMetadataRequest},
    project_tags::{self, TagOperation, TagUpdateResult},
    table_mutation::{self, TableMutation},
    ColumnSchema, Project, Record, TableData,
};
use serde_json::json;
use std::path::{Path, PathBuf};

fn fixture(count: usize) -> (tempfile::TempDir, Project, Vec<PathBuf>) {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Tags", dir.path().to_str().unwrap(), "", "#123456").unwrap();
    update(&mut project, TagOperation::Add, "old", None).unwrap();
    update(&mut project, TagOperation::Add, "other", None).unwrap();
    let mut paths = vec![];
    for i in 0..count {
        let path = project
            .create_table(format!("Nested/Values{i}.table.toml").into())
            .unwrap();
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.schema.columns = vec![ColumnSchema {
            data_name: "value".into(),
            display_name: "old".into(),
            tags: vec!["old".into(), "old/suffix".into()],
            ..Default::default()
        }];
        let mut parent = Record::new();
        parent.tags = vec!["old".into(), "foreign".into()];
        parent.set_value("value", "old".into());
        let mut child = Record::new();
        child.parent_uuid = parent.uuid.clone();
        child.tags = vec!["other".into()];
        table.data.records = vec![parent, child];
        std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
        table.is_dirty = false;
        paths.push(path);
    }
    (dir, project, paths)
}
fn update(
    project: &mut Project,
    op: TagOperation,
    name: &str,
    new: Option<&str>,
) -> devcel_core::Result<TagUpdateResult> {
    let state = project_tags::state(project);
    project_tags::update(
        project,
        devcel_core::project_tags::TagUpdateRequest {
            operation: op,
            name,
            new_name: new,
            expected_revision: &state.revision,
            expected_session: &state.project_session,
        },
        None,
        |_| {},
    )
}
fn disk(path: &Path) -> TableData {
    toml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn edit(project: &mut Project, path: &Path, value: &str) {
    let data = &project.tables_data[path].data;
    let req: TableMutation = serde_json::from_value(json!({
        "table_uuid": data.uuid, "expected_revision": cell_rules::revision(data),
        "cells": [{"record_uuid":data.records[0].uuid,"column_uuid":data.schema.columns[0].uuid,"value":value}]
    })).unwrap();
    table_mutation::apply(project, req, None).unwrap();
}
fn tags(project: &mut Project, path: &Path, names: &[&str]) -> devcel_core::Result<()> {
    let data = &project.tables_data[path].data;
    let request = RecordMetadataRequest {
        table_uuid: data.uuid.clone(),
        expected_revision: cell_rules::revision(data),
        record_uuid: data.records[0].uuid.clone(),
        tags: Some(names.iter().map(|s| s.to_string()).collect()),
        memo: None,
    };
    edit_controls::update_record_metadata(project, request, None).map(|_| ())
}

#[test]
fn rename_covers_unloaded_nested_tables_and_only_exact_local_tags() {
    let (_dir, mut project, paths) = fixture(2);
    let before = disk(&paths[1]);
    project.tables_data.remove(&paths[1]);
    let result = update(&mut project, TagOperation::Rename, "old", Some("new")).unwrap();
    assert_eq!(
        (
            result.scanned_tables,
            result.changed_tables,
            result.changed_rows,
            result.changed_columns
        ),
        (2, 2, 2, 2)
    );
    assert!(!project.tables_data.contains_key(&paths[1]));
    for path in &paths {
        let data = disk(path);
        assert_eq!(data.records[0].tags, ["new", "foreign"]);
        assert_eq!(data.schema.columns[0].tags, ["new", "old/suffix"]);
        assert_eq!(data.records[0].values["value"], "old");
        assert_eq!(data.schema.columns[0].display_name, "old");
        assert_eq!(data.records[1].tags, ["other"]);
        assert_eq!(data.records[1].parent_uuid, data.records[0].uuid);
    }
    let mut expected = before;
    expected.records[0].tags[0] = "new".into();
    expected.schema.columns[0].tags[0] = "new".into();
    assert_eq!(
        cell_rules::revision(&expected),
        cell_rules::revision(&disk(&paths[1]))
    );
}

#[test]
fn collision_and_delete_in_use_leave_every_file_and_live_state_unchanged() {
    let (_dir, mut project, paths) = fixture(2);
    let bytes: Vec<_> = paths
        .iter()
        .chain([&project.path])
        .map(|p| std::fs::read(p).unwrap())
        .collect();
    let revision = project_tags::state(&project).revision;
    assert!(update(&mut project, TagOperation::Rename, "old", Some("other")).is_err());
    assert!(update(&mut project, TagOperation::Delete, "old", None).is_err());
    assert_eq!(project_tags::state(&project).revision, revision);
    for (path, expected) in paths.iter().chain([&project.path]).zip(bytes) {
        assert_eq!(std::fs::read(path).unwrap(), expected);
    }
}

#[test]
fn orphans_survive_edits_and_can_be_corrected_but_not_freely_added() {
    let (_dir, mut project, paths) = fixture(1);
    edit(&mut project, &paths[0], "changed");
    assert_eq!(disk(&paths[0]).records[0].tags, ["old", "foreign"]);
    let usage = project_tags::usage(&project).unwrap();
    assert!(
        !usage
            .usage
            .iter()
            .find(|t| t.name == "foreign")
            .unwrap()
            .registered
    );
    tags(&mut project, &paths[0], &["old", "corrected"]).unwrap();
    assert!(tags(
        &mut project,
        &paths[0],
        &["old", "corrected", "unregistered"]
    )
    .is_err());
    tags(&mut project, &paths[0], &["old", "other"]).unwrap();
    assert_eq!(disk(&paths[0]).records[0].tags, ["old", "other"]);
}

#[test]
fn dirty_live_values_are_not_written_by_rename_and_later_save_keeps_new_tags() {
    let (_dir, mut project, paths) = fixture(1);
    let table = project.tables_data.get_mut(&paths[0]).unwrap();
    table.data.records[0].set_value("value", "unsaved".into());
    table.is_dirty = true;
    update(&mut project, TagOperation::Rename, "old", Some("new")).unwrap();
    assert_eq!(disk(&paths[0]).records[0].values["value"], "old");
    let table = &project.tables_data[&paths[0]];
    assert!(table.is_dirty);
    assert_eq!(table.data.records[0].values["value"], "unsaved");
    assert_eq!(table.data.records[0].tags, ["new", "foreign"]);
    project.save_project().unwrap();
    assert_eq!(disk(&paths[0]).records[0].values["value"], "unsaved");
    assert_eq!(disk(&paths[0]).records[0].tags, ["new", "foreign"]);
}

#[test]
fn historical_undo_redo_changes_values_without_resurrecting_old_tags() {
    let (_dir, mut project, paths) = fixture(1);
    edit(&mut project, &paths[0], "first");
    edit(&mut project, &paths[0], "second");
    let id = project.tables_data[&paths[0]].data.uuid.clone();
    project.undo_command(&id).unwrap();
    update(&mut project, TagOperation::Rename, "old", Some("new")).unwrap();
    project.redo_command(&id).unwrap();
    assert_eq!(disk(&paths[0]).records[0].values["value"], "second");
    project.undo_command(&id).unwrap();
    project.undo_command(&id).unwrap();
    assert_eq!(disk(&paths[0]).records[0].values["value"], "old");
    assert_eq!(disk(&paths[0]).records[0].tags, ["new", "foreign"]);
}

#[test]
fn stale_settings_and_cross_project_session_reject_without_writes() {
    let (_dir, mut project, paths) = fixture(1);
    let (_other_dir, other, _) = fixture(1);
    let old = project_tags::state(&project);
    update(&mut project, TagOperation::Add, "later", None).unwrap();
    let before = std::fs::read(&paths[0]).unwrap();
    assert!(project_tags::update(
        &mut project,
        devcel_core::project_tags::TagUpdateRequest {
            operation: TagOperation::Rename,
            name: "old",
            new_name: Some("new"),
            expected_revision: &old.revision,
            expected_session: &old.project_session
        },
        None,
        |_| {}
    )
    .is_err());
    let current = project_tags::state(&project);
    assert!(project_tags::update(
        &mut project,
        devcel_core::project_tags::TagUpdateRequest {
            operation: TagOperation::Rename,
            name: "old",
            new_name: Some("new"),
            expected_revision: &current.revision,
            expected_session: other.get_instance_id()
        },
        None,
        |_| {}
    )
    .is_err());
    assert_eq!(std::fs::read(&paths[0]).unwrap(), before);
    assert_eq!(project_tags::state(&other).presets, ["old", "other"]);
}

#[test]
fn competing_disk_edit_during_scan_aborts_whole_transaction() {
    let (_dir, mut project, paths) = fixture(2);
    let state = project_tags::state(&project);
    let project_before = std::fs::read(&project.path).unwrap();
    let first_before = std::fs::read(&paths[0]).unwrap();
    let second_before = std::fs::read(&paths[1]).unwrap();
    let result = project_tags::update(
        &mut project,
        devcel_core::project_tags::TagUpdateRequest {
            operation: TagOperation::Rename,
            name: "old",
            new_name: Some("new"),
            expected_revision: &state.revision,
            expected_session: &state.project_session,
        },
        None,
        |progress| {
            if progress.phase == "saving" {
                std::fs::write(
                    &paths[1],
                    format!(
                        "{}\n# concurrent edit\n",
                        String::from_utf8(second_before.clone()).unwrap()
                    ),
                )
                .unwrap();
            }
        },
    );
    assert!(result.is_err());
    assert_eq!(std::fs::read(&project.path).unwrap(), project_before);
    assert_eq!(std::fs::read(&paths[0]).unwrap(), first_before);
    assert_eq!(
        project.tables_data[&paths[0]].data.records[0].tags,
        ["old", "foreign"]
    );
    assert_eq!(project_tags::state(&project).revision, state.revision);
}

#[test]
fn unreadable_unloaded_table_aborts_before_any_publication() {
    let (_dir, mut project, paths) = fixture(2);
    project.tables_data.remove(&paths[1]);
    std::fs::write(&paths[1], "this is not TOML").unwrap();
    let first = std::fs::read(&paths[0]).unwrap();
    let project_before = std::fs::read(&project.path).unwrap();
    assert!(update(&mut project, TagOperation::Rename, "old", Some("new")).is_err());
    assert_eq!(std::fs::read(&paths[0]).unwrap(), first);
    assert_eq!(std::fs::read(&project.path).unwrap(), project_before);
}

#[test]
fn pending_save_cannot_restore_old_tags_or_publish_unrelated_dirty_values() {
    use devcel_core::file_save_queue::FileBasedSaveQueueManager;
    use std::sync::Arc;
    let (_dir, mut project, paths) = fixture(1);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let queue = Arc::new(FileBasedSaveQueueManager::new(runtime.handle().clone()));
    let table = project.tables_data.get_mut(&paths[0]).unwrap();
    table.data.records[0].set_value("value", "pending edit".into());
    table.is_dirty = true;
    queue.enqueue_file_sync(
        paths[0].clone(),
        table.clone(),
        devcel_core::SavePriority::Normal,
    );
    let state = project_tags::state(&project);
    let mut phases = vec![];
    project_tags::update(
        &mut project,
        devcel_core::project_tags::TagUpdateRequest {
            operation: TagOperation::Rename,
            name: "old",
            new_name: Some("new"),
            expected_revision: &state.revision,
            expected_session: &state.project_session,
        },
        Some(&queue),
        |event| {
            assert_eq!(event.project_session, state.project_session);
            phases.push(event.phase);
        },
    )
    .unwrap();
    runtime.block_on(async {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        queue.shutdown_all().await;
    });
    assert_eq!(phases, ["scanning", "saving", "complete"]);
    assert_eq!(disk(&paths[0]).records[0].tags, ["new", "foreign"]);
    assert_eq!(disk(&paths[0]).records[0].values["value"], "old");
    assert_eq!(
        project.tables_data[&paths[0]].data.records[0].values["value"],
        "pending edit"
    );
    assert!(project.tables_data[&paths[0]].is_dirty);
}

#[test]
fn deletion_checks_disk_assignments_even_when_live_dirty_tags_were_removed() {
    let (_dir, mut project, paths) = fixture(1);
    let table = project.tables_data.get_mut(&paths[0]).unwrap();
    table.data.records[0].tags.retain(|t| t != "old");
    table.data.schema.columns[0].tags.retain(|t| t != "old");
    table.is_dirty = true;
    assert!(update(&mut project, TagOperation::Delete, "old", None).is_err());
    assert_eq!(disk(&paths[0]).records[0].tags, ["old", "foreign"]);
    project.save_project().unwrap();
    update(&mut project, TagOperation::Delete, "old", None).unwrap();
    assert_eq!(project_tags::state(&project).presets, ["other"]);
}

#[test]
fn rename_preserves_shared_multi_table_history_identity_and_undo_order() {
    use devcel_core::{SetRecordValueCommand, TransactionCommand};
    use std::sync::{Arc, Mutex};
    let (_dir, mut project, paths) = fixture(2);
    let mut batch = TransactionCommand::new("Edit both tables".into());
    for path in &paths {
        let data = &project.tables_data[path].data;
        batch.add_command(Arc::new(Mutex::new(SetRecordValueCommand::new(
            data.uuid.clone(),
            data.records[0].uuid.clone(),
            data.schema.columns[0].uuid.clone(),
            "batch value".into(),
        ))));
    }
    project.execute_command(batch, None).unwrap();
    let id = project.tables_data[&paths[0]].data.uuid.clone();
    let original_command = project.tables_data[&paths[0]]
        .undo_history
        .last()
        .unwrap()
        .data
        .clone();
    update(&mut project, TagOperation::Rename, "old", Some("new")).unwrap();
    for path in &paths {
        let command = project.tables_data[path].undo_history.last().unwrap();
        assert!(Arc::ptr_eq(&original_command, &command.data));
    }
    project.undo_command(&id).unwrap();
    for path in &paths {
        assert_eq!(disk(path).records[0].values["value"], "old");
        assert_eq!(disk(path).records[0].tags, ["new", "foreign"]);
    }
    project.redo_command(&id).unwrap();
    for path in &paths {
        assert_eq!(disk(path).records[0].values["value"], "batch value");
        assert_eq!(disk(path).schema.columns[0].tags, ["new", "old/suffix"]);
    }
}

#[test]
fn inherited_column_tags_rename_locally_without_changing_interface_definition() {
    use devcel_core::{Interface, InterfaceChange};
    let (_dir, mut project, paths) = fixture(1);
    let mut interface = Interface::new("Stats".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "score".into(),
                    display_name: "Score".into(),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    let id = interface.uuid;
    project
        .interface_registry
        .add_interface_with_path("Stats.interface.toml".into(), interface.clone())
        .unwrap();
    project.save_interface(&interface).unwrap();
    project
        .apply_interface_to_table(&paths[0], &id, true)
        .unwrap();
    let interface_path = project
        .path
        .parent()
        .unwrap()
        .join("Tables/Stats.interface.toml");
    let interface_bytes = std::fs::read(&interface_path).unwrap();
    let table = project.tables_data.get_mut(&paths[0]).unwrap();
    let column = table
        .data
        .schema
        .columns
        .iter_mut()
        .find(|c| c.data_name == "score")
        .unwrap();
    assert!(column.interface_origin.is_some());
    column.tags = vec!["old".into()];
    std::fs::write(&paths[0], toml::to_string(&table.data).unwrap()).unwrap();
    table.is_dirty = false;
    update(&mut project, TagOperation::Rename, "old", Some("new")).unwrap();
    assert_eq!(std::fs::read(interface_path).unwrap(), interface_bytes);
    let data = disk(&paths[0]);
    let column = data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "score")
        .unwrap();
    assert_eq!(column.tags, ["new"]);
    assert!(column.interface_origin.is_some());
}

#[test]
fn rename_counts_union_of_dirty_live_and_disk_assignments_by_identity() {
    let (_dir, mut project, paths) = fixture(1);
    let table = project.tables_data.get_mut(&paths[0]).unwrap();
    table.data.records[0].tags.retain(|t| t != "old");
    table.data.schema.columns[0].tags.retain(|t| t != "old");
    table.data.records[1].tags.push("old".into());
    table.is_dirty = true;
    let result = update(&mut project, TagOperation::Rename, "old", Some("new")).unwrap();
    assert_eq!(result.changed_tables, 1);
    assert_eq!(
        result.changed_rows, 2,
        "One disk-only and one live-only row assignment changed"
    );
    assert_eq!(
        result.changed_columns, 1,
        "The disk-only column assignment changed"
    );
    let persisted = disk(&paths[0]);
    assert_eq!(persisted.records[0].tags, ["new", "foreign"]);
    assert_eq!(persisted.records[1].tags, ["other"]);
    let live = &project.tables_data[&paths[0]].data;
    assert_eq!(live.records[0].tags, ["foreign"]);
    assert_eq!(live.records[1].tags, ["other", "new"]);
    assert!(project.tables_data[&paths[0]].is_dirty);
}

#[test]
fn newly_created_table_during_scan_aborts_without_partial_rename() {
    let (_dir, mut project, paths) = fixture(1);
    let state = project_tags::state(&project);
    let project_before = std::fs::read(&project.path).unwrap();
    let original_before = std::fs::read(&paths[0]).unwrap();
    let new_path = paths[0].with_file_name("CreatedDuringScan.table.toml");
    let mut concurrent = disk(&paths[0]);
    concurrent.uuid = uuid::Uuid::new_v4().to_string();
    let new_bytes = toml::to_string(&concurrent).unwrap();
    let result = project_tags::update(
        &mut project,
        devcel_core::project_tags::TagUpdateRequest {
            operation: TagOperation::Rename,
            name: "old",
            new_name: Some("new"),
            expected_revision: &state.revision,
            expected_session: &state.project_session,
        },
        None,
        |event| {
            if event.phase == "saving" {
                std::fs::write(&new_path, &new_bytes).unwrap();
            }
        },
    );
    assert!(result.is_err());
    assert_eq!(std::fs::read(&project.path).unwrap(), project_before);
    assert_eq!(std::fs::read(&paths[0]).unwrap(), original_before);
    assert_eq!(std::fs::read_to_string(&new_path).unwrap(), new_bytes);
    assert_eq!(project_tags::state(&project).revision, state.revision);
    assert_eq!(
        project.tables_data[&paths[0]].data.records[0].tags,
        ["old", "foreign"]
    );
}

#[test]
fn unrelated_table_retains_exact_bytes_and_modification_time() {
    let (_dir, mut project, paths) = fixture(2);
    let table = project.tables_data.get_mut(&paths[1]).unwrap();
    table.data.records[0].tags.retain(|t| t != "old");
    table.data.schema.columns[0].tags.retain(|t| t != "old");
    let bytes = format!(
        "# Keep this author comment and formatting\n{}\n",
        toml::to_string(&table.data).unwrap()
    );
    std::fs::write(&paths[1], &bytes).unwrap();
    let modified = std::fs::metadata(&paths[1]).unwrap().modified().unwrap();
    update(&mut project, TagOperation::Rename, "old", Some("new")).unwrap();
    assert_eq!(std::fs::read_to_string(&paths[1]).unwrap(), bytes);
    assert_eq!(
        std::fs::metadata(&paths[1]).unwrap().modified().unwrap(),
        modified
    );
}

#[test]
fn relative_project_and_absolute_loaded_table_paths_share_one_inventory_entry() {
    let cwd = std::env::current_dir().unwrap();
    let dir = tempfile::tempdir_in(&cwd).unwrap();
    let mut project =
        Project::create_project("Relative", dir.path().to_str().unwrap(), "", "#123456").unwrap();
    update(&mut project, TagOperation::Add, "old", None).unwrap();
    let table_path = project.create_table("Values.table.toml".into()).unwrap();
    let table = project.tables_data.get_mut(&table_path).unwrap();
    let mut record = Record::new();
    record.tags = vec!["old".into()];
    table.data.records.push(record);
    std::fs::write(&table_path, toml::to_string(&table.data).unwrap()).unwrap();
    table.is_dirty = false;
    project.path = project.path.strip_prefix(&cwd).unwrap().to_path_buf();
    let result = update(&mut project, TagOperation::Rename, "old", Some("new")).unwrap();
    assert_eq!(result.scanned_tables, 1);
    assert_eq!(result.changed_rows, 1);
    assert_eq!(disk(&table_path).records[0].tags, ["new"]);
    assert_eq!(
        project.tables_data[&table_path].data.records[0].tags,
        ["new"]
    );
    let reopened = Project::open_project(project.path.to_str().unwrap()).unwrap();
    assert_eq!(project_tags::state(&reopened).presets, ["new"]);
}

#[test]
fn external_registry_reload_refreshes_once_without_touching_orphan_data() {
    let (_dir, mut first, paths) = fixture(1);
    let mut second = Project::open_project(first.path.to_str().unwrap()).unwrap();
    let original_table = std::fs::read(&paths[0]).unwrap();
    update(&mut second, TagOperation::Add, "external", None).unwrap();
    assert!(update(&mut first, TagOperation::Add, "stale addition", None).is_err());
    assert!(project_tags::reload(&mut first).unwrap());
    assert!(!project_tags::reload(&mut first).unwrap());
    assert_eq!(
        project_tags::state(&first).presets,
        ["old", "other", "external"]
    );
    assert_eq!(std::fs::read(&paths[0]).unwrap(), original_table);
    assert_eq!(
        first.tables_data[&paths[0]].data.records[0].tags,
        ["old", "foreign"]
    );
}

#[test]
fn unrelated_pending_save_survives_read_only_scan_without_spurious_notification() {
    use devcel_core::file_save_queue::FileBasedSaveQueueManager;
    use std::sync::{Arc, Mutex};
    let (_dir, mut project, paths) = fixture(2);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let queue = Arc::new(FileBasedSaveQueueManager::new(runtime.handle().clone()));
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let received = notifications.clone();
    queue.set_save_listener(Some(Arc::new(move |path| {
        received.lock().unwrap().push(path.to_path_buf())
    })));
    let table = project.tables_data.get_mut(&paths[1]).unwrap();
    table.data.records[0].tags.retain(|t| t != "old");
    table.data.schema.columns[0].tags.retain(|t| t != "old");
    std::fs::write(&paths[1], toml::to_string(&table.data).unwrap()).unwrap();
    table.data.records[0].set_value("value", "unrelated pending edit".into());
    table.is_dirty = true;
    queue.enqueue_file_sync(
        paths[1].clone(),
        table.clone(),
        devcel_core::SavePriority::Normal,
    );
    let state = project_tags::state(&project);
    project_tags::update(
        &mut project,
        devcel_core::project_tags::TagUpdateRequest {
            operation: TagOperation::Rename,
            name: "old",
            new_name: Some("new"),
            expected_revision: &state.revision,
            expected_session: &state.project_session,
        },
        Some(&queue),
        |_| {},
    )
    .unwrap();
    assert!(
        !notifications.lock().unwrap().contains(&paths[1]),
        "Read-only scanned paths must not emit rename save notifications"
    );
    assert_eq!(disk(&paths[1]).records[0].values["value"], "old");
    runtime.block_on(async {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        queue.shutdown_all().await;
    });
    assert_eq!(
        disk(&paths[1]).records[0].values["value"],
        "unrelated pending edit"
    );
    assert!(notifications.lock().unwrap().contains(&paths[1]));
    assert_eq!(disk(&paths[0]).records[0].tags, ["new", "foreign"]);
}

#[test]
fn structural_table_duplicate_preserves_orphans_under_new_row_and_column_ids() {
    let (_dir, mut project, paths) = fixture(1);
    let source = disk(&paths[0]);
    let destination = paths[0].with_file_name("Copied.table.toml");
    let copied =
        devcel_core::duplicate::duplicate_entry(&mut project, &paths[0], &destination).unwrap();
    let data = disk(&copied);
    assert_ne!(data.uuid, source.uuid);
    assert_ne!(data.records[0].uuid, source.records[0].uuid);
    assert_ne!(data.schema.columns[0].uuid, source.schema.columns[0].uuid);
    assert_eq!(data.records[0].tags, source.records[0].tags);
    assert_eq!(data.schema.columns[0].tags, source.schema.columns[0].tags);
    assert_eq!(data.records[1].parent_uuid, data.records[0].uuid);
    edit(&mut project, &copied, "ordinary edit after copy");
    assert_eq!(disk(&copied).records[0].tags, ["old", "foreign"]);
    assert_eq!(disk(&copied).schema.columns[0].tags, ["old", "old/suffix"]);
}

fn label(project: &mut Project, path: &Path, value: &str) -> devcel_core::Result<()> {
    let data = &project.tables_data[path].data;
    let command = devcel_core::SetRecordLabelCommand::new(
        data.uuid.clone(),
        data.records[0].uuid.clone(),
        value.into(),
    );
    project.execute_command(command, None).map(|_| ())
}

fn persist_fixture(project: &mut Project, path: &Path) {
    let table = project.tables_data.get_mut(path).unwrap();
    std::fs::write(path, toml::to_string(&table.data).unwrap()).unwrap();
    table.is_dirty = false;
    std::fs::write(
        &project.path,
        toml::to_string(&project.project_data).unwrap(),
    )
    .unwrap();
}

#[test]
fn new_preset_and_rename_targets_follow_shared_ascii_identifier_boundaries() {
    let (_dir, mut project, paths) = fixture(1);
    let maximum = "a".repeat(255);
    let too_long = "a".repeat(256);
    for valid in ["A", "_", "_a0", "a_B9", "while", maximum.as_str()] {
        update(&mut project, TagOperation::Add, valid, None).unwrap();
    }
    update(&mut project, TagOperation::Add, "  Trimmed  ", None).unwrap();
    assert!(project_tags::state(&project)
        .presets
        .contains(&"Trimmed".to_owned()));
    for invalid in [
        "",
        " ",
        "1name",
        "bad-name",
        "bad.name",
        "rpg/enemies",
        "two words",
        "日本語",
        "name\nnext",
        "quote\"",
        "back\\slash",
        too_long.as_str(),
    ] {
        let before_project = std::fs::read(&project.path).unwrap();
        let before_table = std::fs::read(&paths[0]).unwrap();
        let state = project_tags::state(&project);
        assert!(
            update(&mut project, TagOperation::Add, invalid, None).is_err(),
            "accepted new preset {invalid:?}"
        );
        assert!(
            update(&mut project, TagOperation::Rename, "old", Some(invalid)).is_err(),
            "accepted rename target {invalid:?}"
        );
        assert_eq!(project_tags::state(&project).revision, state.revision);
        assert_eq!(std::fs::read(&project.path).unwrap(), before_project);
        assert_eq!(std::fs::read(&paths[0]).unwrap(), before_table);
    }
}

#[test]
fn legacy_invalid_preset_sources_can_be_renamed_or_deleted() {
    let (_dir, mut project, paths) = fixture(1);
    project
        .project_data
        .tag_presets
        .extend(["legacy/tag".into(), "未使用".into()]);
    project.tables_data.get_mut(&paths[0]).unwrap().data.records[0]
        .tags
        .push("legacy/tag".into());
    project
        .tables_data
        .get_mut(&paths[0])
        .unwrap()
        .data
        .schema
        .columns[0]
        .tags
        .push("legacy/tag".into());
    persist_fixture(&mut project, &paths[0]);
    update(
        &mut project,
        TagOperation::Rename,
        "legacy/tag",
        Some("LegacyTag"),
    )
    .unwrap();
    assert!(disk(&paths[0]).records[0]
        .tags
        .contains(&"LegacyTag".into()));
    assert!(disk(&paths[0]).schema.columns[0]
        .tags
        .contains(&"LegacyTag".into()));
    assert!(!disk(&paths[0]).records[0]
        .tags
        .contains(&"legacy/tag".into()));
    project
        .project_data
        .tag_presets
        .extend([" legacy spaced ".into(), "".into()]);
    project.tables_data.get_mut(&paths[0]).unwrap().data.records[0]
        .tags
        .push(" legacy spaced ".into());
    persist_fixture(&mut project, &paths[0]);
    update(
        &mut project,
        TagOperation::Rename,
        " legacy spaced ",
        Some("SpacedLegacy"),
    )
    .unwrap();
    assert!(disk(&paths[0]).records[0]
        .tags
        .contains(&"SpacedLegacy".into()));
    assert!(!disk(&paths[0]).records[0]
        .tags
        .contains(&" legacy spaced ".into()));
    update(&mut project, TagOperation::Delete, "", None).unwrap();
    assert!(!project_tags::state(&project)
        .presets
        .iter()
        .any(String::is_empty));
    update(&mut project, TagOperation::Delete, "未使用", None).unwrap();
    assert!(!project_tags::state(&project)
        .presets
        .contains(&"未使用".into()));
}

#[test]
fn new_assignment_and_orphan_corrections_reject_invalid_names_even_if_registered() {
    let (_dir, mut project, paths) = fixture(1);
    project.project_data.tag_presets.push("legacy/tag".into());
    persist_fixture(&mut project, &paths[0]);
    let too_long = "x".repeat(256);
    for invalid in [
        "legacy/tag",
        "日本語",
        "bad-name",
        "bad.name",
        "1first",
        "two words",
        too_long.as_str(),
    ] {
        let before = std::fs::read(&paths[0]).unwrap();
        assert!(
            tags(&mut project, &paths[0], &["old", invalid]).is_err(),
            "accepted orphan correction {invalid:?}"
        );
        assert!(
            tags(&mut project, &paths[0], &["old", "foreign", invalid]).is_err(),
            "accepted new assignment {invalid:?}"
        );
        let mut candidate = project.tables_data[&paths[0]].data.clone();
        candidate.schema.columns[0].tags = vec!["old".into(), invalid.into()];
        let id = candidate.uuid.clone();
        assert!(
            table_mutation::commit_candidate(&mut project, &id, candidate, None, None).is_err(),
            "accepted column orphan correction {invalid:?}"
        );
        assert_eq!(std::fs::read(&paths[0]).unwrap(), before);
    }
    tags(&mut project, &paths[0], &["old", "CorrectedOrphan"]).unwrap();
    tags(&mut project, &paths[0], &["old", "other"]).unwrap();
    assert_eq!(disk(&paths[0]).records[0].tags, ["old", "other"]);
}

#[test]
fn legacy_invalid_tags_and_row_labels_survive_load_unrelated_edit_and_history() {
    let (_dir, mut project, paths) = fixture(1);
    let table = project.tables_data.get_mut(&paths[0]).unwrap();
    table.data.records[0].label = "旧 label/値".into();
    table.data.records[0].tags.push("日本語/旧".into());
    table.data.schema.columns[0].tags.push("列/旧".into());
    persist_fixture(&mut project, &paths[0]);
    let mut reopened = Project::open_project(project.path.to_str().unwrap()).unwrap();
    reopened.load_table(&paths[0]).unwrap();
    edit(&mut reopened, &paths[0], "unrelated change");
    let id = reopened.tables_data[&paths[0]].data.uuid.clone();
    reopened.undo_command(&id).unwrap();
    reopened.redo_command(&id).unwrap();
    let data = disk(&paths[0]);
    assert_eq!(data.records[0].label, "旧 label/値");
    assert!(data.records[0].tags.contains(&"日本語/旧".into()));
    assert!(data.schema.columns[0].tags.contains(&"列/旧".into()));
    label(&mut reopened, &paths[0], "CorrectedLabel").unwrap();
    reopened.undo_command(&id).unwrap();
    assert_eq!(disk(&paths[0]).records[0].label, "旧 label/値");
    reopened.redo_command(&id).unwrap();
    assert_eq!(disk(&paths[0]).records[0].label, "CorrectedLabel");
    label(&mut reopened, &paths[0], "").unwrap();
    assert!(disk(&paths[0]).records[0].label.is_empty());
}

#[test]
fn row_label_creation_and_change_use_shared_identifier_rules_but_allow_clear() {
    let (_dir, mut project, paths) = fixture(1);
    let maximum = "L".repeat(255);
    let too_long = "L".repeat(256);
    for valid in ["A", "_", "_a0", "a_B9", "while", maximum.as_str(), ""] {
        label(&mut project, &paths[0], valid).unwrap();
        assert_eq!(disk(&paths[0]).records[0].label, valid);
    }
    for invalid in [
        " ",
        " trailing ",
        "1name",
        "bad-name",
        "bad.name",
        "row/name",
        "two words",
        "日本語",
        "name\nnext",
        too_long.as_str(),
    ] {
        let before = std::fs::read(&paths[0]).unwrap();
        assert!(
            label(&mut project, &paths[0], invalid).is_err(),
            "accepted label {invalid:?}"
        );
        assert_eq!(std::fs::read(&paths[0]).unwrap(), before);
        let mut candidate = project.tables_data[&paths[0]].data.clone();
        let mut row = Record::new();
        row.label = invalid.into();
        candidate.records.push(row);
        let id = candidate.uuid.clone();
        assert!(
            table_mutation::commit_candidate(&mut project, &id, candidate, None, None).is_err(),
            "accepted newly inserted invalid label {invalid:?}"
        );
        assert_eq!(std::fs::read(&paths[0]).unwrap(), before);
    }
}

#[test]
fn unchanged_raw_space_tags_survive_row_and_column_editor_additions() {
    use devcel_core::column_editor::{self, EditorDraft, EditorMode, EditorRequest, EditorTarget};
    let (_dir, mut project, paths) = fixture(1);
    let table = project.tables_data.get_mut(&paths[0]).unwrap();
    table.data.records[0].tags = vec![" legacy row ".into()];
    table.data.schema.columns[0].tags = vec![" legacy column ".into()];
    persist_fixture(&mut project, &paths[0]);
    tags(&mut project, &paths[0], &[" legacy row ", "other"]).unwrap();
    assert_eq!(disk(&paths[0]).records[0].tags, [" legacy row ", "other"]);
    let data = &project.tables_data[&paths[0]].data;
    let target = EditorTarget {
        mode: EditorMode::Table,
        target_uuid: data.uuid.clone(),
        column_uuid: Some(data.schema.columns[0].uuid.clone()),
        insert_index: None,
    };
    let context = column_editor::load(&project, &target).unwrap();
    let column = context.column;
    let request = EditorRequest {
        target,
        expected_revision: context.revision,
        creation_uuid: None,
        acknowledgement: None,
        acknowledgements: Default::default(),
        draft: EditorDraft {
            display_name: None,
            tags: vec![" legacy column ".into(), "other".into()],
            font_size: column.style.font_size,
            read_only: column.read_only,
            min_version: column.min_version.to_string(),
            name: column.display_name,
            column_type: devcel_core::operations::value_type_to_string(&column.data_type),
            tooltip: column.tooltip,
            memo_text: column.memo_text,
            default_value: column.default_value,
            color: column.style.color,
            reference_config: column.reference_config,
            curve_config: column.curve_config,
            table_ref_config: column.table_ref_config,
            select_config: column.select_config,
            color_swatches: column.color_swatches,
            input_validation: column.input_validation,
            conditional_formatting: column.conditional_formatting,
            conditional_formatting_override: column.conditional_formatting_override,
        },
    };
    column_editor::save(&mut project, request, None).unwrap();
    assert_eq!(
        disk(&paths[0]).schema.columns[0].tags,
        [" legacy column ", "other"]
    );
    let id = project.tables_data[&paths[0]].data.uuid.clone();
    project.undo_command(&id).unwrap();
    assert_eq!(disk(&paths[0]).schema.columns[0].tags, [" legacy column "]);
    project.undo_command(&id).unwrap();
    assert_eq!(disk(&paths[0]).records[0].tags, [" legacy row "]);
}
