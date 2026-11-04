use devcel_core::{
    operation_handler::{LocalOperationHandler, OperationHandler},
    operations::{DevcelOperation, DevcelResponse},
    *,
};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
#[tokio::test]
async fn direct_column_operations_accept_names_and_report_missing_targets() {
    let dir = tempfile::tempdir().unwrap();
    let mut p =
        Project::create_project("Ops", dir.path().to_str().unwrap(), "", "#123456").unwrap();
    let path = p.create_table(PathBuf::from("Values.table.toml")).unwrap();
    p.load_table(&path).unwrap();
    let id = p.tables_data[&path].data.uuid.clone();
    // Construct the fixture through the public write boundary so its disk revision
    // matches the state read by the operations under test.
    p.execute_command(
        AddColumnCommand::new(
            id.clone(),
            "hp",
            ValueType::I32,
            None,
            None,
            Some("0".into()),
        ),
        None,
    )
    .unwrap();
    let h = LocalOperationHandler::new(Arc::new(Mutex::new(Some(p))));
    for op in [
        DevcelOperation::SetColumnDefaultValue {
            table_uuid: id.clone(),
            column_name: "hp".into(),
            default_value: "42".into(),
        },
        DevcelOperation::SetColumnTooltip {
            table_uuid: id.clone(),
            column_name: "hp".into(),
            tooltip: "help".into(),
        },
        DevcelOperation::SetColumnMemoText {
            table_uuid: id.clone(),
            column_name: "hp".into(),
            memo_text: "details".into(),
        },
        DevcelOperation::SetColumnColor {
            table_uuid: id.clone(),
            column_name: "hp".into(),
            color: "#123456".into(),
        },
    ] {
        assert!(matches!(
            h.handle_operation(op).await,
            DevcelResponse::Ok(_)
        ));
    }
    {
        let lock = h.project.lock().await;
        let c = &lock.as_ref().unwrap().tables_data[&path]
            .data
            .schema
            .columns[0];
        assert_eq!(c.default_value, "42");
        assert_eq!(c.tooltip, "help");
        assert_eq!(c.memo_text, "details");
        assert_eq!(c.style.color, "#123456");
    }
    assert!(matches!(
        h.handle_operation(DevcelOperation::SetColumnDefaultValue {
            table_uuid: id.clone(),
            column_name: "missing".into(),
            default_value: "1".into()
        })
        .await,
        DevcelResponse::Error(_)
    ));
    assert!(matches!(
        h.handle_operation(DevcelOperation::RemoveColumn {
            table_uuid: id,
            column_name: "hp".into()
        })
        .await,
        DevcelResponse::Ok(_)
    ));
    assert!(h.project.lock().await.as_ref().unwrap().tables_data[&path]
        .data
        .schema
        .columns
        .is_empty());
}

#[test]
fn curve_column_creation_and_configuration_survive_undo_redo() {
    let dir = tempfile::tempdir().unwrap();
    let mut p =
        Project::create_project("CurveHistory", dir.path().to_str().unwrap(), "", "#123456")
            .unwrap();
    let path = p.create_table(PathBuf::from("Values.table.toml")).unwrap();
    p.load_table(&path).unwrap();
    let id = p.tables_data[&path].data.uuid.clone();
    let config = CurveConfig {
        start_value: -2.0,
        end_value: 3.0,
    };
    p.execute_command(
        AddColumnCommand::new(id.clone(), "curve", ValueType::Curve, None, None, None)
            .with_curve_config(Some(config.clone())),
        None,
    )
    .unwrap();
    let uuid = p.tables_data[&path].data.schema.columns[0].uuid.clone();
    p.undo_command(&id).unwrap();
    assert!(p.tables_data[&path].data.schema.columns.is_empty());
    p.redo_command(&id).unwrap();
    assert_eq!(
        p.tables_data[&path].data.schema.columns[0].curve_config,
        Some(config.clone())
    );
    assert_eq!(p.tables_data[&path].data.schema.columns[0].uuid, uuid);
    devcel_core::commands::set_column_curve_config(&mut p, &id, &uuid, 10.0, 20.0).unwrap();
    p.undo_command(&id).unwrap();
    assert_eq!(
        p.tables_data[&path].data.schema.columns[0].curve_config,
        Some(config)
    );
    p.redo_command(&id).unwrap();
    assert_eq!(
        p.tables_data[&path].data.schema.columns[0]
            .curve_config
            .as_ref()
            .unwrap()
            .start_value,
        10.0
    );
    assert!(devcel_core::commands::set_column_curve_config(
        &mut p,
        &id,
        &uuid,
        f64::INFINITY,
        20.0
    )
    .is_err());
    assert_eq!(
        p.tables_data[&path].data.schema.columns[0]
            .curve_config
            .as_ref()
            .unwrap()
            .start_value,
        10.0
    );
    p.execute_command(
        InsertColumnCommand::new(id.clone(), "insert", ValueType::Curve, 0, None, None, None)
            .with_curve_config(Some(CurveConfig::default())),
        None,
    )
    .unwrap();
    let inserted = p.tables_data[&path].data.schema.columns[0].uuid.clone();
    p.undo_command(&id).unwrap();
    p.redo_command(&id).unwrap();
    assert_eq!(p.tables_data[&path].data.schema.columns[0].uuid, inserted);
    assert_eq!(
        p.tables_data[&path].data.schema.columns[0].curve_config,
        Some(CurveConfig::default())
    );
}

fn project_file_hashes(root: &std::path::Path) -> std::collections::BTreeMap<PathBuf, String> {
    use sha2::{Digest, Sha256};
    fn visit(
        root: &std::path::Path,
        path: &std::path::Path,
        hashes: &mut std::collections::BTreeMap<PathBuf, String>,
    ) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, hashes);
            } else {
                hashes.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap())),
                );
            }
        }
    }
    let mut hashes = std::collections::BTreeMap::new();
    visit(root, root, &mut hashes);
    hashes
}

#[derive(Debug, PartialEq)]
struct LoadedTableState {
    data: serde_json::Value,
    dirty: bool,
    undo: Vec<usize>,
    redo: Vec<usize>,
}

fn loaded_table_states(project: &Project) -> std::collections::BTreeMap<PathBuf, LoadedTableState> {
    project
        .tables_data
        .iter()
        .map(|(path, table)| {
            (
                path.clone(),
                LoadedTableState {
                    data: serde_json::to_value(&table.data).unwrap(),
                    dirty: table.is_dirty,
                    undo: table
                        .undo_history
                        .iter()
                        .map(|command| Arc::as_ptr(&command.data) as *const () as usize)
                        .collect(),
                    redo: table
                        .redo_history
                        .iter()
                        .map(|command| Arc::as_ptr(&command.data) as *const () as usize)
                        .collect(),
                },
            )
        })
        .collect()
}

#[tokio::test]
async fn column_data_names_are_rejected_atomically_but_display_name_atoms_roundtrip() {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "ColumnNames",
        directory.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let path = project.create_table("Formula.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    let sibling = project.create_table("Untouched.table.toml".into()).unwrap();
    project.load_table(&sibling).unwrap();
    let id = project.tables_data[&path].data.uuid.clone();
    for (name, default) in [("offset", "13"), ("result", "0")] {
        project
            .execute_command(
                AddColumnCommand::new(
                    id.clone(),
                    name,
                    ValueType::I32,
                    None,
                    None,
                    Some(default.into()),
                ),
                None,
            )
            .unwrap();
    }
    project
        .execute_command(AddRecordCommand::new(id.clone()), None)
        .unwrap();
    project
        .execute_command(
            AddColumnCommand::new(
                id.clone(),
                "redo_candidate",
                ValueType::I32,
                None,
                None,
                None,
            ),
            None,
        )
        .unwrap();
    project.undo_command(&id).unwrap();
    assert!(!project.tables_data[&path].redo_history.is_empty());
    let original = project.tables_data[&path].data.clone();
    let before_files = project_file_hashes(directory.path());
    let before_memory = loaded_table_states(&project);
    let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
    for name in ["offset+", "a:b", "unit price", "", "1value"] {
        let mut replacement = serde_json::to_value(&original).unwrap();
        replacement["schema"]["columns"][0]["data_name"] = serde_json::json!(name);
        let operations = vec![
            DevcelOperation::AddColumn {
                table_uuid: id.clone(),
                column_name: name.into(),
                column_type: "I32".into(),
            },
            DevcelOperation::InsertColumn {
                table_uuid: id.clone(),
                index: 0,
                column_name: name.into(),
                column_type: "I32".into(),
            },
            DevcelOperation::RenameColumn {
                table_uuid: id.clone(),
                old_name: "offset".into(),
                new_name: name.into(),
            },
            DevcelOperation::UpdateTableData {
                table_uuid: id.clone(),
                expected_revision: cell_rules::revision(&original),
                data: replacement,
                acknowledgement: None,
            },
            DevcelOperation::ExecuteBatch {
                operations: vec![
                    DevcelOperation::AddColumn {
                        table_uuid: id.clone(),
                        column_name: "temporary".into(),
                        column_type: "I32".into(),
                    },
                    DevcelOperation::AddColumn {
                        table_uuid: id.clone(),
                        column_name: name.into(),
                        column_type: "I32".into(),
                    },
                ],
            },
        ];
        for operation in operations {
            let response = handler.handle_operation(operation).await;
            assert!(
                matches!(response, DevcelResponse::Error(_)),
                "accepted invalid data name {name:?}: {response:?}"
            );
            assert_eq!(
                project_file_hashes(directory.path()),
                before_files,
                "disk changed for {name:?}"
            );
            let lock = handler.project.lock().await;
            assert_eq!(
                loaded_table_states(lock.as_ref().unwrap()),
                before_memory,
                "memory/history changed for {name:?}"
            );
            drop(lock);
            assert!(matches!(
                handler
                    .handle_operation(DevcelOperation::GetTableData {
                        table_uuid: id.clone()
                    })
                    .await,
                DevcelResponse::Ok(_)
            ));
        }
    }
    for label in ["offset+", "a:b", "unit price.rate"] {
        let current = handler.project.lock().await.as_ref().unwrap().tables_data[&path]
            .data
            .clone();
        let mut changed = current.clone();
        changed.schema.columns[0].display_name = label.into();
        let result_column = changed.schema.columns[1].clone();
        changed.records[0].set_cell_value(&result_column, format!("={label}"));
        assert!(matches!(
            handler
                .handle_operation(DevcelOperation::UpdateTableData {
                    table_uuid: id.clone(),
                    expected_revision: cell_rules::revision(&current),
                    data: serde_json::to_value(changed).unwrap(),
                    acknowledgement: None,
                })
                .await,
            DevcelResponse::Ok(_)
        ));
        let reopened: TableData = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(reopened.schema.columns[0].data_name, "offset");
        assert_eq!(reopened.schema.columns[0].display_name, label);
        let mut engine = FormulaEngine::new();
        for formula in [
            format!("={label}"),
            format!("=LET(x,1,{label})"),
            format!("=\"${{{label}}}\""),
        ] {
            assert!(
                matches!(engine.evaluate(&formula, "result", &reopened.records[0], &reopened.schema), FormulaResult::Value(value) if value == "13"),
                "display name {label:?}: {formula}"
            );
        }
        assert!(
            matches!(engine.evaluate_column(&format!("={label}"), &reopened.schema.columns[1], &reopened.records[0], &reopened.schema), FormulaResult::Value(value) if value == "13")
        );
    }
}
