//! Reproducible cross-table formula benchmark; no wall-clock assertions.
//! cargo run -p devcel-core --release --example reference_performance -- [inventory] [iterations]
//! Inventory tables are sparse (zero rows), not 100 x 100 materializations.
use devcel_core::formula_context::ProjectFormulaContext;
use devcel_core::{ColumnSchema, Project, Record, TableSchema, ValueType};
use std::time::Instant;
fn col(name: &str, kind: ValueType, default: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: kind,
        default_value: default.into(),
        ..Default::default()
    }
}
fn rss() -> String {
    std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .filter(|s| s.starts_with("VmRSS:") || s.starts_with("VmHWM:"))
        .collect::<Vec<_>>()
        .join(" ")
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let inventory: usize = args.get(1).and_then(|x| x.parse().ok()).unwrap_or(8);
    let iterations: usize = args.get(2).and_then(|x| x.parse().ok()).unwrap_or(100);
    assert!(inventory >= 8);
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("ReferencePerf", dir.path().to_str().unwrap(), "", "#000000")
            .unwrap();
    let mut paths = Vec::new();
    for i in 0..8 {
        let path = project
            .create_table(format!("t{i}.table.toml").into())
            .unwrap();
        project.load_table(&path).unwrap();
        paths.push(path);
    }
    let ids: Vec<_> = paths
        .iter()
        .map(|p| project.tables_data[p].data.uuid.clone())
        .collect();
    let rowids: Vec<_> = (0..8).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    for (i, path) in paths.iter().enumerate() {
        let t = &mut project.tables_data.get_mut(path).unwrap().data;
        t.metadata.data_name = format!("T{i}");
        let mut reference = col("next", ValueType::Reference, "");
        reference.reference_config = Some(devcel_core::types::ReferenceConfig {
            target_table_uuid: ids[(i + 1) % 8].clone(),
            display_column_uuid: None,
        });
        t.schema = TableSchema {
            columns: vec![
                reference,
                col("key", ValueType::String, ""),
                col("power", ValueType::I32, ""),
                col("formula", ValueType::I32, "=power+1"),
            ],
        };
        t.schema.columns.push(col("id", ValueType::String, ""));
        for j in 5..100 {
            t.schema
                .columns
                .push(col(&format!("c{j}"), ValueType::String, ""));
        }
        for r in 0..100 {
            let mut row = Record::new();
            if r == 99 {
                row.uuid = rowids[i].clone();
            }
            row.values
                .insert("next".into(), rowids[(i + 1) % 8].clone());
            row.values.insert("key".into(), format!("k{r}"));
            row.values.insert("power".into(), "42".into());
            row.values.insert("id".into(), row.uuid.clone());
            for j in 5..100 {
                row.values.insert(format!("c{j}"), "payload".into());
            }
            t.records.push(row);
        }
        Project::save_table(project.tables_data.get_mut(path).unwrap()).unwrap();
    }
    let mut template = project.tables_data[&paths[0]].data.clone();
    template.schema.columns.clear();
    template.records.clear();
    let tables = paths[0].parent().unwrap();
    for i in 8..inventory {
        let mut t = template.clone();
        t.uuid = uuid::Uuid::new_v4().to_string();
        t.metadata.data_name = format!("Sparse{i}");
        t.display_name = t.metadata.data_name.clone();
        t.schema.columns.clear();
        t.records.clear();
        std::fs::write(
            tables.join(format!("s{i}.table.toml")),
            toml::to_string(&t).unwrap(),
        )
        .unwrap();
    }
    println!(
        "inventory={inventory} iterations={iterations} dense_tables=8 rows=100 cols=100 {}",
        rss()
    );
    for loaded in [true, false] {
        if !loaded {
            for path in paths.iter().skip(1) {
                project.tables_data.remove(path);
            }
        }
        let t = &project.tables_data[&paths[0]].data;
        let result = col("result", ValueType::I32, "");
        let lookup_chain = |hops: usize| {
            let mut expr = format!("\"{}\"", rowids[1]);
            for i in 1..=hops {
                expr = format!(
                    "LOOKUP(\"T{i}\",\"id\",{expr},\"{}\")",
                    if i == hops { "power" } else { "next" }
                );
            }
            format!("={expr}")
        };
        let lookup_three = lookup_chain(3);
        let lookup_six = lookup_chain(6);
        let scenarios = [
            ("dot_one", "=next.power", 42),
            ("dot_three", "=next.next.next.power", 42),
            ("dot_six", "=next.next.next.next.next.next.power", 42),
            ("dot_formula", "=next.formula", 43),
            ("lookup_one", r#"=LOOKUP("T1","key","k99","power")"#, 42),
            ("lookup_three", lookup_three.as_str(), 42),
            ("lookup_six", lookup_six.as_str(), 42),
            ("countif", r#"=COUNTIF("T1","power","42")"#, 100),
            ("sumif", r#"=SUMIF("T1","power","42","power")"#, 4200),
        ];
        for (name, formula, expected) in scenarios {
            let context = ProjectFormulaContext::new(&project, None).unwrap();
            let start = Instant::now();
            let value = context
                .evaluate_cell_with_override(t, &result, &t.records[99], formula)
                .into_result()
                .unwrap();
            assert_eq!(value, expected.to_string());
            let cold = start.elapsed();
            let start = Instant::now();
            for _ in 0..iterations {
                assert_eq!(
                    context
                        .evaluate_cell_with_override(t, &result, &t.records[99], formula)
                        .into_result()
                        .unwrap(),
                    expected.to_string()
                );
            }
            let elapsed = start.elapsed();
            println!(
                "loaded={loaded} {name} cold_ms={:.3} repeat_ms={:.3} {}",
                cold.as_secs_f64() * 1000.,
                elapsed.as_secs_f64() * 1000.,
                rss()
            );
        }
    }
}
