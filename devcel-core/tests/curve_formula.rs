use devcel_core::formula_context::ProjectFormulaContext;
use devcel_core::{
    ColumnSchema, FormulaEngine, FormulaResult, Project, Record, TableSchema, ValueType,
};
const CURVE: &str = r#"{"points":[{"x":0,"y":10,"mode":"free","outSlope":0,"outLen":0.5},{"x":0.4,"y":80,"mode":"autoLength","inLen":2},{"x":1,"y":110,"mode":"linear"}]}"#;
fn col(name: &str, kind: ValueType, default: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: kind,
        default_value: default.into(),
        ..Default::default()
    }
}
fn value(engine: &mut FormulaEngine<'_>, formula: &str, row: &Record, schema: &TableSchema) -> f64 {
    engine
        .evaluate(formula, "result", row, schema)
        .into_result()
        .unwrap()
        .parse()
        .unwrap()
}
#[test]
fn samples_runtime_curve_with_expressions_defaults_clamping_and_live_edits() {
    let mut schema = TableSchema {
        columns: vec![
            col("growth", ValueType::Curve, CURVE),
            col("current", ValueType::F64, "50"),
            col("minimum", ValueType::I32, "0"),
            col("maximum", ValueType::I32, "100"),
        ],
    };
    let mut row = Record::new();
    let mut engine = FormulaEngine::new();
    let curve = devcel_runtime::curve::Curve::parse(CURVE, None).unwrap();
    for current in [-100.0_f64, 0., 1., 25., 40., 50., 99., 100., 200.] {
        let actual = value(
            &mut engine,
            &format!("=CURVE({current},minimum,maximum,growth)"),
            &row,
            &schema,
        );
        assert!((actual - curve.sample((current / 100.).clamp(0., 1.))).abs() < 1e-9);
    }
    assert!(
        (value(
            &mut engine,
            "=CURVE(current+10,minimum,maximum,IF(1,growth,1/0))",
            &row,
            &schema
        ) - curve.sample(0.6))
        .abs()
            < 1e-9
    );
    row.values.insert("current".into(), "75".into());
    assert!(
        (value(&mut engine, "=CURVE(current,0,100,growth)", &row, &schema) - curve.sample(0.75))
            .abs()
            < 1e-9
    );
    schema.columns[0].curve_config = Some(devcel_core::types::CurveConfig {
        start_value: 20.,
        end_value: 200.,
    });
    assert_eq!(
        value(&mut engine, "=CURVE(100,0,100,growth)", &row, &schema),
        200.
    );
    row.values.insert(
        "growth".into(),
        r#"{"points":[{"x":0,"y":7,"mode":"constant"},{"x":1,"y":9,"mode":"linear"}]}"#.into(),
    );
    schema.columns[0].curve_config = None;
    assert_eq!(
        value(&mut engine, "=CURVE(50,0,100,growth)", &row, &schema),
        7.
    );
    assert_eq!(
        value(&mut engine, "=CURVE(100,0,100,growth)", &row, &schema),
        9.
    );
    schema.columns[0].default_value.clear();
    row.values.clear();
    assert!((value(&mut engine, "=CURVE(50,0,100,growth)", &row, &schema) - 0.5).abs() < 1e-9);
    assert!(
        (value(&mut engine, "=CURVE(0,-1e308,1e308,growth)", &row, &schema) - 0.5).abs() < 1e-9
    );
}
#[test]
fn rejects_invalid_inputs_and_propagates_errors_without_fallback() {
    let mut schema = TableSchema {
        columns: vec![col("growth", ValueType::Curve, CURVE)],
    };
    let row = Record::new();
    let mut engine = FormulaEngine::new();
    for formula in [
        "=CURVE(1,0,0,growth)",
        "=CURVE(1,2,1,growth)",
        "=CURVE(1,0,2)",
        "=CURVE(1,0,2,3)",
        "=CURVE(1,0,2,\"\")",
        "=CURVE(\"NaN\",0,2,growth)",
        "=CURVE(1,0,1e309,growth)",
        "=CURVE(1/0,0,2,growth)",
        "=CURVE(1,0,2,missing)",
    ] {
        assert!(
            matches!(
                engine.evaluate(formula, "result", &row, &schema),
                FormulaResult::Error(_)
            ),
            "{formula}"
        );
    }
    for invalid in [
        "bad",
        r#"{"points":[]}"#,
        r#"{"points":[{"x":0,"y":1,"mode":"bad"},{"x":1,"y":2,"mode":"linear"}]}"#,
        "=growth",
    ] {
        schema.columns[0].default_value = invalid.into();
        assert!(matches!(
            engine.evaluate("=CURVE(1,0,2,growth)", "result", &row, &schema),
            FormulaResult::Error(_)
        ));
    }
}
#[test]
fn lookup_preserves_curve_endpoint_settings_and_unopened_dependencies() {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("CurveFormula", dir.path().to_str().unwrap(), "", "#123456")
            .unwrap();
    let path = project.create_table("curves.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    {
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.metadata.data_name = "Curves".into();
        let mut curve = col("growth", ValueType::Curve, CURVE);
        curve.curve_config = Some(devcel_core::types::CurveConfig {
            start_value: 3.,
            end_value: 500.,
        });
        table.data.schema.columns = vec![col("id", ValueType::String, ""), curve];
        let mut row = Record::new();
        row.values.insert("id".into(), "hero".into());
        table.data.records.push(row);
        Project::save_table(table).unwrap();
    }
    let output = col("result", ValueType::F64, "");
    let row = Record::new();
    let schema = TableSchema { columns: vec![] };
    for loaded in [true, false] {
        if !loaded {
            project.tables_data.remove(&path);
        }
        let context = ProjectFormulaContext::new(&project, Some(0)).unwrap();
        let result = context
            .evaluate_cell(
                "=CURVE(100,0,100,LOOKUP(\"Curves\",\"id\",\"hero\",\"growth\"))",
                &output,
                &row,
                &schema,
                "target",
            )
            .into_result()
            .unwrap();
        assert_eq!(result.parse::<f64>().unwrap(), 500.);
        assert!(matches!(
            context.evaluate_cell(
                "=CURVE(100,0,100,LOOKUP(\"Curves\",\"id\",\"missing\",\"growth\"))",
                &output,
                &row,
                &schema,
                "target"
            ),
            FormulaResult::Error(_)
        ));
    }
}
#[test]
fn full_minimal_and_streaming_export_evaluate_hidden_curves_and_reject_errors() {
    use devcel_core::json_export::{
        export_runtime_bundle_to_file_with_validation, export_runtime_bundle_with_validation,
        ExportMode,
    };
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("CurveExport", dir.path().to_str().unwrap(), "", "#123456")
            .unwrap();
    let path = project.create_table("values.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    {
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.metadata.data_name = "Values".into();
        let mut curve = col("growth", ValueType::Curve, CURVE);
        curve.min_version = 3;
        table.data.schema.columns = vec![
            curve,
            col("result", ValueType::F64, "=CURVE(50,0,100,growth)"),
        ];
        table.data.records.push(Record::new());
        Project::save_table(table).unwrap();
    }
    let expected = devcel_runtime::curve::Curve::parse(CURVE, None)
        .unwrap()
        .sample(0.5);
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        let bundle =
            export_runtime_bundle_with_validation(&mut project, mode, Some(0), false).unwrap();
        let tables = serde_json::to_value(&bundle.tables).unwrap();
        let table = tables
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "Values")
            .unwrap();
        assert_eq!(table["columns"].as_array().unwrap().len(), 1);
        let result = table["records"][0]["values"]["result"]
            .as_str()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        assert!((result - expected).abs() < 1e-9);
        let destination = dir.path().join("runtime.json");
        let summary = export_runtime_bundle_to_file_with_validation(
            &mut project,
            mode,
            Some(0),
            false,
            &destination,
        )
        .unwrap();
        let streamed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&destination).unwrap()).unwrap();
        assert_eq!(streamed["tables"], tables);
        assert_eq!(summary.manifest.content_hash, bundle.manifest.content_hash);
    }
    project
        .tables_data
        .get_mut(&path)
        .unwrap()
        .data
        .schema
        .columns[1]
        .default_value = "=CURVE(50,0,0,growth)".into();
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        assert!(export_runtime_bundle_with_validation(&mut project, mode, Some(0), false).is_err());
        assert!(export_runtime_bundle_to_file_with_validation(
            &mut project,
            mode,
            Some(0),
            false,
            dir.path().join("invalid.json")
        )
        .is_err());
    }
}
#[test]
fn manual_linear_examples_and_many_rows() {
    let schema = TableSchema {
        columns: vec![
            col(
                "growth",
                ValueType::Curve,
                r#"{"points":[{"x":0,"y":10,"mode":"linear"},{"x":1,"y":110,"mode":"linear"}]}"#,
            ),
            col("current", ValueType::F64, "50"),
        ],
    };
    let mut row = Record::new();
    let mut engine = FormulaEngine::new();
    for (current, expected) in [(0, 10.), (50, 60.), (100, 110.), (150, 110.)] {
        assert!(
            (value(
                &mut engine,
                &format!("=CURVE({current},0,100,growth)"),
                &row,
                &schema
            ) - expected)
                .abs()
                < 1e-9
        );
    }
    for index in 0..10_000 {
        row.values
            .insert("current".into(), (index % 101).to_string());
        let actual = value(&mut engine, "=CURVE(current,0,100,growth)", &row, &schema);
        assert!((actual - (10. + (index % 101) as f64)).abs() < 1e-9);
    }
}
