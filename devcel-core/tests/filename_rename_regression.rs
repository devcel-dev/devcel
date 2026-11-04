//! Integration workflows: a file rename changes paths, never data identity.
use devcel_core::{
    file_save_queue::FileBasedSaveQueueManager, interface::Interface, utils::renamed_file_name,
    ColumnSchema, Project, Record, SetRecordLabelCommand,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

fn fixture() -> (tempfile::TempDir, Project, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "RenameContract",
        directory.path().to_str().unwrap(),
        "",
        "#fff",
    )
    .unwrap();
    let path = project
        .create_table("013_quests.table.toml".into())
        .unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.metadata.data_name = "quests".into();
    table.data.schema.columns = vec![ColumnSchema {
        data_name: "value".into(),
        display_name: "Value".into(),
        ..Default::default()
    }];
    let mut row = Record::new();
    row.set_value("value", "=1+2".into());
    table.data.records = vec![row];
    table.is_dirty = false;
    fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    let interface = Interface::new("Combatant".into(), None);
    project.add_interface(interface.clone()).unwrap();
    project.save_interface(&interface).unwrap();
    (directory, project, path)
}

#[test]
fn numeric_filename_round_trip_preserves_bytes_identity_and_table_history() {
    let (_dir, mut project, source) = fixture();
    let uuid = project.tables_data[&source].data.uuid.clone();
    let record = project.tables_data[&source].data.records[0].uuid.clone();
    project
        .execute_command(
            SetRecordLabelCommand::new(uuid.clone(), record, "history_marker".into()),
            None,
        )
        .unwrap();
    let bytes = fs::read(&source).unwrap();
    let data = serde_json::to_value(&project.tables_data[&source].data).unwrap();
    let history = project.tables_data[&source].undo_history.len();
    let next = project
        .rename_table_file(&source, "013_quest_journal", None)
        .unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(&next).unwrap(), bytes);
    assert_eq!(
        serde_json::to_value(&project.tables_data[&next].data).unwrap(),
        data
    );
    assert_eq!(project.tables_data[&next].undo_history.len(), history);
    assert_eq!(project.tables_data[&next].data.metadata.data_name, "quests");
    assert_eq!(
        project
            .rename_table_file(&next, "013_quests.table.toml", None)
            .unwrap(),
        source
    );
    assert_eq!(fs::read(&source).unwrap(), bytes);
    project.undo_command(&uuid).unwrap();
    assert_eq!(project.tables_data[&source].data.records[0].label, "");
    project.redo_command(&uuid).unwrap();
    assert_eq!(
        project.tables_data[&source].data.records[0].label,
        "history_marker"
    );
}

#[test]
fn interface_round_trip_preserves_complete_definition_and_does_not_replace_targets() {
    let (_dir, mut project, table) = fixture();
    let tables = table.parent().unwrap();
    let source = tables.join("Combatant.interface.toml");
    let bytes = fs::read(&source).unwrap();
    let interface = project.list_interfaces()[0].clone();
    let before = serde_json::to_value(&interface).unwrap();
    let next = project
        .rename_interface_file("Combatant.interface.toml", "001_Combatant")
        .unwrap();
    assert_eq!(fs::read(&next).unwrap(), bytes);
    assert!(!source.exists());
    assert_eq!(
        project
            .interface_registry
            .get_interface_path(&interface.uuid),
        Some("001_Combatant.interface.toml")
    );
    assert_eq!(
        serde_json::to_value(project.get_interface(&interface.uuid).unwrap()).unwrap(),
        before
    );
    assert_eq!(
        project
            .rename_interface_file("001_Combatant.interface.toml", "Combatant.interface.toml")
            .unwrap(),
        source
    );
    assert_eq!(fs::read(&source).unwrap(), bytes);
    let target = tables.join("002_taken.interface.toml");
    fs::write(&target, "KEEP").unwrap();
    assert!(project
        .rename_interface_file("Combatant.interface.toml", "002_taken")
        .is_err());
    assert_eq!(fs::read(&source).unwrap(), bytes);
    assert_eq!(fs::read_to_string(target).unwrap(), "KEEP");
    assert_eq!(
        project
            .interface_registry
            .get_interface_path(&interface.uuid),
        Some("Combatant.interface.toml")
    );
    // A later save follows the new registry path while the unchanged CAS baseline survives.
    let next = project
        .rename_interface_file("Combatant.interface.toml", "002_Combatant")
        .unwrap();
    let mut changed = project.get_interface(&interface.uuid).unwrap().clone();
    changed
        .create_new_version(
            vec![devcel_core::InterfaceChange::ChangeDescription {
                new_description: Some("after rename".into()),
            }],
            None,
            None,
        )
        .unwrap();
    project
        .save_interface_if_unchanged(&changed, &interface)
        .unwrap();
    assert!(!source.exists());
    assert!(fs::read_to_string(next).unwrap().contains("after rename"));
}

#[test]
fn invalid_names_collisions_dirty_and_stale_files_fail_without_losing_identity() {
    let (_dir, mut project, source) = fixture();
    let bytes = fs::read(&source).unwrap();
    for invalid in [
        "",
        " ",
        ".",
        "..",
        "../outside",
        "nested/other",
        "nested\\other",
        "bad\0name",
        "/absolute",
        "C:\\other",
        "bad\nname",
        "tail.",
        "tail ",
        "CON",
        "NUL.table.toml",
        ".table.toml",
    ] {
        assert!(
            project.rename_table_file(&source, invalid, None).is_err(),
            "{invalid:?}"
        );
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert!(project.tables_data.contains_key(&source));
    }
    for suffix in [".table.toml", ".interface.toml"] {
        for invalid in [
            "",
            "..",
            "../outside",
            "a/b",
            "a\\b",
            "a\0b",
            "COM1",
            "PRN",
            "bad*name",
        ] {
            assert!(renamed_file_name(invalid, suffix).is_err(), "{invalid:?}");
        }
        assert!(renamed_file_name(&"x".repeat(240), suffix).is_err());
        assert_eq!(
            renamed_file_name("013_日本語-quest log", suffix).unwrap(),
            format!("013_日本語-quest log{suffix}")
        );
    }
    let target = source.with_file_name("014_taken.table.toml");
    fs::write(&target, "KEEP").unwrap();
    assert!(project
        .rename_table_file(&source, "014_taken", None)
        .is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "KEEP");
    project.tables_data.get_mut(&source).unwrap().is_dirty = true;
    assert!(project
        .rename_table_file(&source, "014_dirty", None)
        .is_err());
    project.tables_data.get_mut(&source).unwrap().is_dirty = false;
    let mut external = project.tables_data[&source].data.clone();
    external.description = "external change".into();
    fs::write(&source, toml::to_string(&external).unwrap()).unwrap();
    assert!(project
        .rename_table_file(&source, "014_stale", None)
        .is_err());
    assert_eq!(project.tables_data[&source].data.description, "");
    let interface = project.list_interfaces()[0].uuid;
    let original = project
        .get_interface(&interface)
        .unwrap()
        .description
        .clone();
    project.get_interface_mut(&interface).unwrap().description = Some("unsaved".into());
    assert!(project
        .rename_interface_file("Combatant.interface.toml", "001_dirty")
        .is_err());
    project.get_interface_mut(&interface).unwrap().description = original;
    let path = source.with_file_name("Combatant.interface.toml");
    let mut disk = project.get_interface(&interface).unwrap().clone();
    disk.create_new_version(
        vec![devcel_core::InterfaceChange::ChangeDescription {
            new_description: Some("external".into()),
        }],
        None,
        None,
    )
    .unwrap();
    disk.save_to_file(&path).unwrap();
    assert!(project
        .rename_interface_file("Combatant.interface.toml", "001_stale")
        .is_err());
}

#[test]
fn dotted_table_filename_is_not_misclassified_as_an_interface_on_reopen() {
    let (_dir, mut project, source) = fixture();
    let next = project
        .rename_table_file(&source, "quest.interface.backup", None)
        .unwrap();
    let mut reopened = Project::open_project(project.path.to_str().unwrap()).unwrap();
    reopened.load_table(&next).unwrap();
    assert_eq!(
        reopened.tables_data[&next].data.metadata.data_name,
        "quests"
    );
    assert_eq!(reopened.list_interfaces().len(), 1);
    // A real interface in a nested directory uses the registry's native path key.
    let original = source.with_file_name("Combatant.interface.toml");
    let nested = source.parent().unwrap().join("nested");
    fs::create_dir(&nested).unwrap();
    fs::rename(original, nested.join("Combatant.interface.toml")).unwrap();
    reopened.reload_interfaces().unwrap();
    let relative = Path::new("nested").join("Combatant.interface.toml");
    let renamed = reopened
        .rename_interface_file(relative.to_str().unwrap(), "001_Combatant")
        .unwrap();
    assert_eq!(renamed, nested.join("001_Combatant.interface.toml"));
    let again = Project::open_project(project.path.to_str().unwrap()).unwrap();
    assert_eq!(again.list_interfaces()[0].name, "Combatant");
}

#[test]
fn delayed_queued_save_cannot_recreate_old_name_or_overwrite_destination() {
    let (_dir, mut project, source) = fixture();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let queue = Arc::new(FileBasedSaveQueueManager::new(runtime.handle().clone()));
    let bytes = fs::read(&source).unwrap();
    let mut stale = project.tables_data[&source].clone();
    stale.is_dirty = true;
    stale.data.description = "obsolete queued bytes".into();
    queue.enqueue_file_sync(
        source.clone(),
        stale.clone(),
        devcel_core::SavePriority::Normal,
    );
    let destination = source.with_file_name("013_quest_journal.table.toml");
    queue.enqueue_file_sync(
        destination.clone(),
        stale,
        devcel_core::SavePriority::Normal,
    );
    assert_eq!(
        project
            .rename_table_file(&source, "013_quest_journal", Some(&queue))
            .unwrap(),
        destination
    );
    runtime.block_on(async {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        queue.shutdown_all().await;
    });
    assert!(!source.exists());
    assert_eq!(fs::read(&destination).unwrap(), bytes);
}

#[test]
fn move_uses_same_atomic_queue_boundary_and_returns_actual_collision_free_path() {
    let (_dir, mut project, source) = fixture();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let queue = Arc::new(FileBasedSaveQueueManager::new(runtime.handle().clone()));
    let bytes = fs::read(&source).unwrap();
    let data = serde_json::to_value(&project.tables_data[&source].data).unwrap();
    let mut stale = project.tables_data[&source].clone();
    stale.is_dirty = true;
    stale.data.description = "obsolete move snapshot".into();
    queue.enqueue_file_sync(source.clone(), stale, devcel_core::SavePriority::Normal);
    let nested = source.parent().unwrap().join("nested");
    fs::create_dir(&nested).unwrap();
    let requested = nested.join("013_quests.table.toml");
    fs::write(&requested, "KEEP DESTINATION").unwrap();
    let destination = project
        .move_table_with_save_queue(source.clone(), requested.clone(), Some(&queue))
        .unwrap();
    assert_eq!(destination, nested.join("013_quests_1.table.toml"));
    runtime.block_on(async {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        queue.shutdown_all().await;
    });
    assert!(!source.exists());
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    assert_eq!(fs::read_to_string(&requested).unwrap(), "KEEP DESTINATION");
    assert_eq!(
        serde_json::to_value(&project.tables_data[&destination].data).unwrap(),
        data
    );
    assert!(!project.tables_data.contains_key(&source));
    assert_eq!(
        project
            .move_table_with_save_queue(destination, source.clone(), Some(&queue))
            .unwrap(),
        source
    );
    assert_eq!(fs::read(&source).unwrap(), bytes);
}

#[test]
fn failed_move_preserves_source_memory_uuid_and_history() {
    let (_dir, mut project, source) = fixture();
    let uuid = project.tables_data[&source].data.uuid.clone();
    let record = project.tables_data[&source].data.records[0].uuid.clone();
    project
        .execute_command(
            SetRecordLabelCommand::new(uuid.clone(), record, "preserved".into()),
            None,
        )
        .unwrap();
    let bytes = fs::read(&source).unwrap();
    let history = project.tables_data[&source].undo_history.len();
    let parent_file = source.with_file_name("blocked");
    fs::write(&parent_file, "KEEP").unwrap();
    assert!(project
        .move_table(source.clone(), parent_file.join("013_quests.table.toml"))
        .is_err());
    assert_eq!(fs::read(&source).unwrap(), bytes);
    assert_eq!(project.tables_data[&source].undo_history.len(), history);
    // Saturated collision allocation must fail before removing the live table.
    let nested = source.parent().unwrap().join("saturated");
    fs::create_dir(&nested).unwrap();
    for n in 0..=1000 {
        fs::write(
            nested.join(if n == 0 {
                "013_quests.table.toml".into()
            } else {
                format!("013_quests_{n}.table.toml")
            }),
            "KEEP",
        )
        .unwrap();
    }
    assert!(project
        .move_table(source.clone(), nested.join("013_quests.table.toml"))
        .is_err());
    assert_eq!(fs::read(&source).unwrap(), bytes);
    assert_eq!(project.tables_data[&source].undo_history.len(), history);
    project.undo_command(&uuid).unwrap();
    assert_eq!(project.tables_data[&source].data.records[0].label, "");
}

// Optional acceptance check against an isolated copy of the actual UI sample.
#[test]
fn actual_sample_round_trip_preserves_every_table_reference_formula_and_row_byte() {
    let Ok(sample) = std::env::var("DEVCEL_RENAME_SAMPLE") else {
        return;
    };
    let directory = tempfile::tempdir().unwrap();
    fn copy(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let p = entry.unwrap().path();
            if p.is_dir() {
                copy(&p, &to.join(p.file_name().unwrap()));
            } else if p.extension().is_some_and(|e| e == "toml")
                && !p.file_name().unwrap().to_string_lossy().starts_with('.')
            {
                fs::copy(&p, to.join(p.file_name().unwrap())).unwrap();
            }
        }
    }
    copy(Path::new(&sample), directory.path());
    let project_path = directory.path().join("GrowthRPG.devcelproj.toml");
    let mut project = Project::open_project(project_path.to_str().unwrap()).unwrap();
    let tables = directory.path().join("Tables");
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fs::read_dir(root)
            .unwrap()
            .filter_map(|entry| {
                let p = entry.unwrap().path();
                (p.extension().is_some_and(|e| e == "toml")
                    && !p.file_name().unwrap().to_string_lossy().starts_with('.'))
                .then(|| (p.file_name().unwrap().into(), fs::read(&p).unwrap()))
            })
            .collect()
    }
    let before = snapshot(&tables);
    for path in before
        .keys()
        .filter(|p| p.to_string_lossy().ends_with(".table.toml"))
    {
        project.load_table(&tables.join(path)).unwrap();
    }
    let data_before: BTreeMap<_, _> = project
        .tables_data
        .values()
        .map(|t| (t.data.uuid.clone(), serde_json::to_value(&t.data).unwrap()))
        .collect();
    let interfaces_before: BTreeMap<_, _> = project
        .list_interfaces()
        .iter()
        .map(|i| (i.uuid, serde_json::to_value(i).unwrap()))
        .collect();
    let old = tables.join("013_quests.table.toml");
    let next = project
        .rename_table_file(&old, "013_quest_journal", None)
        .unwrap();
    assert_eq!(
        fs::read(&next).unwrap(),
        before[Path::new("013_quests.table.toml")]
    );
    assert_eq!(project.tables_data[&next].data.metadata.data_name, "quests");
    let interface = project
        .rename_interface_file("Combatant.interface.toml", "001_Combatant")
        .unwrap();
    assert_eq!(
        fs::read(&interface).unwrap(),
        before[Path::new("Combatant.interface.toml")]
    );
    assert_eq!(
        project
            .tables_data
            .values()
            .map(|t| (t.data.uuid.clone(), serde_json::to_value(&t.data).unwrap()))
            .collect::<BTreeMap<_, _>>(),
        data_before
    );
    assert_eq!(
        project
            .list_interfaces()
            .iter()
            .map(|i| (i.uuid, serde_json::to_value(i).unwrap()))
            .collect::<BTreeMap<_, _>>(),
        interfaces_before
    );
    project
        .rename_table_file(&next, "013_quests.table.toml", None)
        .unwrap();
    project
        .rename_interface_file("001_Combatant.interface.toml", "Combatant.interface.toml")
        .unwrap();
    assert_eq!(snapshot(&tables), before);
    println!("Actual sample verified: {} table/interface files, {} loaded tables, {} interfaces; all UUIDs, internal names, references, formulas and row bytes unchanged", before.len(), data_before.len(), interfaces_before.len());
}
