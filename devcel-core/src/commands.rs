use crate::column::{ColumnSchema, ColumnStyle};
use crate::types::{ReferenceConfig, ReferenceOption, ValueType};
use crate::{DevcelError, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use uuid;

// Forward declarations
use crate::project_impl::Project;

/// Error message for attempts to change an interface-origin column's structure from the table
pub(crate) const INTERFACE_COLUMN_LOCKED_MSG: &str =
    "This column is managed by an interface. Its name, type, default value, and constraints cannot be changed or the column deleted from the table. Make these changes in the interface editor.";

/// Return whether a column originates from an interface and cannot be structurally edited in the table
pub(crate) fn column_is_interface_owned(
    project: &Project,
    table_uuid: &str,
    column_uuid: &str,
) -> bool {
    project.tables_data.values().any(|table| {
        table.data.uuid == table_uuid
            && table
                .data
                .schema
                .columns
                .iter()
                .any(|c| c.uuid == column_uuid && c.interface_origin.is_some())
    })
}

/// Save priority
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SavePriority {
    /// Ordinary operations (debounced)
    Normal,
    /// Transaction completion and undo/redo (save immediately)
    High,
}

/// Command execution result
#[derive(Debug, Clone)]
pub struct CommandExecutionResult {
    /// Whether execution succeeded
    pub success: bool,
    /// Whether saving is needed
    pub should_save: bool,
    /// Save priority
    pub save_priority: SavePriority,
}

pub trait CommandData: Send + Sync {
    fn execute(&mut self, _project: &mut Project) -> Result<()>;
    fn undo(&mut self, _project: &mut Project) -> Result<()>;
    fn get_table_uuid(&self) -> String;

    /// Resolve path-based commands before mutation so rollback/history includes their tables.
    fn affected_tables(&self, _project: &Project) -> Vec<String> {
        self.get_table_uuids()
    }

    /// Only the dedicated edit-control command may change protection settings.
    /// Transactions and complete-table replacements intentionally do not inherit this.
    fn is_edit_control_settings(&self) -> bool {
        false
    }

    /// Only ordinary default-only row creation may establish a baseline with
    /// visible rule issues. The project boundary also verifies the exact delta.
    fn allows_default_record_creation(&self) -> bool {
        false
    }

    /// A token bound to the precise before/schema/candidate, never a validation disable flag.
    fn validation_acknowledgement(&self) -> Option<&str> {
        None
    }

    fn validation_acknowledgement_for(&self, table_uuid: &str) -> Option<&str> {
        if self.get_table_uuid() == table_uuid {
            self.validation_acknowledgement()
        } else {
            None
        }
    }

    /// All participating tables share one command, including multi-table batches.
    fn get_table_uuids(&self) -> Vec<String> {
        let uuid = self.get_table_uuid();
        if uuid.is_empty() {
            Vec::new()
        } else {
            vec![uuid]
        }
    }

    /// Interface editing has its own history scope, independent of table views.
    fn get_interface_uuid(&self) -> Option<uuid::Uuid> {
        None
    }

    /// Reuse immutable states already owned by a replacement command instead of
    /// retaining a second before/after pair in the project history. These must be
    /// the exact states of this execution; the project calls this only after its
    /// validation and atomic persistence have succeeded. Other commands use the
    /// project-owned rollback state and capture their current after-state.
    fn shared_table_history_snapshot(&self, _table_uuid: &str) -> Option<TableHistorySnapshot> {
        None
    }

    /// Return this command's save priority
    fn save_priority(&self) -> SavePriority {
        SavePriority::Normal // Normal priority by default
    }

    /// Whether to save after executing this command
    fn should_save(&self) -> bool {
        true // Save by default
    }
}

#[derive(Clone)]
pub struct Command {
    pub data: Arc<Mutex<dyn CommandData>>,
    pub timestamp: SystemTime,
    pub table_snapshots: Arc<std::collections::BTreeMap<String, TableHistorySnapshot>>,
    pub save_queue: Option<Arc<crate::file_save_queue::FileBasedSaveQueueManager>>,
}

#[derive(Clone)]
pub struct TableHistorySnapshot {
    pub before: Arc<crate::TableData>,
    pub after: Arc<crate::TableData>,
}

impl Command {
    pub fn table_uuids(&self) -> Vec<String> {
        self.table_snapshots.keys().cloned().collect()
    }
}

#[derive(Clone)]
pub struct AddColumnCommand {
    table_uuid: String,
    column_name: String,
    column_type: ValueType,
    tooltip: Option<String>,
    color: Option<String>,
    default_value: Option<String>,
    curve_config: Option<crate::types::CurveConfig>,
    added_column_uuid: String,
    original_record_values: HashMap<String, HashMap<String, String>>, // record_uuid -> column_data_name -> old_value
}

impl AddColumnCommand {
    pub fn new(
        table_uuid: String,
        column_name: &str,
        column_type: ValueType,
        tooltip: Option<String>,
        color: Option<String>,
        default_value: Option<String>,
    ) -> Self {
        Self {
            table_uuid,
            column_name: column_name.to_string(),
            column_type,
            tooltip,
            color,
            default_value,
            curve_config: None,
            added_column_uuid: String::new(),
            original_record_values: HashMap::new(),
        }
    }

    /// Reserve a stable ID before constructing dependent commands in one transaction.
    pub fn with_column_uuid(mut self, uuid: String) -> Self {
        self.added_column_uuid = uuid;
        self
    }

    pub fn with_curve_config(mut self, config: Option<crate::types::CurveConfig>) -> Self {
        self.curve_config = config;
        self
    }

    pub fn get_column_uuid(&self) -> &str {
        &self.added_column_uuid
    }
}

impl CommandData for AddColumnCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        if let Some(config) = &self.curve_config {
            if self.column_type != ValueType::Curve
                || !config.start_value.is_finite()
                || !config.end_value.is_finite()
            {
                return Err(DevcelError::Validation(
                    "Invalid curve configuration".into(),
                ));
            }
        }
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                if !self.added_column_uuid.is_empty()
                    && table
                        .data
                        .schema
                        .columns
                        .iter()
                        .any(|c| c.uuid == self.added_column_uuid)
                {
                    return Err(DevcelError::Validation("Column UUID already exists".into()));
                }
                let mut new_column = ColumnSchema {
                    read_only: false,
                    // Redo must recreate the same column for dependent commands.
                    uuid: if self.added_column_uuid.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        self.added_column_uuid.clone()
                    },
                    display_name: self.column_name.clone(),
                    data_name: self.column_name.clone(),
                    tooltip: self.tooltip.clone().unwrap_or_default(),
                    data_type: self.column_type.clone(),
                    tags: Vec::new(),
                    default_value: self.default_value.clone().unwrap_or_default(),
                    style: ColumnStyle::new(),
                    memo_text: String::new(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: self.curve_config.clone(),
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                };

                new_column.normalize_color_default()?;

                // Set color if provided
                if let Some(color) = &self.color {
                    new_column.style.color = color.clone();
                }

                self.added_column_uuid = new_column.uuid.clone();

                table.data.schema.columns.push(new_column.clone());

                // Store original values and initialize the new column value for all existing records
                for record in &mut table.data.records {
                    let mut record_values = HashMap::new();
                    // Store original value if it exists (shouldn't happen for new columns, but for safety)
                    if let Some(original_value) = record.values.get(&new_column.data_name) {
                        record_values.insert(new_column.data_name.clone(), original_value.clone());
                    }
                    self.original_record_values
                        .insert(record.uuid.clone(), record_values);

                    // Don't set values for new columns - they should remain empty until explicitly set
                }

                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                // Find the column to be removed to get its data_name
                let column_data_name = table
                    .data
                    .schema
                    .columns
                    .iter()
                    .find(|c| c.uuid == self.added_column_uuid)
                    .map(|c| c.data_name.clone());

                // Remove the column from schema
                table
                    .data
                    .schema
                    .columns
                    .retain(|column| column.uuid != self.added_column_uuid);

                // Restore original record values
                if let Some(data_name) = column_data_name {
                    for record in &mut table.data.records {
                        if let Some(original_values) = self.original_record_values.get(&record.uuid)
                        {
                            if let Some(original_value) = original_values.get(&data_name) {
                                // Restore original value
                                record
                                    .values
                                    .insert(data_name.clone(), original_value.clone());
                            } else {
                                // Remove the value if it didn't exist originally
                                record.values.remove(&data_name);
                            }
                        } else {
                            // If no original values stored, remove the column value
                            record.values.remove(&data_name);
                        }
                    }
                }

                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct InsertColumnCommand {
    table_uuid: String,
    column_name: String,
    column_type: ValueType,
    insert_index: usize,
    tooltip: Option<String>,
    color: Option<String>,
    default_value: Option<String>,
    curve_config: Option<crate::types::CurveConfig>,
    added_column_uuid: String,
    original_record_values: HashMap<String, HashMap<String, String>>, // record_uuid -> column_data_name -> old_value
}

impl InsertColumnCommand {
    pub fn new(
        table_uuid: String,
        column_name: &str,
        column_type: ValueType,
        insert_index: usize,
        tooltip: Option<String>,
        color: Option<String>,
        default_value: Option<String>,
    ) -> Self {
        Self {
            table_uuid,
            column_name: column_name.to_string(),
            column_type,
            insert_index,
            tooltip,
            color,
            default_value,
            curve_config: None,
            added_column_uuid: String::new(),
            original_record_values: HashMap::new(),
        }
    }

    pub fn with_curve_config(mut self, config: Option<crate::types::CurveConfig>) -> Self {
        self.curve_config = config;
        self
    }

    pub fn get_column_uuid(&self) -> &str {
        &self.added_column_uuid
    }
}

impl CommandData for InsertColumnCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        if let Some(config) = &self.curve_config {
            if self.column_type != ValueType::Curve
                || !config.start_value.is_finite()
                || !config.end_value.is_finite()
            {
                return Err(DevcelError::Validation(
                    "Invalid curve configuration".into(),
                ));
            }
        }
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let mut new_column = ColumnSchema {
                    read_only: false,
                    uuid: if self.added_column_uuid.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        self.added_column_uuid.clone()
                    },
                    display_name: self.column_name.clone(),
                    data_name: self.column_name.clone(),
                    tooltip: self.tooltip.clone().unwrap_or_default(),
                    data_type: self.column_type.clone(),
                    tags: Vec::new(),
                    default_value: self.default_value.clone().unwrap_or_default(),
                    style: ColumnStyle::new(),
                    memo_text: String::new(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: self.curve_config.clone(),
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                };

                new_column.normalize_color_default()?;

                // Set color if provided
                if let Some(color) = &self.color {
                    new_column.style.color = color.clone();
                }

                self.added_column_uuid = new_column.uuid.clone();

                // Insert column at specified index
                let insert_pos = self.insert_index.min(table.data.schema.columns.len());
                table
                    .data
                    .schema
                    .columns
                    .insert(insert_pos, new_column.clone());

                // Store original values and initialize the new column value for all existing records
                for record in &mut table.data.records {
                    let mut record_values = HashMap::new();
                    // Store original value if it exists (shouldn't happen for new columns, but for safety)
                    if let Some(original_value) = record.values.get(&new_column.data_name) {
                        record_values.insert(new_column.data_name.clone(), original_value.clone());
                    }
                    self.original_record_values
                        .insert(record.uuid.clone(), record_values);

                    // Don't set values for new columns - they should remain empty until explicitly set
                }

                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                // Find the column to be removed to get its data_name
                let column_data_name = table
                    .data
                    .schema
                    .columns
                    .iter()
                    .find(|c| c.uuid == self.added_column_uuid)
                    .map(|c| c.data_name.clone());

                // Remove the column from schema
                table
                    .data
                    .schema
                    .columns
                    .retain(|column| column.uuid != self.added_column_uuid);

                // Restore original record values
                if let Some(data_name) = column_data_name {
                    for record in &mut table.data.records {
                        if let Some(original_values) = self.original_record_values.get(&record.uuid)
                        {
                            if let Some(original_value) = original_values.get(&data_name) {
                                // Restore original value
                                record
                                    .values
                                    .insert(data_name.clone(), original_value.clone());
                            } else {
                                // Remove the value if it didn't exist originally
                                record.values.remove(&data_name);
                            }
                        } else {
                            // If no original values stored, remove the column value
                            record.values.remove(&data_name);
                        }
                    }
                }

                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct RemoveColumnCommand {
    table_uuid: String,
    column_uuid: String,
    removed_column: ColumnSchema,

    removed_memos: HashMap<String, String>,
    removed_record_values: HashMap<String, String>, // record_uuid -> removed_value
}

impl RemoveColumnCommand {
    pub fn new(table_uuid: String, column_uuid: String) -> Self {
        Self {
            table_uuid,
            column_uuid,
            removed_column: ColumnSchema::new(),
            removed_record_values: HashMap::new(),

            removed_memos: HashMap::new(),
        }
    }
}

impl CommandData for RemoveColumnCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        // Interface-origin columns cannot be deleted from the table
        if column_is_interface_owned(_project, &self.table_uuid, &self.column_uuid) {
            return Err(DevcelError::InvalidOperation(
                INTERFACE_COLUMN_LOCKED_MSG.to_string(),
            ));
        }
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                // Store the column and all record values that will be removed
                for column in &table.data.schema.columns {
                    if column.uuid == self.column_uuid {
                        self.removed_column = column.clone();
                        break;
                    }
                }

                // Store all record values for this column (including interface-origin values)
                self.removed_record_values.clear();

                self.removed_memos.clear();
                for record in &table.data.records {
                    if let Some(memo) = record.memo_texts.get(&self.column_uuid) {
                        self.removed_memos.insert(record.uuid.clone(), memo.clone());
                    }
                    if let Some(value) = record.get_cell_value(&self.removed_column) {
                        self.removed_record_values
                            .insert(record.uuid.clone(), value.clone());
                    }
                }

                // Remove column values from all records (delegate storage routing to Record)
                for record in &mut table.data.records {
                    record.remove_cell_value(&self.removed_column);
                    record.memo_texts.remove(&self.column_uuid);
                }

                // Remove column from schema
                table
                    .data
                    .schema
                    .columns
                    .retain(|c| c.uuid != self.column_uuid);
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                // Restore the column to schema
                table.data.schema.columns.push(self.removed_column.clone());

                // Restore all record values for this column (including interface-origin values)
                for record in &mut table.data.records {
                    if let Some(memo) = self.removed_memos.get(&record.uuid) {
                        record
                            .memo_texts
                            .insert(self.column_uuid.clone(), memo.clone());
                    }
                    if let Some(value) = self.removed_record_values.get(&record.uuid) {
                        record.set_cell_value(&self.removed_column, value.clone());
                    }
                }

                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct RenameColumnCommand {
    table_uuid: String,
    column_uuid: String,
    new_name: String,
    old_name: String,
}

impl RenameColumnCommand {
    pub fn new(table_uuid: String, column_uuid: String, new_name: &str) -> Self {
        Self {
            table_uuid,
            column_uuid,
            new_name: new_name.to_string(),
            old_name: String::new(),
        }
    }
}

impl CommandData for RenameColumnCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        // Interface-origin column names belong to the interface and cannot be changed here
        if column_is_interface_owned(_project, &self.table_uuid, &self.column_uuid) {
            return Err(DevcelError::InvalidOperation(
                INTERFACE_COLUMN_LOCKED_MSG.to_string(),
            ));
        }
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                crate::validate_data_name(&self.new_name)?;
                if table.data.schema.columns.iter().any(|column| {
                    column.uuid != self.column_uuid
                        && column.interface_origin.is_none()
                        && column.data_name == self.new_name
                }) {
                    return Err(DevcelError::InvalidOperation(
                        "A local column with this name already exists".into(),
                    ));
                }
                self.old_name = table
                    .data
                    .schema
                    .columns
                    .iter()
                    .find(|c| c.uuid == self.column_uuid)
                    .unwrap()
                    .data_name
                    .clone();

                // Update column schema - both display_name and data_name
                let column = table
                    .data
                    .schema
                    .columns
                    .iter_mut()
                    .find(|c| c.uuid == self.column_uuid)
                    .unwrap();

                column.display_name = self.new_name.clone();
                column.data_name = self.new_name.clone();

                // CRITICAL: Rename all record value keys from old data_name to new data_name
                for record in &mut table.data.records {
                    if let Some(old_value) = record.values.remove(&self.old_name) {
                        record.values.insert(self.new_name.clone(), old_value);
                    }
                }

                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                // Revert column schema - both display_name and data_name
                let column = table
                    .data
                    .schema
                    .columns
                    .iter_mut()
                    .find(|c| c.uuid == self.column_uuid)
                    .unwrap();

                column.display_name = self.old_name.clone();
                column.data_name = self.old_name.clone();

                // CRITICAL: Rename record value keys back from new data_name to old data_name
                for record in &mut table.data.records {
                    if let Some(new_value) = record.values.remove(&self.new_name) {
                        record.values.insert(self.old_name.clone(), new_value);
                    }
                }

                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

/// Move a table column to any position, allowing free reordering of interface-origin
/// and local columns. Each table owns its column order, which reconciliation preserves.
#[derive(Clone)]
pub struct MoveColumnCommand {
    table_uuid: String,
    column_uuid: String,
    new_index: usize,
    old_index: usize,
    moved: bool,
}

impl MoveColumnCommand {
    pub fn new(table_uuid: String, column_uuid: String, new_index: usize) -> Self {
        Self {
            table_uuid,
            column_uuid,
            new_index,
            old_index: 0,
            moved: false,
        }
    }
}

impl CommandData for MoveColumnCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let cols = &mut table.data.schema.columns;
                let from = cols
                    .iter()
                    .position(|c| c.uuid == self.column_uuid)
                    .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;
                // Clamp the insertion position to the element count
                let to = self.new_index.min(cols.len().saturating_sub(1));
                self.old_index = from;
                if from != to {
                    let col = cols.remove(from);
                    cols.insert(to, col);
                    self.moved = true;
                    table.is_dirty = true;
                }
                return Ok(());
            }
        }
        Err(crate::app_error::authoring_error("Table not found"))
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        if !self.moved {
            return Ok(());
        }
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let cols = &mut table.data.schema.columns;
                if let Some(cur) = cols.iter().position(|c| c.uuid == self.column_uuid) {
                    let back = self.old_index.min(cols.len().saturating_sub(1));
                    let col = cols.remove(cur);
                    cols.insert(back, col);
                    table.is_dirty = true;
                }
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct RenameTableDisplayNameCommand {
    table_uuid: String,
    new_name: String,
    old_name: String,
}

impl RenameTableDisplayNameCommand {
    pub fn new(table_uuid: String, new_name: &str) -> Self {
        Self {
            table_uuid,
            new_name: new_name.to_string(),
            old_name: String::new(),
        }
    }
}

impl CommandData for RenameTableDisplayNameCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                self.old_name = table.data.display_name.clone();
                table.data.display_name = self.new_name.clone();
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                table.data.display_name = self.old_name.clone();
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct RenameTableDataNameCommand {
    table_uuid: String,
    new_name: String,
    old_name: String,
}

impl RenameTableDataNameCommand {
    pub fn new(table_uuid: String, new_name: String) -> Self {
        Self {
            table_uuid,
            new_name,
            old_name: String::new(),
        }
    }
}

impl CommandData for RenameTableDataNameCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                self.old_name = table.data.metadata.data_name.clone();
                table.data.metadata.data_name = self.new_name.clone();
                for record in &mut table.data.records {
                    if let Some(old_value) = record.values.remove(&self.old_name) {
                        record.values.insert(self.new_name.clone(), old_value);
                    }
                }

                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                table.data.metadata.data_name = self.old_name.clone();
                for record in &mut table.data.records {
                    if let Some(old_value) = record.values.remove(&self.new_name) {
                        record.values.insert(self.old_name.clone(), old_value);
                    }
                }
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct AddRecordCommand {
    table_uuid: String,
    added_record_uuid: String,
}

impl AddRecordCommand {
    pub fn new(table_uuid: String) -> Self {
        Self {
            table_uuid,
            added_record_uuid: String::new(),
        }
    }

    /// Add a record with a caller-supplied UUID
    /// (For cases where P2P/CLI callers need to know the UUID in advance)
    pub fn with_uuid(table_uuid: String, record_uuid: String) -> Self {
        Self {
            table_uuid,
            added_record_uuid: record_uuid,
        }
    }
}

impl CommandData for AddRecordCommand {
    fn allows_default_record_creation(&self) -> bool {
        true
    }

    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                // Use the supplied UUID, or generate one if absent
                let record_uuid = if self.added_record_uuid.is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    self.added_record_uuid.clone()
                };
                if table.data.records.iter().any(|r| r.uuid == record_uuid) {
                    return Err(DevcelError::Validation("Duplicate row UUID".into()));
                }
                uuid::Uuid::parse_str(&record_uuid)
                    .map_err(|_| DevcelError::Validation("Invalid row UUID".into()))?;
                let new_record = crate::record::Record {
                    uuid: record_uuid,
                    parent_uuid: String::new(),
                    label: String::new(),
                    min_version: 0,
                    tags: Vec::new(),
                    values: HashMap::new(),
                    interface_values: HashMap::new(),
                    memo_texts: HashMap::new(),
                };

                // Do not prepopulate values when creating a record
                // Default values are used as display-time fallbacks

                self.added_record_uuid = new_record.uuid.clone();
                table.data.records.push(new_record);
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                table
                    .data
                    .records
                    .retain(|r| r.uuid != self.added_record_uuid);
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct InsertRecordCommand {
    table_uuid: String,
    index: usize,
    added_record_uuid: String,
}

impl InsertRecordCommand {
    pub fn new(table_uuid: String, index: usize) -> Self {
        Self {
            table_uuid,
            index,
            added_record_uuid: String::new(),
        }
    }
}

impl CommandData for InsertRecordCommand {
    fn allows_default_record_creation(&self) -> bool {
        true
    }

    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let new_record = crate::record::Record {
                    uuid: if self.added_record_uuid.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        self.added_record_uuid.clone()
                    },
                    parent_uuid: String::new(),
                    label: String::new(),
                    min_version: 0,
                    tags: Vec::new(),
                    values: HashMap::new(),
                    interface_values: HashMap::new(),
                    memo_texts: HashMap::new(),
                };

                // Do not prepopulate values when creating a record
                // Default values are used as display-time fallbacks

                self.added_record_uuid = new_record.uuid.clone();

                // Insert at the specified index
                if self.index >= table.data.records.len() {
                    table.data.records.push(new_record);
                } else {
                    table.data.records.insert(self.index, new_record);
                }

                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                table
                    .data
                    .records
                    .retain(|r| r.uuid != self.added_record_uuid);
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct RemoveRecordCommand {
    table_uuid: String,
    record_uuid: String,
    removed_record: crate::record::Record,
    removed_index: usize,
}

impl RemoveRecordCommand {
    pub fn new(table_uuid: String, record_uuid: String) -> Self {
        Self {
            table_uuid,
            record_uuid,
            removed_record: crate::record::Record::new(),
            removed_index: 0,
        }
    }
}

impl CommandData for RemoveRecordCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                // Find the record and its index
                if let Some((index, record)) = table
                    .data
                    .records
                    .iter()
                    .enumerate()
                    .find(|(_, r)| r.uuid == self.record_uuid)
                {
                    self.removed_record = record.clone();
                    self.removed_index = index;
                    table.data.records.remove(index);
                    table.is_dirty = true;
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                // Insert the record back at its original position
                let insert_index = self.removed_index.min(table.data.records.len());
                table
                    .data
                    .records
                    .insert(insert_index, self.removed_record.clone());
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct SetRecordLabelCommand {
    table_uuid: String,
    record_uuid: String,
    new_label: String,
    old_label: String,
}

impl SetRecordLabelCommand {
    pub fn new(table_uuid: String, record_uuid: String, new_label: String) -> Self {
        Self {
            table_uuid,
            record_uuid,
            new_label,
            old_label: String::new(),
        }
    }
}

impl CommandData for SetRecordLabelCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        if self.new_label != record.label && !self.new_label.is_empty() {
                            crate::project_tags::validate_authored_name(&self.new_label)?;
                        }
                        self.old_label = record.label.clone();
                        record.label = self.new_label.clone();
                        table.is_dirty = true;
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        record.label = self.old_label.clone();
                        table.is_dirty = true;
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct SetRecordMemoTextCommand {
    table_uuid: String,
    record_uuid: String,
    column_uuid: String,
    new_memo_text: String,
    old_memo_text: String,
}

impl SetRecordMemoTextCommand {
    pub fn new(
        table_uuid: String,
        record_uuid: String,
        column_uuid: String,
        new_memo_text: String,
    ) -> Self {
        Self {
            table_uuid,
            record_uuid,
            column_uuid,
            new_memo_text,
            old_memo_text: String::new(),
        }
    }
}

impl CommandData for SetRecordMemoTextCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        if record.memo_texts.contains_key(&self.column_uuid) {
                            self.old_memo_text =
                                record.memo_texts.get(&self.column_uuid).unwrap().clone();
                        } else {
                            self.old_memo_text = String::new();
                        }
                        record
                            .memo_texts
                            .insert(self.column_uuid.clone(), self.new_memo_text.clone());
                        break;
                    }
                }
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        if self.old_memo_text.is_empty() {
                            record.memo_texts.remove(&self.column_uuid);
                        } else {
                            record
                                .memo_texts
                                .insert(self.column_uuid.clone(), self.old_memo_text.clone());
                        }
                        break;
                    }
                }
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct SetRecordMinVersionCommand {
    table_uuid: String,
    record_uuid: String,
    new_min_version: u32,
    old_min_version: u32,
}

impl SetRecordMinVersionCommand {
    pub fn new(table_uuid: String, record_uuid: String, new_min_version: u32) -> Self {
        Self {
            table_uuid,
            record_uuid,
            new_min_version,
            old_min_version: 0,
        }
    }
}

impl CommandData for SetRecordMinVersionCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        self.old_min_version = record.min_version;
                        record.min_version = self.new_min_version;
                        table.is_dirty = true;
                        return Ok(());
                    }
                }
            }
        }
        Err(crate::DevcelError::NotFound(format!(
            "Record not found: {}",
            self.record_uuid
        )))
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        record.min_version = self.old_min_version;
                        table.is_dirty = true;
                        return Ok(());
                    }
                }
            }
        }
        Err(crate::DevcelError::NotFound(format!(
            "Record not found: {}",
            self.record_uuid
        )))
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct SetRecordParentUuidCommand {
    table_uuid: String,
    record_uuid: String,
    new_parent_uuid: String,
    old_record: Option<crate::record::Record>,
}
impl SetRecordParentUuidCommand {
    pub fn new(table_uuid: String, record_uuid: String, new_parent_uuid: String) -> Self {
        Self {
            table_uuid,
            record_uuid,
            new_parent_uuid,
            old_record: None,
        }
    }
}
impl CommandData for SetRecordParentUuidCommand {
    fn execute(&mut self, project: &mut Project) -> Result<()> {
        let table = project
            .find_table_by_uuid_mut(&self.table_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?;
        let index = table
            .data
            .records
            .iter()
            .position(|r| r.uuid == self.record_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Record not found"))?;
        if !table.data.metadata.edit_permissions.edit_cells {
            return Err(DevcelError::InvalidOperation(
                "Cell editing is disabled".into(),
            ));
        }
        let previous = table.data.records[index].clone();
        let mut next = previous.clone();
        if self.new_parent_uuid.is_empty() && !previous.parent_uuid.is_empty() {
            let resolver = crate::table::InheritanceResolver::new(&table.data);
            for column in &table.data.schema.columns {
                let input = resolver.input(&previous, column)?;
                next.set_cell_value(column, input.to_owned());
            }
        }
        next.parent_uuid = self.new_parent_uuid.clone();
        table.data.records[index] = next;
        if let Err(error) = table.data.validate_parent_graph() {
            table.data.records[index] = previous;
            return Err(error);
        }
        self.old_record = Some(previous);
        table.is_dirty = true;
        Ok(())
    }
    fn undo(&mut self, project: &mut Project) -> Result<()> {
        let table = project
            .find_table_by_uuid_mut(&self.table_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?;
        let row = table
            .data
            .records
            .iter_mut()
            .find(|r| r.uuid == self.record_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Record not found"))?;
        if let Some(old) = &self.old_record {
            *row = old.clone();
        }
        table.is_dirty = true;
        Ok(())
    }
    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct AddRecordTagCommand {
    table_uuid: String,
    record_uuid: String,
    tag: String,
}

impl AddRecordTagCommand {
    pub fn new(table_uuid: String, record_uuid: String, tag: String) -> Self {
        Self {
            table_uuid,
            record_uuid,
            tag: tag.trim().to_owned(),
        }
    }
}

impl CommandData for AddRecordTagCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        if !record.tags.contains(&self.tag) {
                            record.tags.push(self.tag.clone());
                            table.is_dirty = true;
                        }
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        record.tags.retain(|t| t != &self.tag);
                        table.is_dirty = true;
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct RemoveRecordTagCommand {
    table_uuid: String,
    record_uuid: String,
    tag: String,
}

impl RemoveRecordTagCommand {
    pub fn new(table_uuid: String, record_uuid: String, tag: String) -> Self {
        Self {
            table_uuid,
            record_uuid,
            tag,
        }
    }
}

impl CommandData for RemoveRecordTagCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        record.tags.retain(|t| t != &self.tag);
                        table.is_dirty = true;
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for record in &mut table.data.records {
                    if record.uuid == self.record_uuid {
                        if !record.tags.contains(&self.tag) {
                            record.tags.push(self.tag.clone());
                            table.is_dirty = true;
                        }
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct SetRecordValueCommand {
    table_uuid: String,
    record_uuid: String,
    column_uuid: String,
    new_value: String,
    old_value: Option<String>,
}

impl SetRecordValueCommand {
    pub fn new(
        table_uuid: String,
        record_uuid: String,
        column_uuid: String,
        new_value: String,
    ) -> Self {
        Self {
            table_uuid,
            record_uuid,
            column_uuid,
            new_value,
            old_value: None,
        }
    }
}

impl CommandData for SetRecordValueCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let column = match table
                    .data
                    .schema
                    .columns
                    .iter()
                    .find(|c| c.uuid == self.column_uuid)
                {
                    Some(c) => c,
                    None => {
                        return Err(DevcelError::NotFound(format!(
                            "column not found: {}",
                            self.column_uuid
                        )))
                    }
                };

                crate::edit_controls::require_cell_editable(&table.data, column)?;
                let validated_value = if self.new_value.is_empty() {
                    String::new()
                } else {
                    column.validate_value(&self.new_value)?
                };
                if !validated_value.starts_with('=')
                    && matches!(column.data_type, ValueType::F32 | ValueType::F64)
                    && !validated_value.is_empty()
                    && !validated_value.parse::<f64>().is_ok_and(f64::is_finite)
                {
                    return Err(DevcelError::Validation(
                        "Numeric values must be finite".into(),
                    ));
                }
                let column = column.clone();

                let record = table
                    .data
                    .records
                    .iter_mut()
                    .find(|r| r.uuid == self.record_uuid)
                    .ok_or_else(|| {
                        DevcelError::NotFound(format!("record not found: {}", self.record_uuid))
                    })?;
                self.old_value = record.get_cell_value(&column).cloned();

                record.set_cell_value(&column, validated_value);
                table.is_dirty = true;
                return Ok(());
            }
        }
        Err(DevcelError::NotFound(format!(
            "table not found: {}",
            self.table_uuid
        )))
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                // Get the column for interface-aware storage routing
                let column = table
                    .data
                    .schema
                    .columns
                    .iter()
                    .find(|c| c.uuid == self.column_uuid)
                    .cloned();

                if let Some(column) = column {
                    for record in &mut table.data.records {
                        if record.uuid == self.record_uuid {
                            // Remove empty values, otherwise restore them (delegate storage routing to Record)
                            if let Some(value) = &self.old_value {
                                record.set_cell_value(&column, value.clone());
                            } else {
                                record.remove_cell_value(&column);
                            }
                            break;
                        }
                    }
                }
                table.is_dirty = true;
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct SetColumnColorCommand {
    table_uuid: String,
    column_uuid: String,
    new_color: String,
    old_color: String,
}

impl SetColumnColorCommand {
    pub fn new(table_uuid: String, column_uuid: String, new_color: String) -> Self {
        Self {
            table_uuid,
            column_uuid,
            new_color,
            old_color: String::new(),
        }
    }
}

impl CommandData for SetColumnColorCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for column in &mut table.data.schema.columns {
                    if column.uuid == self.column_uuid {
                        self.old_color = column.style.color.clone();
                        column.style.color = self.new_color.clone();
                        table.is_dirty = true;
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                for column in &mut table.data.schema.columns {
                    if column.uuid == self.column_uuid {
                        column.style.color = self.old_color.clone();
                        table.is_dirty = true;
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct SetColumnTooltipCommand {
    table_uuid: String,
    column_uuid: String,
    new_tooltip: String,
    old_tooltip: String,
}

impl SetColumnTooltipCommand {
    pub fn new(table_uuid: String, column_uuid: String, new_tooltip: String) -> Self {
        Self {
            table_uuid,
            column_uuid,
            new_tooltip,
            old_tooltip: String::new(),
        }
    }
}

impl CommandData for SetColumnTooltipCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let column = table
                    .data
                    .schema
                    .columns
                    .iter_mut()
                    .find(|c| c.uuid == self.column_uuid)
                    .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;

                self.old_tooltip = column.tooltip.clone();
                column.tooltip = self.new_tooltip.clone();
                table.is_dirty = true;
                return Ok(());
            }
        }
        Err(crate::app_error::authoring_error("Table not found"))
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let column = table
                    .data
                    .schema
                    .columns
                    .iter_mut()
                    .find(|c| c.uuid == self.column_uuid)
                    .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;

                column.tooltip = self.old_tooltip.clone();
                table.is_dirty = true;
                return Ok(());
            }
        }
        Err(crate::app_error::authoring_error("Table not found"))
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct SetColumnMemoTextCommand {
    table_uuid: String,
    column_uuid: String,
    new_memo_text: String,
    old_memo_text: String,
}

impl SetColumnMemoTextCommand {
    pub fn new(table_uuid: String, column_uuid: String, new_memo_text: String) -> Self {
        Self {
            table_uuid,
            column_uuid,
            new_memo_text,
            old_memo_text: String::new(),
        }
    }
}

impl CommandData for SetColumnMemoTextCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let column = table
                    .data
                    .schema
                    .columns
                    .iter_mut()
                    .find(|c| c.uuid == self.column_uuid)
                    .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;

                self.old_memo_text = column.memo_text.clone();
                column.memo_text = self.new_memo_text.clone();
                table.is_dirty = true;
                return Ok(());
            }
        }
        Err(crate::app_error::authoring_error("Table not found"))
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let column = table
                    .data
                    .schema
                    .columns
                    .iter_mut()
                    .find(|c| c.uuid == self.column_uuid)
                    .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;

                column.memo_text = self.old_memo_text.clone();
                table.is_dirty = true;
                return Ok(());
            }
        }
        Err(crate::app_error::authoring_error("Table not found"))
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

#[derive(Clone)]
pub struct SetColumnDefaultValueCommand {
    table_uuid: String,
    column_uuid: String,
    new_default_value: String,
    old_default_value: String,
}

impl SetColumnDefaultValueCommand {
    pub fn new(table_uuid: String, column_uuid: String, new_default_value: String) -> Self {
        Self {
            table_uuid,
            column_uuid,
            new_default_value,
            old_default_value: String::new(),
        }
    }
}

impl CommandData for SetColumnDefaultValueCommand {
    fn execute(&mut self, _project: &mut Project) -> Result<()> {
        // Interface-origin column defaults belong to the interface and cannot be changed here
        if column_is_interface_owned(_project, &self.table_uuid, &self.column_uuid) {
            return Err(DevcelError::InvalidOperation(
                INTERFACE_COLUMN_LOCKED_MSG.to_string(),
            ));
        }
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let column = table
                    .data
                    .schema
                    .columns
                    .iter_mut()
                    .find(|c| c.uuid == self.column_uuid)
                    .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;

                // Validate the new default value against the column type
                let validated_value =
                    if self.new_default_value.is_empty() && column.data_type.is_color() {
                        column.data_type.default_value()
                    } else {
                        column.validate_value(&self.new_default_value)?
                    };

                self.old_default_value = column.default_value.clone();
                column.default_value = validated_value;
                table.is_dirty = true;
                return Ok(());
            }
        }
        Err(crate::app_error::authoring_error("Table not found"))
    }

    fn undo(&mut self, _project: &mut Project) -> Result<()> {
        for table in _project.tables_data.values_mut() {
            if table.data.uuid == self.table_uuid {
                let column = table
                    .data
                    .schema
                    .columns
                    .iter_mut()
                    .find(|c| c.uuid == self.column_uuid)
                    .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;

                column.default_value = self.old_default_value.clone();
                table.is_dirty = true;
                return Ok(());
            }
        }
        Err(crate::app_error::authoring_error("Table not found"))
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

// Transaction command: execute multiple commands together, including grouped undo/redo
#[derive(Clone)]
pub struct TransactionCommand {
    commands: Vec<Arc<Mutex<dyn CommandData>>>,
    pub description: String, // Transaction description
}

impl TransactionCommand {
    pub fn new(description: String) -> Self {
        Self {
            commands: Vec::new(),
            description,
        }
    }

    pub fn add_command(&mut self, command: Arc<Mutex<dyn CommandData>>) {
        self.commands.push(command);
    }

    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    pub fn len(&self) -> usize {
        self.commands.len()
    }
}

impl CommandData for TransactionCommand {
    fn affected_tables(&self, project: &Project) -> Vec<String> {
        let mut targets: Vec<_> = self
            .commands
            .iter()
            .flat_map(|command| command.lock().unwrap().affected_tables(project))
            .collect();
        targets.sort();
        targets.dedup();
        targets
    }

    fn execute(&mut self, project: &mut Project) -> Result<()> {
        // Keep exact table state, including dirty flags and history. Undo alone
        // may not restore absent values or partially modified failing commands.
        let original_tables = project.tables_data.clone();
        for command in &self.commands {
            if let Err(error) = command.lock().unwrap().execute(project) {
                project.tables_data = original_tables;
                return Err(error);
            }
        }
        Ok(())
    }

    fn undo(&mut self, project: &mut Project) -> Result<()> {
        let original_tables = project.tables_data.clone();
        for command in self.commands.iter().rev() {
            if let Err(error) = command.lock().unwrap().undo(project) {
                project.tables_data = original_tables;
                return Err(error);
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        let uuids = self.get_table_uuids();
        if uuids.len() == 1 {
            uuids[0].clone()
        } else {
            String::new()
        }
    }

    fn get_table_uuids(&self) -> Vec<String> {
        let mut uuids: Vec<_> = self
            .commands
            .iter()
            .flat_map(|command| command.lock().unwrap().get_table_uuids())
            .collect();
        uuids.sort();
        uuids.dedup();
        uuids
    }

    fn save_priority(&self) -> SavePriority {
        SavePriority::High // Save transactions with high priority
    }
}

// === Interface-related commands ===

/// Create-interface command
#[derive(Clone)]
pub struct CreateInterfaceCommand {
    pub name: String,
    pub description: Option<String>,
    pub interface_uuid: Option<uuid::Uuid>,
}

impl CreateInterfaceCommand {
    pub fn new(name: String, description: Option<String>) -> Self {
        Self {
            name,
            description,
            interface_uuid: None,
        }
    }
}

impl CommandData for CreateInterfaceCommand {
    fn execute(&mut self, project: &mut Project) -> Result<()> {
        let interface =
            crate::interface::Interface::new(self.name.clone(), self.description.clone());
        self.interface_uuid = Some(interface.uuid);
        project.add_interface(interface)?;

        // Save the interface
        if let Some(uuid) = self.interface_uuid {
            if let Some(interface) = project.get_interface(&uuid) {
                project.save_interface(interface)?;
            }
        }

        Ok(())
    }

    fn undo(&mut self, project: &mut Project) -> Result<()> {
        if let Some(uuid) = self.interface_uuid {
            project.remove_interface(&uuid)?;
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        // Interface commands are not associated with a table
        String::new()
    }
}

/// Command to apply an interface to a table
#[derive(Clone)]
pub struct ApplyInterfaceCommand {
    pub table_path: std::path::PathBuf,
    pub interface_uuid: uuid::Uuid,
    pub auto_add_columns: bool,
    pub old_implementations: Option<HashMap<uuid::Uuid, crate::interface::InterfaceImplementation>>,
}

impl ApplyInterfaceCommand {
    pub fn new(
        table_path: std::path::PathBuf,
        interface_uuid: uuid::Uuid,
        auto_add_columns: bool,
    ) -> Self {
        Self {
            table_path,
            interface_uuid,
            auto_add_columns,
            old_implementations: None,
        }
    }
}

impl CommandData for ApplyInterfaceCommand {
    fn affected_tables(&self, project: &Project) -> Vec<String> {
        project
            .tables_data
            .get(&self.table_path)
            .map(|t| vec![t.data.uuid.clone()])
            .unwrap_or_default()
    }

    fn execute(&mut self, project: &mut Project) -> Result<()> {
        // Save the current implementation state
        if let Some(table) = project.tables_data.get(&self.table_path) {
            self.old_implementations = Some(table.data.interface_implementations.clone());
        }

        // Get the interface
        let interface = project
            .interface_registry
            .get_interface(&self.interface_uuid)
            .ok_or_else(|| {
                DevcelError::NotFound(format!("Interface not found: {}", self.interface_uuid))
            })?
            .clone();

        // Get the table and apply the interface
        let table = project
            .tables_data
            .get_mut(&self.table_path)
            .ok_or_else(|| {
                DevcelError::NotFound(format!("Table not found: {}", self.table_path.display()))
            })?;

        // Apply from the current version
        table.apply_interface(
            &interface,
            &project.interface_registry,
            self.auto_add_columns,
        )?;

        // Mark the table dirty to indicate it needs saving
        if let Some(table) = project.tables_data.get_mut(&self.table_path) {
            table.mark_dirty();
        }

        Ok(())
    }

    fn undo(&mut self, project: &mut Project) -> Result<()> {
        if let Some(table) = project.tables_data.get_mut(&self.table_path) {
            // Remove the interface implementation
            table.remove_interface(&self.interface_uuid)?;

            // Restore the previous implementation state
            if let Some(old_impls) = &self.old_implementations {
                table.data.interface_implementations = old_impls.clone();
            }
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        // Implement if table UUID lookup from the path is needed
        String::new()
    }
}

/// Keep exact before/after state so undo/redo preserves version and column IDs.
#[derive(Clone, Default)]
struct InterfaceEditState {
    before: Option<crate::interface::Interface>,
    after: Option<crate::interface::Interface>,
    acknowledgements: std::collections::BTreeMap<String, String>,
}

impl InterfaceEditState {
    fn execute(
        &mut self,
        project: &mut Project,
        uuid: uuid::Uuid,
        edit: impl FnOnce(&mut crate::interface::Interface) -> Result<()>,
    ) -> Result<()> {
        if self.after.is_some() {
            return self.restore(project, uuid, true);
        }
        let before = project
            .get_interface(&uuid)
            .cloned()
            .ok_or_else(|| DevcelError::NotFound(format!("Interface {uuid} not found")))?;
        let mut after = before.clone();
        edit(&mut after)?;
        crate::column_editor::validate_interface_update(project, &after, &self.acknowledgements)?;
        Self::save_state(project, &after)?;
        self.before = Some(before);
        self.after = Some(after);
        Ok(())
    }

    fn restore(&self, project: &mut Project, uuid: uuid::Uuid, redo: bool) -> Result<()> {
        let (expected, target) = if redo {
            (&self.before, &self.after)
        } else {
            (&self.after, &self.before)
        };
        let expected = expected.as_ref().ok_or_else(|| {
            DevcelError::InvalidOperation("No interface edit history is available".into())
        })?;
        let mut target = target.clone().ok_or_else(|| {
            DevcelError::InvalidOperation("No interface edit history is available".into())
        })?;
        let current = project
            .get_interface(&uuid)
            .ok_or_else(|| DevcelError::NotFound(format!("Interface {uuid} not found")))?;
        if current.current_version_id != expected.current_version_id {
            return Err(DevcelError::InvalidOperation(
                "The interface was updated by another operation. Reload the data".into(),
            ));
        }
        // Preserve saved branches/imported history and unrelated file/name changes.
        target.history.extend(current.history.clone());
        target.name = current.name.clone();
        target.rebuild_current_columns()?;
        // History restores an approved definition, but current table protection
        // still applies to its projected synchronization, including unloaded tables.
        // Do not request a second input-rule acknowledgement for historical values.
        for (before, after) in
            crate::column_editor::interface_transition_candidates(project, &target)?
        {
            crate::edit_controls::validate_transition(&before, &after, false)?;
        }
        Self::save_state(project, &target)
    }

    fn save_state(project: &mut Project, target: &crate::interface::Interface) -> Result<()> {
        for column in &target.columns {
            crate::cell_rules::validate_column_definition(column)?;
        }
        let current = project
            .get_interface_mut(&target.uuid)
            .ok_or_else(|| DevcelError::NotFound(format!("Interface {} not found", target.uuid)))?;
        let previous = std::mem::replace(current, target.clone());
        if let Err(error) = project.save_interface_if_unchanged(target, &previous) {
            *project.get_interface_mut(&target.uuid).unwrap() = previous;
            return Err(error);
        }
        Ok(())
    }
}

/// Update-interface command
#[derive(Clone)]
pub struct UpdateInterfaceCommand {
    pub interface_uuid: uuid::Uuid,
    state: InterfaceEditState,
    pub changes: Vec<crate::interface::InterfaceChange>,
    pub author: Option<String>,
    pub comment: Option<String>,
    pub previous_version_id: Option<uuid::Uuid>,
}

impl UpdateInterfaceCommand {
    pub fn with_validation_acknowledgements(
        mut self,
        acknowledgements: std::collections::BTreeMap<String, String>,
    ) -> Self {
        self.state.acknowledgements = acknowledgements;
        self
    }

    pub fn new(
        interface_uuid: uuid::Uuid,
        changes: Vec<crate::interface::InterfaceChange>,
        author: Option<String>,
        comment: Option<String>,
    ) -> Self {
        Self {
            interface_uuid,
            state: InterfaceEditState::default(),
            changes,
            author,
            comment,
            previous_version_id: None,
        }
    }
}

impl CommandData for UpdateInterfaceCommand {
    fn execute(&mut self, project: &mut Project) -> Result<()> {
        self.state
            .execute(project, self.interface_uuid, |interface| {
                interface
                    .create_new_version(
                        self.changes.clone(),
                        self.author.clone(),
                        self.comment.clone(),
                    )
                    .map(|_| ())
            })?;
        self.previous_version_id = self
            .state
            .before
            .as_ref()
            .map(|interface| interface.current_version_id);
        Ok(())
    }

    fn undo(&mut self, project: &mut Project) -> Result<()> {
        self.state.restore(project, self.interface_uuid, false)
    }

    fn get_table_uuid(&self) -> String {
        String::new()
    }

    fn get_interface_uuid(&self) -> Option<uuid::Uuid> {
        Some(self.interface_uuid)
    }

    // The interface write and its notification are already performed atomically
    // with the in-memory change. No unrelated project/table save is needed.
    fn should_save(&self) -> bool {
        false
    }
}

/// Command to restore an interface's content from a previous version
/// Append a new version restoring the content instead of rewinding HEAD
#[derive(Clone)]
pub struct RevertInterfaceCommand {
    pub interface_uuid: uuid::Uuid,
    state: InterfaceEditState,
    pub target_version: uuid::Uuid,
    pub author: Option<String>,
    pub previous_version_id: Option<uuid::Uuid>,
    pub created_version_id: Option<uuid::Uuid>,
}

impl RevertInterfaceCommand {
    pub fn new(
        interface_uuid: uuid::Uuid,
        target_version: uuid::Uuid,
        author: Option<String>,
    ) -> Self {
        Self {
            interface_uuid,
            state: InterfaceEditState::default(),
            target_version,
            author,
            previous_version_id: None,
            created_version_id: None,
        }
    }
}

impl CommandData for RevertInterfaceCommand {
    fn execute(&mut self, project: &mut Project) -> Result<()> {
        self.state
            .execute(project, self.interface_uuid, |interface| {
                interface
                    .revert_to_version(self.target_version, self.author.clone(), None)
                    .map(|_| ())
            })?;
        self.previous_version_id = self
            .state
            .before
            .as_ref()
            .map(|interface| interface.current_version_id);
        self.created_version_id = self
            .state
            .after
            .as_ref()
            .map(|interface| interface.current_version_id);
        Ok(())
    }

    fn undo(&mut self, project: &mut Project) -> Result<()> {
        self.state.restore(project, self.interface_uuid, false)
    }

    fn get_table_uuid(&self) -> String {
        String::new()
    }

    fn get_interface_uuid(&self) -> Option<uuid::Uuid> {
        Some(self.interface_uuid)
    }

    // The interface write and its notification are already performed atomically
    // with the in-memory change. No unrelated project/table save is needed.
    fn should_save(&self) -> bool {
        false
    }
}

/// Command to merge divergent interface histories
#[derive(Clone)]
pub struct MergeInterfaceCommand {
    pub interface_uuid: uuid::Uuid,
    state: InterfaceEditState,
    pub ours_version: uuid::Uuid,
    pub theirs_version: uuid::Uuid,
    pub resolutions: std::collections::HashMap<String, crate::interface::ResolutionType>,
    pub author: Option<String>,
    pub comment: Option<String>,
    pub previous_version_id: Option<uuid::Uuid>,
    pub created_merge_id: Option<uuid::Uuid>,
}

impl MergeInterfaceCommand {
    pub fn new(
        interface_uuid: uuid::Uuid,
        ours_version: uuid::Uuid,
        theirs_version: uuid::Uuid,
        resolutions: std::collections::HashMap<String, crate::interface::ResolutionType>,
        author: Option<String>,
        comment: Option<String>,
    ) -> Self {
        Self {
            interface_uuid,
            state: InterfaceEditState::default(),
            ours_version,
            theirs_version,
            resolutions,
            author,
            comment,
            previous_version_id: None,
            created_merge_id: None,
        }
    }
}

impl CommandData for MergeInterfaceCommand {
    fn execute(&mut self, project: &mut Project) -> Result<()> {
        self.state
            .execute(project, self.interface_uuid, |interface| {
                interface
                    .merge_branches(
                        self.ours_version,
                        self.theirs_version,
                        &self.resolutions,
                        self.author.clone(),
                        self.comment.clone(),
                    )
                    .map(|_| ())
            })?;
        self.previous_version_id = self
            .state
            .before
            .as_ref()
            .map(|interface| interface.current_version_id);
        self.created_merge_id = self
            .state
            .after
            .as_ref()
            .map(|interface| interface.current_version_id);
        Ok(())
    }

    fn undo(&mut self, project: &mut Project) -> Result<()> {
        self.state.restore(project, self.interface_uuid, false)
    }

    fn get_table_uuid(&self) -> String {
        String::new()
    }

    fn get_interface_uuid(&self) -> Option<uuid::Uuid> {
        Some(self.interface_uuid)
    }

    // The interface write and its notification are already performed atomically
    // with the in-memory change. No unrelated project/table save is needed.
    fn should_save(&self) -> bool {
        false
    }
}

/// Add or update a column's reference configuration
pub fn set_column_reference_config(
    project: &mut Project,
    table_uuid: &str,
    column_uuid: &str,
    config: ReferenceConfig,
) -> Result<()> {
    set_column_reference_config_with_save_queue(project, table_uuid, column_uuid, config, None)
}

pub fn set_column_reference_config_with_save_queue(
    project: &mut Project,
    table_uuid: &str,
    column_uuid: &str,
    config: ReferenceConfig,
    queue: Option<&Arc<crate::file_save_queue::FileBasedSaveQueueManager>>,
) -> Result<()> {
    project.ensure_table_loaded_by_uuid(table_uuid)?;
    if column_is_interface_owned(project, table_uuid, column_uuid) {
        return Err(DevcelError::InvalidOperation(
            INTERFACE_COLUMN_LOCKED_MSG.into(),
        ));
    }
    let target = project
        .get_table_catalog_data()?
        .into_iter()
        .find(|table| table.uuid == config.target_table_uuid)
        .ok_or_else(|| DevcelError::NotFound("Target table not found".into()))?;
    if config
        .display_column_uuid
        .as_ref()
        .is_some_and(|id| !target.schema.columns.iter().any(|c| &c.uuid == id))
    {
        return Err(DevcelError::NotFound("Display column not found".into()));
    }
    let mut candidate = project
        .find_table_by_uuid(table_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?
        .data
        .clone();
    let column = candidate
        .schema
        .columns
        .iter_mut()
        .find(|c| c.uuid == column_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;
    column.data_type = ValueType::Reference;
    column.reference_config = Some(config);
    column.table_ref_config = None;
    column.curve_config = None;
    column.select_config = None;
    crate::table_mutation::commit_candidate(project, table_uuid, candidate, None, queue)
}

/// Add or update a column's table-reference configuration.
/// Change the column type to TableRef and set the interface required of referenced tables.
pub fn set_column_table_ref_config(
    project: &mut Project,
    table_uuid: &str,
    column_uuid: &str,
    interface_uuid: &str,
) -> Result<()> {
    project.execute_command(
        crate::column_config::SetColumnConfigCommand::new(
            table_uuid.into(),
            column_uuid.into(),
            crate::column_config::Configuration::TableRef(crate::TableRefConfig {
                interface_uuid: interface_uuid.into(),
            }),
        ),
        None,
    )
}

/// Change the column type to Curve and set fixed y values for its endpoints.
pub fn set_column_curve_config(
    project: &mut Project,
    table_uuid: &str,
    column_uuid: &str,
    start_value: f64,
    end_value: f64,
) -> Result<()> {
    project
        .execute_command(
            SetColumnCurveConfigCommand {
                table_uuid: table_uuid.into(),
                column_uuid: column_uuid.into(),
                config: crate::types::CurveConfig {
                    start_value,
                    end_value,
                },
                old: None,
            },
            None,
        )
        .map(|_| ())
}

#[derive(Clone)]
pub struct SetColumnCurveConfigCommand {
    table_uuid: String,
    column_uuid: String,
    config: crate::types::CurveConfig,
    old: Option<(ValueType, Option<crate::types::CurveConfig>)>,
}
impl CommandData for SetColumnCurveConfigCommand {
    fn execute(&mut self, project: &mut Project) -> Result<()> {
        if !self.config.start_value.is_finite() || !self.config.end_value.is_finite() {
            return Err(DevcelError::Validation(
                "Curve start and end values must be finite numbers".into(),
            ));
        }
        if column_is_interface_owned(project, &self.table_uuid, &self.column_uuid) {
            return Err(DevcelError::InvalidOperation(
                INTERFACE_COLUMN_LOCKED_MSG.into(),
            ));
        }
        let table = project
            .find_table_by_uuid_mut(&self.table_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?;
        let column = table
            .data
            .schema
            .columns
            .iter_mut()
            .find(|c| c.uuid == self.column_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;
        self.old = Some((column.data_type.clone(), column.curve_config.clone()));
        column.data_type = ValueType::Curve;
        column.curve_config = Some(self.config.clone());
        table.is_dirty = true;
        Ok(())
    }
    fn undo(&mut self, project: &mut Project) -> Result<()> {
        let table = project
            .find_table_by_uuid_mut(&self.table_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?;
        let column = table
            .data
            .schema
            .columns
            .iter_mut()
            .find(|c| c.uuid == self.column_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;
        if let Some((kind, config)) = &self.old {
            column.data_type = kind.clone();
            column.curve_config = config.clone();
            table.is_dirty = true;
        }
        Ok(())
    }
    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

/// Remove a column's reference configuration
pub fn remove_column_reference_config(
    project: &mut Project,
    table_uuid: &str,
    column_uuid: &str,
) -> Result<()> {
    remove_column_reference_config_with_save_queue(project, table_uuid, column_uuid, None)
}

pub fn remove_column_reference_config_with_save_queue(
    project: &mut Project,
    table_uuid: &str,
    column_uuid: &str,
    queue: Option<&Arc<crate::file_save_queue::FileBasedSaveQueueManager>>,
) -> Result<()> {
    project.ensure_table_loaded_by_uuid(table_uuid)?;
    if column_is_interface_owned(project, table_uuid, column_uuid) {
        return Err(DevcelError::InvalidOperation(
            INTERFACE_COLUMN_LOCKED_MSG.into(),
        ));
    }
    let mut candidate = project
        .find_table_by_uuid(table_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?
        .data
        .clone();
    let column = candidate
        .schema
        .columns
        .iter_mut()
        .find(|c| c.uuid == column_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;
    column.reference_config = None;
    if column.data_type == ValueType::Reference {
        column.data_type = ValueType::String;
    }
    crate::table_mutation::commit_candidate(project, table_uuid, candidate, None, queue)
}

/// Get the options for a reference column
pub fn get_reference_options(
    project: &mut Project,
    table_uuid: &str,
    column_uuid: &str,
) -> Result<Vec<ReferenceOption>> {
    eprintln!(
        "get_reference_options called with table_uuid={table_uuid}, column_uuid={column_uuid}"
    );

    project.ensure_table_loaded_by_uuid(table_uuid)?;
    let table = project
        .find_table_by_uuid(table_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?;

    eprintln!("Found table: {}", table.data.display_name);

    let column = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.uuid == column_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;

    eprintln!(
        "Found column: {} with config: {:?}",
        column.display_name, column.reference_config
    );

    let config = column
        .reference_config
        .as_ref()
        .ok_or_else(|| DevcelError::Validation("Column is not a reference type".to_string()))?
        .clone();

    eprintln!(
        "Reference config target_table_uuid: {}",
        config.target_table_uuid
    );

    project.ensure_table_loaded_by_uuid(&config.target_table_uuid)?;
    let target_table = project
        .find_table_by_uuid(&config.target_table_uuid)
        .ok_or_else(|| DevcelError::NotFound("Target table not found".to_string()))?;

    eprintln!(
        "Found target table: {} (uuid: {})",
        target_table.data.display_name, target_table.data.uuid
    );

    // Determine the display column
    // Determine display column
    let display_column = if let Some(ref display_col_uuid) = config.display_column_uuid {
        target_table
            .data
            .schema
            .columns
            .iter()
            .find(|c| c.uuid == *display_col_uuid)
    } else {
        // No display column when display_column_uuid is null
        // If display_column_uuid is null, no display column
        None
    };

    // Build the options list
    // Create option list
    let context = crate::formula_context::ProjectFormulaContext::new(project, None)?;
    let resolver = crate::table::InheritanceResolver::new(&target_table.data);
    let mut options = Vec::new();
    for (index, record) in target_table.data.records.iter().enumerate() {
        // Prepare a label or row number
        // Prepare label or row number
        let label = if !record.label.is_empty() {
            record.label.clone()
        } else {
            (index + 1).to_string()
        };

        let display_value = if let Some(col) = display_column {
            let value = display_cell_value(&context, &target_table.data, record, col, &resolver);
            format!("{label}: {value}")
        } else {
            // Otherwise use the label alone, without a colon
            // If no display column specified, show label only (without colon)
            label
        };

        options.push(ReferenceOption {
            uuid: record.uuid.clone(),
            display_value,
        });
    }

    Ok(options)
}

/// Check referential integrity
pub fn check_reference_integrity(
    project: &mut Project,
    table_uuid: &str,
    record_uuid: &str,
) -> Result<crate::types::ReferenceIntegrityCheck> {
    use crate::types::{DeleteImpact, ReferencingRecord};

    project.ensure_referencing_tables_loaded(table_uuid)?;
    let context = crate::formula_context::ProjectFormulaContext::new(project, None)?;
    let mut referencing_records = Vec::new();
    let mut delete_impact = DeleteImpact {
        affected_record_count: 0,
        restrict_count: 0,
    };

    // Read only referencing tables from the catalog, including tables not currently displayed.
    // Referencing tables are loaded on demand; unrelated records stay unloaded.
    for table in project.iter_tables() {
        let mut resolver = None;
        for column in &table.data.schema.columns {
            if let Some(ref config) = column.reference_config {
                if config.target_table_uuid == table_uuid {
                    // This column references the target table
                    // This column references the target table
                    let resolver = resolver
                        .get_or_insert_with(|| crate::table::InheritanceResolver::new(&table.data));
                    for record in &table.data.records {
                        if table.data.uuid == table_uuid && record.uuid == record_uuid {
                            continue;
                        }
                        {
                            let value = crate::reference_integrity::reference_value(
                                &context,
                                &table.data,
                                column,
                                record,
                                resolver,
                            )?;
                            if value == record_uuid {
                                // Reference found
                                // Found a reference
                                let display_value =
                                    get_record_display_value(&context, table, record, resolver);

                                referencing_records.push(ReferencingRecord {
                                    table_uuid: table.data.uuid.clone(),
                                    table_name: table.data.display_name.clone(),
                                    record_uuid: record.uuid.clone(),
                                    record_display_value: display_value,
                                    column_uuid: column.uuid.clone(),
                                    column_name: column.display_name.clone(),
                                    on_delete_action: crate::types::ReferenceOnDelete::Restrict,
                                });

                                delete_impact.affected_record_count += 1;
                                // Surviving references prevent deletion
                                delete_impact.restrict_count += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    let has_children = project.find_table_by_uuid(table_uuid).is_some_and(|table| {
        table
            .data
            .records
            .iter()
            .any(|record| record.uuid != record_uuid && record.parent_uuid == record_uuid)
    });
    let can_delete = delete_impact.restrict_count == 0 && !has_children;

    Ok(crate::types::ReferenceIntegrityCheck {
        record_uuid: record_uuid.to_string(),
        referencing_records,
        can_delete,
        delete_impact,
    })
}

// Helper functions
// Helper function
fn get_record_display_value<'a>(
    context: &crate::formula_context::ProjectFormulaContext<'_>,
    table: &'a crate::table::Table,
    record: &'a crate::record::Record,
    resolver: &crate::table::InheritanceResolver<'a>,
) -> String {
    for column in &table.data.schema.columns {
        if matches!(column.data_type, ValueType::String) {
            return display_cell_value(context, &table.data, record, column, resolver);
        }
    }
    record.uuid.clone()
}

fn display_cell_value<'a>(
    context: &crate::formula_context::ProjectFormulaContext<'_>,
    data: &'a crate::table::TableData,
    record: &'a crate::record::Record,
    column: &'a crate::column::ColumnSchema,
    resolver: &crate::table::InheritanceResolver<'a>,
) -> String {
    let input = match resolver.input(record, column) {
        Ok(input) => input,
        Err(error) => return format!("#ERROR: {error}"),
    };
    if input.starts_with('=') {
        match context.evaluate_cell_with_override(data, column, record, input) {
            crate::types::FormulaResult::Value(value) => value,
            crate::types::FormulaResult::Error(error) => format!("#ERROR: {error:?}"),
        }
    } else {
        input.to_owned()
    }
}
