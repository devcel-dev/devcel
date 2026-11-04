//! Deterministic end-to-end fixture for engine/codegen tests.
use devcel_core::{
    codegen::{generate_code, CodegenTarget},
    json_export::{export_runtime_bundle_as_json, write_export_file, ExportMode},
    *,
};
use std::path::PathBuf;
fn col(name: &str, kind: ValueType, default: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: kind,
        default_value: default.into(),
        ..Default::default()
    }
}
fn main() -> Result<()> {
    let out = PathBuf::from(std::env::args().nth(1).expect("output directory"));
    std::fs::create_dir_all(&out)?;
    let temp = tempfile::tempdir()?;
    let mut p = Project::create_project(
        "CodegenQA",
        temp.path().to_str().unwrap(),
        "engine fixture",
        "#123456",
    )?;
    let ip = p.create_table(PathBuf::from("items.table.toml"))?;
    p.load_table(&ip)?;
    let hp = p.create_table(PathBuf::from("heroes.table.toml"))?;
    p.load_table(&hp)?;
    let itemid = "11111111-1111-4111-8111-111111111111";
    let heroid = "22222222-2222-4222-8222-222222222222";
    let mut parent = Interface::new("Named".into(), None);
    parent
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: col("name", ValueType::String, "Default name"),
            }],
            None,
            None,
        )
        .unwrap();
    let mut iface = Interface::new("Character".into(), None);
    iface
        .create_new_version(
            vec![
                InterfaceChange::AddColumn {
                    column: col("hp", ValueType::I32, "42"),
                },
                InterfaceChange::AddColumn {
                    column: col("tint", ValueType::Color32, "[18,171,239,0]"),
                },
                InterfaceChange::AddColumn {
                    column: col("light", ValueType::ColorFloat, "[-0.25,4,0.5,0]"),
                },
                InterfaceChange::ModifyExtends {
                    new_extends: vec![parent.uuid],
                },
            ],
            None,
            None,
        )
        .unwrap();
    p.interface_registry.add_interface(parent.clone()).unwrap();
    p.interface_registry.add_interface(iface.clone()).unwrap();
    let item_table_uuid = p.tables_data[&ip].data.uuid.clone();
    {
        let t = p.tables_data.get_mut(&ip).unwrap();
        t.data.metadata.data_name = "items".into();
        t.data.schema.columns = vec![col("power", ValueType::I32, "20")];
        let mut row = Record::new();
        row.uuid = itemid.into();
        t.data.records.push(row);
    }
    {
        let t = p.tables_data.get_mut(&hp).unwrap();
        t.data.metadata.data_name = "heroes".into();
        t.apply_interface(&iface, &p.interface_registry, true)
            .unwrap();
        let mut reference = col("weapon", ValueType::Reference, "");
        reference.reference_config = Some(ReferenceConfig {
            target_table_uuid: item_table_uuid.clone(),
            display_column_uuid: None,
        });
        let mut target = col("target", ValueType::TableRef, "");
        target.table_ref_config = Some(TableRefConfig {
            interface_uuid: iface.uuid.to_string(),
        });
        let mut curve = col("curve", ValueType::Curve, "");
        curve.curve_config = Some(CurveConfig::default());
        t.data.schema.columns.extend([
            reference,
            target,
            curve,
            col("limit", ValueType::U64, "18446744073709551615"),
            col("floor", ValueType::I64, "-9223372036854775808"),
            col("enabled", ValueType::Boolean, "true"),
            col("speed", ValueType::F64, "1.5"),
            col("class", ValueType::String, "keyword"),
            col("computed", ValueType::I32, "=hp * 2"),
        ]);
        let mut row = Record::new();
        row.uuid = heroid.into();
        for c in &t.data.schema.columns {
            let v=match c.data_name.as_str(){"weapon"=>itemid.to_string(),"target"=>t.data.uuid.clone(),"name"=>"勇者\nHero".into(),"curve"=>r#"{"points":[{"x":0,"y":0,"mode":"constant"},{"x":0.5,"y":0.7,"mode":"linear"},{"x":1,"y":1,"mode":"auto"}]}"#.into(),_=>continue};
            row.set_cell_value(c, v);
        }
        t.data.records.push(row);
        let mut later = Record::new();
        later.uuid = "33333333-3333-4333-8333-333333333333".into();
        later.min_version = 2;
        t.data.records.push(later);
    }
    for (target, file) in [
        (CodegenTarget::CSharp, "Devcel.cs"),
        (CodegenTarget::Cpp, "Devcel.h"),
    ] {
        write_export_file(out.join(file), &generate_code(&mut p, target, None)?)?;
    }
    // Include two independently generated namespaces together in native smoke tests.
    write_export_file(
        out.join("DevcelOther.h"),
        &generate_code(&mut p, CodegenTarget::Cpp, Some("DevcelOther"))?,
    )?;
    for (mode, file) in [
        (ExportMode::Full, "bundle-initial.json"),
        (ExportMode::Minimal, "minimal-initial.json"),
    ] {
        write_export_file(
            out.join(file),
            &export_runtime_bundle_as_json(&mut p, mode, Some(1))?,
        )?;
    }
    let all = export_runtime_bundle_as_json(&mut p, ExportMode::Full, None)?;
    write_export_file(out.join("all-versions.json"), &all)?;
    {
        let t = p.tables_data.get_mut(&hp).unwrap();
        let c = t
            .data
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == "hp")
            .unwrap()
            .clone();
        t.data.records[0].set_cell_value(&c, "777".into());
        t.data.schema.columns.reverse();
        t.data.records.reverse();
    }
    let ap = p.create_table(PathBuf::from("aaa.table.toml"))?;
    p.load_table(&ap)?;
    p.tables_data.get_mut(&ap).unwrap().data.metadata.data_name = "aaa".into();
    write_export_file(
        out.join("bundle-updated.json"),
        &export_runtime_bundle_as_json(&mut p, ExportMode::Full, None)?,
    )?;
    println!("{}", out.display());
    Ok(())
}
