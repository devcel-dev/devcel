//! Record inheritance is authoring input resolution, never parent-context evaluation.
use devcel_core::commands::{SetRecordParentUuidCommand, SetRecordValueCommand};
use devcel_core::json_export::{ExportMode, ExportTable};
use devcel_core::{
    ColumnSchema, Project, Record, TableData, TableMetadata, TableSchema, ValueType,
};
use std::collections::HashMap;

fn column(name: &str, ty: ValueType, default: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: ty,
        default_value: default.into(),
        ..Default::default()
    }
}
fn data(columns: Vec<ColumnSchema>, records: Vec<Record>) -> TableData {
    TableData {
        description: String::new(),
        uuid: uuid::Uuid::new_v4().to_string(),
        display_name: "inheritance".into(),
        metadata: TableMetadata {
            schema_version: 1,
            interface_order: Vec::new(),
            initial_transposed: false,
            edit_permissions: Default::default(),
            parent_uuid: String::new(),
            data_name: "inheritance".into(),
        },
        interface_implementations: HashMap::new(),
        schema: TableSchema { columns },
        records,
    }
}
fn fixture() -> TableData {
    let a = column("amount", ValueType::I64, "7");
    let b = column("result", ValueType::I64, "0");
    let text = column("text", ValueType::String, "default");
    let flag = column("flag", ValueType::Boolean, "true");
    let mut parent = Record::new();
    parent.label = "parent label".into();
    parent.tags = vec!["parent tag".into()];
    parent.min_version = 9;
    parent.set_cell_value(&a, "10".into());
    parent.set_cell_value(&b, "=amount*2".into());
    parent.set_cell_value(&text, "parent text".into());
    parent.set_cell_value(&flag, "true".into());
    let mut child = Record::new();
    child.parent_uuid = parent.uuid.clone();
    child.set_cell_value(&a, "3".into());
    let mut grandchild = Record::new();
    grandchild.parent_uuid = child.uuid.clone();
    data(vec![a, b, text, flag], vec![parent, child, grandchild])
}
fn install(data: TableData) -> (tempfile::TempDir, Project, String) {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "Inheritance",
        directory.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let path = project
        .create_table("inheritance.table.toml".into())
        .unwrap();
    project.load_table(&path).unwrap();
    let id = data.uuid.clone();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data = data;
    Project::save_table(table).unwrap();
    (directory, project, id)
}

#[test]
fn multilevel_local_empty_zero_false_and_default_are_distinct() {
    let mut d = fixture();
    let cols = d.schema.columns.clone();
    assert_eq!(
        d.effective_cell_input(&d.records[2], &cols[0]).unwrap(),
        "3"
    );
    d.records[1].set_cell_value(&cols[0], "0".into());
    d.records[1].set_cell_value(&cols[2], String::new());
    d.records[1].set_cell_value(&cols[3], "false".into());
    assert_eq!(
        d.effective_cell_input(&d.records[2], &cols[0]).unwrap(),
        "0"
    );
    assert_eq!(
        d.effective_cell_input(&d.records[2], &cols[2]).unwrap(),
        "parent text"
    );
    assert_eq!(
        d.effective_cell_input(&d.records[2], &cols[3]).unwrap(),
        "false"
    );
    d.records[1].remove_cell_value(&cols[0]);
    assert_eq!(
        d.effective_cell_input(&d.records[2], &cols[0]).unwrap(),
        "10"
    );
    d.records[1].remove_cell_value(&cols[0]);
    assert_eq!(
        d.effective_cell_input(&d.records[2], &cols[0]).unwrap(),
        "10"
    );
    assert!(d.records[2].label.is_empty());
    assert!(d.records[2].tags.is_empty());
    assert_eq!(d.records[2].min_version, 0);
}

#[test]
fn inherited_formulas_use_child_context_and_hidden_parent_remains_source() {
    let mut d = fixture();
    let before = serde_json::to_value(&d).unwrap();
    let out = ExportTable::from_table_data_filtered(&mut d, ExportMode::Full, Some(0)).unwrap();
    assert_eq!(out.records.len(), 2);
    assert_eq!(out.records[0].values["result"], "6");
    assert_eq!(out.records[1].values["result"], "6");
    assert_eq!(serde_json::to_value(&d).unwrap(), before);
    let presentation = devcel_core::cell_rules::presentation(&d);
    let json = serde_json::to_value(presentation).unwrap().to_string();
    assert!(json.contains("=amount*2"));
}

#[test]
fn detach_materializes_formulas_and_undo_restores_inputs() {
    let d = fixture();
    let child = d.records[1].uuid.clone();
    let col = d.schema.columns[1].clone();
    let (_dir, mut p, id) = install(d);
    let before = serde_json::to_value(&p.find_table_by_uuid(&id).unwrap().data).unwrap();
    p.execute_command(
        SetRecordParentUuidCommand::new(id.clone(), child.clone(), String::new()),
        None,
    )
    .unwrap();
    let row = &p.find_table_by_uuid(&id).unwrap().data.records[1];
    assert!(row.parent_uuid.is_empty());
    assert_eq!(row.get_cell_value(&col).unwrap(), "=amount*2");
    assert!(row.get_cell_value(&col).is_some());
    p.undo_command(&id).unwrap();
    assert_eq!(
        serde_json::to_value(&p.find_table_by_uuid(&id).unwrap().data).unwrap(),
        before
    );
}

#[test]
fn reparent_preserves_default_and_local_overrides() {
    let mut d = fixture();
    let col = d.schema.columns[2].clone();
    d.records[1].remove_cell_value(&col);
    let mut other = Record::new();
    other.set_cell_value(&d.schema.columns[0], "99".into());
    let other_id = other.uuid.clone();
    d.records.push(other);
    let child = d.records[1].uuid.clone();
    let (_dir, mut p, id) = install(d);
    p.execute_command(
        SetRecordParentUuidCommand::new(id.clone(), child, other_id),
        None,
    )
    .unwrap();
    let table = &p.find_table_by_uuid(&id).unwrap().data;
    assert_eq!(
        table
            .effective_cell_input(&table.records[1], &table.schema.columns[0])
            .unwrap(),
        "3"
    );
    assert!(table.records[1].get_cell_value(&col).is_none());
}

#[test]
fn invalid_parent_cycles_are_atomic_and_distinct_from_formula_cycles() {
    let d = fixture();
    let parent = d.records[0].uuid.clone();
    let child = d.records[2].uuid.clone();
    let (_dir, mut p, id) = install(d);
    let before = serde_json::to_value(&p.find_table_by_uuid(&id).unwrap().data).unwrap();
    for target in [parent.clone(), child, uuid::Uuid::new_v4().to_string()] {
        let error = p
            .execute_command(
                SetRecordParentUuidCommand::new(id.clone(), parent.clone(), target),
                None,
            )
            .unwrap_err();
        let error = serde_json::to_value(devcel_core::AppError::from(error)).unwrap();
        assert!(matches!(
            error["diagnostics"][0]["code"].as_str(),
            Some("error.record.parentCycle" | "error.record.parentMissing")
        ));
        assert_eq!(
            serde_json::to_value(&p.find_table_by_uuid(&id).unwrap().data).unwrap(),
            before
        );
    }
}

#[test]
fn clear_command_undo_and_absence_survive_roundtrip() {
    let d = fixture();
    let child = d.records[1].uuid.clone();
    let col = d.schema.columns[0].clone();
    let (_dir, mut p, id) = install(d);
    p.execute_command(
        SetRecordValueCommand::new(id.clone(), child, col.uuid.clone(), String::new()),
        None,
    )
    .unwrap();
    let table = &p.find_table_by_uuid(&id).unwrap().data;
    let copy: TableData = toml::from_str(&toml::to_string(table).unwrap()).unwrap();
    assert!(copy.records[1].get_cell_value(&col).is_none());
    assert_eq!(
        copy.effective_cell_input(&copy.records[1], &col).unwrap(),
        "10"
    );
    p.undo_command(&id).unwrap();
    assert_eq!(
        p.find_table_by_uuid(&id).unwrap().data.records[1]
            .get_cell_value(&col)
            .unwrap(),
        "3"
    );
}

#[test]
fn raw_serialization_preserves_absence_without_materialization() {
    let d = fixture();
    let raw = serde_json::to_value(&d).unwrap();
    assert!(raw["records"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("cell_modes").is_none()));
    let copy: TableData = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(serde_json::to_value(copy).unwrap(), raw);
    assert!(d.records[2].values.is_empty());
}

#[test]
fn deep_chain_resolution_is_iterative_and_memoized() {
    let col = column("value", ValueType::String, "default");
    let mut root = Record::new();
    root.set_cell_value(&col, "input".into());
    let mut rows = vec![root];
    for _ in 1..20_000 {
        let mut row = Record::new();
        row.parent_uuid = rows.last().unwrap().uuid.clone();
        rows.push(row);
    }
    let d = data(vec![col], rows);
    d.validate_parent_graph().unwrap();
    let start = std::time::Instant::now();
    let resolver = devcel_core::table::InheritanceResolver::new(&d);
    for row in d.records.iter().rev() {
        assert_eq!(resolver.input(row, &d.schema.columns[0]).unwrap(), "input");
    }
    eprintln!("20k-chain resolution {:?}", start.elapsed());
    assert!(start.elapsed() < std::time::Duration::from_secs(10));
}

#[test]
fn parent_formula_edit_validates_descendants_atomically() {
    use devcel_core::cell_rules::{InputRule, InputValidationSettings, ValidationMode};
    let amount = column("amount", ValueType::I64, "0");
    let mut result = column("result", ValueType::I64, "0");
    result.input_validation = Some(InputValidationSettings {
        enabled: true,
        mode: ValidationMode::Reject,
        message: String::new(),
        hint: String::new(),
        rules: vec![InputRule::Unique],
    });
    let mut parent = Record::new();
    parent.set_cell_value(&amount, "1".into());
    parent.set_cell_value(&result, "=amount".into());
    let parent_id = parent.uuid.clone();
    let mut child = Record::new();
    child.parent_uuid = parent_id.clone();
    child.set_cell_value(&amount, "2".into());
    let mut peer = Record::new();
    peer.set_cell_value(&result, "4".into());
    let (_dir, mut p, id) = install(data(
        vec![amount, result.clone()],
        vec![parent, child, peer],
    ));
    let before = serde_json::to_value(&p.find_table_by_uuid(&id).unwrap().data).unwrap();
    let error = p
        .execute_command(
            SetRecordValueCommand::new(id.clone(), parent_id, result.uuid, "=amount*2".into()),
            None,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        devcel_core::DevcelError::InputValidation(_)
    ));
    assert_eq!(
        serde_json::to_value(&p.find_table_by_uuid(&id).unwrap().data).unwrap(),
        before
    );
}

#[test]
fn column_deletion_and_undo_restore_absence_by_uuid() {
    let mut d = fixture();
    let col = d.schema.columns[2].clone();
    d.records[1].remove_cell_value(&col);
    let (_dir, mut p, id) = install(d);
    p.execute_command(
        devcel_core::commands::RemoveColumnCommand::new(id.clone(), col.uuid.clone()),
        None,
    )
    .unwrap();
    assert!(p.find_table_by_uuid(&id).unwrap().data.records[1]
        .get_cell_value(&col)
        .is_none());
    p.undo_command(&id).unwrap();
    let d = &p.find_table_by_uuid(&id).unwrap().data;
    assert!(d.records[1].get_cell_value(&col).is_none());
    assert_eq!(
        d.effective_cell_input(&d.records[1], &col).unwrap(),
        "parent text"
    );
}

#[test]
fn inherited_lookup_keeps_explicit_target_and_formula_cycle_is_separate() {
    let mut d = fixture();
    let result = d.schema.columns[1].clone();
    d.records[0].set_cell_value(
        &result,
        "=LOOKUP(\"source\",\"key\",\"alpha\",\"amount\")+amount".into(),
    );
    let (_dir, mut p, id) = install(d);
    let key = column("key", ValueType::String, "");
    let amount = column("amount", ValueType::I64, "0");
    let mut source_row = Record::new();
    source_row.set_cell_value(&key, "alpha".into());
    source_row.set_cell_value(&amount, "100".into());
    let mut source = data(vec![key, amount], vec![source_row]);
    source.metadata.data_name = "source".into();
    let path = p.create_table("source.table.toml".into()).unwrap();
    p.load_table(&path).unwrap();
    p.tables_data.get_mut(&path).unwrap().data = source;
    Project::save_table(&p.tables_data[&path]).unwrap();
    let context = devcel_core::formula_context::ProjectFormulaContext::new(&p, Some(0)).unwrap();
    let d = &p.find_table_by_uuid(&id).unwrap().data;
    let input = d.effective_cell_input(&d.records[1], &result).unwrap();
    assert!(
        matches!(context.evaluate_cell_with_override(d,&result,&d.records[1],input),devcel_core::FormulaResult::Value(v) if v=="103")
    );
    drop(context);
    let d = &mut p.find_table_by_uuid_mut(&id).unwrap().data;
    d.records[0].set_cell_value(&result, "=result+1".into());
    let error = devcel_core::FormulaEngine::with_table(d).evaluate_column(
        "=result+1",
        &result,
        &d.records[1],
        &d.schema,
    );
    let text = format!("{error:?}");
    assert!(text.contains("Circular"), "{text}");
    assert!(!text.contains("Parent cycle"));
}

#[test]
fn reference_and_curve_inputs_inherit_as_whole_cells() {
    let reference = column("target", ValueType::Reference, "");
    let curve = column("curve", ValueType::Curve, "");
    let mut parent = Record::new();
    let target = uuid::Uuid::new_v4().to_string();
    parent.set_cell_value(&reference, target.clone());
    parent.set_cell_value(&curve, "{\"points\":[1,2]}".into());
    let mut child = Record::new();
    child.parent_uuid = parent.uuid.clone();
    let mut d = data(vec![reference.clone(), curve.clone()], vec![parent, child]);
    assert_eq!(
        d.effective_cell_input(&d.records[1], &reference).unwrap(),
        target
    );
    assert_eq!(
        d.effective_cell_input(&d.records[1], &curve).unwrap(),
        "{\"points\":[1,2]}"
    );
    d.records[1].set_cell_value(&curve, "{\"points\":[3]}".into());
    assert_eq!(
        d.effective_cell_input(&d.records[1], &curve).unwrap(),
        "{\"points\":[3]}"
    );
}

#[test]
fn numeric_empty_query_membership_does_not_depend_on_value_provenance() {
    let key = column("key", ValueType::I64, "7");
    let value = column("value", ValueType::String, "");
    for inherited in [false, true] {
        let mut parent = Record::new();
        parent.set_cell_value(&key, "99".into());
        parent.set_cell_value(&value, "ok".into());
        let mut child = Record::new();
        child.parent_uuid = parent.uuid.clone();
        child.set_cell_value(&key, String::new());
        if !inherited {
            child.set_cell_value(&value, "ok".into());
        }
        let (_dir, p, id) = install(data(vec![key.clone(), value.clone()], vec![parent, child]));
        let d = &p.find_table_by_uuid(&id).unwrap().data;
        let context = devcel_core::formula_context::ProjectFormulaContext::new(&p, None).unwrap();
        let count = context
            .evaluate_cell(
                "=COUNTIF(\"inheritance\",\"key\",\"99\")",
                &column("count", ValueType::I64, "0"),
                &d.records[1],
                &d.schema,
                &id,
            )
            .into_result()
            .unwrap();
        let lookup = context
            .evaluate_cell(
                "=LOOKUP(\"inheritance\",\"key\",\"99\",\"value\")",
                &value,
                &d.records[1],
                &d.schema,
                &id,
            )
            .into_result()
            .unwrap_err();
        assert_eq!(count, "2");
        assert!(format!("{lookup:?}").contains("multiple records"));
    }
}

#[test]
fn standalone_export_and_presentation_reuse_lazy_parent_indices() {
    let amount = column("amount", ValueType::I64, "0");
    let result = column("result", ValueType::I64, "0");
    let mut root = Record::new();
    root.set_cell_value(&amount, "3".into());
    root.set_cell_value(&result, "=amount*2".into());
    let mut rows = vec![root];
    for _ in 1..4_000 {
        let mut row = Record::new();
        row.parent_uuid = rows.last().unwrap().uuid.clone();
        rows.push(row);
    }
    rows.reverse();
    let mut d = data(vec![amount, result], rows);
    let start = std::time::Instant::now();
    let out = ExportTable::from_table_data_filtered(&mut d, ExportMode::Full, None).unwrap();
    assert!(out.records.iter().all(|r| r.values["result"] == "6"));
    let presentation = devcel_core::cell_rules::presentation(&d);
    assert_eq!(presentation.issue_count, 0);
    eprintln!(
        "4k deep-chain formula export+presentation {:?}",
        start.elapsed()
    );
    assert!(start.elapsed() < std::time::Duration::from_secs(8));
}

#[test]
fn minimal_export_preserves_effective_values_and_omits_effective_defaults() {
    let text = column("text", ValueType::String, "default");
    let formula = column("formula", ValueType::I64, "=1+2");
    let mut parent = Record::new();
    parent.set_cell_value(&text, "parent".into());
    let mut child = Record::new();
    child.parent_uuid = parent.uuid.clone();
    let mut explicit_default = child.clone();
    explicit_default.uuid = uuid::Uuid::new_v4().to_string();
    explicit_default.remove_cell_value(&text);
    let mut empty = child.clone();
    empty.uuid = uuid::Uuid::new_v4().to_string();
    empty.set_cell_value(&text, String::new());
    let missing = Record::new();
    let mut d = data(
        vec![text, formula],
        vec![parent, child, explicit_default, empty, missing],
    );
    let out = ExportTable::from_table_data_filtered(&mut d, ExportMode::Minimal, None).unwrap();
    assert_eq!(out.records[1].values["text"], "parent");
    assert_eq!(out.records[2].values["text"], "parent");
    assert_eq!(out.records[3].values["text"], "parent");
    assert!(!out.records[4].values.contains_key("text"));
    assert!(out.records.iter().all(|r| r.values["formula"] == "3"));
}

#[test]
fn checked_batch_clear_restores_inherit_atomically_and_undo_preserves_inputs() {
    use devcel_core::table_mutation::{self, TableMutation};
    let original = fixture();
    let (_directory, mut project, id) = install(original.clone());
    let request = |table: &TableData, cells: serde_json::Value| -> TableMutation {
        serde_json::from_value(serde_json::json!({
            "table_uuid": id, "expected_revision": devcel_core::cell_rules::revision(table),
            "cells": cells
        }))
        .unwrap()
    };
    let row = &original.records[1].uuid;
    let col = &original.schema.columns[0].uuid;
    let clear = serde_json::json!([{"record_uuid": row, "column_uuid": col, "value": ""}]);
    table_mutation::apply(&mut project, request(&original, clear.clone()), None).unwrap();
    let current = project.read_table_data_by_uuid(&id).unwrap();
    assert_eq!(
        current
            .effective_cell_input(&current.records[1], &current.schema.columns[0])
            .unwrap(),
        "10"
    );
    assert_eq!(
        current
            .effective_cell_input(&current.records[2], &current.schema.columns[0])
            .unwrap(),
        "10"
    );
    assert!(current.records[1]
        .get_cell_value(&current.schema.columns[0])
        .is_none());
    assert!(table_mutation::apply(&mut project, request(&original, clear.clone()), None).is_err());
    project.undo_command(&id).unwrap();
    assert_eq!(
        devcel_core::cell_rules::revision(&project.read_table_data_by_uuid(&id).unwrap()),
        devcel_core::cell_rules::revision(&original)
    );
    let bad = serde_json::json!([
        {"record_uuid": row, "column_uuid": col, "value": ""},
        {"record_uuid": row, "column_uuid": "missing-column", "value": "invalid"}
    ]);
    assert!(table_mutation::apply(&mut project, request(&original, bad), None).is_err());
    assert_eq!(
        devcel_core::cell_rules::revision(&project.read_table_data_by_uuid(&id).unwrap()),
        devcel_core::cell_rules::revision(&original)
    );
    devcel_core::edit_controls::set_column_read_only(
        &mut project,
        devcel_core::edit_controls::ColumnReadOnlyRequest {
            table_uuid: id.clone(),
            expected_revision: devcel_core::cell_rules::revision(&original),
            column_uuid: col.clone(),
            read_only: true,
        },
        None,
    )
    .unwrap();
    let locked = project.read_table_data_by_uuid(&id).unwrap();
    assert!(table_mutation::apply(&mut project, request(&locked, clear), None).is_err());
    assert_eq!(
        devcel_core::cell_rules::revision(&project.read_table_data_by_uuid(&id).unwrap()),
        devcel_core::cell_rules::revision(&locked)
    );
}

#[test]
fn release_lint_keeps_hidden_parent_as_input_source() {
    let mut table = fixture();
    table.schema.columns[0].required = Some(true);
    table.schema.columns[0].constraints = Some(devcel_core::column::ColumnConstraints {
        unique: Some(true),
        ..Default::default()
    });
    table.schema.columns[0].input_validation =
        Some(devcel_core::cell_rules::InputValidationSettings {
            enabled: true,
            mode: devcel_core::cell_rules::ValidationMode::Reject,
            message: String::new(),
            hint: String::new(),
            rules: vec![devcel_core::cell_rules::InputRule::Unique],
        });
    table.records[1].remove_cell_value(&table.schema.columns[0]);
    table.records[2].set_cell_value(&table.schema.columns[0], "11".into());
    // Install valid storage first, then inspect a draft whose all-version uniqueness
    // intentionally differs from release uniqueness.
    let rules = table.schema.columns[0].input_validation.take();
    let constraints = table.schema.columns[0].constraints.take();
    let (_directory, mut project, id) = install(table);
    let draft = &mut project.tables_data.values_mut().next().unwrap().data;
    draft.schema.columns[0].input_validation = rules;
    draft.schema.columns[0].constraints = constraints;
    let issues =
        devcel_core::export_validation::lint_project(&mut project, Some(&id), Some(1)).unwrap();
    assert!(issues.is_empty(), "{issues:?}");
}

#[test]
fn clear_tracks_parent_and_default_changes_without_trimming_or_materializing_formulas() {
    let mut d = fixture();
    let column = d.schema.columns[2].clone();
    d.records[1].set_cell_value(&column, " ".into());
    assert_eq!(d.effective_cell_input(&d.records[1], &column).unwrap(), " ");
    d.records[1].set_cell_value(&column, "".into());
    assert!(!d.records[1].values.contains_key("text"));
    d.records[0].set_cell_value(&column, "changed parent".into());
    assert_eq!(
        d.effective_cell_input(&d.records[1], &column).unwrap(),
        "changed parent"
    );
    d.records[0].remove_cell_value(&column);
    d.schema.columns[2].default_value = "changed default".into();
    assert_eq!(
        d.effective_cell_input(&d.records[1], &d.schema.columns[2])
            .unwrap(),
        "changed default"
    );
    d.records[1].set_cell_value(&column, "=\"\"".into());
    assert_eq!(d.records[1].get_cell_value(&column).unwrap(), "=\"\"");
    let old_mode = serde_json::json!({"record_uuid":"row","column_uuid":"column","value":"", "mode":"default"});
    assert!(serde_json::from_value::<devcel_core::table_mutation::CellPatch>(old_mode).is_err());
}

#[test]
fn directly_loaded_empty_inputs_follow_parent_without_rewriting_source() {
    let mut original = fixture();
    original.records[1]
        .values
        .insert("text".into(), String::new());
    for loaded in [
        TableData::from_toml(&toml::to_string(&original).unwrap()).unwrap(),
        TableData::from_json_value(serde_json::to_value(&original).unwrap()).unwrap(),
    ] {
        assert_eq!(
            loaded
                .effective_cell_input(&loaded.records[1], &loaded.schema.columns[2])
                .unwrap(),
            "parent text"
        );
        assert_eq!(loaded.records[1].values["text"], "");
    }
}
