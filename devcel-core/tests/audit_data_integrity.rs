use devcel_core::interface::InterfaceChange;
use devcel_core::*;
use std::collections::{HashMap, HashSet};

fn project() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let p =
        Project::create_project("Audit", dir.path().to_str().unwrap(), "old", "#123456").unwrap();
    (dir, p)
}
fn stats() -> Interface {
    let mut i = Interface::new("Stats".into(), None);
    i.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "hp".into(),
                display_name: "HP".into(),
                data_type: ValueType::I32,
                default_value: "0".into(),
                ..Default::default()
            },
        }],
        None,
        None,
    )
    .unwrap();
    i
}
fn version(i: &mut Interface, n: u32) {
    i.create_new_version(
        vec![InterfaceChange::ChangeMinVersion {
            column_name: "hp".into(),
            min_version: n,
        }],
        None,
        None,
    )
    .unwrap();
}
#[test]
fn stale_metadata_save_and_close_preserve_newer_settings_and_draft() {
    for close in [false, true] {
        let (_dir, mut newest) = project();
        let mut stale = Project::open_project(&newest.get_project_path()).unwrap();
        newest.project_data.project_name = "new-name".into();
        newest.project_data.project_description = "new-description".into();
        newest.project_data.color = "#abcdef".into();
        newest.save_project().unwrap();
        let bytes = std::fs::read(&newest.path).unwrap();
        stale.project_data.project_description = "unsaved-draft".into();
        let result = if close {
            stale.close_project()
        } else {
            stale.save_project()
        };
        assert!(result.is_err());
        assert_eq!(std::fs::read(&newest.path).unwrap(), bytes);
        assert_eq!(stale.project_data.project_description, "unsaved-draft");
        let reopened = Project::open_project(&newest.get_project_path()).unwrap();
        assert_eq!(reopened.project_data.project_name, "new-name");
        assert_eq!(reopened.project_data.color, "#abcdef");
    }
}
#[cfg(feature = "p2p")]
#[tokio::test]
async fn rejected_close_keeps_original_project_session_on_switch() {
    use devcel_core::operation_handler::{LocalOperationHandler, OperationHandler};
    use devcel_core::operations::{DevcelOperation, DevcelResponse};
    let (_dir, mut a) = project();
    let id = a.get_instance_id().to_owned();
    let mut other = Project::open_project(&a.get_project_path()).unwrap();
    other.project_data.color = "#abcdef".into();
    other.save_project().unwrap();
    a.project_data.project_description = "pending".into();
    let (_target_dir, target) = project();
    let state = std::sync::Arc::new(tokio::sync::Mutex::new(Some(a)));
    let handler = LocalOperationHandler::new(state.clone());
    assert!(matches!(
        handler
            .handle_operation(DevcelOperation::OpenProject {
                project_path: target.get_project_path()
            })
            .await,
        DevcelResponse::Error(_)
    ));
    let lock = state.lock().await;
    let kept = lock.as_ref().unwrap();
    assert_eq!(kept.get_instance_id(), id);
    assert_eq!(kept.project_data.project_description, "pending");
}
#[test]
fn export_suffixes_preserve_every_origin_qualified_value() {
    let (_dir, mut p) = project();
    let path = p.create_table("Names.table.toml".into()).unwrap();
    p.load_table(&path).unwrap();
    let mut interface = Interface::new("A".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "x".into(),
                    display_name: "X".into(),
                    data_type: ValueType::String,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    p.interface_registry
        .add_interface_with_path("A.interface.toml".into(), interface.clone())
        .unwrap();
    interface
        .save_to_file(&p.path.parent().unwrap().join("Tables/A.interface.toml"))
        .unwrap();
    let table = p.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns = ["A_x", "A_x_1", "x"]
        .iter()
        .map(|n| ColumnSchema {
            data_name: (*n).into(),
            display_name: (*n).into(),
            data_type: ValueType::String,
            ..Default::default()
        })
        .collect();
    table
        .apply_interface(&interface, &p.interface_registry, true)
        .unwrap();
    let mut row = Record::new();
    for (n, c) in table.data.schema.columns.iter().enumerate() {
        row.set_cell_value(c, format!("value-{n}"));
    }
    table.data.records.push(row);
    table.is_dirty = true;
    p.save_project().unwrap();
    let text = json_export::export_runtime_bundle_as_json_with_validation(
        &mut p,
        json_export::ExportMode::Full,
        None,
        false,
    )
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let table = &v["tables"][0];
    let columns = table["columns"].as_array().unwrap();
    let names: HashSet<_> = columns
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 4);
    let values = table["records"][0]["values"].as_object().unwrap();
    assert_eq!(values.len(), 4);
    for n in 0..4 {
        assert!(values.values().any(|v| v == &format!("value-{n}")));
    }
}
#[test]
fn direct_rename_collision_is_atomic_and_remains_reloadable() {
    let (_dir, mut p) = project();
    let path = p.create_table("Names.table.toml".into()).unwrap();
    p.load_table(&path).unwrap();
    let id = p.tables_data[&path].data.uuid.clone();
    for name in ["a", "b"] {
        p.execute_command(
            AddColumnCommand::new(
                id.clone(),
                name,
                ValueType::I32,
                None,
                None,
                Some("0".into()),
            ),
            None,
        )
        .unwrap();
    }
    p.execute_command(AddRecordCommand::new(id.clone()), None)
        .unwrap();
    let rid = p.tables_data[&path].data.records[0].uuid.clone();
    let columns = p.tables_data[&path].data.schema.columns.clone();
    for (c, value) in columns.iter().zip(["10", "20"]) {
        p.execute_command(
            SetRecordValueCommand::new(id.clone(), rid.clone(), c.uuid.clone(), value.into()),
            None,
        )
        .unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let mem = serde_json::to_value(&p.tables_data[&path].data).unwrap();
    let count = p.tables_data[&path].undo_history.len();
    assert!(p
        .execute_command(
            RenameColumnCommand::new(id.clone(), columns[0].uuid.clone(), "b"),
            None
        )
        .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        serde_json::to_value(&p.tables_data[&path].data).unwrap(),
        mem
    );
    assert_eq!(p.tables_data[&path].undo_history.len(), count);
    assert!(TableData::from_toml(std::str::from_utf8(&before).unwrap()).is_ok());
}
#[test]
fn merge_cross_fields_reject_invalid_default_but_keep_empty_and_formulas() {
    for default in ["300", "", "=1+1"] {
        let base = stats();
        let mut ours = base.clone();
        let mut theirs = base.clone();
        ours.create_new_version(
            vec![InterfaceChange::ModifyColumn {
                column_name: "hp".into(),
                old_type: ValueType::I32,
                new_type: ValueType::I8,
            }],
            None,
            None,
        )
        .unwrap();
        theirs
            .create_new_version(
                vec![InterfaceChange::ChangeDefault {
                    column_name: "hp".into(),
                    new_default: Some(default.into()),
                }],
                None,
                None,
            )
            .unwrap();
        let oh = ours.current_version_id;
        ours.absorb_history(&theirs).unwrap();
        let before = serde_json::to_value(&ours).unwrap();
        let result =
            ours.merge_branches(oh, theirs.current_version_id, &HashMap::new(), None, None);
        if default == "300" {
            assert!(result.is_err());
            assert_eq!(serde_json::to_value(&ours).unwrap(), before);
        } else {
            result.unwrap();
            assert_eq!(ours.columns[0].data_type, ValueType::I8);
            assert_eq!(ours.columns[0].default_value, default);
        }
    }
}
#[test]
fn shortcut_merge_edge_cannot_choose_dominated_older_base() {
    for wanted in [0, 2] {
        let mut a = stats();
        version(&mut a, 0);
        let mut b = a.clone();
        version(&mut b, 1);
        let mut long = b.clone();
        for n in 0..4 {
            long.create_new_version(
                vec![InterfaceChange::ChangeDefault {
                    column_name: "hp".into(),
                    new_default: Some((n + 1).to_string()),
                }],
                None,
                None,
            )
            .unwrap();
        }
        let lh = long.current_version_id;
        let mut side = a.clone();
        side.create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "side".into(),
                    display_name: "Side".into(),
                    data_type: ValueType::String,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
        long.absorb_history(&side).unwrap();
        long.merge_branches(lh, side.current_version_id, &HashMap::new(), None, None)
            .unwrap();
        let oh = long.current_version_id;
        let mut d = b;
        version(&mut d, wanted);
        let dh = d.current_version_id;
        long.absorb_history(&d).unwrap();
        d.absorb_history(&long).unwrap();
        assert!(long.preview_merge_conflicts(oh, dh).unwrap().is_empty());
        long.merge_branches(oh, dh, &HashMap::new(), None, None)
            .unwrap();
        d.merge_branches(dh, oh, &HashMap::new(), None, None)
            .unwrap();
        assert_eq!(
            long.columns
                .iter()
                .find(|c| c.data_name == "hp")
                .unwrap()
                .min_version,
            wanted
        );
        assert_eq!(d.columns[0].min_version, wanted);
    }
}
#[test]
fn automatic_final_state_sync_preserves_restored_uuid_values_and_memos() {
    let (_dir, mut p) = project();
    let i = stats();
    let cid = i.columns[0].uuid.clone();
    let uid = i.uuid;
    let target = i.current_version_id;
    p.interface_registry
        .add_interface_with_path("Stats.interface.toml".into(), i.clone())
        .unwrap();
    i.save_to_file(&p.path.parent().unwrap().join("Tables/Stats.interface.toml"))
        .unwrap();
    let path = p.create_table("Values.table.toml".into()).unwrap();
    p.load_table(&path).unwrap();
    let table = p.tables_data.get_mut(&path).unwrap();
    table
        .apply_interface(&i, &p.interface_registry, true)
        .unwrap();
    let mut row = Record::new();
    row.interface_values.insert(cid.clone(), "99".into());
    row.memo_texts.insert(cid.clone(), "keep-note".into());
    table.data.records.push(row);
    table.is_dirty = true;
    let tid = table.data.uuid.clone();
    p.save_project().unwrap();
    p.execute_command(
        UpdateInterfaceCommand::new(
            uid,
            vec![InterfaceChange::RemoveColumn {
                column_name: "hp".into(),
            }],
            None,
            None,
        ),
        None,
    )
    .unwrap();
    p.execute_command(RevertInterfaceCommand::new(uid, target, None), None)
        .unwrap();
    assert!(table_mutation::sync_pending_interface_updates(&mut p, &tid, None).unwrap());
    for history in 0..3 {
        let data = &p.tables_data[&path].data;
        assert_eq!(data.records[0].interface_values[&cid], "99");
        assert_eq!(data.records[0].memo_texts[&cid], "keep-note");
        assert_eq!(
            data.schema.columns.iter().filter(|c| c.uuid == cid).count(),
            1
        );
        assert!(TableData::from_toml(&std::fs::read_to_string(&path).unwrap()).is_ok());
        if history == 0 {
            p.undo_command(&tid).unwrap();
        } else if history == 1 {
            p.redo_command(&tid).unwrap();
        }
    }
}

fn register(p: &mut Project, i: &Interface) {
    let rel = format!("{}.interface.toml", i.name);
    p.interface_registry
        .add_interface_with_path(rel.clone(), i.clone())
        .unwrap();
    i.save_to_file(&p.path.parent().unwrap().join("Tables").join(rel))
        .unwrap();
}
#[test]
fn shared_ancestor_sync_and_detach_preserve_single_identity_and_values() {
    let (_dir, mut p) = project();
    let parent = stats();
    let cid = parent.columns[0].uuid.clone();
    register(&mut p, &parent);
    let mut a = Interface::new("A".into(), None);
    a.create_new_version(
        vec![InterfaceChange::ModifyExtends {
            new_extends: vec![parent.uuid],
        }],
        None,
        None,
    )
    .unwrap();
    register(&mut p, &a);
    let mut b = Interface::new("B".into(), None);
    b.create_new_version(
        vec![InterfaceChange::ModifyExtends {
            new_extends: vec![parent.uuid],
        }],
        None,
        None,
    )
    .unwrap();
    register(&mut p, &b);
    let path = p.create_table("Shared.table.toml".into()).unwrap();
    p.load_table(&path).unwrap();
    let table = p.tables_data.get_mut(&path).unwrap();
    table
        .apply_interface(&a, &p.interface_registry, true)
        .unwrap();
    table
        .apply_interface(&b, &p.interface_registry, true)
        .unwrap();
    let mut row = Record::new();
    row.interface_values.insert(cid.clone(), "99".into());
    row.memo_texts.insert(cid.clone(), "shared memo".into());
    table.data.records.push(row);
    table
        .data
        .schema
        .columns
        .iter_mut()
        .find(|c| c.uuid == cid)
        .unwrap()
        .conditional_formatting_override = Some(Default::default());
    b.reconcile_table(table, &p.interface_registry).unwrap();
    assert_eq!(
        table
            .data
            .schema
            .columns
            .iter()
            .filter(|c| c.uuid == cid)
            .count(),
        1
    );
    assert_eq!(
        table
            .data
            .schema
            .columns
            .iter()
            .find(|c| c.uuid == cid)
            .unwrap()
            .conditional_formatting_override,
        Some(Default::default())
    );
    a.remove_from_table(table).unwrap();
    assert_eq!(table.data.records[0].interface_values[&cid], "99");
    assert_eq!(table.data.records[0].memo_texts[&cid], "shared memo");
    assert_eq!(
        table
            .data
            .schema
            .columns
            .iter()
            .filter(|c| c.uuid == cid)
            .count(),
        1
    );
    let serialized = toml::to_string(&table.data).unwrap();
    let loaded = TableData::from_toml(&serialized).unwrap();
    assert_eq!(loaded.records[0].interface_values[&cid], "99");
    b.remove_from_table(table).unwrap();
    assert!(!table.data.schema.columns.iter().any(|c| c.uuid == cid));
    assert!(!table.data.records[0].interface_values.contains_key(&cid));
    assert!(!table.data.records[0].memo_texts.contains_key(&cid));
}
#[test]
fn conflict_history_file_is_retained_even_after_successful_import() {
    let (_dir, mut p) = project();
    let base = stats();
    register(&mut p, &base);
    let mut source = base.clone();
    version(&mut source, 2);
    let copy = p
        .path
        .parent()
        .unwrap()
        .join("Stats-conflict.interface.toml");
    source.save_to_file(&copy).unwrap();
    let original = std::fs::read(&copy).unwrap();
    assert_eq!(
        p.import_interface_history_file(&base.uuid, &copy).unwrap(),
        1
    );
    assert_eq!(std::fs::read(&copy).unwrap(), original);
    // An external writer may append after that snapshot was read. A second import
    // must recover the new history, rather than discover the source was deleted.
    version(&mut source, 3);
    source.save_to_file(&copy).unwrap();
    let newest = std::fs::read(&copy).unwrap();
    assert_eq!(
        p.import_interface_history_file(&base.uuid, &copy).unwrap(),
        1
    );
    assert_eq!(std::fs::read(&copy).unwrap(), newest);
    assert!(p
        .get_interface(&base.uuid)
        .unwrap()
        .history
        .contains_key(&source.current_version_id));
}

#[test]
fn last_late_parent_field_disappears_without_touching_local_order() {
    let (_dir, mut p) = project();
    let mut parent = Interface::new("Parent".into(), None);
    register(&mut p, &parent);
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
    register(&mut p, &child);
    let path = p.create_table("Late.table.toml".into()).unwrap();
    p.load_table(&path).unwrap();
    let table = p.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns = ["left", "right"]
        .into_iter()
        .map(|n| ColumnSchema {
            data_name: n.into(),
            data_type: ValueType::String,
            ..Default::default()
        })
        .collect();
    let local_ids: Vec<_> = table
        .data
        .schema
        .columns
        .iter()
        .map(|c| c.uuid.clone())
        .collect();
    table
        .apply_interface(&child, &p.interface_registry, true)
        .unwrap();
    parent
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "hp".into(),
                    data_type: ValueType::I32,
                    default_value: "0".into(),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    *p.interface_registry
        .get_interface_mut(&parent.uuid)
        .unwrap() = parent.clone();
    child.reconcile_table(table, &p.interface_registry).unwrap();
    let cid = parent.columns[0].uuid.clone();
    let mut row = Record::new();
    row.interface_values.insert(cid.clone(), "99".into());
    row.memo_texts.insert(cid.clone(), "late note".into());
    table.data.records.push(row);
    parent
        .create_new_version(
            vec![InterfaceChange::RemoveColumn {
                column_name: "hp".into(),
            }],
            None,
            None,
        )
        .unwrap();
    *p.interface_registry
        .get_interface_mut(&parent.uuid)
        .unwrap() = parent.clone();
    child.reconcile_table(table, &p.interface_registry).unwrap();
    assert_eq!(
        table
            .data
            .schema
            .columns
            .iter()
            .map(|c| c.uuid.clone())
            .collect::<Vec<_>>(),
        local_ids
    );
    assert!(!table.data.records[0].interface_values.contains_key(&cid));
    assert!(!table.data.records[0].memo_texts.contains_key(&cid));
    assert!(TableData::from_toml(&toml::to_string(&table.data).unwrap()).is_ok());
}

#[test]
fn multi_interface_collision_preview_includes_prior_selection_not_shared_identity() {
    let (_dir, mut p) = project();
    let a = stats();
    register(&mut p, &a);
    let mut b = stats();
    b.name = "Other".into();
    register(&mut p, &b);
    assert!(a
        .column_name_collisions(&[], &p.interface_registry)
        .unwrap()
        .is_empty());
    let earlier = a.get_effective_columns(&p.interface_registry).unwrap();
    assert_eq!(
        b.column_name_collisions(&earlier, &p.interface_registry)
            .unwrap(),
        vec!["hp"]
    );
    assert!(a
        .column_name_collisions(&earlier, &p.interface_registry)
        .unwrap()
        .is_empty());
    let mut child = Interface::new("ChildPreview".into(), None);
    child
        .create_new_version(
            vec![InterfaceChange::ModifyExtends {
                new_extends: vec![a.uuid],
            }],
            None,
            None,
        )
        .unwrap();
    register(&mut p, &child);
    assert!(child
        .column_name_collisions(&earlier, &p.interface_registry)
        .unwrap()
        .is_empty());
}

#[test]
fn legacy_synced_sibling_does_not_retain_removed_ancestor_forever() {
    let (_dir, mut p) = project();
    let mut parent = stats();
    let cid = parent.columns[0].uuid.clone();
    register(&mut p, &parent);
    let mut a = Interface::new("LegacyA".into(), None);
    a.create_new_version(
        vec![InterfaceChange::ModifyExtends {
            new_extends: vec![parent.uuid],
        }],
        None,
        None,
    )
    .unwrap();
    register(&mut p, &a);
    let mut b = Interface::new("LegacyB".into(), None);
    b.create_new_version(
        vec![InterfaceChange::ModifyExtends {
            new_extends: vec![parent.uuid],
        }],
        None,
        None,
    )
    .unwrap();
    register(&mut p, &b);
    let path = p.create_table("Legacy.table.toml".into()).unwrap();
    p.load_table(&path).unwrap();
    let table = p.tables_data.get_mut(&path).unwrap();
    table
        .apply_interface(&a, &p.interface_registry, true)
        .unwrap();
    table
        .apply_interface(&b, &p.interface_registry, true)
        .unwrap();
    let mut row = Record::new();
    row.interface_values.insert(cid.clone(), "99".into());
    row.memo_texts
        .insert(cid.clone(), "keep until final requirement removed".into());
    table.data.records.push(row);
    parent
        .create_new_version(
            vec![InterfaceChange::RemoveColumn {
                column_name: "hp".into(),
            }],
            None,
            None,
        )
        .unwrap();
    *p.interface_registry
        .get_interface_mut(&parent.uuid)
        .unwrap() = parent.clone();
    b.reconcile_table(table, &p.interface_registry).unwrap();
    assert!(table.data.schema.columns.iter().any(|c| c.uuid == cid));
    // Old files have a confirmed current fingerprint but no UUID snapshot.
    table
        .data
        .interface_implementations
        .get_mut(&b.uuid)
        .unwrap()
        .required_column_uuids = None;
    a.reconcile_table(table, &p.interface_registry).unwrap();
    assert!(!table.data.schema.columns.iter().any(|c| c.uuid == cid));
    assert!(!table.data.records[0].interface_values.contains_key(&cid));
    assert!(!table.data.records[0].memo_texts.contains_key(&cid));
}

#[test]
fn pending_shared_interfaces_commit_together_and_one_undo_restores_both() {
    let (_dir, mut p) = project();
    let parent = stats();
    let cid = parent.columns[0].uuid.clone();
    register(&mut p, &parent);
    let mut a = Interface::new("PendingA".into(), None);
    a.create_new_version(
        vec![InterfaceChange::ModifyExtends {
            new_extends: vec![parent.uuid],
        }],
        None,
        None,
    )
    .unwrap();
    register(&mut p, &a);
    let mut b = Interface::new("PendingB".into(), None);
    b.create_new_version(
        vec![InterfaceChange::ModifyExtends {
            new_extends: vec![parent.uuid],
        }],
        None,
        None,
    )
    .unwrap();
    register(&mut p, &b);
    let path = p.create_table("Pending.table.toml".into()).unwrap();
    p.load_table(&path).unwrap();
    let table = p.tables_data.get_mut(&path).unwrap();
    table
        .apply_interface(&a, &p.interface_registry, true)
        .unwrap();
    table
        .apply_interface(&b, &p.interface_registry, true)
        .unwrap();
    let mut row = Record::new();
    row.interface_values.insert(cid.clone(), "99".into());
    row.memo_texts.insert(cid.clone(), "shared".into());
    table.data.records.push(row);
    table.is_dirty = true;
    let tid = table.data.uuid.clone();
    p.save_project().unwrap();
    p.execute_command(
        UpdateInterfaceCommand::new(
            parent.uuid,
            vec![InterfaceChange::ChangeDefault {
                column_name: "hp".into(),
                new_default: Some("1".into()),
            }],
            None,
            None,
        ),
        None,
    )
    .unwrap();
    let before = serde_json::to_value(&p.tables_data[&path].data).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert!(table_mutation::sync_interface(&mut p, &tid, &a.uuid, true, true, None).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(
        serde_json::to_value(&p.tables_data[&path].data).unwrap(),
        before
    );
    table_mutation::sync_pending_interface_updates(&mut p, &tid, None).unwrap();
    for i in [&a, &b] {
        assert!(!i.table_needs_sync(
            &p.tables_data[&path].data.interface_implementations[&i.uuid],
            &p.interface_registry
        ));
    }
    let data = &p.tables_data[&path].data;
    assert_eq!(
        data.schema.columns.iter().filter(|c| c.uuid == cid).count(),
        1
    );
    assert_eq!(data.records[0].interface_values[&cid], "99");
    assert_eq!(data.records[0].memo_texts[&cid], "shared");
    let after = serde_json::to_value(data).unwrap();
    p.undo_command(&tid).unwrap();
    assert_eq!(
        serde_json::to_value(&p.tables_data[&path].data).unwrap(),
        before
    );
    p.redo_command(&tid).unwrap();
    assert_eq!(
        serde_json::to_value(&p.tables_data[&path].data).unwrap(),
        after
    );
    assert!(TableData::from_toml(&std::fs::read_to_string(&path).unwrap()).is_ok());
}

#[test]
fn truncated_or_deleted_metadata_refuses_save_and_close_without_flushing_tables() {
    for close in [false, true] {
        for truncate in [false, true] {
            let (_dir, mut p) = project();
            let path = p.create_table("Draft.table.toml".into()).unwrap();
            p.load_table(&path).unwrap();
            p.save_project().unwrap();
            let table_bytes = std::fs::read(&path).unwrap();
            p.project_data.project_description = "unsaved metadata".into();
            let metadata = p.project_data.clone();
            let table = p.tables_data.get_mut(&path).unwrap();
            table.data.description = "unsaved table".into();
            table.is_dirty = true;
            let table_before = serde_json::to_value(&table.data).unwrap();
            if truncate {
                std::fs::write(&p.path, b"").unwrap();
            } else {
                std::fs::remove_file(&p.path).unwrap();
            }
            let result = if close {
                p.close_project()
            } else {
                p.save_project()
            };
            assert!(result.is_err());
            assert!(p.project_data == metadata);
            assert_eq!(std::fs::read(&path).unwrap(), table_bytes);
            assert_eq!(
                serde_json::to_value(&p.tables_data[&path].data).unwrap(),
                table_before
            );
            assert!(p.tables_data[&path].is_dirty);
            if truncate {
                assert_eq!(std::fs::read(&p.path).unwrap(), b"");
            } else {
                assert!(!p.path.exists());
            }
        }
    }
}
