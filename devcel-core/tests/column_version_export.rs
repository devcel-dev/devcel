//! Release export workflow regressions: project output without pruning formula sources.
use devcel_core::{
    cell_rules::{InputRule, InputValidationSettings, ValidationMode},
    json_export::{
        export_project_metadata_as_json_filtered, export_runtime_bundle_to_file_with_validation,
        export_runtime_bundle_with_validation, export_table_metadata_as_json_filtered, ExportMode,
        ExportTable,
    },
    ColumnSchema, Project, Record, TableData, TableMetadata, TableSchema, ValueType,
};
use std::{collections::HashMap, path::PathBuf};

fn column(name: &str, min_version: u32, default: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: ValueType::I64,
        default_value: default.into(),
        min_version,
        ..Default::default()
    }
}

fn record(version: u32, values: &[(&str, &str)]) -> Record {
    Record {
        min_version: version,
        values: values
            .iter()
            .map(|(key, value)| ((*key).into(), (*value).into()))
            .collect(),
        ..Default::default()
    }
}

fn data(name: &str, columns: Vec<ColumnSchema>, records: Vec<Record>) -> TableData {
    TableData {
        description: String::new(),
        uuid: uuid::Uuid::new_v4().to_string(),
        display_name: name.into(),
        metadata: TableMetadata {
            interface_order: Vec::new(),
            initial_transposed: false,
            edit_permissions: Default::default(),
            parent_uuid: String::new(),
            data_name: name.into(),
        },
        interface_implementations: HashMap::new(),
        schema: TableSchema { columns },
        records,
    }
}

fn project() -> (tempfile::TempDir, Project) {
    let directory = tempfile::tempdir().unwrap();
    let project = Project::create_project(
        "ColumnVersions",
        directory.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    (directory, project)
}

fn install(project: &mut Project, data: TableData) -> PathBuf {
    let path = project
        .create_table(format!("{}.table.toml", data.metadata.data_name).into())
        .unwrap();
    project.load_table(&path).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data = data;
    // Deliberately include unreleased validation failures in some fixtures.
    // Export preflight, rather than the authoring save operation, is under test.
    std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    path
}

#[test]
fn full_minimal_and_metadata_project_columns_inclusively_without_mutating_sources() {
    let columns = (0..=3)
        .map(|version| column(&format!("v{version}"), version, "0"))
        .collect();
    let mut source = data(
        "values",
        columns,
        (0..=3)
            .map(|version| {
                record(
                    version,
                    &[("v0", "10"), ("v1", "11"), ("v2", "12"), ("v3", "13")],
                )
            })
            .collect(),
    );
    let before = serde_json::to_value(&source).unwrap();
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        for (target, count) in [(Some(0), 1), (Some(2), 3), (Some(3), 4), (None, 4)] {
            let exported =
                ExportTable::from_table_data_filtered(&mut source, mode, target).unwrap();
            assert_eq!(exported.columns.len(), count);
            assert_eq!(exported.records.len(), count);
            for row in &exported.records {
                assert_eq!(row.values.len(), count);
                for version in 0..count {
                    assert_eq!(
                        row.values[&format!("v{version}")],
                        (10 + version).to_string()
                    );
                }
            }
            let schema: serde_json::Value = serde_json::from_str(
                &export_table_metadata_as_json_filtered(&source, target).unwrap(),
            )
            .unwrap();
            assert_eq!(schema["columns"].as_array().unwrap().len(), count);
            assert_eq!(schema["columns"][count - 1]["min_version"], count - 1);
            assert_eq!(serde_json::to_value(&source).unwrap(), before);
        }
    }
}

#[test]
fn local_formulas_and_defaults_can_read_future_columns() {
    let mut source = data(
        "local",
        vec![
            column("base", 3, "7"),
            column("derived", 0, "=base*2"),
            column("explicit", 2, "0"),
            column("unreleased_error", 3, "=MISSING()"),
        ],
        vec![record(0, &[("explicit", "=base+1")])],
    );
    let before = serde_json::to_value(&source).unwrap();
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        let exported = ExportTable::from_table_data_filtered(&mut source, mode, Some(2)).unwrap();
        assert_eq!(exported.columns.len(), 2);
        assert_eq!(exported.records[0].values["derived"], "14");
        assert_eq!(exported.records[0].values["explicit"], "8");
        assert!(!exported.records[0].values.contains_key("base"));
        assert_eq!(serde_json::to_value(&source).unwrap(), before);
    }
}

#[test]
fn streaming_queries_keep_future_columns_but_filter_future_dependency_rows() {
    let (directory, mut project) = project();
    let mut key = column("key", 3, "");
    key.data_type = ValueType::String;
    let mut group = column("group", 3, "x");
    group.data_type = ValueType::String;
    let source_path = install(
        &mut project,
        data(
            "source",
            vec![key, group, column("amount", 3, "0")],
            vec![
                record(1, &[("key", "alpha"), ("amount", "10")]),
                record(2, &[("key", "beta"), ("amount", "20")]),
                record(3, &[("key", "alpha"), ("amount", "100")]),
            ],
        ),
    );
    let mut lookup = column(
        "lookup",
        0,
        "=LOOKUP(\"source\",\"key\",\"alpha\",\"amount\")",
    );
    lookup.input_validation = Some(InputValidationSettings {
        enabled: true,
        mode: ValidationMode::Reject,
        message: String::new(),
        hint: String::new(),
        rules: vec![InputRule::NumberRange {
            min: Some("0".into()),
            max: Some("20".into()),
        }],
    });
    let mut unreleased_error = column("unreleased_error", 3, "=MISSING()");
    unreleased_error.required = Some(true);
    unreleased_error.input_validation = lookup.input_validation.clone();
    let target_path = install(
        &mut project,
        data(
            "target",
            vec![
                lookup,
                column("count", 1, "=COUNTIF(\"source\",\"group\",\"x\")"),
                column("sum", 2, "=SUMIF(\"source\",\"group\",\"x\",\"amount\")"),
                column("hidden_local", 3, "4"),
                column("local", 2, "=hidden_local+sum"),
                unreleased_error,
            ],
            vec![record(0, &[])],
        ),
    );
    project.tables_data.remove(&source_path);
    project.tables_data.get_mut(&target_path).unwrap().is_dirty = true;
    let before = serde_json::to_value(&project.tables_data[&target_path].data).unwrap();
    let source_bytes = std::fs::read(&source_path).unwrap();
    let target_bytes = std::fs::read(&target_path).unwrap();
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        project.tables_data.remove(&source_path);
        let destination = directory.path().join("runtime.json");
        let summary = export_runtime_bundle_to_file_with_validation(
            &mut project,
            mode,
            Some(2),
            false,
            &destination,
        )
        .unwrap();
        assert!(!project.tables_data.contains_key(&source_path));
        assert_eq!(summary.table_count, 2);
        assert_eq!(summary.record_count, 3);
        let streamed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&destination).unwrap()).unwrap();
        let tables = streamed["tables"].as_array().unwrap();
        let target = tables
            .iter()
            .find(|table| table["name"] == "target")
            .unwrap();
        assert_eq!(target["columns"].as_array().unwrap().len(), 4);
        assert_eq!(
            target["records"][0]["values"],
            serde_json::json!({
                "lookup": "10", "count": "2", "sum": "30", "local": "34"
            })
        );
        let source = tables
            .iter()
            .find(|table| table["name"] == "source")
            .unwrap();
        assert!(source["columns"].as_array().unwrap().is_empty());
        assert!(source["records"]
            .as_array()
            .unwrap()
            .iter()
            .all(|record| { record["values"].as_object().unwrap().is_empty() }));
        let bundle =
            export_runtime_bundle_with_validation(&mut project, mode, Some(2), false).unwrap();
        assert_eq!(bundle.manifest.content_hash, summary.manifest.content_hash);
        assert_eq!(
            serde_json::to_value(bundle.tables).unwrap(),
            streamed["tables"]
        );
        assert_eq!(
            serde_json::to_value(&project.tables_data[&target_path].data).unwrap(),
            before
        );
        assert!(project.tables_data[&target_path].is_dirty);
        assert_eq!(std::fs::read(&source_path).unwrap(), source_bytes);
        assert_eq!(std::fs::read(&target_path).unwrap(), target_bytes);
        let metadata: serde_json::Value = serde_json::from_str(
            &export_project_metadata_as_json_filtered(&mut project, Some(2)).unwrap(),
        )
        .unwrap();
        let target = metadata["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|table| table["data_name"] == "target")
            .unwrap();
        assert_eq!(target["columns"].as_array().unwrap().len(), 4);
    }
}

#[test]
fn visible_formula_dependency_errors_still_abort_atomic_exports_even_when_invalid_is_allowed() {
    let (directory, mut project) = project();
    let path = install(
        &mut project,
        data(
            "broken",
            vec![
                column("future", 3, "=MISSING()"),
                column("visible", 0, "=future+1"),
            ],
            vec![record(0, &[])],
        ),
    );
    let before = serde_json::to_value(&project.tables_data[&path].data).unwrap();
    let destination = directory.path().join("runtime.json");
    std::fs::write(&destination, "previous successful release").unwrap();
    for allow_invalid in [false, true] {
        let error = export_runtime_bundle_to_file_with_validation(
            &mut project,
            ExportMode::Full,
            Some(2),
            allow_invalid,
            &destination,
        )
        .expect_err("a visible formula dependency must still fail");
        assert!(format!("{error:?}").contains("visible"), "{error:?}");
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            "previous successful release"
        );
        assert_eq!(
            serde_json::to_value(&project.tables_data[&path].data).unwrap(),
            before
        );
    }
}

#[test]
fn projected_duplicate_names_keep_their_complete_schema_export_keys() {
    let mut current = column("value", 2, "10");
    current.interface_origin = Some(uuid::Uuid::new_v4().to_string());
    current.interface_origin_name_fallback = Some("Current".into());
    let mut future = column("value", 3, "20");
    future.interface_origin = Some(uuid::Uuid::new_v4().to_string());
    future.interface_origin_name_fallback = Some("Future".into());
    let mut source = data("keys", vec![current, future], vec![record(0, &[])]);
    let projected =
        ExportTable::from_table_data_filtered(&mut source, ExportMode::Full, Some(2)).unwrap();
    let complete = ExportTable::from_table_data(&mut source, ExportMode::Full).unwrap();
    assert_eq!(projected.columns[0].name, "Current_value");
    assert_eq!(projected.columns[0].name, complete.columns[0].name);
    assert_eq!(projected.records[0].values["Current_value"], "10");
    assert!(!projected.records[0].values.contains_key("Future_value"));
}

#[test]
fn interface_constraints_apply_only_to_the_release_columns() {
    let (_directory, mut project) = project();
    let mut interface = devcel_core::Interface::new("Versioned".into(), None);
    let current = column("current", 0, "10");
    let mut future = column("future", 3, "");
    future.required = Some(true);
    interface.columns = vec![current, future];
    project
        .interface_registry
        .add_interface(interface.clone())
        .unwrap();
    let path = install(&mut project, data("implements", Vec::new(), Vec::new()));
    let table = project.tables_data.get_mut(&path).unwrap();
    table
        .apply_interface(&interface, &project.interface_registry, true)
        .unwrap();
    table.data.records.push(record(0, &[]));
    let before = serde_json::to_value(&table.data).unwrap();

    let bundle =
        export_runtime_bundle_with_validation(&mut project, ExportMode::Full, Some(2), false)
            .unwrap();
    assert_eq!(bundle.tables[0].columns.len(), 1);
    assert_eq!(bundle.tables[0].records[0].values["current"], "10");
    assert!(
        export_runtime_bundle_with_validation(&mut project, ExportMode::Full, Some(3), false,)
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(&project.tables_data[&path].data).unwrap(),
        before
    );
}

#[test]
fn table_metadata_serialization_has_only_supported_fields() {
    let mut source = data(
        "metadata_contract",
        vec![column("amount", 0, "7")],
        vec![record(0, &[("amount", "42")])],
    );
    let stored = serde_json::to_value(&source.metadata).unwrap();
    let expected = serde_json::json!({
        "data_name": "metadata_contract",
        "interface_order": [],
        "initial_transposed": false,
        "edit_permissions": {
            "add_columns": true, "delete_columns": true,
            "add_rows": true, "delete_rows": true, "edit_cells": true
        }
    });
    assert_eq!(stored, expected);
    let serialized = toml::to_string(&source.metadata).unwrap();
    let round_trip: TableMetadata = toml::from_str(&serialized).unwrap();
    assert_eq!(serde_json::to_value(round_trip).unwrap(), expected);

    let exported: serde_json::Value =
        serde_json::from_str(&export_table_metadata_as_json_filtered(&source, None).unwrap())
            .unwrap();
    let mut keys: Vec<_> = exported
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "columns",
            "data_name",
            "description",
            "display_name",
            "uuid"
        ]
    );
    assert_eq!(exported["uuid"], source.uuid);
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        let runtime = ExportTable::from_table_data_filtered(&mut source, mode, None).unwrap();
        assert_eq!(runtime.records.len(), 1);
        assert_eq!(runtime.records[0].values["amount"], "42");
    }
}
