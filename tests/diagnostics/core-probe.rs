use devcel_core::{
    cell_rules,
    table_mutation::{self, CellPatch, TableMutation},
    Project, TableData,
};
use std::{fs, path::PathBuf, time::Instant};
fn mem() -> serde_json::Value {
    let status = fs::read_to_string("/proc/self/status").unwrap();
    let mut v = serde_json::Map::new();
    for l in status.lines() {
        if l.starts_with("VmRSS:") || l.starts_with("VmHWM:") {
            let mut s = l.split_whitespace();
            v.insert(
                s.next().unwrap().trim_end_matches(':').into(),
                s.next().unwrap().parse::<u64>().unwrap().into(),
            );
        }
    }
    serde_json::Value::Object(v)
}
fn timed<T>(phase: &str, f: impl FnOnce() -> T) -> T {
    let before = mem();
    let start = Instant::now();
    let r = f();
    println!(
        "PERF {}",
        serde_json::json!({"phase":phase,"ms":start.elapsed().as_secs_f64()*1000.,"before":before,"after":mem()})
    );
    r
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let path = PathBuf::from(&args[1]);
    let mode = args.get(2).map(String::as_str).unwrap_or("workflow");
    let rows: usize = args.get(3).map(|x| x.parse().unwrap()).unwrap_or(10000);
    let text = fs::read_to_string(path).unwrap();
    let mut data: TableData = timed("parse", || toml::from_str(&text).unwrap());
    data.records.truncate(rows);
    drop(text);
    let id = data.metadata.uuid.clone();
    if mode == "phases" {
        drop(timed("clone", || data.clone()));
        let s = timed("serialize", || toml::to_string(&data).unwrap());
        let value = timed("normalize_value", || toml::Value::try_from(&data).unwrap());
        let norm = timed("normalize_decode", || {
            value.try_into::<TableData>().unwrap()
        });
        let rev = timed("revision", || cell_rules::revision(&norm));
        drop(norm);
        drop(s);
        println!("REV {rev}");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "Probe",
        root.path().to_str().unwrap(),
        "Synthetic only",
        "#000000",
    )
    .unwrap();
    let file = project
        .path
        .parent()
        .unwrap()
        .join("Tables/Probe.table.toml");
    fs::write(&file, toml::to_string(&data).unwrap()).unwrap();
    let baseline = cell_rules::revision(&data);
    drop(data);
    timed("load", || project.load_table(&file).unwrap());
    for n in 0..2 {
        let data = &project.find_table_by_uuid(&id).unwrap().data;
        let request = TableMutation {
            table_uuid: id.clone(),
            expected_revision: cell_rules::revision(data),
            cells: vec![CellPatch {
                mode: None,
                record_uuid: data.records[if n == 0 { 0 } else { data.records.len() - 1 }]
                    .uuid
                    .clone(),
                column_uuid: data.schema.columns[0].uuid.clone(),
                value: format!("Tuning_{n}"),
            }],
            versions: vec![],
            create_records: vec![],
            delete_record_uuids: vec![],
            acknowledgement: None,
        };
        let result = timed(&format!("save{n}"), || {
            table_mutation::apply(&mut project, request, None).unwrap()
        });
        drop(timed("ipc_serialize", || {
            serde_json::to_vec(&result).unwrap()
        }));
        drop(result);
    }
    let final_rev = cell_rules::revision(&project.find_table_by_uuid(&id).unwrap().data);
    for n in 0..2 {
        timed(&format!("undo{n}"), || project.undo_command(&id).unwrap());
    }
    assert_eq!(
        baseline,
        cell_rules::revision(&project.find_table_by_uuid(&id).unwrap().data)
    );
    for n in 0..2 {
        timed(&format!("redo{n}"), || project.redo_command(&id).unwrap());
    }
    assert_eq!(
        final_rev,
        cell_rules::revision(&project.find_table_by_uuid(&id).unwrap().data)
    );
    drop(project);
    println!("END {}", mem());
    let disk: TableData = toml::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(final_rev, cell_rules::revision(&disk));
    println!("PASS rows={rows}");
}
