//! Integer formula outputs, explicit rounding and runtime CURVE regression coverage.
use devcel_core::{ColumnSchema, FormulaEngine, Record, TableSchema, ValueType};

fn evaluate(kind: ValueType, expression: &str) -> Result<String, devcel_core::FormulaError> {
    let column = ColumnSchema {
        data_name: "result".into(),
        data_type: kind,
        ..Default::default()
    };
    FormulaEngine::new()
        .evaluate_column(
            expression,
            &column,
            &Record::new(),
            &TableSchema { columns: vec![] },
        )
        .into_result()
}

#[test]
fn formula_results_round_before_checking_every_integer_type() {
    for kind in [
        ValueType::I8,
        ValueType::I16,
        ValueType::I32,
        ValueType::I64,
        ValueType::U8,
        ValueType::U16,
        ValueType::U32,
        ValueType::U64,
    ] {
        for (expression, expected) in [
            ("=19.8", "20"),
            ("=2.5", "3"),
            ("=2.49", "2"),
            ("=0.5", "1"),
            ("=-0.4", "0"),
            ("=-0.0", "0"),
        ] {
            assert_eq!(
                evaluate(kind.clone(), expression).unwrap(),
                expected,
                "{kind:?}: {expression}"
            );
        }
    }
    for kind in [
        ValueType::I8,
        ValueType::I16,
        ValueType::I32,
        ValueType::I64,
    ] {
        for (expression, expected) in [("=-2.5", "-3"), ("=-2.49", "-2"), ("=-0.5", "-1")] {
            assert_eq!(evaluate(kind.clone(), expression).unwrap(), expected);
        }
    }
    for kind in [
        ValueType::U8,
        ValueType::U16,
        ValueType::U32,
        ValueType::U64,
    ] {
        assert!(evaluate(kind, "=-0.5").is_err());
    }
    for (kind, good, expected, bad) in [
        (ValueType::I8, "=127.4", "127", "=127.5"),
        (ValueType::I8, "=-128.4", "-128", "=-128.5"),
        (ValueType::U8, "=255.4", "255", "=255.5"),
        (ValueType::I16, "=32767.4", "32767", "=32767.5"),
        (ValueType::U16, "=65535.4", "65535", "=65535.5"),
        (
            ValueType::I32,
            "=2147483647.4",
            "2147483647",
            "=2147483647.5",
        ),
        (
            ValueType::U32,
            "=4294967295.4",
            "4294967295",
            "=4294967295.5",
        ),
    ] {
        assert_eq!(evaluate(kind.clone(), good).unwrap(), expected);
        assert!(evaluate(kind, bad).is_err(), "{bad}");
    }
}

#[test]
fn exact_large_integers_and_float_boundaries_remain_distinct() {
    for (kind, value) in [
        (ValueType::I64, "9223372036854775807"),
        (ValueType::I64, "-9223372036854775808"),
        (ValueType::U64, "18446744073709551615"),
        (ValueType::U64, "9007199254740993"),
    ] {
        assert_eq!(evaluate(kind, &format!("={value}")).unwrap(), value);
    }
    for (kind, expression) in [
        (ValueType::I64, "=9223372036854775808"),
        (ValueType::U64, "=18446744073709551616"),
        (ValueType::I64, "=9223372036854775808.0"),
        (ValueType::U64, "=18446744073709551616.0"),
        (ValueType::I64, "=1e100"),
        (ValueType::I64, "=-1e100"),
        (ValueType::I64, "=1e309"),
        (ValueType::I64, "=\"NaN\""),
    ] {
        assert!(evaluate(kind, expression).is_err(), "{expression}");
    }
    assert_eq!(
        evaluate(ValueType::F64, "=19.999999999990905").unwrap(),
        "19.999999999990905"
    );
    assert_eq!(
        evaluate(ValueType::I64, "=-9223372036854775808.0").unwrap(),
        "-9223372036854775808"
    );
    for input in [
        "NaN",
        "inf",
        "-inf",
        "1e100",
        "-1e100",
        "170141183460469231731687303715884105728",
    ] {
        assert!(
            ValueType::I64.cast_numeric_value(input).warning.is_some(),
            "{input}"
        );
    }
}

#[test]
fn explicit_rounding_works_inside_and_outside_typed_collections() {
    for (function, positive, negative) in [
        ("ROUND", "3", "-3"),
        ("TRUNC", "2", "-2"),
        ("FLOOR", "2", "-3"),
        ("CEIL", "3", "-2"),
    ] {
        assert_eq!(
            evaluate(ValueType::I32, &format!("={function}(2.5)")).unwrap(),
            positive
        );
        assert_eq!(
            evaluate(ValueType::I32, &format!("={function}(-2.5)")).unwrap(),
            negative
        );
        for integer in ["9007199254740993", "18446744073709551615"] {
            assert_eq!(
                evaluate(ValueType::U64, &format!("={function}({integer})")).unwrap(),
                integer
            );
        }
    }
    for function in ["TRUNC", "FLOOR", "CEIL"] {
        for arguments in ["", "1,2", "\"bad\"", "\"NaN\"", "1/0"] {
            assert!(evaluate(ValueType::F64, &format!("={function}({arguments})")).is_err());
        }
    }
    assert_eq!(
        evaluate(
            ValueType::I32,
            "=REDUCE(MAP([2.5,-2.5],x=>TRUNC(x)),0,(a,x)=>a+x)"
        )
        .unwrap(),
        "0"
    );
    assert_eq!(
        evaluate(
            ValueType::I32,
            "=REDUCE(MAP([2.5,-2.5],x=>FLOOR(x)),0,(a,x)=>a+x)"
        )
        .unwrap(),
        "-1"
    );
    assert_eq!(
        evaluate(
            ValueType::I32,
            "=REDUCE(MAP([2.5,-2.5],x=>CEIL(x)),0,(a,x)=>a+x)"
        )
        .unwrap(),
        "1"
    );
}

#[test]
fn curve_exact_solutions_do_not_drift_and_nonlinear_shapes_remain_curved() {
    use devcel_runtime::curve::{Curve, CurveConfig};
    let config = CurveConfig {
        start_value: 10.0,
        end_value: 30.0,
    };
    assert_eq!(Curve::parse("", Some(&config)).unwrap().sample(0.5), 20.0);
    for mode in ["auto", "linear", "free"] {
        let source = format!(
            r#"{{"points":[{{"x":0,"y":10,"mode":"{mode}"}},{{"x":1,"y":30,"mode":"{mode}"}}]}}"#
        );
        let curve = Curve::parse(&source, None).unwrap();
        assert_eq!(curve.sample(0.5), 20.0);
        assert_eq!(curve.sample(0.0), 10.0);
        assert_eq!(curve.sample(1.0), 30.0);
    }
    let curve = Curve::parse(r#"{"points":[{"x":0,"y":10,"mode":"free","outSlope":0},{"x":1,"y":30,"mode":"free","inSlope":0}]}"#, None).unwrap();
    assert_eq!(curve.sample(0.5), 20.0);
    assert!((curve.sample(0.25) - 13.125).abs() < 1e-9);
    let curve = Curve::parse(r#"{"points":[{"x":0,"y":10,"mode":"constant"},{"x":0.4,"y":20,"mode":"linear"},{"x":1,"y":30,"mode":"linear"}]}"#, None).unwrap();
    assert_eq!(curve.sample(0.399), 10.0);
    assert_eq!(curve.sample(0.4), 20.0);
}

#[test]
fn saved_formula_defaults_export_identically_to_full_minimal_and_runtime() {
    use devcel_core::json_export::{export_runtime_bundle_with_validation, ExportMode};
    use devcel_core::Project;
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Rounding", dir.path().to_str().unwrap(), "", "#123456").unwrap();
    let path = project.create_table("values.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    let cases = [
        ("nearest", ValueType::I32, "=19.8", "20"),
        ("positive", ValueType::I32, "=2.5", "3"),
        ("negative", ValueType::I32, "=-2.5", "-3"),
        ("truncated", ValueType::I32, "=TRUNC(-2.5)", "-2"),
        ("floored", ValueType::I32, "=FLOOR(-2.5)", "-3"),
        ("ceiled", ValueType::I32, "=CEIL(-2.5)", "-2"),
        ("curve_i", ValueType::I32, "=CURVE(0.5,0,1,growth)", "20"),
        ("curve_f", ValueType::F64, "=CURVE(0.5,0,1,growth)", "20"),
        (
            "maximum",
            ValueType::U64,
            "=18446744073709551615",
            "18446744073709551615",
        ),
    ];
    {
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.metadata.data_name = "Values".into();
        table.data.schema.columns = cases
            .iter()
            .map(|(name, kind, formula, _)| ColumnSchema {
                data_name: (*name).into(),
                display_name: (*name).into(),
                data_type: kind.clone(),
                default_value: (*formula).into(),
                ..Default::default()
            })
            .collect();
        table.data.schema.columns.push(ColumnSchema {
            data_name: "growth".into(),
            data_type: ValueType::Curve,
            curve_config: Some(devcel_core::types::CurveConfig {
                start_value: 10.0,
                end_value: 30.0,
            }),
            ..Default::default()
        });
        table.data.records.push(Record::new());
        Project::save_table(table).unwrap();
    }
    project.tables_data.remove(&path);
    project.load_table(&path).unwrap();
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        let bundle =
            export_runtime_bundle_with_validation(&mut project, mode, Some(0), false).unwrap();
        let json = serde_json::to_string(&bundle).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let table = parsed["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "Values")
            .unwrap();
        for (name, _, _, expected) in &cases {
            assert_eq!(table["records"][0]["values"][name], *expected);
        }
        let runtime = devcel_runtime::Snapshot::from_json(&json).unwrap();
        let table = runtime
            .table(runtime.table_index("Values").unwrap())
            .unwrap();
        for (name, _, _, expected) in &cases[..8] {
            let column = table.column(table.column_index(name).unwrap()).unwrap();
            assert_eq!(column.f64_at(0), expected.parse::<f64>().unwrap());
        }
        assert_eq!(
            table
                .column(table.column_index("growth").unwrap())
                .unwrap()
                .curve_at(0)
                .unwrap()
                .sample(0.5),
            20.0
        );
    }
}
