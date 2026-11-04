//! End-to-end column-version projection through real projects and saved-source imports.
//! Native compiler checks: python3 devcel-core/tests/compile_column_version_codegen.py
use devcel_core::{codegen::*, *};
use std::{fs, path::PathBuf};
type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;
fn col(name: &str, ty: ValueType, version: u32) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: ty,
        min_version: version,
        ..Default::default()
    }
}
fn snapshot(p: &Project) -> serde_json::Value {
    let mut tables: Vec<_> = p.tables_data.iter().collect();
    tables.sort_by_key(|(path, _)| *path);
    serde_json::Value::Array(
        tables
            .into_iter()
            .map(|(path, t)| serde_json::json!([path, t.is_dirty, t.data]))
            .collect(),
    )
}
#[test]
fn versioned_codegen_preserves_projected_contract() -> TestResult {
    let generated = tempfile::tempdir()?;
    let out = std::env::var_os("DEVCEL_CODEGEN_FIXTURE_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| generated.path().to_path_buf());
    fs::create_dir_all(&out)?;
    let temp = tempfile::tempdir()?;
    let mut p = Project::create_project(
        "Versions",
        temp.path().to_str().unwrap(),
        "fixture",
        "#123456",
    )?;
    let hp = p.create_table(PathBuf::from("heroes.table.toml"))?;
    p.load_table(&hp)?;
    let ip = p.create_table(PathBuf::from("items.table.toml"))?;
    p.load_table(&ip)?;
    let cp = p.create_table(PathBuf::from("collisions.table.toml"))?;
    p.load_table(&cp)?;
    let mut base = Interface::new("Base".into(), None);
    base.create_new_version(
        vec![
            InterfaceChange::AddColumn {
                column: col("name", ValueType::String, 0),
            },
            InterfaceChange::AddColumn {
                column: col("ancestor_future", ValueType::I32, 3),
            },
        ],
        None,
        None,
    )?;
    let mut child = Interface::new("Child".into(), None);
    child.create_new_version(
        vec![
            InterfaceChange::ModifyExtends {
                new_extends: vec![base.uuid],
            },
            InterfaceChange::AddColumn {
                column: col("child_future", ValueType::I32, 2),
            },
        ],
        None,
        None,
    )?;
    p.interface_registry.add_interface(base.clone())?;
    p.interface_registry.add_interface(child.clone())?;
    let target = p.tables_data[&ip].data.uuid.clone();
    {
        let t = p.tables_data.get_mut(&hp).unwrap();
        t.data.metadata.data_name = "heroes".into();
        t.apply_interface(&child, &p.interface_registry, true)?;
        let mut reference = col("weapon", ValueType::Reference, 0);
        reference.reference_config = Some(ReferenceConfig {
            target_table_uuid: target,
            display_column_uuid: None,
        });
        let mut curve = col("future_curve", ValueType::Curve, 2);
        curve.curve_config = Some(CurveConfig::default());
        let mut input = col("hidden_input", ValueType::I32, 2);
        input.default_value = "21".into();
        let mut computed = col("computed", ValueType::I32, 0);
        computed.default_value = "=hidden_input*2".into();
        t.data.schema.columns.extend([
            reference,
            curve,
            input,
            computed,
            col("max_future", ValueType::String, u32::MAX),
        ]);
        t.data.records.push(Record::new());
    }
    {
        let t = p.tables_data.get_mut(&ip).unwrap();
        t.data.metadata.data_name = "items".into();
        t.data.schema.columns = vec![col("power", ValueType::I32, 9)];
        t.data.records.push(Record::new());
    }
    for (name, min_version) in [("Early", 0), ("Late", 2)] {
        let mut interface = Interface::new(name.into(), None);
        interface.create_new_version(
            vec![InterfaceChange::AddColumn {
                column: col("shared", ValueType::String, min_version),
            }],
            None,
            None,
        )?;
        p.interface_registry.add_interface(interface.clone())?;
        let t = p.tables_data.get_mut(&cp).unwrap();
        t.data.metadata.data_name = "collisions".into();
        t.apply_interface(&interface, &p.interface_registry, true)?;
    }
    let before = snapshot(&p);
    for version in [0, 1, 2, 3, u32::MAX] {
        let model = build_model_for_version(&mut p, Some(version))?;
        let heroes = model
            .tables
            .iter()
            .find(|t| t.data_name == "heroes")
            .unwrap();
        assert!(heroes.columns.iter().any(|c| c.key == "name"));
        assert_eq!(
            heroes.columns.iter().any(|c| c.key == "child_future"),
            version >= 2
        );
        assert_eq!(
            heroes.columns.iter().any(|c| c.key == "ancestor_future"),
            version >= 3
        );
        assert_eq!(
            heroes.columns.iter().any(|c| c.key == "max_future"),
            version == u32::MAX
        );
        assert_eq!(heroes.implements, vec!["Base", "Child"]);
        let inherited = model
            .interfaces
            .iter()
            .find(|i| i.type_name == "Child")
            .unwrap();
        assert_eq!(
            inherited.members.len(),
            1 + usize::from(version >= 2) + usize::from(version >= 3)
        );
        let target = model
            .tables
            .iter()
            .find(|t| t.data_name == "items")
            .unwrap();
        assert_eq!(target.columns.len(), usize::from(version >= 9));
        assert_eq!(
            heroes
                .columns
                .iter()
                .find(|c| c.key == "weapon")
                .unwrap()
                .reference_target
                .as_deref(),
            Some("Items")
        );
        let collision = model
            .tables
            .iter()
            .find(|t| t.data_name == "collisions")
            .unwrap();
        assert_eq!(collision.columns[0].key, "Early_shared");
        assert_eq!(collision.columns[0].accessor, "EarlyShared");
        for (target, ext) in [
            (CodegenTarget::CSharp, "cs"),
            (CodegenTarget::Cpp, "h"),
            (CodegenTarget::TypeScript, "ts"),
        ] {
            let code = generate_code_with_class_name_for_version(
                &mut p,
                target,
                Some("VersionCheck"),
                Some("GameData"),
                Some(version),
            )?;
            fs::write(out.join(format!("v{version}.{ext}")), code)?;
        }
    }
    for target in [
        CodegenTarget::CSharp,
        CodegenTarget::Cpp,
        CodegenTarget::TypeScript,
    ] {
        assert_eq!(
            generate_code(&mut p, target, None)?,
            generate_code_for_version(&mut p, target, None, None)?
        );
        assert_eq!(
            generate_code_with_class_name(&mut p, target, None, Some("GameData"))?,
            generate_code_with_class_name_for_version(
                &mut p,
                target,
                None,
                Some("GameData"),
                None
            )?
        );
    }
    assert_eq!(snapshot(&p), before, "codegen changed live source tables");
    // An excluded future helper must not prevent generation for an earlier version.
    let t = p.tables_data.get_mut(&hp).unwrap();
    t.data
        .schema
        .columns
        .push(col("sample_future_curve", ValueType::String, 0));
    generate_code_for_version(&mut p, CodegenTarget::CSharp, None, Some(1))?;
    assert!(generate_code_for_version(&mut p, CodegenTarget::CSharp, None, Some(2)).is_err());
    Ok(())
}

#[test]
fn saved_source_pull_matches_codegen_without_loading_or_changing_source() -> TestResult {
    let temp = tempfile::tempdir()?;
    let output = tempfile::tempdir()?;
    let mut p = Project::create_project(
        "Unloaded",
        temp.path().to_str().unwrap(),
        "fixture",
        "#123456",
    )?;
    let path = p.create_table(PathBuf::from("sample.table.toml"))?;
    p.load_table(&path)?;
    {
        let t = p.tables_data.get_mut(&path).unwrap();
        t.data.metadata.data_name = "sample".into();
        t.data.schema.columns = vec![
            col("base", ValueType::I32, 0),
            col("future", ValueType::I32, 2),
        ];
        let mut row = Record::new();
        row.set_cell_value(&t.data.schema.columns[0], "=future*2".into());
        row.set_cell_value(&t.data.schema.columns[1], "11".into());
        t.data.records.push(row);
        Project::save_table(t)?;
    }
    p.tables_data.clear();
    let source = fs::read(&path)?;
    let model = build_model_for_version(&mut p, Some(1))?;
    assert_eq!(model.tables[0].columns.len(), 1);
    assert!(p.tables_data.is_empty());
    assert_eq!(fs::read(&path)?, source);

    let sources: Vec<_> = [
        ("full", "full", Some(1)),
        ("minimal", "minimal", Some(1)),
        ("all", "full", None),
    ]
    .into_iter()
    .map(|(id, mode, version)| {
        serde_json::json!({
            "id": id, "project": p.get_project_path(), "namespace": format!("Pulled{id}"),
            "runtime_out": output.path().join(format!("{id}.json")),
            "code_out": output.path().join(format!("{id}.cs")), "code_target": "csharp",
            "mode": mode, "version": version
        })
    })
    .collect();
    let config = output.path().join("pull.json");
    fs::write(
        &config,
        serde_json::to_vec_pretty(&serde_json::json!({"schema_version": 1, "sources": sources}))?,
    )?;
    let report = devcel_core::importer_pull::run(&config, None, false)?;
    assert!(report.success, "{}", serde_json::to_string(&report)?);
    for id in ["full", "minimal", "all"] {
        let code = fs::read_to_string(output.path().join(format!("{id}.cs")))?;
        assert!(code.contains(" Base =>"));
        assert_eq!(code.contains(" Future =>"), id == "all");
        let runtime: serde_json::Value =
            serde_json::from_slice(&fs::read(output.path().join(format!("{id}.json")))?)?;
        let table = &runtime["tables"][0];
        assert_eq!(
            table["columns"].as_array().unwrap().len(),
            if id == "all" { 2 } else { 1 }
        );
        assert_eq!(
            table["records"][0]["values"]["base"], "22",
            "hidden formula input must remain available while evaluating"
        );
        assert_eq!(
            runtime["manifest"]["content_version"],
            if id == "all" {
                serde_json::Value::Null
            } else {
                serde_json::json!(1)
            }
        );
    }
    assert_eq!(fs::read(&path)?, source);
    assert!(p.tables_data.is_empty());
    Ok(())
}

#[test]
fn unsynced_interface_and_table_versions_are_projected_independently() -> TestResult {
    for (name, table_version, interface_version, implements) in
        [("hidden", 0, 3, true), ("required", 3, 0, false)]
    {
        let temp = tempfile::tempdir()?;
        let mut project =
            Project::create_project("Stale", temp.path().to_str().unwrap(), "fixture", "#123456")?;
        let path = project.create_table(PathBuf::from("stale.table.toml"))?;
        project.load_table(&path)?;
        let mut interface = Interface::new("Contract".into(), None);
        interface.create_new_version(
            vec![InterfaceChange::AddColumn {
                column: col("value", ValueType::I32, table_version),
            }],
            None,
            None,
        )?;
        project
            .interface_registry
            .add_interface(interface.clone())?;
        {
            let table = project.tables_data.get_mut(&path).unwrap();
            table.data.metadata.data_name = "stale".into();
            table.apply_interface(&interface, &project.interface_registry, true)?;
        }
        // Updating the interface alone does not change a table's explicitly synced snapshot.
        project
            .interface_registry
            .get_interface_mut(&interface.uuid)
            .unwrap()
            .create_new_version(
                vec![InterfaceChange::ChangeMinVersion {
                    column_name: "value".into(),
                    min_version: interface_version,
                }],
                None,
                None,
            )?;
        let before = snapshot(&project);
        let model = build_model_for_version(&mut project, Some(2))?;
        assert_eq!(
            model.tables[0].columns.len(),
            usize::from(table_version <= 2)
        );
        assert_eq!(
            model.interfaces[0].members.len(),
            usize::from(interface_version <= 2)
        );
        assert_eq!(
            model.tables[0].implements,
            if implements { vec!["Contract"] } else { vec![] }
        );
        for (target, ext) in [
            (CodegenTarget::CSharp, "cs"),
            (CodegenTarget::Cpp, "h"),
            (CodegenTarget::TypeScript, "ts"),
        ] {
            let code = generate_code_with_class_name_for_version(
                &mut project,
                target,
                Some("StaleCheck"),
                Some("GameData"),
                Some(2),
            )?;
            if let Some(out) = std::env::var_os("DEVCEL_CODEGEN_FIXTURE_OUT") {
                let out = PathBuf::from(out);
                fs::create_dir_all(&out)?;
                fs::write(out.join(format!("stale-{name}.{ext}")), code)?;
            }
        }
        assert_eq!(snapshot(&project), before);
        let table = &project.tables_data[&path];
        assert_eq!(table.data.schema.columns[0].min_version, table_version);
        assert_eq!(
            table.data.interface_implementations[&interface.uuid].synced_version_id,
            interface.current_version_id
        );
    }
    Ok(())
}

#[tokio::test]
async fn export_code_operation_forwards_optional_version_and_round_trips_wire() -> TestResult {
    use devcel_core::operation_handler::{LocalOperationHandler, OperationHandler};
    use devcel_core::operations::{DevcelOperation, DevcelResponse};
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let temp = tempfile::tempdir()?;
    let mut project = Project::create_project(
        "Operation",
        temp.path().to_str().unwrap(),
        "fixture",
        "#123456",
    )?;
    let path = project.create_table(PathBuf::from("sample.table.toml"))?;
    project.load_table(&path)?;
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.metadata.data_name = "sample".into();
    table.data.schema.columns = vec![
        col("base", ValueType::I32, 0),
        col("future", ValueType::I32, 2),
    ];
    let before = snapshot(&project);
    let handler = LocalOperationHandler {
        project: Arc::new(Mutex::new(Some(project))),
    };
    for target in ["csharp", "cpp", "typescript", "ts"] {
        for version in [Some(0), Some(1), Some(2), None] {
            let operation = DevcelOperation::ExportCode {
                target: target.into(),
                filters: Default::default(),
                namespace: None,
                version,
            };
            let encoded = rmp_serde::to_vec_named(&operation)?;
            let decoded: DevcelOperation = rmp_serde::from_slice(&encoded)?;
            assert_eq!(decoded, operation);
            let DevcelResponse::Ok(response) = handler.handle_operation(decoded).await else {
                panic!("ExportCode failed for {target}/{version:?}");
            };
            let code = response["code"].as_str().unwrap();
            let accessor = match target {
                "csharp" => " Future =>",
                "cpp" => " future() const",
                _ => " get Future():",
            };
            assert_eq!(code.contains(accessor), version.is_none_or(|v| v >= 2));
            assert_eq!(response["version"], serde_json::to_value(version)?);
        }
    }
    let omitted: DevcelOperation =
        serde_json::from_value(serde_json::json!({"op":"ExportCode","data":{"target":"csharp"}}))?;
    assert!(matches!(
        omitted,
        DevcelOperation::ExportCode {
            version: None,
            namespace: None,
            ..
        }
    ));
    let project = handler.project.lock().await;
    assert_eq!(snapshot(project.as_ref().unwrap()), before);
    Ok(())
}
