use devcel_core::{json_export::*, tag_filter::TagFilter, *};
use std::{fs, path::PathBuf};
type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;
fn column(name: &str, tags: &[&str]) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: ValueType::I32,
        tags: tags.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}
fn project(root: &std::path::Path) -> std::result::Result<Project, Box<dyn std::error::Error>> {
    Ok(Project::create_project(
        "Tags",
        root.to_str().unwrap(),
        "",
        "#123456",
    )?)
}
#[test]
fn exact_or_exclusion_version_semantics() {
    let mut f = TagFilter::default();
    let mut row = Record::new();
    row.tags = vec!["Client".into(), "Common".into()];
    assert!(f.includes_row(&row, None));
    f.row_include_tags = vec!["Client".into(), "Other".into()];
    assert!(f.includes_row(&row, None));
    f.row_exclude_tags = vec!["Common".into()];
    assert!(!f.includes_row(&row, None));
    f.row_exclude_tags.clear();
    f.row_include_tags = vec!["client".into()];
    assert!(!f.includes_row(&row, None));
    f.row_include_tags = vec!["Client".into()];
    row.min_version = 2;
    assert!(!f.includes_row(&row, Some(1)));
    f.row_include_tags = vec!["Orphan".into()];
    assert!(!f.includes_row(&row, None));
}
#[test]
fn output_only_projection_preserves_inheritance_formulas_and_empty_tables() -> TestResult {
    let root = tempfile::tempdir()?;
    let mut p = project(root.path())?;
    let path = p.create_table(PathBuf::from("items.table.toml"))?;
    p.load_table(&path)?;
    let empty = p.create_table(PathBuf::from("empty.table.toml"))?;
    p.load_table(&empty)?;
    let input = column("input", &["Hidden"]);
    let output = column("output", &["Client"]);
    let late = ColumnSchema {
        min_version: 2,
        ..column("late", &["Client"])
    };
    let mut parent = Record::new();
    parent.tags = vec!["Hidden".into()];
    parent.set_cell_value(&input, "21".into());
    parent.set_cell_value(&output, "=input*2".into());
    let mut child = Record::new();
    child.tags = vec!["Client".into()];
    child.parent_uuid = parent.uuid.clone();
    let child_id = child.uuid.clone();
    p.tables_data.get_mut(&path).unwrap().data.schema.columns = vec![input, output, late];
    p.tables_data.get_mut(&path).unwrap().data.records = vec![parent, child];
    let before = serde_json::to_value(&p.tables_data[&path].data)?;
    let f = TagFilter {
        row_include_tags: vec!["Client".into()],
        column_include_tags: vec!["Client".into()],
        ..Default::default()
    };
    let bundle = export_runtime_bundle_with_filters(&mut p, ExportMode::Full, Some(1), false, &f)?;
    let table = bundle.tables.iter().find(|t| t.records.len() == 1).unwrap();
    assert_eq!(table.records[0].id, child_id);
    assert_eq!(table.columns.len(), 1);
    assert_eq!(table.records[0].values["output"], "42");
    assert_eq!(bundle.tables.len(), 2);
    assert_eq!(before, serde_json::to_value(&p.tables_data[&path].data)?);
    let dest = root.path().join("runtime.json");
    export_runtime_bundle_to_file_with_filters(
        &mut p,
        ExportMode::Full,
        Some(1),
        false,
        &f,
        &dest,
    )?;
    let streamed: RuntimeBundle = serde_json::from_slice(&fs::read(dest)?)?;
    assert_eq!(bundle.manifest.content_hash, streamed.manifest.content_hash);
    Ok(())
}
#[test]
fn evaluated_reference_to_excluded_row_fails_atomically() -> TestResult {
    let root = tempfile::tempdir()?;
    let mut p = project(root.path())?;
    let path = p.create_table(PathBuf::from("items.table.toml"))?;
    p.load_table(&path)?;
    let id = p.tables_data[&path].data.uuid.clone();
    let mut target = Record::new();
    target.tags = vec!["Hidden".into()];
    let reference = ColumnSchema {
        data_type: ValueType::Reference,
        reference_config: Some(ReferenceConfig {
            target_table_uuid: id,
            display_column_uuid: None,
        }),
        ..column("link", &[])
    };
    let mut row = Record::new();
    row.tags = vec!["Client".into()];
    row.set_cell_value(&reference, format!("=\"{}\"", target.uuid));
    p.tables_data.get_mut(&path).unwrap().data.schema.columns = vec![reference];
    p.tables_data.get_mut(&path).unwrap().data.records = vec![target, row];
    let dest = root.path().join("runtime.json");
    fs::write(&dest, b"last good")?;
    let f = TagFilter {
        row_include_tags: vec!["Client".into()],
        ..Default::default()
    };
    let err = export_runtime_bundle_to_file_with_filters(
        &mut p,
        ExportMode::Full,
        None,
        false,
        &f,
        &dest,
    )
    .unwrap_err();
    assert_eq!(
        serde_json::to_value(AppError::from(err).into_diagnostic())?["code"],
        "error.export.referenceUnavailable"
    );
    assert_eq!(fs::read(dest)?, b"last good");
    Project::save_table(p.tables_data.get_mut(&path).unwrap())?;
    let output = tempfile::tempdir()?;
    let config = output.path().join("import.json");
    let runtime = output.path().join("runtime.json");
    let code = output.path().join("generated.cs");
    let mut settings = serde_json::json!({"schema_version":1,"sources":[{"id":"test","namespace":"Game","project":p.get_project_path(),"runtime_out":runtime,"code_out":code,"code_target":"csharp"}]});
    fs::write(&config, serde_json::to_vec(&settings)?)?;
    let report = importer_pull::run(&config, None, false)?;
    assert!(report.success, "{}", serde_json::to_string(&report)?);
    let good_runtime = fs::read(&runtime)?;
    let good_code = fs::read(&code)?;
    settings["sources"][0]["row_include_tags"] = serde_json::json!(["Client"]);
    fs::write(&config, serde_json::to_vec(&settings)?)?;
    assert!(!importer_pull::run(&config, None, false)?.success);
    assert_eq!(fs::read(&runtime)?, good_runtime);
    assert_eq!(fs::read(&code)?, good_code);
    Ok(())
}
#[test]
fn projected_interfaces_drop_claims_and_reject_table_refs() -> TestResult {
    let root = tempfile::tempdir()?;
    let mut p = project(root.path())?;
    let path = p.create_table(PathBuf::from("items.table.toml"))?;
    p.load_table(&path)?;
    let mut interface = Interface::new("Contract".into(), None);
    interface.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: column("required", &["Hidden"]),
        }],
        None,
        None,
    )?;
    p.interface_registry.add_interface(interface.clone())?;
    p.tables_data.get_mut(&path).unwrap().apply_interface(
        &interface,
        &p.interface_registry,
        true,
    )?;
    let f = TagFilter {
        column_exclude_tags: vec!["Hidden".into()],
        ..Default::default()
    };
    let bundle = export_runtime_bundle_with_filters(&mut p, ExportMode::Full, None, false, &f)?;
    assert!(bundle.tables[0].interfaces.is_empty());
    assert!(bundle.tables[0].columns.is_empty());
    let id = p.tables_data[&path].data.uuid.clone();
    let reference = ColumnSchema {
        data_type: ValueType::TableRef,
        table_ref_config: Some(TableRefConfig {
            interface_uuid: interface.uuid.to_string(),
        }),
        ..column("table", &["Client"])
    };
    let mut row = Record::new();
    row.set_cell_value(&reference, id);
    let t = p.tables_data.get_mut(&path).unwrap();
    t.data.schema.columns.push(reference);
    t.data.records.push(row);
    let error = export_runtime_bundle_with_filters(&mut p, ExportMode::Full, None, false, &f)
        .err()
        .unwrap();
    assert_eq!(
        serde_json::to_value(AppError::from(error).into_diagnostic())?["code"],
        "error.export.referenceUnavailable"
    );
    Ok(())
}
#[test]
fn independent_sources_fingerprints_and_orphan_repair() -> TestResult {
    let root = tempfile::tempdir()?;
    let out = tempfile::tempdir()?;
    let mut p = project(root.path())?;
    let path = p.create_table(PathBuf::from("items.table.toml"))?;
    p.load_table(&path)?;
    let c = column("value", &[]);
    let mut a = Record::new();
    a.tags = vec!["A".into()];
    a.set_cell_value(&c, "1".into());
    let mut b = Record::new();
    b.tags = vec!["B".into()];
    b.set_cell_value(&c, "2".into());
    let t = p.tables_data.get_mut(&path).unwrap();
    t.data.schema.columns = vec![c];
    t.data.records = vec![a, b];
    Project::save_table(t)?;
    let config_path = out.path().join("import.json");
    let sources:Vec<_>=["A","B"].into_iter().map(|id|serde_json::json!({"id":id,"namespace":id,"project":p.get_project_path(),"runtime_out":out.path().join(format!("{id}.json")),"row_include_tags":[id]})).collect();
    fs::write(
        &config_path,
        serde_json::to_vec(&serde_json::json!({"schema_version":1,"sources":sources}))?,
    )?;
    let report = importer_pull::run(&config_path, None, false)?;
    assert!(report.success, "{}", serde_json::to_string(&report)?);
    for (id, value) in [("A", "1"), ("B", "2")] {
        let bundle: RuntimeBundle =
            serde_json::from_slice(&fs::read(out.path().join(format!("{id}.json")))?)?;
        assert_eq!(bundle.tables[0].records.len(), 1);
        assert_eq!(bundle.tables[0].records[0].values["value"], value);
    }
    let mut config: importer_pull::PullConfig = serde_json::from_slice(&fs::read(&config_path)?)?;
    importer_pull::save_config(&config_path, &config)?; // Existing VCS orphans stay intact.
    config.sources[0].row_include_tags = vec!["Corrected".into()];
    importer_pull::save_config(&config_path, &config)?;
    let status = importer_pull::run(&config_path, None, true)?;
    assert_eq!(status.sources[0].status, "needs_pull");
    assert_eq!(status.sources[1].status, "ready");
    config.sources[0].row_include_tags.push("NewUnknown".into());
    assert!(importer_pull::save_config(&config_path, &config).is_err());
    let mut metadata: toml::Value = toml::from_str(&fs::read_to_string(p.get_project_path())?)?;
    metadata["tag_presets"] = toml::Value::Array(vec![toml::Value::String("Added".into())]);
    fs::write(p.get_project_path(), toml::to_string(&metadata)?)?;
    let status = importer_pull::run(&config_path, None, true)?;
    assert!(status.sources.iter().all(|s| s.status == "needs_pull"));
    Ok(())
}
#[test]
fn table_formulas_read_tag_excluded_rows_but_keep_version_semantics() -> TestResult {
    let root = tempfile::tempdir()?;
    let mut p = project(root.path())?;
    let input_path = p.create_table(PathBuf::from("Input.table.toml"))?;
    p.load_table(&input_path)?;
    let output_path = p.create_table(PathBuf::from("Output.table.toml"))?;
    p.load_table(&output_path)?;
    let c = column("value", &["Hidden"]);
    let mut a = Record::new();
    a.tags = vec!["Hidden".into()];
    a.set_cell_value(&c, "3".into());
    let mut b = Record::new();
    b.min_version = 2;
    b.tags = vec!["Hidden".into()];
    b.set_cell_value(&c, "7".into());
    let t = p.tables_data.get_mut(&input_path).unwrap();
    t.data.metadata.data_name = "Input".into();
    t.data.display_name = "Input".into();
    t.data.schema.columns = vec![c];
    t.data.records = vec![a, b];
    let c = column("total", &["Client"]);
    let mut row = Record::new();
    row.tags = vec!["Client".into()];
    row.set_cell_value(&c, "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)".into());
    let t = p.tables_data.get_mut(&output_path).unwrap();
    t.data.metadata.data_name = "Output".into();
    t.data.schema.columns = vec![c];
    t.data.records = vec![row];
    let f = TagFilter {
        row_include_tags: vec!["Client".into()],
        column_include_tags: vec!["Client".into()],
        ..Default::default()
    };
    for (version, total) in [(Some(1), "3"), (Some(2), "10")] {
        let bundle =
            export_runtime_bundle_with_filters(&mut p, ExportMode::Full, version, false, &f)?;
        let output = bundle.tables.iter().find(|t| t.name == "Output").unwrap();
        assert_eq!(output.records[0].values["total"], total);
        let input = bundle.tables.iter().find(|t| t.name == "Input").unwrap();
        assert!(input.columns.is_empty());
        assert!(input.records.is_empty());
    }
    Ok(())
}
