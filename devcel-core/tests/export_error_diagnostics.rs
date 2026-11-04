//! The export wire carries semantics and exact authored identifiers, never English error wrappers.
use devcel_core::{
    codegen::{self, CodegenTarget},
    export_validation,
    json_export::{self, ExportMode, ExportTable},
    tag_filter::{self, TagFilter},
    AppError, ColumnSchema, DevcelError, Interface, InterfaceImplementation, Project, Record,
    ReferenceConfig, ValueType,
};
use serde_json::{json, Value};

fn diagnostic(error: DevcelError) -> Value {
    serde_json::to_value(AppError::from(error).into_diagnostic()).unwrap()
}
fn project() -> (tempfile::TempDir, Project, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "ExportDiagnostics",
        directory.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let path = project.create_table("items.table.toml".into()).unwrap();
    (directory, project, path)
}
fn column(name: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: ValueType::String,
        ..Default::default()
    }
}

#[test]
fn codegen_identifiers_have_semantic_codes_and_preserve_names() {
    assert_eq!(
        diagnostic(codegen::validate_class_name("bad-name").unwrap_err())["code"],
        "error.codegen.classIdentifier"
    );
    assert_eq!(
        diagnostic(codegen::validate_namespace("bad namespace").unwrap_err())["code"],
        "error.codegen.namespaceIdentifier"
    );
    let (_directory, mut project, _) = project();
    let error = codegen::generate_code_with_class_name(
        &mut project,
        CodegenTarget::Cpp,
        None,
        Some("DevcelColor32"),
    )
    .unwrap_err();
    let value = diagnostic(error);
    assert_eq!(value["code"], "error.codegen.nameConflict");
    assert_eq!(value["params"]["name"], "DevcelColor32");
    assert_eq!(value["params"]["scope"], "class_name");
}

#[test]
fn missing_interface_and_base_interface_ids_stay_typed() {
    let (_directory, mut project, path) = project();
    let missing = uuid::Uuid::new_v4();
    let table = &mut project.tables_data.get_mut(&path).unwrap().data;
    table.interface_implementations.insert(
        missing,
        InterfaceImplementation {
            interface_uuid: missing,
            synced_version_id: uuid::Uuid::new_v4(),
            last_sync_date: chrono::Utc::now(),
            effective_fingerprint: None,
            required_column_uuids: None,
        },
    );
    let value = diagnostic(
        tag_filter::projected_interface_ids(
            &project,
            &project.tables_data[&path].data,
            Some(0),
            &TagFilter::default(),
        )
        .unwrap_err(),
    );
    assert_eq!(value["code"], "error.interface.missingId");
    assert_eq!(value["params"]["id"], missing.to_string());
    let mut interface = Interface::new("契約 {error.parse}".into(), None);
    interface.extends.push(missing);
    let value = diagnostic(
        interface
            .get_effective_columns(&project.interface_registry)
            .unwrap_err(),
    );
    assert_eq!(value["code"], "error.interface.missingId");
    assert_eq!(value["params"]["id"], missing.to_string());
}

#[test]
fn formula_cause_remains_nested_and_unreleased_formula_is_not_evaluated() {
    let (_directory, mut project, path) = project();
    let column = ColumnSchema {
        data_type: ValueType::I64,
        default_value: "=1/0".into(),
        min_version: 2,
        ..column("amount")
    };
    let table = &mut project.tables_data.get_mut(&path).unwrap().data;
    table.schema.columns = vec![column.clone()];
    table.records = vec![Record::new()];
    table.metadata.data_name = "error.parse {user text} 日本語".into();
    let before = serde_json::to_value(&*table).unwrap();
    assert!(ExportTable::from_table_data_filtered(table, ExportMode::Full, Some(1)).is_ok());
    let error = ExportTable::from_table_data_filtered(table, ExportMode::Full, Some(2))
        .err()
        .unwrap();
    let value = diagnostic(error);
    assert_eq!(value["code"], "error.export.formula");
    assert_eq!(value["params"]["table"], "error.parse {user text} 日本語");
    assert_eq!(value["params"]["columnId"], column.uuid);
    assert_eq!(value["params"]["error"]["kind"], "code");
    assert_eq!(
        value["params"]["error"]["code"],
        "error.formula.divisionByZero"
    );
    assert_eq!(serde_json::to_value(&*table).unwrap(), before);
    let wire = serde_json::to_string(&value).unwrap();
    let decoded: Value = serde_json::from_str(&wire).unwrap();
    assert_eq!(value, decoded);
}

#[test]
fn version_projection_reference_error_preserves_output_and_all_identities() {
    let (directory, mut project, path) = project();
    let mut target = Record::new();
    target.min_version = 2;
    let mut row = Record::new();
    let reference = ColumnSchema {
        data_type: ValueType::Reference,
        reference_config: Some(ReferenceConfig {
            target_table_uuid: project.tables_data[&path].data.uuid.clone(),
            display_column_uuid: None,
        }),
        ..column("link")
    };
    row.set_cell_value(&reference, target.uuid.clone());
    let table = &mut project.tables_data.get_mut(&path).unwrap().data;
    table.schema.columns = vec![reference];
    table.records = vec![target.clone(), row.clone()];
    let before = serde_json::to_value(&*table).unwrap();
    let destination = directory.path().join("runtime_日本語.json");
    std::fs::write(&destination, b"last good output").unwrap();
    let error = json_export::export_runtime_bundle_to_file_with_validation(
        &mut project,
        ExportMode::Full,
        Some(1),
        true,
        &destination,
    )
    .err()
    .unwrap();
    let value = diagnostic(error);
    assert_eq!(value["code"], "error.export.referenceUnavailable");
    assert_eq!(value["params"]["target"], target.uuid);
    assert_eq!(value["params"]["row"], row.uuid);
    assert_eq!(value["params"]["column"], "link");
    assert_eq!(std::fs::read(destination).unwrap(), b"last good output");
    assert_eq!(
        serde_json::to_value(&project.tables_data[&path].data).unwrap(),
        before
    );
}

#[test]
fn source_destination_guard_has_exact_path_and_does_not_replace_source() {
    let (_directory, mut project, path) = project();
    let before = std::fs::read(&path).unwrap();
    let error = json_export::export_runtime_bundle_to_file_with_validation(
        &mut project,
        ExportMode::Full,
        None,
        false,
        &path,
    )
    .err()
    .unwrap();
    let value = diagnostic(error);
    assert_eq!(value["code"], "error.export.sourceDestination");
    assert_eq!(value["params"]["path"], path.to_string_lossy().as_ref());
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn dangling_destination_symlink_is_rejected_with_a_semantic_path() {
    let (directory, mut project, _) = project();
    let destination = directory.path().join("unresolved 日本語.json");
    std::os::unix::fs::symlink(directory.path().join("absent"), &destination).unwrap();
    let value = diagnostic(
        json_export::export_runtime_bundle_to_file_with_validation(
            &mut project,
            ExportMode::Full,
            None,
            false,
            &destination,
        )
        .err()
        .unwrap(),
    );
    assert_eq!(value["code"], "error.export.danglingSymlink");
    assert_eq!(
        value["params"]["path"],
        destination.to_string_lossy().as_ref()
    );
    assert!(std::fs::symlink_metadata(destination)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn constraint_summary_is_localizable_and_user_message_remains_literal() {
    let (_directory, mut project, path) = project();
    let custom = "error.parse: User message {value} 日本語";
    let column = ColumnSchema {
        input_validation: Some(devcel_core::cell_rules::InputValidationSettings {
            enabled: true,
            mode: devcel_core::cell_rules::ValidationMode::Reject,
            message: custom.into(),
            hint: "".into(),
            rules: vec![devcel_core::cell_rules::InputRule::Required],
        }),
        ..column("value")
    };
    let table = &mut project.tables_data.get_mut(&path).unwrap().data;
    table.schema.columns = vec![column];
    table.records = vec![Record::new()];
    let value = serde_json::to_value(AppError::from(
        export_validation::require_clean_table(table, false).unwrap_err(),
    ))
    .unwrap();
    assert_eq!(value["diagnostics"][0]["code"], "error.export.constraints");
    assert_eq!(value["diagnostics"][0]["params"]["count"], 1);
    assert_eq!(
        value["diagnostics"][2],
        json!({"kind":"text", "text":custom})
    );
}

#[test]
fn inherited_input_failure_is_a_code_not_an_english_text_wrapper() {
    let (_directory, mut project, path) = project();
    let column = column("inherited");
    let mut row = Record::new();
    row.parent_uuid = "error.parse 日本語 {parent}".into();
    let table = &mut project.tables_data.get_mut(&path).unwrap().data;
    table.schema.columns = vec![column.clone()];
    table.records = vec![row.clone()];
    let value = diagnostic(
        table
            .effective_cell_input(&table.records[0], &column)
            .unwrap_err(),
    );
    assert_eq!(value["code"], "error.record.parentMissing");
    assert_eq!(value["params"]["parent"], row.parent_uuid);
}

#[test]
fn interface_load_wraps_the_typed_parser_cause_and_exact_path() {
    let (_directory, mut project, _) = project();
    let path = project
        .path
        .parent()
        .unwrap()
        .join("Tables")
        .join("error.parse_日本語.interface.toml");
    let contents = "name = [unterminated 日本語";
    std::fs::write(&path, contents).unwrap();
    let value = diagnostic(project.load_interfaces().unwrap_err());
    assert_eq!(value["code"], "error.interface.load");
    assert_eq!(value["params"]["path"], path.to_string_lossy().as_ref());
    assert_eq!(value["params"]["error"]["kind"], "code");
    assert_eq!(value["params"]["error"]["code"], "error.parse");
    assert!(value["params"]["error"]["params"]["details"]
        .as_str()
        .unwrap()
        .contains(contents));
    assert_eq!(std::fs::read_to_string(path).unwrap(), contents);
}

#[test]
fn typed_formula_causes_retain_authored_text_and_evaluation_context() {
    let original = json!({"kind":"code", "code":"error.interface.missingId", "params":{"id":"error.parse {id} 日本語"}});
    let diagnostic: devcel_core::Diagnostic = serde_json::from_value(original.clone()).unwrap();
    let error = devcel_core::FormulaError::EvaluationContext {
        context: "table path / row-id / source bytes 2..7".into(),
        source: Box::new(devcel_core::FormulaError::Structured(Box::new(diagnostic))),
    };
    let value = serde_json::to_value(error.diagnostic()).unwrap();
    assert_eq!(value["code"], "grid.errorWithCause");
    assert_eq!(value["params"]["summary"], original);
    assert_eq!(
        value["params"]["error"],
        json!({"kind":"text", "text":"table path / row-id / source bytes 2..7"})
    );
    let literal = devcel_core::FormulaError::Structured(Box::new(devcel_core::Diagnostic::Text {
        text: "error.interface.missingId".into(),
    }));
    assert_eq!(
        serde_json::to_value(literal.diagnostic()).unwrap(),
        json!({"kind":"text", "text":"error.interface.missingId"})
    );
}

#[test]
fn invalid_interface_identifier_keeps_parser_details_beneath_localized_summary() {
    let (_directory, mut project, _) = project();
    let id = "error.parse {id} 日本語";
    let value = diagnostic(project.redo_interface_command(id).unwrap_err());
    assert_eq!(value["code"], "error.interface.invalidId");
    assert_eq!(value["params"]["id"], id);
    assert_eq!(
        value["params"]["details"],
        uuid::Uuid::parse_str(id).unwrap_err().to_string()
    );
}

#[test]
fn unloaded_export_target_preserves_nested_parser_error_and_source_bytes() {
    let (_directory, mut project, path) = project();
    project.tables_data.remove(&path);
    let contents = "description = [broken 日本語";
    std::fs::write(&path, contents).unwrap();
    let error = json_export::export_project_metadata_as_json(&mut project).unwrap_err();
    let value = diagnostic(error);
    assert_eq!(value["code"], "error.export.readTarget");
    assert_eq!(value["params"]["error"]["kind"], "code");
    assert_eq!(value["params"]["error"]["code"], "error.parse");
    assert!(value["params"]["error"]["params"]["details"]
        .as_str()
        .unwrap()
        .contains(contents));
    assert_eq!(std::fs::read_to_string(path).unwrap(), contents);
    assert!(project.tables_data.is_empty());
}

#[test]
fn interface_identity_guard_is_localized_without_mutating_either_definition() {
    let (_directory, project, _) = project();
    let expected = Interface::new("Original".into(), None);
    let candidate = Interface::new("Replacement".into(), None);
    let before = serde_json::to_value((&expected, &candidate)).unwrap();
    let value = diagnostic(
        project
            .save_interface_if_unchanged(&candidate, &expected)
            .unwrap_err(),
    );
    assert_eq!(value["code"], "error.interface.identityImmutable");
    assert_eq!(value["params"]["expected"], expected.uuid.to_string());
    assert_eq!(value["params"]["actual"], candidate.uuid.to_string());
    assert_eq!(
        serde_json::to_value((&expected, &candidate)).unwrap(),
        before
    );
}
