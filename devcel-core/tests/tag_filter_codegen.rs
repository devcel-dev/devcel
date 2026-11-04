use devcel_core::{codegen::*, tag_filter::TagFilter, *};
use std::path::PathBuf;

#[test]
fn tag_projection_preserves_names_and_canonical_interfaces() -> Result<()> {
    let dir = tempfile::tempdir().unwrap();
    let mut p = Project::create_project("Tags", dir.path().to_str().unwrap(), "", "#123456")?;
    let path = p.create_table(PathBuf::from("items.table.toml"))?;
    p.load_table(&path)?;
    let mut interface = Interface::new("Contract".into(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "required".into(),
                    display_name: "required".into(),
                    data_type: ValueType::String,
                    tags: vec!["private".into()],
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    p.interface_registry.add_interface(interface.clone())?;
    let table = p.tables_data.get_mut(&path).unwrap();
    table.data.metadata.data_name = "items".into();
    table.apply_interface(&interface, &p.interface_registry, true)?;
    for tags in [vec!["private".into()], vec!["public".into()]] {
        table.data.schema.columns.push(ColumnSchema {
            data_name: "same".into(),
            display_name: "same".into(),
            data_type: ValueType::String,
            tags,
            ..Default::default()
        });
    }
    let before = serde_json::to_value(&table.data).unwrap();
    let full = build_model(&mut p)?;
    let filter = TagFilter {
        column_exclude_tags: vec!["private".into()],
        ..Default::default()
    };
    let model = build_model_for_filters(&mut p, None, &filter)?;
    assert_eq!(model.tables[0].columns.len(), 1);
    assert_eq!(
        model.tables[0].columns[0].key,
        full.tables[0].columns[2].key
    );
    assert_eq!(
        model.tables[0].columns[0].accessor,
        full.tables[0].columns[2].accessor
    );
    assert!(model.tables[0].implements.is_empty());
    assert_eq!(model.interfaces[0].members.len(), 1);
    for (target, ext) in [
        (CodegenTarget::CSharp, "cs"),
        (CodegenTarget::Cpp, "h"),
        (CodegenTarget::TypeScript, "ts"),
    ] {
        let code = generate_code_with_class_name_for_filters(
            &mut p,
            target,
            Some("TagCheck"),
            None,
            None,
            &filter,
        )?;
        assert!(code.contains("IContract"));
        if let Some(output) = std::env::var_os("DEVCEL_TAG_CODEGEN_FIXTURE_OUT") {
            std::fs::create_dir_all(&output).unwrap();
            std::fs::write(PathBuf::from(output).join(format!("tags.{ext}")), code).unwrap();
        }
    }
    assert_eq!(
        serde_json::to_value(&p.tables_data[&path].data).unwrap(),
        before
    );
    Ok(())
}

#[test]
fn tag_projection_operations_roundtrip_and_legacy_defaults() {
    for name in ["ExportCode", "ExportRuntimeBundle"] {
        let value = serde_json::json!({"op":name,"data":{
            "target":"typescript", "mode":"full", "version":3,
            "row_include_tags":["公開"], "column_exclude_tags":["private"]
        }});
        // Exact operation fields remain unchanged; only the four optional tag arrays are added.
        let mut value = value;
        if name == "ExportCode" {
            value["data"].as_object_mut().unwrap().remove("mode");
        } else {
            value["data"].as_object_mut().unwrap().remove("target");
        }
        let op: devcel_core::operations::DevcelOperation = serde_json::from_value(value).unwrap();
        let bytes = rmp_serde::to_vec_named(&op).unwrap();
        let decoded: devcel_core::operations::DevcelOperation =
            rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded, op);
        let json = serde_json::to_value(decoded).unwrap();
        assert_eq!(
            json["data"]["row_include_tags"],
            serde_json::json!(["公開"])
        );
        assert_eq!(
            json["data"]["column_exclude_tags"],
            serde_json::json!(["private"])
        );
    }
    let old: devcel_core::operations::DevcelOperation = serde_json::from_value(
        serde_json::json!({"op":"ExportRuntimeBundle","data":{"mode":"full","version":null}}),
    )
    .unwrap();
    assert!(
        matches!(old, devcel_core::operations::DevcelOperation::ExportRuntimeBundle { filters, .. } if filters.is_empty())
    );
}
