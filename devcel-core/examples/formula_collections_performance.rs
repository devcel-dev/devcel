//! Reproducible collection benchmark and semantic checks; no timing assertions.
//! Run with `cargo run -p devcel-core --release --example formula_collections_performance`.
//! Optional settings: ITERATIONS=10 CASE_FILTER=table_.
use devcel_core::formula_context::ProjectFormulaContext;
use devcel_core::formula_engine::FormulaLimits;
use devcel_core::{
    ColumnSchema, FormulaEngine, FormulaError, FormulaResult, Project, Record, TableSchema,
    ValueType,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::Instant;

struct Counting;
static TRACK: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);
static NET: AtomicI64 = AtomicI64::new(0);
static PEAK: AtomicI64 = AtomicI64::new(0);
fn account(bytes: usize, delta: i64) {
    if TRACK.load(Ordering::Relaxed) {
        if bytes != 0 {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(bytes as u64, Ordering::Relaxed);
        }
        let current = NET.fetch_add(delta, Ordering::Relaxed) + delta;
        PEAK.fetch_max(current, Ordering::Relaxed);
    }
}
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            account(layout.size(), layout.size() as i64);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(layout);
        if !p.is_null() {
            account(layout.size(), layout.size() as i64);
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        account(0, -(layout.size() as i64));
        System.dealloc(ptr, layout);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let p = System.realloc(ptr, layout, size);
        if !p.is_null() {
            account(size, size as i64 - layout.size() as i64);
        }
        p
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn selected(name: &str) -> bool {
    std::env::var("CASE_FILTER").map_or(true, |filter| name.contains(&filter))
}
fn iterations() -> usize {
    std::env::var("ITERATIONS")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(10)
        .max(1)
}
fn syscr() -> Option<u64> {
    std::fs::read_to_string("/proc/self/io")
        .ok()?
        .lines()
        .find_map(|s| s.strip_prefix("syscr: ")?.trim().parse().ok())
}
fn rss_kib(field: &str) -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find_map(|s| {
            s.strip_prefix(field)?
                .split_whitespace()
                .next()?
                .parse()
                .ok()
        })
        .unwrap_or(0)
}
fn check(result: FormulaResult, expected: &str) {
    match result {
        FormulaResult::Value(value) => assert_eq!(value, expected),
        error => panic!("expected {expected}, got {error:?}"),
    }
}
fn measure(name: &str, rows: usize, evaluations: usize, n: usize, mut operation: impl FnMut()) {
    if !selected(name) {
        return;
    }
    let profile_first = std::env::var_os("PROFILE_FIRST").is_some();
    if profile_first {
        ALLOCS.store(0, Ordering::Relaxed);
        BYTES.store(0, Ordering::Relaxed);
        NET.store(0, Ordering::Relaxed);
        PEAK.store(0, Ordering::Relaxed);
        TRACK.store(true, Ordering::Relaxed);
    }
    let first = Instant::now();
    operation();
    let first_ns = first.elapsed().as_nanos();
    if profile_first {
        TRACK.store(false, Ordering::Relaxed);
        println!("# first-allocation {name}: allocs={} bytes={} peak_net_heap={} (first_ns is instrumented in this mode)", ALLOCS.load(Ordering::Relaxed), BYTES.load(Ordering::Relaxed), PEAK.load(Ordering::Relaxed));
    }
    let start = Instant::now();
    for _ in 0..n {
        operation();
    }
    let ns = start.elapsed().as_nanos() as f64 / n as f64;
    ALLOCS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    NET.store(0, Ordering::Relaxed);
    PEAK.store(0, Ordering::Relaxed);
    TRACK.store(true, Ordering::Relaxed);
    operation();
    TRACK.store(false, Ordering::Relaxed);
    let allocs = ALLOCS.load(Ordering::Relaxed);
    let bytes = BYTES.load(Ordering::Relaxed);
    let peak = PEAK.load(Ordering::Relaxed);
    let probe_start = syscr();
    let probe_end = syscr();
    let probe = probe_start.zip(probe_end).map(|(a, b)| b.saturating_sub(a));
    let io_start = syscr();
    operation();
    let io_end = syscr();
    let reads = io_start
        .zip(io_end)
        .zip(probe)
        .map(|((a, b), p)| b.saturating_sub(a).saturating_sub(p).to_string())
        .unwrap_or_else(|| "unavailable".into());
    println!(
        "{name},{rows},{evaluations},{n},{first_ns},{ns:.1},{allocs},{bytes},{peak},{reads},{},{}",
        rss_kib("VmRSS:"),
        rss_kib("VmHWM:")
    );
}
fn col(name: &str, kind: ValueType) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: kind,
        ..Default::default()
    }
}
struct Fixture {
    // Keep the directory alive until the project and all contexts are dropped.
    _directory: tempfile::TempDir,
    project: Project,
    output: PathBuf,
    source: PathBuf,
}
fn fixture(rows: usize, loaded: bool) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "CollectionPerformance",
        directory.path().to_str().unwrap(),
        "",
        "#000000",
    )
    .unwrap();
    let output = project.create_table("output.table.toml".into()).unwrap();
    let source = project.create_table("source.table.toml".into()).unwrap();
    project.load_table(&output).unwrap();
    project.load_table(&source).unwrap();
    {
        let table = &mut project.tables_data.get_mut(&source).unwrap().data;
        table.metadata.data_name = "Source".into();
        table.schema = TableSchema {
            columns: vec![
                col("id", ValueType::I64),
                col("bucket", ValueType::I64),
                col("value", ValueType::I64),
            ],
        };
        table.records = (1..=rows)
            .map(|i| {
                let mut row = Record::new();
                row.values.insert("id".into(), i.to_string());
                row.values.insert("bucket".into(), (i % 10).to_string());
                row.values.insert("value".into(), i.to_string());
                row
            })
            .collect();
    }
    {
        let table = &mut project.tables_data.get_mut(&output).unwrap().data;
        table.metadata.data_name = "Output".into();
        table.schema = TableSchema {
            columns: vec![col("result", ValueType::I64)],
        };
        table.records = (0..20).map(|_| Record::new()).collect();
    }
    Project::save_table(project.tables_data.get_mut(&source).unwrap()).unwrap();
    Project::save_table(project.tables_data.get_mut(&output).unwrap()).unwrap();
    if !loaded {
        project.tables_data.remove(&source);
    }
    Fixture {
        _directory: directory,
        project,
        output,
        source,
    }
}
fn semantics() {
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let mut engine = FormulaEngine::new();
    for (formula, expected) in [
        ("=REDUCE(MAP(FILTER([1,2,3,4,5,6,7,8],x=>x>4),(x,i)=>x*2+i),0,(a,x)=>a+x)","58"),
        ("=REDUCE(MAP(FILTER([4,1,4,2],x=>x>1),(x,i)=>x*10+i),0,(a,x)=>a*100+x)","404122"),
        ("=REDUCE([1,2,3],10,(a,x)=>a-x)","4"),
        ("=REDUCE(MAP([],x=>1/0),7,(a,x)=>a+x)","7"),
        ("=REDUCE(GROUPBY([2,1,2,3,1],x=>x),0,(a,g)=>a*10+g.key)","213"),
        ("=REDUCE(GROUPBY([2,1,2,3,1],x=>x),0,(a,g)=>a*1000+REDUCE(g.rows,0,(b,x)=>b*10+x))","22011003"),
        ("=REDUCE(JOIN([{v:1},{v:2}],[{v:3},{v:4}],(l,r)=>1,\"INNER\"),0,(a,p)=>a*100+p.left.v*10+p.right.v)","13142324"),
        ("=REDUCE(JOIN([{k:1},{k:2}],[{k:1,v:0}],(l,r)=>SAME(l.k,r.k),\"LEFT\"),0,(a,p)=>a+(HASROW(p.right)?10+p.right.v:1))","11"),
        ("=IF(1,7,REDUCE([1,2],0,(a,x)=>1/0))","7"),
    ] { check(engine.evaluate(formula,"check",&record,&schema),expected); }
    for formula in [
        "=REDUCE([1,2],0,(a,x)=>a+1/(2-x))",
        "=REDUCE(JOIN([],SEQUENCE(-1),(l,r)=>1,\"INNER\"),0,(a,p)=>a+1)",
        "=REDUCE(JOIN([{k:1}],[],(l,r)=>1,\"LEFT\"),0,(a,p)=>a+p.right.k)",
    ] {
        let first = format!("{:?}", engine.evaluate(formula, "check", &record, &schema));
        assert!(first.starts_with("Error("), "{first}");
        assert_eq!(
            first,
            format!("{:?}", engine.evaluate(formula, "check", &record, &schema))
        );
        check(engine.evaluate("=1+2", "check", &record, &schema), "3");
    }
    println!("# semantic checks: value, MAP/FILTER/index order, left-fold, JOIN left/right order, GROUPBY first/group order, short-circuit, repeated error identity and recovery passed");
}
fn limit_probe(name: &str, formula: &str, limits: FormulaLimits, expected_limit: bool) {
    if !selected(name) {
        return;
    }
    let schema = TableSchema { columns: vec![] };
    let record = Record::new();
    let mut engine = FormulaEngine::new();
    engine.set_limits(limits);
    let start = Instant::now();
    let result = engine.evaluate(formula, "limit", &record, &schema);
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    println!("# statistics {name}: {:?}", engine.statistics());
    if expected_limit {
        assert!(
            matches!(
                result,
                FormulaResult::Error(FormulaError::ExecutionLimit(_))
            ),
            "{name}: {result:?}"
        );
    } else {
        assert!(
            matches!(result, FormulaResult::Value(_)),
            "{name}: {result:?}"
        );
    }
    println!("# limit {name}: elapsed_ms={ms:.3} result={result:?}");
    check(engine.evaluate("=1+2", "limit", &record, &schema), "3");
}
fn diagnostics(
    name: &str,
    formula: &str,
    expected: &str,
    engine: &mut FormulaEngine<'_>,
    record: &Record,
    schema: &TableSchema,
) {
    if !selected(name) {
        return;
    }
    check(
        engine.evaluate(formula, "diagnostic", record, schema),
        expected,
    );
    println!("# statistics {name}: {:?}", engine.statistics());
}
fn main() {
    if std::env::var("CASE_FILTER").as_deref() == Ok("diagnostic_overhead") {
        let record = Record::new();
        let schema = TableSchema { columns: vec![] };
        let mut engine = FormulaEngine::new();
        println!("scenario,rows,cells_per_operation,iterations,first_ns,ns_per_operation,allocs_per_operation,allocated_bytes_per_operation,peak_net_heap_bytes,read_syscalls_per_operation,rss_kib,process_hwm_kib");
        for (name, formula, expected) in [
            (
                "diagnostic_overhead_interpolation_plain",
                r#"="あ quoted ${1+2}""#,
                "あ quoted 3",
            ),
            (
                "diagnostic_overhead_interpolation_doubled_quotes",
                r#"="あ ""quoted"" ${1+2}""#,
                r#"あ "quoted" 3"#,
            ),
            (
                "diagnostic_overhead_typed_doubled_quotes",
                r#"=LET(s,"あ ""quoted"" ${REDUCE([1],0,(a,x)=>a+x)}",s)"#,
                r#"あ "quoted" 1"#,
            ),
        ] {
            measure(name, 1, 1, iterations(), || {
                check(
                    engine.evaluate(black_box(formula), "result", &record, &schema),
                    expected,
                );
            });
        }
        for (name, formula) in [
            ("diagnostic_overhead_error_scalar", "=1/0"),
            (
                "diagnostic_overhead_error_callback",
                "=REDUCE([1,2,3],0,(a,x)=>a+1/(x-3))",
            ),
        ] {
            measure(name, 3, 1, iterations(), || {
                match engine.evaluate(black_box(formula), "result", &record, &schema) {
                    FormulaResult::Error(FormulaError::DivisionByZero)
                        if name.ends_with("scalar") => {}
                    FormulaResult::Error(FormulaError::EvaluationContext { context, source })
                        if name.ends_with("callback") =>
                    {
                        assert_eq!(context, "REDUCE: element index 2 (zero-based)");
                        assert!(matches!(*source, FormulaError::DivisionByZero));
                    }
                    other => panic!("unexpected error result: {other:?}"),
                }
            });
            check(engine.evaluate("=1+2", "result", &record, &schema), "3");
        }
        println!("# diagnostic overhead cases passed; success values, error variants and recovery are unchanged");
        return;
    }
    if std::env::var("CASE_FILTER").is_ok_and(|value| value == "cold_diagnostic") {
        for rows in [100usize, 1000, 10000] {
            let fixture = fixture(rows, false);
            let source_bytes = std::fs::metadata(&fixture.source).unwrap().len();
            let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
            let output = &fixture.project.tables_data[&fixture.output].data;
            let mut engine = FormulaEngine::with_context(&context, &output.uuid);
            ALLOCS.store(0, Ordering::Relaxed);
            BYTES.store(0, Ordering::Relaxed);
            NET.store(0, Ordering::Relaxed);
            PEAK.store(0, Ordering::Relaxed);
            TRACK.store(true, Ordering::Relaxed);
            let result = engine.evaluate_column(
                "=REDUCE(TABLE(\"Source\"),0,(a,r)=>a+r.value)",
                &output.schema.columns[0],
                &output.records[0],
                &output.schema,
            );
            TRACK.store(false, Ordering::Relaxed);
            let allocs = ALLOCS.load(Ordering::Relaxed);
            let bytes = BYTES.load(Ordering::Relaxed);
            let peak = PEAK.load(Ordering::Relaxed);
            check(result, &(rows * (rows + 1) / 2).to_string());
            assert_eq!(
                engine.statistics().source_memory_live_bytes,
                0,
                "source reservations survived a completed root"
            );
            println!("# cold-diagnostic rows={rows} source_bytes={source_bytes} allocs={allocs} bytes={bytes} peak_net_heap={peak} statistics={:?}", engine.statistics());
        }
        return;
    }
    if std::env::var("CASE_FILTER").is_ok_and(|value| value == "source_query_boundary") {
        let source_mib: usize = std::env::var("SOURCE_LIMIT_MIB")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(256);
        let rows: Vec<usize> = std::env::var("SOURCE_ROWS")
            .unwrap_or_else(|_| "9000,18000,36000,100000".into())
            .split(',')
            .map(|v| v.parse().unwrap())
            .collect();
        let queries = std::env::var("SOURCE_QUERIES").unwrap_or_else(|_| "LOOKUP,SUMIF".into());
        for rows in rows {
            for query in queries.split(',') {
                assert!(["LOOKUP", "SUMIF", "TABLE"].contains(&query));
                let fixture = fixture(rows, false);
                let source_bytes = std::fs::metadata(&fixture.source).unwrap().len();
                let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
                let output = &fixture.project.tables_data[&fixture.output].data;
                let mut engine = FormulaEngine::with_context(&context, &output.uuid);
                engine.set_limits(FormulaLimits {
                    source_working_bytes: source_mib * 1024 * 1024,
                    ..FormulaLimits::default()
                });
                let (formula, expected) = if query == "LOOKUP" {
                    (
                        format!("=LOOKUP(\"Source\",\"id\",\"{rows}\",\"value\")"),
                        rows.to_string(),
                    )
                } else if query == "TABLE" {
                    (
                        String::from("=REDUCE(TABLE(\"Source\"),0,(a,r)=>a+r.value)"),
                        (rows * (rows + 1) / 2).to_string(),
                    )
                } else {
                    (
                        "=SUMIF(\"Source\",\"bucket\",\"0\",\"value\")".into(),
                        (5 * (rows / 10) * (rows / 10 + 1)).to_string(),
                    )
                };
                ALLOCS.store(0, Ordering::Relaxed);
                BYTES.store(0, Ordering::Relaxed);
                NET.store(0, Ordering::Relaxed);
                PEAK.store(0, Ordering::Relaxed);
                TRACK.store(true, Ordering::Relaxed);
                let start = Instant::now();
                let result = engine.evaluate_column(
                    &formula,
                    &output.schema.columns[0],
                    &output.records[0],
                    &output.schema,
                );
                let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
                TRACK.store(false, Ordering::Relaxed);
                let allocs = ALLOCS.load(Ordering::Relaxed);
                let bytes = BYTES.load(Ordering::Relaxed);
                let peak = PEAK.load(Ordering::Relaxed);
                match &result {
                    FormulaResult::Value(value) => assert_eq!(value, &expected),
                    FormulaResult::Error(FormulaError::ExecutionLimit(_)) => {}
                    other => panic!("{query} {rows}: {other:?}"),
                }
                assert_eq!(
                    engine.statistics().source_memory_live_bytes,
                    0,
                    "source reservations survived a completed root"
                );
                println!("# source-query rows={rows} query={query} source_bytes={source_bytes} limit_mib={source_mib} instrumented_ms={elapsed_ms:.3} allocs={allocs} bytes={bytes} peak_net_heap={peak} statistics={:?} result={result:?}", engine.statistics());
                check(
                    engine.evaluate("=1+2", "source_limit", &output.records[0], &output.schema),
                    "3",
                );
            }
        }
        return;
    }
    let n = iterations();
    println!("# release benchmark; time excludes allocation accounting, one warm allocation/io probe; net heap peak is a proxy, not RSS");
    println!("# default limits: {:?}", FormulaLimits::default());
    semantics();
    println!("scenario,rows,cells_per_operation,iterations,first_ns,ns_per_operation,allocs_per_operation,allocated_bytes_per_operation,peak_net_heap_bytes,read_syscalls_per_operation,rss_kib,process_hwm_kib");
    let record = Record::new();
    let schema = TableSchema { columns: vec![] };
    let small = "=REDUCE(MAP(FILTER([1,2,3,4,5,6,7,8],x=>x>4),(x,i)=>x*2+i),0,(a,x)=>a+x)";
    let mut engine = FormulaEngine::new();
    measure("small_array", 8, 1, n * 100, || {
        check(
            engine.evaluate(black_box(small), "result", &record, &schema),
            "58",
        )
    });
    diagnostics("small_array", small, "58", &mut engine, &record, &schema);
    for rows in [100usize, 1000, 10000] {
        let formula = format!("=REDUCE(MAP(SEQUENCE({rows}),x=>x*2),0,(a,x)=>a+x)");
        let expected = (rows * (rows + 1)).to_string();
        measure(&format!("sequence_map_reduce_{rows}"), rows, 1, n, || {
            check(
                engine.evaluate(black_box(&formula), "result", &record, &schema),
                &expected,
            )
        });
        diagnostics(
            &format!("sequence_map_reduce_{rows}"),
            &formula,
            &expected,
            &mut engine,
            &record,
            &schema,
        );
    }
    for rows in [10usize, 100, 200, 300] {
        for high in [false, true] {
            if high && rows == 300 {
                continue;
            }
            let name = format!("join_{}_{rows}", if high { "high" } else { "low" });
            let predicate = if high { "1" } else { "SAME(l.k,r.k)" };
            let formula = format!("=LET(rows,MAP(SEQUENCE({rows}),x=>{{k:x}}),REDUCE(JOIN(rows,rows,(l,r)=>{predicate},\"INNER\"),0,(a,p)=>a+1))");
            let expected = (if high { rows * rows } else { rows }).to_string();
            measure(&name, rows, 1, n, || {
                check(
                    engine.evaluate(black_box(&formula), "result", &record, &schema),
                    &expected,
                )
            });
            diagnostics(&name, &formula, &expected, &mut engine, &record, &schema);
        }
    }
    for rows in [100usize, 1000, 10000] {
        for loaded in [true, false] {
            let fixture = fixture(rows, loaded);
            let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
            let output = &fixture.project.tables_data[&fixture.output].data;
            let formula = "=REDUCE(TABLE(\"Source\"),0,(a,r)=>a+r.value)";
            let expected = (rows * (rows + 1) / 2).to_string();
            let name = format!(
                "table_{}_{rows}",
                if loaded { "loaded" } else { "unloaded" }
            );
            measure(&name, rows, 1, n, || {
                check(
                    context.evaluate_cell_with_override(
                        output,
                        &output.schema.columns[0],
                        &output.records[0],
                        black_box(formula),
                    ),
                    &expected,
                )
            });
            let mut diagnostic_engine = FormulaEngine::with_context(&context, &output.uuid);
            diagnostics(
                &name,
                formula,
                &expected,
                &mut diagnostic_engine,
                &output.records[0],
                &output.schema,
            );
            if rows >= 1000 {
                let group = "=REDUCE(GROUPBY(TABLE(\"Source\"),r=>r.bucket),0,(a,g)=>a+REDUCE(g.rows,0,(b,r)=>b+r.value))";
                measure(
                    &format!(
                        "groupby_{}_{rows}",
                        if loaded { "loaded" } else { "unloaded" }
                    ),
                    rows,
                    1,
                    n,
                    || {
                        check(
                            context.evaluate_cell_with_override(
                                output,
                                &output.schema.columns[0],
                                &output.records[0],
                                black_box(group),
                            ),
                            &expected,
                        )
                    },
                );
                diagnostics(
                    &format!(
                        "groupby_{}_{rows}",
                        if loaded { "loaded" } else { "unloaded" }
                    ),
                    group,
                    &expected,
                    &mut diagnostic_engine,
                    &output.records[0],
                    &output.schema,
                );
            }
            if rows == 1000 {
                for shared in [false, true] {
                    let name = format!(
                        "multi_cell_{}_{}",
                        if loaded { "loaded" } else { "unloaded" },
                        if shared { "snapshot" } else { "roots" }
                    );
                    measure(&name, rows, 20, n, || {
                        if shared {
                            context.begin_snapshot().unwrap();
                        }
                        for row in &output.records {
                            check(
                                context.evaluate_cell_with_override(
                                    output,
                                    &output.schema.columns[0],
                                    row,
                                    black_box(formula),
                                ),
                                &expected,
                            );
                        }
                        if shared {
                            context.finish_snapshot().unwrap();
                        }
                    });
                }
                let mut preview = output.clone();
                preview.schema.columns[0].default_value = formula.into();
                measure(
                    &format!("preview_{}", if loaded { "loaded" } else { "unloaded" }),
                    rows,
                    20,
                    n,
                    || {
                        let presentation = context
                            .presentation_cancellable(black_box(&preview))
                            .unwrap();
                        assert_eq!(presentation.cells.len(), 20);
                        for row in presentation.cells.values() {
                            for cell in row.values() {
                                assert_eq!(cell.display_value, expected);
                                assert!(cell.formula_error.is_none());
                            }
                        }
                    },
                );
                for mode in [
                    devcel_core::json_export::ExportMode::Full,
                    devcel_core::json_export::ExportMode::Minimal,
                ] {
                    measure(
                        &format!(
                            "export_{mode:?}_{}",
                            if loaded { "loaded" } else { "unloaded" }
                        ),
                        rows,
                        20,
                        n,
                        || {
                            let json = devcel_core::json_export::export_table_as_json_in_project_with_validation(&fixture.project, black_box(&preview), mode, false).unwrap();
                            let exported: devcel_core::json_export::ExportTable =
                                serde_json::from_str(&json).unwrap();
                            assert_eq!(exported.records.len(), 20);
                            for (row, original) in exported.records.iter().zip(&preview.records) {
                                assert_eq!(row.id, original.uuid);
                                assert_eq!(row.values.get("result"), Some(&expected));
                            }
                        },
                    );
                }
                assert!(fixture.source.exists());
            }
        }
    }
    // Isolate schema-width cost without manufacturing 97 unused cell payloads per row.
    for columns in [3usize, 100] {
        let mut wide = fixture(1000, true);
        let source = &mut wide.project.tables_data.get_mut(&wide.source).unwrap().data;
        for i in 3..columns {
            source
                .schema
                .columns
                .push(col(&format!("unused{i}"), ValueType::String));
        }
        let context = ProjectFormulaContext::new(&wide.project, None).unwrap();
        let output = &wide.project.tables_data[&wide.output].data;
        let formula = "=REDUCE(TABLE(\"Source\"),0,(a,r)=>a+r.value)";
        measure(&format!("table_wide_{columns}_columns"), 1000, 1, n, || {
            check(
                context.evaluate_cell_with_override(
                    output,
                    &output.schema.columns[0],
                    &output.records[0],
                    formula,
                ),
                "500500",
            );
        });
    }
    if selected("source_budget_1mib") {
        let fixture = fixture(1000, false);
        let context = ProjectFormulaContext::new(&fixture.project, None).unwrap();
        let output = &fixture.project.tables_data[&fixture.output].data;
        let mut engine = FormulaEngine::with_context(&context, &output.uuid);
        engine.set_limits(FormulaLimits {
            source_working_bytes: 1024 * 1024,
            ..FormulaLimits::default()
        });
        let result = engine.evaluate(
            "=REDUCE(TABLE(\"Source\"),0,(a,r)=>a+r.value)",
            "source_limit",
            &output.records[0],
            &output.schema,
        );
        assert!(
            matches!(&result, FormulaResult::Error(FormulaError::ExecutionLimit(message)) if message.to_lowercase().contains("source")),
            "{result:?}"
        );
        println!(
            "# limit source_budget_1mib: {result:?}; statistics={:?}",
            engine.statistics()
        );
        check(
            engine.evaluate("=1+2", "source_limit", &output.records[0], &output.schema),
            "3",
        );
    }
    limit_probe(
        "sequence_items_100000",
        "=REDUCE(SEQUENCE(100000),0,(a,x)=>a+x)",
        FormulaLimits::default(),
        false,
    );
    limit_probe(
        "sequence_items_100001",
        "=REDUCE(SEQUENCE(100001),0,(a,x)=>a+x)",
        FormulaLimits::default(),
        true,
    );
    limit_probe("join_default_limit_1000","=LET(rows,MAP(SEQUENCE(1000),x=>{k:x}),REDUCE(JOIN(rows,rows,(l,r)=>SAME(l.k,r.k),\"INNER\"),0,(a,p)=>a+1))",FormulaLimits::default(),true);
    limit_probe("join_steps_isolated_1000", "=LET(rows,MAP(SEQUENCE(1000),x=>{k:x}),REDUCE(JOIN(rows,rows,(l,r)=>SAME(l.k,r.k),\"INNER\"),0,(a,p)=>a+1))", FormulaLimits { allocated_bytes: usize::MAX, ..FormulaLimits::default() }, true);
    limit_probe("join_items_400","=LET(rows,MAP(SEQUENCE(400),x=>{k:x}),REDUCE(JOIN(rows,rows,(l,r)=>1,\"INNER\"),0,(a,p)=>a+1))",FormulaLimits::default(),true);
    limit_probe("join_allocation_300", "=LET(rows,MAP(SEQUENCE(300),x=>{k:x}),REDUCE(JOIN(rows,rows,(l,r)=>1,\"INNER\"),0,(a,p)=>a+1))", FormulaLimits::default(), true);
    limit_probe(
        "allocation_1mib",
        "=REDUCE(MAP(SEQUENCE(10000),x=>{k:x}),0,(a,r)=>a+r.k)",
        FormulaLimits {
            allocated_bytes: 1024 * 1024,
            ..FormulaLimits::default()
        },
        true,
    );
    limit_probe(
        "steps_100",
        "=REDUCE(SEQUENCE(1000),0,(a,x)=>a+x)",
        FormulaLimits {
            steps: 100,
            ..FormulaLimits::default()
        },
        true,
    );
    println!("# all selected scenarios passed; allocation/step/item failures released evaluation state and reused the same engine successfully");
}
