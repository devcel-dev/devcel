//! Persisted unordered maps are key-sorted; meaningful sequence order is not.
use devcel_core::{
    cell_rules, file_save_queue::SaveableFile, ColumnSchema, Interface, Project, Record, TableData,
};
use std::collections::HashMap;

fn rebuild<K: Clone + Eq + std::hash::Hash + Ord, V: Clone>(
    map: &mut HashMap<K, V>,
    reverse: bool,
) {
    let mut entries: Vec<_> = map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    if reverse {
        entries.reverse();
    }
    *map = entries.into_iter().collect(); // A fresh random hash seed on every pass.
}
fn shuffle(data: &mut TableData, reverse: bool) {
    rebuild(&mut data.interface_implementations, reverse);
    for record in &mut data.records {
        rebuild(&mut record.values, reverse);
        rebuild(&mut record.interface_values, reverse);
        rebuild(&mut record.memo_texts, reverse);
    }
}
fn fixture() -> (tempfile::TempDir, Project, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "Ordered",
        root.path().to_str().unwrap(),
        "日本語\n",
        "#123456",
    )
    .unwrap();
    let path = project.create_table("Ordered.table.toml".into()).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns = ["zeta", "alpha", "middle"]
        .iter()
        .map(|name| ColumnSchema {
            data_name: (*name).into(),
            display_name: (*name).into(),
            ..Default::default()
        })
        .collect();
    for n in 0..3 {
        let mut record = Record::new();
        record.label = format!("row{n}\n日本語 🧪");
        record.tags = vec!["z".into(), "a".into()];
        for (key, value) in [
            ("zeta", "last"),
            ("alpha", "first"),
            ("middle", "quotes \" \\ \n \t"),
        ] {
            record.values.insert(key.into(), value.into());
        }
        for column in &table.data.schema.columns {
            record
                .memo_texts
                .insert(column.uuid.clone(), column.data_name.clone());
        }
        table.data.records.push(record);
    }
    std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    (root, project, path)
}
#[test]
fn every_table_writer_is_stable_and_one_cell_diff_is_local() {
    let (_root, mut project, path) = fixture();
    let table = project.tables_data.get_mut(&path).unwrap();
    Project::save_table(table).unwrap();
    let expected = std::fs::read_to_string(&path).unwrap();
    let original = serde_json::to_value(&table.data).unwrap();
    let original_revision = cell_rules::revision(&table.data);
    for n in 0..12 {
        shuffle(&mut table.data, n % 2 == 0);
        Project::save_table(table).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
        let copy = path.with_file_name("queue.table.toml");
        table.save_to_file(&copy).unwrap();
        assert_eq!(std::fs::read_to_string(copy).unwrap(), expected);
        table.data = toml::from_str(&expected).unwrap();
        assert_eq!(serde_json::to_value(&table.data).unwrap(), original);
        assert_eq!(cell_rules::revision(&table.data), original_revision);
    }
    table.data.records[1]
        .values
        .insert("alpha".into(), "changed".into());
    Project::save_table(table).unwrap();
    let edited = std::fs::read_to_string(&path).unwrap();
    assert_eq!(expected.lines().count(), edited.lines().count());
    let changed: Vec<_> = expected
        .lines()
        .zip(edited.lines())
        .filter(|(a, b)| a != b)
        .collect();
    assert_eq!(changed, vec![("alpha = \"first\"", "alpha = \"changed\"")]);
    // Column/row/tag order is semantic, so it survives serialization unchanged.
    table.data.schema.columns.reverse();
    table.data.records.reverse();
    Project::save_table(table).unwrap();
    let reloaded: TableData = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(&table.data).unwrap(),
        serde_json::to_value(&reloaded).unwrap()
    );
}
#[test]
fn interface_history_and_project_are_stable_across_reload() {
    let (root, project, _path) = fixture();
    let mut interface = Interface::new("OrderedInterface".into(), Some("日本語".into()));
    for n in 0..4 {
        interface
            .create_new_version(vec![], None, Some(format!("version{n}")))
            .unwrap();
    }
    let path = root.path().join("ordered.interface.toml");
    interface.save_to_file(&path).unwrap();
    let expected = std::fs::read_to_string(&path).unwrap();
    for n in 0..12 {
        rebuild(&mut interface.history, n % 2 == 0);
        interface.save_to_file(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
        interface = Interface::load_from_file(&path).unwrap();
    }
    let project_text = toml::to_string(&project.project_data).unwrap();
    let reloaded: devcel_core::project_impl::ProjectFileData =
        toml::from_str(&project_text).unwrap();
    assert_eq!(project_text, toml::to_string(&reloaded).unwrap());
}

#[test]
fn deterministic_child_process() {
    let Some(input) = std::env::var_os("DEVCEL_TOML_CHILD_INPUT") else {
        return;
    };
    let output = std::path::PathBuf::from(std::env::var_os("DEVCEL_TOML_CHILD_OUTPUT").unwrap());
    let table = devcel_core::table::Table {
        path: output.clone(),
        data: toml::from_str(&std::fs::read_to_string(input).unwrap()).unwrap(),
        is_dirty: false,
        undo_history: vec![],
        redo_history: vec![],
    };
    table.save_to_file(&output).unwrap();
}

#[test]
fn table_bytes_match_in_independent_processes() {
    let (_root, project, path) = fixture();
    Project::save_table(&project.tables_data[&path]).unwrap();
    let expected = std::fs::read(&path).unwrap();
    for n in 0..3 {
        let output = path.with_file_name(format!("child{n}.table.toml"));
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "deterministic_child_process"])
            .env("DEVCEL_TOML_CHILD_INPUT", &path)
            .env("DEVCEL_TOML_CHILD_OUTPUT", &output)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(std::fs::read(output).unwrap(), expected);
    }
}
