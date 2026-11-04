use crate::formula_engine::FormulaEngine;
use crate::table::TableData;
use crate::types::{CurveConfig, ReferenceConfig, TableRefConfig, ValueType};
use crate::{DevcelError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Simple table structure for export
/// Contains only usable data, without metadata
#[derive(Serialize, Deserialize, Clone)]
pub struct ExportTable {
    /// Stable identity used by engine-side Reference/TableRef resolution.
    pub uuid: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interfaces: Vec<String>,
    /// Table identifier (data_name)
    pub name: String,
    /// Column information array, providing types and default values
    pub columns: Vec<ExportColumn>,
    /// Record data array
    pub records: Vec<ExportRecord>,
}

/// Column information for export
#[derive(Serialize, Deserialize, Clone)]
pub struct ExportColumn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_config: Option<ReferenceConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_ref_config: Option<TableRefConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve_config: Option<CurveConfig>,
    /// Column identifier (data_name)
    pub name: String,
    /// Data type
    pub data_type: ValueType,
    /// Default value (needed only in Minimal mode)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

/// Record information for export
#[derive(Serialize, Deserialize, Clone)]
pub struct ExportRecord {
    /// Record identifier
    pub id: String,
    /// Map from column names to values
    pub values: HashMap<String, String>,
}

/// Structure for exporting all tables
#[derive(Serialize, Deserialize, Clone)]
pub struct ExportProject {
    /// Project name
    pub name: String,
    /// Array of all tables
    pub tables: Vec<ExportTable>,
}

/// Table metadata structure for export
/// Format suitable for Unity/UE code generation
#[derive(Serialize, Deserialize, Clone)]
pub struct ExportTableMetadata {
    /// Unique table identifier
    pub uuid: String,
    /// Human-readable table display name, including Japanese names
    pub display_name: String,
    /// Alphanumeric table data name used as a system identifier
    pub data_name: String,
    /// Table description
    pub description: String,
    /// Column metadata array
    pub columns: Vec<ExportColumnMetadata>,
}

/// Column metadata structure for export
/// Format suitable for Unity/UE code generation
#[derive(Serialize, Deserialize, Clone)]
pub struct ExportColumnMetadata {
    /// Unique column identifier
    pub uuid: String,
    /// Human-readable column display name, including Japanese names
    pub display_name: String,
    /// Alphanumeric column data name used as a system identifier
    pub data_name: String,
    /// Data type
    pub data_type: ValueType,
    /// Minimum content version that includes this column.
    pub min_version: u32,
    /// Default value
    pub default_value: String,
    /// Tooltip text
    pub tooltip: String,
    /// Detailed description text
    pub memo_text: String,
    /// Tags associated with the column
    pub tags: Vec<String>,
    /// Whether the column is required, as defined by its interface
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    /// Value constraints, available for validation by generated code
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<crate::column::ColumnConstraints>,
    /// UUID of the interface this column originates from
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_origin: Option<String>,
}

/// Project-wide metadata export structure
#[derive(Serialize, Deserialize, Clone)]
pub struct ExportProjectMetadata {
    /// Project name
    pub name: String,
    /// Project description
    pub description: String,
    /// Metadata array for all tables
    pub tables: Vec<ExportTableMetadata>,
}

/// Export mode
#[derive(Debug, Clone, Copy)]
pub enum ExportMode {
    /// Full mode: apply defaults to all records
    Full,
    /// Minimal mode: omit columns whose values equal the default
    Minimal,
}

/// Determine the export key for each column
/// When multiple columns share a name because interfaces define the same data_name,
/// qualify them by interface name instead of silently discarding one
pub(crate) fn build_export_keys(columns: &[crate::column::ColumnSchema]) -> Vec<String> {
    let mut name_counts: HashMap<&str, usize> = HashMap::new();
    for column in columns {
        *name_counts.entry(column.data_name.as_str()).or_insert(0) += 1;
    }

    let mut keys = Vec::with_capacity(columns.len());
    let mut used: HashMap<String, usize> = HashMap::new();
    for column in columns {
        let mut key = if name_counts[column.data_name.as_str()] > 1 {
            // Collision: qualify interface-origin columns with their interface name
            if column.interface_origin.is_some() {
                let prefix = column
                    .interface_origin_name_fallback
                    .clone()
                    .or_else(|| column.interface_origin.as_ref().map(|u| u[..8].to_string()))
                    .unwrap_or_default();
                format!("{}_{}", prefix, column.data_name)
            } else {
                column.data_name.clone()
            }
        } else {
            column.data_name.clone()
        };

        // If qualified names still collide, use sequential numbers to ensure uniqueness
        let base = key.clone();
        let mut suffix = 0;
        while used.contains_key(&key) {
            suffix += 1;
            key = format!("{base}_{suffix}");
        }
        used.insert(key.clone(), 0);
        keys.push(key);
    }

    keys
}

impl ExportTable {
    /// Create an ExportTable from TableData, evaluating formulas to values
    pub fn from_table_data(table_data: &mut TableData, mode: ExportMode) -> Result<Self> {
        Self::from_table_data_filtered(table_data, mode, None)
    }

    /// Create an ExportTable from TableData with version filtering
    /// When target_version is Some(n), export only columns and records with min_version <= n.
    /// When None, export all columns and records.
    pub fn from_table_data_filtered(
        table_data: &mut TableData,
        mode: ExportMode,
        target_version: Option<u32>,
    ) -> Result<Self> {
        let mut engine = FormulaEngine::with_table(table_data);
        Self::from_table_data_filtered_with_evaluator(
            table_data,
            mode,
            target_version,
            &mut |data, column, record, formula| {
                engine.evaluate_column(formula, column, record, &data.schema)
            },
        )
    }

    pub(crate) fn from_table_data_filtered_with_evaluator(
        table_data: &TableData,
        mode: ExportMode,
        target_version: Option<u32>,
        evaluator: &mut crate::cell_rules::FormulaEvaluator<'_>,
    ) -> Result<Self> {
        Self::from_table_data_with_filters_and_evaluator(
            table_data,
            mode,
            target_version,
            &crate::tag_filter::TagFilter::default(),
            evaluator,
        )
    }

    pub(crate) fn from_table_data_with_filters_and_evaluator(
        table_data: &TableData,
        mode: ExportMode,
        target_version: Option<u32>,
        filter: &crate::tag_filter::TagFilter,
        evaluator: &mut crate::cell_rules::FormulaEvaluator<'_>,
    ) -> Result<Self> {
        // Derive names from the complete schema so an existing exported field
        // keeps its identity across releases, including duplicate-name columns.
        let export_keys = build_export_keys(&table_data.schema.columns);
        let projected_columns: Vec<_> = table_data
            .schema
            .columns
            .iter()
            .zip(&export_keys)
            .filter(|(column, _)| filter.includes_column(column, target_version))
            .collect();
        for (column, _) in &projected_columns {
            column.validate_color_storage_contract()?;
        }
        let columns = projected_columns
            .iter()
            .map(|(column, key)| ExportColumn {
                reference_config: column.reference_config.clone(),
                table_ref_config: column.table_ref_config.clone(),
                curve_config: column.curve_config.clone(),
                name: (*key).clone(),
                data_type: column.data_type.clone(),
                // A formula default depends on the actual row. Every such cell
                // is materialized below; no dummy-row formula is exported as a
                // supposedly universal column default.
                default_value: match mode {
                    ExportMode::Minimal if !column.default_value.starts_with('=') => Some(
                        if column.data_type.is_color() && column.default_value.is_empty() {
                            column.data_type.default_value()
                        } else {
                            column.default_value.clone()
                        },
                    ),
                    _ => None,
                },
            })
            .collect();
        let mut records = Vec::new();
        let inheritance = crate::table::InheritanceResolver::new(table_data);
        for record in table_data
            .records
            .iter()
            .filter(|record| filter.includes_row(record, target_version))
        {
            let mut values = HashMap::new();
            for &(column, key) in &projected_columns {
                let input = inheritance.input(record, column)?;
                column.validate_color_storage_value(input)?;
                let formula_default = column.default_value.starts_with('=');
                let effective = input;
                let value = if effective.starts_with('=') {
                    // Projection affects output only. Formulas may depend on
                    // later-version source columns in this or another table.
                    match evaluator(table_data, column, record, effective) {
                        crate::types::FormulaResult::Value(value) => value,
                        crate::types::FormulaResult::Error(error) => {
                            return Err(crate::app_error::diagnostic(
                                "error.export.formula",
                                serde_json::json!({"table": table_data.metadata.data_name, "tableId": table_data.uuid, "column": column.data_name, "columnId": column.uuid, "row": record.uuid, "error": error.diagnostic()}),
                            ));
                        }
                    }
                } else if matches!(mode, ExportMode::Full)
                    && effective.is_empty()
                    && column.default_value.is_empty()
                {
                    column.data_type.default_value()
                } else {
                    effective.to_string()
                };
                let value = if column.data_type.is_color() && !value.is_empty() {
                    column.validate_value(&value)?
                } else {
                    value
                };
                if matches!(mode, ExportMode::Full)
                    || formula_default
                    || value != column.default_value
                {
                    values.insert(key.clone(), value);
                }
            }
            records.push(ExportRecord {
                id: record.uuid.clone(),
                values,
            });
        }
        let mut interfaces: Vec<_> = table_data
            .interface_implementations
            .values()
            .map(|implementation| implementation.interface_uuid.to_string())
            .collect();
        interfaces.sort();
        interfaces.dedup();
        Ok(ExportTable {
            uuid: table_data.uuid.clone(),
            interfaces,
            name: table_data.metadata.data_name.clone(),
            columns,
            records,
        })
    }
}

/// Export table data as JSON with formula evaluation
pub fn export_table_as_json(table_data: &mut TableData, mode: ExportMode) -> Result<String> {
    export_table_as_json_with_validation(table_data, mode, false)
}

pub fn export_table_as_json_with_validation(
    table_data: &mut TableData,
    mode: ExportMode,
    allow_invalid: bool,
) -> Result<String> {
    crate::export_validation::require_clean_table(table_data, allow_invalid)?;
    let export_table = ExportTable::from_table_data(table_data, mode)?;

    match serde_json::to_string_pretty(&export_table) {
        Ok(json) => Ok(json),
        Err(e) => Err(DevcelError::Serialization(e)),
    }
}

/// Export one table with its project query context (including unsaved edits).
/// Standalone TableData-only APIs cannot resolve other project tables.
pub fn export_table_as_json_in_project_with_validation(
    project: &crate::Project,
    table_data: &TableData,
    mode: ExportMode,
    allow_invalid: bool,
) -> Result<String> {
    let context = crate::formula_context::ProjectFormulaContext::new(project, None)?;
    context.begin_snapshot().map_err(formula_snapshot_error)?;
    let mut evaluator =
        |data: &TableData, column: &crate::ColumnSchema, record: &crate::Record, formula: &str| {
            context.with_diagnostic_display(
                context.evaluate_cell_with_override(data, column, record, formula),
            )
        };
    let table = crate::Table {
        path: Default::default(),
        data: table_data.clone(),
        is_dirty: false,
        undo_history: Vec::new(),
        redo_history: Vec::new(),
    };
    let issues = crate::export_validation::lint_project_table_with_evaluator(
        project,
        &table,
        None,
        &mut evaluator,
    )?;
    if !allow_invalid && !issues.is_empty() {
        return Err(crate::export_validation::export_error(&issues));
    }
    let exported = ExportTable::from_table_data_filtered_with_evaluator(
        table_data,
        mode,
        None,
        &mut evaluator,
    )?;
    context.finish_snapshot().map_err(formula_snapshot_error)?;
    serde_json::to_string_pretty(&exported).map_err(DevcelError::Serialization)
}

/// Studio's existing path-keyed JSON shape. This API retains the returned JSON
/// values, but does not populate editor state just to enumerate all source tables.
pub fn export_all_table_values_with_validation(
    project: &crate::Project,
    mode: ExportMode,
    allow_invalid: bool,
) -> Result<std::collections::BTreeMap<String, serde_json::Value>> {
    let context = crate::formula_context::ProjectFormulaContext::new(project, None)?;
    context.begin_snapshot().map_err(formula_snapshot_error)?;
    let mut evaluator =
        |data: &TableData, column: &crate::ColumnSchema, record: &crate::Record, formula: &str| {
            context.with_diagnostic_display(
                context.evaluate_cell_with_override(data, column, record, formula),
            )
        };
    let mut paths = std::collections::BTreeSet::new();
    for entry in project.get_project_entries()? {
        if entry.entry_type == crate::ProjectEntryType::Table {
            paths.insert(project.resolve_table_path(&std::path::PathBuf::from(entry.path))?);
        }
    }
    paths.extend(project.tables_data.keys().cloned());
    let mut values = std::collections::BTreeMap::new();
    for path in paths {
        let unloaded;
        let table = if let Some(table) = project.tables_data.get(&path) {
            table
        } else {
            unloaded = read_unloaded_export_table(project, &path)?;
            &unloaded
        };
        let issues = crate::export_validation::lint_project_table_with_evaluator(
            project,
            table,
            None,
            &mut evaluator,
        )?;
        if !allow_invalid && !issues.is_empty() {
            return Err(crate::export_validation::export_error(&issues));
        }
        let table = ExportTable::from_table_data_filtered_with_evaluator(
            &table.data,
            mode,
            None,
            &mut evaluator,
        )?;
        values.insert(
            path.to_string_lossy().into_owned(),
            serde_json::to_value(table)?,
        );
    }
    context.finish_snapshot().map_err(formula_snapshot_error)?;
    Ok(values)
}

/// Export all tables as JSON
pub fn export_all_tables_as_json(project: &mut crate::Project, mode: ExportMode) -> Result<String> {
    export_all_tables_as_json_with_validation(project, mode, false)
}

pub fn export_all_tables_as_json_with_validation(
    project: &mut crate::Project,
    mode: ExportMode,
    allow_invalid: bool,
) -> Result<String> {
    crate::export_validation::require_clean(project, None, None, allow_invalid)?;
    ensure_all_tables_loaded(project)?;
    let context = crate::formula_context::ProjectFormulaContext::new(project, None)?;
    context.begin_snapshot().map_err(formula_snapshot_error)?;
    let mut evaluator =
        |data: &TableData, column: &crate::ColumnSchema, record: &crate::Record, formula: &str| {
            context.with_diagnostic_display(
                context.evaluate_cell_with_override(data, column, record, formula),
            )
        };
    let mut paths: Vec<_> = project.tables_data.keys().collect();
    paths.sort();
    let mut export_tables = Vec::with_capacity(paths.len());
    for path in paths {
        export_tables.push(ExportTable::from_table_data_filtered_with_evaluator(
            &project.tables_data[path].data,
            mode,
            None,
            &mut evaluator,
        )?);
    }
    export_tables.sort_by(|a, b| (&a.name, &a.uuid).cmp(&(&b.name, &b.uuid)));

    // Serialize the entire project
    let export_project = ExportProject {
        name: project.get_project_name(),
        tables: export_tables,
    };

    context.finish_snapshot().map_err(formula_snapshot_error)?;
    match serde_json::to_string_pretty(&export_project) {
        Ok(json) => Ok(json),
        Err(e) => Err(DevcelError::Serialization(e)),
    }
}

/// Convert table metadata to the export structure
impl ExportTableMetadata {
    pub fn from_table_data(table_data: &TableData) -> Self {
        Self::from_table_data_filtered(table_data, None)
    }

    /// Project the metadata schema for a release without changing authoring data.
    pub fn from_table_data_filtered(table_data: &TableData, target_version: Option<u32>) -> Self {
        let columns: Vec<ExportColumnMetadata> = table_data
            .schema
            .columns
            .iter()
            .filter(|column| target_version.is_none_or(|version| column.min_version <= version))
            .map(|col| ExportColumnMetadata {
                uuid: col.uuid.clone(),
                display_name: col.display_name.clone(),
                data_name: col.data_name.clone(),
                data_type: col.data_type.clone(),
                min_version: col.min_version,
                default_value: col.default_value.clone(),
                tooltip: col.tooltip.clone(),
                memo_text: col.memo_text.clone(),
                tags: col.tags.clone(),
                required: col.required,
                constraints: col.constraints.clone(),
                interface_origin: col.interface_origin.clone(),
            })
            .collect();

        ExportTableMetadata {
            uuid: table_data.uuid.clone(),
            display_name: table_data.display_name.clone(),
            data_name: table_data.metadata.data_name.clone(),
            description: table_data.description.clone(),
            columns,
        }
    }
}

/// Export table metadata as JSON
pub fn export_table_metadata_as_json(table_data: &TableData) -> Result<String> {
    export_table_metadata_as_json_filtered(table_data, None)
}

pub fn export_table_metadata_as_json_filtered(
    table_data: &TableData,
    target_version: Option<u32>,
) -> Result<String> {
    let export_metadata = ExportTableMetadata::from_table_data_filtered(table_data, target_version);

    match serde_json::to_string_pretty(&export_metadata) {
        Ok(json) => Ok(json),
        Err(e) => Err(DevcelError::Serialization(e)),
    }
}

/// Export project-wide metadata as JSON
pub fn export_project_metadata_as_json(project: &mut crate::Project) -> Result<String> {
    export_project_metadata_as_json_filtered(project, None)
}

pub fn export_project_metadata_as_json_filtered(
    project: &mut crate::Project,
    target_version: Option<u32>,
) -> Result<String> {
    // Explicit project export may load all tables, but must preserve live data
    // and history and must report malformed/unreadable files instead of dropping them.
    ensure_all_tables_loaded(project)?;

    // Convert all table metadata to the export format
    let mut export_tables = Vec::new();
    for table in project.tables_data.values() {
        let export_metadata =
            ExportTableMetadata::from_table_data_filtered(&table.data, target_version);
        export_tables.push(export_metadata);
    }

    // Serialize project-wide metadata
    let export_metadata = ExportProjectMetadata {
        name: project.get_project_name(),
        description: project.get_project_description(),
        tables: export_tables,
    };

    match serde_json::to_string_pretty(&export_metadata) {
        Ok(json) => Ok(json),
        Err(e) => Err(DevcelError::Serialization(e)),
    }
}

/// Export table data as full-format JSON with formula evaluation
pub fn export_table_json_full(table_data: &mut TableData) -> Result<serde_json::Value> {
    let export_table = ExportTable::from_table_data(table_data, ExportMode::Full)?;

    match serde_json::to_value(&export_table) {
        Ok(json) => Ok(json),
        Err(e) => Err(DevcelError::Serialization(e)),
    }
}

/// Export table data as minimal-format JSON with formula evaluation
pub fn export_table_json_minimal(table_data: &mut TableData) -> Result<serde_json::Value> {
    let export_table = ExportTable::from_table_data(table_data, ExportMode::Minimal)?;

    match serde_json::to_value(&export_table) {
        Ok(json) => Ok(json),
        Err(e) => Err(DevcelError::Serialization(e)),
    }
}

// =============================================================================
// Runtime distribution bundle (output for code generation and DLL readers)
// Runtime distribution bundle (output for codegen / DLL consumer side)
// =============================================================================

/// Format version of the runtime bundle structure itself.
/// Always increment this after a breaking change to the bundle layout.
pub const RUNTIME_SCHEMA_VERSION: u32 = 1;

/// Runtime distribution bundle manifest.
/// Metadata consumers (DLL/Unity/UE) use to identify new data through
/// `content_hash` and perform hot reload.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RuntimeManifest {
    /// Bundle format version ([`RUNTIME_SCHEMA_VERSION`])
    pub schema_version: u32,
    /// Applied content-version filter.
    /// `Some(n)` includes only columns and records with `min_version <= n`; `None` includes everything.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_version: Option<u32>,
    /// Hash of the data content, the primary hot-reload change-detection signal.
    /// Identical content always produces the same value (deterministic).
    pub content_hash: String,
    /// Data revision based on generation time; a supplementary hot-reload signal.
    pub data_revision: u64,
    /// Generation timestamp (RFC3339)
    pub generated_at: String,
    /// Export mode ("full" / "minimal")
    pub mode: String,
}

/// Runtime distribution bundle (manifest and tables).
#[derive(Serialize, Deserialize, Clone)]
pub struct RuntimeBundle {
    /// Bundle metadata
    pub manifest: RuntimeManifest,
    /// Project name
    pub project_name: String,
    /// Version-filtered tables, sorted by name for deterministic output
    pub tables: Vec<ExportTable>,
}

/// Ensure all table files in the project are loaded.
pub(crate) fn ensure_all_tables_loaded(project: &mut crate::Project) -> Result<()> {
    let entries = project.get_project_entries().map_err(|e| {
        crate::app_error::diagnostic(
            "error.export.entries",
            serde_json::json!({"error": crate::AppError::from(e).into_diagnostic()}),
        )
    })?;

    let table_paths: Vec<std::path::PathBuf> = entries
        .iter()
        .filter(|entry| entry.entry_type == crate::ProjectEntryType::Table)
        .map(|entry| std::path::PathBuf::from(&entry.path))
        .collect();

    for path in &table_paths {
        let resolved = project.resolve_table_path(path).map_err(|e| {
            crate::app_error::diagnostic("error.export.resolvePath", serde_json::json!({"path": path.display().to_string(), "error": crate::AppError::from(e).into_diagnostic()}))
        })?;
        if !project.is_loaded_table(&resolved) {
            project.load_table(&resolved).map_err(|e| {
                crate::app_error::diagnostic("error.export.readTarget", serde_json::json!({"path": path.display().to_string(), "error": crate::AppError::from(e).into_diagnostic()}))
            })?;
        }
    }

    Ok(())
}

/// Compute a deterministic content hash from the tables.
/// Record value maps (HashMap) are folded in sorted key order,
/// so identical data produces the same hash on every run.
fn ordered_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let sorted: std::collections::BTreeMap<_, _> = map
                .into_iter()
                .map(|(key, value)| (key, ordered_json(value)))
                .collect();
            serde_json::Value::Object(sorted.into_iter().collect())
        }
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(ordered_json).collect())
        }
        value => value,
    }
}

/// Compute a deterministic content hash over the tables.
fn compute_content_hash(tables: &[ExportTable]) -> String {
    use sha2::{Digest, Sha256};
    struct HashWriter(Sha256);
    impl std::io::Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = HashWriter(Sha256::new());
    writer.0.update(b"[");
    for (index, table) in tables.iter().enumerate() {
        if index != 0 {
            writer.0.update(b",");
        }
        let value =
            ordered_json(serde_json::to_value(table).expect("export table is serializable"));
        serde_json::to_writer(&mut writer, &value).expect("export table is serializable");
    }
    writer.0.update(b"]");
    format!("{:x}", writer.0.finalize())
}

/// Include inherited contracts for TableRef consumers and generated interfaces.
pub(crate) fn expanded_interface_ids(
    project: &crate::Project,
    roots: Vec<String>,
) -> Result<Vec<String>> {
    let mut seen = std::collections::BTreeSet::new();
    let mut pending = roots;
    while let Some(id) = pending.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let uuid = uuid::Uuid::parse_str(&id).map_err(|error| {
            crate::app_error::diagnostic(
                "error.interface.invalidId",
                serde_json::json!({"id": id, "details": error.to_string()}),
            )
        })?;
        let iface = project
            .interface_registry
            .get_interface(&uuid)
            .ok_or_else(|| {
                crate::app_error::diagnostic(
                    "error.interface.missingId",
                    serde_json::json!({"id": id}),
                )
            })?;
        pending.extend(iface.extends.iter().map(|id| id.to_string()));
    }
    Ok(seen.into_iter().collect())
}

/// Convert the entire project to a runtime distribution bundle.
/// When `target_version` is `Some(n)`, include only columns and records with `min_version <= n`.
/// Tables are sorted by name, and `content_hash` is computed deterministically.
pub fn export_runtime_bundle(
    project: &mut crate::Project,
    mode: ExportMode,
    target_version: Option<u32>,
) -> Result<RuntimeBundle> {
    export_runtime_bundle_with_validation(project, mode, target_version, false)
}

pub fn export_runtime_bundle_with_validation(
    project: &mut crate::Project,
    mode: ExportMode,
    target_version: Option<u32>,
    allow_invalid: bool,
) -> Result<RuntimeBundle> {
    export_runtime_bundle_with_filters(
        project,
        mode,
        target_version,
        allow_invalid,
        &crate::tag_filter::TagFilter::default(),
    )
}

pub fn export_runtime_bundle_with_filters(
    project: &mut crate::Project,
    mode: ExportMode,
    target_version: Option<u32>,
    allow_invalid: bool,
    filter: &crate::tag_filter::TagFilter,
) -> Result<RuntimeBundle> {
    ensure_all_tables_loaded(project)?;
    let mut retained = crate::tag_filter::RetainedIndex::default();
    for table in project.tables_data.values() {
        retained.add(project, &table.data, target_version, filter)?;
    }

    let context = crate::formula_context::ProjectFormulaContext::new(project, target_version)?;
    context.begin_snapshot().map_err(formula_snapshot_error)?;
    let mut evaluator =
        |data: &TableData, column: &crate::ColumnSchema, record: &crate::Record, formula: &str| {
            context.with_diagnostic_display(
                context.evaluate_cell_with_override(data, column, record, formula),
            )
        };
    let mut paths: Vec<_> = project.tables_data.keys().cloned().collect();
    paths.sort();
    let mut export_tables = Vec::with_capacity(paths.len());
    for path in paths {
        let table = &project.tables_data[&path];
        let issues = crate::export_validation::lint_project_table_with_filters(
            project,
            table,
            target_version,
            filter,
            &mut evaluator,
        )?;
        if !allow_invalid && !issues.is_empty() {
            return Err(crate::export_validation::export_error(&issues));
        }
        let mut export_table = ExportTable::from_table_data_with_filters_and_evaluator(
            &table.data,
            mode,
            target_version,
            filter,
            &mut evaluator,
        )?;
        export_table.interfaces = crate::tag_filter::projected_interface_ids(
            project,
            &table.data,
            target_version,
            filter,
        )?;
        retained.validate(&export_table)?;
        export_tables.push(export_table);
    }

    // Sort tables by name for deterministic output
    export_tables.sort_by(|a, b| (&a.name, &a.uuid).cmp(&(&b.name, &b.uuid)));

    let content_hash = compute_content_hash(&export_tables);
    let now = chrono::Utc::now();

    let manifest = RuntimeManifest {
        schema_version: RUNTIME_SCHEMA_VERSION,
        content_version: target_version,
        content_hash,
        data_revision: now.timestamp_millis() as u64,
        generated_at: now.to_rfc3339(),
        mode: match mode {
            ExportMode::Full => "full",
            ExportMode::Minimal => "minimal",
        }
        .to_string(),
    };

    context.finish_snapshot().map_err(formula_snapshot_error)?;
    Ok(RuntimeBundle {
        manifest,
        project_name: project.get_project_name(),
        tables: export_tables,
    })
}

/// Export a runtime distribution bundle as a JSON string.
pub fn export_runtime_bundle_as_json(
    project: &mut crate::Project,
    mode: ExportMode,
    target_version: Option<u32>,
) -> Result<String> {
    let bundle = export_runtime_bundle(project, mode, target_version)?;
    serde_json::to_string_pretty(&bundle).map_err(DevcelError::Serialization)
}

pub fn export_runtime_bundle_as_json_with_validation(
    project: &mut crate::Project,
    mode: ExportMode,
    target_version: Option<u32>,
    allow_invalid: bool,
) -> Result<String> {
    let bundle =
        export_runtime_bundle_with_validation(project, mode, target_version, allow_invalid)?;
    serde_json::to_string_pretty(&bundle).map_err(DevcelError::Serialization)
}

/// Write an export atomically so engine file watchers never observe a partial JSON/code file.
pub fn write_export_file(path: impl AsRef<std::path::Path>, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let path = path.as_ref();
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut file = crate::utils::new_atomic_save_temp(parent)?;
    file.write_all(content.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// Small result for CLI/UI acknowledgements; no exported records are retained.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RuntimeExportSummary {
    pub manifest: RuntimeManifest,
    pub table_count: usize,
    pub record_count: usize,
}

/// Export the current runtime JSON contract without retaining all unloaded tables
/// or the complete output in memory. Existing live edits are authoritative.
///
/// A private spool captures each converted table once. Only names, identities and
/// byte ranges are retained for sorting; the final atomic file is assembled from
/// that immutable capture. Memory is O(largest table + retained row identities +
/// table/interface count + already loaded editor state); temporary disk space is
/// roughly twice the compact output.
/// JSON object keys are canonical and the tables remain name-sorted. The manifest
/// follows the tables so its hash can be finalized while copying, not in a second
/// evaluation pass. A compact retained row/interface identity index additionally
/// validates cross-table references before publication; cell values remain streamed.
/// Object member order/whitespace are not part of the schema.
/// Like the existing export, this holds the caller's exclusive Project borrow;
/// it is not a filesystem-wide transaction against unrelated external writers.
pub fn export_runtime_bundle_to_file_with_validation(
    project: &mut crate::Project,
    mode: ExportMode,
    target_version: Option<u32>,
    allow_invalid: bool,
    path: impl AsRef<std::path::Path>,
) -> Result<RuntimeExportSummary> {
    export_runtime_bundle_to_file_with_filters(
        project,
        mode,
        target_version,
        allow_invalid,
        &crate::tag_filter::TagFilter::default(),
        path,
    )
}

pub fn export_runtime_bundle_to_file_with_filters(
    project: &mut crate::Project,
    mode: ExportMode,
    target_version: Option<u32>,
    allow_invalid: bool,
    filter: &crate::tag_filter::TagFilter,
    path: impl AsRef<std::path::Path>,
) -> Result<RuntimeExportSummary> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Seek, SeekFrom, Write};

    struct TableChunk {
        name: String,
        uuid: String,
        offset: u64,
        length: u64,
    }

    let path = path.as_ref();
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    // Discover once, and include loaded-only tables just as the in-memory API does.
    let mut paths = std::collections::BTreeSet::new();
    let mut protected = std::collections::BTreeSet::new();
    for entry in project.get_project_entries()? {
        let source = project.resolve_table_path(&std::path::PathBuf::from(entry.path))?;
        if entry.entry_type == crate::ProjectEntryType::Table {
            paths.insert(source.clone());
        }
        if entry.entry_type == crate::ProjectEntryType::Table
            || entry.entry_type == crate::ProjectEntryType::Interface
        {
            protected.insert(source);
        }
    }
    paths.extend(project.tables_data.keys().cloned());
    protected.extend(paths.iter().cloned());
    for (source, _) in project.interface_registry.get_all_interfaces_with_paths() {
        protected.insert(project.resolve_table_path(&std::path::PathBuf::from(source))?);
    }
    // Never replace a source table or the project itself with its runtime export.
    // Canonicalize existing paths too, covering aliases/symlinks.
    let destination = export_path_identity(path)?;
    if export_path_identity(&project.path)? == destination {
        return Err(crate::app_error::diagnostic(
            "error.export.sourceDestination",
            serde_json::json!({"path": path.display().to_string()}),
        ));
    }
    for source in &protected {
        if export_path_identity(source)? == destination {
            return Err(crate::app_error::diagnostic(
                "error.export.sourceDestination",
                serde_json::json!({"path": path.display().to_string()}),
            ));
        }
    }
    std::fs::create_dir_all(parent)?;
    let mut spool = tempfile::tempfile_in(parent)?;
    let mut chunks = Vec::with_capacity(paths.len());
    let context = crate::formula_context::ProjectFormulaContext::new(project, target_version)?;
    context.begin_snapshot().map_err(formula_snapshot_error)?;
    let mut evaluator =
        |data: &TableData, column: &crate::ColumnSchema, record: &crate::Record, formula: &str| {
            context.with_diagnostic_display(
                context.evaluate_cell_with_override(data, column, record, formula),
            )
        };
    let mut retained = crate::tag_filter::RetainedIndex::default();
    for source in &paths {
        if let Some(table) = project.tables_data.get(source) {
            retained.add(project, &table.data, target_version, filter)?;
        } else {
            let table = read_unloaded_export_table(project, source)?;
            retained.add(project, &table.data, target_version, filter)?;
        }
    }
    let mut record_count = 0;
    for source in paths {
        let table = if let Some(live) = project.tables_data.get(&source) {
            crate::Table {
                path: source.clone(),
                data: live.data.clone(),
                is_dirty: false,
                undo_history: Vec::new(),
                redo_history: Vec::new(),
            }
        } else {
            read_unloaded_export_table(project, &source)?
        };
        let issues = crate::export_validation::lint_project_table_with_filters(
            project,
            &table,
            target_version,
            filter,
            &mut evaluator,
        )?;
        if !allow_invalid && !issues.is_empty() {
            return Err(crate::export_validation::export_error(&issues));
        }
        let mut exported = ExportTable::from_table_data_with_filters_and_evaluator(
            &table.data,
            mode,
            target_version,
            filter,
            &mut evaluator,
        )?;
        exported.interfaces = crate::tag_filter::projected_interface_ids(
            project,
            &table.data,
            target_version,
            filter,
        )?;
        retained.validate(&exported)?;
        record_count += exported.records.len();
        drop(table);
        let offset = spool.stream_position()?;
        // Canonicalize one table only. This is precisely the representation used
        // by the existing content hash, including nested reference/curve configs.
        let value = ordered_json(serde_json::to_value(&exported)?);
        {
            let mut writer = std::io::BufWriter::new(&mut spool);
            serde_json::to_writer(&mut writer, &value)?;
            writer.flush()?;
        }
        chunks.push(TableChunk {
            name: exported.name,
            uuid: exported.uuid,
            offset,
            length: spool.stream_position()? - offset,
        });
    }
    chunks.sort_by(|a, b| (&a.name, &a.uuid, a.offset).cmp(&(&b.name, &b.uuid, b.offset)));
    let mut output = crate::utils::new_atomic_save_temp(parent)?;
    let manifest;
    {
        let mut writer = std::io::BufWriter::new(output.as_file_mut());
        writer.write_all(b"{\"project_name\":")?;
        serde_json::to_writer(&mut writer, &project.get_project_name())?;
        writer.write_all(b",\"tables\":[")?;
        let mut hasher = Sha256::new();
        hasher.update(b"[");
        let mut buffer = [0u8; 64 * 1024];
        for (index, chunk) in chunks.iter().enumerate() {
            if index != 0 {
                writer.write_all(b",")?;
                hasher.update(b",");
            }
            spool.seek(SeekFrom::Start(chunk.offset))?;
            let mut remaining = chunk.length;
            while remaining != 0 {
                let length = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
                spool.read_exact(&mut buffer[..length])?;
                writer.write_all(&buffer[..length])?;
                hasher.update(&buffer[..length]);
                remaining -= length as u64;
            }
        }
        hasher.update(b"]");
        writer.write_all(b"],\"manifest\":")?;
        let now = chrono::Utc::now();
        manifest = RuntimeManifest {
            schema_version: RUNTIME_SCHEMA_VERSION,
            content_version: target_version,
            content_hash: format!("{:x}", hasher.finalize()),
            data_revision: now.timestamp_millis() as u64,
            generated_at: now.to_rfc3339(),
            mode: match mode {
                ExportMode::Full => "full",
                ExportMode::Minimal => "minimal",
            }
            .into(),
        };
        serde_json::to_writer(&mut writer, &manifest)?;
        writer.write_all(b"}")?;
        writer.flush()?;
    }
    context.finish_snapshot().map_err(formula_snapshot_error)?;
    output.as_file().sync_all()?;
    output
        .persist(path)
        .map_err(|error| DevcelError::Io(error.error))?;
    Ok(RuntimeExportSummary {
        manifest,
        table_count: chunks.len(),
        record_count,
    })
}

/// Resolve aliases even for an unsaved/externally removed live table. Canonicalize
/// the nearest existing ancestor, then append the non-existing suffix.
fn export_path_identity(path: &std::path::Path) -> Result<std::path::PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut existing = absolute.as_path();
    let mut suffix = Vec::new();
    loop {
        match std::fs::canonicalize(existing) {
            Ok(mut resolved) => {
                for part in suffix.into_iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(existing)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Err(crate::app_error::diagnostic(
                        "error.export.danglingSymlink",
                        serde_json::json!({"path": existing.display().to_string()}),
                    ));
                }
                let Some(name) = existing.file_name() else {
                    return Err(error.into());
                };
                suffix.push(name.to_owned());
                let Some(parent) = existing.parent() else {
                    return Err(error.into());
                };
                existing = parent;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

/// Read one unloaded export source without inserting it into editor state.
/// Code generation shares the same storage/column-identity validation path.
pub(crate) fn read_unloaded_export_table(
    project: &crate::Project,
    source: &std::path::Path,
) -> Result<crate::Table> {
    let text = std::fs::read_to_string(source)?;
    let data = TableData::from_toml(&text)?;
    crate::Interface::validate_table_column_ids(&data, &project.interface_registry)?;
    Ok(crate::Table {
        path: source.to_path_buf(),
        data,
        is_dirty: false,
        undo_history: Vec::new(),
        redo_history: Vec::new(),
    })
}

fn formula_snapshot_error(error: crate::FormulaError) -> DevcelError {
    crate::app_error::diagnostic(
        "error.export.formulaSnapshot",
        serde_json::json!({"error": error.diagnostic()}),
    )
}
