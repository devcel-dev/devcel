use devcel_core::{
    codegen::{self, CodegenTarget},
    json_export::{self, ExportMode},
    *,
};
use std::{fs, path::PathBuf};

fn fixture(labels: &[&str]) -> (tempfile::TempDir, Project, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "Typed references",
        dir.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let path = project.create_table("enemies.table.toml".into()).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.metadata.data_name = "enemies".into();
    let name = ColumnSchema {
        data_name: "name".into(),
        data_type: ValueType::String,
        ..Default::default()
    };
    table.data.schema.columns = vec![name.clone()];
    table.data.records = labels
        .iter()
        .enumerate()
        .map(|(i, label)| {
            let mut row = Record::new();
            row.uuid = format!("00000000-0000-4000-8000-{:012}", i + 1);
            row.label = (*label).into();
            row.set_cell_value(&name, format!("Enemy {}", i + 1));
            row
        })
        .collect();
    (dir, project, path)
}

#[test]
fn typed_references_use_uuid_and_exact_labels_without_mutating_authoring() {
    let (_dir, mut p, path) = fixture(&["Slime", "foo_bar", "", "", "slime"]);
    let before = serde_json::to_value(&p.tables_data[&path].data).unwrap();
    let code = codegen::generate_code_with_class_name(
        &mut p,
        CodegenTarget::CSharp,
        Some("Game.Master"),
        Some("GameDatabase"),
    )
    .unwrap();
    assert!(code.contains("public sealed class EnemiesReference"));
    assert!(code.contains("TryGet(EnemiesReference? reference, out EnemiesHandle? row)"));
    assert!(code.contains(
        "EnemiesKey foo_bar => new EnemiesKey(\"00000000-0000-4000-8000-000000000002\")"
    ));
    assert!(code.contains("EnemiesKey slime =>"));
    assert!(!code.contains("EnemiesReference Row3"));
    assert!(!code.contains("EnemiesReference FooBar"));
    assert_eq!(
        before,
        serde_json::to_value(&p.tables_data[&path].data).unwrap()
    );
    if let Some(out) = std::env::var_os("DEVCEL_TYPED_REFS_OUT") {
        let out = PathBuf::from(out);
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("Devcel.cs"), code).unwrap();
        fs::write(
            out.join("bundle.json"),
            json_export::export_runtime_bundle_as_json(&mut p, ExportMode::Full, None).unwrap(),
        )
        .unwrap();
        let column = p.tables_data[&path].data.schema.columns[0].clone();
        p.tables_data.get_mut(&path).unwrap().data.records[0]
            .set_cell_value(&column, "Renamed runtime value".into());
        fs::write(
            out.join("updated.json"),
            json_export::export_runtime_bundle_as_json(&mut p, ExportMode::Full, None).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn labels_fail_closed_without_normalization_or_suffixes() {
    for labels in [
        &["same", "same"][..],
        &["while"][..],
        &["bad-label"][..],
        &["日本語"][..],
        &["EnemiesReferences"][..],
    ] {
        let (_dir, mut p, _) = fixture(labels);
        assert!(
            codegen::generate_code(&mut p, CodegenTarget::CSharp, Some("Game.Master")).is_err(),
            "{labels:?}"
        );
    }
    let (_dir, mut p, _) = fixture(&["Slime"]);
    assert!(codegen::generate_code_with_class_name(
        &mut p,
        CodegenTarget::CSharp,
        Some("Game.Master"),
        Some("EnemiesReference")
    )
    .is_err());
}

#[test]
fn named_references_follow_version_and_tag_filter() {
    let (_dir, mut p, path) = fixture(&["Early", "Late", "Hidden"]);
    p.tables_data.get_mut(&path).unwrap().data.records[1].min_version = 2;
    p.tables_data.get_mut(&path).unwrap().data.records[2].tags = vec!["hidden".into()];
    let filters = devcel_core::tag_filter::TagFilter {
        row_exclude_tags: vec!["hidden".into()],
        ..Default::default()
    };
    let code = codegen::generate_code_with_class_name_for_filters(
        &mut p,
        CodegenTarget::CSharp,
        Some("Game.Master"),
        None,
        Some(0),
        &filters,
    )
    .unwrap();
    assert!(code.contains("EnemiesKey Early =>"));
    assert!(!code.contains("EnemiesKey Late =>"));
    assert!(!code.contains("EnemiesKey Hidden =>"));
}

#[test]
fn interface_references_retain_table_identity_and_only_generate_valid_conversions() {
    let (_dir, mut p, enemies) = fixture(&["Slime", "", "Child"]);
    let mut create = CreateInterfaceCommand::new("Damageable".into(), None);
    create.execute(&mut p).unwrap();
    let interface_id = p
        .list_interfaces()
        .iter()
        .find(|i| i.name == "Damageable")
        .unwrap()
        .uuid;
    let hp = ColumnSchema {
        data_name: "hp".into(),
        data_type: ValueType::I32,
        default_value: "7".into(),
        ..Default::default()
    };
    p.get_interface_mut(&interface_id)
        .unwrap()
        .create_new_version(vec![InterfaceChange::AddColumn { column: hp }], None, None)
        .unwrap();
    ApplyInterfaceCommand::new(enemies.clone(), interface_id, true)
        .execute(&mut p)
        .unwrap();
    let props = p.create_table("props.table.toml".into()).unwrap();
    p.tables_data
        .get_mut(&props)
        .unwrap()
        .data
        .metadata
        .data_name = "props".into();
    ApplyInterfaceCommand::new(props.clone(), interface_id, true)
        .execute(&mut p)
        .unwrap();
    let hp = p.tables_data[&enemies]
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "hp")
        .unwrap()
        .clone();
    let same_id = p.tables_data[&enemies].data.records[0].uuid.clone();
    p.tables_data.get_mut(&enemies).unwrap().data.records[0].set_cell_value(&hp, "42".into());
    p.tables_data.get_mut(&enemies).unwrap().data.records[2].parent_uuid = same_id.clone();
    let hp2 = p.tables_data[&props]
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "hp")
        .unwrap()
        .clone();
    let mut other = Record::new();
    other.uuid = same_id;
    other.label = "Barrel".into();
    other.set_cell_value(&hp2, "91".into());
    p.tables_data
        .get_mut(&props)
        .unwrap()
        .data
        .records
        .push(other);
    let props_uuid = p.tables_data[&props].data.uuid.clone();
    let friend = ColumnSchema {
        data_name: "friend".into(),
        data_type: ValueType::Reference,
        reference_config: Some(ReferenceConfig {
            target_table_uuid: props_uuid.clone(),
            display_column_uuid: None,
        }),
        ..Default::default()
    };
    let table_ref = ColumnSchema {
        data_name: "catalog".into(),
        data_type: ValueType::TableRef,
        table_ref_config: Some(TableRefConfig {
            interface_uuid: interface_id.to_string(),
        }),
        ..Default::default()
    };
    p.tables_data
        .get_mut(&enemies)
        .unwrap()
        .data
        .schema
        .columns
        .extend([friend.clone(), table_ref.clone()]);
    p.tables_data.get_mut(&enemies).unwrap().data.records[0]
        .set_cell_value(&friend, "00000000-0000-4000-8000-000000000001".into());
    p.tables_data.get_mut(&enemies).unwrap().data.records[0].set_cell_value(&table_ref, props_uuid);
    CreateInterfaceCommand::new("Armored".into(), None)
        .execute(&mut p)
        .unwrap();
    let armor_id = p
        .list_interfaces()
        .iter()
        .find(|i| i.name == "Armored")
        .unwrap()
        .uuid;
    p.get_interface_mut(&armor_id)
        .unwrap()
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "hp".into(),
                    data_type: ValueType::I32,
                    default_value: "100".into(),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    ApplyInterfaceCommand::new(enemies.clone(), armor_id, true)
        .execute(&mut p)
        .unwrap();
    for (name, kind, value) in [
        ("byte_value", ValueType::U8, "255"),
        ("sbyte_value", ValueType::I8, "-128"),
        ("short_value", ValueType::I16, "-1234"),
        ("ushort_value", ValueType::U16, "60000"),
        ("uint_value", ValueType::U32, "4000000000"),
        ("long_value", ValueType::I64, "-9007199254740993"),
        ("ulong_value", ValueType::U64, "9007199254740993"),
        ("float_value", ValueType::F32, "1.25"),
        ("double_value", ValueType::F64, "-2.5"),
        ("enabled", ValueType::Boolean, "true"),
        ("tint", ValueType::Color32, "[128,0,255,255]"),
        ("hdr", ValueType::ColorFloat, "[-2.0,4.0,0.0,1.0]"),
        ("choice", ValueType::Select, "Ready"),
        ("when", ValueType::DateTime, "2026-10-26T12:34:56Z"),
    ] {
        p.tables_data
            .get_mut(&enemies)
            .unwrap()
            .data
            .schema
            .columns
            .push(ColumnSchema {
                data_name: name.into(),
                data_type: kind,
                default_value: value.into(),
                ..Default::default()
            });
    }
    p.tables_data
        .get_mut(&enemies)
        .unwrap()
        .data
        .schema
        .columns
        .push(ColumnSchema {
            data_name: "growth".into(),
            data_type: ValueType::Curve,
            curve_config: Some(devcel_core::types::CurveConfig {
                start_value: 10.0,
                end_value: 30.0,
            }),
            ..Default::default()
        });
    let code = codegen::generate_code_with_class_name(
        &mut p,
        CodegenTarget::CSharp,
        Some("Game.Master"),
        Some("GameDatabase"),
    )
    .unwrap();
    assert!(code.contains("public sealed class IDamageableReference"));
    assert!(code.contains("int IDamageable.Hp =>"));
    assert!(code.contains("int IArmored.Hp =>"));
    assert!(code.contains("public IDamageableKey AsDamageable()"));
    for path in [&enemies, &props] {
        assert!(code.contains(&format!("case \"{}\":", p.tables_data[path].data.uuid)));
    }
    let full = json_export::export_runtime_bundle_as_json(&mut p, ExportMode::Full, None).unwrap();
    let minimal =
        json_export::export_runtime_bundle_as_json(&mut p, ExportMode::Minimal, None).unwrap();
    if let Some(out) = std::env::var_os("DEVCEL_TYPED_REFS_OUT") {
        let out = PathBuf::from(out).join("interfaces");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("Devcel.cs"), code).unwrap();
        fs::write(out.join("bundle.json"), &full).unwrap();
        fs::write(out.join("minimal.json"), minimal).unwrap();
        let mut removed: serde_json::Value = serde_json::from_str(&full).unwrap();
        removed["tables"][0]["interfaces"] = serde_json::json!([]);
        removed["manifest"]["content_hash"] = serde_json::json!("membership-removed");
        fs::write(out.join("removed.json"), removed.to_string()).unwrap();
    }
}

#[test]
fn reference_type_names_cannot_collide_with_runtime_helpers() {
    let (_dir, mut p, path) = fixture(&[]);
    p.tables_data
        .get_mut(&path)
        .unwrap()
        .data
        .metadata
        .data_name = "devcel_table".into();
    let error = codegen::generate_code(&mut p, CodegenTarget::CSharp, None).unwrap_err();
    assert!(error.to_string().contains("DevcelTableReference"));
}

#[test]
fn live_handle_internal_member_names_are_rejected() {
    for name in ["state", "prepare", "publish"] {
        let (_dir, mut project, path) = fixture(&["Slime"]);
        project
            .tables_data
            .get_mut(&path)
            .unwrap()
            .data
            .schema
            .columns[0]
            .data_name = name.into();
        let error = codegen::generate_code(&mut project, CodegenTarget::CSharp, None).unwrap_err();
        assert!(
            error.to_string().contains("live handle member collision"),
            "{error}"
        );
    }
}

#[test]
fn managed_memory_helpers_cannot_collide_with_table_properties() {
    for name in [
        "table_views",
        "share_string",
        "get_table_view",
        "check_read_model",
        "publish_read_model",
        "dispose_read_model",
    ] {
        let (_dir, mut project, path) = fixture(&[]);
        project
            .tables_data
            .get_mut(&path)
            .unwrap()
            .data
            .metadata
            .data_name = name.into();
        assert!(
            codegen::generate_code(&mut project, CodegenTarget::CSharp, None).is_err(),
            "{name}"
        );
    }
}

#[test]
fn unity_read_scopes_are_main_thread_only_and_other_targets_keep_monitor() {
    let (_dir, mut project, _) = fixture(&["Slime"]);
    let code = codegen::generate_code_with_class_name(
        &mut project,
        CodegenTarget::CSharp,
        Some("Game.Master"),
        Some("GameDatabase"),
    )
    .unwrap();
    assert!(code.contains("#if UNITY_5_3_OR_NEWER"));
    assert!(
        code.contains("internal ReadScope EnterRead() { EnsureOwnerThread(); return default; }")
    );
    assert!(code.contains("System.Threading.Monitor.Enter(gate)"));
    assert!(code.contains("System.Threading.Monitor.Exit(_gate)"));
    assert!(code.contains("using (EnterRead())"));
    assert!(code.contains("~GameDatabase() { DisposeCore(); }"));
}
