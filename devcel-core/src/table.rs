use crate::app_error::diagnostic;
use crate::column::ColumnSchema;
use crate::commands::Command;
use crate::interface::{
    ColumnMismatch, ConstraintViolation, Interface, InterfaceImplementation, InterfaceValidation,
};
use crate::record::Record;
use crate::{AppError, DevcelError, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone)]
pub struct Table {
    pub path: PathBuf,
    pub is_dirty: bool,
    pub data: TableData,
    pub undo_history: Vec<Command>,
    pub redo_history: Vec<Command>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(try_from = "StoredTableData")]
pub struct TableData {
    pub uuid: String,
    pub display_name: String,
    pub description: String,
    pub metadata: TableMetadata,
    #[serde(serialize_with = "crate::ordered_map::serialize")]
    pub interface_implementations: HashMap<uuid::Uuid, InterfaceImplementation>,
    pub schema: TableSchema,
    pub records: Vec<Record>,
}

/// Per-table authoring controls. New tables start fully editable.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TableEditPermissions {
    pub add_columns: bool,
    pub delete_columns: bool,
    pub add_rows: bool,
    pub delete_rows: bool,
    pub edit_cells: bool,
}
impl Default for TableEditPermissions {
    fn default() -> Self {
        Self {
            add_columns: true,
            delete_columns: true,
            add_rows: true,
            delete_rows: true,
            edit_cells: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct TableMetadata {
    /// On-disk authoring schema; absent in legacy files means version 1.
    #[serde(
        default = "crate::authoring_format::default_schema_version",
        deserialize_with = "crate::authoring_format::deserialize_schema_version",
        serialize_with = "crate::authoring_format::serialize_schema_version"
    )]
    pub schema_version: u32,
    pub interface_order: Vec<uuid::Uuid>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub parent_uuid: String,
    pub data_name: String,
    pub initial_transposed: bool,
    pub edit_permissions: TableEditPermissions,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TableSchema {
    pub columns: Vec<ColumnSchema>,
}

/// The on-disk contract requires explicit collections and canonical cell keys.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredTableData {
    uuid: String,
    display_name: String,
    description: String,
    metadata: TableMetadata,
    interface_implementations: HashMap<uuid::Uuid, InterfaceImplementation>,
    schema: TableSchema,
    records: Vec<Record>,
}
impl TryFrom<StoredTableData> for TableData {
    type Error = DevcelError;
    fn try_from(stored: StoredTableData) -> Result<Self> {
        let mut data = Self {
            uuid: stored.uuid,
            display_name: stored.display_name,
            description: stored.description,
            metadata: stored.metadata,
            interface_implementations: stored.interface_implementations,
            schema: stored.schema,
            records: stored.records,
        };
        crate::edit_controls::normalize_settings_metadata(&mut data);
        data.validate_storage_contract()?;
        Ok(data)
    }
}
impl TableData {
    /// Parse and validate without converting application diagnostics into a parser string.
    pub fn from_toml(text: &str) -> Result<Self> {
        let stored: StoredTableData = toml::from_str(text)?;
        Self::try_from(stored)
    }

    pub(crate) fn from_toml_value(value: toml::Value) -> Result<Self> {
        let stored: StoredTableData = value.try_into()?;
        Self::try_from(stored)
    }

    /// Native JSON/RPC decoding keeps storage validation causes structured.
    pub fn from_json_value(value: serde_json::Value) -> Result<Self> {
        let stored: StoredTableData = serde_json::from_value(value)?;
        Self::try_from(stored)
    }

    pub fn validate_storage_contract(&self) -> Result<()> {
        let mut column_ids = std::collections::HashSet::new();
        let mut normal_names = std::collections::HashSet::new();
        let mut interface_ids = std::collections::HashSet::new();
        for column in &self.schema.columns {
            column.validate_color_storage_contract()?;
            uuid::Uuid::parse_str(&column.uuid).map_err(|error| {
                diagnostic(
                    "error.storage.invalidColumnId",
                    json!({"id": column.uuid, "error": error.to_string()}),
                )
            })?;
            crate::validate_data_name(&column.data_name)?;
            if !column_ids.insert(column.uuid.as_str()) {
                return Err(diagnostic(
                    "error.storage.duplicateColumnId",
                    json!({"id": column.uuid}),
                ));
            }
            if column.interface_origin.is_some() {
                interface_ids.insert(column.uuid.as_str());
            } else if !normal_names.insert(column.data_name.as_str()) {
                return Err(diagnostic(
                    "column.validation.inputError",
                    json!({"context": column.data_name, "error": AppError::owned("A column with the same name already exists")}),
                ));
            }
        }
        let color_columns: Vec<_> = self
            .schema
            .columns
            .iter()
            .filter(|column| column.data_type.is_color())
            .collect();
        for record in &self.records {
            for column in &color_columns {
                if let Some(value) = record.get_cell_value(column) {
                    column
                        .validate_color_storage_value(value)
                        .map_err(|error| diagnostic("error.storage.recordValue", json!({"record": record.uuid, "column": column.data_name, "error": AppError::from(error)})))?;
                }
            }
            for key in record.values.keys() {
                if !normal_names.contains(key.as_str()) {
                    return Err(diagnostic(
                        "error.storage.noncanonicalCell",
                        json!({"record": record.uuid, "key": key}),
                    ));
                }
            }
            for key in record.interface_values.keys() {
                if !interface_ids.contains(key.as_str()) {
                    return Err(diagnostic(
                        "error.storage.recordValue",
                        json!({"record": record.uuid, "column": key, "error": AppError::code("error.columnMissing", json!({}))}),
                    ));
                }
            }
        }
        self.validate_parent_graph()?;
        Ok(())
    }

    pub fn validate_parent_graph(&self) -> Result<()> {
        let rows: HashMap<_, _> = self.records.iter().map(|r| (r.uuid.as_str(), r)).collect();
        if rows.len() != self.records.len() {
            return Err(diagnostic("error.storage.duplicateRecordId", json!({})));
        }
        let mut done = std::collections::HashSet::new();
        for row in &self.records {
            let mut current = row;
            let mut path = std::collections::HashSet::new();
            while !done.contains(current.uuid.as_str()) {
                if !path.insert(current.uuid.as_str()) {
                    return Err(diagnostic(
                        "error.record.parentCycle",
                        json!({"row": current.uuid}),
                    ));
                }
                if current.parent_uuid.is_empty() {
                    break;
                }
                current = rows
                    .get(current.parent_uuid.as_str())
                    .copied()
                    .ok_or_else(|| {
                        diagnostic(
                            "error.record.parentMissing",
                            json!({"parent": current.parent_uuid}),
                        )
                    })?;
            }
            done.extend(path);
        }
        Ok(())
    }

    /// Resolve authoring input, retaining formulas and explicit local empty values.
    /// For a batch use InheritanceResolver once, rather than rebuilding its index.
    pub fn effective_cell_input<'a>(
        &'a self,
        record: &'a Record,
        column: &'a ColumnSchema,
    ) -> crate::Result<&'a str> {
        match record.get_cell_value(column).is_some() {
            true => Ok(record
                .get_cell_value(column)
                .map(String::as_str)
                .unwrap_or("")),

            false if record.parent_uuid.is_empty() => Ok(&column.default_value),
            _ => InheritanceResolver::new(self).input(record, column),
        }
    }
}

/// Snapshot-scoped cache for project queries. It retains indices and lazily
/// requested raw inputs, never copies all records or materializes their values.
#[derive(Default)]
pub(crate) struct InputResolutionCache {
    rows: HashMap<String, usize>,
    inputs: HashMap<(String, String), std::sync::Arc<str>>,
}
impl InputResolutionCache {
    pub(crate) fn input(
        &mut self,
        data: &TableData,
        record: &Record,
        column: &ColumnSchema,
    ) -> Result<String> {
        match record.get_cell_value(column).is_some() {
            true => return Ok(record.get_cell_value(column).cloned().unwrap_or_default()),

            false if record.parent_uuid.is_empty() => return Ok(column.default_value.clone()),
            _ => {}
        }
        if self.rows.is_empty() {
            self.rows.extend(
                data.records
                    .iter()
                    .enumerate()
                    .map(|(i, r)| (r.uuid.clone(), i)),
            );
        }
        let mut current = record;
        let mut seen = std::collections::HashSet::new();
        let mut path = Vec::new();
        let value = loop {
            let key = (current.uuid.clone(), column.uuid.clone());
            if let Some(input) = self.inputs.get(&key) {
                break input.to_string();
            }
            if !seen.insert(current.uuid.as_str()) {
                return Err(diagnostic(
                    "error.record.parentCycle",
                    json!({"row": current.uuid}),
                ));
            }
            path.push(key);
            match current.get_cell_value(column).is_some() {
                true => break current.get_cell_value(column).cloned().unwrap_or_default(),

                false if current.parent_uuid.is_empty() => break column.default_value.clone(),
                false => {
                    current = self
                        .rows
                        .get(&current.parent_uuid)
                        .and_then(|i| data.records.get(*i))
                        .ok_or_else(|| {
                            diagnostic(
                                "error.record.parentMissing",
                                json!({"parent": current.parent_uuid}),
                            )
                        })?
                }
            }
        };
        let shared: std::sync::Arc<str> = value.as_str().into();
        for key in path {
            self.inputs.insert(key, shared.clone());
        }
        Ok(value)
    }
}

/// Lazy input resolver: only UUID indices and requested cells are retained. Parent
/// walks are iterative, and memoization shares resolved ancestor inputs.
pub struct InheritanceResolver<'a> {
    rows: HashMap<&'a str, &'a Record>,
    inputs: std::cell::RefCell<HashMap<(&'a str, &'a str), &'a str>>,
}
impl<'a> InheritanceResolver<'a> {
    pub fn new(data: &'a TableData) -> Self {
        Self {
            rows: data.records.iter().map(|r| (r.uuid.as_str(), r)).collect(),
            inputs: Default::default(),
        }
    }
    pub fn input_transient<'b>(
        &'b self,
        record: &'b Record,
        column: &'b ColumnSchema,
    ) -> Result<&'b str> {
        let mut current = record;
        let mut seen = std::collections::HashSet::new();
        loop {
            if !seen.insert(current.uuid.as_str()) {
                return Err(diagnostic(
                    "error.record.parentCycle",
                    json!({"row": current.uuid}),
                ));
            }
            match current.get_cell_value(column).is_some() {
                true => {
                    return Ok(current
                        .get_cell_value(column)
                        .map(String::as_str)
                        .unwrap_or(""))
                }

                false if current.parent_uuid.is_empty() => return Ok(&column.default_value),
                false => {
                    current = self
                        .rows
                        .get(current.parent_uuid.as_str())
                        .copied()
                        .ok_or_else(|| {
                            diagnostic(
                                "error.record.parentMissing",
                                json!({"parent": current.parent_uuid}),
                            )
                        })?
                }
            }
        }
    }
    /// Resolve input without flattening application diagnostics into text.
    pub fn input(&self, record: &'a Record, column: &'a ColumnSchema) -> crate::Result<&'a str> {
        let mut current = record;
        let mut path = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let value = loop {
            let key = (current.uuid.as_str(), column.uuid.as_str());
            if let Some(value) = self.inputs.borrow().get(&key) {
                break *value;
            }
            if !visited.insert(current.uuid.as_str()) {
                return Err(crate::app_error::diagnostic(
                    "error.record.parentCycle",
                    serde_json::json!({"row": current.uuid}),
                ));
            }
            path.push(key);
            match current.get_cell_value(column).is_some() {
                true => {
                    break current
                        .get_cell_value(column)
                        .map(String::as_str)
                        .unwrap_or("")
                }

                false if current.parent_uuid.is_empty() => break column.default_value.as_str(),
                false => {
                    current = self
                        .rows
                        .get(current.parent_uuid.as_str())
                        .copied()
                        .ok_or_else(|| {
                            crate::app_error::diagnostic(
                                "error.record.parentMissing",
                                serde_json::json!({"parent": current.parent_uuid}),
                            )
                        })?
                }
            }
        };
        let mut inputs = self.inputs.borrow_mut();
        for key in path {
            inputs.insert(key, value);
        }
        Ok(value)
    }
}

impl Table {
    /// Apply an interface
    pub fn apply_interface(
        &mut self,
        interface: &Interface,
        registry: &crate::interface::InterfaceRegistry,
        auto_add_columns: bool,
    ) -> Result<()> {
        eprintln!("Applying interface {}...", interface.name);

        // Check whether it is already implemented
        if self
            .data
            .interface_implementations
            .contains_key(&interface.uuid)
        {
            return Err(diagnostic(
                "error.interface.alreadyImplemented",
                json!({"id": interface.uuid}),
            ));
        }

        let effective_columns = interface.get_effective_columns(registry)?;
        interface.check_shared_update(self, &effective_columns, registry)?;
        // Run validation
        let validation = self.validate_interface(interface, registry)?;

        if !validation.is_valid {
            if !auto_add_columns {
                return Err(DevcelError::Diagnostics(validation.missing_columns.iter().map(|name| {
                    crate::types::Diagnostic::Code { code: "interface.dialog.missingColumn".into(), params: json!({"name": name}) }
                }).chain(validation.type_mismatches.iter().map(|mismatch| {
                    crate::types::Diagnostic::Code { code: "interface.dialog.typeMismatch".into(), params: json!({
                        "name": mismatch.column_name, "expected": mismatch.expected_type, "actual": mismatch.actual_type
                    }) }
                })).chain(validation.constraint_violations.iter().map(|violation| violation.diagnostic.clone())).collect()));
            }

            // Automatically add missing columns
            // Use get_effective_columns to include inherited columns
            let effective_columns = interface.get_effective_columns(registry)?;

            for column_name in &validation.missing_columns {
                if let Some(interface_col) = effective_columns
                    .iter()
                    .find(|c| &c.data_name == column_name)
                {
                    self.add_column_from_interface(
                        interface_col,
                        &interface.uuid.to_string(),
                        &interface.name,
                    )?;
                }
            }
        }

        // Record implementation information
        let implementation = InterfaceImplementation {
            interface_uuid: interface.uuid,
            synced_version_id: interface.current_version_id,
            last_sync_date: Utc::now(),
            effective_fingerprint: Some(interface.effective_fingerprint(registry)),
            required_column_uuids: Some(
                effective_columns
                    .iter()
                    .map(|column| column.uuid.clone())
                    .collect(),
            ),
        };

        self.data
            .interface_implementations
            .insert(interface.uuid, implementation);

        // Update interface order, adding only previously unrecorded entries
        if !self.data.metadata.interface_order.contains(&interface.uuid) {
            self.data.metadata.interface_order.push(interface.uuid);
        }

        self.mark_dirty();

        eprintln!(
            "Interface {} applied. Columns added: {}",
            interface.name,
            validation.missing_columns.len()
        );

        Ok(())
    }

    /// Validate an interface
    pub fn validate_interface(
        &self,
        interface: &Interface,
        registry: &crate::interface::InterfaceRegistry,
    ) -> Result<InterfaceValidation> {
        let mut validation = InterfaceValidation {
            interface_uuid: interface.uuid,
            is_valid: true,
            missing_columns: Vec::new(),
            type_mismatches: Vec::new(),
            constraint_violations: Vec::new(),
        };

        // Get effective columns, including inheritance
        let effective_columns = interface.get_effective_columns(registry)?;

        // Check each column
        for interface_col in &effective_columns {
            // Check whether a column originating from this interface already exists
            // Treat matching data_name values from different interfaces as separate columns
            // For inheritance, however, parent-origin columns are also part of this interface
            // interface_col.interface_origin should identify the original definition owner

            let table_col = self.data.schema.columns.iter().find(|column| {
                column.interface_origin.is_some() && column.uuid == interface_col.uuid
            });
            if let Some(table_col) = table_col {
                // Check types
                if table_col.data_type != interface_col.data_type {
                    validation.type_mismatches.push(ColumnMismatch {
                        column_name: interface_col.data_name.clone(),
                        expected_type: interface_col.data_type.clone(),
                        actual_type: table_col.data_type.clone(),
                    });
                    validation.is_valid = false;
                }

                // Check required flags and constraints against record values using the interface definition
                let violations = self.check_column_constraints(interface_col, table_col);
                if !violations.is_empty() {
                    validation.is_valid = false;
                    validation.constraint_violations.extend(violations);
                }
            } else {
                // No column originating from this interface exists
                validation
                    .missing_columns
                    .push(interface_col.data_name.clone());
                validation.is_valid = false;
            }
        }

        Ok(validation)
    }

    /// Validate record values against interface-defined required flags and constraints
    ///
    /// Semantics:
    /// - Required: the effective whole-cell input must be nonempty
    /// - unique / min / max / pattern: apply to effective inherited/local/default inputs
    ///   Formula inputs are checked by the formula-aware validation path.
    /// - Compare uniqueness after type normalization, aligning "1.0" and "1" according to type rules
    pub(crate) fn check_column_constraints(
        &self,
        interface_col: &ColumnSchema,
        table_col: &ColumnSchema,
    ) -> Vec<ConstraintViolation> {
        self.check_column_constraints_for_version(interface_col, table_col, None)
    }

    pub(crate) fn check_column_constraints_for_version(
        &self,
        interface_col: &ColumnSchema,
        table_col: &ColumnSchema,
        version: Option<u32>,
    ) -> Vec<ConstraintViolation> {
        let mut violations = Vec::new();

        let required = interface_col.required.unwrap_or(false);
        let constraints = interface_col.constraints.clone().unwrap_or_default();

        if !required && constraints.is_empty() {
            return violations;
        }

        // Compile patterns in advance, reporting invalid patterns as violations themselves
        let pattern = match &constraints.pattern {
            Some(p) => match regex::Regex::new(p) {
                Ok(re) => Some(re),
                Err(_) => {
                    violations.push(ConstraintViolation {
                        column_name: interface_col.data_name.clone(),
                        constraint_type: "pattern".to_string(),
                        diagnostic: crate::types::Diagnostic::Code {
                            code: "interface.validation.invalidPattern".to_string(),
                            params: serde_json::json!({ "name": interface_col.data_name }),
                        },
                        record_uuid: None,
                    });
                    None
                }
            },
            None => None,
        };

        let range_label = match (constraints.min_value, constraints.max_value) {
            (Some(min), Some(max)) => Some(format!("{}〜{}", min, max)),
            (Some(min), None) => Some(format!("At least {}", min)),
            (None, Some(max)) => Some(format!("At most {}", max)),
            (None, None) => None,
        };

        let mut seen_values: HashMap<String, crate::types::Diagnostic> = HashMap::new();
        let inheritance = InheritanceResolver::new(&self.data);

        for (source_index, record) in self
            .data
            .records
            .iter()
            .enumerate()
            .filter(|(_, r)| version.is_none_or(|v| r.min_version <= v))
        {
            let record_label = record.display_label_diagnostic(source_index);

            let raw_value = inheritance.input(record, table_col).unwrap_or("");

            if raw_value.is_empty() {
                // Explicit local empty and an empty resolved default are both empty.
                if required {
                    violations.push(ConstraintViolation {
                        column_name: interface_col.data_name.clone(),
                        constraint_type: "required".to_string(),
                        diagnostic: crate::types::Diagnostic::Code { code: "interface.validation.required".to_string(), params: serde_json::json!({ "name": interface_col.data_name, "record": record_label }) },
                        record_uuid: Some(record.uuid.clone()),
                    });
                }
                continue;
            }

            // Exclude formula cells because their evaluation result is not established here
            // (Checking formula text against ranges or patterns would produce false positives)
            if raw_value.starts_with('=') {
                continue;
            }

            if constraints.unique.unwrap_or(false) {
                // Compare type-normalized values, aligning "1.0" and "1" using I32/F64 rules
                let normalized = table_col
                    .validate_value(&raw_value.to_string())
                    .unwrap_or_else(|_| raw_value.to_string());
                if let Some(first_label) = seen_values.insert(normalized, record_label.clone()) {
                    violations.push(ConstraintViolation {
                        column_name: interface_col.data_name.clone(),
                        constraint_type: "unique".to_string(),
                        diagnostic: crate::types::Diagnostic::Code { code: "interface.validation.unique".to_string(), params: serde_json::json!({ "name": interface_col.data_name, "value": raw_value, "firstRecord": first_label, "record": record_label }) },
                        record_uuid: Some(record.uuid.clone()),
                    });
                }
            }

            if range_label.is_some() {
                // Skip unparseable numbers here; type validation is responsible for them
                if let Ok(number) = raw_value.parse::<f64>() {
                    let below = constraints.min_value.is_some_and(|min| number < min);
                    let above = constraints.max_value.is_some_and(|max| number > max);
                    if below || above {
                        violations.push(ConstraintViolation {
                            column_name: interface_col.data_name.clone(),
                            constraint_type: if below { "min_value" } else { "max_value" }
                                .to_string(),
                            diagnostic: crate::types::Diagnostic::Code { code: "interface.validation.range".to_string(), params: serde_json::json!({ "name": interface_col.data_name, "value": raw_value, "record": record_label, "bounds": match (constraints.min_value, constraints.max_value) { (Some(_), Some(_)) => "both", (Some(_), None) => "min", _ => "max" }, "min": constraints.min_value.unwrap_or(0.0), "max": constraints.max_value.unwrap_or(0.0) }) },
                            record_uuid: Some(record.uuid.clone()),
                        });
                    }
                }
            }

            if let Some(re) = &pattern {
                if !re.is_match(raw_value) {
                    violations.push(ConstraintViolation {
                        column_name: interface_col.data_name.clone(),
                        constraint_type: "pattern".to_string(),
                        diagnostic: crate::types::Diagnostic::Code { code: "interface.validation.pattern".to_string(), params: serde_json::json!({ "name": interface_col.data_name, "value": raw_value, "record": record_label }) },
                        record_uuid: Some(record.uuid.clone()),
                    });
                }
            }
        }

        violations
    }

    /// Count entered values in interface-origin columns
    /// (Used to preview destructive-operation impact; when column_names is None,
    /// include all columns originating from the interface)
    pub fn count_interface_column_values(
        &self,
        interface_uuid: &str,
        column_names: Option<&[String]>,
    ) -> usize {
        let target_uuids: Vec<&String> = self
            .data
            .schema
            .columns
            .iter()
            .filter(|c| {
                c.interface_origin.as_deref() == Some(interface_uuid)
                    && column_names
                        .map(|names| names.contains(&c.data_name))
                        .unwrap_or(true)
            })
            .map(|c| &c.uuid)
            .collect();

        self.data
            .records
            .iter()
            .map(|record| {
                target_uuids
                    .iter()
                    .filter(|uuid| {
                        record
                            .interface_values
                            .get(**uuid)
                            .map(|v| !v.is_empty())
                            .unwrap_or(false)
                    })
                    .count()
            })
            .sum()
    }

    /// Add a column from an interface
    fn add_column_from_interface(
        &mut self,
        interface_col: &crate::column::ColumnSchema,
        interface_uuid: &str,
        interface_name: &str,
    ) -> Result<()> {
        // Copy the column
        // Keep the interface definition's UUID as the stable column ID
        let mut column = interface_col.clone();
        // Record the interface origin using its UUID
        column.interface_origin = Some(interface_uuid.to_string());
        // Also record the interface name as a fallback
        column.interface_origin_name_fallback = Some(interface_name.to_string());

        self.data.schema.columns.push(column);
        Ok(())
    }

    /// Set the dirty flag
    pub fn mark_dirty(&mut self) {
        self.is_dirty = true;
    }

    /// Check whether a column exists
    pub fn has_column(&self, column_name: &str) -> bool {
        self.data
            .schema
            .columns
            .iter()
            .any(|c| c.data_name == column_name)
    }

    /// Remove an interface implementation
    pub fn remove_interface(&mut self, interface_uuid: &uuid::Uuid) -> Result<()> {
        if self
            .data
            .interface_implementations
            .remove(interface_uuid)
            .is_none()
        {
            return Err(diagnostic(
                "error.interface.notImplemented",
                json!({"id": interface_uuid}),
            ));
        }

        // Remove it from interface order too
        self.data
            .metadata
            .interface_order
            .retain(|uuid| uuid != interface_uuid);

        self.mark_dirty();
        Ok(())
    }
}

impl TableData {
    /// Get a column definition by column name
    fn find_column_by_name(&self, column_name: &str) -> Option<&ColumnSchema> {
        self.schema
            .columns
            .iter()
            .find(|c| c.data_name == column_name)
    }

    /// Set a record value with formula detection
    /// Delegate storage routing between ordinary `values` and interface-origin
    /// `interface_values` to Record::set_cell_value
    /// Sets a record value with formula detection
    /// This standalone API has no project query context. Input rules report
    /// cross-table formulas as context-required errors; use the corresponding
    /// `Project` method to resolve project dependencies during validation.
    pub fn set_record_value_with_formula(
        &mut self,
        record_uuid: &str,
        column_name: &str,
        value: &str,
    ) -> Result<()> {
        // Get and clone the column definition before mutably borrowing the record
        let column = self
            .find_column_by_name(column_name)
            .cloned()
            .ok_or_else(|| {
                diagnostic(
                    "interface.dialog.missingColumn",
                    json!({"name": column_name}),
                )
            })?;

        let mut candidate = self.clone();
        let record = candidate
            .records
            .iter_mut()
            .find(|r| r.uuid == record_uuid)
            .ok_or_else(|| diagnostic("error.notFound", json!({"details": record_uuid})))?;
        let normalized = if value.is_empty() {
            String::new()
        } else {
            column.validate_value(&value.to_string())?
        };
        record.set_cell_value(&column, normalized);
        crate::cell_rules::validate_transition("", self, &candidate, None)?;
        *self = candidate;

        Ok(())
    }

    /// Get a record value
    /// Delegate value access to Record::get_cell_value
    /// Gets the value for a record
    pub fn get_record_value(&self, record_uuid: &str, column_name: &str) -> Option<String> {
        let record = self.records.iter().find(|r| r.uuid == record_uuid)?;
        let column = self.find_column_by_name(column_name);

        column.and_then(|column| {
            self.effective_cell_input(record, column)
                .ok()
                .map(str::to_owned)
        })
    }
}
