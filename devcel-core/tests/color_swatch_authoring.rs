//! End-to-end authoring contracts for named RGBA choices; they are not cell constraints.
use devcel_core::{
    column_editor::{self, EditorDraft, EditorMode, EditorRequest, EditorTarget},
    *,
};
use serde_json::json;

fn preset(name: &str, data_type: ValueType, value: &str) -> ColorSwatch {
    ColorSwatch {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        data_type,
        value: value.into(),
    }
}
fn palette() -> Vec<ColorSwatch> {
    normalize_color_swatches(vec![
        preset(
            "透明HDR",
            ValueType::ColorFloat,
            "[-2.25,4.125,0.100000001,0]",
        ),
        preset("透明byte", ValueType::Color32, "[7,128,255,0]"),
    ])
    .unwrap()
}
fn fixture() -> (tempfile::TempDir, Project, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Swatches", dir.path().to_str().unwrap(), "", "#242A30").unwrap();
    let path = project.create_table("Colors.table.toml".into()).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns = vec![ColumnSchema {
        data_name: "tint".into(),
        display_name: "tint".into(),
        data_type: ValueType::ColorFloat,
        default_value: ValueType::ColorFloat.default_value(),
        memo_text: "keep memo".into(),
        ..Default::default()
    }];
    table.data.records.push(Record::new());
    std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    (dir, project, path)
}
fn editor_request(project: &Project, table: &TableData) -> EditorRequest {
    let target = EditorTarget {
        mode: EditorMode::Table,
        target_uuid: table.uuid.clone(),
        column_uuid: Some(table.schema.columns[0].uuid.clone()),
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
            read_only: false,
            min_version: column.min_version.to_string(),
            name: column.display_name,
            column_type: operations::value_type_to_string(&column.data_type),
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
fn column_editor_requires_an_explicit_content_version() {
    let column = ColumnSchema::default();
    let draft = EditorDraft {
        display_name: None,
        tags: vec![],
        font_size: 12,
        read_only: false,
        min_version: "0".into(),
        name: "value".into(),
        column_type: "String".into(),
        tooltip: String::new(),
        memo_text: String::new(),
        default_value: String::new(),
        color: column.style.color,
        reference_config: None,
        curve_config: None,
        table_ref_config: None,
        select_config: None,
        color_swatches: Vec::new(),
        input_validation: None,
        conditional_formatting: None,
        conditional_formatting_override: None,
    };
    let mut value = serde_json::to_value(&draft).unwrap();
    assert!(serde_json::from_value::<EditorDraft>(value.clone()).is_ok());
    value.as_object_mut().unwrap().remove("min_version");
    assert!(serde_json::from_value::<EditorDraft>(value.clone()).is_err());
    value["min_version"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<EditorDraft>(value).is_err());
}

#[test]
fn named_rgba_inputs_normalize_without_losing_precision_or_transparent_rgb() {
    let mut raw = preset(
        "  発光  ",
        ValueType::ColorFloat,
        "[-2.25,4.125,0.100000001,0]",
    );
    raw.id = raw.id.to_uppercase();
    let normalized = normalize_color_swatches(vec![raw.clone()]).unwrap();
    assert_eq!(normalized[0].name, "発光");
    assert_eq!(normalized[0].id, raw.id.to_lowercase());
    assert_eq!(normalized[0].value, "[-2.25,4.125,0.1,0.0]");
    validate_color_swatches(&normalized).unwrap();
    assert_eq!(
        apply_color_swatch(&normalized[0], &ValueType::ColorFloat).unwrap(),
        normalized[0].value
    );
    assert!(apply_color_swatch(&normalized[0], &ValueType::Color32).is_err());
    assert!(apply_color_swatch(&normalized[0], &ValueType::String).is_err());
    assert!(validate_color_swatches(&[raw]).is_err());
    assert!(normalize_color_swatches(vec![normalized[0].clone(), normalized[0].clone()]).is_err());
    for name in ["", "   ", "bad\nname", "bad\0name", &"色".repeat(129)] {
        let mut invalid = normalized[0].clone();
        invalid.name = name.into();
        assert!(normalize_color_swatches(vec![invalid]).is_err());
    }
    for value in [
        "[0,0,0,1.1]",
        "[NaN,0,0,1]",
        "[1e40,0,0,1]",
        "=COLORFLOAT(1,1,1)",
        "#FFFFFF",
    ] {
        let mut invalid = normalized[0].clone();
        invalid.value = value.into();
        assert!(normalize_color_swatches(vec![invalid]).is_err());
    }
    let mut wrong_type = normalized[0].clone();
    wrong_type.data_type = ValueType::String;
    assert!(normalize_color_swatches(vec![wrong_type]).is_err());
    let mut wrong_id = normalized[0].clone();
    wrong_id.id = "not-an-id".into();
    assert!(normalize_color_swatches(vec![wrong_id]).is_err());
    let many = (0..257)
        .map(|_| preset("x", ValueType::Color32, "[1,2,3,4]"))
        .collect();
    assert!(normalize_color_swatches(many).is_err());
    let bytes = rmp_serde::to_vec_named(&palette()).unwrap();
    let roundtrip: Vec<ColorSwatch> = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(roundtrip[0].value, "[-2.25,4.125,0.1,0.0]");
    assert_eq!(roundtrip[1].value, "[7,128,255,0]");
}

#[test]
fn draft_swatch_selection_validates_only_precision_and_canonical_rgba() {
    for mut swatch in palette() {
        for name in ["  Glow  ", "", " "] {
            swatch.name = name.into();
            swatch.id = "unfinished-draft-id".into();
            assert_eq!(
                apply_color_swatch(&swatch, &swatch.data_type).unwrap(),
                swatch.value
            );
            // Applying a draft must not weaken strict save/load metadata validation.
            assert!(validate_color_swatches(&[swatch.clone()]).is_err());
            assert!(normalize_color_swatches(vec![swatch.clone()]).is_err());
        }
    }
    let mut swatch = palette().remove(0);
    swatch.name.clear();
    assert!(apply_color_swatch(&swatch, &ValueType::Color32).is_err());
    assert!(normalize_color_swatches(vec![swatch.clone()]).is_err());
    for value in [
        "[-2.25,4.125,0.100000001,0]",
        "[-2.25, 4.125, 0.1, 0.0]",
        "[0,0,0,1.1]",
        "[NaN,0,0,1]",
        "[1e40,0,0,1]",
        "=COLORFLOAT(1,1,1)",
        "#FFFFFF",
    ] {
        swatch.value = value.into();
        assert!(apply_color_swatch(&swatch, &ValueType::ColorFloat).is_err());
    }
    swatch.data_type = ValueType::String;
    swatch.value = "[1,2,3,4]".into();
    assert!(apply_color_swatch(&swatch, &ValueType::String).is_err());
    swatch.data_type = ValueType::Color32;
    for value in ["[1,2,3,256]", "[1,2,3,4.0]", "[1, 2, 3, 4]"] {
        swatch.value = value.into();
        assert!(apply_color_swatch(&swatch, &ValueType::Color32).is_err());
    }
}

#[test]
fn column_palette_edits_are_atomic_undoable_and_survive_type_changes_and_reload() {
    let (_dir, mut project, path) = fixture();
    let original = project.tables_data[&path].data.clone();
    let mut request = editor_request(&project, &original);
    request.draft.color_swatches = palette();
    let stale = request.clone();
    column_editor::save(&mut project, request, None).unwrap();
    let saved = project.tables_data[&path].data.clone();
    let expected = saved.schema.columns[0].color_swatches.clone();
    assert_ne!(
        cell_rules::revision(&original),
        cell_rules::revision(&saved)
    );
    assert!(column_editor::save(&mut project, stale, None).is_err());
    assert_eq!(saved.schema.columns[0].memo_text, "keep memo");
    assert!(saved.records[0].values.is_empty());
    let mut edit = editor_request(&project, &saved);
    edit.draft.color_swatches.reverse();
    edit.draft.color_swatches[0].name = "renamed".into();
    edit.draft.column_type = "String".into();
    column_editor::save(&mut project, edit, None).unwrap();
    let changed = project.tables_data[&path].data.clone();
    assert_eq!(changed.schema.columns[0].color_swatches[1], expected[0]);
    assert_eq!(
        changed.schema.columns[0].color_swatches[0].id,
        expected[1].id
    );
    project.undo_command(&original.uuid).unwrap();
    assert_eq!(
        project.tables_data[&path].data.schema.columns[0].color_swatches,
        expected
    );
    project.redo_command(&original.uuid).unwrap();
    let mut reopened = Project::open_project(project.path.to_str().unwrap()).unwrap();
    reopened.load_table(&path).unwrap();
    assert_eq!(
        reopened.tables_data[&path].data.schema.columns[0].color_swatches,
        changed.schema.columns[0].color_swatches
    );
    let mut invalid = editor_request(&project, &changed);
    invalid.draft.color_swatches[0].value = "[999,0,0,0]".into();
    let disk = std::fs::read(&path).unwrap();
    let history = project.tables_data[&path].undo_history.len();
    assert!(column_editor::save(&mut project, invalid, None).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), disk);
    assert_eq!(project.tables_data[&path].undo_history.len(), history);
    let mut remove = editor_request(&project, &changed);
    remove.draft.color_swatches.clear();
    column_editor::save(&mut project, remove, None).unwrap();
    assert!(project.tables_data[&path].data.schema.columns[0]
        .color_swatches
        .is_empty());
    project.undo_command(&original.uuid).unwrap();
    assert_eq!(
        project.tables_data[&path].data.schema.columns[0].color_swatches,
        changed.schema.columns[0].color_swatches
    );
}

#[test]
fn swatch_only_interface_history_propagates_and_rename_revert_preserves_identity() {
    let (_dir, mut project, path) = fixture();
    let mut base = Interface::new("BasePalette".into(), None);
    base.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "tint".into(),
                data_type: ValueType::ColorFloat,
                ..Default::default()
            },
        }],
        None,
        None,
    )
    .unwrap();
    let first = base.current_version_id;
    let column_id = base.columns[0].uuid.clone();
    let mut child = Interface::new("ChildPalette".into(), None);
    child
        .create_new_version(
            vec![InterfaceChange::ModifyExtends {
                new_extends: vec![base.uuid],
            }],
            None,
            None,
        )
        .unwrap();
    let mut registry = InterfaceRegistry::new();
    registry.add_interface(base.clone()).unwrap();
    registry.add_interface(child.clone()).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns.clear();
    table.apply_interface(&child, &registry, true).unwrap();
    let mut direct = table.clone();
    direct.data.schema.columns.clear();
    direct.data.interface_implementations.clear();
    direct.data.metadata.interface_order.clear();
    direct.apply_interface(&base, &registry, true).unwrap();
    let choices = palette();
    base.create_new_version(
        vec![InterfaceChange::ChangeColorSwatches {
            column_name: "tint".into(),
            swatches: choices.clone(),
        }],
        None,
        None,
    )
    .unwrap();
    *registry.get_interface_mut(&base.uuid).unwrap() = base.clone();
    let delta = base.apply_to_table(&mut direct, first, &registry).unwrap();
    assert!(delta
        .metadata_changes
        .iter()
        .any(|change| change.contains("color swatch")));
    assert_eq!(direct.data.schema.columns[0].color_swatches, choices);
    assert_eq!(direct.data.schema.columns[0].uuid, column_id);
    child.reconcile_table(table, &registry).unwrap();
    assert_eq!(table.data.schema.columns[0].color_swatches, choices);
    let with_swatches = base.current_version_id;
    let mut renamed = choices.clone();
    renamed.reverse();
    renamed[0].name = "new name".into();
    base.create_new_version(
        vec![
            InterfaceChange::RenameColumn {
                old_name: "tint".into(),
                new_name: "renamed_tint".into(),
            },
            InterfaceChange::ChangeColorSwatches {
                column_name: "renamed_tint".into(),
                swatches: renamed,
            },
        ],
        None,
        None,
    )
    .unwrap();
    base.revert_to_version(with_swatches, None, None).unwrap();
    assert_eq!(base.columns[0].uuid, column_id);
    assert_eq!(base.columns[0].data_name, "tint");
    assert_eq!(base.columns[0].color_swatches, choices);
    base.validate_storage_contract().unwrap();
    let wire = rmp_serde::to_vec_named(&base).unwrap();
    let decoded: Interface = rmp_serde::from_slice(&wire).unwrap();
    decoded.validate_storage_contract().unwrap();
    assert_eq!(decoded.columns[0].color_swatches, choices);
    let interface_path = path.parent().unwrap().join("Base.interface.toml");
    base.save_to_file(&interface_path).unwrap();
    assert_eq!(
        Interface::load_from_file(&interface_path).unwrap().columns[0].color_swatches,
        choices
    );
    base.revert_to_version(first, None, None).unwrap();
    assert!(base.columns[0].color_swatches.is_empty());
}

#[test]
fn interface_palette_lists_are_an_independent_three_way_merge_field() {
    let mut base = Interface::new("PaletteBranches".into(), None);
    base.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "tint".into(),
                color_swatches: palette(),
                ..Default::default()
            },
        }],
        None,
        None,
    )
    .unwrap();
    let mut ours = base.clone();
    let mut theirs = base;
    let mut a = ours.columns[0].color_swatches.clone();
    a[0].name = "ours".into();
    let mut b = theirs.columns[0].color_swatches.clone();
    b.reverse();
    ours.create_new_version(
        vec![InterfaceChange::ChangeColorSwatches {
            column_name: "tint".into(),
            swatches: a,
        }],
        None,
        None,
    )
    .unwrap();
    theirs
        .create_new_version(
            vec![InterfaceChange::ChangeColorSwatches {
                column_name: "tint".into(),
                swatches: b.clone(),
            }],
            None,
            None,
        )
        .unwrap();
    let ours_id = ours.current_version_id;
    let theirs_id = theirs.current_version_id;
    ours.absorb_history(&theirs).unwrap();
    let conflicts = ours.preview_merge_conflicts(ours_id, theirs_id).unwrap();
    assert!(conflicts.iter().any(|conflict| conflict
        .field_conflicts
        .iter()
        .any(|field| field.field == "color_swatches")));
    let resolutions =
        std::collections::HashMap::from([("tint".into(), ResolutionType::TakeTheirs)]);
    ours.merge_branches(ours_id, theirs_id, &resolutions, None, None)
        .unwrap();
    assert_eq!(ours.columns[0].color_swatches, b);
    ours.validate_storage_contract().unwrap();
}

#[test]
fn authoring_wire_contains_presets_but_runtime_and_sdk_metadata_are_unchanged() {
    let (_dir, mut project, path) = fixture();
    let before = json_export::export_runtime_bundle(&mut project, ExportMode::Full, None).unwrap();
    let mut request = editor_request(&project, &project.tables_data[&path].data);
    request.draft.color_swatches = palette();
    column_editor::save(&mut project, request, None).unwrap();
    let table = &project.tables_data[&path].data;
    let authoring = serde_json::to_value(table).unwrap();
    assert_eq!(
        authoring["schema"]["columns"][0]["color_swatches"][0]["value"],
        json!("[-2.25,4.125,0.1,0.0]")
    );
    let bytes = rmp_serde::to_vec_named(table).unwrap();
    let decoded: TableData = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(
        decoded.schema.columns[0].color_swatches,
        table.schema.columns[0].color_swatches
    );
    assert!(!json_export::export_table_metadata_as_json(table)
        .unwrap()
        .contains("color_swatches"));
    let after = json_export::export_runtime_bundle(&mut project, ExportMode::Full, None).unwrap();
    assert_eq!(before.manifest.content_hash, after.manifest.content_hash);
    assert_eq!(
        serde_json::to_value(&before.tables).unwrap(),
        serde_json::to_value(&after.tables).unwrap()
    );
    assert!(!serde_json::to_string(&after)
        .unwrap()
        .contains("color_swatches"));
    let captured = replication::capture(&project).unwrap();
    assert!(serde_json::to_string(&captured)
        .unwrap()
        .contains("color_swatches"));
    #[cfg(feature = "p2p")]
    {
        use devcel_core::p2p_messages::P2PMessage;
        let bytes = rmp_serde::to_vec_named(&P2PMessage::broadcast(captured.clone())).unwrap();
        let P2PMessage::Broadcast { project_state } = rmp_serde::from_slice(&bytes).unwrap() else {
            panic!("broadcast expected")
        };
        assert_eq!(project_state, captured);
    }
}

#[test]
fn persisted_non_color_columns_and_inactive_interface_history_reject_invalid_presets() {
    let (_dir, project, path) = fixture();
    let mut data = project.tables_data[&path].data.clone();
    data.schema.columns[0].data_type = ValueType::String;
    data.schema.columns[0].color_swatches = palette();
    let encoded = toml::to_string(&data).unwrap();
    let decoded: TableData = toml::from_str(&encoded).unwrap();
    assert_eq!(
        decoded.schema.columns[0].color_swatches,
        data.schema.columns[0].color_swatches
    );
    data.schema.columns[0].color_swatches[0].value = "[-2.25,4.125,0.1,0]".into();
    assert!(data.validate_storage_contract().is_err());
    assert!(toml::from_str::<TableData>(&toml::to_string(&data).unwrap()).is_err());
    let mut interface = Interface::new("History".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "tint".into(),
                    color_swatches: palette(),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    let saved_version = interface.current_version_id;
    interface
        .create_new_version(
            vec![InterfaceChange::RemoveColumn {
                column_name: "tint".into(),
            }],
            None,
            None,
        )
        .unwrap();
    let InterfaceChange::AddColumn { column } =
        &mut interface.history.get_mut(&saved_version).unwrap().changes[0]
    else {
        unreachable!()
    };
    column.color_swatches[0].value = "[0,0,0,2]".into();
    assert!(interface.validate_storage_contract().is_err());
}

#[test]
fn inherited_column_palette_cannot_be_overridden_through_table_editor() {
    let (_dir, mut project, path) = fixture();
    let choices = palette();
    let mut interface = Interface::new("OwnedPalette".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "tint".into(),
                    display_name: "tint".into(),
                    data_type: ValueType::ColorFloat,
                    color_swatches: choices.clone(),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    project.add_interface(interface.clone()).unwrap();
    let registry = project.interface_registry.clone();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns.clear();
    table.apply_interface(&interface, &registry, true).unwrap();
    std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    let before = project.tables_data[&path].data.clone();
    let disk = std::fs::read(&path).unwrap();
    let history = project.tables_data[&path].undo_history.len();
    let mut request = editor_request(&project, &before);
    request.draft.color_swatches[0].name = "unauthorized override".into();
    assert!(column_editor::preview(&project, &request).is_err());
    assert!(column_editor::save(&mut project, request, None).is_err());
    assert_eq!(
        project.tables_data[&path].data.schema.columns[0].color_swatches,
        choices
    );
    assert_eq!(
        cell_rules::revision(&before),
        cell_rules::revision(&project.tables_data[&path].data)
    );
    assert_eq!(std::fs::read(&path).unwrap(), disk);
    assert_eq!(project.tables_data[&path].undo_history.len(), history);
}
