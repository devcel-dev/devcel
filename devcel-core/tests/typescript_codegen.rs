//! Real TypeScript generation + canonical JSON fixtures for the compiler/runtime check.
//! DEVCEL_CODEGEN_FIXTURE_OUT=DIR cargo test -p devcel-core --test typescript_codegen
//! python3 devcel-core/tests/compile_typescript_codegen.py --fixtures DIR
use devcel_core::{codegen::*, *};
use std::{fs, path::PathBuf};

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

fn column(name: &str, data_type: ValueType, default_value: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type,
        default_value: default_value.into(),
        ..Default::default()
    }
}

#[test]
fn typescript_generates_all_canonical_types_and_real_bundles() -> TestResult {
    let temp = tempfile::tempdir()?;
    let mut project =
        Project::create_project("Types", temp.path().to_str().unwrap(), "", "#123456")?;
    let items = project.create_table(PathBuf::from("items.table.toml"))?;
    let heroes = project.create_table(PathBuf::from("heroes.table.toml"))?;
    project.load_table(&items)?;
    project.load_table(&heroes)?;
    let mut interface = Interface::new("Named".into(), None);
    interface.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: column("title", ValueType::String, "default title"),
        }],
        None,
        None,
    )?;
    project
        .interface_registry
        .add_interface(interface.clone())?;
    let item_id;
    let table_id;
    {
        let table = project.tables_data.get_mut(&items).unwrap();
        table.data.metadata.data_name = "items".into();
        table_id = table.data.uuid.clone();
        table.apply_interface(&interface, &project.interface_registry, true)?;
        let row = Record::new();
        item_id = row.uuid.clone();
        table.data.records.push(row);
    }
    let hero_id;
    {
        let table = project.tables_data.get_mut(&heroes).unwrap();
        table.data.metadata.data_name = "heroes".into();
        table.apply_interface(&interface, &project.interface_registry, true)?;
        table.data.schema.columns.extend([
            column("empty", ValueType::None, ""),
            column("byte", ValueType::U8, "255"),
            column("signed_byte", ValueType::I8, "-128"),
            column("short", ValueType::I16, "-32768"),
            column("unsigned_short", ValueType::U16, "65535"),
            column("int", ValueType::I32, "-2147483648"),
            column("unsigned_int", ValueType::U32, "4294967295"),
            column("long", ValueType::I64, "-9223372036854775808"),
            column("unsigned_long", ValueType::U64, "18446744073709551615"),
            column("single", ValueType::F32, "1.25"),
            column("double", ValueType::F64, "3.125"),
            column("enabled", ValueType::Boolean, "true"),
            column("tint", ValueType::Color32, "[0,128,255,64]"),
            column("hdr", ValueType::ColorFloat, "[-2.0,4.0,0.5,0.25]"),
            column("when", ValueType::DateTime, "2026-10-14T11:00:00Z"),
        ]);
        let mut curve = column("curve", ValueType::Curve, "");
        curve.curve_config = Some(CurveConfig::default());
        let mut reference = column("weapon", ValueType::Reference, &item_id);
        reference.reference_config = Some(ReferenceConfig {
            target_table_uuid: table_id.clone(),
            display_column_uuid: None,
        });
        let mut table_ref = column("catalog", ValueType::TableRef, &table_id);
        table_ref.table_ref_config = Some(TableRefConfig {
            interface_uuid: interface.uuid.to_string(),
        });
        let mut select = column("kind", ValueType::Select, "high-tier");
        select.select_config = Some(SelectConfig {
            options: vec![
                SelectOption {
                    value: "high-tier".into(),
                    label: "High".into(),
                },
                SelectOption {
                    value: "high_tier".into(),
                    label: "Different".into(),
                },
                SelectOption {
                    value: "quote\"\nline".into(),
                    label: "Escaped".into(),
                },
            ],
        });
        let mut future = column("future", ValueType::String, "future");
        future.min_version = 2;
        table
            .data
            .schema
            .columns
            .extend([curve, reference, table_ref, select, future]);
        let row = Record::new();
        hero_id = row.uuid.clone();
        table.data.records.push(row);
    }
    let code = generate_code_with_class_name(
        &mut project,
        CodegenTarget::TypeScript,
        Some("Game::Data"),
        Some("GameData"),
    )?;
    assert!(code.contains("export namespace Game.Data"));
    assert!(code.contains("export class HeroesRow implements INamed"));
    assert!(code.contains("get Long(): bigint"));
    assert!(code.contains("get UnsignedLong(): bigint"));
    assert!(code.contains("get Tint(): __devcelRuntime.Color32"));
    assert!(code.contains("get Hdr(): __devcelRuntime.ColorFloat"));
    assert!(code.contains("this._row.reference(\"weapon\", \"items\")"));
    assert!(code.contains("HighTier2 = \"high_tier\""));
    let early = generate_code_with_class_name_for_version(
        &mut project,
        CodegenTarget::TypeScript,
        Some("Game.Data"),
        Some("GameData"),
        Some(1),
    )?;
    assert!(!early.contains("get Future()"));
    assert!(code.contains("get Future()"));
    if let Some(out) = std::env::var_os("DEVCEL_CODEGEN_FIXTURE_OUT") {
        let out = PathBuf::from(out);
        fs::create_dir_all(&out)?;
        fs::write(out.join("types.ts"), code)?;
        fs::write(out.join("types-early.ts"), early)?;
        for (name, mode) in [("full", ExportMode::Full), ("minimal", ExportMode::Minimal)] {
            fs::write(
                out.join(format!("types-{name}.json")),
                json_export::export_runtime_bundle_as_json(&mut project, mode, None)?,
            )?;
        }
        fs::write(
            out.join("types-ids.json"),
            serde_json::to_vec(&serde_json::json!({"hero":hero_id,"item":item_id}))?,
        )?;
    }
    Ok(())
}

#[test]
fn typescript_rejects_keyword_and_generated_api_collisions() -> TestResult {
    assert_eq!(
        CodegenTarget::from_name("TYPESCRIPT"),
        Some(CodegenTarget::TypeScript)
    );
    assert_eq!(
        CodegenTarget::from_name("ts"),
        Some(CodegenTarget::TypeScript)
    );
    assert_eq!(CodegenTarget::TypeScript.file_extension(), "ts");
    let temp = tempfile::tempdir()?;
    let mut project =
        Project::create_project("Names", temp.path().to_str().unwrap(), "", "#123456")?;
    for name in [
        "await",
        "debugger",
        "extends",
        "function",
        "import",
        "instanceof",
        "package",
        "super",
        "with",
        "yield",
        "let",
        "type",
        "any",
        "number",
        "bigint",
        "unknown",
        "undefined",
        "module",
        "constructor",
        "Runtime",
        "FromRuntime",
        "LoadJson",
        "DevcelTableReference",
    ] {
        assert!(
            generate_code_with_class_name(
                &mut project,
                CodegenTarget::TypeScript,
                None,
                Some(name)
            )
            .is_err(),
            "accepted class_name {name}"
        );
    }
    for namespace in [
        "Game.await",
        "Game.function",
        "Game.import",
        "Game.extends",
        "Game.with",
        "Game::yield",
        "any",
        "Game.type",
        "Game.toString",
        "Game.constructor",
        "Game.prototype",
    ] {
        assert!(
            generate_code(&mut project, CodegenTarget::TypeScript, Some(namespace)).is_err(),
            "accepted namespace {namespace}"
        );
    }
    let path = project.create_table(PathBuf::from("sample.table.toml"))?;
    project.load_table(&path)?;
    for name in ["runtime", "from_runtime", "load_json"] {
        project
            .tables_data
            .get_mut(&path)
            .unwrap()
            .data
            .metadata
            .data_name = name.into();
        assert!(generate_code(&mut project, CodegenTarget::TypeScript, None).is_err());
    }
    project
        .tables_data
        .get_mut(&path)
        .unwrap()
        .data
        .metadata
        .data_name = "sample".into();
    for name in ["SampleRow", "SampleTable", "Sample"] {
        assert!(generate_code_with_class_name(
            &mut project,
            CodegenTarget::TypeScript,
            None,
            Some(name)
        )
        .is_err());
    }
    for name in ["id", "row_index", "sample_row"] {
        project
            .tables_data
            .get_mut(&path)
            .unwrap()
            .data
            .schema
            .columns = vec![column(name, ValueType::String, "")];
        assert!(generate_code(&mut project, CodegenTarget::TypeScript, None).is_err());
    }
    Ok(())
}
