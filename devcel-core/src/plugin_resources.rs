//! Declarative plugin-owned tables. No plugin code or filesystem paths are executed.
//! Ownership is recorded in an ordinary settings-project registry; table edits remain
//! the source of truth and removing a package never removes these user documents.
use crate::{ColumnSchema, DevcelError, Project, Record, Result, Table, TableData, ValueType};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const REGISTRY_NAME: &str = "PluginResources";
pub const REGISTRY_UUID: &str = "682923bd-8e8d-55b6-a9dd-f628431954bd";
const MAX_TABLES: usize = 32;
const MAX_RESOURCE: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceManifest {
    #[serde(default)]
    pub settings_tables: Vec<ResourceDeclaration>,
    #[serde(default)]
    pub translation_tables: Vec<ResourceDeclaration>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceDeclaration {
    pub id: String,
    pub path: String,
    pub contract: String,
    #[serde(default)]
    pub cardinality: ResourceCardinality,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceCardinality {
    #[default]
    Singleton,
    Rows,
}
impl ResourceCardinality {
    pub fn name(self) -> &'static str {
        match self {
            Self::Singleton => "singleton",
            Self::Rows => "rows",
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Settings,
    Translations,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceTable {
    pub id: String,
    pub kind: ResourceKind,
    #[serde(default)]
    pub cardinality: ResourceCardinality,
    pub table: TableData,
    pub contract: crate::interface::Interface,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceTables {
    pub owner: String,
    pub tables: Vec<ResourceTable>,
    /// Previous approved package defaults, supplied by the host, never by plugin JSON.
    #[serde(default)]
    pub previous_tables: Vec<ResourceTable>,
}
pub type Settings = BTreeMap<String, BTreeMap<String, Value>>;
pub type Translations = BTreeMap<String, BTreeMap<String, BTreeMap<String, String>>>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLabel {
    pub owner: String,
    pub key: String,
    pub source: String,
}
pub type Labels = BTreeMap<String, ResourceLabel>;
#[derive(Default)]
pub struct CompiledResources {
    pub settings: Settings,
    pub translations: Translations,
    pub labels: Labels,
}
fn invalid(reason: &str, owner: &str, table: &str) -> DevcelError {
    DevcelError::Diagnostics(vec![crate::types::Diagnostic::Code {
        code: format!("plugin.resources.error.{reason}"),
        params: json!({"owner":owner,"table":table}),
    }])
}
pub fn valid_owner(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
        && !id.contains("..")
        && !id.ends_with('.')
        && !matches!(id, "constructor" | "prototype" | "__proto__")
}
pub(crate) fn valid_key(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id.as_bytes()[0].is_ascii_alphabetic()
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        && !matches!(id, "constructor" | "prototype" | "__proto__")
}
pub fn table_name(owner: &str, id: &str) -> String {
    format!(
        "Plugin_{}_{}",
        owner
            .bytes()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        id
    )
}
fn safe_path(path: &str, suffix: &str) -> bool {
    path.len() <= 512
        && path.ends_with(suffix)
        && !path.starts_with('/')
        && !path.contains('\\')
        && path.split('/').all(|part| {
            !part.is_empty()
                && !matches!(part, "." | "..")
                && !part.ends_with(['.', ' '])
                && !part
                    .chars()
                    .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        })
}
/// Package readers must reject symlinks/special ZIP entries before supplying bytes.
/// Only declared resources are parsed; every table is validated before returning.
pub fn validate_resources(
    owner: &str,
    manifest: &ResourceManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<ResourceTables> {
    if !valid_owner(owner) {
        return Err(invalid("owner", owner, ""));
    }
    if manifest.settings_tables.len() + manifest.translation_tables.len() > MAX_TABLES {
        return Err(invalid("limit", owner, ""));
    }
    let total = manifest
        .settings_tables
        .iter()
        .chain(&manifest.translation_tables)
        .flat_map(|declaration| [&declaration.path, &declaration.contract])
        .filter_map(|path| files.get(path))
        .map(Vec::len)
        .sum::<usize>();
    if total > 8 * 1024 * 1024 {
        return Err(invalid("limit", owner, ""));
    }
    let mut result = ResourceTables {
        owner: owner.into(),
        tables: vec![],
        previous_tables: vec![],
    };
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for (kind, declarations) in [
        (ResourceKind::Settings, &manifest.settings_tables),
        (ResourceKind::Translations, &manifest.translation_tables),
    ] {
        for declaration in declarations {
            if !valid_key(&declaration.id) || !ids.insert(declaration.id.clone()) {
                return Err(invalid("tableId", owner, &declaration.id));
            }
            if !safe_path(&declaration.path, ".table.toml")
                || !paths.insert(declaration.path.to_lowercase())
                || !safe_path(&declaration.contract, ".interface.toml")
            {
                return Err(invalid("path", owner, &declaration.id));
            }
            let bytes = files
                .get(&declaration.path)
                .ok_or_else(|| invalid("missing", owner, &declaration.id))?;
            if bytes.len() > MAX_RESOURCE {
                return Err(invalid("limit", owner, &declaration.id));
            }
            let parse_error = |error: crate::AppError| {
                crate::app_error::diagnostic(
                    "grid.errorWithCause",
                    serde_json::json!({
                        "summary": crate::AppError::from(invalid("parse", owner, &declaration.id)).into_diagnostic(),
                        "error": error.into_diagnostic(),
                    }),
                )
            };
            let text = std::str::from_utf8(bytes).map_err(|error| {
                parse_error(crate::AppError::code(
                    "error.parse",
                    serde_json::json!({"details": error.to_string()}),
                ))
            })?;
            let table = TableData::from_toml(text).map_err(|error| parse_error(error.into()))?;
            if table.metadata.data_name != table_name(owner, &declaration.id) {
                return Err(invalid("namespace", owner, &declaration.id));
            }
            let cardinality = if kind == ResourceKind::Translations {
                ResourceCardinality::Rows
            } else {
                declaration.cardinality
            };
            let contract_bytes = files
                .get(&declaration.contract)
                .ok_or_else(|| invalid("missing", owner, &declaration.id))?;
            if contract_bytes.len() > MAX_RESOURCE {
                return Err(invalid("limit", owner, &declaration.id));
            }
            let contract: crate::interface::Interface = toml::from_str(
                std::str::from_utf8(contract_bytes)
                    .map_err(|_| invalid("parse", owner, &declaration.id))?,
            )
            .map_err(|_| invalid("parse", owner, &declaration.id))?;
            validate_resource_contract(owner, &declaration.id, &table, &contract)?;
            validate_table(owner, &declaration.id, kind, cardinality, &table, None)?;
            result.tables.push(ResourceTable {
                id: declaration.id.clone(),
                kind,
                cardinality,
                table,
                contract,
            });
        }
    }
    validate_resource_ids(&result)?;
    Ok(result)
}
pub fn contract_name(owner: &str, id: &str) -> String {
    format!("{}_Contract", table_name(owner, id))
}
fn validate_resource_contract(
    owner: &str,
    id: &str,
    table: &TableData,
    contract: &crate::interface::Interface,
) -> Result<()> {
    if !contract.name.starts_with(&table_name(owner, ""))
        || !contract.name.ends_with("_Contract")
        || !contract.extends.is_empty()
        || table.interface_implementations.len() != 1
        || table.metadata.interface_order != [contract.uuid]
    {
        return Err(invalid("schema", owner, id));
    }
    let mut registry = crate::interface::InterfaceRegistry::new();
    registry.add_interface(contract.clone())?;
    crate::plugin_resource_registry::validate_target(table, contract, &registry)
}
pub fn validate_resource_ids(resources: &ResourceTables) -> Result<()> {
    let mut ids = BTreeMap::<String, Option<String>>::new();
    let mut contracts = BTreeMap::new();
    let mut names = BTreeSet::new();
    for item in &resources.tables {
        if !valid_key(&item.id) || !names.insert(&item.id) {
            return Err(invalid("tableId", &resources.owner, &item.id));
        }
        validate_resource_contract(&resources.owner, &item.id, &item.table, &item.contract)?;
        let snapshot = serde_json::to_value(&item.contract)?;
        match contracts.insert(item.contract.uuid, snapshot.clone()) {
            Some(previous) if previous != snapshot => {
                return Err(invalid("identity", &resources.owner, &item.id))
            }
            Some(_) => (),
            None => {
                if ids.insert(item.contract.uuid.to_string(), None).is_some() {
                    return Err(invalid("identity", &resources.owner, &item.id));
                }
            }
        }
        let entries = std::iter::once((item.table.uuid.clone(), None))
            .chain(
                item.table
                    .schema
                    .columns
                    .iter()
                    .map(|c| (c.uuid.clone(), c.interface_origin.clone())),
            )
            .chain(item.table.records.iter().map(|r| (r.uuid.clone(), None)));
        for (id, origin) in entries {
            if uuid::Uuid::parse_str(&id).is_err() {
                return Err(invalid("identity", &resources.owner, &item.id));
            }
            if let Some(previous) = ids.insert(id, origin.clone()) {
                if origin.is_none() || origin != previous {
                    return Err(invalid("identity", &resources.owner, &item.id));
                }
            }
        }
    }
    Ok(())
}
pub fn scalar(column: &ColumnSchema, input: &str, owner: &str, table: &str) -> Result<Value> {
    use ValueType::*;
    if !matches!(
        column.data_type,
        String | Select | Boolean | U8 | I8 | U16 | I16 | U32 | I32 | F32 | F64 | U64 | I64
    ) {
        return Err(invalid("schema", owner, table));
    }
    if column.required.unwrap_or(false) && input.trim().is_empty() {
        return Err(invalid("value", owner, table));
    }
    // Empty optional strings are strings; an unset optional scalar is JSON null.
    // Literal "null" is not a special sentinel and still goes through type validation.
    if input.is_empty()
        && !column.required.unwrap_or(false)
        && column.data_type != String
        && column.data_type != Select
    {
        return Ok(Value::Null);
    }
    if !column.data_type.validate(input) {
        return Err(invalid("value", owner, table));
    }
    Ok(match column.data_type {
        String => Value::String(input.into()),
        Select => {
            let select = column
                .select_config
                .as_ref()
                .ok_or_else(|| invalid("schema", owner, table))?;
            select
                .validate()
                .map_err(|_| invalid("schema", owner, table))?;
            if !select.options.iter().any(|o| o.value == input) {
                return Err(invalid("value", owner, table));
            }
            Value::String(input.into())
        }
        Boolean => Value::Bool(input == "true"),
        U8 | I8 | U16 | I16 | U32 | I32 | F32 | F64 => serde_json::from_str(input)
            .ok()
            .filter(Value::is_number)
            .ok_or_else(|| invalid("value", owner, table))?,
        // 64-bit integers remain strings so JavaScript cannot silently lose precision.
        U64 | I64 => Value::String(input.into()),
        _ => return Err(invalid("schema", owner, table)),
    })
}
fn effective(table: &TableData) -> Result<Vec<Record>> {
    let resolver = crate::table::InheritanceResolver::new(table);
    let mut records = table.records.clone();
    for (row, original) in records.iter_mut().zip(&table.records) {
        for c in &table.schema.columns {
            row.values
                .insert(c.data_name.clone(), resolver.input(original, c)?.into());
        }
    }
    Ok(records)
}
pub fn validate_table(
    owner: &str,
    id: &str,
    kind: ResourceKind,
    cardinality: ResourceCardinality,
    table: &TableData,
    locales: Option<&BTreeSet<String>>,
) -> Result<()> {
    table.validate_storage_contract().map_err(|error| {
        crate::app_error::diagnostic(
            "grid.errorWithCause",
            serde_json::json!({
                "summary": crate::AppError::from(invalid("schema", owner, id)).into_diagnostic(),
                "error": crate::AppError::from(error).into_diagnostic(),
            }),
        )
    })?;
    if !table.metadata.parent_uuid.is_empty()
        || table.schema.columns.is_empty()
        || table.schema.columns.len() > 128
        || table.records.len() > 10000
        || table
            .schema
            .columns
            .iter()
            .any(|c| !valid_key(&c.data_name))
    {
        return Err(invalid("schema", owner, id));
    }
    let rows = effective(table)?;
    match kind {
        ResourceKind::Settings => {
            if cardinality == ResourceCardinality::Singleton && rows.len() != 1 {
                return Err(invalid("singleton", owner, id));
            }
            for c in &table.schema.columns {
                // An absent default is not an effective cell. Required columns may
                // obtain their value from every record instead.
                if !c.default_value.is_empty() {
                    scalar(c, &c.default_value, owner, id)?;
                }
                if !matches!(
                    c.data_type,
                    ValueType::String
                        | ValueType::Select
                        | ValueType::Boolean
                        | ValueType::U8
                        | ValueType::I8
                        | ValueType::U16
                        | ValueType::I16
                        | ValueType::U32
                        | ValueType::I32
                        | ValueType::F32
                        | ValueType::F64
                        | ValueType::U64
                        | ValueType::I64
                ) {
                    return Err(invalid("schema", owner, id));
                }
                for row in &rows {
                    scalar(
                        c,
                        row.values
                            .get(&c.data_name)
                            .ok_or_else(|| invalid("value", owner, id))?,
                        owner,
                        id,
                    )?;
                }
            }
        }
        ResourceKind::Translations => {
            if !(3..=4).contains(&table.schema.columns.len())
                || table.schema.columns.iter().any(|c| {
                    !["key", "locale", "text", "source"].contains(&c.data_name.as_str())
                        || c.data_type != ValueType::String
                })
                || ["key", "locale", "text"].iter().any(|name| {
                    !table
                        .schema
                        .columns
                        .iter()
                        .any(|c| c.data_name == *name && c.data_type == ValueType::String)
                })
            {
                return Err(invalid("schema", owner, id));
            }
            let mut keys = BTreeSet::new();
            let mut fallback = BTreeSet::new();
            let mut all = BTreeSet::new();
            for r in rows {
                let key = r
                    .values
                    .get("key")
                    .ok_or_else(|| invalid("value", owner, id))?;
                let locale = r
                    .values
                    .get("locale")
                    .ok_or_else(|| invalid("value", owner, id))?;
                let text = r
                    .values
                    .get("text")
                    .ok_or_else(|| invalid("value", owner, id))?;
                if key.len() > 200
                    || !key.split('.').all(valid_key)
                    || !keys.insert((locale.clone(), key.clone()))
                {
                    return Err(invalid("messageCollision", owner, id));
                }
                if locale.is_empty()
                    || locale.len() > 40
                    || !locale
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    || locales.is_some_and(|l| !l.contains(locale))
                {
                    return Err(invalid("locale", owner, id));
                }
                use formatjs_icu_messageformat_parser::{Parser, ParserOptions};
                Parser::new(
                    text,
                    ParserOptions {
                        ignore_tag: true,
                        requires_other_clause: true,
                        should_parse_skeletons: true,
                        ..Default::default()
                    },
                )
                .parse()
                .map_err(|_| invalid("icu", owner, id))?;
                all.insert(key.clone());
                if locale == "en" {
                    fallback.insert(key.clone());
                }
            }
            if all != fallback {
                return Err(invalid("fallback", owner, id));
            }
        }
    }
    Ok(())
}
pub fn registry(project: &Project) -> Result<Option<&Table>> {
    let mut tables = project
        .tables_data
        .values()
        .filter(|t| t.data.metadata.data_name == REGISTRY_NAME);
    let first = tables.next();
    if tables.next().is_some() || first.is_some_and(|t| t.data.uuid != REGISTRY_UUID) {
        return Err(invalid("registry", "", ""));
    }
    Ok(first)
}
#[derive(Debug)]
pub struct RegistryBinding {
    pub record_uuid: String,
    pub registration_uuid: String,
    pub contract_uuid: uuid::Uuid,
    pub owner: String,
    pub id: String,
    pub table_uuid: String,
    pub kind: ResourceKind,
    pub cardinality: ResourceCardinality,
}

// Read exactly the effective values shown by the settings editor. All consumers
// share validation so defaults/inheritance cannot change ownership between paths.
pub fn registry_bindings(
    data: &TableData,
    tables: &crate::plugin_resource_registry::Tables,
    interfaces: &crate::interface::InterfaceRegistry,
) -> Result<Vec<RegistryBinding>> {
    crate::plugin_resource_registry::bindings(data, tables, interfaces).map(|bindings| {
        bindings
            .into_iter()
            .map(|b| RegistryBinding {
                record_uuid: b.catalog_record_uuid,
                registration_uuid: b.registration_uuid,
                contract_uuid: b.contract_uuid,
                owner: b.owner,
                id: b.id,
                table_uuid: b.target_uuid,
                kind: b.kind,
                cardinality: b.cardinality,
            })
            .collect()
    })
}

/// A registration is an active dependency even when the package is disabled.
/// Removal must first be an explicit registry transaction, never implicit data loss.
pub fn require_unregistered_table(
    registry: &TableData,
    table_uuid: &str,
    tables: &crate::plugin_resource_registry::Tables,
    interfaces: &crate::interface::InterfaceRegistry,
) -> Result<()> {
    for binding in registry_bindings(registry, tables, interfaces)? {
        if binding.table_uuid == table_uuid || binding.registration_uuid == table_uuid {
            return Err(crate::app_error::diagnostic(
                "error.referencedRowDelete",
                json!({
                    "table": registry.display_name,
                    "row": format!("{} / {}", binding.owner, binding.id),
                    "column": "registration / target"
                }),
            ));
        }
    }
    Ok(())
}

/// Preserve the package's contract at the ordinary authoring boundary.
/// Resolve membership from the typed registry; a Plugin-looking name is only a fast filter.
pub(crate) fn validate_authoring_transition(
    project: &Project,
    before: &TableData,
    after: &TableData,
) -> Result<()> {
    if !before.metadata.data_name.starts_with("Plugin_") {
        return Ok(());
    }
    let catalog = project.get_table_catalog()?;
    let Some(root) = catalog.iter().find(|entry| entry.uuid == REGISTRY_UUID) else {
        return Ok(());
    };
    let mut tables = crate::plugin_resource_registry::Tables::new();
    for entry in catalog
        .iter()
        .filter(|entry| entry.uuid == REGISTRY_UUID || entry.data_name.starts_with("Plugin_"))
    {
        let data = if entry.uuid == before.uuid {
            before.clone()
        } else {
            project.read_table_data_by_uuid(&entry.uuid)?
        };
        let path = std::path::PathBuf::from(&entry.path);
        tables.insert(
            path.clone(),
            Table {
                path,
                data,
                is_dirty: false,
                undo_history: vec![],
                redo_history: vec![],
            },
        );
    }
    let root_data = &tables[&std::path::PathBuf::from(&root.path)].data;
    let binding = registry_bindings(root_data, &tables, &project.interface_registry)?
        .into_iter()
        .find(|binding| binding.table_uuid == before.uuid);
    let Some(binding) = binding else {
        return Ok(());
    };
    if before.metadata.data_name != after.metadata.data_name
        || before.schema.columns.len() != after.schema.columns.len()
        || after.metadata.edit_permissions.add_columns
        || after.metadata.edit_permissions.delete_columns
        || (binding.cardinality == ResourceCardinality::Singleton
            && (after.records.len() != 1
                || before.records[0].uuid != after.records[0].uuid
                || after.metadata.edit_permissions.add_rows
                || after.metadata.edit_permissions.delete_rows))
    {
        return Err(invalid("schema", &binding.owner, &binding.id));
    }
    let contract = project
        .interface_registry
        .get_interface(&binding.contract_uuid)
        .ok_or_else(|| invalid("schema", &binding.owner, &binding.id))?;
    crate::plugin_resource_registry::validate_target(after, contract, &project.interface_registry)?;
    validate_table(
        &binding.owner,
        &binding.id,
        binding.kind,
        binding.cardinality,
        after,
        None,
    )
}

fn validate_project_identities(
    tables: &std::collections::HashMap<std::path::PathBuf, Table>,
    registry: &TableData,
    interfaces: &crate::interface::InterfaceRegistry,
    owner: &str,
) -> Result<()> {
    let bindings = registry_bindings(registry, tables, interfaces)?;
    let owned: BTreeSet<&str> = bindings
        .iter()
        .flat_map(|binding| {
            [
                binding.table_uuid.as_str(),
                binding.registration_uuid.as_str(),
            ]
        })
        .collect();
    let mut identities = BTreeMap::<&str, (&str, Option<&str>)>::new();
    for table in tables.values() {
        let table_id = table.data.uuid.as_str();
        let entries = std::iter::once((table_id, None))
            .chain(
                table
                    .data
                    .schema
                    .columns
                    .iter()
                    .map(|c| (c.uuid.as_str(), c.interface_origin.as_deref())),
            )
            .chain(table.data.records.iter().map(|r| (r.uuid.as_str(), None)));
        for (id, origin) in entries {
            if let Some((previous, previous_origin)) = identities.insert(id, (table_id, origin)) {
                if (owned.contains(table_id) || owned.contains(previous))
                    && (origin.is_none() || origin != previous_origin)
                {
                    return Err(invalid("identity", owner, ""));
                }
            }
        }
    }
    Ok(())
}
/// Strict all-or-nothing projection. Owner/table and owner/locale/key collisions
/// fail the complete snapshot instead of publishing a partially registered plugin.
pub fn compile(project: &Project, locales: &BTreeSet<String>) -> Result<CompiledResources> {
    let mut result = CompiledResources::default();
    let mut label_sources = BTreeMap::<(String, String), String>::new();
    let Some(registry) = registry(project)? else {
        return Ok(result);
    };
    validate_project_identities(
        &project.tables_data,
        &registry.data,
        &project.interface_registry,
        "",
    )?;
    let bindings = registry_bindings(
        &registry.data,
        &project.tables_data,
        &project.interface_registry,
    )?;
    for binding in &bindings {
        let owner = binding.owner.as_str();
        let id = binding.id.as_str();
        let uuid = binding.table_uuid.as_str();
        let kind = binding.kind;
        let cardinality = binding.cardinality;
        let mut matching = project.tables_data.values().filter(|t| t.data.uuid == uuid);
        let table = matching
            .next()
            .ok_or_else(|| invalid("missing", owner, id))?;
        if matching.next().is_some() || table.data.metadata.data_name != table_name(owner, id) {
            return Err(invalid("namespace", owner, id));
        }
        validate_table(owner, id, kind, cardinality, &table.data, Some(locales))?;
        let rows = effective(&table.data)?;
        result.labels.insert(
            table.data.uuid.clone(),
            ResourceLabel {
                owner: owner.into(),
                key: format!("{id}.title"),
                source: table.data.display_name.clone(),
            },
        );
        for column in &table.data.schema.columns {
            result.labels.insert(
                column.uuid.clone(),
                ResourceLabel {
                    owner: owner.into(),
                    key: format!("{id}.{}", column.data_name),
                    source: column.display_name.clone(),
                },
            );
            if let Some(select) = &column.select_config {
                for option in &select.options {
                    let encoded = option
                        .value
                        .bytes()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>();
                    result.labels.insert(
                        format!("{}\0{}", column.uuid, option.value),
                        ResourceLabel {
                            owner: owner.into(),
                            key: format!("{id}.{}.option.x{encoded}", column.data_name),
                            source: option.label.clone(),
                        },
                    );
                }
            }
        }

        match kind {
            ResourceKind::Settings => {
                let values = rows
                    .iter()
                    .map(|row| {
                        table
                            .data
                            .schema
                            .columns
                            .iter()
                            .map(|c| {
                                Ok((
                                    c.data_name.clone(),
                                    scalar(c, &row.values[&c.data_name], owner, id)?,
                                ))
                            })
                            .collect::<Result<BTreeMap<String, Value>>>()
                    })
                    .collect::<Result<Vec<_>>>()?;
                let value = if cardinality == ResourceCardinality::Singleton {
                    json!(values[0])
                } else {
                    json!(rows
                        .iter()
                        .zip(values)
                        .map(|(row, values)| json!({"id":row.uuid,"values":values}))
                        .collect::<Vec<_>>())
                };
                result
                    .settings
                    .entry(owner.into())
                    .or_default()
                    .insert(id.into(), value);
            }

            ResourceKind::Translations => {
                for row in rows {
                    let locale = &row.values["locale"];
                    let key = &row.values["key"];
                    if let Some(source) = row.values.get("source").filter(|value| !value.is_empty())
                    {
                        if label_sources
                            .insert((owner.into(), key.clone()), source.clone())
                            .is_some_and(|previous| previous != *source)
                        {
                            return Err(invalid("schema", owner, id));
                        }
                    }
                    if result
                        .translations
                        .entry(owner.into())
                        .or_default()
                        .entry(locale.clone())
                        .or_default()
                        .insert(key.clone(), row.values["text"].clone())
                        .is_some()
                    {
                        return Err(invalid("messageCollision", owner, id));
                    }
                }
            }
        }
    }
    // Original labels are explicit plugin data, not the currently edited
    // metadata. Custom table/column/option names must remain user-authored.
    result.labels.retain(|_, label| {
        if let Some(source) = label_sources.get(&(label.owner.clone(), label.key.clone())) {
            label.source = source.clone();
            true
        } else {
            false
        }
    });
    Ok(result)
}
fn translation_identities(table: &TableData) -> Result<BTreeSet<(String, String)>> {
    effective(table)?
        .into_iter()
        .map(|row| {
            Ok((
                row.values
                    .get("key")
                    .ok_or_else(|| invalid("value", "", ""))?
                    .clone(),
                row.values
                    .get("locale")
                    .ok_or_else(|| invalid("value", "", ""))?
                    .clone(),
            ))
        })
        .collect()
}
/// Merge a fully validated package into an in-memory staging project. Existing
/// authored rows/columns win, compatible additions are seeded, never removed.
/// Caller writes this candidate only after whole-project compilation succeeds.
pub fn merge_resources(project: &mut Project, resources: &ResourceTables) -> Result<()> {
    if !valid_owner(&resources.owner) {
        return Err(invalid("owner", &resources.owner, ""));
    }
    validate_resource_ids(resources)?;
    let root = project
        .path
        .parent()
        .ok_or_else(|| invalid("registry", "", ""))?
        .to_path_buf();
    let mut staged = project.tables_data.clone();
    let mut interfaces = project.interface_registry.clone();
    // Schema 2 requires an existing, loaded ownership registry. A lazy Project
    // has no tables_data; treating that as an empty source would overwrite
    // authored tables with package defaults when the candidate is persisted.
    let mut registry = registry(project)?
        .cloned()
        .ok_or_else(|| invalid("registry", &resources.owner, ""))?;
    let registry_path = registry.path.clone();
    for item in &resources.tables {
        validate_resource_contract(&resources.owner, &item.id, &item.table, &item.contract)?;
        let previous = resources
            .previous_tables
            .iter()
            .find(|table| table.id == item.id && table.table.uuid == item.table.uuid);
        validate_table(
            &resources.owner,
            &item.id,
            item.kind,
            item.cardinality,
            &item.table,
            None,
        )?;
        if item.table.metadata.data_name != table_name(&resources.owner, &item.id) {
            return Err(invalid("namespace", &resources.owner, &item.id));
        }
        let bindings = registry_bindings(&registry.data, &staged, &interfaces)?;
        let binding = bindings
            .iter()
            .find(|r| r.owner == resources.owner && r.id == item.id);
        if binding.is_some_and(|r| {
            r.table_uuid != item.table.uuid
                || r.contract_uuid != item.contract.uuid
                || r.kind != item.kind
                || r.cardinality != item.cardinality
        }) {
            return Err(invalid("collision", &resources.owner, &item.id));
        }
        if bindings.iter().any(|r| {
            r.table_uuid == item.table.uuid
                && Some(r.record_uuid.as_str()) != binding.map(|b| b.record_uuid.as_str())
        }) {
            return Err(invalid("collision", &resources.owner, &item.id));
        }
        let existing = staged
            .iter()
            .find(|(_, t)| t.data.uuid == item.table.uuid)
            .map(|(p, t)| (p.clone(), t.clone()));
        if binding.is_none() && existing.is_some() {
            return Err(invalid("collision", &resources.owner, &item.id));
        }
        if staged.values().any(|t| {
            t.data.metadata.data_name == item.table.metadata.data_name
                && t.data.uuid != item.table.uuid
        }) {
            return Err(invalid("collision", &resources.owner, &item.id));
        }
        if interfaces
            .get_all_interfaces()
            .iter()
            .any(|c| c.name == item.contract.name && c.uuid != item.contract.uuid)
            || (binding.is_none()
                && interfaces
                    .get_interface(&item.contract.uuid)
                    .is_some_and(|existing| {
                        serde_json::to_value(existing).ok()
                            != serde_json::to_value(&item.contract).ok()
                    }))
        {
            return Err(invalid("identity", &resources.owner, &item.id));
        }
        let contract_path = interfaces
            .get_interface_path(&item.contract.uuid)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                std::path::Path::new("Plugins")
                    .join(&resources.owner)
                    .join(format!("{}.interface.toml", item.contract.uuid))
                    .to_string_lossy()
                    .into_owned()
            });
        interfaces.add_interface_with_path(contract_path, item.contract.clone())?;
        let mut merged = if let Some((_, table)) = &existing {
            table.data.clone()
        } else {
            item.table.clone()
        };
        if existing.is_some() {
            for column in &item.table.schema.columns {
                match merged
                    .schema
                    .columns
                    .iter()
                    .find(|c| c.uuid == column.uuid || c.data_name == column.data_name)
                {
                    Some(old)
                        if old.uuid != column.uuid
                            || old.data_name != column.data_name
                            || old.data_type != column.data_type =>
                    {
                        return Err(invalid("upgrade", &resources.owner, &item.id))
                    }
                    Some(_) => (),
                    None => {
                        merged.schema.columns.push(column.clone());
                        for row in &mut merged.records {
                            row.set_cell_value(column, column.default_value.clone());
                        }
                    }
                }
            }
            // Settings singleton identity is stable; translation additions merge
            // by locale/key, keeping authored translations even if defaults change.
            if item.kind == ResourceKind::Settings && item.cardinality == ResourceCardinality::Rows
            {
                for row in &item.table.records {
                    if !merged.records.iter().any(|old| old.uuid == row.uuid)
                        && !previous.is_some_and(|table| {
                            table.table.records.iter().any(|old| old.uuid == row.uuid)
                        })
                    {
                        merged.records.push(row.clone());
                    }
                }
            }
            if item.kind == ResourceKind::Translations {
                let mut authored = translation_identities(&merged)?;
                let prior = previous
                    .map(|t| translation_identities(&t.table))
                    .transpose()?
                    .unwrap_or_default();
                let projected = effective(&item.table)?;
                for (row, values) in item.table.records.iter().zip(projected) {
                    let key = (
                        values.values["key"].clone(),
                        values.values["locale"].clone(),
                    );
                    if !authored.contains(&key) && !prior.contains(&key) {
                        authored.insert(key);
                        merged.records.push(row.clone());
                    }
                }
            }
        }
        if let Some(implementation) = merged
            .interface_implementations
            .get_mut(&item.contract.uuid)
        {
            implementation.synced_version_id = item.contract.current_version_id;
            implementation.effective_fingerprint =
                Some(item.contract.effective_fingerprint(&interfaces));
        }
        merged.metadata.edit_permissions.add_columns = false;
        merged.metadata.edit_permissions.delete_columns = false;
        if item.cardinality == ResourceCardinality::Singleton {
            merged.metadata.edit_permissions.add_rows = false;
            merged.metadata.edit_permissions.delete_rows = false;
        }
        validate_resource_contract(&resources.owner, &item.id, &merged, &item.contract)?;
        let path = existing.map(|(p, _)| p).unwrap_or_else(|| {
            root.join("Tables/Plugins")
                .join(&resources.owner)
                .join(format!("{}.table.toml", item.id))
        });
        staged.insert(
            path.clone(),
            Table {
                path,
                is_dirty: true,
                data: merged,
                undo_history: vec![],
                redo_history: vec![],
            },
        );
        if binding.is_none() {
            let registration = crate::plugin_resource_registry::registration_table(
                &resources.owner,
                &item.id,
                item.kind,
                item.cardinality,
                &item.table,
                &item.contract,
            )?;
            let mut row = Record::new();
            row.label = format!("{} / {}", resources.owner, item.id);
            row.set_cell_value(&registry.data.schema.columns[0], registration.uuid.clone());
            registry.data.records.push(row);
            let path = root
                .join("Tables/Plugins")
                .join(&resources.owner)
                .join(format!("{}.registration.table.toml", item.id));
            if staged.contains_key(&path) {
                return Err(invalid("collision", &resources.owner, &item.id));
            }
            staged.insert(
                path.clone(),
                Table {
                    path,
                    is_dirty: true,
                    data: registration,
                    undo_history: vec![],
                    redo_history: vec![],
                },
            );
        }
    }
    registry.is_dirty = true;
    validate_project_identities(&staged, &registry.data, &interfaces, &resources.owner)?;
    staged.insert(registry_path, registry);
    project.tables_data = staged;
    project.interface_registry = interfaces;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(owner: &str) -> ResourceTables {
        use crate::interface::{Interface, InterfaceChange, InterfaceRegistry};
        let mut row = Record::new();
        row.set_value("defaultDelimiter", ",".into());
        let original = TableData {
            uuid: uuid::Uuid::new_v4().to_string(),
            display_name: "Preferences".into(),
            description: String::new(),
            metadata: crate::table::TableMetadata {
                data_name: "Preferences".into(),
                parent_uuid: String::new(),
                interface_order: vec![],
                initial_transposed: false,
                edit_permissions: Default::default(),
            },
            interface_implementations: Default::default(),
            schema: crate::table::TableSchema {
                columns: vec![ColumnSchema {
                    data_name: "defaultDelimiter".into(),
                    display_name: "Delimiter".into(),
                    data_type: ValueType::String,
                    default_value: ",".into(),
                    required: Some(true),
                    ..Default::default()
                }],
            },
            records: vec![row],
        };
        let mut contract = Interface::new(contract_name(owner, "preferences"), None);
        let changes = original
            .schema
            .columns
            .iter()
            .map(|old| {
                let mut c = old.clone();
                c.uuid = uuid::Uuid::new_v4().to_string();
                c.interface_origin = None;
                c.interface_origin_name_fallback = None;
                InterfaceChange::AddColumn { column: c }
            })
            .collect();
        contract.create_new_version(changes, None, None).unwrap();
        let mut interfaces = InterfaceRegistry::new();
        interfaces.add_interface(contract.clone()).unwrap();
        let mut data = original.clone();
        data.uuid = uuid::Uuid::new_v4().to_string();
        data.metadata.data_name = table_name(owner, "preferences");
        data.schema.columns.clear();
        data.records.clear();
        data.interface_implementations.clear();
        data.metadata.interface_order.clear();
        let mut table = crate::Table {
            path: std::path::PathBuf::new(),
            data,
            is_dirty: false,
            undo_history: vec![],
            redo_history: vec![],
        };
        table.apply_interface(&contract, &interfaces, true).unwrap();
        for old in &original.records {
            let mut row = crate::Record::new();
            for (column, previous) in table
                .data
                .schema
                .columns
                .iter()
                .zip(&original.schema.columns)
            {
                row.set_cell_value(column, old.get_cell_value(previous).unwrap().clone());
            }
            table.data.records.push(row);
        }
        ResourceTables {
            owner: owner.into(),
            previous_tables: vec![],
            tables: vec![ResourceTable {
                id: "preferences".into(),
                kind: ResourceKind::Settings,
                cardinality: ResourceCardinality::Singleton,
                table: table.data,
                contract,
            }],
        }
    }
    fn set(table: &mut TableData, row: usize, name: &str, value: &str) {
        let column = table
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == name)
            .unwrap();
        table.records[row].set_cell_value(column, value.into());
    }
    fn binding_list(project: &Project) -> Vec<RegistryBinding> {
        registry_bindings(
            &registry(project).unwrap().unwrap().data,
            &project.tables_data,
            &project.interface_registry,
        )
        .unwrap()
    }
    #[test]
    fn authoring_commands_cannot_break_singleton_or_detach_resource_contract() {
        let temp = tempfile::tempdir().unwrap();
        let mut project =
            Project::create_project("Resources", &temp.path().to_string_lossy(), "", "#123456")
                .unwrap();
        let path = project.create_table("Registry.table.toml".into()).unwrap();
        project.load_table(&path).unwrap();
        std::fs::write(
            &path,
            crate::table_storage::to_toml(&crate::plugin_resource_registry::catalog_table())
                .unwrap(),
        )
        .unwrap();
        let entry = project.path.clone();
        crate::plugin_resource_registry::registration_contract()
            .save_to_file(
                &entry
                    .parent()
                    .unwrap()
                    .join("Tables/Registry.interface.toml"),
            )
            .unwrap();
        project = crate::localization::load(&entry).unwrap();
        let resource = fixture("csv-exporter");
        merge_resources(&mut project, &resource).unwrap();
        // Materialize the independent initial fixture before exercising authoring commands.
        for (path, table) in &project.tables_data {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, crate::table_storage::to_toml(&table.data).unwrap()).unwrap();
        }
        for (path, interface) in project.interface_registry.get_all_interfaces_with_paths() {
            let file = entry.parent().unwrap().join("Tables").join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            interface.save_to_file(&file).unwrap();
        }
        project = crate::localization::load(&entry).unwrap();
        let binding = binding_list(&project)
            .into_iter()
            .find(|b| b.kind == ResourceKind::Settings)
            .unwrap();
        let (path, original) = project
            .tables_data
            .iter()
            .find(|(_, t)| t.data.uuid == binding.table_uuid)
            .map(|(p, t)| (p.clone(), t.data.clone()))
            .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        for corruption in 0..5 {
            let mut after = original.clone();
            match corruption {
                0 => after.records.clear(),
                1 => {
                    let mut row = after.records[0].clone();
                    row.uuid = uuid::Uuid::new_v4().to_string();
                    after.records.push(row);
                }
                2 => after.metadata.edit_permissions.add_rows = true,
                3 => {
                    after.interface_implementations.clear();
                    after.metadata.interface_order.clear();
                }
                _ => after.metadata.edit_permissions.add_columns = true,
            }
            let command = crate::table_mutation::ReplaceTableCommand::new(
                binding.table_uuid.clone(),
                crate::cell_rules::revision(&original),
                after,
                None,
            )
            .with_edit_control_settings();
            assert!(
                project.execute_command(command, None).is_err(),
                "corruption={corruption}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            assert_eq!(
                crate::cell_rules::revision(
                    &project
                        .find_table_by_uuid(&binding.table_uuid)
                        .unwrap()
                        .data
                ),
                crate::cell_rules::revision(&original)
            );
        }
        assert!(crate::table_mutation::remove_interface_checked(
            &mut project,
            &binding.table_uuid,
            &binding.contract_uuid,
            None,
            None
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let mut edited = original.clone();
        set(&mut edited, 0, "defaultDelimiter", ";");
        project
            .execute_command(
                crate::table_mutation::ReplaceTableCommand::new(
                    binding.table_uuid.clone(),
                    crate::cell_rules::revision(&original),
                    edited,
                    None,
                ),
                None,
            )
            .unwrap();
        let reopened = crate::localization::load(&entry).unwrap();
        let catalog = compile(&reopened, &BTreeSet::from(["en".into()])).unwrap();
        assert_eq!(
            catalog.settings["csv-exporter"]["preferences"]["defaultDelimiter"],
            ";"
        );
    }
}
