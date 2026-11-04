//! Reproducible formula-only benchmark; no project files or external services.
use devcel_core::{ColumnSchema, FormulaEngine, FormulaResult, Record, TableSchema, ValueType};
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;
struct Counting;
static TRACK: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        }
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(size as u64, Ordering::Relaxed);
        }
        System.realloc(ptr, layout, size)
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;
fn main() {
    let n = std::env::var("ITERATIONS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(10000);
    println!(
        "columns,scenario,mode,iterations,ns_per_eval,allocs_per_eval,allocated_bytes_per_eval"
    );
    for columns in [2, 100] {
        let schema = TableSchema {
            columns: (0..columns)
                .map(|i| ColumnSchema {
                    data_name: format!("c{i}"),
                    display_name: format!("Column {i}"),
                    data_type: ValueType::I32,
                    default_value: (i + 2).to_string(),
                    ..Default::default()
                })
                .collect(),
        };
        let record = Record::new();
        for (name, formula, expected) in [
            ("arithmetic", "=1+2*3", "7"),
            ("columns", "=c0*c1+10", "16"),
            ("interpolation", "=\"value=${c0*c1}\"", "value=6"),
            ("short_circuit", "=1 || (1/0)", "true"),
            ("conditional", "=c0>1 ? c0*c1 : 1/0", "6"),
        ] {
            for fresh in [false, true] {
                let mut engine = FormulaEngine::new();
                assert!(
                    matches!(engine.evaluate(formula, "output", &record, &schema), FormulaResult::Value(v) if v == expected)
                );
                ALLOCS.store(0, Ordering::Relaxed);
                BYTES.store(0, Ordering::Relaxed);
                let start = Instant::now();
                for _ in 0..n {
                    if fresh {
                        engine = FormulaEngine::new();
                    }
                    let result = engine.evaluate(
                        black_box(formula),
                        "output",
                        black_box(&record),
                        black_box(&schema),
                    );
                    match &result {
                        FormulaResult::Value(v) => assert_eq!(v, expected),
                        other => panic!("{other:?}"),
                    }
                    black_box(result);
                }
                let elapsed = start.elapsed().as_nanos() as f64 / n as f64;
                TRACK.store(true, Ordering::Relaxed);
                for _ in 0..100 {
                    if fresh {
                        engine = FormulaEngine::new();
                    }
                    black_box(engine.evaluate(formula, "output", &record, &schema));
                }
                TRACK.store(false, Ordering::Relaxed);
                let allocs = ALLOCS.load(Ordering::Relaxed) as f64 / 100.0;
                let bytes = BYTES.load(Ordering::Relaxed) as f64 / 100.0;
                println!(
                    "{columns},{name},{},{n},{elapsed:.1},{allocs:.1},{bytes:.1}",
                    if fresh {
                        "fresh_engine"
                    } else {
                        "reused_engine"
                    }
                );
            }
        }
    }
}
