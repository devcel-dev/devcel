// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2024 Devcel Studio Contributors
// See devcel-studio/LICENSE in the complete source distribution.

use toml08 as toml;

use super::*;
use devcel_core::app_catalog::*;
fn table<'a>(project: &'a Project, name: &str) -> Result<&'a TableData> {
    project
        .tables_data
        .values()
        .find(|table| table.data.metadata.data_name == name)
        .map(|table| &table.data)
        .ok_or_else(|| DevcelError::Validation(name.into()))
}
fn rows(project: &Project, name: &str) -> Result<Vec<Record>> {
    Ok(table(project, name)?.records.clone())
}

fn source() -> Project {
    devcel_core::localization::load(&seed_root().join("studio.devcelproj.toml")).unwrap()
}
fn edit(p: &mut Project, name: &str, f: impl FnOnce(&mut TableData)) {
    f(&mut p
        .tables_data
        .values_mut()
        .find(|t| t.data.metadata.data_name == name)
        .unwrap()
        .data)
}
#[test]
fn real_settings_are_typed_and_seed_is_editable() {
    let p = source();
    let c = crate::settings_seed::compile_runtime(&p).unwrap();
    assert_eq!(c.values.locale, "system");
    assert!(!c.values.automatic_update_checks);
    assert_eq!(c.values.color_float_display, "linear");
    assert_eq!(c.values.plugin_theme, "");
    let d = tempfile::tempdir().unwrap();
    let path = crate::settings_seed::seed_project(d.path()).unwrap();
    let p = devcel_core::localization::load(&path).unwrap();
    assert_eq!(
        crate::settings_seed::compile_runtime(&p).unwrap().values,
        c.values
    );
    assert!(crate::settings_seed::seed_project(d.path()).is_err());
}
#[test]
fn seeded_tables_use_sparse_save_format_and_reload_without_value_changes() {
    let dir = tempfile::tempdir().unwrap();
    let project_path = crate::settings_seed::seed_project(dir.path()).unwrap();
    let mut tables = 0;
    for (name, template) in crate::settings_seed::source_files() {
        let text = fs::read_to_string(dir.path().join(name)).unwrap();
        if !name.ends_with(".table.toml") {
            assert_eq!(text, *template, "non-table template changed: {name}");
            continue;
        }
        tables += 1;
        let before = TableData::from_toml(template).unwrap();
        let after = TableData::from_toml(&text).unwrap();
        assert_eq!(
            serde_json::to_value(&after).unwrap(),
            serde_json::to_value(&before).unwrap(),
            "{name}"
        );
        assert_eq!(
            text,
            after.to_toml().unwrap(),
            "seed differs from ordinary save: {name}"
        );
        let parsed: toml::Value = toml::from_str(&text).unwrap();
        if before.metadata.parent_uuid.is_empty() {
            assert!(parsed["metadata"].get("parent_uuid").is_none(), "{name}");
        }
        assert!(text.starts_with("uuid = "), "{name}");
        assert!(
            text.find("\ndisplay_name = ").unwrap() < text.find("\ndescription = ").unwrap(),
            "{name}"
        );
    }
    assert!(tables > 20);
    let user_settings = dir.path().join("Tables/UserSettings.table.toml");
    let before_save = fs::read_to_string(&user_settings).unwrap();
    assert!(
        !before_save.contains("\n\n\n"),
        "redundant layout blank lines"
    );
    let mut project = devcel_core::localization::load(&project_path).unwrap();
    for table in project.tables_data.values_mut() {
        table.is_dirty = true;
    }
    project.save_project().unwrap();
    assert_eq!(fs::read_to_string(&user_settings).unwrap(), before_save);
    let reloaded = devcel_core::localization::load(&project_path).unwrap();
    assert_eq!(
        crate::settings_seed::compile_runtime(&project)
            .unwrap()
            .values,
        crate::settings_seed::compile_runtime(&reloaded)
            .unwrap()
            .values
    );
    println!(
        "Canonical seeded tables: {tables}; UserSettings bytes: {}",
        before_save.len()
    );
}

#[test]
fn invalid_edit_then_repair_recovers_without_mutating_sources() {
    type TableChange = (&'static str, fn(&mut TableData));
    fn set_local(table: &mut TableData, name: &str, value: String) {
        let column = table
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == name)
            .unwrap()
            .clone();
        table.records[0].set_cell_value(&column, value);
    }
    let changes: Vec<TableChange> = vec![
        ("UserSettings", |t| {
            t.schema.columns[0]
                .select_config
                .as_mut()
                .unwrap()
                .options
                .pop();
        }),
        ("UserSettings", |t| {
            t.schema.columns[0]
                .select_config
                .as_mut()
                .unwrap()
                .options
                .push(devcel_core::SelectOption {
                    value: "xx".into(),
                    label: "extra".into(),
                });
        }),
        ("UserSettings", |t| {
            t.schema.columns[0].data_type = ValueType::String;
        }),
        ("UserSettings", |t| {
            set_local(t, "locale", "missing".into());
        }),
        ("UserSettings", |t| {
            set_local(t, "automaticUpdateChecks", "yes".into());
        }),
        ("UserSettings", |t| {
            set_local(t, "pluginTheme", "x".repeat(257));
        }),
        ("UserSettings", |t| {
            t.records.clear();
        }),
        ("UserSettings", |t| {
            t.records.push(t.records[0].clone());
        }),
        ("Themes", |t| {
            t.records.pop();
        }),
        ("Themes", |t| {
            set_local(t, "label_ref", "dangling".into());
        }),
        ("Themes", |t| {
            t.schema.columns.retain(|c| c.data_name != "background");
        }),
        ("Themes", |t| {
            set_local(t, "background", "[1,2,3,128]".into());
        }),
        ("Translations_common", |t| {
            set_local(t, "message_ref", "dangling".into());
        }),
    ];
    for (name, change) in changes {
        let mut p = source();
        let original = table(&p, name).unwrap().clone();
        change(
            &mut p
                .tables_data
                .values_mut()
                .find(|t| t.data.metadata.data_name == name)
                .unwrap()
                .data,
        );
        assert!(
            crate::settings_seed::compile_runtime(&p).is_err(),
            "accepted {name}"
        );
        edit(&mut p, name, |t| *t = original);
        assert!(
            crate::settings_seed::compile_runtime(&p).is_ok(),
            "repair failed {name}"
        );
    }
}
#[test]
fn live_source_edit_needs_no_sha_or_review_and_keeps_icu_safe() {
    let mut p = source();
    edit(&mut p, "Messages", |t| {
        let r = t
            .records
            .iter_mut()
            .find(|r| r.values["key"] == "common.save")
            .unwrap();
        r.values
            .insert("source_message".into(), "保存する（個人設定）".into());
    });
    let c = crate::settings_seed::compile_runtime(&p).unwrap();
    assert_eq!(
        c.localization.messages["ja"]["common.save"],
        "保存する（個人設定）"
    );
    assert!(generate(&p).is_err());
    edit(&mut p, "Messages", |t| {
        let r = t
            .records
            .iter_mut()
            .find(|r| r.values["key"] == "common.save")
            .unwrap();
        r.values.insert("source_message".into(), "broken {".into());
    });
    assert!(crate::settings_seed::compile_runtime(&p).is_err());
}
#[test]
fn live_unreviewed_translation_is_editable_but_mismatched_arguments_fall_back() {
    let mut p = source();
    let m = rows(&p, "Messages")
        .unwrap()
        .into_iter()
        .find(|r| r.values["key"] == "common.save")
        .unwrap()
        .uuid;
    let en = rows(&p, "Locales")
        .unwrap()
        .into_iter()
        .find(|r| r.values["code"] == "en")
        .unwrap()
        .uuid;
    edit(&mut p, "Translations_common", |t| {
        let r = t
            .records
            .iter_mut()
            .find(|r| r.values["message_ref"] == m && r.values["locale_ref"] == en)
            .unwrap();
        r.values.insert("message".into(), "My save".into());
        r.values.insert("status".into(), "draft".into());
        r.values
            .insert("reviewed_source_revision".into(), "".into());
    });
    assert_eq!(
        crate::settings_seed::compile_runtime(&p)
            .unwrap()
            .localization
            .messages["en"]["common.save"],
        "My save"
    );
    assert!(generate(&p).is_err());
    edit(&mut p, "Translations_common", |t| {
        let r = t
            .records
            .iter_mut()
            .find(|r| r.values["message_ref"] == m && r.values["locale_ref"] == en)
            .unwrap();
        r.values.insert("message".into(), "Save {other}".into());
    });
    assert!(!crate::settings_seed::compile_runtime(&p)
        .unwrap()
        .localization
        .messages["en"]
        .contains_key("common.save"));
}
#[test]
fn theme_identity_does_not_change_when_appearance_flag_changes() {
    let mut p = source();
    let before = crate::settings_seed::compile_runtime(&p).unwrap();
    edit(&mut p, "Themes", |t| {
        for r in &mut t.records {
            let key = r.values["key"].as_str();
            if key == "light" || key == "dark" {
                r.values
                    .insert("is_dark".into(), (key == "light").to_string());
            }
        }
    });
    let after = crate::settings_seed::compile_runtime(&p).unwrap();
    assert_eq!(before.theme_css, after.theme_css);
    for key in ["light", "dark"] {
        let a = after.themes.iter().find(|t| t.key == key).unwrap();
        let b = before.themes.iter().find(|t| t.key == key).unwrap();
        assert_eq!(a.tokens, b.tokens);
        assert_eq!(a.is_dark, key == "light");
        assert!(after
            .theme_css
            .contains(&format!(":root.dark[data-devcel-theme=\"{key}\"]")));
    }
}
#[test]
fn valid_theme_addition_preserves_inline_colors() {
    let mut p = source();
    let base = rows(&p, "Themes").unwrap()[0].clone();
    edit(&mut p, "Themes", |t| {
        let mut r = base;
        r.uuid = "custom-theme".into();
        r.values.insert("key".into(), "custom".into());
        t.records.push(r);
    });
    assert!(crate::settings_seed::compile_runtime(&p)
        .unwrap()
        .theme_css
        .contains(":root[data-devcel-theme=\"custom\"]"));
}
#[test]
fn locale_candidates_follow_enabled_locales_and_recover_after_removal() {
    let mut p = source();
    let mut ko = rows(&p, "Locales")
        .unwrap()
        .into_iter()
        .find(|r| r.values["code"] == "en")
        .unwrap();
    ko.uuid = "ef21a5e8-38cf-4a52-a19e-ce0dc7bd2d7a".into();
    ko.values.insert("code".into(), "ko".into());
    ko.values.insert("required".into(), "false".into());
    edit(&mut p, "Locales", |t| t.records.push(ko));
    assert!(
        crate::settings_seed::compile_runtime(&p).is_ok(),
        "locale candidates derive from enabled locale records"
    );
    edit(&mut p, "UserSettings", |t| {
        t.records[0].values.insert("locale".into(), "ko".into());
    });
    let compiled = crate::settings_seed::compile_runtime(&p).unwrap();
    assert_eq!(compiled.values.locale, "ko");
    assert!(compiled.localization.locales.contains_key("ko"));
    assert!(!compiled.warnings.is_empty());
    edit(&mut p, "Locales", |t| {
        t.records
            .retain(|r| r.uuid != "ef21a5e8-38cf-4a52-a19e-ce0dc7bd2d7a")
    });
    assert!(crate::settings_seed::compile_runtime(&p).is_err());
    edit(&mut p, "UserSettings", |t| {
        t.records[0].values.insert("locale".into(), "system".into());
    });
    assert!(crate::settings_seed::compile_runtime(&p).is_ok());
}
#[test]
fn deterministic_and_read_only_check() {
    let p = source();
    let a = generate(&p).unwrap();
    assert_eq!(a, generate(&p).unwrap());
    let d = tempfile::tempdir().unwrap();
    export(&p, d.path(), false).unwrap();
    export(&p, d.path(), true).unwrap();
    for path in fs::read_dir(d.path()).unwrap() {
        let path = path.unwrap().path();
        let crlf = fs::read_to_string(&path).unwrap().replace("\n", "\r\n");
        fs::write(&path, &crlf).unwrap();
        export(&p, d.path(), true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), crlf);
    }
    let locales = tempfile::tempdir().unwrap();
    devcel_core::localization::export(&p, locales.path(), false).unwrap();
    for name in ["catalog.json", "keys.ts"] {
        let path = locales.path().join(name);
        let crlf = fs::read_to_string(&path).unwrap().replace("\n", "\r\n");
        fs::write(&path, &crlf).unwrap();
        devcel_core::localization::export(&p, locales.path(), true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), crlf);
    }
    fs::write(locales.path().join("keys.ts"), "stale\r\n").unwrap();
    assert!(devcel_core::localization::export(&p, locales.path(), true).is_err());
    fs::write(d.path().join("themes.css"), "stale").unwrap();
    assert!(export(&p, d.path(), true).is_err());
    assert_eq!(
        fs::read_to_string(d.path().join("themes.css")).unwrap(),
        "stale"
    );
}
#[test]
fn explicit_default_modes_use_typed_defaults_without_source_rewrite() {
    let mut p = source();
    edit(&mut p, "UserSettings", |t| {
        t.records[0]
            .values
            .insert("color32Display".into(), "".into());
        t.schema
            .columns
            .iter_mut()
            .find(|c| c.data_name == "color32Display")
            .unwrap()
            .default_value = "linear".into();
        t.records[0]
            .values
            .insert("automaticUpdateChecks".into(), "".into());
        for column in &t.schema.columns {
            if matches!(
                column.data_name.as_str(),
                "color32Display" | "automaticUpdateChecks"
            ) {}
        }
    });
    let values = crate::settings_seed::compile_runtime(&p).unwrap().values;
    assert_eq!(values.color32_display, "linear");
    assert!(!values.automatic_update_checks);
    assert_eq!(
        table(&p, "UserSettings").unwrap().records[0].values["color32Display"],
        ""
    );
}
#[test]
fn embedded_message_contract_rejects_missing_keys_or_new_arguments() {
    let original = crate::settings_seed::message_contract().unwrap();
    let mut writable_copy = crate::settings_seed::message_contract().unwrap();
    assert!(std::sync::Arc::ptr_eq(&original, &writable_copy));
    std::sync::Arc::make_mut(&mut writable_copy).records.clear();
    assert!(!crate::settings_seed::message_contract()
        .unwrap()
        .records
        .is_empty());

    let mut p = source();
    edit(&mut p, "Messages", |t| {
        t.records
            .iter_mut()
            .find(|r| r.values["key"] == "common.save")
            .unwrap()
            .values
            .insert("source_message".into(), "Save {newArgument}".into());
    });
    assert!(crate::settings_seed::compile_runtime(&p).is_err());
    let mut p = source();
    edit(&mut p, "Messages", |t| {
        t.records.retain(|r| r.values["key"] != "common.save")
    });
    assert!(crate::settings_seed::compile_runtime(&p).is_err());
}
#[test]
fn labels_cannot_require_arguments() {
    let mut p = source();
    let id = rows(&p, "Messages")
        .unwrap()
        .into_iter()
        .find(|r| r.values["key"] == "column.managedBy")
        .unwrap()
        .uuid;
    edit(&mut p, "Themes", |t| {
        t.records[0].values.insert("label_ref".into(), id);
    });
    assert!(crate::settings_seed::compile_runtime(&p).is_err());
}
#[test]
fn reversed_order_keeps_dark_specificity() {
    let mut p = source();
    edit(&mut p, "Themes", |t| {
        for r in &mut t.records {
            let order = if r.values["key"] == "dark" { "0" } else { "1" };
            r.values.insert("order".into(), order.into());
        }
    });
    let css = crate::settings_seed::compile_runtime(&p).unwrap().theme_css;
    assert!(
        css.find(":root.dark:not([data-devcel-theme])").unwrap()
            < css.find(":root:not([data-devcel-theme])").unwrap()
    );
    for key in ["light", "dark"] {
        assert!(css.contains(&format!(":root[data-devcel-theme=\"{key}\"]")));
        assert!(css.contains(&format!(":root.dark[data-devcel-theme=\"{key}\"]")));
    }
}
fn diagnostic_json(error: DevcelError) -> serde_json::Value {
    match error {
        DevcelError::Diagnostics(mut diagnostics) => {
            assert_eq!(diagnostics.len(), 1);
            serde_json::to_value(diagnostics.remove(0)).unwrap()
        }
        other => panic!("expected structured diagnostic, got {other:?}"),
    }
}

#[test]
fn schema_diagnostics_keep_semantics_and_do_not_mutate_invalid_sources() {
    for (name, count) in [("UserSettings", 0usize), ("UserSettings", 2)] {
        let mut project = source();
        edit(&mut project, name, |table| {
            if count == 0 {
                table.records.clear();
            } else {
                let mut extra = table.records[0].clone();
                extra.uuid = uuid::Uuid::new_v4().to_string();
                table.records.push(extra);
            }
        });
        let before = serde_json::to_value(table(&project, name).unwrap()).unwrap();
        let error = diagnostic_json(
            crate::settings_seed::compile_runtime(&project)
                .err()
                .expect("invalid singleton"),
        );
        assert_eq!(error["code"], "settings.schema.singleton");
        assert_eq!(error["params"], json!({ "table": name, "count": count }));
        assert_eq!(
            serde_json::to_value(table(&project, name).unwrap()).unwrap(),
            before
        );
    }
    let mut project = source();
    edit(&mut project, "Messages", |table| {
        table
            .schema
            .columns
            .retain(|column| column.data_name != "source_message")
    });
    let error = diagnostic_json(
        devcel_core::localization::compile_runtime(&project)
            .err()
            .unwrap(),
    );
    assert_eq!(error["code"], "settings.schema.missingColumn");
    assert_eq!(
        error["params"],
        json!({ "table": "Messages", "column": "source_message" })
    );

    let mut project = source();
    edit(&mut project, "UserSettings", |table| {
        table
            .schema
            .columns
            .iter_mut()
            .find(|column| column.data_name == "locale")
            .unwrap()
            .data_type = ValueType::String;
    });
    let error = diagnostic_json(
        crate::settings_seed::compile_runtime(&project)
            .err()
            .unwrap(),
    );
    assert_eq!(error["code"], "settings.schema.columnType");
    assert_eq!(error["params"]["expected"], "Select");
    assert_eq!(error["params"]["actual"], "String");
}

#[test]
fn schema_reference_and_nested_icu_errors_preserve_literal_values() {
    let mut project = source();
    let missing = uuid::Uuid::new_v4().to_string();
    edit(&mut project, "Themes", |table| {
        let column = table
            .schema
            .columns
            .iter()
            .find(|column| column.data_name == "label_ref")
            .unwrap()
            .clone();
        table.records[0].label = "色の行 {not_a_key}".into();
        table.records[0].set_cell_value(&column, missing.clone());
    });
    let error = diagnostic_json(
        crate::settings_seed::compile_runtime(&project)
            .err()
            .unwrap(),
    );
    assert_eq!(error["code"], "settings.schema.referenceMissing");
    assert_eq!(error["params"]["value"], missing);
    assert_eq!(
        error["params"]["record"],
        json!({ "kind": "text", "text": "色の行 {not_a_key}" })
    );

    let mut project = source();
    edit(&mut project, "Messages", |table| {
        table
            .records
            .iter_mut()
            .find(|record| record.values["key"] == "common.save")
            .unwrap()
            .values
            .insert("source_message".into(), "broken {".into());
    });
    let error = diagnostic_json(
        devcel_core::localization::compile_runtime(&project)
            .err()
            .unwrap(),
    );
    assert_eq!(error["code"], "settings.localization.messageError");
    assert_eq!(error["params"]["key"], "common.save");
    assert_eq!(error["params"]["error"]["kind"], "diagnostics");
    assert_eq!(
        error["params"]["error"]["diagnostics"][0]["code"],
        "settings.localization.icuSyntax"
    );
    assert!(
        error["params"]["error"]["diagnostics"][0]["params"]["details"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert!(!error.to_string().contains("Validation error:"));
}

#[test]
fn missing_release_key_is_rejected_after_translation_references_are_removed() {
    let mut project = source();
    let removed = table(&project, "Messages")
        .unwrap()
        .records
        .iter()
        .find(|row| row.values["key"] == "common.save")
        .unwrap()
        .uuid
        .clone();
    for table in project.tables_data.values_mut() {
        if table.data.metadata.data_name.starts_with("Translations_") {
            table
                .data
                .records
                .retain(|row| row.values.get("message_ref") != Some(&removed));
        }
    }
    edit(&mut project, "Messages", |table| {
        table.records.retain(|row| row.uuid != removed)
    });
    let error = diagnostic_json(
        crate::settings_seed::compile_runtime(&project)
            .err()
            .unwrap(),
    );
    assert_eq!(error["code"], "settings.localization.embeddedMissing");
    assert_eq!(error["params"]["key"], "common.save");
}
