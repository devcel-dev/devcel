// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2024 Devcel Studio Contributors
// See devcel-studio/LICENSE in the complete source distribution.

//! Personal palette workflows against Studio's real settings-project transaction store.
#[path = "../src/app_settings_store.rs"]
mod app_settings_store;
#[path = "../src/color_swatch_settings_store.rs"]
mod apply_store;
#[path = "../src/settings_resources_store.rs"]
mod settings_resources_store;
#[path = "../src/settings_seed.rs"]
mod settings_seed;
#[path = "../src/settings_transactions_store.rs"]
mod store;
// These persistence fixtures intentionally use unversioned temporary roots.
// Version selection and migration are exercised by Studio's settings_profile tests.
mod settings_profile {
    use devcel_core::AppError;
    use std::path::Path;
    fn assert_unversioned(config: &Path) {
        assert!(config
            .components()
            .all(|part| part.as_os_str() != "settings-versions"));
        assert!(!config.join("profile.json").exists());
    }
    pub fn prepare(config: &Path) -> Result<(), AppError> {
        assert_unversioned(config);
        Ok(())
    }
    pub fn migration_source(config: &Path) -> Option<String> {
        assert_unversioned(config);
        None
    }
    pub fn reset_uninitialized(config: &Path, _expected: &str) -> Result<bool, AppError> {
        assert_unversioned(config);
        Ok(false)
    }
    pub fn recover_uninitialized(config: &Path, _original: &AppError) -> Result<bool, AppError> {
        assert_unversioned(config);
        Ok(false)
    }
}
// Locale selection does not participate in these persistence workflows.
mod locale_settings {
    pub fn system_locale_for(locales: &[String]) -> String {
        locales
            .iter()
            .find(|value| value.as_str() == "en")
            .cloned()
            .unwrap_or_default()
    }
}
use devcel_core::{AppError, ColorSwatch, Project, ValueType};
use std::path::Path;
use std::sync::{Arc, Barrier};
fn swatch(name: &str) -> ColorSwatch {
    ColorSwatch {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        data_type: ValueType::ColorFloat,
        value: "[-0.25,4,0.5,0]".into(),
    }
}
fn stale_or_busy(error: &AppError) -> bool {
    matches!(error, AppError::Code{code,..} if code == "color.swatches.stale" || code == "settings.editorBusy")
}
fn save(
    config: &Path,
    revision: &str,
    swatches: Vec<ColorSwatch>,
) -> Result<store::UserColorSwatches, AppError> {
    let lease = app_settings_store::acquire_editor(config)?;
    let mut project = Project::open_project(&lease.project_path.to_string_lossy())?;
    store::transaction(
        config,
        &lease.generation,
        &mut project,
        None,
        revision,
        swatches,
    )
}
#[test]
fn load_save_restart_noop_and_clear_preserve_typed_values() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path();
    let empty = store::read(config).unwrap();
    assert!(empty.swatches.is_empty());
    assert!(app_settings_store::project_path(config).is_file());
    let mut hdr = swatch("  HDR glow  ");
    hdr.id = hdr.id.to_uppercase();
    let bytes = ColorSwatch {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Transparent".into(),
        data_type: ValueType::Color32,
        value: "[18, 171, 239, 0]".into(),
    };
    let saved = {
        let lease = app_settings_store::acquire_editor(config).unwrap();
        let mut project = Project::open_project(&lease.project_path.to_string_lossy()).unwrap();
        assert!(
            project.tables_data.is_empty(),
            "exercise a lazy settings editor"
        );
        let registry = devcel_core::TableData::from_toml(
            &std::fs::read_to_string(config.join("settings/Tables/PluginResources.table.toml"))
                .unwrap(),
        )
        .unwrap();
        assert!(
            registry.records.len() >= 2,
            "exercise multiple registered resource tables"
        );
        let mut catalog_project =
            Project::open_project(&lease.project_path.to_string_lossy()).unwrap();
        for entry in catalog_project.get_table_catalog().unwrap() {
            catalog_project
                .ensure_table_loaded_by_uuid(&entry.uuid)
                .unwrap();
        }
        let bindings = devcel_core::plugin_resource_registry::bindings(
            &registry,
            &catalog_project.tables_data,
            &catalog_project.interface_registry,
        )
        .unwrap();
        let edited_id = &bindings
            .iter()
            .find(|binding| binding.kind == devcel_core::plugin_resources::ResourceKind::Settings)
            .unwrap()
            .target_uuid;
        project.ensure_table_loaded_by_uuid(edited_id).unwrap();
        let edited = project
            .tables_data
            .values_mut()
            .find(|table| table.data.uuid == *edited_id)
            .unwrap();
        let resource_path = edited.path.clone();
        let resource_bytes = std::fs::read(&resource_path).unwrap();
        edited.data.display_name = "Uncommitted plugin label {literal} 日本語".into();
        edited.data.metadata.initial_transposed = !edited.data.metadata.initial_transposed;
        let (value_column, authored_value) = edited
            .data
            .schema
            .columns
            .iter()
            .filter(|column| column.data_type == ValueType::Select)
            .find_map(|column| {
                column
                    .select_config
                    .as_ref()?
                    .options
                    .iter()
                    .find(|option| {
                        edited.data.records[0].get_cell_value(column) != Some(&option.value)
                    })
                    .map(|option| (column.clone(), option.value.clone()))
            })
            .expect("seeded settings must offer a different valid scalar choice");
        edited.data.records[0].set_cell_value(&value_column, authored_value);
        edited.is_dirty = true;
        let authored = edited.data.clone();
        assert_eq!(
            project.tables_data.len(),
            1,
            "other registered tables remain unopened"
        );
        let saved = store::transaction(
            config,
            &lease.generation,
            &mut project,
            None,
            &empty.revision,
            vec![hdr, bytes],
        )
        .unwrap();
        for binding in &bindings {
            assert!(
                project
                    .find_table_by_uuid(&binding.registration_uuid)
                    .is_some(),
                "typed registration tables must also be loaded"
            );
            assert!(
                project.find_table_by_uuid(&binding.target_uuid).is_some(),
                "full settings validation must load every registered resource"
            );
        }
        let edited = project.find_table_by_uuid(edited_id).unwrap();
        assert_eq!(
            serde_json::to_value(&edited.data).unwrap(),
            serde_json::to_value(&authored).unwrap(),
            "palette save must retain loaded resource edits"
        );
        assert!(
            edited.is_dirty,
            "palette save must not acknowledge unrelated resource edits"
        );
        assert_eq!(
            std::fs::read(&resource_path).unwrap(),
            resource_bytes,
            "palette save must not persist unrelated resource edits"
        );
        saved
    };
    assert_eq!(saved.swatches[0].name, "HDR glow");
    assert_eq!(saved.swatches[0].value, "[-0.25,4.0,0.5,0.0]");
    assert_eq!(saved.swatches[1].value, "[18,171,239,0]");
    assert_ne!(saved.revision, empty.revision);
    assert_eq!(store::read(config).unwrap(), saved);
    assert_eq!(
        save(config, &saved.revision, saved.swatches.clone()).unwrap(),
        saved
    );
    assert!(stale_or_busy(
        &save(config, &empty.revision, saved.swatches.clone()).unwrap_err()
    ));
    let cleared = save(config, &saved.revision, vec![]).unwrap();
    assert!(cleared.swatches.is_empty());
    assert_ne!(cleared.revision, saved.revision);
    assert_eq!(store::read(config).unwrap(), cleared);
}
#[test]
fn malformed_input_and_persisted_source_are_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path();
    let initial = store::read(config).unwrap();
    let saved = save(config, &initial.revision, vec![swatch("Base")]).unwrap();
    let path = config.join("settings/Tables/UserColorFloatSwatches.table.toml");
    let good = std::fs::read(&path).unwrap();
    for (kind, value) in [
        (ValueType::ColorFloat, "[1,2,3,1.01]"),
        (ValueType::ColorFloat, "[1e40,0,0,1]"),
        (ValueType::Color32, "[1.5,0,0,255]"),
        (ValueType::String, "[1,2,3,4]"),
    ] {
        let mut invalid = swatch("Invalid");
        invalid.data_type = kind;
        invalid.value = value.into();
        assert!(save(config, &saved.revision, vec![invalid]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), good);
    }
    let corrupt = b"[invalid source";
    std::fs::write(&path, corrupt).unwrap();
    assert!(store::read(config).is_err());
    assert!(save(config, &saved.revision, vec![swatch("Overwrite")]).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), corrupt);
}
#[test]
fn concurrent_windows_have_one_writer_and_strict_readers_observe_committed_source() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path();
    let initial = store::read(config).unwrap();
    let barrier = Arc::new(Barrier::new(9));
    let writers: Vec<_> = (0..8)
        .map(|index| {
            let config = config.to_owned();
            let revision = initial.revision.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                save(&config, &revision, vec![swatch(&format!("Window {index}"))])
            })
        })
        .collect();
    barrier.wait();
    let mut winners = 0;
    for writer in writers {
        match writer.join().unwrap() {
            Ok(_) => winners += 1,
            Err(error) => assert!(stale_or_busy(&error), "{error}"),
        }
    }
    assert_eq!(winners, 1);
    let current = store::read(config).unwrap();
    assert_eq!(current.swatches.len(), 1);
    assert_eq!(store::read(config).unwrap(), current);
}
#[test]
fn child_process_store_writer() {
    let Ok(root) = std::env::var("DEVCEL_SWATCH_TEST_CHILD") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let revision = std::env::var("DEVCEL_SWATCH_TEST_REVISION").unwrap();
    while !root.join("start").exists() {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    match save(&root, &revision, vec![swatch("Process")]) {
        Ok(_) => {}
        Err(error) if stale_or_busy(&error) => std::process::exit(20),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(21)
        }
    }
}
#[test]
fn concurrent_processes_use_the_settings_editor_lock_and_revision() {
    let dir = tempfile::tempdir().unwrap();
    let initial = store::read(dir.path()).unwrap();
    let executable = std::env::current_exe().unwrap();
    let mut children: Vec<_> = (0..6)
        .map(|_| {
            std::process::Command::new(&executable)
                .args(["--exact", "child_process_store_writer", "--nocapture"])
                .env("DEVCEL_SWATCH_TEST_CHILD", dir.path())
                .env("DEVCEL_SWATCH_TEST_REVISION", &initial.revision)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap()
        })
        .collect();
    std::fs::write(dir.path().join("start"), "go").unwrap();
    let mut success = 0;
    for child in &mut children {
        match child.wait().unwrap().code() {
            Some(0) => success += 1,
            Some(20) => {}
            other => panic!("unexpected process exit {other:?}"),
        }
    }
    assert_eq!(success, 1);
    assert_eq!(store::read(dir.path()).unwrap().swatches.len(), 1);
}
#[test]
fn apply_requires_exact_precision_and_ui_color_requires_opaque_bytes() {
    let float = devcel_core::normalize_color_swatches(vec![swatch("HDR")])
        .unwrap()
        .remove(0);
    assert_eq!(
        apply_store::apply(float.clone(), "ColorFloat").unwrap(),
        "[-0.25,4.0,0.5,0.0]"
    );
    assert!(apply_store::apply(float.clone(), "Color32").is_err());
    assert!(apply_store::apply(float, "UiColor").is_err());
    let mut bytes = ColorSwatch {
        id: uuid::Uuid::new_v4().to_string(),
        name: "UI".into(),
        data_type: ValueType::Color32,
        value: "[18,171,239,255]".into(),
    };
    assert_eq!(
        apply_store::apply(bytes.clone(), "UiColor").unwrap(),
        "#12ABEF"
    );
    assert_eq!(
        apply_store::apply(bytes.clone(), "Color32").unwrap(),
        bytes.value
    );
    assert!(apply_store::apply(bytes.clone(), "ColorFloat").is_err());
    assert!(apply_store::apply(bytes.clone(), "unknown").is_err());
    bytes.value = "[18,171,239,0]".into();
    assert!(apply_store::apply(bytes.clone(), "UiColor").is_err());
    assert_eq!(
        apply_store::apply(bytes.clone(), "Color32").unwrap(),
        "[18,171,239,0]"
    );
    bytes.value = "[18, 171, 239, 255]".into();
    assert!(apply_store::apply(bytes, "UiColor").is_err());
}
