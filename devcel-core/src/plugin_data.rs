//! Bulk updates of canonical TableData by plugins.
//!
//! Finish validation and saving before changing memory or history. Resolve file paths
//! only from existing table UUIDs, never from input. Use dedicated APIs for interface-managed structure.
use crate::commands::{CommandData, SavePriority};
use crate::file_save_queue::FileBasedSaveQueueManager;
use crate::{ColumnSchema, DevcelError, Project, Result, TableData, ValueType};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

fn invalid(message: impl Into<String>) -> DevcelError {
    DevcelError::Validation(message.into())
}

fn check_uuid(value: &str, kind: &str) -> Result<()> {
    uuid::Uuid::parse_str(value).map_err(|_| invalid(format!("Invalid {kind} UUID: {value}")))?;
    Ok(())
}

fn same<T: serde::Serialize>(left: &T, right: &T) -> Result<bool> {
    Ok(serde_json::to_value(left)? == serde_json::to_value(right)?)
}

fn validate_cell(column: &ColumnSchema, value: &str) -> Result<String> {
    // Preserve empty cells separately from default values to guarantee round trips with getTable.
    if value.is_empty() {
        return Ok(String::new());
    }
    let value = column.validate_value(&value.to_string())?;
    if !value.starts_with('=')
        && matches!(column.data_type, ValueType::F32 | ValueType::F64)
        && !value.parse::<f64>().is_ok_and(f64::is_finite)
    {
        return Err(invalid(format!(
            "Non-finite value for {}",
            column.data_name
        )));
    }
    Ok(value)
}

/// Protect existing table identities and interface-managed structure, and validate all input.
pub fn validate_table_data(
    project: &Project,
    table_uuid: &str,
    mut data: TableData,
) -> Result<TableData> {
    // Exact empty raw input clears an override; whitespace and formulas remain values.
    for record in &mut data.records {
        record.values.retain(|_, value| !value.is_empty());
        record.interface_values.retain(|_, value| !value.is_empty());
    }
    let original = project.read_table_data_by_uuid(table_uuid)?;
    crate::edit_controls::validate_transition(&original, &data, false)?;
    if data.uuid != table_uuid {
        return Err(invalid("Table UUID cannot be changed"));
    }
    if data.metadata.parent_uuid != original.metadata.parent_uuid {
        return Err(invalid(
            "Table parent must be changed through the table API",
        ));
    }
    if data.metadata.data_name != original.metadata.data_name {
        crate::validate_data_name(&data.metadata.data_name)?;
    }
    if !same(
        &data.interface_implementations,
        &original.interface_implementations,
    )? || data.metadata.interface_order != original.metadata.interface_order
    {
        return Err(invalid(
            "Interface implementations must be changed through the interface API",
        ));
    }

    let old_columns: HashMap<_, _> = original
        .schema
        .columns
        .iter()
        .map(|column| (column.uuid.as_str(), column))
        .collect();
    let mut column_ids = HashSet::new();
    let mut names = HashSet::new();
    for column in &mut data.schema.columns {
        column.color_swatches = crate::normalize_color_swatches(column.color_swatches.clone())?;
        crate::cell_rules::normalize_column_rules(column)?;
        crate::cell_rules::validate_column_definition(column)?;
        check_uuid(&column.uuid, "column")?;
        if !column_ids.insert(column.uuid.clone()) {
            return Err(invalid("Duplicate column UUID"));
        }
        let old = old_columns.get(column.uuid.as_str());
        crate::validate_data_name(&column.data_name)?;
        if !names.insert((column.interface_origin.clone(), column.data_name.clone())) {
            return Err(invalid("Duplicate column data name in the same namespace"));
        }
        if column.interface_origin.is_some() || old.is_some_and(|c| c.interface_origin.is_some()) {
            let Some(old) = old else {
                return Err(invalid(
                    "Cannot add interface-owned columns through updateTable",
                ));
            };
            // Display settings are editable; type, name, constraints, and ownership are not.
            let mut allowed = (*old).clone();
            allowed.style = column.style.clone();
            allowed.tooltip = column.tooltip.clone();
            allowed.memo_text = column.memo_text.clone();
            allowed.conditional_formatting_override =
                column.conditional_formatting_override.clone();
            if !same(&allowed, column)? {
                return Err(invalid("Cannot change interface-owned column definitions"));
            }
        }
        let default_value = validate_cell(column, &column.default_value)?;
        if column.interface_origin.is_none() {
            column.default_value = default_value;
        }
        if let Some(config) = &column.curve_config {
            if column.data_type != ValueType::Curve
                || !config.start_value.is_finite()
                || !config.end_value.is_finite()
            {
                return Err(invalid("Invalid Curve configuration"));
            }
        }
        if let Some(config) = &column.reference_config {
            if column.data_type != ValueType::Reference {
                return Err(invalid("Reference configuration requires Reference type"));
            }
            check_uuid(&config.target_table_uuid, "reference table")?;
        }
        if let Some(config) = &column.table_ref_config {
            if column.data_type != ValueType::TableRef {
                return Err(invalid("TableRef configuration requires TableRef type"));
            }
            check_uuid(&config.interface_uuid, "interface")?;
            // Allow unrelated edits with existing broken references; check existence only for new settings.
            if old.is_none_or(|old| old.table_ref_config != column.table_ref_config)
                && project
                    .get_interface(&uuid::Uuid::parse_str(&config.interface_uuid).unwrap())
                    .is_none()
            {
                return Err(invalid("TableRef interface not found"));
            }
        }
        if let Some(constraints) = &column.constraints {
            if constraints.min_value.is_some_and(|v| !v.is_finite())
                || constraints.max_value.is_some_and(|v| !v.is_finite())
                || matches!((constraints.min_value, constraints.max_value), (Some(min), Some(max)) if min > max)
            {
                return Err(invalid("Invalid column constraint range"));
            }
            if let Some(pattern) = &constraints.pattern {
                regex::Regex::new(pattern)
                    .map_err(|e| invalid(format!("Invalid constraint pattern: {e}")))?;
            }
        }
    }
    if old_columns
        .values()
        .any(|column| column.interface_origin.is_some() && !column_ids.contains(&column.uuid))
    {
        return Err(invalid(
            "Cannot remove interface-owned columns through updateTable",
        ));
    }

    let normal_columns: HashMap<_, _> = data
        .schema
        .columns
        .iter()
        .filter(|column| column.interface_origin.is_none())
        .map(|column| (column.data_name.as_str(), column))
        .collect();
    let interface_columns: HashMap<_, _> = data
        .schema
        .columns
        .iter()
        .filter(|column| column.interface_origin.is_some())
        .map(|column| (column.uuid.as_str(), column))
        .collect();
    let mut record_ids = HashSet::new();
    for record in &mut data.records {
        check_uuid(&record.uuid, "record")?;
        if !record_ids.insert(record.uuid.clone()) {
            return Err(invalid("Duplicate record UUID"));
        }
        for (name, value) in &mut record.values {
            let column = normal_columns
                .get(name.as_str())
                .copied()
                .ok_or_else(|| invalid(format!("Unknown record column: {name}")))?;
            *value = validate_cell(column, value)?;
        }
        for (id, value) in &mut record.interface_values {
            let column = interface_columns
                .get(id.as_str())
                .ok_or_else(|| invalid(format!("Unknown interface column: {id}")))?;
            *value = validate_cell(column, value)?;
        }
    }
    data.validate_storage_contract()?;
    Ok(data)
}

/// A single Undo/Redo unit, including persistence. Failures leave both data and history unchanged.
pub struct UpdateTableDataCommand {
    table_uuid: String,
    expected_revision: String,
    data: TableData,
    original: Option<TableData>,
    acknowledgement: Option<String>,
}

impl UpdateTableDataCommand {
    pub fn new(table_uuid: String, data: TableData, expected_revision: String) -> Self {
        Self {
            table_uuid,
            expected_revision,
            data,
            original: None,
            acknowledgement: None,
        }
    }

    pub fn with_validation_acknowledgement(mut self, acknowledgement: Option<String>) -> Self {
        self.acknowledgement = acknowledgement;
        self
    }

    fn apply(&self, project: &mut Project, data: TableData) -> Result<()> {
        let table = project
            .find_table_by_uuid_mut(&self.table_uuid)
            .ok_or_else(|| DevcelError::NotFound("Table not found".into()))?;
        table.data = data;
        table.is_dirty = true;
        Ok(())
    }
}

impl CommandData for UpdateTableDataCommand {
    fn execute(&mut self, project: &mut Project) -> Result<()> {
        let current = project
            .find_table_by_uuid(&self.table_uuid)
            .ok_or_else(|| DevcelError::NotFound("Table not found".into()))?;
        if crate::cell_rules::revision(&current.data) != self.expected_revision {
            return Err(invalid(
                "Table revision changed; fetch a new snapshot before replacing data",
            ));
        }
        let data = validate_table_data(project, &self.table_uuid, self.data.clone())?;
        let original = project
            .find_table_by_uuid(&self.table_uuid)
            .unwrap()
            .data
            .clone();
        self.apply(project, data)?;
        self.original = Some(original);
        Ok(())
    }

    fn undo(&mut self, project: &mut Project) -> Result<()> {
        let original = self
            .original
            .clone()
            .ok_or_else(|| invalid("Update has not been executed"))?;
        self.apply(project, original)
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
    fn validation_acknowledgement(&self) -> Option<&str> {
        self.acknowledgement.as_deref()
    }
    fn save_priority(&self) -> SavePriority {
        SavePriority::High
    }
}

pub fn update_table_data(
    project: &mut Project,
    table_uuid: &str,
    expected_revision: &str,
    data: serde_json::Value,
    save_queue: Option<Arc<FileBasedSaveQueueManager>>,
) -> Result<()> {
    update_table_data_checked(
        project,
        table_uuid,
        expected_revision,
        data,
        None,
        save_queue,
    )
}

/// Warning approval resubmits the same candidate, binding it and the previous state at the central gate.
pub fn update_table_data_checked(
    project: &mut Project,
    table_uuid: &str,
    expected_revision: &str,
    data: serde_json::Value,
    acknowledgement: Option<String>,
    save_queue: Option<Arc<FileBasedSaveQueueManager>>,
) -> Result<()> {
    // Do not silently ignore undefined paths or rows/columns fields.
    let object = data
        .as_object()
        .ok_or_else(|| invalid("Expected a complete TableData object from getTable"))?;
    const FIELDS: &[&str] = &[
        "uuid",
        "display_name",
        "description",
        "metadata",
        "interface_implementations",
        "schema",
        "records",
    ];
    if object.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err(invalid(
            "Unknown TableData field; use the object returned by getTable",
        ));
    }
    let data = TableData::from_json_value(data)?;
    project.execute_command(
        UpdateTableDataCommand::new(table_uuid.into(), data, expected_revision.into())
            .with_validation_acknowledgement(acknowledgement),
        save_queue.as_ref(),
    )
}
