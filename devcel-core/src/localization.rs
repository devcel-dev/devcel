//! Treat Studio localization sources as ordinary Devcel tables.
//! Centralize validation, ICU ASTs, generation, and revision management in Rust without extending the storage format.
use crate::{
    ColumnSchema, DevcelError, Project, Record, ReferenceConfig, Result, SelectConfig,
    SelectOption, Table, TableData, ValueType,
};
use formatjs_icu_messageformat_parser::{
    print_ast, Locale, MessageFormatElement as Element, Parser, ParserOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const BASE_TABLES: [&str; 2] = ["Messages", "Locales"];
const TRANSLATION_PREFIX: &str = "Translations_";

pub(crate) fn is_translation_table(name: &str) -> bool {
    name.strip_prefix(TRANSLATION_PREFIX)
        .is_some_and(|domain| safe_name(domain, false))
}
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

fn translation_name(key: &str) -> Result<String> {
    if !safe_name(key, true) || !key.contains('.') {
        return Err(coded(
            "settings.localization.semanticKey",
            json!({"key": key}),
        ));
    }
    Ok(format!(
        "{TRANSLATION_PREFIX}{}",
        key.split('.').next().unwrap()
    ))
}
fn translation_tables(project: &Project) -> Result<Vec<&Table>> {
    let mut tables = BTreeMap::new();
    for table in project.tables_data.values() {
        let name = table.data.metadata.data_name.as_str();
        if name == "Translations"
            || (name.starts_with(TRANSLATION_PREFIX) && !is_translation_table(name))
        {
            return Err(coded(
                "settings.localization.domainTable",
                json!({"table": name}),
            ));
        }
        if is_translation_table(name) && tables.insert(name, table).is_some() {
            return Err(coded(
                "settings.localization.duplicateDomain",
                json!({"table": name}),
            ));
        }
    }
    if tables.is_empty() {
        return Err(coded("settings.localization.domainRequired", json!({})));
    }
    Ok(tables.into_values().collect())
}
fn table_names(project: &Project) -> Result<Vec<String>> {
    let mut names = BASE_TABLES
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    names.extend(
        translation_tables(project)?
            .iter()
            .map(|table| table.data.metadata.data_name.clone()),
    );
    Ok(names)
}
const SOURCE: &str = "ja";
const PSEUDO: &str = "en-XA";

fn invalid(message: impl Into<String>) -> DevcelError {
    crate::app_error::authoring_error(message)
}
fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn text<'a>(record: &'a Record, column: &str) -> Result<&'a str> {
    record
        .values
        .get(column)
        .map(String::as_str)
        .ok_or_else(|| {
            coded(
                "settings.schema.missingCell",
                json!({"record": record_label(record), "recordId": record.uuid, "column": column}),
            )
        })
}
fn boolean(record: &Record, column: &str) -> Result<bool> {
    match text(record, column)? {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(coded(
            "settings.schema.valueType",
            json!({"record": record_label(record), "recordId": record.uuid, "column": column, "type": "Boolean", "value": record.values.get(column)}),
        )),
    }
}
fn safe_name(value: &str, dot: bool) -> bool {
    !value.is_empty()
        && value.split(if dot { '.' } else { '\0' }).all(|part| {
            !matches!(part, "__proto__" | "prototype" | "constructor")
                && part.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}
fn parse(message: &str) -> Result<Vec<Element>> {
    Parser::new(
        message,
        ParserOptions {
            ignore_tag: true,
            requires_other_clause: true,
            should_parse_skeletons: true,
            ..Default::default()
        },
    )
    .parse()
    .map_err(|error| {
        coded(
            "settings.localization.icuSyntax",
            json!({"details": format!("{error:?}")}),
        )
    })
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum ArgType {
    String,
    Number,
    Date,
}
impl ArgType {
    fn typescript(&self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Number => "number",
            Self::Date => "Date | number",
        }
    }
}
type Arguments = BTreeMap<String, ArgType>;
fn arguments(ast: &[Element]) -> Result<Arguments> {
    fn visit(ast: &[Element], out: &mut Arguments) -> Result<()> {
        for element in ast {
            let arg = match element {
                Element::Argument(v) => Some((&v.value, ArgType::String)),
                Element::Number(v) => Some((&v.value, ArgType::Number)),
                Element::Date(v) | Element::Time(v) => Some((&v.value, ArgType::Date)),
                Element::Select(v) => {
                    for option in v.options.values() {
                        visit(&option.value, out)?;
                    }
                    Some((&v.value, ArgType::String))
                }
                Element::Plural(v) => {
                    for option in v.options.values() {
                        visit(&option.value, out)?;
                    }
                    Some((&v.value, ArgType::Number))
                }
                Element::Tag(_) => return Err(coded("settings.localization.richText", json!({}))),
                _ => None,
            };
            if let Some((name, kind)) = arg {
                if !safe_name(name, false) {
                    return Err(coded(
                        "settings.localization.argumentName",
                        json!({"name": name}),
                    ));
                }
                if let Some(previous) = out.insert(name.clone(), kind.clone()) {
                    if previous != kind {
                        return Err(coded(
                            "settings.localization.argumentType",
                            json!({"name": name}),
                        ));
                    }
                }
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    visit(ast, &mut out)?;
    Ok(out)
}
fn pseudo(ast: &mut [Element]) {
    for element in ast {
        match element {
            Element::Literal(v) if !v.value.trim().is_empty() => {
                let accented: String = v
                    .value
                    .chars()
                    .map(|c| match c {
                        'a' => 'á',
                        'e' => 'ë',
                        'i' => 'ï',
                        'o' => 'ô',
                        'u' => 'ü',
                        'A' => 'Á',
                        'E' => 'Ë',
                        'I' => 'Ï',
                        'O' => 'Ô',
                        'U' => 'Ü',
                        _ => c,
                    })
                    .collect();
                v.value = format!(
                    "⟦{accented}{}⟧",
                    "～".repeat(v.value.chars().count().div_ceil(2).max(3))
                );
            }
            Element::Select(v) => {
                for option in v.options.values_mut() {
                    pseudo(&mut option.value);
                }
            }
            Element::Plural(v) => {
                for option in v.options.values_mut() {
                    pseudo(&mut option.value);
                }
            }
            _ => {}
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLocale {
    pub display_name: String,
    pub fallback: Option<String>,
    pub direction: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema_version: u32,
    pub source_locale: String,
    pub hash: String,
    pub locales: BTreeMap<String, CatalogLocale>,
    pub messages: BTreeMap<String, BTreeMap<String, String>>,
}
pub struct Generated {
    pub warnings: Vec<crate::types::Diagnostic>,
    pub catalog: Catalog,
    pub keys: String,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportMessage {
    pub key: String,
    pub ja: String,
    #[serde(default)]
    pub en: Option<String>,
    /// Additional translations for locale codes already registered in Locales.
    #[serde(default)]
    pub translations: BTreeMap<String, String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub usage: Option<String>,
}

/// Load saved sources. Do not ignore unreadable tables and continue generation.
pub fn load(path: &Path) -> Result<Project> {
    let mut project = Project::open_project(&path.to_string_lossy())?;
    for entry in project.get_project_entries()? {
        if entry.entry_type == crate::ProjectEntryType::Table {
            let path = project.resolve_table_path(&PathBuf::from(entry.path))?;
            project.load_table(&path)?;
        }
    }
    Ok(project)
}
fn table<'a>(project: &'a Project, name: &str) -> Result<&'a Table> {
    let matches: Vec<_> = project
        .tables_data
        .values()
        .filter(|t| t.data.metadata.data_name == name)
        .collect();
    if matches.len() != 1 {
        return Err(coded(
            "settings.schema.tableCount",
            json!({"table": name, "count": matches.len()}),
        ));
    }
    Ok(matches[0])
}
/// Resolve a temporary compiler projection; raw authoring inputs stay intact.
fn effective_data(table: &Table) -> Result<TableData> {
    let mut data = table.data.clone();
    let resolver = crate::table::InheritanceResolver::new(&table.data);
    for (record, original) in data.records.iter_mut().zip(&table.data.records) {
        for column in &data.schema.columns {
            let value = resolver.input(original, column)?.to_owned();
            // This is an effective projection, not an authoring write: retain empty results.
            if column.interface_origin.is_some() {
                record.interface_values.insert(column.uuid.clone(), value);
            } else {
                record.values.insert(column.data_name.clone(), value);
            }
        }
    }
    Ok(data)
}
fn columns(name: &str) -> Vec<(&'static str, ValueType, bool)> {
    use ValueType::*;
    match name {
        "Messages" => vec![
            ("key", String, true),
            ("source_message", String, true),
            ("context", String, false),
            ("namespace", String, true),
            ("usage_location", String, false),
            ("source_revision", String, true),
            ("deprecated", Boolean, true),
        ],
        "Locales" => vec![
            ("code", String, true),
            ("display_name", String, true),
            ("fallback_locale", Reference, false),
            ("direction", Select, true),
            ("enabled", Boolean, true),
            ("required", Boolean, true),
        ],
        _ => vec![
            ("message_ref", Reference, true),
            ("locale_ref", Reference, true),
            ("message", String, true),
            ("status", Select, true),
            ("reviewed_source_revision", String, false),
            ("note", String, false),
        ],
    }
}
/// Validate schema, value types, and record UUIDs before both generation and import.
fn schema(project: &Project) -> Result<()> {
    let mut ids = BTreeSet::new();
    for name in table_names(project)? {
        let name = name.as_str();
        let data = effective_data(table(project, name)?)?;
        if !ids.insert(data.uuid.clone()) {
            return Err(coded(
                "settings.schema.duplicateTableId",
                json!({"table": name, "id": data.uuid}),
            ));
        }
        let mut names = BTreeSet::new();
        for column in &data.schema.columns {
            if !names.insert(column.data_name.as_str()) {
                return Err(coded(
                    "settings.schema.duplicateColumn",
                    json!({"table": name, "column": column.data_name}),
                ));
            }
        }
        for (field, kind, required) in columns(name) {
            let column = data
                .schema
                .columns
                .iter()
                .find(|c| c.data_name == field)
                .ok_or_else(|| {
                    coded(
                        "settings.schema.missingColumn",
                        json!({"table": name, "column": field}),
                    )
                })?;
            if column.data_type != kind || column.interface_origin.is_some() {
                return Err(coded(
                    "settings.schema.columnType",
                    json!({"table": name, "column": field, "expected": format!("{kind:?}"), "actual": format!("{:?}", column.data_type)}),
                ));
            }
            if kind == ValueType::Reference {
                let target = if field == "message_ref" {
                    "Messages"
                } else {
                    "Locales"
                };
                if column
                    .reference_config
                    .as_ref()
                    .map(|r| r.target_table_uuid.as_str())
                    != Some(table(project, target)?.data.uuid.as_str())
                {
                    return Err(coded(
                        "settings.schema.referenceConfig",
                        json!({"table": name, "column": field, "target": target}),
                    ));
                }
            }
            if kind == ValueType::Select {
                let expected = if field == "status" {
                    vec!["draft", "needs_review", "reviewed"]
                } else {
                    vec!["ltr", "rtl"]
                };
                let config = column.select_config.as_ref().ok_or_else(|| {
                    coded(
                        "settings.schema.selectConfig",
                        json!({"table": name, "column": field}),
                    )
                })?;
                config.validate().map_err(invalid)?;
                let actual: BTreeSet<_> = config.options.iter().map(|o| o.value.as_str()).collect();
                if actual != expected.into_iter().collect() {
                    return Err(coded(
                        "settings.schema.selectOptions",
                        json!({"table": name, "column": field}),
                    ));
                }
            }
            for (record_index, record) in data.records.iter().enumerate() {
                let value = text(record, field)?;
                if required && value.trim().is_empty() {
                    return Err(coded(
                        "settings.schema.emptyValue",
                        json!({"record": record.display_label_diagnostic(record_index), "recordId": record.uuid, "column": field}),
                    ));
                }
                match kind {
                    ValueType::Boolean => {
                        boolean(record, field)?;
                    }
                    ValueType::Reference if !value.is_empty() => {
                        uuid::Uuid::parse_str(value).map_err(|_| {
                            coded("settings.schema.valueType", json!({"record": record.display_label_diagnostic(record_index), "recordId": record.uuid, "column": field, "type": "UUID", "value": value}))
                        })?;
                    }
                    ValueType::Select
                        if !column
                            .select_config
                            .as_ref()
                            .unwrap()
                            .options
                            .iter()
                            .any(|o| o.value == value) =>
                    {
                        return Err(coded(
                            "settings.schema.selectValue",
                            json!({"table": name, "column": field, "value": value}),
                        ));
                    }
                    _ => {}
                }
            }
        }
        for record in &data.records {
            uuid::Uuid::parse_str(&record.uuid).map_err(|_| {
                coded(
                    "settings.schema.invalidRecordId",
                    json!({"table": name, "record": record.uuid}),
                )
            })?;
            if !ids.insert(record.uuid.clone()) {
                return Err(coded(
                    "settings.schema.duplicateRecord",
                    json!({"table": name, "record": record.uuid}),
                ));
            }
        }
    }
    Ok(())
}

/// strict=false allows unfinished translations and reviews, but always rejects structural corruption.
fn build(project: &Project, strict: bool) -> Result<Generated> {
    build_with_policy(project, strict, false)
}
fn build_with_policy(project: &Project, strict: bool, live: bool) -> Result<Generated> {
    schema(project)?;
    let mut warnings = Vec::new();
    let source = effective_data(table(project, "Messages")?)?;
    let locale_data = effective_data(table(project, "Locales")?)?;
    let translation_data = translation_tables(project)?
        .into_iter()
        .map(effective_data)
        .collect::<Result<Vec<_>>>()?;
    let mut locale_by_id = BTreeMap::new();
    let mut locale_by_code = BTreeMap::new();
    let mut locales = BTreeMap::new();
    for record in &locale_data.records {
        let code = text(record, "code")?;
        if code == PSEUDO
            || code.parse::<Locale>().is_err()
            || code.parse::<Locale>().unwrap().to_string() != code
        {
            return Err(coded(
                "settings.localization.localeInvalid",
                json!({"locale": code}),
            ));
        }
        if locale_by_code.insert(code, record).is_some() {
            return Err(coded(
                "settings.localization.duplicateLocale",
                json!({"locale": code}),
            ));
        }
        locale_by_id.insert(record.uuid.as_str(), record);
        if boolean(record, "required")? && !boolean(record, "enabled")? {
            return Err(coded(
                "settings.localization.requiredLocaleDisabled",
                json!({"locale": code}),
            ));
        }
    }
    for code in ["ja", "en"] {
        let r = locale_by_code.get(code).ok_or_else(|| {
            coded(
                "settings.localization.localeMissing",
                json!({"locale": code}),
            )
        })?;
        if !boolean(r, "enabled")? || !boolean(r, "required")? {
            return Err(coded(
                "settings.localization.localeFlags",
                json!({"locale": code}),
            ));
        }
    }
    for (&code, record) in &locale_by_code {
        let fallback = text(record, "fallback_locale")?;
        let target = if fallback.is_empty() {
            None
        } else {
            let target = locale_by_id.get(fallback).ok_or_else(|| {
                coded(
                    "settings.localization.fallbackMissing",
                    json!({"locale": code}),
                )
            })?;
            if !boolean(target, "enabled")? {
                return Err(coded(
                    "settings.localization.fallbackDisabled",
                    json!({"locale": code}),
                ));
            }
            Some(text(target, "code")?.to_owned())
        };
        if (code == SOURCE && target.is_some()) || (code != SOURCE && target.is_none()) {
            return Err(coded(
                "settings.localization.fallbackChain",
                json!({"locale": code}),
            ));
        }
        let mut visited = BTreeSet::new();
        let mut next = *record;
        loop {
            if !visited.insert(next.uuid.as_str()) {
                return Err(coded(
                    "settings.localization.fallbackCycle",
                    json!({"locale": code}),
                ));
            }
            let next_id = text(next, "fallback_locale")?;
            if next_id.is_empty() {
                break;
            }
            next = locale_by_id.get(next_id).ok_or_else(|| {
                coded(
                    "settings.localization.fallbackMissing",
                    json!({"locale": code}),
                )
            })?;
        }
        if boolean(record, "enabled")? {
            locales.insert(
                code.to_string(),
                CatalogLocale {
                    display_name: text(record, "display_name")?.into(),
                    fallback: target,
                    direction: text(record, "direction")?.into(),
                },
            );
        }
    }
    let mut by_key = BTreeMap::new();
    let mut by_id = BTreeMap::new();
    let mut args = BTreeMap::new();
    for record in &source.records {
        let key = text(record, "key")?;
        if !safe_name(key, true) || !key.contains('.') {
            return Err(coded(
                "settings.localization.semanticKey",
                json!({"key": key}),
            ));
        }
        if by_key.insert(key, record).is_some() {
            return Err(coded(
                "settings.localization.duplicateKey",
                json!({"key": key}),
            ));
        }
        by_id.insert(record.uuid.as_str(), record);
        let source = text(record, "source_message")?;
        if text(record, "namespace")? != key.split('.').next().unwrap_or_default() {
            return Err(coded(
                "settings.localization.namespace",
                json!({"key": key}),
            ));
        }
        if strict && text(record, "source_revision")? != digest(source.as_bytes()) {
            return Err(coded(
                "settings.localization.sourceRevision",
                json!({"key": key}),
            ));
        }
        args.insert(
            key,
            arguments(&parse(source).map_err(|e| {
                coded(
                    "settings.localization.messageError",
                    json!({"key": key, "locale": "ja", "error": crate::AppError::from(e)}),
                )
            })?)?,
        );
    }
    let mut pairs = BTreeMap::new();
    for (owner, translation) in translation_data.iter().flat_map(|table| {
        table
            .records
            .iter()
            .map(move |record| (&table.metadata.data_name, record))
    }) {
        let message = *by_id
            .get(text(translation, "message_ref")?)
            .ok_or_else(|| {
                coded("settings.schema.referenceMissing", json!({"record": record_label(translation), "recordId": translation.uuid, "column": "message_ref", "target": "Messages", "value": translation.values.get("message_ref")}))
            })?;
        let locale = *locale_by_id
            .get(text(translation, "locale_ref")?)
            .ok_or_else(|| {
                coded("settings.schema.referenceMissing", json!({"record": record_label(translation), "recordId": translation.uuid, "column": "locale_ref", "target": "Locales", "value": translation.values.get("locale_ref")}))
            })?;
        let key = text(message, "key")?;
        if owner != &translation_name(key)? {
            return Err(coded(
                "settings.localization.wrongDomain",
                json!({"record": record_label(translation), "recordId": translation.uuid, "key": key, "table": owner}),
            ));
        }
        let code = text(locale, "code")?;
        if pairs.insert((key, code), translation).is_some() {
            return Err(coded(
                "settings.localization.duplicateTranslation",
                json!({"key": key, "locale": code}),
            ));
        }
        let translation_args = arguments(&parse(text(translation, "message")?).map_err(|e| {
            coded(
                "settings.localization.messageError",
                json!({"key": key, "locale": code, "error": crate::AppError::from(e)}),
            )
        })?)?;
        if (strict || (!live && text(translation, "status")? == "reviewed"))
            && args[key] != translation_args
        {
            return Err(coded(
                "settings.localization.argumentsMismatch",
                json!({"key": key, "locale": code, "source": format!("{:?}", args[key]), "translation": format!("{translation_args:?}")}),
            ));
        }
        if code == SOURCE
            && text(translation, "message")? != text(message, "source_message")?
            && strict
        {
            return Err(coded(
                "settings.localization.sourceMismatch",
                json!({"key": key}),
            ));
        }
        if strict
            && !boolean(message, "deprecated")?
            && boolean(locale, "enabled")?
            && (text(translation, "status")? != "reviewed"
                || text(translation, "reviewed_source_revision")?
                    != text(message, "source_revision")?)
        {
            return Err(coded(
                "settings.localization.reviewRequired",
                json!({"key": key, "locale": code}),
            ));
        }
    }
    let mut messages: BTreeMap<String, BTreeMap<String, String>> = locales
        .keys()
        .map(|c| (c.clone(), BTreeMap::new()))
        .collect();
    let mut keys = String::from("// Generated by devcel localization export. Do not edit.\nexport interface MessageArgs {\n");
    let mut pseudo_messages = BTreeMap::new();
    for (&key, record) in &by_key {
        if boolean(record, "deprecated")? {
            continue;
        }
        for (code, locale) in &locale_by_code {
            if !boolean(locale, "enabled")? {
                continue;
            }
            if live && *code == SOURCE {
                messages
                    .get_mut(*code)
                    .unwrap()
                    .insert(key.to_string(), text(record, "source_message")?.into());
            } else if let Some(translation) = pairs.get(&(key, *code)) {
                if live && arguments(&parse(text(translation, "message")?)?)? != args[key] {
                    warnings.push(crate::types::Diagnostic::Code {
                        code: "settings.translationArgumentsFallback".into(),
                        params: serde_json::json!({ "key": key, "locale": code }),
                    });
                    continue;
                }
                messages
                    .get_mut(*code)
                    .unwrap()
                    .insert(key.to_string(), text(translation, "message")?.to_string());
            } else if strict && boolean(locale, "required")? {
                return Err(coded(
                    "settings.localization.translationMissing",
                    json!({"key": key, "locale": code}),
                ));
            } else if live {
                warnings.push(crate::types::Diagnostic::Code {
                    code: "settings.translationMissingFallback".into(),
                    params: serde_json::json!({ "key": key, "locale": code }),
                });
            }
        }
        let source_text = text(record, "source_message")?;
        let candidate = pairs
            .get(&(key, "en"))
            .map(|r| text(r, "message"))
            .transpose()?
            .unwrap_or(source_text);
        let mut ast = parse(candidate)?;
        // Import/reconcile saves stale English translations as needs_review. In this working state,
        // pseudo catalogs also use the source AST rather than forcing old translation arguments onto new source text.
        if !strict && arguments(&ast)? != args[key] {
            ast = parse(source_text)?;
        }
        pseudo(&mut ast);
        let value = print_ast(&ast);
        if arguments(&parse(&value)?)? != args[key] {
            return Err(coded(
                "settings.localization.pseudoArguments",
                json!({"key": key}),
            ));
        }
        pseudo_messages.insert(key.to_string(), value);
        keys.push_str(&format!("  {}: {{", serde_json::to_string(key)?));
        for (arg, kind) in &args[key] {
            keys.push_str(&format!(
                " {}: {};",
                serde_json::to_string(arg)?,
                kind.typescript()
            ));
        }
        keys.push_str(" };\n");
    }
    keys.push_str("}\nexport type MessageKey = keyof MessageArgs;\n");
    locales.insert(
        PSEUDO.into(),
        CatalogLocale {
            display_name: "English (Pseudo)".into(),
            fallback: Some(SOURCE.into()),
            direction: "ltr".into(),
        },
    );
    messages.insert(PSEUDO.into(), pseudo_messages);
    let mut catalog = Catalog {
        schema_version: 1,
        source_locale: SOURCE.into(),
        hash: String::new(),
        locales,
        messages,
    };
    catalog.hash = digest(&serde_json::to_vec(&catalog)?);
    Ok(Generated {
        catalog,
        keys,
        warnings,
    })
}
/// Keep already compiled UI call sites safe while permitting additional messages.
pub fn validate_message_contract(project: &Project, baseline: &TableData) -> Result<()> {
    let current = effective_data(table(project, "Messages")?)?;
    for expected in &baseline.records {
        if boolean(expected, "deprecated")? {
            continue;
        }
        let key = text(expected, "key")?;
        let actual = current
            .records
            .iter()
            .find(|r| r.values.get("key").map(String::as_str) == Some(key))
            .ok_or_else(|| coded("settings.localization.embeddedMissing", json!({"key": key})))?;
        if boolean(actual, "deprecated")?
            || arguments(&parse(text(actual, "source_message")?)?)?
                != arguments(&parse(text(expected, "source_message")?)?)?
        {
            return Err(coded(
                "settings.localization.embeddedContract",
                json!({"key": key}),
            ));
        }
    }
    Ok(())
}
/// Compile editable personal translations without release review/SHA bookkeeping.
/// Source Japanese is authoritative; unsafe argument-mismatched translations fall back.
pub fn compile_runtime(project: &Project) -> Result<Generated> {
    build_with_policy(project, false, true)
}
pub fn validate(project: &Project) -> Result<Generated> {
    build(project, true)
}

/// Do not change the output destination until all validation and both file builds finish.
/// --check is read-only and fails for missing or stale generated files.
pub fn export(project: &Project, out: &Path, check: bool) -> Result<String> {
    let generated = validate(project)?;
    let catalog = format!("{}\n", serde_json::to_string_pretty(&generated.catalog)?);
    let files = [("catalog.json", catalog), ("keys.ts", generated.keys)];
    if check {
        for (name, expected) in &files {
            if !fs::read_to_string(out.join(name))
                .is_ok_and(|actual| actual.replace("\r\n", "\n") == *expected)
            {
                return Err(coded(
                    "settings.schema.artifactStale",
                    json!({"path": out.join(name).to_string_lossy()}),
                ));
            }
        }
    } else {
        fs::create_dir_all(out)?;
        let mut prepared = Vec::new();
        for (name, value) in &files {
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
            if let Err(error) = file.persist(&path) {
                for (previous, original) in committed.iter().zip(&originals).rev() {
                    match original {
                        Some(bytes) => crate::utils::write_atomic(previous, bytes)?,
                        None => fs::remove_file(previous)?,
                    }
                }
                return Err(DevcelError::Io(error.error));
            }
            committed.push(path);
        }
    }
    Ok(generated.catalog.hash)
}

fn new_record(values: &[(&str, &str)]) -> Record {
    let mut record = Record::new();
    // Human-readable localization identity lives in key/display_name values.
    // Generated labels are bounded, collision-free portable identifiers.
    record.label = format!("record_{}", record.uuid.replace('-', ""));
    for (key, value) in values {
        record.set_value(key, (*value).to_string());
    }
    record
}
fn reference(target: &TableData, display: &str) -> ReferenceConfig {
    ReferenceConfig {
        target_table_uuid: target.uuid.clone(),
        display_column_uuid: target
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == display)
            .map(|c| c.uuid.clone()),
    }
}
fn set_choices(column: &mut ColumnSchema, values: &[&str]) {
    column.select_config = Some(SelectConfig {
        options: values
            .iter()
            .map(|v| SelectOption {
                value: (*v).into(),
                label: (*v).into(),
            })
            .collect(),
    });
}
/// Create ordinary message, locale and semantic-domain translation tables.
pub fn init(dir: &Path, name: &str) -> Result<PathBuf> {
    let mut project = Project::create_project(
        name,
        &dir.to_string_lossy(),
        "Devcel Studio localization sources (Messages / Locales / Translations)",
        crate::project_impl::DEFAULT_PROJECT_HEADER_COLOR,
    )?;
    for name in ["Messages", "Locales", "Translations_common"] {
        let relative = if let Some(domain) = name.strip_prefix(TRANSLATION_PREFIX) {
            format!("Translations/{domain}.table.toml")
        } else {
            format!("Localization/{name}.table.toml")
        };
        let path = project.create_table(PathBuf::from(relative))?;
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.metadata.data_name = name.into();
        table.data.display_name = name.into();
        table.data.description = match name {
            "Messages" => {
                "key is an ordinary String column containing semantic dot keys. source_revision is the source SHA256."
            }
            "Locales" => "ja/en are enabled and required. fallback is a record reference. en-XA is added only during generation.",
            _ => "Reference cells use standard Devcel UUIDs. After reviewing a translation, set status=reviewed and its source revision.",
        }
        .into();
        for (name, kind, required) in columns(name) {
            let mut column = ColumnSchema {
                data_name: name.into(),
                display_name: name.into(),
                data_type: kind,
                required: Some(required),
                ..Default::default()
            };
            column.default_value = match name {
                "source_revision" => "pending",
                "deprecated" | "required" => "false",
                "enabled" => "true",
                "direction" => "ltr",
                "status" => "draft",
                _ => "",
            }
            .into();
            column.style.width = if matches!(
                name,
                "source_message" | "message" | "context" | "usage_location"
            ) {
                420
            } else {
                180
            };
            if name == "status" {
                set_choices(&mut column, &["reviewed", "draft", "needs_review"]);
            }
            if name == "direction" {
                set_choices(&mut column, &["ltr", "rtl"]);
            }
            table.data.schema.columns.push(column);
        }
    }
    let messages = table(&project, "Messages")?.data.clone();
    let locales = table(&project, "Locales")?.data.clone();
    for table in project.tables_data.values_mut() {
        for column in &mut table.data.schema.columns {
            if column.data_type == ValueType::Reference {
                column.reference_config = Some(if column.data_name == "message_ref" {
                    reference(&messages, "key")
                } else {
                    reference(&locales, "code")
                });
            }
        }
        if table.data.metadata.data_name == "Locales" {
            let ja = new_record(&[
                ("code", "ja"),
                ("display_name", "日本語"),
                ("fallback_locale", ""),
                ("direction", "ltr"),
                ("enabled", "true"),
                ("required", "true"),
            ]);
            let en = new_record(&[
                ("code", "en"),
                ("display_name", "English"),
                ("fallback_locale", &ja.uuid),
                ("direction", "ltr"),
                ("enabled", "true"),
                ("required", "true"),
            ]);
            table.data.records = vec![ja, en];
        }
        Project::save_table(table)?;
    }
    let seed = [
        ("common.save", "保存", "Save"),
        ("common.cancel", "キャンセル", "Cancel"),
        ("common.close", "閉じる", "Close"),
        ("common.loading", "読み込み中…", "Loading…"),
        ("common.error", "エラー", "Error"),
        ("common.confirm", "確認", "Confirm"),
        ("common.delete", "削除", "Delete"),
        ("common.edit", "編集", "Edit"),
        ("common.add", "追加", "Add"),
        ("common.search", "検索", "Search"),
        ("common.create", "作成", "Create"),
        ("common.apply", "適用", "Apply"),
        ("common.back", "戻る", "Back"),
        ("common.next", "次へ", "Next"),
        ("common.ok", "OK", "OK"),
    ];
    let entries = seed
        .iter()
        .map(|(key, ja, en)| ImportMessage {
            key: (*key).into(),
            ja: (*ja).into(),
            en: Some((*en).into()),
            translations: BTreeMap::new(),
            context: Some("Common actions".into()),
            usage: Some("Shared Studio UI".into()),
        })
        .collect::<Vec<_>>();
    import(&mut project, &entries)?;
    Ok(project.path)
}

type WorkingTables = (
    BTreeMap<String, (PathBuf, TableData)>,
    HashMap<PathBuf, String>,
    BTreeSet<String>,
);

fn working(project: &Project) -> Result<WorkingTables> {
    schema(project)?;
    let mut tables = BTreeMap::new();
    let mut expected = HashMap::new();
    let dirty = BTreeSet::new();
    for name in table_names(project)? {
        let table = table(project, &name)?;
        expected.insert(table.path.clone(), crate::cell_rules::revision(&table.data));
        let data = effective_data(table)?;
        tables.insert(name.to_string(), (table.path.clone(), data));
    }
    Ok((tables, expected, dirty))
}
fn persist(
    project: &mut Project,
    mut tables: BTreeMap<String, (PathBuf, TableData)>,
    expected: HashMap<PathBuf, String>,
    dirty: &BTreeSet<String>,
) -> Result<()> {
    let old = project.tables_data.clone();
    // Working tables contain effective inputs for matching and validation. Restore
    // unchanged cells from raw authoring data, and make only actual edits local.
    for (path, data) in tables.values_mut() {
        if let Some(before) = old.get(path) {
            let resolver = crate::table::InheritanceResolver::new(&before.data);
            for row in &mut data.records {
                if let Some(original) = before.data.records.iter().find(|r| r.uuid == row.uuid) {
                    for column in &data.schema.columns {
                        let value = row.get_cell_value(column).cloned().unwrap_or_default();
                        if value == resolver.input(original, column)? {
                            row.remove_cell_value(column);
                            if let Some(raw) = original.get_cell_value(column) {
                                row.set_cell_value(column, raw.clone());
                            }
                        } else {
                            row.set_cell_value(column, value);
                        }
                    }
                }
            }
        }
    }
    for (path, data) in tables.values() {
        if let Some(before) = old.get(path) {
            crate::edit_controls::validate_transition(&before.data, data, false)?;
        } else {
            data.validate_storage_contract()?;
        }
    }
    for (path, data) in tables.values() {
        if let Some(table) = project.tables_data.get_mut(path) {
            table.data = data.clone();
        } else {
            project.tables_data.insert(
                path.clone(),
                Table {
                    path: path.clone(),
                    is_dirty: false,
                    data: data.clone(),
                    undo_history: Vec::new(),
                    redo_history: Vec::new(),
                },
            );
        }
    }
    // Allow unreviewed work to be saved, but never write structural, ICU, or reference errors to the source.
    if let Err(e) = build(project, false) {
        project.tables_data = old;
        return Err(e);
    }
    let entries = tables
        .iter()
        .map(|(name, (path, data))| (path.as_path(), dirty.contains(name).then_some(data)))
        .collect::<Vec<_>>();
    if let Err(e) = crate::table_mutation::persist_selected_tables(&entries, &expected, None) {
        project.tables_data = old;
        return Err(e);
    }
    Ok(())
}
fn ensure_domain(
    project: &Project,
    tables: &mut BTreeMap<String, (PathBuf, TableData)>,
    expected: &mut HashMap<PathBuf, String>,
    key: &str,
) -> Result<String> {
    let name = translation_name(key)?;
    if !tables.contains_key(&name) {
        let template = tables
            .values()
            .find(|(_, data)| is_translation_table(&data.metadata.data_name))
            .ok_or_else(|| coded("settings.localization.domainSchemaMissing", json!({})))?;
        let mut data = template.1.clone();
        data.uuid = uuid::Uuid::new_v4().to_string();
        data.metadata.data_name = name.clone();
        data.display_name = format!("Translations: {}", &name[TRANSLATION_PREFIX.len()..]);
        data.records.clear();
        // Domain tables remain ordinary movable tables. Place a new domain beside
        // its schema template so moving the folder never breaks later imports.
        let parent = template.0.parent().ok_or_else(|| {
            coded(
                "settings.localization.domainParent",
                json!({"path": template.0.to_string_lossy()}),
            )
        })?;
        let path = parent.join(format!("{}.table.toml", &name[TRANSLATION_PREFIX.len()..]));
        if project.tables_data.contains_key(&path) || path.try_exists()? {
            return Err(coded(
                "settings.localization.domainDestination",
                json!({"path": path.to_string_lossy()}),
            ));
        }
        expected.insert(
            path.clone(),
            crate::table_mutation::EXPECTED_ABSENT_REVISION.into(),
        );
        tables.insert(name.clone(), (path, data));
    }
    Ok(name)
}

type TranslationIndex = HashMap<(String, String), usize>;

fn translation_index(table: &TableData) -> TranslationIndex {
    let mut index = TranslationIndex::new();
    for (position, record) in table.records.iter().enumerate() {
        if let (Some(message), Some(locale)) = (
            record.values.get("message_ref"),
            record.values.get("locale_ref"),
        ) {
            // Preserve the previous first-match behavior; validation rejects duplicates.
            index
                .entry((message.clone(), locale.clone()))
                .or_insert(position);
        }
    }
    index
}

fn set_value_if_changed(record: &mut Record, name: &str, value: &str) -> bool {
    if record.values.get(name).map(String::as_str) == Some(value) {
        return false;
    }
    record.set_value(name, value.to_owned());
    true
}

fn upsert_translation(
    table: &mut TableData,
    index: &mut TranslationIndex,
    message: &Record,
    locale_id: &str,
    value: &str,
) -> bool {
    let key = (message.uuid.clone(), locale_id.to_owned());
    let (position, mut changed) = if let Some(&position) = index.get(&key) {
        (position, false)
    } else {
        let position = table.records.len();
        table.records.push(new_record(&[
            ("message_ref", &message.uuid),
            ("locale_ref", locale_id),
            ("message", ""),
            ("status", "draft"),
            ("reviewed_source_revision", ""),
            ("note", ""),
        ]));
        // These operations only append; existing record positions remain stable.
        index.insert(key, position);
        (position, true)
    };
    let record = &mut table.records[position];
    // Preserve existing user-authored labels; only new records receive generated labels.
    changed |= set_value_if_changed(record, "message", value);
    changed |= set_value_if_changed(record, "status", "reviewed");
    changed |= set_value_if_changed(
        record,
        "reviewed_source_revision",
        &message.values["source_revision"],
    );
    changed
}
/// Upsert temporary JSON into the source, preserving existing UUIDs and unspecified translations.
pub fn import(project: &mut Project, entries: &[ImportMessage]) -> Result<usize> {
    let (mut tables, mut expected, mut dirty) = working(project)?;
    // Do not hide existing duplicates or broken references by merely updating the first matching record.
    build(project, false)?;
    let mut seen = BTreeSet::new();
    let locale_ids: BTreeMap<String, String> = tables["Locales"]
        .1
        .records
        .iter()
        .map(|r| (r.values["code"].clone(), r.uuid.clone()))
        .collect();
    let mut messages = tables.remove("Messages").unwrap();
    let mut indexes = HashMap::new();
    for entry in entries {
        let domain = ensure_domain(project, &mut tables, &mut expected, &entry.key)?;
        let translations = &mut tables.get_mut(&domain).unwrap().1;
        let translation_index = indexes
            .entry(domain.clone())
            .or_insert_with(|| translation_index(translations));
        if !seen.insert(entry.key.as_str()) {
            return Err(coded(
                "settings.localization.duplicateKey",
                json!({"key": entry.key}),
            ));
        }
        for code in entry.translations.keys() {
            if code == SOURCE || (code == "en" && entry.en.is_some()) {
                return Err(coded(
                    "settings.localization.duplicateTranslation",
                    json!({"key": entry.key, "locale": code}),
                ));
            }
            if !locale_ids.contains_key(code) {
                return Err(coded(
                    "settings.localization.localeUnregistered",
                    json!({"key": entry.key, "locale": code}),
                ));
            }
        }
        let position = messages
            .1
            .records
            .iter()
            .position(|r| r.values.get("key") == Some(&entry.key));
        let mut message_changed = position.is_none();
        let record = if let Some(index) = position {
            &mut messages.1.records[index]
        } else {
            messages.1.records.push(new_record(&[
                ("key", &entry.key),
                ("source_message", ""),
                ("context", ""),
                ("namespace", entry.key.split('.').next().unwrap_or_default()),
                ("usage_location", ""),
                ("source_revision", ""),
                ("deprecated", "false"),
            ]));
            messages.1.records.last_mut().unwrap()
        };
        let revision = digest(entry.ja.as_bytes());
        let changed = record.values.get("source_revision") != Some(&revision);
        // Importing values does not migrate existing user-authored row labels.
        message_changed |= set_value_if_changed(record, "source_message", &entry.ja);
        message_changed |= set_value_if_changed(record, "source_revision", &revision);
        if let Some(context) = &entry.context {
            message_changed |= set_value_if_changed(record, "context", context);
        }
        if let Some(usage) = &entry.usage {
            message_changed |= set_value_if_changed(record, "usage_location", usage);
        }
        if message_changed {
            dirty.insert("Messages".into());
        }
        if changed {
            for tr in &mut translations.records {
                if tr.values.get("message_ref") == Some(&record.uuid)
                    && set_value_if_changed(tr, "status", "needs_review")
                {
                    dirty.insert(domain.clone());
                }
            }
        }
        if upsert_translation(
            translations,
            translation_index,
            record,
            &locale_ids["ja"],
            &entry.ja,
        ) {
            dirty.insert(domain.clone());
        }
        if let Some(en) = &entry.en {
            if upsert_translation(
                translations,
                translation_index,
                record,
                &locale_ids["en"],
                en,
            ) {
                dirty.insert(domain.clone());
            }
        }
        for (code, value) in &entry.translations {
            if upsert_translation(
                translations,
                translation_index,
                record,
                &locale_ids[code],
                value,
            ) {
                dirty.insert(domain.clone());
            }
        }
    }
    tables.insert("Messages".into(), messages);
    persist(project, tables, expected, &dirty)?;
    Ok(entries.len())
}
/// Explicitly reflect source edits saved through the UI in revisions and mark existing translations for review.
pub fn reconcile(project: &mut Project) -> Result<usize> {
    let (mut tables, mut expected, mut dirty) = working(project)?;
    let ja = tables["Locales"]
        .1
        .records
        .iter()
        .find(|r| r.values.get("code").map(String::as_str) == Some("ja"))
        .ok_or_else(|| {
            coded(
                "settings.localization.localeMissing",
                json!({"locale": "ja"}),
            )
        })?
        .uuid
        .clone();
    let mut messages = tables.remove("Messages").unwrap();
    let mut indexes = HashMap::new();
    let mut count = 0;
    for record in &mut messages.1.records {
        let domain = ensure_domain(project, &mut tables, &mut expected, text(record, "key")?)?;
        let translations = &mut tables.get_mut(&domain).unwrap().1;
        let translation_index = indexes
            .entry(domain.clone())
            .or_insert_with(|| translation_index(translations));
        let source = text(record, "source_message")?.to_string();
        let revision = digest(source.as_bytes());
        if text(record, "source_revision")? != revision {
            record.set_value("source_revision", revision);
            dirty.insert("Messages".into());
            count += 1;
            for tr in &mut translations.records {
                if tr.values.get("message_ref") == Some(&record.uuid)
                    && set_value_if_changed(tr, "status", "needs_review")
                {
                    dirty.insert(domain.clone());
                }
            }
        }
        if upsert_translation(translations, translation_index, record, &ja, &source) {
            dirty.insert(domain);
        }
    }
    tables.insert("Messages".into(), messages);
    persist(project, tables, expected, &dirty)?;
    Ok(count)
}

#[cfg(test)]
mod inheritance_projection_tests {
    use super::*;

    #[test]
    fn generated_labels_are_valid_unique_and_do_not_replace_message_keys() {
        let first = new_record(&[("key", "common.save")]);
        let second = new_record(&[("key", "common_save")]);
        crate::validate_data_name(&first.label).unwrap();
        crate::validate_data_name(&second.label).unwrap();
        assert_ne!(first.label, second.label);
        assert_eq!(
            first.label,
            format!("record_{}", first.uuid.replace('-', ""))
        );
        assert_eq!(first.values["key"], "common.save");
        assert_eq!(second.values["key"], "common_save");
    }

    #[test]
    fn translation_updates_preserve_existing_labels_and_identities() {
        let message = new_record(&[("key", "common.save"), ("source_revision", "revision")]);
        let dir = tempfile::tempdir().unwrap();
        let mut project =
            Project::create_project("Labels", dir.path().to_str().unwrap(), "", "#123456").unwrap();
        let path = project
            .create_table("Translations.table.toml".into())
            .unwrap();
        let mut table = project.tables_data[&path].data.clone();
        let mut index = TranslationIndex::new();
        assert!(upsert_translation(
            &mut table, &mut index, &message, "locale", "Save"
        ));
        crate::validate_data_name(&table.records[0].label).unwrap();
        let id = table.records[0].uuid.clone();
        table.records[0].label = "legacy / 翻訳".into();
        assert!(upsert_translation(
            &mut table, &mut index, &message, "locale", "Save now"
        ));
        assert_eq!(table.records.len(), 1);
        assert_eq!(table.records[0].uuid, id);
        assert_eq!(table.records[0].label, "legacy / 翻訳");
        assert_eq!(table.records[0].values["message_ref"], message.uuid);
    }

    #[test]
    fn projection_resolves_parent_and_preserves_explicit_empty_without_touching_raw() {
        let column = ColumnSchema {
            data_name: "status".into(),
            default_value: "draft".into(),
            ..Default::default()
        };
        let mut parent = Record::new();
        parent.set_cell_value(&column, "reviewed".into());
        let mut child = Record::new();
        child.parent_uuid = parent.uuid.clone();
        let dir = tempfile::tempdir().unwrap();
        let mut project =
            Project::create_project("Projection", dir.path().to_str().unwrap(), "", "#123456")
                .unwrap();
        let path = project.create_table("Values.table.toml".into()).unwrap();
        project.load_table(&path).unwrap();
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.schema.columns.push(column.clone());
        table.data.records.extend([parent, child]);
        let before = serde_json::to_value(&table.data).unwrap();
        assert_eq!(
            effective_data(table).unwrap().records[1].values["status"],
            "reviewed"
        );
        assert_eq!(serde_json::to_value(&table.data).unwrap(), before);
        table.data.records[1].set_cell_value(&column, String::new());
        assert_eq!(
            effective_data(table).unwrap().records[1].values["status"],
            "reviewed"
        );
        assert_eq!(
            effective_data(table).unwrap().records[1].values["status"],
            "reviewed"
        );
    }
}

#[cfg(test)]
mod release_contract_tests {
    use super::*;
    #[test]
    fn independent_contract_preserves_required_keys_and_exact_icu_arguments() {
        let directory = tempfile::tempdir().unwrap();
        let file = init(directory.path(), "Contracts").unwrap();
        let mut project = load(&file).unwrap();
        let path = project
            .tables_data
            .iter()
            .find(|(_, t)| t.data.metadata.data_name == "Messages")
            .unwrap()
            .0
            .clone();
        project.tables_data.get_mut(&path).unwrap().data.records[0]
            .values
            .insert("source_message".into(), "Value {amount, number}".into());
        let baseline = project.tables_data[&path].data.clone();
        validate_message_contract(&project, &baseline).unwrap();
        for message in [
            "Value",
            "Value {renamed, number}",
            "Value {amount}",
            "broken {",
        ] {
            project.tables_data.get_mut(&path).unwrap().data = baseline.clone();
            project.tables_data.get_mut(&path).unwrap().data.records[0]
                .values
                .insert("source_message".into(), message.into());
            assert!(
                validate_message_contract(&project, &baseline).is_err(),
                "{message}"
            );
        }
        project.tables_data.get_mut(&path).unwrap().data = baseline.clone();
        project.tables_data.get_mut(&path).unwrap().data.records[0]
            .values
            .insert("deprecated".into(), "true".into());
        assert!(validate_message_contract(&project, &baseline).is_err());
        project.tables_data.get_mut(&path).unwrap().data = baseline.clone();
        project
            .tables_data
            .get_mut(&path)
            .unwrap()
            .data
            .records
            .remove(0);
        let error = validate_message_contract(&project, &baseline).unwrap_err();
        assert!(format!("{error:?}").contains("embeddedMissing"));
        project.tables_data.get_mut(&path).unwrap().data = baseline.clone();
        project.tables_data.get_mut(&path).unwrap().data.records[0]
            .values
            .insert("source_message".into(), "Edited {amount, number}".into());
        let mut extra = baseline.records[0].clone();
        extra.uuid = uuid::Uuid::new_v4().to_string();
        extra.values.insert("key".into(), "custom.extra".into());
        project
            .tables_data
            .get_mut(&path)
            .unwrap()
            .data
            .records
            .push(extra);
        validate_message_contract(&project, &baseline).unwrap();
    }
}
