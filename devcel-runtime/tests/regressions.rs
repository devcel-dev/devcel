use devcel_runtime::{Database, Snapshot};
use serde_json::json;

fn bundle(columns: serde_json::Value, values: serde_json::Value) -> String {
    json!({"manifest":{"schema_version":1,"content_hash":"test","mode":"minimal",
        "data_revision":1,"generated_at":"2026-10-01T00:00:00Z"},"project_name":"Runtime contract",
      "tables":[{"uuid":"11111111-1111-4111-8111-111111111111","name":"items","columns":columns,"records":[{"id":"row","values":values}]}]})
    .to_string()
}

#[test]
fn minimal_restores_all_scalar_defaults_and_preserves_explicit_empty() {
    let s = Snapshot::from_json(&bundle(
        json!([
          {"name":"hp","data_type":"I32","default_value":"42"},
          {"name":"speed","data_type":"F64","default_value":"1.5"},
          {"name":"enabled","data_type":"Boolean","default_value":"true"},
          {"name":"label","data_type":"String","default_value":"日本語"},
          {"name":"empty","data_type":"String","default_value":"fallback"}
        ]),
        json!({"empty":""}),
    ))
    .unwrap();
    let t = s.table(0).unwrap();
    assert_eq!(t.column(0).unwrap().i64_at(0), 42);
    assert_eq!(t.column(1).unwrap().f64_at(0), 1.5);
    assert!(t.column(2).unwrap().bool_at(0));
    assert_eq!(t.column(3).unwrap().str_at(0), Some("日本語"));
    assert_eq!(t.column(4).unwrap().str_at(0), Some(""));
}

#[test]
fn table_ref_is_preserved_as_text() {
    let s = Snapshot::from_json(&bundle(
        json!([{"name":"target","data_type":"TableRef"}]),
        json!({"target":"table-uuid"}),
    ))
    .unwrap();
    assert_eq!(
        s.table(0).unwrap().column(0).unwrap().str_at(0),
        Some("table-uuid")
    );
}

#[test]
fn rejects_duplicate_names_and_record_ids() {
    let good = bundle(json!([{"name":"hp","data_type":"I32"}]), json!({"hp":"42"}));
    for duplicate in ["table", "column", "record"] {
        let mut d: serde_json::Value = serde_json::from_str(&good).unwrap();
        match duplicate {
            "table" => {
                let t = d["tables"][0].clone();
                d["tables"].as_array_mut().unwrap().push(t);
            }
            "column" => {
                let c = d["tables"][0]["columns"][0].clone();
                d["tables"][0]["columns"].as_array_mut().unwrap().push(c);
            }
            _ => {
                let r = d["tables"][0]["records"][0].clone();
                d["tables"][0]["records"].as_array_mut().unwrap().push(r);
            }
        }
        assert!(
            Snapshot::from_json(&d.to_string()).is_err(),
            "accepted duplicate {duplicate}"
        );
    }
}

#[test]
fn reload_invalid_same_hash_keeps_old_snapshot() {
    let dir = std::env::temp_dir().join(format!("devcel-runtime-reload-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("bundle.json");
    let good = bundle(json!([{"name":"hp","data_type":"I32"}]), json!({"hp":"42"}));
    std::fs::write(&p, &good).unwrap();
    let d = Database::open(&p).unwrap();
    let old = d.load();
    let bad = good.replace("\"schema_version\":1", "\"schema_version\":999");
    std::fs::write(&p, bad).unwrap();
    assert!(d.reload_if_changed().is_err());
    assert_eq!(old.table(0).unwrap().column(0).unwrap().i64_at(0), 42);
    assert_eq!(d.load().table(0).unwrap().column(0).unwrap().i64_at(0), 42);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn invalid_scalars_are_errors_instead_of_silent_zero() {
    for (kind, value) in [
        ("I32", "oops"),
        ("I8", "128"),
        ("U8", "-1"),
        ("I64", "18446744073709551615"),
        ("F32", "1e100"),
        ("I64", "1.5"),
        ("F64", "NaN"),
        ("F32", "inf"),
        ("Boolean", "yes"),
    ] {
        assert!(
            Snapshot::from_json(&bundle(
                json!([{"name":"value","data_type":kind}]),
                json!({"value":value})
            ))
            .is_err(),
            "{kind} {value}"
        );
    }
}
#[test]
fn integer_boundaries_retain_u64_bits() {
    let s = Snapshot::from_json(&bundle(
        json!([{"name":"min","data_type":"I64"},{"name":"max","data_type":"U64"}]),
        json!({"min":"-9223372036854775808","max":"18446744073709551615"}),
    ))
    .unwrap();
    assert_eq!(s.table(0).unwrap().column(0).unwrap().i64_at(0), i64::MIN);
    assert_eq!(
        s.table(0).unwrap().column(1).unwrap().i64_at(0) as u64,
        u64::MAX
    );
}

#[test]
fn rejects_missing_required_metadata_and_unsupported_type_names() {
    let canonical: serde_json::Value = serde_json::from_str(&bundle(
        json!([{"name":"v","data_type":"String"}]),
        json!({"v":"current"}),
    ))
    .unwrap();
    for (parent, field) in [
        ("", "project_name"),
        ("/manifest", "data_revision"),
        ("/manifest", "generated_at"),
        ("/manifest", "mode"),
        ("/tables/0", "uuid"),
        ("/tables/0/records/0", "values"),
    ] {
        let mut invalid = canonical.clone();
        invalid
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            Snapshot::from_json(&invalid.to_string()).is_err(),
            "accepted missing {parent}/{field}"
        );
    }
    for (path, value) in [
        ("/manifest/mode", json!("")),
        ("/manifest/mode", json!("unknown")),
        ("/manifest/generated_at", json!("")),
        ("/manifest/data_revision", json!(-1)),
        ("/tables/0/uuid", json!("")),
        ("/tables/0/columns/0/data_type", json!("Str")),
        ("/tables/0/columns/0/data_type", json!("Bool")),
    ] {
        let mut invalid = canonical.clone();
        *invalid.pointer_mut(path).unwrap() = value;
        assert!(
            Snapshot::from_json(&invalid.to_string()).is_err(),
            "accepted invalid {path}"
        );
    }
    // Current exporter may omit content_version, empty interfaces and optional
    // type-specific configs, and it may omit individual default-valued cells.
    assert!(Snapshot::from_json(&canonical.to_string()).is_ok());
}

#[test]
fn reload_rejects_missing_metadata_before_same_hash_fast_path() {
    let dir = std::env::temp_dir().join(format!("devcel-runtime-contract-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bundle.json");
    let good = bundle(
        json!([{"name":"v","data_type":"String"}]),
        json!({"v":"retained"}),
    );
    std::fs::write(&path, &good).unwrap();
    let db = Database::open(&path).unwrap();
    for (parent, field) in [
        ("/manifest", "mode"),
        ("/tables/0", "uuid"),
        ("/tables/0/records/0", "values"),
    ] {
        let mut bad: serde_json::Value = serde_json::from_str(&good).unwrap();
        bad.pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(field);
        std::fs::write(&path, bad.to_string()).unwrap();
        assert!(db.reload_if_changed().is_err());
        assert_eq!(
            db.load().table(0).unwrap().column(0).unwrap().str_at(0),
            Some("retained")
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn curve_requires_explicit_current_tangent_mode_but_keeps_empty_default() {
    use devcel_runtime::curve::Curve;
    assert!(Curve::parse(r#"{"points":[{"x":0,"y":0},{"x":1,"y":1}]}"#, None).is_err());
    assert!(Curve::parse("", None).is_ok());
    assert!(Curve::parse(
        r#"{"points":[{"x":0,"y":0,"mode":"auto"},{"x":1,"y":1,"mode":"auto"}]}"#,
        None
    )
    .is_ok());
}

#[test]
fn typed_rgba_survives_defaults_native_access_and_validation() {
    use devcel_runtime::{ffi, Color32, ColorFloat};
    let json = bundle(
        json!([
            {"name":"byte","data_type":"Color32","default_value":"[18,171,239,0]"},
            {"name":"hdr","data_type":"ColorFloat","default_value":"[-0.25,4,0.5,0]"},
            {"name":"white32","data_type":"Color32"},
            {"name":"whitefloat","data_type":"ColorFloat"}
        ]),
        json!({}),
    );
    let db = Database::from_json(&json).unwrap();
    let snap = db.load();
    let table = snap.table(0).unwrap();
    assert_eq!(
        table.column(0).unwrap().color32_at(0).unwrap().components(),
        [18, 171, 239, 0]
    );
    assert_eq!(
        table
            .column(1)
            .unwrap()
            .color_float_at(0)
            .unwrap()
            .components(),
        [-0.25, 4.0, 0.5, 0.0]
    );
    assert_eq!(
        table.column(2).unwrap().color32_at(0),
        Some(Color32::default())
    );
    assert_eq!(
        table.column(3).unwrap().color_float_at(0),
        Some(ColorFloat::default())
    );
    assert!(table.column(0).unwrap().str_at(0).is_none());
    assert!(table.column(1).unwrap().color32_at(0).is_none());
    assert_eq!(std::mem::size_of::<Color32>(), 4);
    assert_eq!(std::mem::size_of::<ColorFloat>(), 16);
    assert_eq!(ffi::devcel_rt_api_version(), 1);
    unsafe {
        let mut bytes = Color32::default();
        let mut floats = ColorFloat::default();
        assert_eq!(ffi::devcel_rt_get_color32(&db, 0, 0, 0, &mut bytes), 1);
        assert_eq!(bytes.components(), [18, 171, 239, 0]);
        assert_eq!(ffi::devcel_rt_get_color_float(&db, 0, 0, 1, &mut floats), 1);
        assert_eq!(floats.components(), [-0.25, 4.0, 0.5, 0.0]);
        for (row, col) in [(-1, 0), (1, 0), (0, 1), (0, 99)] {
            assert_eq!(ffi::devcel_rt_get_color32(&db, 0, row, col, &mut bytes), 0);
            assert_eq!(bytes.components(), [18, 171, 239, 0]);
        }
        assert_eq!(
            ffi::devcel_rt_get_color32(&db, 0, 0, 0, std::ptr::null_mut()),
            0
        );
        assert_eq!(
            ffi::devcel_rt_get_color_float(std::ptr::null(), 0, 0, 1, &mut floats),
            0
        );
    }
    for (kind, values) in [
        (
            "Color32",
            vec![
                "",
                "#12abef",
                "[0,0,0]",
                "[0,0,0,256]",
                "[1.0,2,3,4]",
                "[0,0,0,-1]",
                "[true,0,0,0]",
            ],
        ),
        (
            "ColorFloat",
            vec![
                "",
                "[0,0,0]",
                "[0,0,0,-0.01]",
                "[0,0,0,1.00000001]",
                "[1e40,0,0,1]",
                "[NaN,0,0,1]",
                "[0,0,0,1,0]",
            ],
        ),
    ] {
        for raw in values {
            let invalid = bundle(json!([{"name":"v","data_type":kind}]), json!({"v":raw}));
            assert!(
                Snapshot::from_json(&invalid).is_err(),
                "{kind} accepted {raw}"
            );
        }
    }
    assert!(Snapshot::from_json(&bundle(
        json!([{"name":"v","data_type":"Color"}]),
        json!({"v":"#12abef"})
    ))
    .is_err());
}

#[test]
fn invalid_color_same_hash_reload_is_atomic() {
    let dir = std::env::temp_dir().join(format!(
        "devcel-runtime-color-reload-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bundle.json");
    let good = bundle(
        json!([{"name":"c","data_type":"ColorFloat"}]),
        json!({"c":"[-1,8,0.5,0]"}),
    );
    std::fs::write(&path, &good).unwrap();
    let db = Database::open(&path).unwrap();
    std::fs::write(&path, good.replace("[-1,8,0.5,0]", "[1,0,0,2]")).unwrap();
    assert!(db.reload_if_changed().is_err());
    assert_eq!(
        db.load()
            .table(0)
            .unwrap()
            .column(0)
            .unwrap()
            .color_float_at(0)
            .unwrap()
            .components(),
        [-1.0, 8.0, 0.5, 0.0]
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn record_reference_table_requires_uuid_and_current_interface_membership() {
    use devcel_runtime::ffi::*;
    use std::ffi::CString;
    let mut value: serde_json::Value = serde_json::from_str(&bundle(json!([]), json!({}))).unwrap();
    value["tables"][0]["interfaces"] = json!(["damageable"]);
    let mut second = value["tables"][0].clone();
    second["uuid"] = json!("22222222-2222-4222-8222-222222222222");
    second["name"] = json!("props");
    second["interfaces"] = json!([]);
    value["tables"].as_array_mut().unwrap().push(second);
    let input = CString::new(value.to_string()).unwrap();
    let first = CString::new("11111111-1111-4111-8111-111111111111").unwrap();
    let second = CString::new("22222222-2222-4222-8222-222222222222").unwrap();
    let required = CString::new("damageable").unwrap();
    let empty = CString::new("").unwrap();
    let name = CString::new("items").unwrap();
    let row = CString::new("row").unwrap();
    unsafe {
        let db = devcel_rt_open_from_json(input.as_ptr());
        assert!(!db.is_null());
        assert_eq!(
            devcel_rt_record_reference_table(db, first.as_ptr(), required.as_ptr()),
            0
        );
        assert_eq!(
            devcel_rt_record_reference_table(db, second.as_ptr(), required.as_ptr()),
            -1
        );
        assert_eq!(
            devcel_rt_record_reference_table(db, second.as_ptr(), empty.as_ptr()),
            1
        );
        assert_eq!(
            devcel_rt_record_reference_table(db, name.as_ptr(), empty.as_ptr()),
            -1
        );
        assert_eq!(
            devcel_rt_record_reference_table(db, std::ptr::null(), required.as_ptr()),
            -1
        );
        assert_eq!(
            devcel_rt_record_reference_table(std::ptr::null(), first.as_ptr(), required.as_ptr()),
            -1
        );
        assert_eq!(devcel_rt_row_by_uuid(db, 0, row.as_ptr()), 0);
        assert_eq!(devcel_rt_row_by_uuid(db, 1, row.as_ptr()), 0);
        let mut len = -1;
        let id = devcel_rt_row_uuid(db, 0, 0, &mut len);
        assert_eq!(len, 3);
        assert_eq!(std::slice::from_raw_parts(id, len as usize), b"row");
        assert!(!devcel_rt_row_uuid(db, 1, 0, std::ptr::null_mut()).is_null());
        for (table, row) in [(-1, 0), (0, -1), (2, 0), (0, 1)] {
            len = -1;
            assert!(devcel_rt_row_uuid(db, table, row, &mut len).is_null());
            assert_eq!(len, 0);
        }
        len = -1;
        assert!(devcel_rt_row_uuid(std::ptr::null(), 0, 0, &mut len).is_null());
        assert_eq!(len, 0);

        devcel_rt_close(db);
    }
}

#[test]
fn f32_max_decimal_roundtrip_uses_finite_f32_conversion() {
    for raw in [
        "3.4028235e38",
        "340282350000000000000000000000000000000",
        "-3.4028235e38",
    ] {
        Snapshot::from_json(&bundle(
            json!([{"name":"v","data_type":"F32"}]),
            json!({"v":raw}),
        ))
        .unwrap();
    }
    for raw in ["3.4028236e38", "1e39", "NaN", "inf"] {
        assert!(Snapshot::from_json(&bundle(
            json!([{"name":"v","data_type":"F32"}]),
            json!({"v":raw})
        ))
        .is_err());
    }
}

#[test]
fn decoded_defaults_preserve_explicit_values_and_curve_configuration() {
    let columns = json!([
        {"name":"color","data_type":"Color32","default_value":"[1,2,3,4]"},
        {"name":"hdr","data_type":"ColorFloat","default_value":"[-2,4,0,1]"},
        {"name":"n","data_type":"I32","default_value":"42"},
        {"name":"f","data_type":"F64","default_value":"1.5"},
        {"name":"b","data_type":"Boolean","default_value":"true"},
        {"name":"curve","data_type":"Curve","curve_config":{"start_value":10,"end_value":30}}
    ]);
    let mut value: serde_json::Value = serde_json::from_str(&bundle(columns, json!({}))).unwrap();
    value["tables"][0]["records"] = json!([
        {"id":"a","values":{}}, {"id":"b","values":{}},
        {"id":"c","values":{"color":"[9,8,7,6]","hdr":"[0,0,0,0]","n":"","f":"","b":"","curve":""}}
    ]);
    let snap = Snapshot::from_json(&value.to_string()).unwrap();
    let table = snap.table(0).unwrap();
    for row in 0..2 {
        assert_eq!(
            table
                .column(0)
                .unwrap()
                .color32_at(row)
                .unwrap()
                .components(),
            [1, 2, 3, 4]
        );
        assert_eq!(
            table.column(1).unwrap().color_float_at(row).unwrap().r,
            -2.0
        );
        assert_eq!(table.column(2).unwrap().i64_at(row), 42);
        assert_eq!(table.column(3).unwrap().f64_at(row), 1.5);
        assert!(table.column(4).unwrap().bool_at(row));
    }
    assert_eq!(
        table.column(0).unwrap().color32_at(2).unwrap().components(),
        [9, 8, 7, 6]
    );
    assert_eq!(table.column(2).unwrap().i64_at(2), 0);
    assert_eq!(table.column(3).unwrap().f64_at(2), 0.0);
    assert!(!table.column(4).unwrap().bool_at(2));
    for row in 0..3 {
        assert_eq!(
            table.column(5).unwrap().curve_at(row).unwrap().sample(0.5),
            20.0
        );
    }
}

#[test]
fn unused_numeric_defaults_remain_lazy_but_colors_are_always_validated() {
    for (kind, explicit) in [
        ("I32", "1"),
        ("F64", "1"),
        ("Boolean", "true"),
        ("Curve", ""),
    ] {
        let columns = json!([{"name":"v","data_type":kind,"default_value":"invalid"}]);
        assert!(Snapshot::from_json(&bundle(columns.clone(), json!({"v":explicit}))).is_ok());
        assert!(Snapshot::from_json(&bundle(columns, json!({}))).is_err());
    }
    for kind in ["Color32", "ColorFloat"] {
        let text = bundle(
            json!([{"name":"v","data_type":kind,"default_value":"invalid"}]),
            json!({"v":"[1,1,1,1]"}),
        );
        let parsed: devcel_runtime::Bundle = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed.validate().unwrap_err(),
            Snapshot::from_json(&text).unwrap_err()
        );
    }
}
