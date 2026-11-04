//! End-to-end regressions for precision-typed, straight-alpha color formulas.
use devcel_core::formula_context::ProjectFormulaContext;
use devcel_core::{
    ColumnSchema, FormulaEngine, FormulaResult, Project, Record, TableSchema, ValueType,
};

fn column(name: &str, kind: ValueType, default: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: kind,
        default_value: default.into(),
        ..Default::default()
    }
}
fn evaluate(formula: &str) -> Result<String, devcel_core::FormulaError> {
    FormulaEngine::new()
        .evaluate(
            formula,
            "result",
            &Record::new(),
            &TableSchema { columns: vec![] },
        )
        .into_result()
}
fn channels(formula: &str) -> [f64; 4] {
    serde_json::from_str(&evaluate(formula).unwrap()).unwrap()
}
fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-6 * expected.abs().max(1.0),
        "{actual} != {expected}"
    );
}

#[test]
fn constructors_channels_and_explicit_precision_conversion() {
    assert_eq!(evaluate("=COLOR32(128,0,255)").unwrap(), "[128,0,255,255]");
    assert_eq!(channels("=COLORFLOAT(-2,4,0,0)"), [-2., 4., 0., 0.]);
    assert_eq!(channels("=COLORFLOAT(0,0,0)"), [0., 0., 0., 1.]);
    assert_eq!(evaluate("=COLOR32(128,0,255,64).r").unwrap(), "128");
    assert_eq!(evaluate("=COLOR32(128,0,255,64).a").unwrap(), "64");
    close(
        evaluate("=COLORFLOAT(-2,4,0,0.25).a")
            .unwrap()
            .parse()
            .unwrap(),
        0.25,
    );
    let normalized = channels("=COLOR_TO_FLOAT(COLOR32(128,128,128,64))");
    close(normalized[0], 128.0 / 255.0);
    close(normalized[3], 64.0 / 255.0);
    let linear = channels("=SRGB_TO_LINEAR(COLOR_TO_FLOAT(COLOR32(128,128,128,64)))");
    close(linear[0], 0.2158605);
    close(linear[3], normalized[3]);
    let encoded = channels("=LINEAR_TO_SRGB(COLORFLOAT(0.2158605,0.2158605,0.2158605,0.25))");
    close(encoded[0], 128.0 / 255.0);
    close(encoded[3], 0.25);
    assert_eq!(
        evaluate("=COLOR_TO_BYTE(COLORFLOAT(0.5,0,1,0.5))").unwrap(),
        "[128,0,255,128]"
    );
    assert_eq!(
        evaluate("=COLOR_TO_BYTE(COLOR_TO_FLOAT(COLOR32(128,23,255,64)))").unwrap(),
        "[128,23,255,64]"
    );
}

#[test]
fn transfer_functions_preserve_hdr_negative_rgb_and_straight_alpha() {
    let decoded = channels("=SRGB_TO_LINEAR(COLORFLOAT(-0.5,0.04045,2,0))");
    close(decoded[0], -0.21404114);
    close(decoded[1], 0.04045 / 12.92);
    assert!(decoded[2] > 1.0);
    assert_eq!(decoded[3], 0.0);
    let encoded = channels("=LINEAR_TO_SRGB(COLORFLOAT(-0.0031308,0.0031308,2,0.25))");
    close(encoded[0], -0.0031308 * 12.92);
    close(encoded[1], 0.0031308 * 12.92);
    assert!(encoded[2] > 1.0);
    assert_eq!(encoded[3], 0.25);
    assert_eq!(
        channels("=GAMMA_DECODE(COLORFLOAT(-2,0.5,4,0.25),2)"),
        [-4., 0.25, 16., 0.25]
    );
    assert_eq!(
        channels("=GAMMA_ENCODE(COLORFLOAT(-4,0.25,16,0),2)"),
        [-2., 0.5, 4., 0.]
    );
    assert_eq!(
        channels("=EXPOSURE(COLORFLOAT(-2,0.5,4,0.25),2)"),
        [-8., 2., 16., 0.25]
    );
    assert_eq!(
        channels("=LERP_COLOR(COLORFLOAT(-2,0,4,0),COLORFLOAT(2,2,8,1),0.5)"),
        [0., 1., 6., 0.5]
    );
    close(
        channels("=LERP_COLOR(COLOR32(0,0,0,0),COLOR32(255,255,255,255),0.5)")[0],
        0.5,
    );
    assert_eq!(
        channels("=CLAMP_COLOR(COLORFLOAT(-2,0.5,4,0))"),
        [0., 0.5, 1., 0.]
    );
    assert_eq!(
        channels("=CLAMP_COLOR(COLORFLOAT(-2,0.5,4,0.25),-1,2)"),
        [-1., 0.5, 2., 0.25]
    );
    assert_eq!(
        evaluate("=COLOR_TO_BYTE(CLAMP_COLOR(COLORFLOAT(-2,0.5,4,0)))").unwrap(),
        "[0,128,255,0]"
    );
}

#[test]
fn invalid_channels_arguments_overflow_and_implicit_conversions_are_errors() {
    for formula in [
        "=COLOR32(-1,0,0)",
        "=COLOR32(256,0,0)",
        "=COLOR32(0.5,0,0)",
        "=COLOR32(0,0)",
        "=COLORFLOAT(1,2)",
        "=COLORFLOAT(0,0,0,1.000000001)",
        "=COLORFLOAT(0,0,0,-0.000000001)",
        "=COLORFLOAT(1e39,0,0)",
        "=COLORFLOAT(0,0,0,0/0)",
        "=COLORFLOAT(\"1\",0,0)",
        "=COLOR_TO_BYTE(COLORFLOAT(-0.1,0,0))",
        "=COLOR_TO_BYTE(COLORFLOAT(1.01,0,0))",
        "=COLOR_TO_FLOAT(\"[128,0,0,255]\")",
        "=GAMMA_DECODE(COLORFLOAT(1,1,1),0)",
        "=GAMMA_ENCODE(COLORFLOAT(1,1,1),-1)",
        "=GAMMA_DECODE(COLORFLOAT(1e30,1,1),2)",
        "=EXPOSURE(COLORFLOAT(1,1,1),1024)",
        "=EXPOSURE(COLORFLOAT(1e30,0,0),100)",
        "=LERP_COLOR(COLOR32(1,2,3),COLORFLOAT(1,2,3),0.5)",
        "=LERP_COLOR(COLORFLOAT(0,0,0,0),COLORFLOAT(1,1,1,1),2)",
        "=CLAMP_COLOR(COLORFLOAT(1,1,1),1,0)",
        "=CLAMP_COLOR(COLORFLOAT(1,1,1),1)",
        "=COLOR32(1,2,3).x",
        "=COLOR32(1,2,3)+\"x\"",
        "=COLORFLOAT(1,2,3)<COLORFLOAT(2,3,4)",
        "=CONCAT(COLOR32(1,2,3))",
        r#"="${COLOR32(1,2,3)}""#,
        r#"=LET(c,COLORFLOAT(1,2,3),"${c}")"#,
        "=SUM(COLORFLOAT(1,2,3))",
        "=IF(COLOR32(1,2,3),1,0)",
    ] {
        assert!(evaluate(formula).is_err(), "{formula}");
    }
}

#[test]
fn collections_records_optional_comparison_and_grouping_keep_color_kinds() {
    for (formula, expected) in [
        ("=SAME(COLOR32(1,2,3),COLOR32(1,2,3))", "true"),
        ("=COLOR32(1,2,3)==COLOR32(1,2,3)", "true"),
        ("=SAME(COLOR32(1,2,3),COLORFLOAT(1,2,3))", "false"),
        ("=COLOR32(1,2,3)==\"[1,2,3,255]\"", "false"),
        ("=LET(c,{tint:COLOR32(1,2,3)},c.tint.g)", "2"),
        ("=REDUCE(MAP([COLOR32(1,2,3),COLOR32(4,5,6)],c=>c.r),0,(a,x)=>a+x)", "5"),
        ("=REDUCE([COLOR32(1,2,3)],COLOR32(0,0,0),(a,x)=>x)", "[1,2,3,255]"),
        ("=REDUCE(GROUPBY([COLORFLOAT(0,1,2,0),COLORFLOAT(-0.0,1,2,0),COLORFLOAT(1,1,2,0)],c=>c),0,(n,g)=>n+1)", "2"),
        ("=REDUCE(JOIN([{id:1},{id:2}],[{id:1,tint:COLOR32(7,8,9)}],(l,r)=>SAME(l.id,r.id),\"LEFT\"),0,(a,p)=>a+IF(HASROW(p.right),p.right.tint.r,0))", "7"),
    ] {
        assert_eq!(evaluate(formula).unwrap(), expected, "{formula}");
    }
    for formula in [
        "=REDUCE([COLOR32(1,2,3),COLORFLOAT(1,2,3)],0,(a,c)=>a)",
        "=REDUCE([1],COLOR32(1,2,3),(a,x)=>COLORFLOAT(1,2,3))",
        "=REDUCE(GROUPBY([1,2],x=>IF(x==1,COLOR32(1,2,3),COLORFLOAT(1,2,3))),0,(n,g)=>n+1)",
    ] {
        assert!(evaluate(formula).is_err(), "{formula}");
    }
}

#[test]
fn same_row_references_defaults_and_destination_assignments_are_typed() {
    let schema = TableSchema {
        columns: vec![
            column("byte", ValueType::Color32, "[128,0,255,0]"),
            column("hdr", ValueType::ColorFloat, "[-2,4,0,0]"),
            column("white", ValueType::Color32, ""),
            column("white_float", ValueType::ColorFloat, ""),
        ],
    };
    let row = Record::new();
    let mut engine = FormulaEngine::new();
    for (formula, kind, expected) in [
        ("=byte", ValueType::Color32, "[128,0,255,0]"),
        ("=white", ValueType::Color32, "[255,255,255,255]"),
        ("=hdr.r", ValueType::F64, "-2"),
        ("=white_float.a", ValueType::F64, "1"),
        (
            "=IF(1,byte,COLOR32(0,0,0))",
            ValueType::Color32,
            "[128,0,255,0]",
        ),
    ] {
        let output = column("result", kind, "");
        assert_eq!(
            engine
                .evaluate_column(formula, &output, &row, &schema)
                .into_result()
                .unwrap(),
            expected
        );
    }
    for (formula, kind) in [
        ("=byte", ValueType::String),
        ("=byte", ValueType::ColorFloat),
        ("=hdr", ValueType::Color32),
        ("=\"[1,2,3,4]\"", ValueType::Color32),
        ("=COLOR32(1,2,3)", ValueType::String),
        ("=1", ValueType::ColorFloat),
    ] {
        assert!(
            matches!(
                engine.evaluate_column(formula, &column("result", kind, ""), &row, &schema),
                FormulaResult::Error(_)
            ),
            "{formula}"
        );
    }
    // A destination supplied separately from an empty schema must also reject text.
    assert!(engine
        .evaluate_column(
            "=\"[1,2,3,4]\"",
            &column("result", ValueType::Color32, ""),
            &row,
            &TableSchema { columns: vec![] }
        )
        .into_result()
        .is_err());
}

#[test]
fn lookup_table_reference_and_hidden_color_dependencies_work_loaded_or_unopened() {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("ColorFormula", dir.path().to_str().unwrap(), "", "#123456")
            .unwrap();
    let path = project.create_table("colors.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    let (table_uuid, row_uuid) = {
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.metadata.data_name = "Colors".into();
        let mut hidden = column(
            "tint",
            ValueType::ColorFloat,
            "=EXPOSURE(COLORFLOAT(-0.5,1,2,0),1)",
        );
        hidden.min_version = 3;
        table.data.schema.columns = vec![
            column("id", ValueType::String, "hero"),
            hidden,
            column("count", ValueType::I32, "7"),
            column("label", ValueType::String, "hello"),
        ];
        let row = Record::new();
        let identity = (table.data.uuid.clone(), row.uuid.clone());
        table.data.records.push(row);
        Project::save_table(table).unwrap();
        identity
    };
    let mut reference = column("source", ValueType::Reference, &row_uuid);
    reference.reference_config = Some(devcel_core::ReferenceConfig {
        target_table_uuid: table_uuid,
        display_column_uuid: None,
    });
    let schema = TableSchema {
        columns: vec![reference],
    };
    let row = Record::new();
    for loaded in [true, false] {
        if !loaded {
            project.tables_data.remove(&path);
        }
        let context = ProjectFormulaContext::new(&project, Some(0)).unwrap();
        for formula in [
            "=LOOKUP(\"Colors\",\"id\",\"hero\",\"tint\")",
            "=source.tint",
            "=REDUCE(TABLE(\"Colors\"),COLORFLOAT(0,0,0),(a,r)=>r.tint)",
        ] {
            let result = context
                .evaluate_cell(
                    formula,
                    &column("result", ValueType::ColorFloat, ""),
                    &row,
                    &schema,
                    "target",
                )
                .into_result()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<[f64; 4]>(&result).unwrap(),
                [-1., 2., 4., 0.],
                "{formula}"
            );
            assert!(context
                .evaluate_cell(
                    formula,
                    &column("result", ValueType::String, ""),
                    &row,
                    &schema,
                    "target"
                )
                .into_result()
                .is_err());
        }
        // A color returned by LOOKUP stays typed inside interpolation, even
        // when the caller schema has no local color columns.
        assert!(context
            .evaluate_cell(
                r#"="${LOOKUP(""Colors"",""id"",""hero"",""tint"")}""#,
                &column("result", ValueType::String, ""),
                &row,
                &schema,
                "target"
            )
            .into_result()
            .is_err());
        let mixed_queries = context.evaluate_cell(
            r#"=COLORFLOAT(COUNTIF("Colors","id","hero"),SUMIF("Colors","id","hero","count"),LOOKUP("Colors","id","hero","count"))"#,
            &column("result", ValueType::ColorFloat, ""), &row, &schema, "target"
        ).into_result().unwrap();
        assert_eq!(
            serde_json::from_str::<[f64; 4]>(&mixed_queries).unwrap(),
            [1., 7., 7., 1.]
        );
        for (formula, kind, expected) in [
            ("=source.tint.g", ValueType::F64, "2"),
            (
                "=LOOKUP(\"Colors\",\"id\",\"hero\",\"count\")+1",
                ValueType::I32,
                "8",
            ),
            (
                "=CONCAT(LOOKUP(\"Colors\",\"id\",\"hero\",\"label\"),\"!\")",
                ValueType::String,
                "hello!",
            ),
        ] {
            assert_eq!(
                context
                    .evaluate_cell(
                        formula,
                        &column("result", kind, ""),
                        &row,
                        &schema,
                        "target"
                    )
                    .into_result()
                    .unwrap(),
                expected
            );
        }
    }
}

#[test]
fn full_minimal_streaming_runtime_preserve_row_specific_color_formulas() {
    use devcel_core::json_export::{
        export_runtime_bundle_to_file_with_validation, export_runtime_bundle_with_validation,
        ExportMode,
    };
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("ColorExport", dir.path().to_str().unwrap(), "", "#123456")
            .unwrap();
    let path = project.create_table("colors.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    {
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.metadata.data_name = "Colors".into();
        let mut hidden = column("source", ValueType::ColorFloat, "=COLORFLOAT(-0.5,1,2,0)");
        hidden.min_version = 3;
        table.data.schema.columns = vec![
            hidden,
            column("ev", ValueType::F64, "0"),
            column("hdr", ValueType::ColorFloat, "=EXPOSURE(source,ev)"),
            column(
                "byte",
                ValueType::Color32,
                "=COLOR_TO_BYTE(CLAMP_COLOR(hdr))",
            ),
            column(
                "srgb",
                ValueType::ColorFloat,
                "=COLOR_TO_FLOAT(COLOR32(128,128,128,64))",
            ),
            column("linear", ValueType::ColorFloat, "=SRGB_TO_LINEAR(srgb)"),
        ];
        table.data.records.push(Record::new());
        let mut row = Record::new();
        row.set_value("ev", "1".into());
        table.data.records.push(row);
        Project::save_table(table).unwrap();
    }
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        let bundle =
            export_runtime_bundle_with_validation(&mut project, mode, Some(0), false).unwrap();
        let json = serde_json::to_string(&bundle).unwrap();
        let snapshot = devcel_runtime::Snapshot::from_json(&json).unwrap();
        let table = snapshot
            .table(snapshot.table_index("Colors").unwrap())
            .unwrap();
        assert!(table.column_index("source").is_none());
        let hdr = table.column(table.column_index("hdr").unwrap()).unwrap();
        assert_eq!(
            hdr.color_float_at(0).unwrap().components(),
            [-0.5, 1., 2., 0.]
        );
        assert_eq!(
            hdr.color_float_at(1).unwrap().components(),
            [-1., 2., 4., 0.]
        );
        assert!(hdr.str_at(0).is_none());
        assert!(hdr.color32_at(0).is_none());
        let byte = table.column(table.column_index("byte").unwrap()).unwrap();
        assert_eq!(byte.color32_at(0).unwrap().components(), [0, 255, 255, 0]);
        assert_eq!(byte.color32_at(1).unwrap().components(), [0, 255, 255, 0]);
        let srgb = table
            .column(table.column_index("srgb").unwrap())
            .unwrap()
            .color_float_at(0)
            .unwrap();
        let linear = table
            .column(table.column_index("linear").unwrap())
            .unwrap()
            .color_float_at(0)
            .unwrap();
        close(srgb.r.into(), 128.0 / 255.0);
        close(linear.r.into(), 0.2158605);
        assert_eq!(srgb.a, linear.a);
        let destination = dir.path().join("runtime.json");
        let summary = export_runtime_bundle_to_file_with_validation(
            &mut project,
            mode,
            Some(0),
            false,
            &destination,
        )
        .unwrap();
        let streamed = std::fs::read_to_string(&destination).unwrap();
        assert_eq!(summary.manifest.content_hash, bundle.manifest.content_hash);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&streamed).unwrap()["tables"],
            serde_json::to_value(&bundle.tables).unwrap()
        );
        devcel_runtime::Snapshot::from_json(&streamed).unwrap();
    }
    project
        .tables_data
        .get_mut(&path)
        .unwrap()
        .data
        .schema
        .columns[2]
        .default_value = "=COLOR32(1,2,3)".into();
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        for allow_invalid in [false, true] {
            assert!(export_runtime_bundle_with_validation(
                &mut project,
                mode,
                Some(0),
                allow_invalid
            )
            .is_err());
            let destination = dir.path().join("preserved.json");
            std::fs::write(&destination, "preserve this file").unwrap();
            assert!(export_runtime_bundle_to_file_with_validation(
                &mut project,
                mode,
                Some(0),
                allow_invalid,
                &destination
            )
            .is_err());
            assert_eq!(
                std::fs::read_to_string(&destination).unwrap(),
                "preserve this file"
            );
        }
    }
}
