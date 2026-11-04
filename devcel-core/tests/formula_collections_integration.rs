//! Persistent integration regressions for collection formulas and their project boundaries.
//! Run from a clean checkout: cargo test -p devcel-core --test formula_collections_integration.
//! Performance measurements live in the benchmark examples, not timing assertions here.
use devcel_core::{ColumnSchema, FormulaEngine, FormulaResult, Record, TableSchema, ValueType};

#[test]
fn scalar_collection_matrix() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let cases: &[(&str, Option<&str>)] = &[
        (
            r###"=REDUCE(MAP([10,20,30],x=>x*2),0,(a,x)=>a+x)"###,
            Some(r###"120"###),
        ),
        (
            r###"=REDUCE(FILTER([10,-5,20],x=>x>0),0,(a,x)=>a+x)"###,
            Some(r###"30"###),
        ),
        (r###"=REDUCE([1,2,3],10,(a,x)=>a-x)"###, Some(r###"4"###)),
        (r###"=REDUCE([],10,(a,x)=>1/0)"###, Some(r###"10"###)),
        (
            r###"=REDUCE(MAP([],x=>1/0),7,(a,x)=>a+x)"###,
            Some(r###"7"###),
        ),
        (
            r###"=REDUCE(SEQUENCE(3),0,(a,x)=>a+x*100)"###,
            Some(r###"600"###),
        ),
        (r###"=REDUCE(SEQUENCE(0),2,(a,x)=>a+x)"###, Some(r###"2"###)),
        (
            r###"=REDUCE(MAP([1,2],x=>REDUCE([10,20],0,(a,y)=>a+x*y)),0,(a,x)=>a+x)"###,
            Some(r###"90"###),
        ),
        (
            r###"=REDUCE(MAP([1,2],(x,i)=>x+i*10),0,(a,x)=>a+x)"###,
            Some(r###"13"###),
        ),
        (
            r###"=REDUCE(MAP(FILTER([4,5,6],(x,i)=>i>0),(x,i)=>i),0,(a,x)=>a+x)"###,
            Some(r###"1"###),
        ),
        (r###"=REDUCE([1,2,3],0,(a,x,i)=>a+i)"###, Some(r###"3"###)),
        (
            r###"=REDUCE([1,2],{v:0},(a,x)=>{v:a.v+x}).v"###,
            Some(r###"3"###),
        ),
        (
            r###"=REDUCE(MAP([1,2],x=>{rows:[x,x+1]}),0,(a,r)=>a+REDUCE(r.rows,0,(b,y)=>b+y))"###,
            Some(r###"8"###),
        ),
        (
            r###"=SAME(9007199254740993,9007199254740992.0)"###,
            Some(r###"false"###),
        ),
        (r###"=SAME(1,1.0)"###, Some(r###"true"###)),
        (r###"=SAME("010",10)"###, Some(r###"false"###)),
        (r###"=SAME("A","a")"###, Some(r###"false"###)),
        (r###"=SAME(" a","a")"###, Some(r###"false"###)),
        (r###"="010"=10"###, Some(r###"true"###)),
        (
            r###"=REDUCE(GROUPBY([2,1,2,3,1],x=>x),0,(a,g)=>a*10+g.key)"###,
            Some(r###"213"###),
        ),
        (
            r###"=REDUCE(GROUPBY([1,1.0,2],x=>x),0,(a,g)=>a+1)"###,
            Some(r###"2"###),
        ),
        (
            r###"=REDUCE(JOIN([{k:1},{k:1}],[{k:1},{k:1},{k:1}],(l,r)=>SAME(l.k,r.k),"INNER"),0,(a,p)=>a+1)"###,
            Some(r###"6"###),
        ),
        (
            r###"=REDUCE(JOIN([{k:1},{k:2}],[{k:1,z:0}],(l,r)=>SAME(l.k,r.k),"LEFT"),0,(a,p)=>a+(HASROW(p.right)?10+p.right.z:1))"###,
            Some(r###"11"###),
        ),
        (
            r###"=REDUCE(JOIN([{k:1},{k:2}],[],(l,r)=>1/0,"LEFT"),0,(a,p)=>a+(HASROW(p.right)?100:1))"###,
            Some(r###"2"###),
        ),
        (
            r###"=LETREC(fact,n=>n<=1?1:n*fact(n-1),fact(5))"###,
            Some(r###"120"###),
        ),
        (
            r###"=LETREC(f,n=>IF(n<=0,0,f(n-1)+1),f(5))"###,
            Some(r###"5"###),
        ),
        (r###"=LETREC(f,n=>n==0?1:f(n-1),f(0))"###, Some(r###"1"###)),
        (
            r###"=IF(1,7,REDUCE([1,2],0,(a,x)=>1/0))"###,
            Some(r###"7"###),
        ),
        (
            r###"=REDUCE(MAP([1,2],x=>"a,b"),"",(a,x)=>CONCAT(a,x))"###,
            Some(r###"a,ba,b"###),
        ),
        (
            r###"=REDUCE(MAP([1],x=>{`a,b`:x}),0,(a,r)=>a+r.`a,b`)"###,
            Some(r###"1"###),
        ),
        (r###"=MAP([1],x=>x)"###, None),
        (r###"={a:1}"###, None),
        (r###"=x=>x"###, None),
        (r###"=REDUCE([1,"2"],0,(a,x)=>a+x)"###, None),
        (
            r###"=REDUCE(MAP([1,2],x=>x==1?{a:x}:{b:x}),0,(a,x)=>a+1)"###,
            None,
        ),
        (r###"=REDUCE([[1],[2]],0,(a,x)=>a+1)"###, None),
        (r###"=REDUCE([1],0,(a,x)=>{v:x})"###, None),
        (r###"=REDUCE(MAP([],()=>1),0,(a,x)=>a+x)"###, None),
        (r###"=REDUCE(MAP([],(x,X)=>1),0,(a,x)=>a+x)"###, None),
        (r###"=REDUCE(FILTER([],(x,i,z)=>1),0,(a,x)=>a+x)"###, None),
        (r###"=REDUCE([],1,x=>x)"###, None),
        (r###"=SEQUENCE(-1)"###, None),
        (r###"=SEQUENCE(1.5)"###, None),
        (r###"=SEQUENCE(1,2)"###, None),
        (
            r###"=REDUCE(GROUPBY([1,2],x=>x==1?1:"1"),0,(a,g)=>a+1)"###,
            None,
        ),
        (r###"=SAME({a:1},{a:1})"###, None),
        (r###"=HASROW(0)"###, None),
        (
            r###"=REDUCE(JOIN([],SEQUENCE(-1),(l,r)=>1,"INNER"),0,(a,p)=>a+1)"###,
            None,
        ),
        (
            r###"=REDUCE(JOIN([],[],(l,r)=>1,"OUTER"),0,(a,p)=>a+1)"###,
            None,
        ),
        (
            r###"=REDUCE(JOIN([{k:1}],[],(l,r)=>1,"LEFT"),0,(a,p)=>a+p.right.k)"###,
            None,
        ),
        (r###"=LETREC(f,n=>f(n),f(1))"###, None),
        (r###"=LETREC(f,n=>n,f(1,2))"###, None),
        (r###"=REDUCE([1,2],0,(a,x)=>a+1/(2-x))"###, None),
        (r###"=REDUCE(MAP([1],x=>{a:1,A:2}),0,(a,x)=>a+1)"###, None),
    ];
    let mut failures = Vec::new();
    for (formula, expected) in cases {
        let actual = FormulaEngine::new().evaluate(formula, "review", &record, &schema);
        let ok = match (&actual, expected) {
            (FormulaResult::Value(value), Some(expected)) => value == expected,
            (FormulaResult::Error(_), None) => true,
            _ => false,
        };
        if !ok {
            failures.push(format!("{formula} => {actual:?}; expected {expected:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn column(name: &str, value_type: ValueType) -> ColumnSchema {
    let mut column = ColumnSchema::new();
    column.data_name = name.into();
    column.display_name = name.into();
    column.data_type = value_type;
    column
}

#[test]
fn scope_and_named_columns() {
    let mut record = Record::new();
    for (name, value) in [
        ("x", "100"),
        ("straße", "7"),
        ("a+b", "12"),
        ("1+2", "99"),
        ("offset+", "13"),
        ("a:b", "14"),
        ("unit price.rate", "15"),
    ] {
        record.set_value(name, value.into());
    }
    let schema = TableSchema {
        columns: vec![
            column("x", ValueType::I32),
            column("straße", ValueType::I32),
            column("a+b", ValueType::I32),
            column("1+2", ValueType::I32),
            column("offset+", ValueType::I32),
            column("a:b", ValueType::I32),
            column("unit price.rate", ValueType::I32),
        ],
    };
    for (formula, expected) in [
        ("=a+b", "12"),
        ("=1+2", "99"),
        ("=STRASSE", "7"),
        ("=offset+", "13"),
        ("=a:b", "14"),
        ("=unit price.rate", "15"),
        ("=LET(result,offset+,result)", "13"),
        ("=\"${offset+}\"", "13"),
        ("=REDUCE(MAP([1,2],x=>x+`x`),0,(a,x)=>a+x)", "203"),
        (
            "=REDUCE(MAP([1,2],x=>REDUCE(MAP([3],x=>x),0,(a,y)=>a+y)+x),0,(a,x)=>a+x)",
            "9",
        ),
        ("=REDUCE(MAP([1],straße=>STRASSE),0,(a,x)=>a+x)", "1"),
    ] {
        assert!(
            matches!(FormulaEngine::new().evaluate(formula, "review", &record, &schema), FormulaResult::Value(value) if value == expected),
            "{formula}"
        );
    }
}

#[test]
fn column_name_atoms_preserve_errors_and_diagnostic_locations() {
    let mut record = Record::new();
    record.set_value("offset+", "13".into());
    let schema = TableSchema {
        columns: vec![
            column("offset+", ValueType::I32),
            column("", ValueType::I32),
        ],
    };
    let mut engine = FormulaEngine::new();
    let formula = "=SUM(offset+,1/0)";
    assert!(matches!(
        engine.evaluate(formula, "result", &record, &schema),
        FormulaResult::Error(devcel_core::FormulaError::DivisionByZero)
    ));
    let diagnostic = engine.last_diagnostic().unwrap();
    let failure = formula.find("1/0").unwrap();
    assert_eq!(
        diagnostic
            .frames
            .first()
            .and_then(|frame| frame.location.as_ref())
            .map(|location| (location.span.start, location.span.end)),
        Some((failure, failure + 3))
    );
    for formula in ["=1+", "=missing+", "=a:b"] {
        assert!(
            matches!(
                engine.evaluate(formula, "result", &record, &schema),
                FormulaResult::Error(devcel_core::FormulaError::ParseError(_))
            ),
            "{formula}"
        );
    }
    let duplicate_schema = TableSchema {
        columns: vec![
            column("offset+", ValueType::I32),
            column("OFFSET+", ValueType::I32),
        ],
    };
    assert!(matches!(
        engine.evaluate("=offset+", "result", &record, &duplicate_schema),
        FormulaResult::Error(devcel_core::FormulaError::InvalidReference(_))
    ));
}

#[test]
fn reused_engine_observes_schema_and_name_changes() {
    let record = Record::new();
    let mut schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    let check = |engine: &mut FormulaEngine<'_>, schema: &TableSchema, formula, expected| {
        assert!(
            matches!(engine.evaluate(formula, "result", &record, schema),
            FormulaResult::Value(value) if value == expected),
            "{formula}"
        );
    };
    check(&mut engine, &schema, "=1+2", "3");
    let mut named = column("value", ValueType::I32);
    named.display_name = "1+2".into();
    named.default_value = "99".into();
    schema.columns.push(named);
    check(&mut engine, &schema, "=1+2", "99");
    schema.columns[0].default_value = "101".into();
    check(&mut engine, &schema, "=1+2", "101");
    schema.columns[0].display_name = "offset+".into();
    check(&mut engine, &schema, "=1+2", "3");
    check(&mut engine, &schema, "=offset+", "101");
    let mut duplicate = column("other", ValueType::I32);
    duplicate.display_name = "OFFSET+".into();
    schema.columns.push(duplicate);
    assert!(matches!(
        engine.evaluate("=offset+", "result", &record, &schema),
        FormulaResult::Error(devcel_core::FormulaError::InvalidReference(_))
    ));
    schema.columns.remove(0);
    schema.columns[0].default_value = "7".into();
    check(&mut engine, &schema, "=offset+", "7");
    schema.columns.clear();
    assert!(matches!(
        engine.evaluate("=offset+", "result", &record, &schema),
        FormulaResult::Error(devcel_core::FormulaError::ParseError(_))
    ));
    check(&mut engine, &schema, "=1+2", "3");
}

#[test]
fn typed_number_operators_preserve_scalar_comparison_rules() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    for (formula, expected) in [
        ("=9007199254740993>9007199254740992.0", "true"),
        ("=9007199254740992.0<9007199254740993", "true"),
        ("=-9223372036854775808.0=-9223372036854775808", "true"),
        ("=1.0=1", "true"),
        ("=1.0!=1", "false"),
        ("=1.5<=2", "true"),
        ("=2>=1.5", "true"),
        ("=1.5+2", "3.5"),
        ("=3.0/2", "1.5"),
        ("=\"prefix\"+1.5", "prefix1.5"),
        ("=LET(n,9007199254740993,n>9007199254740992.0)", "true"),
    ] {
        assert!(
            matches!(engine.evaluate(formula, "result", &record, &schema),
            FormulaResult::Value(value) if value == expected),
            "{formula}"
        );
    }
    for formula in ["=9007199254740993+0.0", "=9007199254740993<0.5"] {
        assert!(
            matches!(
                engine.evaluate(formula, "result", &record, &schema),
                FormulaResult::Error(devcel_core::FormulaError::TypeError(_))
            ),
            "{formula}"
        );
    }
}

#[test]
fn failed_evaluation_releases_state() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    for formula in [
        "=LETREC(f,n=>f(n),f(1))",
        "=REDUCE([1,2],0,(a,x)=>a+1/(2-x))",
    ] {
        assert!(matches!(
            engine.evaluate(formula, "review", &record, &schema),
            FormulaResult::Error(_)
        ));
        assert!(
            matches!(engine.evaluate("=REDUCE([1,2,3],0,(a,x)=>a+x)", "review", &record, &schema), FormulaResult::Value(value) if value == "6")
        );
    }
}

use devcel_core::formula_context::ProjectFormulaContext;
use devcel_core::{Project, Table, TableData, TableMetadata};
use std::collections::HashMap;

fn data(name: &str, columns: Vec<ColumnSchema>, rows: &[&[(&str, &str)]]) -> TableData {
    TableData {
        description: String::new(),
        uuid: uuid::Uuid::new_v4().to_string(),
        display_name: name.into(),
        metadata: TableMetadata {
            interface_order: Vec::new(),
            initial_transposed: false,
            edit_permissions: Default::default(),
            parent_uuid: String::new(),
            data_name: name.into(),
        },
        interface_implementations: HashMap::new(),
        schema: TableSchema { columns },
        records: rows
            .iter()
            .map(|fields| {
                let mut row = Record::new();
                for (key, value) in *fields {
                    row.set_value(key, (*value).into());
                }
                row
            })
            .collect(),
    }
}
fn insert(project: &mut Project, data: &TableData, loaded: bool) -> std::path::PathBuf {
    let path = project
        .path
        .parent()
        .unwrap()
        .join("Tables")
        .join(format!("{}.table.toml", data.metadata.data_name));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, toml::to_string(data).unwrap()).unwrap();
    if loaded {
        project.tables_data.insert(
            path.clone(),
            Table {
                path: path.clone(),
                is_dirty: false,
                data: data.clone(),
                undo_history: vec![],
                redo_history: vec![],
            },
        );
    }
    path
}
fn expect(
    context: &ProjectFormulaContext<'_>,
    root: &TableData,
    formula: &str,
    expected: Option<&str>,
) {
    let column = root
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "total")
        .unwrap();
    let result = context.evaluate_cell_with_override(root, column, &root.records[0], formula);
    match (result, expected) {
        (FormulaResult::Value(value), Some(expected)) => assert_eq!(value, expected, "{formula}"),
        (FormulaResult::Error(_), None) => (),
        (actual, expected) => panic!("{formula}: {actual:?}, expected {expected:?}"),
    }
}
#[test]
fn table_chain_version_and_lazy_cycles() {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Review", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let mut enemies = data(
        "Enemies",
        vec![
            column("id", ValueType::String),
            column("active", ValueType::Boolean),
            column("total", ValueType::I32),
        ],
        &[
            &[("id", "slime"), ("active", "true")],
            &[("id", "dragon"), ("active", "true")],
            &[("id", "ghost"), ("active", "false")],
        ],
    );
    let mut price = column("price", ValueType::I32);
    price.min_version = 99; // Excluded output column remains readable.
    let mut drops = data(
        "Drops",
        vec![
            column("enemyId", ValueType::String),
            price,
            column("count", ValueType::I32),
        ],
        &[
            &[("enemyId", "slime"), ("price", "10"), ("count", "2")],
            &[("enemyId", "slime"), ("price", "5"), ("count", "1")],
            &[("enemyId", "ghost"), ("price", "100"), ("count", "1")],
        ],
    );
    drops.records[1].min_version = 2;
    insert(&mut project, &enemies, true);
    let drops_path = insert(&mut project, &drops, false);
    let chain = "=REDUCE(MAP(GROUPBY(MAP(JOIN(FILTER(TABLE(\"Enemies\"),e=>e.active),TABLE(\"Drops\"),(e,d)=>SAME(e.id,d.enemyId),\"LEFT\"),p=>{id:p.left.id,value:HASROW(p.right)?p.right.price*p.right.count:0}),r=>r.id),g=>{id:g.key,value:REDUCE(g.rows,0,(a,r)=>a+r.value)}),0,(a,r)=>a+r.value)";
    for (version, expected) in [(None, "25"), (Some(1), "20"), (Some(2), "25")] {
        let context = ProjectFormulaContext::new(&project, version).unwrap();
        expect(&context, &enemies, chain, Some(expected));
        expect(
            &context,
            &enemies,
            "=REDUCE(TABLE(\"Enemies\"),0,(a,r)=>a+1)",
            Some("3"),
        );
        expect(
            &context,
            &enemies,
            "=REDUCE(TABLE(\"Enemies\"),0,(a,r)=>a+(r.active?1:0))",
            Some("2"),
        );
    }
    // The candidate root must win over the project's loaded copy.
    enemies.records.remove(2);
    expect(
        &ProjectFormulaContext::new(&project, None).unwrap(),
        &enemies,
        "=REDUCE(TABLE(\"Enemies\"),0,(a,r)=>a+1)",
        Some("2"),
    );
    // Reading the actual active root cell is a cycle, merely obtaining its row is not.
    enemies.records[0].set_value(
        "total",
        "=REDUCE(TABLE(\"Enemies\"),0,(a,r)=>a+r.total)".into(),
    );
    expect(
        &ProjectFormulaContext::new(&project, None).unwrap(),
        &enemies,
        "=REDUCE(TABLE(\"Enemies\"),0,(a,r)=>a+r.total)",
        None,
    );
    expect(
        &ProjectFormulaContext::new(&project, None).unwrap(),
        &enemies,
        "=REDUCE(TABLE(\"Enemies\"),0,(a,r)=>a+1)",
        Some("2"),
    );
    // Re-saving an unloaded dependency is visible to the next root context.
    drops.records[0].set_value("price", "20".into());
    std::fs::write(&drops_path, toml::to_string(&drops).unwrap()).unwrap();
    expect(
        &ProjectFormulaContext::new(&project, None).unwrap(),
        &enemies,
        chain,
        Some("45"),
    );
}

#[test]
fn uniform_parser_for_scalar_and_collection_expressions() {
    let mut record = Record::new();
    for (name, value) in [("unit price", "7"), ("x+1", "99")] {
        record.set_value(name, value.into());
    }
    let schema = TableSchema {
        columns: vec![
            column("unit price", ValueType::I32),
            column("x+1", ValueType::I32),
        ],
    };
    let cases = [
        ("=SAME\t(1,1)", "true"),
        ("=SAME\n(1,1)", "true"),
        ("=\"${unit price}\"", "7"),
        ("=REDUCE([1],0,(a,x)=>a+unit price)", "7"),
        ("=REDUCE([1],0,(a,x)=>a+x+1)", "2"),
        ("=REDUCE(MAP([1],x=>x+1),0,(a,x)=>a+x)", "2"),
    ];
    let mut failures = vec![];
    for (formula, expected) in cases {
        let actual = FormulaEngine::new().evaluate(formula, "review", &record, &schema);
        if !matches!(&actual,FormulaResult::Value(value) if value==expected) {
            failures.push(format!("{formula:?}: {actual:?} != {expected}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn one_grammar_for_cells_bindings_and_interpolation() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    for (expression, expected) in [
        ("true", "true"),
        ("false", "false"),
        ("1+2*3", "7"),
        ("12/3/2", "2"),
        ("1e-3*1000", "1"),
        ("SUM(10,20,30)", "60"),
        ("IF(true,42,1/0)", "42"),
        ("IF(false,missing,42)", "42"),
        ("IF(true,42,1e999)", "42"),
        ("true ? 42 : UNKNOWN()", "42"),
        ("false ? 1e999 : 42", "42"),
        ("false && 1/0", "false"),
        ("true || 1e999", "true"),
        ("REDUCE([1,2,3],0,(a,x)=>a+x)", "6"),
        ("COLOR32(12,23,34).r", "12"),
    ] {
        for formula in [
            format!("={expression}"),
            format!("=LET(result,{expression},result)"),
            format!("=\"${{{expression}}}\""),
        ] {
            let mut engine = FormulaEngine::new();
            assert_eq!(
                engine
                    .evaluate(&formula, "result", &record, &schema)
                    .into_result()
                    .unwrap(),
                expected,
                "{formula}"
            );
            // An unrelated typed column must never change how an expression runs.
            let colored_schema = TableSchema {
                columns: vec![column("unused_color", ValueType::Color32)],
            };
            assert_eq!(
                engine
                    .evaluate(&formula, "result", &record, &colored_schema)
                    .into_result()
                    .unwrap(),
                expected,
                "{formula} with an unused color column"
            );
        }
    }
    for formula in ["=missing", "=LET(result,missing,result)", "=\"${missing}\""] {
        assert!(
            matches!(
                FormulaEngine::new().evaluate(formula, "result", &record, &schema),
                FormulaResult::Error(devcel_core::FormulaError::InvalidReference(_))
            ),
            "{formula}"
        );
    }
}

#[test]
fn limits_and_cancel_boundaries() {
    use devcel_core::formula_engine::FormulaLimits;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut errors = vec![];
    for (formula, limits) in [
        (
            "=123456",
            FormulaLimits {
                source_bytes: 3,
                ..FormulaLimits::default()
            },
        ),
        (
            "=SAME(1,1)",
            FormulaLimits {
                source_bytes: 3,
                ..FormulaLimits::default()
            },
        ),
        (
            "=REDUCE(SEQUENCE(10),0,(a,x)=>a+x)",
            FormulaLimits {
                collection_items: 5,
                ..FormulaLimits::default()
            },
        ),
        (
            "=REDUCE(SEQUENCE(10),0,(a,x)=>a+x)",
            FormulaLimits {
                steps: 5,
                ..FormulaLimits::default()
            },
        ),
        (
            "=LETREC(f,n=>n==0?0:f(n-1),f(10))",
            FormulaLimits {
                call_depth: 3,
                ..FormulaLimits::default()
            },
        ),
        (
            "=REDUCE(JOIN([{k:1},{k:1}],[{k:1},{k:1}],(l,r)=>1,\"INNER\"),0,(a,p)=>a+1)",
            FormulaLimits {
                collection_items: 3,
                ..FormulaLimits::default()
            },
        ),
    ] {
        let mut engine = FormulaEngine::new();
        engine.set_limits(limits);
        if !matches!(
            engine.evaluate(formula, "review", &record, &schema),
            FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))
        ) {
            errors.push(formula);
        }
    }
    let cancel = Arc::new(AtomicBool::new(true));
    let mut engine = FormulaEngine::new();
    engine.set_cancellation(Some(cancel.clone()));
    assert!(matches!(
        engine.evaluate(
            "=REDUCE(SEQUENCE(3),0,(a,x)=>a+x)",
            "review",
            &record,
            &schema
        ),
        FormulaResult::Error(devcel_core::FormulaError::Cancelled)
    ));
    cancel.store(false, Ordering::Relaxed);
    assert!(
        matches!(engine.evaluate("=REDUCE(SEQUENCE(3),0,(a,x)=>a+x)","review",&record,&schema),FormulaResult::Value(value) if value=="6")
    );
    assert!(errors.is_empty(), "Limits bypassed: {errors:?}");
}

#[test]
fn reference_identity_and_output_targets() {
    use devcel_core::types::ReferenceConfig;
    let target = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    let other = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    let rowid = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    let mut src = column("src", ValueType::Reference);
    src.reference_config = Some(ReferenceConfig {
        target_table_uuid: target.into(),
        display_column_uuid: None,
    });
    let mut upper = column("upper", ValueType::Reference);
    upper.reference_config = Some(ReferenceConfig {
        target_table_uuid: target.to_uppercase(),
        display_column_uuid: None,
    });
    let mut dest = column("dest", ValueType::Reference);
    dest.reference_config = Some(ReferenceConfig {
        target_table_uuid: other.into(),
        display_column_uuid: None,
    });
    let mut record = Record::new();
    record.set_value("src", rowid.into());
    record.set_value("upper", rowid.to_uppercase());
    let schema = TableSchema {
        columns: vec![src.clone(), upper, dest.clone()],
    };
    let mut errors = vec![];
    let mut engine = FormulaEngine::new();
    let same = engine.evaluate("=SAME(src,upper)", "review", &record, &schema);
    if !matches!(&same,FormulaResult::Value(v) if v=="true") {
        errors.push(format!("UUID case changes SAME identity: {same:?}"));
    }
    let wrong_target = engine.evaluate_column("=LET(a,src,a)", &dest, &record, &schema);
    if !matches!(wrong_target, FormulaResult::Error(_)) {
        errors.push(format!(
            "Reference output allowed incompatible target: {wrong_target:?}"
        ));
    }
    let good = engine.evaluate_column("=LET(a,src,a)", &src, &record, &schema);
    assert!(matches!(good,FormulaResult::Value(v) if v==rowid));
    record.set_value("src", String::new());
    for formula in [
        "=SAME(src,src)",
        "=REDUCE(GROUPBY([src],x=>x),0,(a,g)=>a+1)",
    ] {
        let result = engine.evaluate(formula, "review", &record, &schema);
        if !matches!(result, FormulaResult::Error(_)) {
            errors.push(format!("Empty Reference key accepted: {result:?}"));
        }
    }
    assert!(
        matches!(engine.evaluate("=SAME(\"\",\"\")","review",&record,&schema),FormulaResult::Value(v) if v=="true")
    );
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}

#[test]
fn cancel_during_join_and_resume() {
    use devcel_core::formula_engine::FormulaLimits;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let flag = Arc::new(AtomicBool::new(false));
    let other = flag.clone();
    let signal = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(5));
        other.store(true, Ordering::Relaxed);
    });
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    engine.set_cancellation(Some(flag.clone()));
    engine.set_limits(FormulaLimits {
        steps: 100_000_000,
        allocated_bytes: 512 * 1024 * 1024,
        ..FormulaLimits::default()
    });
    let result=engine.evaluate("=LET(rows,MAP(SEQUENCE(10000),x=>{id:x}),REDUCE(JOIN(rows,rows,(a,b)=>a.id==-b.id,\"INNER\"),0,(a,p)=>a+1))","review",&record,&schema);
    signal.join().unwrap();
    assert!(
        matches!(
            result,
            FormulaResult::Error(devcel_core::FormulaError::Cancelled)
        ),
        "{result:?}"
    );
    flag.store(false, Ordering::Relaxed);
    assert!(
        matches!(engine.evaluate("=REDUCE([1,2],0,(a,x)=>a+x)","review",&record,&schema),FormulaResult::Value(v) if v=="3")
    );
}

#[test]
fn snapshot_same_stamp_and_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Snapshot", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
    let mut input = data(
        "Input",
        vec![column("value", ValueType::I32)],
        &[&[("value", "10")]],
    );
    insert(&mut project, &root, true);
    let path = insert(&mut project, &input, false);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    let formula = "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)";
    context.begin_snapshot().unwrap();
    expect(&context, &root, formula, Some("10"));
    let metadata = std::fs::metadata(&path).unwrap();
    let old_len = metadata.len();
    let time = metadata.modified().unwrap();
    input.records[0].set_value("value", "20".into());
    std::fs::write(&path, toml::to_string(&input).unwrap()).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().len(), old_len);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(time))
        .unwrap();
    assert!(matches!(
        context.finish_snapshot(),
        Err(devcel_core::FormulaError::DataChanged(_))
    ));
    expect(&context, &root, formula, Some("20"));
    context.begin_snapshot().unwrap();
    expect(&context, &root, formula, Some("20"));
    let extra = data("Extra", vec![column("value", ValueType::I32)], &[]);
    let path2 = project
        .path
        .parent()
        .unwrap()
        .join("Tables/Extra.table.toml");
    std::fs::write(path2, toml::to_string(&extra).unwrap()).unwrap();
    assert!(matches!(
        context.finish_snapshot(),
        Err(devcel_core::FormulaError::DataChanged(_))
    ));
    expect(&context, &root, formula, Some("20"));
}

#[test]
fn full_minimal_streaming_and_failure() {
    use devcel_core::json_export::{
        export_runtime_bundle_to_file_with_validation, export_runtime_bundle_with_validation,
        ExportMode,
    };
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Exports", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let formula = "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)";
    let root = data(
        "Root",
        vec![column("total", ValueType::I32)],
        &[&[("total", formula)]],
    );
    let mut hidden = column("value", ValueType::I32);
    hidden.min_version = 99;
    let mut input = data(
        "Input",
        vec![hidden],
        &[&[("value", "10")], &[("value", "20")]],
    );
    input.records[1].min_version = 2;
    let root_path = insert(&mut project, &root, true);
    insert(&mut project, &input, false);
    for (version, expected) in [(None, 30), (Some(1), 10), (Some(2), 30)] {
        let mut reconstructed = vec![];
        for mode in [ExportMode::Full, ExportMode::Minimal] {
            let full =
                export_runtime_bundle_with_validation(&mut project, mode, version, true).unwrap();
            let output = dir.path().join("stream.json");
            let stream = export_runtime_bundle_to_file_with_validation(
                &mut project,
                mode,
                version,
                true,
                &output,
            )
            .unwrap();
            let stream_json: serde_json::Value =
                serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
            let json = serde_json::to_value(&full).unwrap();
            assert_eq!(json["tables"], stream_json["tables"]);
            assert_eq!(full.manifest.content_hash, stream.manifest.content_hash);
            let root_json = json["tables"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == "Root")
                .unwrap();
            let actual = &root_json["records"][0]["values"]["total"];
            assert_eq!(actual, &serde_json::json!(expected.to_string()), "{json}");
            reconstructed.push(actual.clone());
            if version.is_some() {
                let input = json["tables"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| t["name"] == "Input")
                    .unwrap();
                assert!(input["columns"].as_array().unwrap().is_empty());
            }
        }
        assert_eq!(reconstructed[0], reconstructed[1]);
    }
    project
        .tables_data
        .get_mut(&root_path)
        .unwrap()
        .data
        .records[0]
        .set_value("total", "=REDUCE([1,2],0,(a,x)=>a+1/(2-x))".into());
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        assert!(export_runtime_bundle_with_validation(&mut project, mode, None, true).is_err());
        assert!(export_runtime_bundle_to_file_with_validation(
            &mut project,
            mode,
            None,
            true,
            dir.path().join("bad.json")
        )
        .is_err());
    }
}

#[test]
fn stable_order_and_exact_numeric_keys() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    for (formula,expected) in [
      ("=REDUCE(JOIN([{i:2},{i:1}],[{i:4},{i:3}],(l,r)=>1,\"INNER\"),0,(a,p)=>a*100+p.left.i*10+p.right.i)","24231413"),
      ("=REDUCE(JOIN([{i:2},{i:1},{i:3}],[{i:1}],(l,r)=>l.i==r.i,\"LEFT\"),0,(a,p)=>a*10+p.left.i)","213"),
      ("=REDUCE(GROUPBY([{k:2,v:1},{k:1,v:2},{k:2,v:3}],r=>r.k),0,(a,g)=>a*100+REDUCE(g.rows,0,(b,r)=>b*10+r.v))","1302"),
      ("=REDUCE(GROUPBY([9007199254740993,9007199254740992.0,9007199254740992],x=>x),0,(a,g)=>a*10+REDUCE(g.rows,0,(b,r)=>b+1))","12"),
      ("=REDUCE(GROUPBY([0,-0.0,0.0],x=>x),0,(a,g)=>a+1)","1"),
      ("=SAME(-170141183460469231731687303715884105728,-170141183460469231731687303715884105728.0)","true"),
      ("=SAME(170141183460469231731687303715884105727,170141183460469231731687303715884105727.0)","false"),
      ("=SAME(true,1)","false"),
      ("=REDUCE(FILTER([2,2,1,2],x=>x==2),0,(a,x)=>a*10+x)","222"),
      ("=LET(x,10,LET(f,n=>n+x,LET(x,20,f(1))))","11"),
    ] {
      let result=FormulaEngine::new().evaluate(formula,"review",&record,&schema);
      assert!(matches!(&result,FormulaResult::Value(v) if v==expected),"{formula}: {result:?}, expected {expected}");
    }
}

#[test]
fn tableref_interface_and_typed_field_validation() {
    use devcel_core::interface::{Interface, InterfaceChange, InterfaceImplementation};
    use devcel_core::types::{ReferenceConfig, TableRefConfig};
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Typed", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let base = Interface::new("Base".into(), None);
    let wrong = Interface::new("Wrong".into(), None);
    let mut child = Interface::new("Child".into(), None);
    child
        .create_new_version(
            vec![InterfaceChange::ModifyExtends {
                new_extends: vec![base.uuid],
            }],
            None,
            None,
        )
        .unwrap();
    for interface in [&base, &wrong, &child] {
        project
            .interface_registry
            .add_interface(interface.clone())
            .unwrap();
    }
    let mut input = data(
        "Input",
        vec![column("value", ValueType::U8)],
        &[&[("value", "10")]],
    );
    input.interface_implementations.insert(
        child.uuid,
        InterfaceImplementation {
            interface_uuid: child.uuid,
            synced_version_id: child.current_version_id,
            last_sync_date: chrono::Utc::now(),
            effective_fingerprint: None,
            required_column_uuids: None,
        },
    );
    input.metadata.interface_order.push(child.uuid);
    let mut table_ref = column("target", ValueType::TableRef);
    table_ref.table_ref_config = Some(TableRefConfig {
        interface_uuid: base.uuid.to_string(),
    });
    let mut bad_ref = column("wrong", ValueType::TableRef);
    bad_ref.table_ref_config = Some(TableRefConfig {
        interface_uuid: wrong.uuid.to_string(),
    });
    let mut row_ref = column("row", ValueType::Reference);
    row_ref.reference_config = Some(ReferenceConfig {
        target_table_uuid: input.uuid.clone(),
        display_column_uuid: None,
    });
    let mut root = data(
        "Root",
        vec![column("total", ValueType::I32), table_ref, bad_ref, row_ref],
        &[&[]],
    );
    root.records[0].set_value("target", input.uuid.clone());
    root.records[0].set_value("wrong", input.uuid.clone());
    root.records[0].set_value("row", input.records[0].uuid.clone());
    insert(&mut project, &root, true);
    let path = insert(&mut project, &input, true);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    expect(
        &context,
        &root,
        "=REDUCE(TABLE(target),0,(a,r)=>a+r.value)",
        Some("10"),
    );
    expect(
        &context,
        &root,
        "=REDUCE(TABLE(wrong),0,(a,r)=>a+r.value)",
        None,
    );
    expect(
        &context,
        &root,
        "=REDUCE([row],0,(a,r)=>a+r.value)",
        Some("10"),
    );
    drop(context);
    project.tables_data.get_mut(&path).unwrap().data.records[0].min_version = 2;
    let context = ProjectFormulaContext::new(&project, Some(1)).unwrap();
    expect(
        &context,
        &root,
        "=REDUCE(TABLE(target),0,(a,r)=>a+r.value)",
        Some("0"),
    );
    expect(&context, &root, "=REDUCE([row],0,(a,r)=>a+r.value)", None);
    drop(context);
    project.tables_data.get_mut(&path).unwrap().data.records[0].set_value("value", "999".into());
    expect(
        &ProjectFormulaContext::new(&project, None).unwrap(),
        &root,
        "=REDUCE(TABLE(target),0,(a,r)=>a+r.value)",
        None,
    );
}

#[test]
fn engine_only_cancel_during_disk_table() {
    use devcel_core::formula_engine::FormulaLimits;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("CancelDisk", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
    let mut input = data("Input", vec![column("value", ValueType::I32)], &[]);
    for i in 0..10000 {
        let mut row = Record::new();
        row.set_value("value", i.to_string());
        input.records.push(row);
    }
    insert(&mut project, &root, true);
    insert(&mut project, &input, false);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    let mut engine = FormulaEngine::with_context(&context, &root.uuid);
    engine.set_limits(FormulaLimits {
        allocated_bytes: 512 * 1024 * 1024,
        ..FormulaLimits::default()
    });
    let flag = Arc::new(AtomicBool::new(false));
    let other = flag.clone();
    engine.set_cancellation(Some(flag.clone()));
    let signal = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2));
        other.store(true, Ordering::Relaxed);
    });
    let result = engine.evaluate_column(
        "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)",
        &root.schema.columns[0],
        &root.records[0],
        &root.schema,
    );
    signal.join().unwrap();
    assert!(
        matches!(
            result,
            FormulaResult::Error(devcel_core::FormulaError::Cancelled)
        ),
        "{result:?}"
    );
    flag.store(false, Ordering::Relaxed);
    assert!(
        matches!(engine.evaluate_column("=REDUCE([1,2],0,(a,x)=>a+x)",&root.schema.columns[0],&root.records[0],&root.schema),FormulaResult::Value(v) if v=="3")
    );
}

#[test]
fn nested_recursive_expression_stack_safety() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut body = "f(n)".to_string();
    for _ in 0..50 {
        body = format!("1+({body})");
    }
    let formula = format!("=LETREC(f,n=>{body},f(1))");
    assert!(matches!(
        FormulaEngine::new().evaluate(&formula, "review", &record, &schema),
        FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))
    ));
}

#[test]
fn record_field_order_and_empty_callback_syntax() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut errors = vec![];
    for (formula, expected) in [
        ("=REDUCE([{a:1,b:2},{b:3,a:4}],0,(n,r)=>n+r.a)", Some("5")),
        (
            "=REDUCE([1,2],{a:0,b:0},(n,x)=>{b:n.b+x,a:n.a+x}).a",
            Some("3"),
        ),
        ("=REDUCE(MAP([],x=>x & 1),0,(a,x)=>a+x)", None),
        ("=REDUCE(MAP([],x=>x ||| 1),0,(a,x)=>a+x)", None),
        ("=REDUCE(MAP([],x=>[1,,2]),0,(a,x)=>a+x)", None),
    ] {
        let result = FormulaEngine::new().evaluate(formula, "review", &record, &schema);
        if !match (&result, expected) {
            (FormulaResult::Value(v), Some(e)) => v == e,
            (FormulaResult::Error(_), None) => true,
            _ => false,
        } {
            errors.push(format!("{formula}: {result:?}, expected {expected:?}"));
        }
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}

#[test]
fn lookup_preserves_return_type() {
    use devcel_core::types::ReferenceConfig;
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Lookup", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let target = data(
        "Target",
        vec![column("value", ValueType::I32)],
        &[&[("value", "10")]],
    );
    let mut reference = column("ref", ValueType::Reference);
    reference.reference_config = Some(ReferenceConfig {
        target_table_uuid: target.uuid.clone(),
        display_column_uuid: None,
    });
    let mut lookup = data(
        "Lookup",
        vec![
            column("key", ValueType::String),
            column("number", ValueType::I32),
            reference,
        ],
        &[&[("key", "a"), ("number", "10")]],
    );
    lookup.records[0].set_value("ref", target.records[0].uuid.clone());
    let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
    insert(&mut project, &target, false);
    insert(&mut project, &lookup, false);
    insert(&mut project, &root, true);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    expect(
        &context,
        &root,
        "=SAME(LOOKUP(\"Lookup\",\"key\",\"a\",\"number\"),10)?1:0",
        Some("1"),
    );
    expect(
        &context,
        &root,
        "=LET(r,LOOKUP(\"Lookup\",\"key\",\"a\",\"ref\"),r.value)",
        Some("10"),
    );
}

#[test]
fn small_stack_and_nested_dependencies_recover() {
    std::thread::Builder::new().stack_size(2*1024*1024).spawn(|| {
      let mut record=Record::new();let mut schema=TableSchema{columns:vec![]};
      for i in 0..80 {let name=format!("c{i}");let c=column(&name,ValueType::I32);record.set_value(&name,if i==79 {"1".into()} else {format!("=REDUCE([1],0,(a,x)=>a+c{})",i+1)});schema.columns.push(c);}
      let mut engine=FormulaEngine::new();
      let result=engine.evaluate_column(record.get_value("c0").unwrap(),&schema.columns[0],&record,&schema);
      assert!(matches!(result,FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))),"{result:?}");
      assert!(matches!(engine.evaluate("=REDUCE([1,2],0,(a,x)=>a+x)","review",&record,&schema),FormulaResult::Value(v) if v=="3"));
      let mut body="f(n)".to_string();for _ in 0..50 {body=format!("1+({body})");}
      let result=engine.evaluate(&format!("=LETREC(f,n=>{body},f(1))"),"review",&record,&schema);
      assert!(matches!(result,FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))));
      assert!(matches!(engine.evaluate("=REDUCE([1,2],0,(a,x)=>a+x)","review",&record,&schema),FormulaResult::Value(v) if v=="3"));
    }).unwrap().join().unwrap();
}

#[test]
fn large_cell_string_allocation_budget() {
    use devcel_core::formula_engine::FormulaLimits;
    let mut record = Record::new();
    record.set_value("large", "a".repeat(1024 * 1024));
    let schema = TableSchema {
        columns: vec![column("large", ValueType::String)],
    };
    let mut engine = FormulaEngine::new();
    engine.set_limits(FormulaLimits {
        allocated_bytes: 16 * 1024,
        ..FormulaLimits::default()
    });
    let result = engine.evaluate("=LET(s,large,LEN(s))", "review", &record, &schema);
    assert!(
        matches!(
            result,
            FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))
        ),
        "Large typed cell copied without charging: {result:?}"
    );
}

#[test]
fn ffi_sized_stacks_and_reuse() {
    for stack in [1024 * 1024, 512 * 1024, 128 * 1024] {
        std::thread::Builder::new().name(format!("review-stack-{stack}")).stack_size(stack).spawn(move|| {
        use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
        let mut record=Record::new();let mut schema=TableSchema{columns:vec![]};
        for i in 0..80 {let name=format!("c{i}");let c=column(&name,ValueType::I32);record.set_value(&name,if i==79 {"1".into()} else {format!("=REDUCE([1],0,(a,x)=>a+c{})",i+1)});schema.columns.push(c);}
        let mut engine=FormulaEngine::new();
        let result=engine.evaluate_column(record.get_value("c0").unwrap(),&schema.columns[0],&record,&schema);
        assert!(matches!(result,FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))),"{stack}: {result:?}");
        assert!(matches!(engine.evaluate("=REDUCE([1,2],0,(a,x)=>a+x)","review",&record,&schema),FormulaResult::Value(v) if v=="3"));
        let mut body="f(n)".to_string();for _ in 0..50 {body=format!("1+({body})");}
        let result=engine.evaluate(&format!("=LETREC(f,n=>{body},f(1))"),"review",&record,&schema);
        assert!(matches!(result,FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))),"{stack}: {result:?}");
        let flag=Arc::new(AtomicBool::new(true));engine.set_cancellation(Some(flag.clone()));
        assert!(matches!(engine.evaluate("=REDUCE([1,2],0,(a,x)=>a+x)","review",&record,&schema),FormulaResult::Error(devcel_core::FormulaError::Cancelled)));
        flag.store(false,Ordering::Relaxed);
        assert!(matches!(engine.evaluate("=REDUCE([1,2],0,(a,x)=>a+x)","review",&record,&schema),FormulaResult::Value(v) if v=="3"));
      }).unwrap().join().unwrap();
    }
}

#[test]
fn source_and_inventory_limits_recover() {
    use devcel_core::formula_engine::FormulaLimits;
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("SourceLimits", dir.path().to_str().unwrap(), "", "#000000")
            .unwrap();
    let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
    let input = data(
        "Input",
        vec![column("value", ValueType::I32)],
        &[&[("value", "42")]],
    );
    insert(&mut project, &root, true);
    insert(&mut project, &input, false);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    let mut engine = FormulaEngine::with_context(&context, &root.uuid);
    let formula = "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)";
    engine.set_limits(FormulaLimits {
        source_working_bytes: 1024,
        ..FormulaLimits::default()
    });
    let result = engine.evaluate_column(
        formula,
        &root.schema.columns[0],
        &root.records[0],
        &root.schema,
    );
    assert!(
        matches!(
            result,
            FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))
        ),
        "{result:?}"
    );
    assert_eq!(
        engine.statistics().source_memory_live_bytes,
        0,
        "Failed source read leaked reservations"
    );
    engine.set_limits(FormulaLimits::default());
    assert!(
        matches!(engine.evaluate_column(formula,&root.schema.columns[0],&root.records[0],&root.schema),FormulaResult::Value(v) if v=="42")
    );
    assert!(engine.statistics().source_memory_peak_bytes > 0);
    assert_eq!(
        engine.statistics().source_memory_live_bytes,
        0,
        "Completed root leaked source reservations"
    );
    for i in 0..200 {
        std::fs::create_dir(
            project
                .path
                .parent()
                .unwrap()
                .join("Tables")
                .join(format!("directory{i}")),
        )
        .unwrap();
    }
    engine.set_limits(FormulaLimits {
        allocated_bytes: 16 * 1024,
        ..FormulaLimits::default()
    });
    let result = engine.evaluate_column(
        formula,
        &root.schema.columns[0],
        &root.records[0],
        &root.schema,
    );
    assert!(
        matches!(
            result,
            FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))
        ),
        "{result:?}"
    );
    engine.set_limits(FormulaLimits::default());
    assert!(
        matches!(engine.evaluate_column(formula,&root.schema.columns[0],&root.records[0],&root.schema),FormulaResult::Value(v) if v=="42")
    );
}

#[test]
fn source_reservation_drop_and_failure_atomicity() {
    use devcel_core::formula_memory::{SourceBudget, TypedTableBacking};
    use std::sync::Arc;
    let budget = Arc::new(SourceBudget::new(100));
    let hold = budget.reserve(60).unwrap();
    assert_eq!((budget.used(), budget.peak(), budget.total()), (60, 60, 60));
    assert!(budget.reserve(50).is_err());
    assert!(budget.reserve(usize::MAX).is_err());
    assert_eq!((budget.used(), budget.peak(), budget.total()), (60, 60, 60));
    let backing = Arc::new(TypedTableBacking::new(
        Arc::new(data("Backing", vec![], &[])),
        hold,
    ));
    let row = backing.clone();
    drop(backing);
    assert_eq!(
        budget.used(),
        60,
        "An LRU eviction cannot free a live row's reservation"
    );
    drop(row);
    assert_eq!(budget.used(), 0);
    let full = budget.reserve(100).unwrap();
    assert_eq!(
        (budget.used(), budget.peak(), budget.total()),
        (100, 100, 160)
    );
    drop(full);
    assert_eq!(budget.used(), 0);
    let guards: Vec<_> = (0..10).map(|_| budget.reserve(10).unwrap()).collect();
    assert!(budget.reserve(1).is_err());
    drop(guards);
    assert_eq!(budget.used(), 0);
}

#[test]
fn cached_source_rebinds_new_root_budget() {
    use devcel_core::formula_engine::FormulaLimits;
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Rebind", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
    let input = data(
        "Input",
        vec![column("value", ValueType::I32)],
        &[&[("value", "42")]],
    );
    insert(&mut project, &root, true);
    insert(&mut project, &input, true);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    context.begin_snapshot().unwrap();
    let mut first = FormulaEngine::with_context(&context, &root.uuid);
    let formula = "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)";
    assert!(
        matches!(first.evaluate_column(formula,&root.schema.columns[0],&root.records[0],&root.schema),FormulaResult::Value(v) if v=="42")
    );
    assert!(
        first.statistics().source_memory_live_bytes > 0,
        "Explicit batch retains a lazy-row backing"
    );
    let mut second = FormulaEngine::with_context(&context, &root.uuid);
    second.set_limits(FormulaLimits {
        source_working_bytes: 1,
        ..FormulaLimits::default()
    });
    assert!(
        matches!(
            second.evaluate_column(
                formula,
                &root.schema.columns[0],
                &root.records[0],
                &root.schema
            ),
            FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))
        ),
        "Warm backing bypassed a new root's smaller source budget"
    );
    assert_eq!(second.statistics().source_memory_live_bytes, 0);
    second.set_limits(FormulaLimits::default());
    assert!(
        matches!(second.evaluate_column(formula,&root.schema.columns[0],&root.records[0],&root.schema),FormulaResult::Value(v) if v=="42")
    );
    context.finish_snapshot().unwrap();
    assert_eq!(first.statistics().source_memory_live_bytes, 0);
    assert_eq!(second.statistics().source_memory_live_bytes, 0);
}

#[test]
fn prebuilt_inventory_cannot_bypass_typed_budget() {
    use devcel_core::formula_engine::FormulaLimits;
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Prebuilt", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
    let input = data(
        "Input",
        vec![column("value", ValueType::I32)],
        &[&[("value", "42")]],
    );
    insert(&mut project, &root, true);
    insert(&mut project, &input, true);
    for i in 0..50 {
        let name = format!("Identity{i}_{}", "long_metadata_name_".repeat(4));
        let extra = data(&name, vec![], &[]);
        insert(&mut project, &extra, true);
    }
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    context.begin_snapshot().unwrap();
    let mut engine = FormulaEngine::with_context(&context, &root.uuid);
    engine.set_limits(FormulaLimits {
        allocated_bytes: 16 * 1024,
        ..FormulaLimits::default()
    });
    let result = engine.evaluate_column(
        "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)",
        &root.schema.columns[0],
        &root.records[0],
        &root.schema,
    );
    engine.set_limits(FormulaLimits::default());
    assert!(
        matches!(engine.evaluate_column("=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)",&root.schema.columns[0],&root.records[0],&root.schema),FormulaResult::Value(v) if v=="42"),
        "A failed adoption poisoned the next larger-budget root"
    );
    context.finish_snapshot().unwrap();
    assert!(
        matches!(
            result,
            FormulaResult::Error(devcel_core::FormulaError::ExecutionLimit(_))
        ),
        "Prebuilt unbudgeted inventory bypassed typed cap: {result:?}"
    );
}

#[test]
fn lazy_strict_mixed_roots_and_start_failure() {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Lazy", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
    let mut input = data(
        "Input",
        vec![
            column("key", ValueType::String),
            column("value", ValueType::I32),
        ],
        &[&[("key", "a"), ("value", "10")]],
    );
    insert(&mut project, &root, true);
    let path = insert(&mut project, &input, false);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    expect(
        &context,
        &root,
        "=LOOKUP(\"Input\",\"key\",\"a\",\"value\")",
        Some("10"),
    );
    let time = std::fs::metadata(&path).unwrap().modified().unwrap();
    input.records[0].set_value("value", "20".into());
    let updated = toml::to_string(&input).unwrap();
    std::fs::write(&path, &updated).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(time))
        .unwrap();
    expect(
        &context,
        &root,
        "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)",
        Some("20"),
    );
    std::fs::write(&path, "broken = [").unwrap();
    assert!(context.begin_snapshot().is_err());
    std::fs::write(&path, &updated).unwrap();
    context.begin_snapshot().unwrap();
    expect(
        &context,
        &root,
        "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)",
        Some("20"),
    );
    context.finish_snapshot().unwrap();
}

#[test]
fn lazy_strict_dependency_promotion_and_first_read_ledger() {
    use devcel_core::formula_context::FormulaQueryResolver;
    struct Mutating<'a> {
        context: &'a ProjectFormulaContext<'a>,
        path: std::path::PathBuf,
        updated: String,
        count: std::cell::Cell<usize>,
    }
    impl FormulaQueryResolver for Mutating<'_> {
        fn begin_evaluation(&self) -> Result<(), devcel_core::FormulaError> {
            self.context.begin_evaluation()
        }
        fn end_evaluation(
            &self,
            e: &mut FormulaEngine<'_>,
        ) -> Result<(), devcel_core::FormulaError> {
            self.context.end_evaluation(e)
        }
        fn begin_collection_snapshot(
            &self,
            e: &mut FormulaEngine<'_>,
        ) -> Result<(), devcel_core::FormulaError> {
            self.context.begin_collection_snapshot(e)
        }
        fn evaluate_query(
            &self,
            e: &mut FormulaEngine<'_>,
            n: &str,
            a: &[String],
        ) -> Result<devcel_core::formula_engine::collections::Value, devcel_core::FormulaError>
        {
            self.count.set(self.count.get() + 1);
            if self.count.get() == 2 {
                let time = std::fs::metadata(&self.path).unwrap().modified().unwrap();
                std::fs::write(&self.path, &self.updated).unwrap();
                std::fs::File::options()
                    .write(true)
                    .open(&self.path)
                    .unwrap()
                    .set_times(std::fs::FileTimes::new().set_modified(time))
                    .unwrap();
            }
            self.context.evaluate_query(e, n, a)
        }
    }
    for evict in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut project =
            Project::create_project("Promote", dir.path().to_str().unwrap(), "", "#000000")
                .unwrap();
        let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
        insert(&mut project, &root, true);
        let mut input = data(
            "Input",
            vec![
                column("key", ValueType::String),
                column("value", ValueType::I32),
            ],
            &[&[("key", "a"), ("value", "10")]],
        );
        let path = insert(&mut project, &input, false);
        input.records[0].set_value("value", "20".into());
        for name in ["B", "C", "D", "E", "Driver"] {
            let value = if name == "Driver" {
                "=REDUCE([1],0,(a,x)=>a+x)"
            } else {
                "1"
            };
            insert(
                &mut project,
                &data(
                    name,
                    vec![
                        column("key", ValueType::String),
                        column("value", ValueType::I32),
                    ],
                    &[&[("key", "a"), ("value", value)]],
                ),
                false,
            );
        }
        let context = ProjectFormulaContext::new(&project, None).unwrap();
        let wrapper = Mutating {
            context: &context,
            path,
            updated: toml::to_string(&input).unwrap(),
            count: std::cell::Cell::new(0),
        };
        let names = if evict {
            vec!["Input", "B", "C", "D", "E", "Input", "Driver"]
        } else {
            vec!["Input", "Driver"]
        };
        let formula = format!(
            "={}",
            names
                .iter()
                .map(|n| format!("LOOKUP(\"{n}\",\"key\",\"a\",\"value\")"))
                .collect::<Vec<_>>()
                .join("+")
        );
        let mut engine = FormulaEngine::with_context(&wrapper, &root.uuid);
        let result = engine.evaluate(&formula, "total", &root.records[0], &root.schema);
        assert!(
            matches!(
                result,
                FormulaResult::Error(devcel_core::FormulaError::DataChanged(_))
            ),
            "evict={evict}: {result:?}"
        );
        assert_eq!(wrapper.count.get(), names.len());
        expect(
            &context,
            &root,
            "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)",
            Some("20"),
        );
    }
}

#[test]
fn unselected_collection_does_not_scan_inventory() {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("LazyBranch", dir.path().to_str().unwrap(), "", "#000000").unwrap();
    let root = data(
        "Root",
        vec![
            column("total", ValueType::I32),
            column("later", ValueType::I32),
        ],
        &[&[("later", "=REDUCE(TABLE(\"Missing\"),0,(a,r)=>a+1)")]],
    );
    insert(&mut project, &root, true);
    std::fs::write(
        project
            .path
            .parent()
            .unwrap()
            .join("Tables/Broken.table.toml"),
        "broken = [",
    )
    .unwrap();
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    expect(&context, &root, "=IF(1,7,later)", Some("7"));
    expect(
        &context,
        &root,
        "=IF(1,7,REDUCE(TABLE(\"Missing\"),0,(a,r)=>a+1))",
        Some("7"),
    );
    expect(&context, &root, "=later", None);
}

#[test]
fn automatic_interface_reload_preserves_pending_and_recovers_from_conflict() {
    use devcel_core::{interface::InterfaceChange, Interface};
    let dir = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "InterfaceConflict",
        dir.path().to_str().unwrap(),
        "",
        "#000000",
    )
    .unwrap();
    let mut disk = Interface::new("Base".into(), None);
    let path = project
        .path
        .parent()
        .unwrap()
        .join("Tables/Base.interface.toml");
    disk.save_to_file(&path).unwrap();
    project.load_interfaces().unwrap();
    let baseline = project
        .interface_registry
        .get_interface(&disk.uuid)
        .unwrap()
        .clone();
    project
        .interface_registry
        .get_interface_mut(&disk.uuid)
        .unwrap()
        .create_new_version(
            vec![InterfaceChange::ChangeDescription {
                new_description: Some("unsaved local edit".into()),
            }],
            None,
            None,
        )
        .unwrap();
    // Unchanged disk must preserve the complete pending version graph.
    let pending = project
        .interface_registry
        .get_interface(&disk.uuid)
        .unwrap()
        .clone();
    project.reload_interfaces_preserving_pending().unwrap();
    assert_eq!(
        serde_json::to_value(
            project
                .interface_registry
                .get_interface(&disk.uuid)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&pending).unwrap()
    );
    disk.create_new_version(
        vec![InterfaceChange::ChangeDescription {
            new_description: Some("external edit".into()),
        }],
        None,
        None,
    )
    .unwrap();
    disk.save_to_file(&path).unwrap();
    // A conflict must neither replace live content nor advance its confirmed baseline.
    for _ in 0..2 {
        assert!(project.reload_interfaces_preserving_pending().is_err());
        assert_eq!(
            serde_json::to_value(
                project
                    .interface_registry
                    .get_interface(&disk.uuid)
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(&pending).unwrap()
        );
    }
    // Discarding the local edit permits the same context to publish the new disk state.
    *project
        .interface_registry
        .get_interface_mut(&disk.uuid)
        .unwrap() = baseline;
    project.reload_interfaces_preserving_pending().unwrap();
    assert_eq!(
        project
            .interface_registry
            .get_interface(&disk.uuid)
            .unwrap()
            .description
            .as_deref(),
        Some("external edit")
    );
    project.reload_interfaces_preserving_pending().unwrap();
}

#[cfg(unix)]
#[test]
fn automatic_interface_reload_rejects_foreign_symlinks_and_cycles() {
    use devcel_core::Interface;
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let foreign = Interface::new("Foreign".into(), None);
    let foreign_path = outside.path().join("Foreign.interface.toml");
    foreign.save_to_file(&foreign_path).unwrap();
    let mut project = Project::create_project(
        "ScopedInterfaces",
        dir.path().to_str().unwrap(),
        "",
        "#000000",
    )
    .unwrap();
    let tables = project.path.parent().unwrap().join("Tables");
    symlink(outside.path(), tables.join("outside")).unwrap();
    symlink(&foreign_path, tables.join("linked.interface.toml")).unwrap();
    symlink(&tables, tables.join("cycleA")).unwrap();
    symlink(&tables, tables.join("cycleB")).unwrap();
    project.reload_interfaces_preserving_pending().unwrap();
    assert!(project
        .interface_registry
        .get_interface(&foreign.uuid)
        .is_none());
    for name in ["outside", "linked.interface.toml", "cycleA", "cycleB"] {
        std::fs::remove_file(tables.join(name)).unwrap();
    }
    std::fs::remove_dir(&tables).unwrap();
    symlink(outside.path(), &tables).unwrap();
    assert!(project.reload_interfaces_preserving_pending().is_err());
    assert!(project
        .interface_registry
        .get_interface(&foreign.uuid)
        .is_none());
    std::fs::remove_file(&tables).unwrap();
    std::fs::create_dir(&tables).unwrap();
    project.reload_interfaces_preserving_pending().unwrap();
}

#[test]
fn diagnostic_literal_dependency_identity_and_context_reset() {
    use devcel_core::ReferenceConfig;
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Diagnostics", dir.path().to_str().unwrap(), "", "#000000")
            .unwrap();
    let input = data(
        "Input",
        vec![
            column("key", ValueType::String),
            column("value", ValueType::U8),
            column("invalid", ValueType::I32),
        ],
        &[&[("key", "a"), ("value", "999"), ("invalid", "not-a-number")]],
    );
    let mut reference = column("row", ValueType::Reference);
    reference.reference_config = Some(ReferenceConfig {
        target_table_uuid: input.uuid.clone(),
        display_column_uuid: None,
    });
    let mut root = data(
        "Root",
        vec![column("total", ValueType::I32), reference],
        &[&[]],
    );
    root.records[0].set_value("row", input.records[0].uuid.clone());
    insert(&mut project, &root, true);
    insert(&mut project, &input, true);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    for formula in [
        "=LET(r,row,r.value)",
        "=LET(v,LOOKUP(\"Input\",\"key\",\"a\",\"value\"),v)",
        "=LET(v,SUMIF(\"Input\",\"key\",\"a\",\"invalid\"),v)",
        "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.value)",
    ] {
        let result = context.evaluate_cell_with_override(
            &root,
            &root.schema.columns[0],
            &root.records[0],
            formula,
        );
        let FormulaResult::Error(error) = result else {
            panic!("{formula}: {result:?}")
        };
        let diagnostic = context.last_diagnostic().expect("diagnostic sidecar");
        assert!(
            diagnostic
                .frames
                .iter()
                .any(|f| f.cell.as_ref().is_some_and(|c| c.table_uuid.as_deref()
                    == Some(input.uuid.as_str())
                    && c.row_uuid.as_deref() == Some(input.records[0].uuid.as_str())
                    && c.column_uuid.as_deref()
                        == Some(
                            input.schema.columns[if formula.contains("SUMIF") { 2 } else { 1 }]
                                .uuid
                                .as_str()
                        ))),
            "{formula}: {diagnostic:?}"
        );
        assert_eq!(
            diagnostic.root.as_ref().unwrap().table_uuid.as_deref(),
            Some(root.uuid.as_str())
        );
        assert!(context
            .format_error(&error)
            .contains(&input.records[0].uuid));
        expect(&context, &root, "=REDUCE([1],0,(a,x)=>a+x)", Some("1"));
        assert!(context.last_diagnostic().is_none());
    }
}

#[test]
fn diagnostic_unicode_lambda_spans_and_success_clear() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    for formula in [
        "=LET(日本,1,REDUCE([1,0],0,(a,x)=>a+日本/x))",
        "=REDUCE([1,0],0,(a,x)=>a+1/x)",
        "=LET(s,\"あ\",REDUCE([1],0,(a,x)=>1/0))",
    ] {
        let result = engine.evaluate(formula, "total", &record, &schema);
        assert!(matches!(result, FormulaResult::Error(_)));
        let diagnostic = engine.last_diagnostic().unwrap();
        let locations: Vec<_> = diagnostic
            .frames
            .iter()
            .filter_map(|f| f.location.as_ref())
            .collect();
        assert!(!locations.is_empty(), "{diagnostic:?}");
        for location in &locations {
            assert!(
                formula
                    .get(location.span.start..location.span.end)
                    .is_some(),
                "Invalid UTF-8 source span {location:?}"
            );
        }
        assert!(
            locations
                .iter()
                .any(|l| formula[l.span.start..l.span.end].contains('/')),
            "{diagnostic:?}"
        );
        assert!(
            diagnostic.frames.iter().any(|f| f.element_index.is_some()),
            "{diagnostic:?}"
        );
        assert!(
            matches!(engine.evaluate("=IF(1,7,REDUCE([1],0,(a,x)=>1/0))","total",&record,&schema),FormulaResult::Value(v) if v=="7")
        );
        assert!(engine.last_diagnostic().is_none());
        assert!(
            matches!(engine.evaluate("=REDUCE([],9,(a,x)=>1/0)","total",&record,&schema),FormulaResult::Value(v) if v=="9")
        );
        assert!(engine.last_diagnostic().is_none());
    }
}

#[test]
fn diagnostic_presentation_includes_source_and_cell_identity() {
    let dir = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "PresentationDiagnostics",
        dir.path().to_str().unwrap(),
        "",
        "#000000",
    )
    .unwrap();
    let root = data(
        "Root",
        vec![column("total", ValueType::I32)],
        &[&[("total", "=REDUCE([1],0,(a,x)=>1/0)")]],
    );
    insert(&mut project, &root, true);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    for presentation in [
        devcel_core::cell_rules::presentation(&root),
        context.presentation(&root),
    ] {
        let errors: Vec<_> = presentation
            .cells
            .values()
            .flat_map(|r| r.values())
            .filter_map(|c| c.formula_error.as_ref())
            .collect();
        assert_eq!(errors.len(), 1);
        for diagnostic in errors {
            let text = serde_json::to_string(diagnostic).unwrap();
            assert!(text.contains("source bytes"), "{text}");
            assert!(text.contains(&root.uuid), "{text}");
            assert!(text.contains(&root.records[0].uuid), "{text}");
            assert!(text.contains(&root.schema.columns[0].uuid), "{text}");
        }
    }
}

#[test]
fn diagnostic_escaped_interpolation_and_dependency_source_provenance() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    for formula in [
        r#"="あ ""quoted"" ${1/0}""#,
        r#"="外 ${""内 ${1/0}""}""#,
        r#"=LET(s,"あ ""quoted"" ${REDUCE([1],0,(a,x)=>1/0)}",s)"#,
        r#"=LET(s,"外 ${""内 ${REDUCE([1],0,(a,x)=>1/0)}""}",s)"#,
    ] {
        assert!(matches!(
            engine.evaluate(formula, "total", &record, &schema),
            FormulaResult::Error(_)
        ));
        let diagnostic = engine.last_diagnostic().unwrap();
        let target = formula.find("1/0").unwrap();
        assert!(
            diagnostic
                .frames
                .iter()
                .filter_map(|f| f.location.as_ref())
                .any(|l| l.span.start == target && l.span.end == target + 3),
            "Exact original escaped-source offset not retained: {formula} {diagnostic:?}"
        );
    }
    let dir = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "SourceProvenance",
        dir.path().to_str().unwrap(),
        "",
        "#000000",
    )
    .unwrap();
    let dependency_formula = "=LET(日本,1,REDUCE([1],0,(a,x)=>日本/0))";
    let input = data(
        "Input",
        vec![column("bad", ValueType::I32)],
        &[&[("bad", dependency_formula)]],
    );
    let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
    insert(&mut project, &root, true);
    insert(&mut project, &input, true);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    let root_formula = "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.bad)";
    expect(&context, &root, root_formula, None);
    let diagnostic = context.last_diagnostic().unwrap();
    let mut saw_root = false;
    let mut saw_dependency = false;
    for location in diagnostic.frames.iter().filter_map(|f| f.location.as_ref()) {
        let cell = location.cell().expect("Source identity finalized");
        let source = if cell.table_uuid.as_deref() == Some(input.uuid.as_str()) {
            saw_dependency = true;
            assert_eq!(
                cell.row_uuid.as_deref(),
                Some(input.records[0].uuid.as_str())
            );
            dependency_formula
        } else if cell.table_uuid.as_deref() == Some(root.uuid.as_str()) {
            saw_root = true;
            root_formula
        } else {
            panic!("Unexpected source identity {cell:?}")
        };
        assert!(
            source.get(location.span.start..location.span.end).is_some(),
            "{location:?}"
        );
    }
    assert!(saw_root && saw_dependency, "{diagnostic:?}");
}

#[test]
fn diagnostic_limits_cancel_classification_and_reuse() {
    use devcel_core::{formula_engine::FormulaLimits, FormulaError};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    assert!(matches!(
        engine.evaluate("=LETREC(f,n=>f(n),f(1))", "total", &record, &schema),
        FormulaResult::Error(FormulaError::ExecutionLimit(_))
    ));
    let diagnostic = engine
        .take_diagnostic()
        .expect("recursion limit diagnostic");
    assert!(diagnostic.frames.len() <= 32);
    assert!(engine.last_diagnostic().is_none());
    engine.set_limits(FormulaLimits {
        steps: 10,
        ..FormulaLimits::default()
    });
    assert!(matches!(
        engine.evaluate(
            "=REDUCE(SEQUENCE(10000),0,(a,x)=>a+x)",
            "total",
            &record,
            &schema
        ),
        FormulaResult::Error(FormulaError::ExecutionLimit(_))
    ));
    engine.set_limits(FormulaLimits::default());
    let cancel = Arc::new(AtomicBool::new(true));
    engine.set_cancellation(Some(cancel.clone()));
    assert!(matches!(
        engine.evaluate("=REDUCE([1],0,(a,x)=>a+x)", "total", &record, &schema),
        FormulaResult::Error(FormulaError::Cancelled)
    ));
    cancel.store(false, Ordering::Relaxed);
    assert!(
        matches!(engine.evaluate("=REDUCE([1],0,(a,x)=>a+x)","total",&record,&schema),FormulaResult::Value(v) if v=="1")
    );
    assert!(engine.last_diagnostic().is_none());
}

#[test]
fn diagnostic_missing_field_and_join_pair_indices() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    assert!(matches!(
        engine.evaluate(
            "=REDUCE(JOIN([{v:1},{v:2}],[{v:3},{v:4}],(l,r)=>1/(r.v-4),\"INNER\"),0,(a,p)=>a+1)",
            "total",
            &record,
            &schema
        ),
        FormulaResult::Error(_)
    ));
    let diagnostic = engine.last_diagnostic().unwrap();
    assert!(
        diagnostic
            .frames
            .iter()
            .any(|f| f.left_index == Some(0) && f.right_index == Some(1)),
        "{diagnostic:?}"
    );
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("MissingField", dir.path().to_str().unwrap(), "", "#000000")
            .unwrap();
    let root = data("Root", vec![column("total", ValueType::I32)], &[&[]]);
    let input = data(
        "Input",
        vec![column("value", ValueType::I32)],
        &[&[("value", "1")]],
    );
    insert(&mut project, &root, true);
    insert(&mut project, &input, true);
    let context = ProjectFormulaContext::new(&project, None).unwrap();
    expect(
        &context,
        &root,
        "=REDUCE(TABLE(\"Input\"),0,(a,r)=>a+r.missing)",
        None,
    );
    let diagnostic = context.last_diagnostic().unwrap();
    assert!(
        diagnostic.frames.iter().any(|f| f
            .cell
            .as_ref()
            .is_some_and(|c| c.table_uuid.as_deref() == Some(input.uuid.as_str())
                && c.row_uuid.as_deref() == Some(input.records[0].uuid.as_str()))),
        "{diagnostic:?}"
    );
}

#[test]
fn diagnostic_type_boundaries_keep_precise_callback_spans() {
    // A rejected literal has cell identity, but no formula-source interval.
    let literal_record = Record::new();
    let literal_column = column("byte", ValueType::U8);
    let literal_schema = TableSchema {
        columns: vec![literal_column.clone()],
    };
    let mut literal_engine = FormulaEngine::new();
    assert!(matches!(
        literal_engine.evaluate_column("999", &literal_column, &literal_record, &literal_schema),
        FormulaResult::Error(_)
    ));
    let diagnostic = literal_engine
        .last_diagnostic()
        .expect("literal type diagnostic");
    let root = diagnostic.root.as_ref().expect("literal root identity");
    assert_eq!(root.row_uuid.as_deref(), Some(literal_record.uuid.as_str()));
    assert_eq!(
        root.column_uuid.as_deref(),
        Some(literal_column.uuid.as_str())
    );
    assert!(
        diagnostic
            .frames
            .iter()
            .all(|frame| frame.location.is_none()),
        "{diagnostic:?}"
    );
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    for (formula, fragment, index) in [
        (r#"=REDUCE([1,"x"],0,(a,x)=>a)"#, r#""x""#, Some(1)),
        (
            r#"=REDUCE(MAP([1,2],x=>x==1?1:"x"),0,(a,x)=>a)"#,
            r#"x==1?1:"x""#,
            Some(1),
        ),
        ("=REDUCE(FILTER([1],x=>{a:x}),0,(a,x)=>a)", "{a:x}", Some(0)),
        (
            "=REDUCE(GROUPBY([1],x=>{a:x}),0,(a,x)=>a)",
            "{a:x}",
            Some(0),
        ),
        (r#"=LET(s,"${MAP([1],x=>x)}",s)"#, "MAP([1],x=>x)", None),
    ] {
        assert!(
            matches!(
                engine.evaluate(formula, "total", &record, &schema),
                FormulaResult::Error(_)
            ),
            "{formula}"
        );
        let diagnostic = engine.last_diagnostic().unwrap();
        let start = formula.find(fragment).unwrap();
        assert!(
            diagnostic
                .frames
                .iter()
                .filter_map(|f| f.location.as_ref())
                .any(|l| l.span.start == start && l.span.end == start + fragment.len()),
            "{formula}: {diagnostic:?}"
        );
        if let Some(index) = index {
            assert!(
                diagnostic
                    .frames
                    .iter()
                    .any(|f| f.element_index == Some(index)),
                "{diagnostic:?}"
            );
        }
    }
}

#[test]
fn diagnostic_full_minimal_streaming_errors_include_source_identity() {
    use devcel_core::json_export::{
        export_runtime_bundle_to_file_with_validation, export_runtime_bundle_with_validation,
        ExportMode,
    };
    let dir = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "ExportDiagnostics",
        dir.path().to_str().unwrap(),
        "",
        "#000000",
    )
    .unwrap();
    let root = data(
        "Root",
        vec![column("total", ValueType::I32)],
        &[&[("total", "=REDUCE([1],0,(a,x)=>1/0)")]],
    );
    insert(&mut project, &root, true);
    for mode in [ExportMode::Full, ExportMode::Minimal] {
        let memory = match export_runtime_bundle_with_validation(&mut project, mode, None, true) {
            Err(error) => error.to_string(),
            Ok(_) => panic!("Invalid formula exported successfully"),
        };
        let stream = export_runtime_bundle_to_file_with_validation(
            &mut project,
            mode,
            None,
            true,
            dir.path().join("result.json"),
        )
        .unwrap_err()
        .to_string();
        for text in [memory, stream] {
            assert!(text.contains("source bytes"), "{text}");
            assert!(text.contains(&root.uuid), "{text}");
            assert!(text.contains(&root.records[0].uuid), "{text}");
            assert!(text.contains(&root.schema.columns[0].uuid), "{text}");
        }
    }
}

#[test]
fn token_buffer_boundaries_preserve_values_and_utf8_spans() {
    let record = Record::new();
    let empty = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    for (formula, expected) in [
        ("=1+1+1+1+1+1+1+1", "8"),   // 15 top-level tokens
        ("=-1+1+1+1+1+1+1+1", "6"),  // 16
        ("=1+1+1+1+1+1+1+1+1", "9"), // 17
        ("=SUM(1,1,1,1,1,1,1,1)", "8"),
        ("=SUM(11,1,1,1,1,1,1,1)", "18"),
        ("=SUM(1,1,1,1,1,1,1,1,1)", "9"),
        ("=REDUCE([1,2,3,4,5,6,7,8,9],0,(a,x)=>a+x)", "45"),
        ("=CONCAT(\"日本\"\"語\",\"([{\",\"${1+2}\")", "日本\"語([{3"),
    ] {
        assert!(
            matches!(engine.evaluate(formula, "result", &record, &empty),
            FormulaResult::Value(value) if value == expected),
            "{formula}"
        );
    }
    for size in [15, 16, 17, 48] {
        let name = "列".repeat(size);
        let mut named = column(&name, ValueType::I32);
        named.default_value = "3".into();
        let schema = TableSchema {
            columns: vec![named],
        };
        let formula = format!("={name}");
        assert!(
            matches!(engine.evaluate(&formula, "result", &record, &schema),
            FormulaResult::Value(value) if value == "3")
        );
        let formula = format!("={}1{}", "(".repeat(size), ")".repeat(size));
        assert!(
            matches!(engine.evaluate(&formula, "result", &record, &empty),
            FormulaResult::Value(value) if value == "1")
        );
        let invalid = format!("={}1{}]", "(".repeat(size), ")".repeat(size - 1));
        assert!(matches!(
            engine.evaluate(&invalid, "result", &record, &empty),
            FormulaResult::Error(devcel_core::FormulaError::ParseError(_))
        ));
        for formula in [
            format!("={name}+1/0"),
            format!("=\"日本${{{name}+1/0}}\""),
            format!("=\"日本\"\"語${{{name}+1/0}}\""),
        ] {
            assert!(
                matches!(
                    engine.evaluate(&formula, "result", &record, &schema),
                    FormulaResult::Error(devcel_core::FormulaError::DivisionByZero)
                ),
                "{formula}"
            );
            let start = formula.find("1/0").unwrap();
            let diagnostic = engine.last_diagnostic().unwrap();
            assert!(
                diagnostic
                    .frames
                    .iter()
                    .filter_map(|f| f.location.as_ref())
                    .any(|location| location.span.start == start && location.span.end == start + 3),
                "{formula}: {diagnostic:?}"
            );
            for location in diagnostic.frames.iter().filter_map(|f| f.location.as_ref()) {
                assert!(formula
                    .get(location.span.start..location.span.end)
                    .is_some());
            }
        }
    }
}

#[test]
fn scalar_numeric_builtins_preserve_float_kind_between_calls() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    for expression in [
        "=SUM(1e38,1e38)",
        "=AVG(1e38,1e38)",
        "=SUM(SUM(1e38,1e38),1e38)",
        "=SUM(ABS(-1e38),MAX(1e38,0.0))",
    ] {
        assert!(
            matches!(
                engine.evaluate(expression, "audit", &record, &schema),
                FormulaResult::Value(_)
            ),
            "{expression}"
        );
    }
    for expression in [
        "=SUM(9007199254740993,0.0)",
        "=AVG(9007199254740993,0.0)",
        "=SUM(9007199254740993,MIN(0.0,1.0))",
    ] {
        assert!(
            matches!(
                engine.evaluate(expression, "audit", &record, &schema),
                FormulaResult::Error(_)
            ),
            "{expression} must enforce mixed arithmetic precision"
        );
    }
    let sum = engine.evaluate("=SUM(1e38,1e38)", "audit", &record, &schema);
    let direct = engine.evaluate("=1e38+1e38", "audit", &record, &schema);
    match (sum, direct) {
        (FormulaResult::Value(a), FormulaResult::Value(b)) => assert_eq!(a, b),
        _ => panic!("SUM and direct arithmetic must both produce values"),
    };
}

#[test]
fn unknown_collection_fields_refine_independently_of_record_order() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    let elements = ["{xs:[]}", "{xs:[1]}", "{xs:[\"a\"]}"];
    for a in 0..3 {
        for b in 0..3 {
            for c in 0..3 {
                if a == b || b == c || a == c {
                    continue;
                }
                let expression = format!(
                    "=REDUCE([{},{},{}],0,(n,r)=>n+1)",
                    elements[a], elements[b], elements[c]
                );
                assert!(
                    matches!(
                        engine.evaluate(&expression, "audit", &record, &schema),
                        FormulaResult::Error(_)
                    ),
                    "{expression}"
                );
            }
        }
    }
    for expression in [
        "=REDUCE([{xs:[]},{xs:[1]},{xs:[2]}],0,(n,r)=>n+1)",
        "=REDUCE([{nested:{xs:[]}},{nested:{xs:[1]}},{nested:{xs:[2]}}],0,(n,r)=>n+1)",
    ] {
        assert!(
            matches!(engine.evaluate(expression,"audit",&record,&schema),FormulaResult::Value(value) if value=="3")
        );
    }
}
