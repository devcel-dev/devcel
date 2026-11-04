//! Authoring workflow checks for edit controls, persistence and history boundaries.
use devcel_core::{
    cell_rules,
    column_editor::{self, EditorDraft, EditorMode, EditorRequest, EditorTarget},
    commands::{
        AddColumnCommand, AddRecordCommand, RemoveColumnCommand, RemoveRecordCommand,
        SetRecordLabelCommand, SetRecordValueCommand, TransactionCommand, UpdateInterfaceCommand,
    },
    edit_controls::{self, ColumnReadOnlyRequest, TableEditSettingsRequest},
    plugin_data,
    table_mutation::{self, TableMutation},
    ColumnSchema, Interface, InterfaceChange, Project, Record, TableData, TableEditPermissions,
    ValueType,
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

fn fixture(count: usize) -> (tempfile::TempDir, Project, Vec<PathBuf>) {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "EditControls",
        directory.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let mut paths = Vec::new();
    for index in 0..count {
        let path = project
            .create_table(format!("Group/Values{index}.table.toml").into())
            .unwrap();
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.schema.columns = vec![ColumnSchema {
            data_name: "value".into(),
            display_name: "value".into(),
            ..Default::default()
        }];
        let mut row = Record::new();
        row.values.insert("value".into(), "original".into());
        table.data.records = vec![row];
        std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
        table.is_dirty = false;
        paths.push(path);
    }
    (directory, project, paths)
}
fn snapshot(project: &Project, path: &Path) -> TableData {
    project.tables_data[path].data.clone()
}
fn protect(project: &mut Project, path: &Path, permissions: TableEditPermissions) {
    let data = snapshot(project, path);
    edit_controls::update_table_edit_settings(
        project,
        TableEditSettingsRequest {
            display_name: None,
            description: String::new(),
            table_uuid: data.uuid,
            expected_revision: cell_rules::revision(&project.tables_data[path].data),
            initial_transposed: true,
            edit_permissions: permissions,
        },
        None,
    )
    .unwrap();
}
fn lock_column(project: &mut Project, path: &Path, locked: bool) {
    let data = snapshot(project, path);
    edit_controls::set_column_read_only(
        project,
        ColumnReadOnlyRequest {
            expected_revision: cell_rules::revision(&data),
            table_uuid: data.uuid,
            column_uuid: data.schema.columns[0].uuid.clone(),
            read_only: locked,
        },
        None,
    )
    .unwrap();
}
fn edit(project: &mut Project, path: &Path, value: &str) -> devcel_core::Result<()> {
    let data = snapshot(project, path);
    let request: TableMutation = serde_json::from_value(json!({
        "table_uuid":data.uuid,"expected_revision":cell_rules::revision(&data),
        "cells":[{"record_uuid":data.records[0].uuid,"column_uuid":data.schema.columns[0].uuid,"value":value}]
    })).unwrap();
    table_mutation::apply(project, request, None).map(|_| ())
}
fn assert_unchanged(
    project: &Project,
    path: &Path,
    data: &TableData,
    bytes: &[u8],
    history: usize,
) {
    assert_eq!(
        cell_rules::revision(data),
        cell_rules::revision(&project.tables_data[path].data)
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert_eq!(project.tables_data[path].undo_history.len(), history);
    assert!(!project.tables_data[path].is_dirty);
}
fn editor(project: &Project, path: &Path) -> EditorRequest {
    let data = &project.tables_data[path].data;
    let target = EditorTarget {
        mode: EditorMode::Table,
        target_uuid: data.uuid.clone(),
        column_uuid: Some(data.schema.columns[0].uuid.clone()),
        insert_index: None,
    };
    let context = column_editor::load(project, &target).unwrap();
    let column = context.column;
    EditorRequest {
        target,
        expected_revision: context.revision,
        creation_uuid: None,
        acknowledgement: None,
        acknowledgements: Default::default(),
        draft: EditorDraft {
            display_name: None,
            tags: vec![],
            font_size: 12,
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
    }
}

#[test]
fn defaults_required_fields_and_settings_round_trip_with_stale_revision_rejection() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    let before = snapshot(&project, path);
    assert_eq!(
        before.metadata.edit_permissions,
        TableEditPermissions::default()
    );
    assert!(!before.metadata.initial_transposed);
    assert!(!before.schema.columns[0].read_only);
    let request = TableEditSettingsRequest {
        display_name: None,
        description: String::new(),
        table_uuid: before.uuid.clone(),
        expected_revision: cell_rules::revision(&before),
        initial_transposed: true,
        edit_permissions: TableEditPermissions {
            add_rows: false,
            ..Default::default()
        },
    };
    edit_controls::update_table_edit_settings(&mut project, request.clone(), None).unwrap();
    assert!(edit_controls::update_table_edit_settings(&mut project, request, None).is_err());
    let saved = snapshot(&project, path);
    let loaded: TableData = toml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(cell_rules::revision(&saved), cell_rules::revision(&loaded));
    assert_ne!(cell_rules::revision(&before), cell_rules::revision(&saved));
    for field in ["initial_transposed", "edit_permissions"] {
        let mut invalid = serde_json::to_value(&saved).unwrap();
        invalid["metadata"].as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<TableData>(invalid).is_err());
    }
    let mut invalid = serde_json::to_value(&saved).unwrap();
    invalid["schema"]["columns"][0]
        .as_object_mut()
        .unwrap()
        .remove("read_only");
    assert!(serde_json::from_value::<TableData>(invalid).is_err());
    project.undo_command(&before.uuid).unwrap();
    assert_eq!(
        cell_rules::revision(&before),
        cell_rules::revision(&snapshot(&project, path))
    );
    project.redo_command(&before.uuid).unwrap();
    assert_eq!(
        cell_rules::revision(&saved),
        cell_rules::revision(&snapshot(&project, path))
    );
}

#[test]
fn table_protections_reject_structure_cells_row_metadata_and_complete_replace_atomically() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    protect(
        &mut project,
        path,
        TableEditPermissions {
            add_columns: false,
            delete_columns: false,
            add_rows: false,
            delete_rows: false,
            edit_cells: false,
        },
    );
    let before = snapshot(&project, path);
    let bytes = std::fs::read(path).unwrap();
    let history = project.tables_data[path].undo_history.len();
    let id = before.uuid.clone();
    assert!(project
        .execute_command(
            AddColumnCommand::new(id.clone(), "new", ValueType::String, None, None, None),
            None
        )
        .is_err());
    assert!(project
        .execute_command(
            RemoveColumnCommand::new(id.clone(), before.schema.columns[0].uuid.clone()),
            None
        )
        .is_err());
    assert!(project
        .execute_command(AddRecordCommand::new(id.clone()), None)
        .is_err());
    assert!(project
        .execute_command(
            RemoveRecordCommand::new(id.clone(), before.records[0].uuid.clone()),
            None
        )
        .is_err());
    assert!(project
        .execute_command(
            SetRecordLabelCommand::new(
                id.clone(),
                before.records[0].uuid.clone(),
                "changed".into()
            ),
            None
        )
        .is_err());
    assert!(edit(&mut project, path, "changed").is_err());
    for replace in 0..4 {
        let mut candidate = before.clone();
        match replace {
            0 => candidate.records.clear(),
            1 => candidate.schema.columns.push(ColumnSchema {
                data_name: "new".into(),
                ..Default::default()
            }),
            2 => {
                candidate.metadata.edit_permissions = Default::default();
                candidate.records[0]
                    .values
                    .insert("value".into(), "bypass".into());
            }
            _ => candidate.records[0].tags.push("changed".into()),
        }
        assert!(plugin_data::update_table_data(
            &mut project,
            &id,
            &cell_rules::revision(&before),
            serde_json::to_value(candidate).unwrap(),
            None
        )
        .is_err());
    }
    assert_unchanged(&project, path, &before, &bytes, history);
}

#[test]
fn read_only_preserves_existing_inputs_allows_formula_defaults_and_settings_undo() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    let id = snapshot(&project, path).uuid;
    project
        .execute_command(AddRecordCommand::new(id), None)
        .unwrap();
    let mut request = editor(&project, path);
    request.draft.read_only = true;
    request.draft.default_value = "=1+2".into();
    column_editor::save(&mut project, request, None).unwrap();
    let locked = snapshot(&project, path);
    assert_eq!(locked.records[0].values["value"], "original");
    let presentation = devcel_core::formula_context::ProjectFormulaContext::new(&project, None)
        .unwrap()
        .presentation(&locked);
    assert_eq!(
        presentation.cells[&locked.records[1].uuid][&locked.schema.columns[0].uuid].display_value,
        "3"
    );
    for value in ["changed", "", "=9", "original"] {
        assert!(edit(&mut project, path, value).is_err());
    }
    let mut request = editor(&project, path);
    request.draft.default_value = "=3+4".into();
    column_editor::save(&mut project, request, None).unwrap();
    assert_eq!(
        snapshot(&project, path).records[0].values["value"],
        "original"
    );
    let after = snapshot(&project, path);
    let presentation = devcel_core::formula_context::ProjectFormulaContext::new(&project, None)
        .unwrap()
        .presentation(&after);
    assert_eq!(
        presentation.cells[&after.records[1].uuid][&after.schema.columns[0].uuid].display_value,
        "7"
    );
    project.undo_command(&locked.uuid).unwrap();
    assert!(snapshot(&project, path).schema.columns[0].read_only);
    project.undo_command(&locked.uuid).unwrap();
    assert!(!snapshot(&project, path).schema.columns[0].read_only);
    project.redo_command(&locked.uuid).unwrap();
    assert!(snapshot(&project, path).schema.columns[0].read_only);
    let mut candidate = snapshot(&project, path);
    candidate.schema.columns[0].read_only = false;
    candidate.records[0]
        .values
        .insert("value".into(), "bypass".into());
    let revision = cell_rules::revision(&snapshot(&project, path));
    assert!(plugin_data::update_table_data(
        &mut project,
        &locked.uuid,
        &revision,
        serde_json::to_value(candidate).unwrap(),
        None
    )
    .is_err());
    lock_column(&mut project, path, false);
    edit(&mut project, path, "allowed").unwrap();
}

#[test]
fn unrestricted_edits_keep_settings_guards_and_identity_after_file_move() {
    let (_directory, mut project, paths) = fixture(2);
    let path = &paths[0];
    lock_column(&mut project, &paths[1], true);
    let unrelated = snapshot(&project, &paths[1]);
    let unrelated_bytes = std::fs::read(&paths[1]).unwrap();
    let unrelated_history = project.tables_data[&paths[1]].undo_history.len();
    edit(&mut project, path, "allowed").unwrap();
    let before = snapshot(&project, path);
    let bytes = std::fs::read(path).unwrap();
    let history = project.tables_data[path].undo_history.len();
    for setting in 0..3 {
        let mut candidate = before.clone();
        candidate.records[0]
            .values
            .insert("value".into(), "mixed".into());
        match setting {
            0 => candidate.metadata.initial_transposed = true,
            1 => candidate.metadata.edit_permissions.edit_cells = false,
            _ => candidate.schema.columns[0].read_only = true,
        }
        assert!(plugin_data::update_table_data(
            &mut project,
            &before.uuid,
            &cell_rules::revision(&before),
            serde_json::to_value(candidate).unwrap(),
            None
        )
        .is_err());
        assert_unchanged(&project, path, &before, &bytes, history);
    }
    lock_column(&mut project, path, true);
    assert!(edit(&mut project, path, "blocked").is_err());
    project.undo_command(&before.uuid).unwrap();
    let moved = project
        .move_table(path.clone(), path.with_file_name("Moved.table.toml"))
        .unwrap();
    edit(&mut project, &moved, "after move").unwrap();
    project.undo_command(&before.uuid).unwrap();
    assert_eq!(
        snapshot(&project, &moved).records[0].values["value"],
        "allowed"
    );
    project.redo_command(&before.uuid).unwrap();
    assert_eq!(
        snapshot(&project, &moved).records[0].values["value"],
        "after move"
    );
    assert_unchanged(
        &project,
        &paths[1],
        &unrelated,
        &unrelated_bytes,
        unrelated_history,
    );
}

#[test]
fn command_path_lookup_checks_uuid_and_falls_back_after_relocation() {
    // A staged command can relocate loaded tables before the shared validator.
    // Keep files untouched here so this isolates UUID lookup from filesystem moves.
    struct SwapLoadedPaths {
        uuid: String,
        first: PathBuf,
        second: PathBuf,
    }
    impl devcel_core::commands::CommandData for SwapLoadedPaths {
        fn execute(&mut self, project: &mut Project) -> devcel_core::Result<()> {
            let mut first = project.tables_data.remove(&self.first).unwrap();
            let mut second = project.tables_data.remove(&self.second).unwrap();
            first.path = self.second.clone();
            second.path = self.first.clone();
            project.tables_data.insert(self.second.clone(), first);
            project.tables_data.insert(self.first.clone(), second);
            Ok(())
        }
        fn undo(&mut self, _: &mut Project) -> devcel_core::Result<()> {
            Ok(())
        }
        fn get_table_uuid(&self) -> String {
            self.uuid.clone()
        }
        fn should_save(&self) -> bool {
            false
        }
    }
    let (_directory, mut project, paths) = fixture(2);
    lock_column(&mut project, &paths[1], true);
    let before = snapshot(&project, &paths[0]);
    let bytes: Vec<_> = paths.iter().map(|p| std::fs::read(p).unwrap()).collect();
    project
        .execute_command(
            SwapLoadedPaths {
                uuid: before.uuid.clone(),
                first: paths[0].clone(),
                second: paths[1].clone(),
            },
            None,
        )
        .unwrap();
    assert_eq!(
        cell_rules::revision(&before),
        cell_rules::revision(&snapshot(&project, &paths[1]))
    );
    assert_ne!(project.tables_data[&paths[0]].data.uuid, before.uuid);
    for (path, bytes) in paths.iter().zip(bytes) {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn current_deletion_control_blocks_undo_of_an_added_row_without_moving_history() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    protect(
        &mut project,
        path,
        TableEditPermissions {
            delete_rows: false,
            ..Default::default()
        },
    );
    let id = snapshot(&project, path).uuid;
    project
        .execute_command(AddRecordCommand::new(id.clone()), None)
        .unwrap();
    let before = snapshot(&project, path);
    let bytes = std::fs::read(path).unwrap();
    let history = project.tables_data[path].undo_history.len();
    assert!(project.undo_command(&id).is_err());
    assert_unchanged(&project, path, &before, &bytes, history);
    assert!(project.tables_data[path].redo_history.is_empty());
}

#[test]
fn locked_cells_allow_default_only_rows_but_reject_creation_overrides() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    lock_column(&mut project, path, true);
    let before = snapshot(&project, path);
    let request: TableMutation = serde_json::from_value(json!({"table_uuid":before.uuid,
        "expected_revision":cell_rules::revision(&before), "create_records":[{
            "record_uuid":uuid::Uuid::new_v4().to_string(), "values":[{
                "column_uuid":before.schema.columns[0].uuid,"value":"override"}]}]}))
    .unwrap();
    assert!(table_mutation::apply(&mut project, request, None).is_err());
    let batch = table_mutation::prepare_record_batch(
        &project,
        &before.uuid,
        &cell_rules::revision(&before),
        "2",
    )
    .unwrap();
    table_mutation::apply(&mut project, batch, None).unwrap();
    let after = snapshot(&project, path);
    assert_eq!(after.records.len(), 3);
    assert!(after.records[1].values.is_empty());
}

#[test]
fn protected_second_table_rolls_back_a_multi_table_transaction_before_any_save() {
    let (_directory, mut project, paths) = fixture(2);
    lock_column(&mut project, &paths[1], true);
    let before: Vec<_> = paths.iter().map(|p| snapshot(&project, p)).collect();
    let bytes: Vec<_> = paths.iter().map(|p| std::fs::read(p).unwrap()).collect();
    let history: Vec<_> = paths
        .iter()
        .map(|p| project.tables_data[p].undo_history.len())
        .collect();
    let mut transaction = TransactionCommand::new("protected batch".into());
    for table in &before {
        transaction.add_command(Arc::new(Mutex::new(SetRecordValueCommand::new(
            table.uuid.clone(),
            table.records[0].uuid.clone(),
            table.schema.columns[0].uuid.clone(),
            "changed".into(),
        ))));
    }
    assert!(project.execute_command(transaction, None).is_err());
    for i in 0..2 {
        assert_unchanged(&project, &paths[i], &before[i], &bytes[i], history[i]);
    }
}

#[test]
fn interface_derived_add_remove_and_sync_respect_table_controls_atomically() {
    let (_directory, mut project, paths) = fixture(2);
    let mut interface = Interface::new("Stats".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "score".into(),
                    display_name: "score".into(),
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
    for path in &paths {
        project.apply_interface_to_table(path, &id, true).unwrap();
    }
    protect(
        &mut project,
        &paths[1],
        TableEditPermissions {
            add_columns: false,
            delete_columns: false,
            ..Default::default()
        },
    );
    let before: Vec<_> = paths.iter().map(|p| snapshot(&project, p)).collect();
    let bytes: Vec<_> = paths.iter().map(|p| std::fs::read(p).unwrap()).collect();
    let interface_path = paths[0]
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("Stats.interface.toml");
    let interface_bytes = std::fs::read(&interface_path).unwrap();
    for change in [
        InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "extra".into(),
                ..Default::default()
            },
        },
        InterfaceChange::RemoveColumn {
            column_name: "score".into(),
        },
    ] {
        assert!(project
            .execute_command(
                UpdateInterfaceCommand::new(id, vec![change], None, None),
                None
            )
            .is_err());
        assert_eq!(std::fs::read(&interface_path).unwrap(), interface_bytes);
        for i in 0..2 {
            assert_eq!(
                cell_rules::revision(&before[i]),
                cell_rules::revision(&snapshot(&project, &paths[i]))
            );
            assert_eq!(std::fs::read(&paths[i]).unwrap(), bytes[i]);
        }
    }
    // An interface definition arriving externally still cannot bypass the sync boundary.
    project
        .get_interface_mut(&id)
        .unwrap()
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "external".into(),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    assert!(
        table_mutation::sync_interface(&mut project, &before[1].uuid, &id, true, true, None)
            .is_err()
    );
    assert_eq!(std::fs::read(&paths[1]).unwrap(), bytes[1]);
}

#[test]
fn interface_undo_redo_respects_current_column_controls_before_saving_definition() {
    for add_column in [false, true] {
        for redo in [false, true] {
            let (_directory, mut project, paths) = fixture(1);
            let path = &paths[0];
            let mut interface = Interface::new("Stats".into(), None);
            interface
                .create_new_version(
                    vec![InterfaceChange::AddColumn {
                        column: ColumnSchema {
                            data_name: "score".into(),
                            display_name: "score".into(),
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
            project.apply_interface_to_table(path, &id, true).unwrap();
            let table_id = snapshot(&project, path).uuid;
            let change = if add_column {
                InterfaceChange::AddColumn {
                    column: ColumnSchema {
                        data_name: "extra".into(),
                        display_name: "extra".into(),
                        ..Default::default()
                    },
                }
            } else {
                InterfaceChange::RemoveColumn {
                    column_name: "score".into(),
                }
            };
            project
                .execute_command(
                    UpdateInterfaceCommand::new(id, vec![change], None, None),
                    None,
                )
                .unwrap();
            table_mutation::sync_interface(&mut project, &table_id, &id, true, true, None).unwrap();
            if redo {
                project.undo_interface_command(&id.to_string()).unwrap();
                table_mutation::sync_interface(&mut project, &table_id, &id, true, true, None)
                    .unwrap();
            }
            let restores_column = add_column == redo;
            protect(
                &mut project,
                path,
                TableEditPermissions {
                    add_columns: !restores_column,
                    delete_columns: restores_column,
                    ..Default::default()
                },
            );
            let before = snapshot(&project, path);
            let bytes = std::fs::read(path).unwrap();
            let history = project.tables_data[path].undo_history.len();
            let interface_path = path
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("Stats.interface.toml");
            let interface_bytes = std::fs::read(&interface_path).unwrap();
            let version = project.get_interface(&id).unwrap().current_version_id;
            let result = if redo {
                project.redo_interface_command(&id.to_string())
            } else {
                project.undo_interface_command(&id.to_string())
            };
            assert!(result.is_err(), "add={add_column} redo={redo}");
            assert_eq!(
                project.get_interface(&id).unwrap().current_version_id,
                version
            );
            assert_eq!(std::fs::read(&interface_path).unwrap(), interface_bytes);
            assert_unchanged(&project, path, &before, &bytes, history);
            // A rejected replay did not consume or move the interface history entry.
            protect(&mut project, path, TableEditPermissions::default());
            if redo {
                project.redo_interface_command(&id.to_string()).unwrap();
            } else {
                project.undo_interface_command(&id.to_string()).unwrap();
            }
        }
    }
}

#[test]
fn interface_column_read_only_is_table_local_and_survives_reopen_and_sync() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    let mut interface = Interface::new("Stats".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "score".into(),
                    display_name: "score".into(),
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
    project.apply_interface_to_table(path, &id, true).unwrap();
    let before = snapshot(&project, path);
    let column_uuid = before
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "score")
        .unwrap()
        .uuid
        .clone();
    let interface_path = path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("Stats.interface.toml");
    let interface_bytes = std::fs::read(&interface_path).unwrap();
    edit_controls::set_column_read_only(
        &mut project,
        ColumnReadOnlyRequest {
            expected_revision: cell_rules::revision(&before),
            table_uuid: before.uuid.clone(),
            column_uuid: column_uuid.clone(),
            read_only: true,
        },
        None,
    )
    .unwrap();
    assert_eq!(std::fs::read(&interface_path).unwrap(), interface_bytes);
    let mut reopened = Project::open_project(project.path.to_str().unwrap()).unwrap();
    reopened
        .ensure_table_loaded_with_save_queue(path, None, None)
        .unwrap();
    assert!(
        reopened.tables_data[path]
            .data
            .schema
            .columns
            .iter()
            .find(|c| c.uuid == column_uuid)
            .unwrap()
            .read_only
    );
    reopened
        .get_interface_mut(&id)
        .unwrap()
        .create_new_version(
            vec![InterfaceChange::ChangeDefault {
                column_name: "score".into(),
                new_default: Some("updated default".into()),
            }],
            None,
            None,
        )
        .unwrap();
    table_mutation::sync_interface(&mut reopened, &before.uuid, &id, true, true, None).unwrap();
    let after = snapshot(&reopened, path);
    let column = after
        .schema
        .columns
        .iter()
        .find(|c| c.uuid == column_uuid)
        .unwrap();
    assert!(column.read_only);
    assert_eq!(column.default_value, "updated default");
    assert_eq!(after.records[0].values, before.records[0].values);
    let stored: TableData = toml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(
        stored
            .schema
            .columns
            .iter()
            .find(|c| c.uuid == column_uuid)
            .unwrap()
            .read_only
    );
}

#[test]
fn whole_table_and_folder_deletion_cannot_erase_unloaded_protected_tables() {
    let (_directory, mut project, paths) = fixture(2);
    protect(
        &mut project,
        &paths[1],
        TableEditPermissions {
            delete_rows: false,
            ..Default::default()
        },
    );
    project.tables_data.remove(&paths[1]);
    assert!(project.delete_table(paths[1].clone()).is_err());
    assert!(project.delete_directory("Group".into()).is_err());
    assert!(paths.iter().all(|p| p.exists()));
    assert!(project.tables_data.contains_key(&paths[0]));
}

#[tokio::test]
async fn typed_document_apis_reject_table_and_project_paths_before_mutation() {
    use devcel_core::{
        operation_handler::{LocalOperationHandler, OperationHandler},
        operations::{DevcelOperation, DevcelResponse},
    };
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    let table_bytes = std::fs::read(path).unwrap();
    let project_path = project.path.clone();
    let project_bytes = std::fs::read(&project_path).unwrap();
    for path in [path, &project_path] {
        assert!(project.delete_markdown(path.clone()).is_err());
        assert!(project.delete_interface(path.clone()).is_err());
    }
    let handler = LocalOperationHandler::new(Arc::new(tokio::sync::Mutex::new(Some(project))));
    for target in [path, &project_path] {
        let response = handler
            .handle_operation(DevcelOperation::WriteMarkdownFile {
                file_path: target.to_string_lossy().into(),
                content: "not table data".into(),
            })
            .await;
        assert!(matches!(response, DevcelResponse::Error(_)));
    }
    let markdown = path.with_file_name("Notes.md");
    assert!(matches!(
        handler
            .handle_operation(DevcelOperation::WriteMarkdownFile {
                file_path: markdown.to_string_lossy().into(),
                content: "# valid markdown".into()
            })
            .await,
        DevcelResponse::Ok(_)
    ));
    assert!(matches!(
        handler
            .handle_operation(DevcelOperation::MoveMarkdownFile {
                old_path: markdown.to_string_lossy().into(),
                new_path: path.to_string_lossy().into()
            })
            .await,
        DevcelResponse::Error(_)
    ));
    assert_eq!(std::fs::read(path).unwrap(), table_bytes);
    assert_eq!(std::fs::read(&project_path).unwrap(), project_bytes);
    assert_eq!(
        std::fs::read_to_string(markdown).unwrap(),
        "# valid markdown"
    );
}

#[test]
fn table_creation_and_relocation_cannot_change_document_type_or_replace_protected_files() {
    let (_directory, mut project, paths) = fixture(2);
    let path = &paths[0];
    protect(
        &mut project,
        path,
        TableEditPermissions {
            delete_rows: false,
            ..Default::default()
        },
    );
    let before = snapshot(&project, path);
    let bytes = std::fs::read(path).unwrap();
    let history = project.tables_data[path].undo_history.len();
    for filename in [
        "Notes.md",
        "Notes.interface.toml",
        "Notes.devcelproj.toml",
        "Notes",
    ] {
        let destination = path.with_file_name(filename);
        assert!(project.create_table(destination.clone()).is_err());
        assert!(project
            .move_table(path.clone(), destination.clone())
            .is_err());
        assert!(!destination.exists());
        assert_eq!(project.tables_data[path].path, *path);
        assert_unchanged(&project, path, &before, &bytes, history);
    }
    assert!(project
        .rename_interface_file(path.to_str().unwrap(), "Converted")
        .is_err());
    let copied = devcel_core::duplicate::duplicate_entry(&mut project, &paths[1], path).unwrap();
    assert_ne!(copied, *path);
    assert_unchanged(&project, path, &before, &bytes, history);
    let markdown = path.with_file_name("Notes.md");
    std::fs::write(&markdown, "# Notes").unwrap();
    assert!(project
        .move_table(
            markdown.clone(),
            path.with_file_name("Converted.table.toml")
        )
        .is_err());
    assert_eq!(std::fs::read_to_string(markdown).unwrap(), "# Notes");
}

#[test]
fn changing_a_lock_and_converting_raw_values_requires_separate_saves() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    edit(&mut project, path, "[1, 2, 3, 4]").unwrap();
    let before = snapshot(&project, path);
    let bytes = std::fs::read(path).unwrap();
    let history = project.tables_data[path].undo_history.len();
    let mut request = editor(&project, path);
    request.draft.read_only = true;
    request.draft.column_type = "Color32".into();
    request.draft.default_value = "[255,255,255,255]".into();
    assert!(column_editor::save(&mut project, request.clone(), None).is_err());
    assert_unchanged(&project, path, &before, &bytes, history);
    request.draft.read_only = false;
    column_editor::save(&mut project, request, None).unwrap();
    assert_eq!(
        snapshot(&project, path).records[0].values["value"],
        "[1,2,3,4]"
    );
    lock_column(&mut project, path, true);
}

#[test]
fn authoring_controls_never_enter_runtime_metadata_exports() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    lock_column(&mut project, path, true);
    protect(
        &mut project,
        path,
        TableEditPermissions {
            edit_cells: false,
            ..Default::default()
        },
    );
    let table = snapshot(&project, path);
    let metadata = serde_json::to_value(
        devcel_core::json_export::ExportTableMetadata::from_table_data(&table),
    )
    .unwrap();
    assert!(metadata.get("initial_transposed").is_none());
    assert!(metadata.get("edit_permissions").is_none());
    assert!(metadata["columns"][0].get("read_only").is_none());
}

#[test]
fn metadata_edits_round_trip_history_and_uuid_memos() {
    let (_dir, mut project, paths) = fixture(1);
    for name in ["alpha", "translation", "column"] {
        let state = devcel_core::project_tags::state(&project);
        devcel_core::project_tags::update(
            &mut project,
            devcel_core::project_tags::TagUpdateRequest {
                operation: devcel_core::project_tags::TagOperation::Add,
                name,
                new_name: None,
                expected_revision: &state.revision,
                expected_session: &state.project_session,
            },
            None,
            |_| {},
        )
        .unwrap();
    }
    let path = &paths[0];
    let before = snapshot(&project, path);
    let record_uuid = before.records[0].uuid.clone();
    let column_uuid = before.schema.columns[0].uuid.clone();
    let request = edit_controls::RecordMetadataRequest {
        table_uuid: before.uuid.clone(),
        expected_revision: cell_rules::revision(&before),
        record_uuid: record_uuid.clone(),
        tags: Some(vec![" alpha ".into(), "alpha".into(), "translation".into()]),
        memo: Some(edit_controls::CellMemo {
            column_uuid: column_uuid.clone(),
            text: "Cell memo\nSecond line".into(),
        }),
    };
    let result =
        edit_controls::update_record_metadata(&mut project, request.clone(), None).unwrap();
    assert_eq!(result.table.records[0].tags, vec!["alpha", "translation"]);
    assert_eq!(
        result.table.records[0].memo_texts[&column_uuid],
        "Cell memo\nSecond line"
    );
    assert!(edit_controls::update_record_metadata(&mut project, request, None).is_err());
    let loaded: TableData = toml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(
        loaded.records[0].memo_texts,
        result.table.records[0].memo_texts
    );
    project.undo_command(&before.uuid).unwrap();
    assert_eq!(
        snapshot(&project, path).records[0].memo_texts,
        before.records[0].memo_texts
    );
    project.redo_command(&before.uuid).unwrap();
    let mut change = editor(&project, path);
    change.draft.name = "renamed".into();
    change.draft.tags = vec![" column ".into(), "column".into()];
    change.draft.font_size = 18;
    column_editor::save(&mut project, change, None).unwrap();
    let saved = snapshot(&project, path);
    assert_eq!(saved.schema.columns[0].style.font_size, 18);
    assert_eq!(saved.schema.columns[0].tags, vec!["column"]);
    assert!(saved.records[0].memo_texts.contains_key(&column_uuid));
    assert!(!saved.records[0].memo_texts.contains_key("renamed"));
    let mut change = editor(&project, path);
    change.draft.font_size = 0;
    assert!(column_editor::save(&mut project, change, None).is_err());
    lock_column(&mut project, path, true);
    let data = snapshot(&project, path);
    let revision = cell_rules::revision(&data);
    assert!(edit_controls::update_record_metadata(
        &mut project,
        edit_controls::RecordMetadataRequest {
            table_uuid: data.uuid,
            expected_revision: revision,
            record_uuid,
            tags: None,
            memo: Some(edit_controls::CellMemo {
                column_uuid,
                text: "blocked".into()
            })
        },
        None
    )
    .is_err());
}

#[test]
fn table_description_save_and_undo() {
    let (_dir, mut project, paths) = fixture(1);
    let path = &paths[0];
    let before = snapshot(&project, path);
    edit_controls::update_table_edit_settings(
        &mut project,
        TableEditSettingsRequest {
            display_name: None,
            table_uuid: before.uuid.clone(),
            expected_revision: cell_rules::revision(&before),
            initial_transposed: before.metadata.initial_transposed,
            edit_permissions: before.metadata.edit_permissions.clone(),
            description: "Description\n日本語".into(),
        },
        None,
    )
    .unwrap();
    let saved = snapshot(&project, path);
    assert_eq!(saved.description, "Description\n日本語");
    project.undo_command(&before.uuid).unwrap();
    assert_eq!(snapshot(&project, path).description, before.description);
    project.redo_command(&before.uuid).unwrap();
    assert_eq!(snapshot(&project, path).description, saved.description);
}

#[test]
fn interface_display_label_is_independent_of_validated_data_name_and_undoable() {
    let (_directory, mut project, paths) = fixture(1);
    let mut interface = Interface::new("Stats".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "score".into(),
                    display_name: "score".into(),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    let id = interface.uuid;
    let column_uuid = interface.columns[0].uuid.clone();
    project
        .interface_registry
        .add_interface_with_path("Stats.interface.toml".into(), interface.clone())
        .unwrap();
    project.save_interface(&interface).unwrap();
    let target = EditorTarget {
        mode: EditorMode::Interface,
        target_uuid: id.to_string(),
        column_uuid: Some(column_uuid),
        insert_index: None,
    };
    let context = column_editor::load(&project, &target).unwrap();
    let mut request = editor(&project, &paths[0]);
    request.draft = serde_json::from_value(serde_json::json!({
        "name": context.column.data_name, "display_name": "得点 / Score",
        "column_type": devcel_core::operations::value_type_to_string(&context.column.data_type),
        "min_version": context.column.min_version.to_string(), "read_only": context.column.read_only,
        "tooltip": context.column.tooltip, "memo_text": context.column.memo_text,
        "default_value": context.column.default_value, "color": context.column.style.color,
        "tags": context.column.tags, "font_size": context.column.style.font_size,
        "reference_config": context.column.reference_config, "curve_config": context.column.curve_config,
        "table_ref_config": context.column.table_ref_config, "select_config": context.column.select_config,
        "color_swatches": context.column.color_swatches
    })).unwrap();
    request.target = target;
    request.expected_revision = context.revision;
    column_editor::save(&mut project, request.clone(), None).unwrap();
    let field = &project.get_interface(&id).unwrap().columns[0];
    assert_eq!(field.data_name, "score");
    assert_eq!(field.display_name, "得点 / Score");
    project.undo_interface_command(&id.to_string()).unwrap();
    assert_eq!(
        project.get_interface(&id).unwrap().columns[0].display_name,
        "score"
    );
    project.redo_interface_command(&id.to_string()).unwrap();
    request.expected_revision = column_editor::load(&project, &request.target)
        .unwrap()
        .revision;
    request.draft.name = "not a valid / identifier".into();
    assert!(column_editor::save(&mut project, request.clone(), None).is_err());
    assert_eq!(
        project.get_interface(&id).unwrap().columns[0].data_name,
        "score"
    );
    request.draft.name = "score".into();
    request.draft.display_name = Some(String::new());
    column_editor::save(&mut project, request, None).unwrap();
    assert_eq!(
        project.get_interface(&id).unwrap().columns[0].display_name,
        "score"
    );
}

#[test]
fn settings_display_name_is_independent_validated_and_undoable() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    let before = snapshot(&project, path);
    let request = |name: &str| TableEditSettingsRequest {
        table_uuid: before.uuid.clone(),
        expected_revision: cell_rules::revision(&before),
        display_name: Some(name.into()),
        description: before.description.clone(),
        initial_transposed: before.metadata.initial_transposed,
        edit_permissions: before.metadata.edit_permissions.clone(),
    };
    assert!(edit_controls::update_table_edit_settings(&mut project, request("  "), None).is_err());
    assert_eq!(
        cell_rules::revision(&before),
        cell_rules::revision(&snapshot(&project, path))
    );
    edit_controls::update_table_edit_settings(&mut project, request("  表示名  "), None).unwrap();
    let after = snapshot(&project, path);
    assert_eq!(after.display_name, "表示名");
    assert_eq!(after.metadata.data_name, before.metadata.data_name);
    assert_eq!(after.uuid, before.uuid);
    project.undo_command(&before.uuid).unwrap();
    assert_eq!(
        cell_rules::revision(&before),
        cell_rules::revision(&snapshot(&project, path))
    );
}

#[test]
fn legacy_user_settings_get_lossless_structural_protection() {
    let (_directory, mut project, paths) = fixture(1);
    let path = &paths[0];
    let mut legacy = snapshot(&project, path);
    legacy.uuid = edit_controls::USER_SETTINGS_UUID.into();
    legacy.metadata.edit_permissions = TableEditPermissions::default();
    legacy.metadata.initial_transposed = false;
    // Even a damaged multi-row installation is preserved for explicit recovery.
    legacy.records.push(Record::new());
    let mut upgraded: TableData = toml::from_str(&toml::to_string(&legacy).unwrap()).unwrap();
    assert_eq!(upgraded.records.len(), 2);
    assert_eq!(upgraded.records[0].uuid, legacy.records[0].uuid);
    assert_eq!(upgraded.records[0].values, legacy.records[0].values);
    assert!(upgraded.metadata.initial_transposed);
    assert!(!upgraded.metadata.edit_permissions.add_rows);
    assert!(!upgraded.metadata.edit_permissions.delete_rows);
    upgraded.metadata.initial_transposed = false;
    let reopened: TableData = toml::from_str(&toml::to_string(&upgraded).unwrap()).unwrap();
    assert!(!reopened.metadata.initial_transposed);
    project.tables_data.get_mut(path).unwrap().data = upgraded.clone();
    std::fs::write(path, toml::to_string(&upgraded).unwrap()).unwrap();
    let unlock = TableEditSettingsRequest {
        table_uuid: upgraded.uuid.clone(),
        expected_revision: cell_rules::revision(&upgraded),
        display_name: None,
        description: upgraded.description.clone(),
        initial_transposed: false,
        edit_permissions: TableEditPermissions::default(),
    };
    assert!(edit_controls::update_table_edit_settings(&mut project, unlock, None).is_err());
    assert!(project
        .execute_command(AddRecordCommand::new(upgraded.uuid.clone()), None)
        .is_err());
    assert_eq!(snapshot(&project, path).records.len(), 2);
}

#[test]
fn plugin_complete_root_identity_payload_roundtrips_update() {
    let (_directory, mut project, paths) = fixture(1);
    let before = snapshot(&project, &paths[0]);
    let mut wire = serde_json::to_value(&before).unwrap();
    assert_eq!(wire["uuid"], before.uuid);
    assert!(wire["metadata"].get("uuid").is_none());
    assert!(wire.get("interface_order").is_none());
    assert!(wire["metadata"].get("interface_order").is_some());
    wire["display_name"] = json!("Plugin edited display");
    plugin_data::update_table_data(
        &mut project,
        &before.uuid,
        &cell_rules::revision(&before),
        wire,
        None,
    )
    .unwrap();
    let after = snapshot(&project, &paths[0]);
    assert_eq!(after.uuid, before.uuid);
    assert_eq!(after.display_name, "Plugin edited display");
    assert_eq!(
        serde_json::to_value(&after.records).unwrap(),
        serde_json::to_value(&before.records).unwrap()
    );
    assert_eq!(
        after.metadata.interface_order,
        before.metadata.interface_order
    );
}
#[test]
fn shortcut_bulk_cells_and_version_validate_before_any_write_and_one_undo_restores_all() {
    use cell_rules::{InputRule, InputValidationSettings, ValidationMode};
    for mode in [ValidationMode::Reject, ValidationMode::Warn] {
        let (_directory, mut project, paths) = fixture(1);
        let path = &paths[0];
        let data = &mut project.tables_data.get_mut(path).unwrap().data;
        data.schema.columns.push(ColumnSchema {
            data_name: "amount".into(),
            display_name: "Amount".into(),
            data_type: ValueType::I32,
            input_validation: Some(InputValidationSettings {
                enabled: true,
                mode: mode.clone(),
                message: String::new(),
                hint: String::new(),
                rules: vec![InputRule::NumberRange {
                    min: Some("0".into()),
                    max: Some("20".into()),
                }],
            }),
            ..Default::default()
        });
        data.records[0].values.insert("amount".into(), "10".into());
        std::fs::write(path, toml::to_string(data).unwrap()).unwrap();
        let before = snapshot(&project, path);
        let bytes = std::fs::read(path).unwrap();
        let mut request: TableMutation = serde_json::from_value(json!({
            "table_uuid":before.uuid,"expected_revision":cell_rules::revision(&before),
            "cells":[
                {"record_uuid":before.records[0].uuid,"column_uuid":before.schema.columns[0].uuid,"value":"changed text"},
                {"record_uuid":before.records[0].uuid,"column_uuid":before.schema.columns[1].uuid,"value":"25"}],
            "versions":[{"record_uuid":before.records[0].uuid,"min_version":"2"}]
        })).unwrap();
        let error = table_mutation::apply(&mut project, request.clone(), None)
            .err()
            .unwrap();
        assert_unchanged(&project, path, &before, &bytes, 0);
        let devcel_core::DevcelError::InputValidation(report) = error else {
            panic!("expected native input validation");
        };
        if matches!(mode, ValidationMode::Warn) {
            request.acknowledgement = report.acknowledgement;
            assert!(request.acknowledgement.is_some());
        } else {
            request.cells[1].value = "15".into();
        }
        table_mutation::apply(&mut project, request, None).unwrap();
        assert_eq!(project.tables_data[path].undo_history.len(), 1);
        assert_eq!(
            snapshot(&project, path).records[0].values["value"],
            "changed text"
        );
        assert_eq!(snapshot(&project, path).records[0].min_version, 2);
        project.undo_command(&before.uuid).unwrap();
        assert_eq!(
            cell_rules::revision(&snapshot(&project, path)),
            cell_rules::revision(&before)
        );
    }
}
