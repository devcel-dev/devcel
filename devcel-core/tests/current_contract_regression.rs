//! End-to-end regressions for the single prerelease storage/API contract.
use devcel_core::{
    column_editor::EditorTarget,
    interface::{ConflictResolution, MergeInfo, ResolutionType},
    operation_handler::{LocalOperationHandler, OperationHandler},
    operations::{value_type_from_string, DevcelOperation, DevcelResponse},
    *,
};
use serde_json::json;
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
use uuid::Uuid;

fn project() -> (tempfile::TempDir, Project, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "CurrentContract",
        directory.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let path = project.create_table("Values.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    (directory, project, path)
}
fn column(name: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        ..Default::default()
    }
}

#[test]
fn saved_schema_rejects_unsupported_fields_aliases_and_missing_collections() {
    let (_directory, project, path) = project();
    let canonical = serde_json::to_value(&project.tables_data[&path].data).unwrap();
    for field in ["uuid", "display_name", "interface_implementations"] {
        let mut value = canonical.clone();
        value.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<TableData>(value).is_err(),
            "{field}"
        );
    }
    let mut missing_order = canonical.clone();
    missing_order["metadata"]
        .as_object_mut()
        .unwrap()
        .remove("interface_order");
    assert!(serde_json::from_value::<TableData>(missing_order).is_err());
    let mut old_root_order = canonical.clone();
    old_root_order["interface_order"] = json!([]);
    assert!(serde_json::from_value::<TableData>(old_root_order).is_err());
    for field in ["conditions", "data_type_params"] {
        let mut value = serde_json::to_value(column("value")).unwrap();
        value[field] = if field == "conditions" {
            json!([])
        } else {
            json!("")
        };
        assert!(
            serde_json::from_value::<ColumnSchema>(value).is_err(),
            "{field}"
        );
    }
    for alias in ["Str", "Bool", "string", "int", "float", "bool", "Typo"] {
        assert!(value_type_from_string(alias).is_err());
        assert!(serde_json::from_value::<ValueType>(json!(alias)).is_err());
    }
    assert!(serde_json::from_value::<MergeInfo>(
        json!({"second_parent_id": Uuid::new_v4(), "conflict_resolutions": []})
    )
    .is_err());
    assert!(serde_json::from_value::<ConflictResolution>(
        json!({"column_name":"a", "resolution_type":"TakeOurs", "description":""})
    )
    .is_err());
}

#[test]
fn editor_requires_explicit_uuid_target_and_diagnostics_have_one_source() {
    let target = json!({"mode":"table", "target_uuid": Uuid::new_v4().to_string(), "column_uuid":null, "insert_index":null});
    assert!(serde_json::from_value::<EditorTarget>(target.clone()).is_ok());
    let mut missing = target.clone();
    missing.as_object_mut().unwrap().remove("column_uuid");
    assert!(serde_json::from_value::<EditorTarget>(missing).is_err());
    let mut named = target;
    named["column_name"] = json!("old_name");
    assert!(serde_json::from_value::<EditorTarget>(named).is_err());
    let code = Diagnostic::Code {
        code: "error.validation.required".into(),
        params: json!({}),
    };
    assert_eq!(
        serde_json::to_value(code).unwrap(),
        json!({"kind":"code","code":"error.validation.required","params":{}})
    );
    let text = Diagnostic::Text {
        text: "利用者の説明".into(),
    };
    assert_eq!(
        serde_json::to_value(text).unwrap(),
        json!({"kind":"text","text":"利用者の説明"})
    );
    assert!(serde_json::from_value::<Diagnostic>(
        json!({"kind":"code", "code":"x", "params":{}, "text":"fallback"})
    )
    .is_err());
}

#[tokio::test]
async fn invalid_batch_type_rolls_back_without_defaulting_to_string() {
    for bad in ["string", "Typo"] {
        let (_directory, project, path) = project();
        let id = project.tables_data[&path].data.uuid.clone();
        let before = std::fs::read(&path).unwrap();
        let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
        let result = handler
            .handle_operation(DevcelOperation::ExecuteBatch {
                operations: vec![
                    DevcelOperation::AddColumn {
                        table_uuid: id.clone(),
                        column_name: "valid".into(),
                        column_type: "String".into(),
                    },
                    DevcelOperation::AddColumn {
                        table_uuid: id,
                        column_name: "bad".into(),
                        column_type: bad.into(),
                    },
                ],
            })
            .await;
        assert!(
            matches!(result, DevcelResponse::Error(ref text) if text.to_string().contains("Unknown value type"))
        );
        assert!(
            handler.project.lock().await.as_ref().unwrap().tables_data[&path]
                .data
                .schema
                .columns
                .is_empty()
        );
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
}

#[tokio::test]
async fn public_duplicate_preserves_stable_interface_values_and_parent_links() {
    let (_directory, mut project, path) = project();
    let mut interface = Interface::new("Stats".into(), None);
    let column = column("hp");
    let column_id = column.uuid.clone();
    interface
        .create_new_version(vec![InterfaceChange::AddColumn { column }], None, None)
        .unwrap();
    project
        .interface_registry
        .add_interface_with_path("Stats.interface.toml".into(), interface.clone())
        .unwrap();
    interface
        .save_to_file(&path.parent().unwrap().join("Stats.interface.toml"))
        .unwrap();
    project
        .tables_data
        .get_mut(&path)
        .unwrap()
        .apply_interface(&interface, &project.interface_registry, true)
        .unwrap();
    let parent = Record::new();
    let mut child = Record::new();
    child.parent_uuid = parent.uuid.clone();
    child
        .interface_values
        .insert(column_id.clone(), "99".into());
    project.tables_data.get_mut(&path).unwrap().data.records = vec![parent, child];
    project.save_project().unwrap();
    let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
    let response = handler
        .handle_operation(DevcelOperation::DuplicateTable {
            table_path: "Values.table.toml".into(),
            new_data_name: "Copy".into(),
            new_display_name: "複製".into(),
        })
        .await;
    let DevcelResponse::Ok(value) = response else {
        panic!("{response:?}");
    };
    let lock = handler.project.lock().await;
    let duplicate = &lock.as_ref().unwrap().tables_data
        [&PathBuf::from(value["new_path"].as_str().unwrap())]
        .data;
    assert_eq!(duplicate.display_name, "複製");
    assert_eq!(duplicate.schema.columns[0].uuid, column_id);
    assert_eq!(duplicate.records[1].interface_values[&column_id], "99");
    assert_eq!(duplicate.records[1].parent_uuid, duplicate.records[0].uuid);
    duplicate.validate_storage_contract().unwrap();
}

#[test]
fn independent_same_named_columns_require_explicit_identity_resolution() {
    let mut source = Interface::new("Merge".into(), None);
    let mut branch = source.clone();
    let ours_column = column("same");
    let theirs_column = column("same");
    let ours_id = ours_column.uuid.clone();
    let theirs_id = theirs_column.uuid.clone();
    let ours = source
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ours_column,
            }],
            None,
            None,
        )
        .unwrap();
    let theirs = branch
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: theirs_column,
            }],
            None,
            None,
        )
        .unwrap();
    source.absorb_history(&branch).unwrap();
    let conflicts = source.preview_merge_conflicts(ours, theirs).unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].field_conflicts[0].field, "identity");
    let before = serde_json::to_value(&source).unwrap();
    assert!(source
        .merge_branches(ours, theirs, &HashMap::new(), None, None)
        .is_err());
    assert_eq!(serde_json::to_value(&source).unwrap(), before);
    for (choice, id) in [
        (ResolutionType::TakeOurs, ours_id),
        (ResolutionType::TakeTheirs, theirs_id),
    ] {
        let mut merged = source.clone();
        merged
            .merge_branches(
                ours,
                theirs,
                &HashMap::from([("same".into(), choice)]),
                None,
                None,
            )
            .unwrap();
        assert_eq!(merged.columns.len(), 1);
        assert_eq!(merged.columns[0].uuid, id);
        merged.rebuild_current_columns().unwrap();
        assert_eq!(merged.columns[0].uuid, id);
    }
}

#[test]
fn loading_inconsistent_inheritance_does_not_repair_or_save() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("Broken.interface.toml");
    let mut interface = Interface::new("Broken".into(), None);
    interface.extends.push(Uuid::new_v4());
    assert!(interface.save_to_file(&file).is_err());
    std::fs::write(&file, toml::to_string(&interface).unwrap()).unwrap();
    let before = std::fs::read(&file).unwrap();
    assert_eq!(
        serde_json::to_value(AppError::from(
            Interface::load_from_file(&file).unwrap_err()
        ))
        .unwrap()["diagnostics"][0]["code"],
        "error.interface.historySnapshot"
    );
    assert_eq!(std::fs::read(file).unwrap(), before);
}

#[test]
fn interface_name_cells_are_rejected_and_normal_namespace_is_preserved() {
    let (_directory, project, path) = project();
    let mut data = project.tables_data[&path].data.clone();
    let mut interface_column = column("value");
    interface_column.interface_origin = Some(Uuid::new_v4().to_string());
    data.schema.columns.push(interface_column.clone());
    let mut record = Record::new();
    record.values.insert("value".into(), "old".into());
    data.records.push(record);
    assert!(serde_json::from_value::<TableData>(serde_json::to_value(&data).unwrap()).is_err());
    data.schema.columns.push(column("value"));
    let canonical: TableData =
        serde_json::from_value(serde_json::to_value(&data).unwrap()).unwrap();
    assert_eq!(canonical.records[0].get_cell_value(&interface_column), None);
    assert_eq!(canonical.records[0].values["value"], "old");
}

#[test]
fn unsupported_operations_are_unknown_and_record_draft_is_read_only() {
    for operation in [
        "ValidateDataNameCommand",
        "ExportTableJsonFull",
        "ExportTableJsonMinimal",
        "ExportAllTablesJsonFull",
        "ExportAllTablesJsonMinimal",
        "BeginTransaction",
        "CommitTransaction",
        "RollbackTransaction",
        "SetCellRangeValues",
        "CopyPasteCellRange",
        "SyncProjectState",
    ] {
        assert!(
            serde_json::from_value::<DevcelOperation>(json!({"op":operation, "data": {}})).is_err()
        );
    }
    let (_directory, project, path) = project();
    let id = project.tables_data[&path].data.uuid.clone();
    let before = std::fs::read(&path).unwrap();
    let draft = table_mutation::prepare_record_draft(&project, &id).unwrap();
    assert!(!serde_json::to_value(draft)
        .unwrap()
        .as_object()
        .unwrap()
        .contains_key("requires_input"));
    assert!(project.tables_data[&path].data.records.is_empty());
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn codegen_rejects_a_missing_table_data_name() {
    let (_directory, mut project, path) = project();
    project
        .tables_data
        .get_mut(&path)
        .unwrap()
        .data
        .metadata
        .data_name
        .clear();
    let expected = json!({
        "kind": "code",
        "code": "error.codegen.tableDataName",
        "params": {
            "table": project.tables_data[&path].data.display_name,
            "tableId": project.tables_data[&path].data.uuid,
        },
    });
    let result = codegen::generate_code(&mut project, codegen::CodegenTarget::CSharp, None);
    assert_eq!(
        serde_json::to_value(AppError::from(result.unwrap_err()).into_diagnostic()).unwrap(),
        expected,
    );
}

#[tokio::test]
async fn whole_table_update_requires_the_read_revision_and_retains_undo_redo() {
    let (_directory, mut project, path) = project();
    let id = project.tables_data[&path].data.uuid.clone();
    let old = serde_json::to_value(&project.tables_data[&path].data).unwrap();
    let stale_revision = cell_rules::revision(&project.tables_data[&path].data);
    project
        .execute_command(
            AddColumnCommand::new(
                id.clone(),
                "new_column",
                ValueType::String,
                None,
                None,
                None,
            ),
            None,
        )
        .unwrap();
    let persisted = std::fs::read(&path).unwrap();
    let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
    let response = handler
        .handle_operation(DevcelOperation::UpdateTableData {
            table_uuid: id.clone(),
            expected_revision: stale_revision,
            data: old,
            acknowledgement: None,
        })
        .await;
    assert!(
        matches!(response, DevcelResponse::Error(ref message) if message.to_string().contains("revision changed"))
    );
    assert_eq!(std::fs::read(&path).unwrap(), persisted);
    let snapshot = handler
        .handle_operation(DevcelOperation::GetTableData {
            table_uuid: id.clone(),
        })
        .await;
    let DevcelResponse::Ok(snapshot) = snapshot else {
        panic!("Snapshot request failed");
    };
    let revision = snapshot["revision"].as_str().unwrap().to_owned();
    let mut data = snapshot["table"].clone();
    data["description"] = json!("Updated");
    assert!(matches!(
        handler
            .handle_operation(DevcelOperation::UpdateTableData {
                table_uuid: id.clone(),
                expected_revision: revision,
                data,
                acknowledgement: None
            })
            .await,
        DevcelResponse::Ok(_)
    ));
    let mut lock = handler.project.lock().await;
    let project = lock.as_mut().unwrap();
    project.undo_command(&id).unwrap();
    project.redo_command(&id).unwrap();
    assert_eq!(project.tables_data[&path].data.description, "Updated");
    assert_eq!(
        project.tables_data[&path].data.schema.columns[0].data_name,
        "new_column"
    );
    assert!(serde_json::from_value::<DevcelOperation>(
        json!({"op":"UpdateTableData", "data":{"table_uuid":id,"data":{},"acknowledgement":null}})
    )
    .is_err());
}

#[test]
fn interfaces_is_an_ordinary_tables_subdirectory() {
    let (_directory, mut project, path) = project();
    let root = path.parent().unwrap();
    assert!(!root.parent().unwrap().join("interfaces").exists());
    std::fs::create_dir(root.join("interfaces")).unwrap();
    let interface = Interface::new("Source".into(), None);
    interface
        .save_to_file(&root.join("interfaces/Source.interface.toml"))
        .unwrap();
    project.reload_interfaces().unwrap();
    project
        .move_interface_file(
            "interfaces/Source.interface.toml",
            "interfaces/Destination.interface.toml",
        )
        .unwrap();
    assert!(root.join("interfaces/Destination.interface.toml").exists());
    assert!(!root.join("Destination.interface.toml").exists());
    assert_eq!(
        project
            .interface_registry
            .get_interface_path(&interface.uuid)
            .map(PathBuf::from),
        Some(PathBuf::from("interfaces").join("Destination.interface.toml"))
    );
}

#[test]
fn strict_identity_accepts_legitimate_inherited_column_removal() {
    let (_directory, mut project, path) = project();
    let mut parent = Interface::new("Parent".into(), None);
    let inherited = column("inherited");
    let inherited_id = inherited.uuid.clone();
    parent
        .create_new_version(
            vec![InterfaceChange::AddColumn { column: inherited }],
            None,
            None,
        )
        .unwrap();
    let mut child = Interface::new("Child".into(), None);
    child
        .create_new_version(
            vec![InterfaceChange::ModifyExtends {
                new_extends: vec![parent.uuid],
            }],
            None,
            None,
        )
        .unwrap();
    project
        .interface_registry
        .add_interface(parent.clone())
        .unwrap();
    project
        .interface_registry
        .add_interface(child.clone())
        .unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table
        .apply_interface(&child, &project.interface_registry, true)
        .unwrap();
    let mut record = Record::new();
    record.interface_values.insert(inherited_id, "value".into());
    table.data.records.push(record);
    parent
        .create_new_version(
            vec![InterfaceChange::RemoveColumn {
                column_name: "inherited".into(),
            }],
            None,
            None,
        )
        .unwrap();
    let parent_id = parent.uuid;
    *project
        .interface_registry
        .get_interface_mut(&parent_id)
        .unwrap() = parent;
    child
        .reconcile_table(table, &project.interface_registry)
        .unwrap();
    assert!(table.data.schema.columns.is_empty());
    assert!(table.data.records[0].interface_values.is_empty());
    table.data.validate_storage_contract().unwrap();
}

#[test]
fn root_interface_files_are_explicitly_rejected_without_being_moved() {
    let (_directory, mut project, path) = project();
    let directory = path.parent().unwrap().parent().unwrap().join("interfaces");
    std::fs::create_dir(&directory).unwrap();
    let file = directory.join("Unsupported.interface.toml");
    Interface::new("Unsupported".into(), None)
        .save_to_file(&file)
        .unwrap();
    let bytes = std::fs::read(&file).unwrap();
    assert_eq!(
        serde_json::to_value(
            AppError::from(project.reload_interfaces().unwrap_err()).into_diagnostic()
        )
        .unwrap(),
        json!({"kind": "code", "code": "error.project.legacyInterfaceLocation", "params": {}}),
    );
    assert_eq!(std::fs::read(file).unwrap(), bytes);
}

#[test]
fn unsupported_column_fields_leave_disk_and_loaded_state_unchanged() {
    let (_directory, mut project, path) = project();
    let table_id = project.tables_data[&path].data.uuid.clone();
    project
        .execute_command(
            AddColumnCommand::new(
                table_id.clone(),
                "value",
                ValueType::String,
                None,
                None,
                None,
            ),
            None,
        )
        .unwrap();
    let canonical = std::fs::read_to_string(&path).unwrap();
    let loaded = serde_json::to_value(&project.tables_data[&path].data).unwrap();
    for field in ["conditions = []", "data_type_params = \"must not be lost\""] {
        let unsupported = canonical.replace(
            "data_type = \"String\"",
            &format!("data_type = \"String\"\n{field}"),
        );
        assert_ne!(unsupported, canonical);
        std::fs::write(&path, &unsupported).unwrap();
        assert!(project
            .reload_table(&table_id)
            .unwrap_err()
            .to_string()
            .contains("unknown field"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), unsupported);
        assert_eq!(
            serde_json::to_value(&project.tables_data[&path].data).unwrap(),
            loaded
        );
    }
}

#[test]
fn rename_collision_resolution_follows_branch_identity_not_column_order() {
    let mut ours = Interface::new("Renames".into(), None);
    let first = column("first");
    let second = column("second");
    let first_id = first.uuid.clone();
    let second_id = second.uuid.clone();
    ours.create_new_version(
        vec![
            InterfaceChange::AddColumn { column: first },
            InterfaceChange::AddColumn { column: second },
        ],
        None,
        None,
    )
    .unwrap();
    let mut theirs = ours.clone();
    let our_version = ours
        .create_new_version(
            vec![InterfaceChange::RenameColumn {
                old_name: "second".into(),
                new_name: "same".into(),
            }],
            None,
            None,
        )
        .unwrap();
    let their_version = theirs
        .create_new_version(
            vec![InterfaceChange::RenameColumn {
                old_name: "first".into(),
                new_name: "same".into(),
            }],
            None,
            None,
        )
        .unwrap();
    ours.absorb_history(&theirs).unwrap();
    let conflict = ours
        .preview_merge_conflicts(our_version, their_version)
        .unwrap();
    assert_eq!(conflict[0].field_conflicts[0].ours, second_id);
    assert_eq!(conflict[0].field_conflicts[0].theirs, first_id);
    ours.merge_branches(
        our_version,
        their_version,
        &HashMap::from([("same".into(), ResolutionType::TakeOurs)]),
        None,
        None,
    )
    .unwrap();
    assert_eq!(ours.columns.len(), 1);
    assert_eq!(ours.columns[0].uuid, second_id);
}

#[test]
fn columns_missing_from_history_are_rejected_without_repair() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Untracked.interface.toml");
    let mut interface = Interface::new(
        "Untracked".into(),
        Some("Initial description is recorded in history".into()),
    );
    interface.columns.push(column("untracked"));
    assert!(interface.save_to_file(&path).is_err());
    std::fs::write(&path, toml::to_string(&interface).unwrap()).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert_eq!(
        serde_json::to_value(AppError::from(
            Interface::load_from_file(&path).unwrap_err()
        ))
        .unwrap()["diagnostics"][0]["code"],
        "error.interface.historySnapshot"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let fresh = Interface::new(
        "Fresh".into(),
        Some("Initial description is recorded in history".into()),
    );
    fresh.save_to_file(&path).unwrap();
    assert_eq!(
        Interface::load_from_file(&path).unwrap().description,
        fresh.description
    );
}

#[test]
fn interface_description_replays_merges_and_reverts_from_history() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Descriptions.interface.toml");
    let mut ours = Interface::new("Descriptions".into(), Some("Initial".into()));
    let initial_id = ours.current_version_id;
    let mut theirs = ours.clone();
    let our_id = ours
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: column("value"),
            }],
            None,
            None,
        )
        .unwrap();
    let their_id = theirs
        .create_new_version(
            vec![InterfaceChange::ChangeDescription {
                new_description: Some("Edited".into()),
            }],
            None,
            None,
        )
        .unwrap();
    ours.absorb_history(&theirs).unwrap();
    let preview = ours
        .preview_merge_changes(our_id, their_id, &HashMap::new())
        .unwrap();
    assert!(preview.iter().any(|change| matches!(
        change,
        InterfaceChange::ChangeDescription { new_description } if new_description.as_deref() == Some("Edited")
    )));
    let merged_id = ours
        .merge_branches(our_id, their_id, &HashMap::new(), None, None)
        .unwrap();
    assert_eq!(ours.description.as_deref(), Some("Edited"));
    ours.save_to_file(&path).unwrap();
    let mut reopened = Interface::load_from_file(&path).unwrap();
    reopened.description = Some("Untracked".into());
    assert_eq!(
        serde_json::to_value(AppError::from(
            reopened.validate_storage_contract().unwrap_err()
        ))
        .unwrap()["diagnostics"][0]["params"]["field"]["code"],
        "interface.description"
    );
    reopened.rebuild_current_columns().unwrap();
    assert_eq!(reopened.description.as_deref(), Some("Edited"));
    reopened.revert_to_version(initial_id, None, None).unwrap();
    assert_eq!(reopened.description.as_deref(), Some("Initial"));
    assert!(reopened.columns.is_empty());
    assert!(reopened.history.contains_key(&merged_id));
    assert!(reopened.history.contains_key(&their_id));
    reopened.save_to_file(&path).unwrap();
    let mut missing_initial = Interface::new("Missing".into(), None);
    missing_initial
        .history
        .get_mut(&missing_initial.current_version_id)
        .unwrap()
        .changes
        .clear();
    assert!(missing_initial.validate_storage_contract().is_err());
}

#[tokio::test]
async fn committed_snapshot_rejects_untracked_history_and_unknown_column_identity() {
    let (_directory, mut project, path) = project();
    let mut interface = Interface::new("Snapshot".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: column("value"),
            }],
            None,
            None,
        )
        .unwrap();
    project
        .interface_registry
        .add_interface(interface.clone())
        .unwrap();
    project
        .tables_data
        .get_mut(&path)
        .unwrap()
        .apply_interface(&interface, &project.interface_registry, true)
        .unwrap();
    let before = replication::capture(&project).unwrap();
    let disk_before = std::fs::read(&path).unwrap();
    let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
    let mut untracked_history = before.clone();
    untracked_history["interfaces"][0][1]["columns"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::to_value(column("untracked")).unwrap());
    assert!(matches!(
        handler.apply_server_snapshot(untracked_history).await,
        DevcelResponse::Error(_)
    ));
    let mut unknown_identity = before.clone();
    unknown_identity["tables"]["Values.table.toml"]["schema"]["columns"][0]["uuid"] =
        json!(Uuid::new_v4().to_string());
    assert!(matches!(
        handler.apply_server_snapshot(unknown_identity).await,
        DevcelResponse::Error(_)
    ));
    assert_eq!(
        replication::capture(handler.project.lock().await.as_ref().unwrap()).unwrap(),
        before
    );
    assert_eq!(std::fs::read(path).unwrap(), disk_before);
}

#[test]
fn editing_requires_the_column_revision_while_creation_can_use_null() {
    let (_directory, mut project, path) = project();
    let id = project.tables_data[&path].data.uuid.clone();
    project
        .execute_command(
            AddColumnCommand::new(id.clone(), "value", ValueType::String, None, None, None),
            None,
        )
        .unwrap();
    let stored = project.tables_data[&path].data.schema.columns[0].clone();
    let target = column_editor::EditorTarget {
        mode: column_editor::EditorMode::Table,
        target_uuid: id,
        column_uuid: Some(stored.uuid.clone()),
        insert_index: None,
    };
    let context = column_editor::load(&project, &target).unwrap();
    let request = column_editor::EditorRequest {
        target,
        draft: column_editor::EditorDraft {
            display_name: None,
            tags: vec![],
            font_size: 12,
            read_only: false,
            name: stored.display_name,
            column_type: "String".into(),
            tooltip: stored.tooltip,
            memo_text: stored.memo_text,
            default_value: stored.default_value,
            color: stored.style.color,
            reference_config: None,
            curve_config: None,
            table_ref_config: None,
            select_config: None,
            color_swatches: Vec::new(),
            input_validation: None,
            conditional_formatting: None,
            conditional_formatting_override: None,
            min_version: stored.min_version.to_string(),
        },
        expected_revision: None,
        creation_uuid: None,
        acknowledgement: None,
        acknowledgements: Default::default(),
    };
    assert!(column_editor::preview(&project, &request).is_err());
    let current = column_editor::EditorRequest {
        expected_revision: context.revision,
        ..request
    };
    assert!(column_editor::preview(&project, &current).is_ok());
}

#[test]
fn rejected_input_and_export_keep_typed_diagnostics_without_string_prefixes() {
    let (_directory, project, path) = project();
    let mut before = project.tables_data[&path].data.clone();
    let mut value = column("value");
    value.input_validation = Some(cell_rules::InputValidationSettings {
        enabled: true,
        mode: cell_rules::ValidationMode::Warn,
        message: String::new(),
        hint: String::new(),
        rules: vec![cell_rules::InputRule::Required],
    });
    before.schema.columns.push(value);
    let mut after = before.clone();
    after.records.push(Record::new());
    let error = cell_rules::validate_transition(&project.project_data.uuid, &before, &after, None)
        .unwrap_err();
    let DevcelError::InputValidation(report) = error else {
        panic!("Input report was converted to text");
    };
    assert!(report.acknowledgement.is_some());
    assert!(
        matches!(&report.issues[0].diagnostic,Diagnostic::Code { code,.. } if code=="error.validation.required")
    );
    let encoded =
        serde_json::to_value(AppError::from(DevcelError::InputValidation(report))).unwrap();
    assert_eq!(encoded["kind"], "input_validation");
    assert_eq!(encoded["report"]["issues"][0]["diagnostic"]["kind"], "code");
    assert!(!encoded.to_string().contains("DEVCEL_INPUT_VALIDATION"));
    after.schema.columns[0].required = Some(true);
    let error = export_validation::require_clean_table(&after, false).unwrap_err();
    let DevcelError::Diagnostics(diagnostics) = error else {
        panic!("Export diagnostics were converted to text");
    };
    assert!(diagnostics.iter().any(|diagnostic| matches!(diagnostic,Diagnostic::Code { code,.. } if code=="interface.validation.required")));
}
