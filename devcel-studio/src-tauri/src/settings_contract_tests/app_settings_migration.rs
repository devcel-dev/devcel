// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2024 Devcel Studio Contributors
// See devcel-studio/LICENSE in the complete source distribution.

use toml08 as toml;

use super::*;
use devcel_core::app_settings_migration::*;
use toml::Value;
thread_local! { static VALIDATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
fn invalid(message: impl Into<String>) -> DevcelError {
    DevcelError::Validation(message.into())
}
fn merge_projects(base: &Path, user: &Path, next: &Path) -> Result<Vec<String>> {
    merge_projects_with_steps(base, user, next, &[])
}
fn merge_projects_with_steps(
    base: &Path,
    user: &Path,
    next: &Path,
    steps: &[MigrationStep<'_>],
) -> Result<Vec<String>> {
    let baseline = crate::settings_seed::message_contract()?;
    devcel_core::app_settings_migration::merge_projects_with_steps(
        base,
        user,
        next,
        steps,
        &|file| {
            VALIDATIONS.with(|count| count.set(count.get() + 1));
            devcel_core::app_catalog::compile_runtime(
                &devcel_core::localization::load(file)?,
                &baseline,
            )
            .map(|_| ())
        },
    )
}

const TEXT_SETTINGS: &str = "Tables/UserSettings.table.toml";
fn copy(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &target.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
        }
    }
}
fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let seed = seed_root();
    let paths = ["base", "user", "new"].map(|name| temp.path().join(name));
    for path in &paths {
        copy(&seed, path);
        edit(path, TEXT_SETTINGS, |data| {
            let index = data
                .schema
                .columns
                .iter()
                .position(|column| column.data_name == "pluginTheme")
                .unwrap();
            data.schema.columns.swap(0, index);
        });
    }
    let [base, user, new] = paths;
    (temp, base, user, new)
}
fn read(root: &Path, name: &str) -> TableData {
    toml::from_str(&fs::read_to_string(root.join(name)).unwrap()).unwrap()
}
fn edit(root: &Path, name: &str, f: impl FnOnce(&mut TableData)) {
    let mut data = read(root, name);
    f(&mut data);
    fs::write(root.join(name), data.to_toml().unwrap()).unwrap();
}
fn compiled(root: &Path) -> devcel_core::app_catalog::CompiledAppSettings {
    crate::settings_seed::compile_runtime(
        &devcel_core::localization::load(&root.join("studio.devcelproj.toml")).unwrap(),
    )
    .unwrap()
}
fn set_presets(root: &Path, presets: &[&str]) {
    let file = root.join("studio.devcelproj.toml");
    let mut value: Value = toml::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    value.as_table_mut().unwrap().insert(
        "tag_presets".into(),
        Value::Array(presets.iter().map(|v| Value::String((*v).into())).collect()),
    );
    fs::write(file, toml::to_string(&value).unwrap()).unwrap();
}
fn presets(root: &Path) -> Vec<String> {
    let data: devcel_core::project_impl::ProjectFileData =
        toml::from_str(&fs::read_to_string(root.join("studio.devcelproj.toml")).unwrap()).unwrap();
    data.tag_presets
}
fn add_retired_sample(root: &Path, greeting: &str, enabled: bool) {
    let mut sample = read(root, TEXT_SETTINGS);
    sample.uuid = "86fb28f4-3974-584c-9aa2-34d044d0c039".into();
    sample.metadata.data_name = "HelloWorldSettings".into();
    sample.schema.columns.truncate(1);
    sample.schema.columns[0].data_name = "greeting".into();
    sample.schema.columns[0].uuid = "150714fd-b36a-51d3-ae69-c31eaff1a479".into();
    sample.records[0].uuid = "406972c9-c93e-5633-8a00-ada2c728d86e".into();
    sample.records[0].values = [("greeting".into(), greeting.into())].into_iter().collect();

    fs::write(
        root.join("Tables/RetiredSample.table.toml"),
        sample.to_toml().unwrap(),
    )
    .unwrap();
    edit(root, "Tables/PluginStates.table.toml", |data| {
        let mut row = data.records[0].clone();
        row.uuid = "6cf1f0b5-5996-5750-810f-9704d49924ca".into();
        row.values.insert("pluginId".into(), "hello-world".into());
        row.values.insert("enabled".into(), enabled.to_string());
        data.records.push(row);
    });
}
#[test]
fn retired_sample_does_not_block_customized_profile_upgrade_or_touch_recovery() {
    let (_temp, base, user, new) = fixture();
    add_retired_sample(&base, "Hello", true);
    add_retired_sample(&user, "My saved greeting", false);
    let recovery = fs::read(user.join("Tables/RetiredSample.table.toml")).unwrap();
    let warnings = merge_projects(&base, &user, &new).unwrap();
    assert_eq!(warnings.len(), 2);
    assert!(!new.join("Tables/RetiredSample.table.toml").exists());
    assert!(!compiled(&new).plugin_states.contains_key("hello-world"));
    assert!(compiled(&new).plugin_states.contains_key("csv-exporter"));
    assert_eq!(
        fs::read(user.join("Tables/RetiredSample.table.toml")).unwrap(),
        recovery
    );
}
#[test]
fn repurposed_sample_table_and_plugin_row_remain_user_data() {
    let (_temp, base, user, new) = fixture();
    add_retired_sample(&base, "Hello", true);
    add_retired_sample(&user, "Personal notes", false);
    edit(&user, "Tables/RetiredSample.table.toml", |data| {
        data.metadata.data_name = "PersonalNotes".into()
    });
    edit(&user, "Tables/PluginStates.table.toml", |data| {
        data.records
            .iter_mut()
            .find(|row| row.values["pluginId"] == "hello-world")
            .unwrap()
            .values
            .insert("pluginId".into(), "user-plugin".into());
    });
    assert!(merge_projects(&base, &user, &new).unwrap().is_empty());
    assert_eq!(
        read(&new, "Tables/RetiredSample.table.toml")
            .metadata
            .data_name,
        "PersonalNotes"
    );
    assert_eq!(
        compiled(&new).plugin_states.get("user-plugin"),
        Some(&false)
    );
}
#[test]
fn user_tag_presets_and_assignments_survive_upgrade_without_metadata_overwrite() {
    let (_temp, base, user, new) = fixture();
    set_presets(&base, &["old", "removed"]);
    set_presets(&user, &["personal", "old"]);
    set_presets(&new, &["old", "removed", "new standard"]);
    edit(&user, TEXT_SETTINGS, |data| {
        data.records[0].tags = vec!["personal".into(), "orphan".into()]
    });
    let user_bytes = fs::read(user.join("studio.devcelproj.toml")).unwrap();
    let file = new.join("studio.devcelproj.toml");
    let mut metadata: Value = toml::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    metadata["project_description"] = Value::String("New release metadata".into());
    fs::write(&file, toml::to_string(&metadata).unwrap()).unwrap();
    merge_projects(&base, &user, &new).unwrap();
    assert_eq!(presets(&new), ["personal", "old", "new standard"]);
    assert_eq!(
        read(&new, TEXT_SETTINGS).records[0].tags,
        ["personal", "orphan"]
    );
    let actual: Value = toml::from_str(&fs::read_to_string(file).unwrap()).unwrap();
    metadata["tag_presets"] = actual["tag_presets"].clone();
    assert_eq!(actual, metadata);
    assert_eq!(
        fs::read(user.join("studio.devcelproj.toml")).unwrap(),
        user_bytes
    );
}
#[test]
fn concurrent_custom_and_new_standard_presets_both_survive() {
    let (_temp, base, user, new) = fixture();
    set_presets(&base, &[]);
    set_presets(&user, &["custom"]);
    set_presets(&new, &["builtin"]);
    merge_projects(&base, &user, &new).unwrap();
    assert_eq!(presets(&new), ["custom", "builtin"]);
}
#[test]
fn preset_reordering_and_deletion_preserve_new_defaults_without_duplicates() {
    let (_temp, base, user, new) = fixture();
    set_presets(&base, &["first", "removed", "last"]);
    set_presets(&user, &["last", "custom", "first", "new builtin"]);
    set_presets(
        &new,
        &["first", "removed", "last", "new builtin", "another builtin"],
    );
    merge_projects(&base, &user, &new).unwrap();
    assert_eq!(
        presets(&new),
        ["last", "custom", "first", "new builtin", "another builtin"]
    );
}
#[test]
fn unchanged_tag_presets_adopt_new_standard_without_rewriting_project_bytes() {
    let (_temp, base, user, new) = fixture();
    for root in [&base, &user] {
        set_presets(root, &["old"]);
    }
    set_presets(&new, &["new standard", "old"]);
    let bytes = fs::read(new.join("studio.devcelproj.toml")).unwrap();
    merge_projects(&base, &user, &new).unwrap();
    assert_eq!(presets(&new), ["new standard", "old"]);
    assert_eq!(fs::read(new.join("studio.devcelproj.toml")).unwrap(), bytes);
}
#[test]
fn rejected_upgrade_restores_project_registry_and_tables() {
    let (_temp, base, user, new) = fixture();
    set_presets(&user, &["personal"]);
    set_presets(&new, &["new standard"]);
    edit(&user, TEXT_SETTINGS, |data| {
        data.schema.columns[0].data_type = devcel_core::ValueType::I32;
        data.schema.columns[0].default_value = "1".into();
        data.records[0]
            .values
            .insert("pluginTheme".into(), "7".into());
    });
    let project_bytes = fs::read(new.join("studio.devcelproj.toml")).unwrap();
    let table_before = devcel_core::cell_rules::revision(&read(&new, TEXT_SETTINGS));
    assert!(merge_projects(&base, &user, &new).is_err());
    assert_eq!(
        fs::read(new.join("studio.devcelproj.toml")).unwrap(),
        project_bytes
    );
    assert_eq!(
        devcel_core::cell_rules::revision(&read(&new, TEXT_SETTINGS)),
        table_before
    );
}
#[test]
fn malformed_user_source_never_compiles_new_standard() {
    let (_temp, base, user, new) = fixture();
    let table = user.join("Tables/UserSettings.table.toml");
    fs::write(&table, "[invalid source").unwrap();
    let untouched = fs::read(new.join("Tables/UserSettings.table.toml")).unwrap();
    VALIDATIONS.with(|count| count.set(0));
    for _ in 0..2 {
        assert!(merge_projects(&base, &user, &new).is_err());
    }
    assert_eq!(VALIDATIONS.with(|count| count.get()), 0);
    assert_eq!(
        fs::read(new.join("Tables/UserSettings.table.toml")).unwrap(),
        untouched
    );
    assert_eq!(fs::read_to_string(table).unwrap(), "[invalid source");
}
#[test]
fn user_scalar_wins_and_unedited_new_standard_advances() {
    let (_temp, base, user, new) = fixture();
    edit(&user, TEXT_SETTINGS, |d| {
        d.records[0]
            .values
            .insert("pluginTheme".into(), "My greeting".into());
    });
    edit(&new, TEXT_SETTINGS, |d| {
        d.description = "New standard description".into();
        d.records[0]
            .values
            .insert("pluginTheme".into(), "New standard greeting".into());
    });
    let original = fs::read(user.join(TEXT_SETTINGS)).unwrap();
    assert!(merge_projects(&base, &user, &new).unwrap().is_empty());
    assert_eq!(compiled(&new).values.plugin_theme, "My greeting");
    assert_eq!(
        read(&new, TEXT_SETTINGS).description,
        "New standard description"
    );
    assert_eq!(fs::read(user.join(TEXT_SETTINGS)).unwrap(), original);
}
#[test]
fn added_user_and_standard_swatches_and_translations_survive() {
    let (_temp, base, user, new) = fixture();
    let swatches = "Tables/UserColor32Swatches.table.toml";
    for (root, name) in [(&user, "Personal"), (&new, "New standard")] {
        edit(root, swatches, |d| {
            let mut row = devcel_core::Record::new();
            row.values.insert("name".into(), name.into());
            row.values.insert("value".into(), "[12,34,56,255]".into());
            row.values.insert("order".into(), "0".into());
            d.records.push(row);
        });
    }
    let translation = "Tables/Translations/common.table.toml";
    edit(&user, translation, |d| {
        d.records[0]
            .values
            .insert("message".into(), "保存する".into());
    });
    merge_projects(&base, &user, &new).unwrap();
    assert_eq!(read(&new, swatches).records.len(), 2);
    assert_eq!(
        read(&new, translation).records[0].values["message"],
        "保存する"
    );
    compiled(&new);
}
#[test]
fn raw_absence_and_default_are_preserved() {
    let (_temp, base, user, new) = fixture();
    edit(&user, TEXT_SETTINGS, |d| {
        d.schema.columns[0].default_value = "Personal default".into();
        d.records[0].values.remove("pluginTheme");
    });
    merge_projects(&base, &user, &new).unwrap();
    let data = read(&new, TEXT_SETTINGS);
    assert!(!data.records[0].values.contains_key("pluginTheme"));
    assert_eq!(compiled(&new).values.plugin_theme, "Personal default");
}
#[test]
fn stable_uuid_rename_rekeys_user_values_and_preserves_move() {
    let (_temp, base, user, new) = fixture();
    for root in [&base, &user] {
        edit(root, TEXT_SETTINGS, |d| {
            d.schema.columns[0].data_name = "old_plugin_theme".into();
            let value = d.records[0].values.remove("pluginTheme").unwrap();
            d.records[0].values.insert("old_plugin_theme".into(), value);
        });
    }
    edit(&user, TEXT_SETTINGS, |d| {
        d.records[0]
            .values
            .insert("old_plugin_theme".into(), "Renamed input".into());
    });
    fs::rename(
        user.join(TEXT_SETTINGS),
        user.join("Tables/Moved.table.toml"),
    )
    .unwrap();
    merge_projects(&base, &user, &new).unwrap();
    assert!(!new.join(TEXT_SETTINGS).exists());
    assert_eq!(compiled(&new).values.plugin_theme, "Renamed input");
}
fn plus_one(raw: &str) -> Result<String> {
    raw.parse::<i64>()
        .map(|n| (n + 1).to_string())
        .map_err(|e| invalid(e.to_string()))
}
fn greeting(raw: &str) -> Result<String> {
    Ok(format!("Greeting {raw}"))
}
#[test]
fn explicit_type_steps_support_skipped_releases() {
    let (_temp, base, user, new) = fixture();
    for root in [&base, &user] {
        edit(root, TEXT_SETTINGS, |d| {
            d.schema.columns[0].data_type = devcel_core::ValueType::I32;
            d.schema.columns[0].default_value = "1".into();
            d.records[0].values.insert("pluginTheme".into(), "1".into());
        });
    }
    edit(&user, TEXT_SETTINGS, |d| {
        d.records[0].values.insert("pluginTheme".into(), "7".into());
    });
    let data = read(&base, TEXT_SETTINGS);
    let table_uuid = data.uuid.as_str();
    let column_uuid = data.schema.columns[0].uuid.as_str();
    let steps = [
        MigrationStep::ConvertColumn {
            table_uuid,
            column_uuid,
            from: devcel_core::ValueType::I32,
            to: devcel_core::ValueType::I64,
            convert: plus_one,
        },
        MigrationStep::ConvertColumn {
            table_uuid,
            column_uuid,
            from: devcel_core::ValueType::I64,
            to: devcel_core::ValueType::String,
            convert: greeting,
        },
    ];
    merge_projects_with_steps(&base, &user, &new, &steps).unwrap();
    assert_eq!(compiled(&new).values.plugin_theme, "Greeting 8");
}
#[test]
fn removal_requires_explicit_release_policy() {
    let (_temp, base, user, new) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    for root in [&base, &user] {
        edit(root, TEXT_SETTINGS, |d| {
            let mut column = d.schema.columns[0].clone();
            column.uuid = id.clone();
            column.data_name = "retired".into();
            d.schema.columns.push(column);
            d.records[0]
                .values
                .insert("retired".into(), "original".into());
        });
    }
    edit(&user, TEXT_SETTINGS, |d| {
        d.records[0]
            .values
            .insert("retired".into(), "personal".into());
    });
    assert!(merge_projects(&base, &user, &new).is_err());
    let data = read(&base, TEXT_SETTINGS);
    let steps = [MigrationStep::RemoveColumn {
        table_uuid: &data.uuid,
        column_uuid: &id,
    }];
    assert_eq!(
        merge_projects_with_steps(&base, &user, &new, &steps)
            .unwrap()
            .len(),
        1
    );
    compiled(&new);
}
#[test]
fn invalid_user_type_is_not_reported_as_migration_success() {
    let (_temp, base, user, new) = fixture();
    edit(&user, TEXT_SETTINGS, |d| {
        d.schema.columns[0].data_type = devcel_core::ValueType::I32;
        d.schema.columns[0].default_value = "1".into();
        d.records[0].values.insert("pluginTheme".into(), "7".into());
    });
    assert!(merge_projects(&base, &user, &new).is_err());
    assert_eq!(
        compiled(&new).values.plugin_theme,
        compiled(&base).values.plugin_theme
    );
}
#[test]
fn unregistered_release_type_change_rejects_user_edits() {
    let (_temp, base, user, new) = fixture();
    for root in [&base, &user] {
        edit(root, TEXT_SETTINGS, |d| {
            d.schema.columns[0].data_type = devcel_core::ValueType::I32;
            d.schema.columns[0].default_value = "1".into();
            d.records[0].values.insert("pluginTheme".into(), "1".into());
        });
    }
    edit(&user, TEXT_SETTINGS, |d| {
        d.records[0].values.insert("pluginTheme".into(), "7".into());
    });
    assert!(merge_projects(&base, &user, &new)
        .unwrap_err()
        .to_string()
        .contains("explicit release conversion"));
}
