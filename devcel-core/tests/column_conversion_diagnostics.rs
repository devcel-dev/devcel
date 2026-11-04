//! Column editor conversion preview/save keep locale-neutral diagnostics and atomic rejection.
use devcel_core::{
    cell_rules,
    column_editor::{self, EditorDraft, EditorMode, EditorRequest, EditorTarget},
    types::Diagnostic,
    AppError, ColumnSchema, DevcelError, Project, Record, ValueType,
};
use serde_json::json;
use std::path::PathBuf;

fn fixture(values: &[&str]) -> (tempfile::TempDir, Project, PathBuf, EditorRequest) {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "ConversionDiagnostics",
        directory.path().to_str().unwrap(),
        "",
        "#ffffff",
    )
    .unwrap();
    let path = project.create_table("Values.table.toml".into()).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns = vec![ColumnSchema {
        data_name: "value".into(),
        display_name: "value".into(),
        data_type: ValueType::String,
        ..Default::default()
    }];
    table.data.records = values
        .iter()
        .map(|value| {
            let mut record = Record::new();
            record.values.insert("value".into(), (*value).into());
            record
        })
        .collect();
    std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    table.is_dirty = false;
    let target = EditorTarget {
        mode: EditorMode::Table,
        target_uuid: table.data.uuid.clone(),
        column_uuid: Some(table.data.schema.columns[0].uuid.clone()),
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
            tags: vec![],
            font_size: 12,
            read_only: column.read_only,
            min_version: column.min_version.to_string(),
            name: column.display_name,
            column_type: "String".into(),
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
    (directory, project, path, request)
}

#[test]
fn conversion_failures_keep_codes_through_preview_and_save_without_mutation() {
    for (raw, target_type, key, params) in [
        ("300", "U8", "invalidValue", json!({ "type": "U8" })),
        ("1.2", "I32", "invalidValue", json!({ "type": "I32" })),
        ("NaN", "F64", "invalidValue", json!({ "type": "F64" })),
        (
            "not-bool",
            "Boolean",
            "invalidValue",
            json!({ "type": "Boolean" }),
        ),
        ("=1+2", "I32", "formulaReviewRequired", json!({})),
        ("16777217", "F32", "precisionLoss", json!({})),
        ("value", "None", "undefinedType", json!({})),
    ] {
        let (_directory, mut project, path, mut request) = fixture(&[raw]);
        request.draft.column_type = target_type.into();
        let before = project.tables_data[&path].data.clone();
        let bytes = std::fs::read(&path).unwrap();
        let history = project.tables_data[&path].undo_history.len();
        let expected = Diagnostic::Code {
            code: format!("column.conversion.{key}"),
            params,
        };
        let preview = column_editor::preview(&project, &request).unwrap();
        assert_eq!(preview.error_count, 1, "{target_type}: {raw}");
        let sample = preview
            .samples
            .iter()
            .find(|sample| sample.error.is_some())
            .unwrap();
        assert_eq!(sample.original_value, raw);
        assert_eq!(sample.error.as_ref(), Some(&expected));
        let location = &preview.locations[sample.table_uuid.as_ref().unwrap()];
        assert_eq!(location.table_name, before.display_name);
        assert_eq!(
            location.records[sample.record_uuid.as_ref().unwrap()],
            Diagnostic::Code {
                code: "grid.defaultRowLabel".into(),
                params: json!({ "number": 1 })
            }
        );

        let wire = serde_json::to_value(sample).unwrap();
        assert_eq!(wire["error"], serde_json::to_value(&expected).unwrap());
        assert!(wire["converted_value"].is_null());
        let error = column_editor::save(&mut project, request, None).unwrap_err();
        assert!(matches!(error, DevcelError::Diagnostics(_)));
        let AppError::Diagnostics { diagnostics } = AppError::from(error) else {
            panic!("Save must preserve structured conversion diagnostics");
        };
        assert_eq!(
            diagnostics[0],
            Diagnostic::Code {
                code: "column.conversion.saveBlocked".into(),
                params: json!({ "count": 1 }),
            }
        );
        assert!(diagnostics.contains(&expected));
        assert_eq!(
            cell_rules::revision(&before),
            cell_rules::revision(&project.tables_data[&path].data)
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(project.tables_data[&path].undo_history.len(), history);
        assert!(!project.tables_data[&path].is_dirty);
    }
}

#[test]
fn bounded_conversion_samples_preserve_late_error_codes() {
    let mut values = vec!["1"; 25];
    values.push("300");
    let (_directory, mut project, _path, mut request) = fixture(&values);
    request.draft.column_type = "U8".into();
    let preview = column_editor::preview(&project, &request).unwrap();
    assert_eq!(preview.samples.len(), 20);
    assert_eq!(preview.error_count, 1);
    let late = preview
        .samples
        .iter()
        .find(|sample| sample.original_value == "300")
        .unwrap();
    let locations = &preview.locations[late.table_uuid.as_ref().unwrap()];
    assert_eq!(
        locations.records[late.record_uuid.as_ref().unwrap()],
        Diagnostic::Code {
            code: "grid.defaultRowLabel".into(),
            params: json!({ "number": 26 })
        },
        "bounded sample position must not replace the actual source row index"
    );
    assert!(
        locations.records.len() <= 40,
        "locations only describe returned samples/issues, not every source row"
    );

    assert!(preview.samples.iter().any(|sample| sample.original_value == "300" && matches!(
        &sample.error, Some(Diagnostic::Code { code, .. }) if code == "column.conversion.invalidValue"
    )));
    let AppError::Diagnostics { diagnostics } =
        AppError::from(column_editor::save(&mut project, request, None).unwrap_err())
    else {
        panic!("Save must preserve structured conversion diagnostics");
    };
    assert!(diagnostics.iter().any(|diagnostic| matches!(diagnostic, Diagnostic::Code { code, .. } if code == "column.conversion.invalidValue")));
}

#[test]
fn successful_conversion_and_empty_values_keep_the_existing_contract() {
    let (_directory, mut project, path, mut request) = fixture(&["00012", ""]);
    request.draft.column_type = "I32".into();
    let preview = column_editor::preview(&project, &request).unwrap();
    assert_eq!(preview.error_count, 0);
    assert!(preview.samples.iter().all(|sample| sample.error.is_none()));
    assert_eq!(
        preview
            .samples
            .iter()
            .find(|sample| sample.original_value == "00012")
            .unwrap()
            .converted_value
            .as_deref(),
        Some("12")
    );
    column_editor::save(&mut project, request, None).unwrap();
    assert_eq!(
        project.tables_data[&path].data.records[0].values["value"],
        "12"
    );
    assert_eq!(
        project.tables_data[&path].data.records[1].values["value"],
        ""
    );
}

#[test]
fn explicit_display_label_preserves_internal_name_values_and_preview_history() {
    let (_directory, mut project, path, mut request) = fixture(&["kept"]);
    request.draft.display_name = Some("Visible label / 表示名".into());
    let before = project.tables_data[&path].data.clone();
    let bytes = std::fs::read(&path).unwrap();
    let history = project.tables_data[&path].undo_history.len();
    assert_eq!(
        column_editor::preview(&project, &request)
            .unwrap()
            .error_count,
        0
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(project.tables_data[&path].undo_history.len(), history);
    assert_eq!(
        cell_rules::revision(&project.tables_data[&path].data),
        cell_rules::revision(&before)
    );
    column_editor::save(&mut project, request, None).unwrap();
    let after = &project.tables_data[&path].data;
    assert_eq!(after.schema.columns[0].data_name, "value");
    assert_eq!(
        after.schema.columns[0].display_name,
        "Visible label / 表示名"
    );
    assert_eq!(after.records[0].values, before.records[0].values);
    let id = after.uuid.clone();
    project.undo_command(&id).unwrap();
    assert_eq!(
        project.tables_data[&path].data.schema.columns[0].display_name,
        "value"
    );
    project.redo_command(&id).unwrap();
    assert_eq!(
        project.tables_data[&path].data.schema.columns[0].data_name,
        "value"
    );
}

#[test]
fn explicit_internal_rename_moves_values_and_keeps_display_label() {
    let (_directory, mut project, path, mut request) = fixture(&["kept"]);
    request.draft.display_name = Some("Visible label".into());
    request.draft.name = "renamed_value".into();
    column_editor::save(&mut project, request, None).unwrap();
    let after = &project.tables_data[&path].data;
    assert_eq!(after.schema.columns[0].display_name, "Visible label");
    assert_eq!(after.schema.columns[0].data_name, "renamed_value");
    assert_eq!(
        after.records[0]
            .values
            .get("renamed_value")
            .map(String::as_str),
        Some("kept")
    );
    assert!(!after.records[0].values.contains_key("value"));
}

#[test]
fn disabled_rules_roundtrip_without_enforcement_and_reenable_keeps_conditions() {
    let (_directory, mut project, path, mut request) = fixture(&[""]);
    request.draft.input_validation = Some(serde_json::from_value(json!({
        "enabled": false, "mode": "reject", "message": "", "hint": "", "rules": [{"kind":"required"}]
    })).unwrap());
    let result = column_editor::preview(&project, &request).unwrap();
    assert_eq!(result.input_issue_count, 0);
    assert!(result
        .input_reports
        .iter()
        .all(|entry| entry.report.issues.is_empty()));
    column_editor::save(&mut project, request.clone(), None).unwrap();
    let context = column_editor::load(&project, &request.target).unwrap();
    let settings = context.column.input_validation.unwrap();
    assert!(!settings.enabled);
    assert_eq!(settings.rules.len(), 1);
    let disk: devcel_core::TableData =
        toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(
        !disk.schema.columns[0]
            .input_validation
            .as_ref()
            .unwrap()
            .enabled
    );
    request.expected_revision = context.revision;
    request.draft.input_validation.as_mut().unwrap().enabled = true;
    let bytes = std::fs::read(&path).unwrap();
    let result = column_editor::preview(&project, &request).unwrap();
    // Re-enabling reports existing invalid data, but does not introduce a value
    // transition. Existing-data warnings must not become a save rejection.
    assert_eq!(result.input_issue_count, 1);
    assert_eq!(result.reject_issue_count, 1);
    assert!(result
        .input_reports
        .iter()
        .all(|entry| entry.report.issues.is_empty()));
    assert!(
        !project.tables_data[&path].data.schema.columns[0]
            .input_validation
            .as_ref()
            .unwrap()
            .enabled
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    column_editor::save(&mut project, request, None).unwrap();
    let saved = &project.tables_data[&path].data.schema.columns[0].input_validation;
    assert!(saved.as_ref().unwrap().enabled);
    assert_eq!(saved.as_ref().unwrap().rules.len(), 1);
    let legacy: devcel_core::cell_rules::InputValidationSettings =
        serde_json::from_value(json!({"mode":"reject","rules":[{"kind":"required"}]})).unwrap();
    assert!(legacy.enabled);
}

#[test]
fn ordinary_editor_preserves_version_even_from_stale_or_invalid_drafts() {
    for incoming in ["999", "-1", "not-a-version"] {
        let (_directory, mut project, path, mut request) = fixture(&["hello"]);
        project
            .tables_data
            .get_mut(&path)
            .unwrap()
            .data
            .schema
            .columns[0]
            .min_version = 7;
        std::fs::write(
            &path,
            toml::to_string(&project.tables_data[&path].data).unwrap(),
        )
        .unwrap();
        request.expected_revision = column_editor::load(&project, &request.target)
            .unwrap()
            .revision;
        request.draft.min_version = incoming.into();
        request.draft.tooltip = "changed tooltip".into();
        column_editor::save(&mut project, request, None).unwrap();
        assert_eq!(
            project.tables_data[&path].data.schema.columns[0].min_version,
            7
        );
        assert_eq!(
            project.tables_data[&path].data.schema.columns[0].tooltip,
            "changed tooltip"
        );
    }
}

#[test]
fn new_column_uses_backend_default_not_restored_draft_version() {
    let (_directory, mut project, path, mut request) = fixture(&["hello"]);
    request.target.column_uuid = None;
    let context = column_editor::load(&project, &request.target).unwrap();
    request.expected_revision = context.revision;
    request.creation_uuid = Some(context.column.uuid.clone());
    request.draft.name = "new_field".into();
    request.draft.min_version = "999".into();
    column_editor::save(&mut project, request, None).unwrap();
    let column = project.tables_data[&path]
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "new_field")
        .unwrap();
    assert_eq!(column.min_version, context.column.min_version);
    assert_eq!(column.min_version, 0);
}
