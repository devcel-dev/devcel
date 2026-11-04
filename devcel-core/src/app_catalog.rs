//! Compile the ordinary, editable personal settings project into runtime snapshots.
use crate::{DevcelError, Project, Record, Result, TableData, ValueType};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsValues {
    pub locale: String,
    pub theme: String,
    pub automatic_update_checks: bool,
    pub color32_display: String,
    pub color_float_display: String,
    pub plugin_theme: String,
    pub plugin_catalog_url: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Theme {
    pub key: String,
    pub label_key: String,
    pub is_dark: bool,
    pub tokens: BTreeMap<String, [u8; 4]>,
}
pub type PluginSettings = crate::plugin_resources::Settings;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledAppSettings {
    pub schema_version: u32,
    #[serde(deserialize_with = "deserialize_warnings")]
    pub warnings: Vec<crate::types::Diagnostic>,
    pub values: SettingsValues,
    pub user_swatches: Vec<crate::ColorSwatch>,
    pub plugin_states: BTreeMap<String, bool>,
    pub plugin_settings: PluginSettings,
    #[serde(default)]
    pub plugin_translations: crate::plugin_resources::Translations,
    pub plugin_labels: crate::plugin_resources::Labels,
    pub themes: Vec<Theme>,
    pub theme_css: String,
    pub localization: crate::localization::Catalog,
}
const BINDINGS: [&str; 7] = [
    "locale",
    "theme",
    "automaticUpdateChecks",
    "color32Display",
    "colorFloatDisplay",
    "pluginTheme",
    "pluginCatalogUrl",
];
// Helper-only diagnostics lack a source index. Preserve authored labels, but use
// a localized generic row label instead of exposing a generated UUID label.
fn record_label(record: &Record) -> crate::types::Diagnostic {
    match record.display_label_diagnostic(0) {
        crate::types::Diagnostic::Text { text } => crate::types::Diagnostic::Text { text },
        _ => crate::types::Diagnostic::Code {
            code: "rules.preview.row".into(),
            params: json!({}),
        },
    }
}

fn coded(code: &str, params: serde_json::Value) -> DevcelError {
    DevcelError::Diagnostics(vec![crate::types::Diagnostic::Code {
        code: code.into(),
        params,
    }])
}

fn err(s: impl Into<String>) -> DevcelError {
    crate::app_error::authoring_error(s)
}
fn table<'a>(p: &'a Project, name: &str) -> Result<&'a TableData> {
    let mut rows = p
        .tables_data
        .values()
        .filter(|t| t.data.metadata.data_name == name);
    let t = rows.next().ok_or_else(|| {
        coded(
            "settings.schema.tableCount",
            json!({"table": name, "count": 0}),
        )
    })?;
    if rows.next().is_some() {
        return Err(coded(
            "settings.schema.tableCount",
            json!({"table": name, "count": p.tables_data.values().filter(|t| t.data.metadata.data_name == name).count()}),
        ));
    }
    Ok(&t.data)
}
fn text<'a>(r: &'a Record, k: &str) -> Result<&'a str> {
    r.values.get(k).map(String::as_str).ok_or_else(|| {
        coded(
            "settings.schema.missingCell",
            json!({"record": record_label(r), "recordId": r.uuid, "column": k}),
        )
    })
}
fn order(r: &Record) -> Result<i32> {
    text(r, "order")?.parse().map_err(|_| coded("settings.schema.valueType", json!({"record": record_label(r), "recordId": r.uuid, "column": "order", "type": "I32", "value": r.values.get("order")})))
}
fn fields(t: &str) -> Vec<(&'static str, ValueType, Option<&'static str>)> {
    use ValueType::{Boolean, Color32, ColorFloat, Reference, Select, String, I32};
    match t {
        "UserSettings" => vec![
            ("locale", Select, None),
            ("theme", Select, None),
            ("automaticUpdateChecks", Boolean, None),
            ("color32Display", Select, None),
            ("colorFloatDisplay", Select, None),
            ("pluginTheme", String, None),
            ("pluginCatalogUrl", String, None),
        ],
        "Themes" => {
            let mut fields = vec![
                ("key", String, None),
                ("label_ref", Reference, Some("Messages")),
                ("order", I32, None),
                ("is_dark", Boolean, None),
            ];
            fields.extend(
                crate::theme_schema::COLOR_FIELDS
                    .iter()
                    .map(|(_, field, _)| (*field, Color32, None)),
            );
            fields
        }
        "UserColor32Swatches" => vec![
            ("name", String, None),
            ("value", Color32, None),
            ("order", I32, None),
        ],
        "UserColorFloatSwatches" => vec![
            ("name", String, None),
            ("value", ColorFloat, None),
            ("order", I32, None),
        ],
        "PluginStates" => vec![("pluginId", String, None), ("enabled", Boolean, None)],
        "PluginResources" => vec![("registration", ValueType::TableRef, None)],
        _ => vec![],
    }
}
const APP_TABLES: [&str; 6] = [
    "UserSettings",
    "Themes",
    "UserColor32Swatches",
    "UserColorFloatSwatches",
    "PluginStates",
    "PluginResources",
];
fn rows(p: &Project, t: &str) -> Result<Vec<Record>> {
    let source = table(p, t)?;
    let resolver = crate::table::InheritanceResolver::new(source);
    let mut d = source.clone();
    for (r, original) in d.records.iter_mut().zip(&source.records) {
        for c in &d.schema.columns {
            let value = resolver.input(original, c)?.to_owned();
            // Effective compiler values include empty defaults; authoring clear semantics do not apply.
            if c.interface_origin.is_some() {
                r.interface_values.insert(c.uuid.clone(), value);
            } else {
                r.values.insert(c.data_name.clone(), value);
            }
        }
    }
    d.records
        .sort_by_key(|r| (order(r).unwrap_or_default(), r.uuid.clone()));
    Ok(d.records)
}
/// Live compilation ignores release review bookkeeping but keeps structural/ICU validation.
pub fn compile_runtime(p: &Project, message_contract: &TableData) -> Result<CompiledAppSettings> {
    compile(p, false, Some(message_contract))
}
fn compile(
    p: &Project,
    strict: bool,
    message_contract: Option<&TableData>,
) -> Result<CompiledAppSettings> {
    if !strict {
        let baseline = message_contract.ok_or_else(|| {
            err("Runtime compilation requires a caller-supplied message contract")
        })?;
        crate::localization::validate_message_contract(p, baseline)?;
    }
    let localized = if strict {
        crate::localization::validate(p)?
    } else {
        crate::localization::compile_runtime(p)?
    };
    let mut ids = BTreeSet::new();
    for t in APP_TABLES {
        let d = table(p, t)?;
        if !ids.insert(d.uuid.clone()) {
            return Err(coded(
                "settings.schema.duplicateTableId",
                json!({"table": t, "id": d.uuid}),
            ));
        }
        if d.schema.columns.len() != fields(t).len() {
            return Err(coded("settings.schema.bindingCount", json!({"table": t})));
        }
        let mut columns = BTreeSet::new();
        for c in &d.schema.columns {
            if !ids.insert(c.uuid.clone()) || !columns.insert(&c.data_name) {
                return Err(coded(
                    "settings.schema.duplicateColumn",
                    json!({"table": t, "column": c.data_name}),
                ));
            }
        }
        for (field, kind, target) in fields(t) {
            let c = d
                .schema
                .columns
                .iter()
                .find(|c| c.data_name == field)
                .ok_or_else(|| {
                    coded(
                        "settings.schema.missingColumn",
                        json!({"table": t, "column": field}),
                    )
                })?;
            if c.data_type != kind || c.interface_origin.is_some() {
                return Err(coded(
                    "settings.schema.columnType",
                    json!({"table": t, "column": field, "expected": format!("{kind:?}"), "actual": format!("{:?}", c.data_type)}),
                ));
            }
            if !c.default_value.is_empty() && !kind.validate(&c.default_value) {
                return Err(coded(
                    "settings.schema.columnDefault",
                    json!({"table": t, "column": field, "type": format!("{kind:?}"), "value": c.default_value}),
                ));
            }
            if let Some(target) = target {
                let target = table(p, target)?;
                let cfg = c.reference_config.as_ref().ok_or_else(|| {
                    coded(
                        "settings.schema.referenceConfig",
                        json!({"table": t, "column": field, "target": target.metadata.data_name}),
                    )
                })?;
                if cfg.target_table_uuid != target.uuid
                    || !target
                        .schema
                        .columns
                        .iter()
                        .any(|c| Some(&c.uuid) == cfg.display_column_uuid.as_ref())
                {
                    return Err(coded(
                        "settings.schema.referenceConfig",
                        json!({"table": t, "column": field, "target": target.metadata.data_name}),
                    ));
                }
            }
        }
        for (row_index, r) in rows(p, t)?.into_iter().enumerate() {
            if !ids.insert(r.uuid.clone()) {
                return Err(coded(
                    "settings.schema.duplicateRecord",
                    json!({"table": t, "record": r.uuid}),
                ));
            }
            if fields(t).iter().any(|(field, _, _)| *field == "order") {
                order(&r)?;
            }
            for (field, kind, target) in fields(t) {
                let v = text(&r, field)?;
                if !matches!(
                    field,
                    "pluginTheme" | "pluginCatalogUrl" | "defaultDelimiter"
                ) && v.trim().is_empty()
                {
                    return Err(coded(
                        "settings.schema.emptyValue",
                        json!({"record": r.display_label_diagnostic(row_index), "recordId": r.uuid, "column": field}),
                    ));
                }
                if !v.is_empty() && !kind.validate(v) {
                    return Err(coded(
                        "settings.schema.valueType",
                        json!({"record": r.display_label_diagnostic(row_index), "recordId": r.uuid, "column": field, "type": format!("{kind:?}"), "value": v}),
                    ));
                }
                if let Some(target) = target {
                    if !table(p, target)?.records.iter().any(|r| r.uuid == v) {
                        return Err(coded(
                            "settings.schema.referenceMissing",
                            json!({"record": r.display_label_diagnostic(row_index), "recordId": r.uuid, "column": field, "target": target, "value": v}),
                        ));
                    }
                }
            }
        }
    }
    let messages = rows(p, "Messages")?;
    let label = |r: &Record| -> Result<String> {
        let id = text(r, "label_ref")?;
        let m = messages.iter().find(|m| m.uuid == id).ok_or_else(|| {
            coded(
                "settings.schema.referenceMissing",
                json!({"record": record_label(r), "recordId": r.uuid, "column": "label_ref", "target": "Messages", "value": id}),
            )
        })?;
        if text(m, "deprecated")? == "true" {
            return Err(coded(
                "settings.schema.deprecatedLabel",
                json!({"record": record_label(r), "recordId": r.uuid, "message": id}),
            ));
        }
        let key = text(m, "key")?;
        for dictionary in localized.catalog.messages.values() {
            if let Some(value) = dictionary.get(key) {
                use formatjs_icu_messageformat_parser::{
                    MessageFormatElement, Parser, ParserOptions,
                };
                let ast = Parser::new(
                    value,
                    ParserOptions {
                        ignore_tag: true,
                        ..Default::default()
                    },
                )
                .parse()
                .map_err(|error| {
                    coded(
                        "settings.schema.labelSyntax",
                        json!({"key": key, "details": format!("{error:?}")}),
                    )
                })?;
                if ast
                    .iter()
                    .any(|element| !matches!(element, MessageFormatElement::Literal(_)))
                {
                    return Err(coded("settings.schema.labelArguments", json!({"key": key})));
                }
            }
        }
        Ok(key.into())
    };

    let themes = rows(p, "Themes")?;
    let mut theme_keys = BTreeSet::new();
    for r in &themes {
        let key = text(r, "key")?;
        if !key.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || matches!(key, "system" | "constructor" | "prototype" | "__proto__")
        {
            return Err(coded("settings.schema.themeKey", json!({"key": key})));
        }
        if !theme_keys.insert(key) {
            return Err(coded("settings.schema.duplicateTheme", json!({"key": key})));
        }
    }
    if !theme_keys.contains("light") || !theme_keys.contains("dark") {
        return Err(coded("settings.schema.requiredThemes", json!({})));
    }
    let user = table(p, "UserSettings")?;
    if user.records.len() != 1 {
        return Err(coded(
            "settings.schema.singleton",
            json!({"table": "UserSettings", "count": user.records.len()}),
        ));
    }
    if user.schema.columns.len() != BINDINGS.len() {
        return Err(coded(
            "settings.schema.bindingCount",
            json!({"table": "UserSettings"}),
        ));
    }
    let user_rows = rows(p, "UserSettings")?;
    let r = &user_rows[0];
    let mut values = BTreeMap::new();
    for (key, kind, _) in fields("UserSettings") {
        let column = user
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == key)
            .ok_or_else(|| {
                coded(
                    "settings.schema.missingColumn",
                    json!({"table": "UserSettings", "column": key}),
                )
            })?;
        let value = text(r, key)?;
        if !column.default_value.is_empty() && !kind.validate(&column.default_value) {
            return Err(coded(
                "settings.schema.columnDefault",
                json!({"table": "UserSettings", "column": key, "type": format!("{kind:?}"), "value": column.default_value}),
            ));
        }
        if key == "pluginCatalogUrl" {
            validate_plugin_catalog_url(value)?;
            validate_plugin_catalog_url(&column.default_value)?;
            values.insert(key, json!(value));
            continue;
        }
        if key == "pluginTheme" {
            if value.len() > 256 || value.chars().any(|c| c.is_control()) {
                return Err(coded(
                    "settings.schema.pluginTheme",
                    json!({"value": value, "max": 256}),
                ));
            }
            values.insert(key, json!(value));
            continue;
        }
        if kind == ValueType::Boolean {
            values.insert(key, json!(value == "true"));
            continue;
        }
        let select = column.select_config.as_ref().ok_or_else(|| {
            coded(
                "settings.schema.selectConfig",
                json!({"table": "UserSettings", "column": key}),
            )
        })?;
        select.validate().map_err(err)?;
        let choices: BTreeSet<_> = select.options.iter().map(|o| o.value.as_str()).collect();
        let expected: BTreeSet<&str> = match key {
            "locale" => std::iter::once("system")
                .chain(
                    localized
                        .catalog
                        .locales
                        .keys()
                        .map(String::as_str)
                        .filter(|k| *k != "en-XA"),
                )
                .collect(),
            "theme" => std::iter::once("system")
                .chain(theme_keys.iter().copied())
                .collect(),
            _ => ["srgb", "linear"].into_iter().collect(),
        };
        // Theme/locale records are the only candidate source. Their stored Select
        // config declares just the system-following mode, never a duplicate list.
        let configured = if matches!(key, "theme" | "locale") {
            BTreeSet::from(["system"])
        } else {
            expected.clone()
        };
        if choices != configured || choices.len() != select.options.len() {
            return Err(coded(
                "settings.schema.selectOptions",
                json!({"table": "UserSettings", "column": key}),
            ));
        }
        if !expected.contains(value) {
            return Err(coded(
                "settings.schema.selectValue",
                json!({"table": "UserSettings", "column": key, "value": value}),
            ));
        }
        if !column.default_value.is_empty() && !expected.contains(column.default_value.as_str()) {
            return Err(coded(
                "settings.schema.selectValue",
                json!({"table": "UserSettings", "column": key, "value": column.default_value}),
            ));
        }
        values.insert(key, json!(value));
    }
    let values: SettingsValues = serde_json::from_value(serde_json::to_value(values)?)?;
    let user_swatches = compile_user_swatches(p)?;
    let plugin_states = compile_plugin_states(p)?;
    let resources =
        crate::plugin_resources::compile(p, &localized.catalog.locales.keys().cloned().collect())?;
    let plugin_settings = resources.settings;
    let mut theme_out = vec![];
    let mut css =
        String::from("/* Generated by devcel app-catalog export. Do not edit. */\n@layer base {\n");
    for r in &themes {
        let key = text(r, "key")?;
        let mut colors = BTreeMap::new();
        for (token, field, _) in crate::theme_schema::COLOR_FIELDS {
            let rgba = crate::color::Color32::parse(text(r, field)?)
                .map_err(err)?
                .channels();
            if rgba[3] != 255 {
                return Err(coded(
                    "settings.schema.themeOpacity",
                    json!({"theme": key, "token": token}),
                ));
            }
            colors.insert(token, rgba);
        }
        if key == "light" {
            css.push_str("  :root:not([data-devcel-theme]), :root[data-devcel-theme=\"light\"], :root.dark[data-devcel-theme=\"light\"] {\n");
        } else if key == "dark" {
            css.push_str("  :root.dark:not([data-devcel-theme]), :root[data-devcel-theme=\"dark\"], :root.dark[data-devcel-theme=\"dark\"] {\n");
        } else {
            css.push_str(&format!("  :root[data-devcel-theme=\"{key}\"], :root.dark[data-devcel-theme=\"{key}\"] {{\n"));
        }
        for (name, rgba) in &colors {
            css.push_str(&format!("    --{name}: {};\n", hsl(*rgba)));
        }
        if key == "light" {
            css.push_str("    --radius: 0.5rem;\n")
        }
        css.push_str("  }\n");
        theme_out.push(Theme {
            key: key.into(),
            label_key: label(r)?,
            is_dark: text(r, "is_dark")? == "true",
            tokens: colors
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        });
    }
    css.push_str("}\n");
    Ok(CompiledAppSettings {
        schema_version: 2,
        warnings: localized.warnings,
        values,
        user_swatches,
        plugin_states,
        plugin_settings,
        plugin_translations: resources.translations,
        plugin_labels: resources.labels,
        themes: theme_out,
        theme_css: css,
        localization: localized.catalog,
    })
}
/// Older validated caches contained plain compiler warning strings. Keep those
/// caches usable when the editable source is temporarily invalid, without
/// treating their text as semantic codes or changing the stored source bytes.
fn deserialize_warnings<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<crate::types::Diagnostic>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Warning {
        Diagnostic(crate::types::Diagnostic),
        Legacy(String),
    }
    Vec::<Warning>::deserialize(deserializer).map(|warnings| {
        warnings
            .into_iter()
            .map(|warning| match warning {
                Warning::Diagnostic(value) => value,
                Warning::Legacy(details) => crate::types::Diagnostic::Code {
                    code: "settings.legacyWarning".into(),
                    params: json!({ "details": details }),
                },
            })
            .collect()
    })
}

/// Strict release projection. The JSON is also the embedded last-good baseline.
pub fn generate(p: &Project) -> Result<BTreeMap<String, String>> {
    let compiled = compile(p, true, None)?;
    let ts = r#"// Generated by devcel app-catalog export. Do not edit.
import data from './catalog.json';
import type { SavedColorSwatch } from '../../types/colorTypes';
import type { Diagnostic } from '../../types/tableRules';
export interface AppSettings { locale: string; theme: string; automaticUpdateChecks: boolean; color32Display: 'srgb' | 'linear'; colorFloatDisplay: 'srgb' | 'linear'; pluginTheme: string; pluginCatalogUrl: string }
export type SettingKey = keyof AppSettings;
export type PluginSettingValue = string | number | boolean | null;
export interface PluginSettingRow { id: string; values: Record<string, PluginSettingValue> }
export type PluginSettings = Record<string, Record<string, Record<string, PluginSettingValue> | PluginSettingRow[]>>;
export type PluginTranslations = Record<string, Record<string, Record<string, string>>>;
export interface AppCatalog { schemaVersion: number; warnings: Diagnostic[]; values: AppSettings; userSwatches: SavedColorSwatch[]; pluginStates: Record<string, boolean>; pluginSettings: PluginSettings; pluginTranslations: PluginTranslations; pluginLabels: Record<string, {owner:string;key:string;source:string}>; themes: {key:string;labelKey:string;isDark:boolean;tokens:Record<string,number[]>}[]; themeCss:string; localization: typeof data.localization }
export const catalog = data as AppCatalog;
"#;
    Ok([
        (
            "catalog.json".into(),
            format!("{}\n", serde_json::to_string_pretty(&compiled)?),
        ),
        ("catalog.ts".into(), ts.into()),
        ("themes.css".into(), compiled.theme_css),
    ]
    .into_iter()
    .collect())
}
/// Write the bundled ordinary project into an empty directory. Never overwrites user data.
pub fn seed_project(dir: &Path, project_file: &str, files: &[(&str, &str)]) -> Result<PathBuf> {
    let safe = |name: &str| {
        !name.is_empty()
            && !name.contains(['\\', ':', '\0'])
            && Path::new(name)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
    };
    let mut names = BTreeSet::new();
    if !safe(project_file)
        || !project_file.ends_with(".devcelproj.toml")
        || !files.iter().any(|(name, _)| *name == project_file)
        || files
            .iter()
            .any(|(name, _)| !safe(name) || !names.insert(name.to_ascii_lowercase()))
    {
        return Err(err("Invalid seed source paths"));
    }
    if dir.exists() && fs::read_dir(dir)?.next().is_some() {
        return Err(coded(
            "settings.schema.seedDestination",
            json!({"path": dir.to_string_lossy()}),
        ));
    }
    fs::create_dir_all(dir.join("Tables"))?;
    for (name, content) in files {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap())?;
        // Seed authoring tables through the same sparse serializer as later saves.
        // Raw templates may contain legacy explicit defaults and layout whitespace.
        // Parsing preserves string contents; never collapse blank lines in raw TOML.
        if name.ends_with(".table.toml") {
            let table = TableData::from_toml(content)?;
            let text = crate::table_storage::to_toml(&table)?;
            crate::utils::write_atomic(&path, text.as_bytes())?;
        } else {
            crate::utils::write_atomic(&path, content.as_bytes())?;
        }
    }
    Ok(dir.join(project_file))
}
/// Catalog destinations have the same bounds as native plugin download URLs.
/// Empty means no catalog is configured; validation never fetches the URL.
pub fn validate_plugin_catalog_url(value: &str) -> Result<()> {
    if value.is_empty() {
        return Ok(());
    }
    if value.len() > 2048 {
        return Err(coded(
            "settings.schema.catalogUrlLength",
            json!({"max": 2048}),
        ));
    }
    let parsed = url::Url::parse(value).map_err(|error| {
        coded(
            "settings.schema.catalogUrlParse",
            json!({"value": value, "details": error.to_string()}),
        )
    })?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(coded("settings.schema.catalogUrlSecurity", json!({})));
    }
    Ok(())
}
fn compile_plugin_states(p: &Project) -> Result<BTreeMap<String, bool>> {
    let mut states = BTreeMap::new();
    for row in rows(p, "PluginStates")? {
        let id = text(&row, "pluginId")?;
        // Keep ordinary setting IDs aligned with the native package namespace.
        if id.is_empty()
            || id.len() > 100
            || !id.as_bytes()[0].is_ascii_alphanumeric()
            || !id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
            || id.contains("..")
            || id.ends_with('.')
            || matches!(id, "constructor" | "prototype" | "__proto__")
        {
            return Err(coded("settings.schema.pluginId", json!({"id": id})));
        }
        if states
            .insert(id.into(), text(&row, "enabled")? == "true")
            .is_some()
        {
            return Err(coded("settings.schema.duplicatePlugin", json!({"id": id})));
        }
    }
    // Every plugin, including bundled plugins, owns its explicit source row.
    // A missing row is disabled at the consumer, never a core per-plugin rule.
    Ok(states)
}
fn compile_user_swatches(p: &Project) -> Result<Vec<crate::ColorSwatch>> {
    let mut ordered = Vec::new();
    for (name, data_type) in [
        ("UserColor32Swatches", ValueType::Color32),
        ("UserColorFloatSwatches", ValueType::ColorFloat),
    ] {
        for row in rows(p, name)? {
            ordered.push((
                order(&row)?,
                crate::ColorSwatch {
                    id: row.uuid.clone(),
                    name: text(&row, "name")?.into(),
                    data_type: data_type.clone(),
                    value: text(&row, "value")?.into(),
                },
            ));
        }
    }
    ordered.sort_by(|(ao, a), (bo, b)| (ao, &a.id).cmp(&(bo, &b.id)));
    // Only the runtime projection is canonicalized. Editable source rows are untouched.
    crate::normalize_color_swatches(ordered.into_iter().map(|(_, swatch)| swatch).collect())
}

/// Replace both ordinary palette tables through one project transaction/history entry.
/// The caller owns the settings-writer lease and checks its full-source revision.
/// Project command execution validates cells, atomically saves both tables and rolls
/// back memory, disk and history if validation or persistence fails.
pub fn replace_user_swatches(
    p: &mut Project,
    swatches: Vec<crate::ColorSwatch>,
    message_contract: std::sync::Arc<TableData>,
    save_queue: Option<&std::sync::Arc<crate::file_save_queue::FileBasedSaveQueueManager>>,
) -> Result<()> {
    use crate::commands::CommandData;
    use std::sync::{Arc, Mutex};
    let catalog = p.get_table_catalog()?;
    let names = APP_TABLES
        .into_iter()
        .chain(["Messages", "Locales"])
        .map(str::to_owned)
        .chain(
            catalog
                .iter()
                .filter(|entry| {
                    entry.data_name == "Translations"
                        || entry.data_name.starts_with("Translations_")
                })
                .map(|entry| entry.data_name.clone()),
        )
        .collect::<std::collections::BTreeSet<_>>();
    for name in names {
        let matches: Vec<_> = catalog
            .iter()
            .filter(|entry| entry.data_name == name)
            .collect();
        if matches.len() != 1 {
            return Err(coded(
                "settings.schema.tableCount",
                json!({"table": name, "count": matches.len()}),
            ));
        }
        p.ensure_table_loaded_by_uuid(&matches[0].uuid)?;
    }
    // The registry is part of APP_TABLES, but its plugin-owned tables can still
    // be unopened in the editor. Full runtime validation needs those sources as
    // well. Load only missing registered UUIDs; never replace an already loaded
    // table, its authored edits, dirty flag or history with a disk reread.
    // The typed catalog points to registration tables, which in turn point to
    // resources. Load the plugin namespace before the shared bindings validator
    // resolves both edges. ensure_table_loaded preserves already loaded edits.
    for entry in catalog
        .iter()
        .filter(|entry| entry.data_name.starts_with("Plugin_"))
    {
        p.ensure_table_loaded_by_uuid(&entry.uuid)?;
    }
    crate::plugin_resource_registry::bindings(
        table(p, "PluginResources")?,
        &p.tables_data,
        &p.interface_registry,
    )?;
    // Ordinary pending edits remain owned by the table editor. In particular,
    // never let its dirty flag opt this cross-table write out of the disk CAS.
    for name in ["UserColor32Swatches", "UserColorFloatSwatches"] {
        let source = table(p, name)?;
        if p.find_table_by_uuid(&source.uuid)
            .is_some_and(|table| table.is_dirty)
        {
            return Err(coded("settings.schema.swatchPending", json!({})));
        }
    }
    let before = compile_runtime(p, &message_contract)?;
    let swatches = crate::normalize_color_swatches(swatches)?;
    if before.user_swatches == swatches {
        // No-op must not acknowledge a stale open table as a successful save.
        // Do not reload it: the ordinary editor still owns that table's history.
        for name in ["UserColor32Swatches", "UserColorFloatSwatches"] {
            let source = table(p, name)?;
            let live = p.find_table_by_uuid(&source.uuid).ok_or_else(|| {
                coded(
                    "settings.schema.tableCount",
                    json!({"table": name, "count": 0}),
                )
            })?;
            let disk: TableData =
                TableData::from_toml(&fs::read_to_string(&live.path)?).map_err(|error| {
                    coded(
                        "settings.schema.swatchParse",
                        json!({"path": live.path.to_string_lossy(), "details": crate::AppError::from(error).into_diagnostic()}),
                    )
                })?;
            if crate::cell_rules::revision(source) != crate::cell_rules::revision(&disk) {
                return Err(coded("settings.schema.swatchChanged", json!({})));
            }
        }
        return Ok(());
    }
    let mut commands: Vec<Arc<Mutex<dyn CommandData>>> = Vec::new();
    for (name, data_type) in [
        ("UserColor32Swatches", ValueType::Color32),
        ("UserColorFloatSwatches", ValueType::ColorFloat),
    ] {
        let source = table(p, name)?;
        let mut after = source.clone();
        after.records = swatches
            .iter()
            .enumerate()
            .filter(|(_, swatch)| swatch.data_type == data_type)
            .map(|(index, swatch)| {
                // Retain authoring metadata and raw unchanged cells. The compiled
                // projection trims names and resolves defaults; adding/reordering
                // another swatch must not repair or materialize those source cells.
                let existing = source.records.iter().find(|r| r.uuid == swatch.id);
                let previous = existing
                    .and_then(|_| before.user_swatches.iter().find(|old| old.id == swatch.id));
                let mut row = existing.cloned().unwrap_or_default();
                row.uuid = swatch.id.clone();
                if previous.is_none_or(|old| old.name != swatch.name) {
                    row.values.insert("name".into(), swatch.name.clone());
                }
                if previous.is_none_or(|old| old.value != swatch.value) {
                    row.values.insert("value".into(), swatch.value.clone());
                }
                row.values.insert("order".into(), index.to_string());
                row
            })
            .collect();
        commands.push(Arc::new(Mutex::new(
            crate::table_mutation::ReplaceTableCommand::new(
                source.uuid.clone(),
                crate::cell_rules::revision(source),
                after,
                None,
            ),
        )));
    }
    struct ValidateSettings(Arc<TableData>);
    impl CommandData for ValidateSettings {
        fn execute(&mut self, project: &mut Project) -> Result<()> {
            compile_runtime(project, &self.0).map(|_| ())
        }
        fn undo(&mut self, _project: &mut Project) -> Result<()> {
            Ok(())
        }
        fn get_table_uuid(&self) -> String {
            String::new()
        }
    }
    commands.push(Arc::new(Mutex::new(ValidateSettings(
        message_contract.clone(),
    ))));
    p.execute_transaction(
        "Replace personal color swatches".into(),
        move |transaction| {
            for command in commands {
                transaction.add_command(command);
            }
            Ok(())
        },
        save_queue,
    )
}

fn hsl([r, g, b, _]: [u8; 4]) -> String {
    let (r, g, b) = (r as f64 / 255., g as f64 / 255., b as f64 / 255.);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let l = (max + min) / 2.;
    let (h, s) = if d == 0. {
        (0., 0.)
    } else {
        let h = if max == r {
            ((g - b) / d).rem_euclid(6.)
        } else if max == g {
            (b - r) / d + 2.
        } else {
            (r - g) / d + 4.
        };
        (h * 60., d / (1. - (2. * l - 1.).abs()))
    };
    format!("{h:.2} {:.2}% {:.2}%", s * 100., l * 100.)
}
pub fn export(p: &Project, out: &Path, check: bool) -> Result<()> {
    let files = generate(p)?;
    if check {
        for (name, expected) in files {
            if !fs::read_to_string(out.join(&name))
                .is_ok_and(|actual| actual.replace("\r\n", "\n") == expected)
            {
                return Err(coded(
                    "settings.schema.artifactStale",
                    json!({"path": out.join(&name).to_string_lossy()}),
                ));
            }
        }
    } else {
        publish(out, files, |file, path| {
            file.persist(path)
                .map(|_| ())
                .map_err(|e| DevcelError::Io(e.error))
        })?;
    }
    Ok(())
}
// Prepare every file and snapshot every original before publishing. A failed
// rename restores earlier artifacts, matching localization::export semantics.
// Individual renames are atomic; this is not a crash-atomic directory transaction.
fn publish(
    out: &Path,
    files: BTreeMap<String, String>,
    mut persist: impl FnMut(tempfile::NamedTempFile, &Path) -> Result<()>,
) -> Result<()> {
    fs::create_dir_all(out)?;
    let mut prepared = Vec::new();
    for (name, value) in files {
        let mut file = tempfile::NamedTempFile::new_in(out)?;
        file.write_all(value.as_bytes())?;
        file.as_file().sync_all()?;
        prepared.push((out.join(name), file));
    }
    let originals = prepared
        .iter()
        .map(|(path, _)| match fs::read(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(DevcelError::Io(e)),
        })
        .collect::<Result<Vec<_>>>()?;
    let mut committed: Vec<PathBuf> = Vec::new();
    for (path, file) in prepared {
        if let Err(error) = persist(file, &path) {
            for (previous, original) in committed.iter().zip(&originals).rev() {
                match original {
                    Some(bytes) => crate::utils::write_atomic(previous, bytes)?,
                    None => fs::remove_file(previous)?,
                }
            }
            return Err(error);
        }
        committed.push(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rollback_restores_or_removes_previously_committed_artifact() {
        for existing in [true, false] {
            let d = tempfile::tempdir().unwrap();
            if existing {
                fs::write(d.path().join("a"), "old").unwrap();
            }
            let mut n = 0;
            let files = [("a".into(), "new".into()), ("b".into(), "new".into())]
                .into_iter()
                .collect();
            assert!(publish(d.path(), files, |file, path| {
                n += 1;
                if n == 2 {
                    return Err(err("injected"));
                }
                file.persist(path)
                    .map(|_| ())
                    .map_err(|e| DevcelError::Io(e.error))
            })
            .is_err());
            if existing {
                assert_eq!(fs::read_to_string(d.path().join("a")).unwrap(), "old");
            } else {
                assert!(!d.path().join("a").exists());
            }
        }
    }
    #[test]
    fn seed_rejects_unsafe_or_duplicate_inputs_before_writing() {
        for files in [
            vec![("../outside", "x"), ("p.devcelproj.toml", "project")],
            vec![("p.devcelproj.toml", "a"), ("P.devcelproj.toml", "b")],
        ] {
            let root = tempfile::tempdir().unwrap();
            let destination = root.path().join("seed");
            assert!(seed_project(&destination, "p.devcelproj.toml", &files).is_err());
            assert!(!destination.exists());
        }
    }
    #[test]
    fn generic_seed_retains_non_table_bytes_and_refuses_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let files = [
            ("p.devcelproj.toml", "project\r\n"),
            ("notes.txt", "literal\r\n{data}\n"),
        ];
        seed_project(root.path(), "p.devcelproj.toml", &files).unwrap();
        for (name, content) in files {
            assert_eq!(
                fs::read(root.path().join(name)).unwrap(),
                content.as_bytes()
            );
        }
        assert!(seed_project(root.path(), "p.devcelproj.toml", &files).is_err());
    }
}
