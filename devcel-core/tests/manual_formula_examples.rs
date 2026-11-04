//! Integration checks for manual formulas and expected results using the actual engine.
//! Run: cargo test --locked -p devcel-core --test manual_formula_examples -- --nocapture
//! Does not validate UI interaction or presentation.
use devcel_core::formula_context::ProjectFormulaContext;
use devcel_core::{
    ColumnSchema, FormulaEngine, FormulaResult, Project, Record, TableSchema, ValueType,
};
fn col(name: &str, kind: ValueType, default: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: kind,
        default_value: default.into(),
        ..Default::default()
    }
}
#[test]
fn manual_formula_examples_match_current_engine() {
    let mut n = 0;
    let mut engine = FormulaEngine::new();
    let mut schema = TableSchema {
        columns: vec![
            col("price", ValueType::I32, "120"),
            col("quantity", ValueType::I32, "3"),
            col("empty_text", ValueType::String, ""),
            col("empty_num", ValueType::I32, ""),
            col("empty_bool", ValueType::Boolean, ""),
            col("total", ValueType::I32, "=price*quantity"),
            col("label", ValueType::String, "=\"\""),
        ],
    };
    let mut record = Record::new();
    for (expr, expected) in [
        ("=true", "true"),
        ("=false", "false"),
        ("=TrUe", "true"),
        ("=FaLsE", "false"),
        ("=SUM(10,20,30)", "60"),
        ("=SUM(10,\"20\",\"x\",\"\")", "30"),
        ("=SUM(\"x\")", "0"),
        ("=AVG(10,20,30)", "20"),
        ("=AVERAGE(10,\"x\",20)", "15"),
        ("=AVG(\"x\")", "0"),
        ("=MIN(5,10,3,8)", "3"),
        ("=MAX(5,10,3,8)", "10"),
        ("=MIN(\"x\",2)", "2"),
        ("=COUNT(1,\"x\",\"\")", "3"),
        ("=COUNT()", "0"),
        ("=ABS(-42)", "42"),
        ("=ROUND(3.14159)", "3"),
        ("=ROUND(3.14159,2)", "3.14"),
        ("=ROUND(125,-1)", "130"),
        ("=ROUND(-2.5)", "-3"),
        ("=CONCAT(\"Item_\",12)", "Item_12"),
        ("=CONCAT()", ""),
        ("=LEN(\"日本語\")", "3"),
        ("=LENGTH(\"りんご🍎\")", "4"),
        ("=LEN(\"é\")", "2"),
        ("=LEN(\"👨‍👩‍👧‍👦\")", "7"),
        ("=UPPER(\"hello\")", "HELLO"),
        ("=LOWER(\"HELLO\")", "hello"),
        ("=IF(1,42,1/0)", "42"),
        ("=IF(0,1/0,42)", "42"),
        ("=IF(\"false\",1,2)", "2"),
        ("=IF(\"0.0\",1,2)", "1"),
        ("=IF(0.0,1,2)", "2"),
        ("=IF(\" false \",1,2)", "1"),
        ("=IF(1,42,UNKNOWN())", "42"),
        ("=1+2*3", "7"),
        ("=(1+2)*3", "9"),
        ("=10-3-2", "5"),
        ("=12/3/2", "2"),
        ("=\"12\"+\"3\"", "15"),
        ("=\"Item_\"+12", "Item_12"),
        ("=\"010\"=10", "true"),
        ("=\"A\"=\"a\"", "false"),
        ("=\"2\"<\"10\"", "true"),
        ("=1e-3*1000", "1"),
        ("=\"He said \"\"Hi\"\"\"", "He said \"Hi\""),
        ("=PRICE*Quantity", "360"),
        ("=total+10", "370"),
        ("=empty_num+2", "2"),
        ("=IF(empty_bool,1,2)", "2"),
        ("=COUNT(empty_text)", "1"),
        ("=SUM(empty_text)", "0"),
        ("=label", ""),
        ("=", ""),
        ("=\"NaN\"", "NaN"),
        ("=IF(quantity=0,0,price/quantity)", "40"),
    ] {
        match engine.evaluate(expr, "result", &record, &schema) {
            FormulaResult::Value(v) => assert_eq!(v, expected, "{expr}"),
            error => panic!("{expr}: {error:?}"),
        }
        n += 1;
    }
    for (expr, category) in [
        ("=SUM()", "ArgumentError"),
        ("=AVG()", "ArgumentError"),
        ("=MIN(\"x\")", "ArgumentError"),
        ("=MAX(\"\")", "ArgumentError"),
        ("=ABS(\"x\")", "ArgumentError"),
        ("=ABS(\"\")", "ArgumentError"),
        ("=ROUND(1,\"1.5\")", "TypeError"),
        ("=IF(1,2)", "ArgumentError"),
        ("=SUM(1,)", "ParseError"),
        ("=IF(1,42,)", "ParseError"),
        ("=COUNT(1/0)", "DivisionByZero"),
        ("=SUM(\"NaN\")", "TypeError"),
        ("=SUM(1/0)", "DivisionByZero"),
        ("=UNKNOWN()", "FunctionNotFound"),
        ("=missing", "InvalidReference"),
        ("=\"x\"-1", "TypeError"),
        ("=9007199254740993+0.5", "TypeError"),
        (
            "=LOOKUP(\"Items\",\"id\",\"potion\",\"price\")",
            "InvalidReference",
        ),
    ] {
        match engine.evaluate(expr, "result", &record, &schema) {
            FormulaResult::Error(e) => {
                assert!(format!("{e:?}").starts_with(category), "{expr}: {e:?}")
            }
            value => panic!("{expr}: expected error got {value:?}"),
        }
        n += 1;
    }
    for (kind, expr, expected) in [
        (ValueType::I32, "=3/2", "2"),
        (ValueType::I32, "=-3/2", "-2"),
        (ValueType::F64, "=3/2", "1.5"),
        (ValueType::String, "=3/2", "1.5"),
        (ValueType::Boolean, "=2>1", "true"),
        (ValueType::None, "=1/0", ""),
    ] {
        let target = col("result", kind, "");
        assert_eq!(
            engine
                .evaluate_column(expr, &target, &record, &schema)
                .into_result()
                .unwrap(),
            expected
        );
        n += 1;
    }
    for (kind, expr) in [
        (ValueType::U8, "=256"),
        (ValueType::I32, "=\"text\""),
        (ValueType::Boolean, "=1"),
        (ValueType::I32, "=\"\""),
    ] {
        assert!(matches!(
            engine.evaluate_column(expr, &col("result", kind, ""), &record, &schema),
            FormulaResult::Error(_)
        ));
        n += 1;
    }
    record.set_cell_value(&schema.columns[5], "5".into());
    assert_eq!(
        engine
            .evaluate("=total", "result", &record, &schema)
            .into_result()
            .unwrap(),
        "5"
    );
    n += 1;
    record.remove_cell_value(&schema.columns[5]);
    assert_eq!(
        engine
            .evaluate("=total", "result", &record, &schema)
            .into_result()
            .unwrap(),
        "360"
    );
    n += 1;
    record.set_cell_value(&schema.columns[5], "=total+1".into());
    assert!(format!(
        "{:?}",
        engine.evaluate("=total", "result", &record, &schema)
    )
    .contains("CircularReference"));
    n += 1;
    schema.columns.push(col("PRICE", ValueType::I32, "1"));
    assert!(format!(
        "{:?}",
        engine.evaluate("=price", "result", &record, &schema)
    )
    .contains("Ambiguous column"));
    n += 1;
    let directory = tempfile::tempdir().unwrap();
    let mut p = Project::create_project(
        "FormulaManual",
        directory.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let ip = p.create_table("items.table.toml".into()).unwrap();
    p.load_table(&ip).unwrap();
    {
        let t = p.tables_data.get_mut(&ip).unwrap();
        t.data.metadata.data_name = "Items".into();
        t.data.display_name = "アイテム".into();
        t.data.schema.columns = vec![
            col("id", ValueType::String, ""),
            col("category", ValueType::String, ""),
            col("price", ValueType::I32, "0"),
            col("double", ValueType::I32, "=price*2"),
        ];
        for (id, cat, price, version) in [
            ("potion", "common", "120", 0),
            ("ether", "common", "300", 0),
            ("sword", "rare", "500", 1),
        ] {
            let mut r = Record::new();
            r.min_version = version;
            r.values.extend([
                ("id".into(), id.into()),
                ("category".into(), cat.into()),
                ("price".into(), price.into()),
            ]);
            t.data.records.push(r);
        }
        Project::save_table(t).unwrap();
    }
    let out = col("result", ValueType::I32, "");
    let query_schema = TableSchema {
        columns: vec![col("item_id", ValueType::String, "potion")],
    };
    let row = Record::new();
    for version in [None, Some(0)] {
        let ctx = ProjectFormulaContext::new(&p, version).unwrap();
        for (expr,expected) in [("=LOOKUP(\"Items\",\"id\",item_id,\"price\")","120"),("=LOOKUP(\"items\",\"ID\",\"potion\",\"double\")","240"),("=COUNTIF(\"Items\",\"category\",\"common\")","2"),("=SUMIF(\"Items\",\"category\",\"common\",\"price\")","420"),("=COUNTIF(\"Items\",\"price\",\">100\")","0"),("=COUNTIF(\"Items\",\"id\",\"Potion\")","0"),("=COUNTIF(\"Items\",\"price\",\"0120\")","0"),("=SUMIF(\"Items\",\"category\",\"none\",\"price\")","0"),("=COUNTIF(\"アイテム\",\"category\",\"rare\")",if version.is_none(){"1"}else{"0"}),("=IF(COUNTIF(\"Items\",\"id\",\"none\")=1,LOOKUP(\"Items\",\"id\",\"none\",\"price\"),0)","0")] {
            assert_eq!(ctx.evaluate_cell(expr,&out,&row,&query_schema,"target").into_result().unwrap(),expected,"{expr}");n+=1;
        }
        for expr in [
            "=LOOKUP(\"Items\",\"id\",\"none\",\"price\")",
            "=LOOKUP(\"Items\",\"category\",\"common\",\"price\")",
            "=SUMIF(\"Items\",\"category\",\"common\",\"id\")",
        ] {
            assert!(
                matches!(
                    ctx.evaluate_cell(expr, &out, &row, &query_schema, "target"),
                    FormulaResult::Error(_)
                ),
                "{expr}"
            );
            n += 1;
        }
    }
    p.tables_data.remove(&ip);
    let ctx = ProjectFormulaContext::new(&p, None).unwrap();
    assert_eq!(
        ctx.evaluate_cell(
            "=SUMIF(\"Items\",\"category\",\"common\",\"price\")",
            &out,
            &row,
            &query_schema,
            "target"
        )
        .into_result()
        .unwrap(),
        "420"
    );
    n += 1;
    println!("PASS: {n} formula assertions, including every supported function/alias, typed output, defaults, errors, lazy IF, project queries, version populations, and unopened table reads.");
}
