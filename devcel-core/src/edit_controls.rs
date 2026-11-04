//! Persisted authoring protections shared by Studio, CLI, plugins and history.
//! These prevent accidental edits; their explicit settings APIs remain available.
use crate::file_save_queue::FileBasedSaveQueueManager;
use crate::table_mutation::{MutationResult, ReplaceTableCommand};
use crate::{ColumnSchema, DevcelError, Project, Result, TableData, TableEditPermissions};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

pub const USER_SETTINGS_UUID: &str = "6a6882ac-5a9a-51fc-b1d3-3ba3169b3a6e";

/// Fixed application bindings are editable values, not a resizable data collection.
pub fn is_user_settings(data: &TableData) -> bool {
    data.uuid == USER_SETTINGS_UUID
}

/// Registration is maintained by the atomic package transaction, not cell editing.
fn is_resource_registration(data: &TableData) -> bool {
    data.uuid == "682923bd-8e8d-55b6-a9dd-f628431954bd"
        || data
            .interface_implementations
            .keys()
            .any(|id| id.to_string() == "3af00752-cf43-4a47-9f8a-1a3e8f338fbd")
}

/// Application-owned schemas expose editable data, not arbitrary bindings.
fn has_fixed_settings_schema(data: &TableData) -> bool {
    matches!(
        data.uuid.as_str(),
        USER_SETTINGS_UUID
            | "2fdd9cf8-ce1e-5de8-92c5-a98c68c30420"
            | "cedb6021-fd4a-5954-96af-30081ed0dd39"
            | "682923bd-8e8d-55b6-a9dd-f628431954bd"
            | "0de0da47-cf7c-5dce-b945-b6583fec0148"
            | "b7b25d20-7d0c-56e9-a47e-142a84f59d9c"
            | "f5d2cb66-255e-5290-b774-4c423e921938"
    )
}
fn fixed_column_contract(column: &ColumnSchema) -> serde_json::Value {
    serde_json::json!({"name":column.data_name, "type":column.data_type,
        "reference":column.reference_config, "tableRef":column.table_ref_config,
        "choices":column.select_config.as_ref().map(|c| c.options.iter().map(|o| &o.value).collect::<Vec<_>>())})
}

/// Read-time, lossless upgrade for pre-protection settings files. Only authoring
/// metadata changes; all rows, cells, UUIDs and custom display names are retained.
/// Once protected, an explicitly saved orientation remains the user's choice.
pub(crate) fn normalize_settings_metadata(data: &mut TableData) {
    if is_resource_registration(data) {
        data.metadata.edit_permissions = TableEditPermissions {
            add_columns: false,
            delete_columns: false,
            add_rows: false,
            delete_rows: false,
            edit_cells: false,
        };
    }
    if is_user_settings(data) {
        if data.metadata.edit_permissions == TableEditPermissions::default() {
            data.metadata.initial_transposed = true;
        }
        data.metadata.edit_permissions.add_rows = false;
        data.metadata.edit_permissions.delete_rows = false;
    }
    if has_fixed_settings_schema(data) {
        data.metadata.edit_permissions.add_columns = false;
        data.metadata.edit_permissions.delete_columns = false;
    }
}

pub const ADD_COLUMNS_DISABLED: &str = "Columns cannot be added to this table";
pub const DELETE_COLUMNS_DISABLED: &str = "Columns cannot be deleted from this table";
pub const ADD_ROWS_DISABLED: &str = "Rows cannot be added to this table";
pub const DELETE_ROWS_DISABLED: &str = "Rows cannot be deleted from this table";
pub const EDIT_CELLS_DISABLED: &str = "Cells cannot be edited in this table";
pub const COLUMN_READ_ONLY: &str = "This column is write-protected";
const SETTINGS_API_REQUIRED: &str =
    "Change edit restrictions through the dedicated settings screen or settings API";

fn invalid(message: &str) -> DevcelError {
    crate::app_error::authoring_error(message)
}

pub fn require_cell_editable(data: &TableData, column: &ColumnSchema) -> Result<()> {
    if !data.metadata.edit_permissions.edit_cells {
        return Err(invalid(EDIT_CELLS_DISABLED));
    }
    if column.read_only {
        return Err(invalid(COLUMN_READ_ONLY));
    }
    Ok(())
}

/// Compare UUID identities and stored inputs, never calculated/default values.
/// Deleting a permitted row/column is a structural action. Remaining protected
/// cells retain their exact raw representation, including absent versus empty.
/// Always use the current permissions, even if the candidate tries to clear them.
pub(crate) fn validate_transition(
    before: &TableData,
    after: &TableData,
    settings_command: bool,
) -> Result<()> {
    if is_resource_registration(before) {
        let locked = TableEditPermissions {
            add_columns: false,
            delete_columns: false,
            add_rows: false,
            delete_rows: false,
            edit_cells: false,
        };
        if after.metadata.edit_permissions != locked
            || before.metadata.data_name != after.metadata.data_name
            || serde_json::to_value(&before.schema)? != serde_json::to_value(&after.schema)?
            || serde_json::to_value(&before.records)? != serde_json::to_value(&after.records)?
            || serde_json::to_value(&before.interface_implementations)?
                != serde_json::to_value(&after.interface_implementations)?
            || before.metadata.interface_order != after.metadata.interface_order
        {
            return Err(crate::app_error::diagnostic(
                "table.edit.structureBlocked",
                serde_json::json!({}),
            ));
        }
    }
    // This invariant is structural, not a user-toggleable editing preference.
    // Preserve any damaged legacy rows for recovery; never silently delete data.
    if is_user_settings(before) {
        let same_rows = before.records.len() == after.records.len()
            && before
                .records
                .iter()
                .all(|row| after.records.iter().any(|new| new.uuid == row.uuid));
        if !same_rows
            || after.metadata.edit_permissions.add_rows
            || after.metadata.edit_permissions.delete_rows
        {
            return Err(invalid("UserSettings must keep its single settings record"));
        }
    }
    if has_fixed_settings_schema(before) {
        let same_columns = before.schema.columns.len() == after.schema.columns.len()
            && before.schema.columns.iter().all(|old| {
                after.schema.columns.iter().any(|new| {
                    old.uuid == new.uuid && fixed_column_contract(old) == fixed_column_contract(new)
                })
            });
        if !same_columns
            || before.metadata.data_name != after.metadata.data_name
            || after.metadata.edit_permissions.add_columns
            || after.metadata.edit_permissions.delete_columns
        {
            return Err(crate::app_error::diagnostic(
                "table.edit.structureBlocked",
                serde_json::json!({}),
            ));
        }
    }
    let permissions = &before.metadata.edit_permissions;
    if !settings_command
        && (permissions != &after.metadata.edit_permissions
            || before.metadata.initial_transposed != after.metadata.initial_transposed)
    {
        return Err(invalid(SETTINGS_API_REQUIRED));
    }
    // Ordinary unrestricted edits need only inspect column flags. Keep this
    // after the dedicated-settings check, and require both snapshots to be
    // unrestricted so no lock/unlock transition skips the general validation.
    let unrestricted = TableEditPermissions::default();
    if permissions == &unrestricted
        && after.metadata.edit_permissions == unrestricted
        && before.schema.columns.iter().all(|column| !column.read_only)
        && after.schema.columns.iter().all(|column| !column.read_only)
    {
        return Ok(());
    }
    let old_columns: HashMap<_, _> = before.schema.columns.iter().map(|c| (&c.uuid, c)).collect();
    let new_columns: HashMap<_, _> = after.schema.columns.iter().map(|c| (&c.uuid, c)).collect();
    if !permissions.add_columns && new_columns.keys().any(|id| !old_columns.contains_key(id)) {
        return Err(invalid(ADD_COLUMNS_DISABLED));
    }
    if !permissions.delete_columns && old_columns.keys().any(|id| !new_columns.contains_key(id)) {
        return Err(invalid(DELETE_COLUMNS_DISABLED));
    }
    for column in &after.schema.columns {
        if !settings_command
            && old_columns
                .get(&column.uuid)
                .is_some_and(|old| old.read_only != column.read_only)
        {
            return Err(invalid(SETTINGS_API_REQUIRED));
        }
    }
    let protected: Vec<_> = after
        .schema
        .columns
        .iter()
        .filter_map(|column| {
            let old = old_columns.get(&column.uuid).copied();
            (!permissions.edit_cells
                || old.is_some_and(|old| old.read_only)
                || (!settings_command && column.read_only))
                .then_some((old, column))
        })
        .collect();
    // Fully editable tables do not scan their rows for every metadata edit.
    if permissions.edit_cells
        && permissions.add_rows
        && permissions.delete_rows
        && protected.is_empty()
    {
        return Ok(());
    }
    let old_rows: HashMap<_, _> = before.records.iter().map(|r| (&r.uuid, r)).collect();
    if !permissions.add_rows
        && after
            .records
            .iter()
            .any(|r| !old_rows.contains_key(&r.uuid))
    {
        return Err(invalid(ADD_ROWS_DISABLED));
    }
    if !permissions.delete_rows {
        let new_rows: std::collections::HashSet<_> =
            after.records.iter().map(|r| &r.uuid).collect();
        if old_rows.keys().any(|id| !new_rows.contains(id)) {
            return Err(invalid(DELETE_ROWS_DISABLED));
        }
    }
    for record in &after.records {
        let old_record = old_rows.get(&record.uuid).copied();
        if !permissions.edit_cells {
            let changed_metadata = match old_record {
                Some(old) => !same_record_metadata(old, record),
                None => {
                    !record.label.is_empty()
                        || !record.parent_uuid.is_empty()
                        || record.min_version != 0
                        || !record.tags.is_empty()
                        || !record.memo_texts.is_empty()
                }
            };
            if changed_metadata {
                return Err(invalid(EDIT_CELLS_DISABLED));
            }
        }
        for (old_column, column) in &protected {
            let old = old_record
                .zip(*old_column)
                .and_then(|(r, c)| r.get_cell_value(c));
            let new = record.get_cell_value(column);
            let changed = if let (Some(old_record), Some(old_column)) = (old_record, old_column) {
                old != new
                    || (old_record.parent_uuid != record.parent_uuid
                        && before.effective_cell_input(old_record, old_column).ok()
                            != after.effective_cell_input(record, column).ok())
            } else {
                // Default-only creation is permitted; it never writes an override.
                new.is_some_and(|value| !value.is_empty())
            };
            if changed {
                return Err(invalid(if permissions.edit_cells {
                    COLUMN_READ_ONLY
                } else {
                    EDIT_CELLS_DISABLED
                }));
            }
        }
    }
    Ok(())
}

fn same_record_metadata(before: &crate::Record, after: &crate::Record) -> bool {
    before.label == after.label
        && before.parent_uuid == after.parent_uuid
        && before.min_version == after.min_version
        && before.tags == after.tags
        && before.memo_texts == after.memo_texts
}

/// Whole-table/folder deletion must not bypass row or column deletion controls.
pub(crate) fn require_table_deletable(data: &TableData) -> Result<()> {
    if has_fixed_settings_schema(data) {
        return Err(crate::app_error::diagnostic(
            "table.edit.structureBlocked",
            serde_json::json!({}),
        ));
    }
    if !data.metadata.edit_permissions.delete_rows {
        return Err(invalid(
            "Cannot delete the table because row deletion is prohibited",
        ));
    }
    if !data.metadata.edit_permissions.delete_columns {
        return Err(invalid(
            "Cannot delete the table because column deletion is prohibited",
        ));
    }
    Ok(())
}

/// A column-definition save may include protection changes, but may not use
/// them to combine an unlock with value conversion or structural data changes.
pub(crate) fn preserves_stored_cells(before: &TableData, after: &TableData) -> bool {
    if before.records.len() != after.records.len()
        || before.schema.columns.len() != after.schema.columns.len()
    {
        return false;
    }
    let old_columns: HashMap<_, _> = before.schema.columns.iter().map(|c| (&c.uuid, c)).collect();
    if after
        .schema
        .columns
        .iter()
        .any(|c| !old_columns.contains_key(&c.uuid))
    {
        return false;
    }
    let old_rows: HashMap<_, _> = before.records.iter().map(|r| (&r.uuid, r)).collect();
    after.records.iter().all(|record| {
        old_rows.get(&record.uuid).is_some_and(|old| {
            same_record_metadata(old, record)
                && after.schema.columns.iter().all(|column| {
                    old.get_cell_value(old_columns[&column.uuid]) == record.get_cell_value(column)
                })
        })
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TableEditSettingsRequest {
    pub table_uuid: String,
    pub expected_revision: String,
    pub initial_transposed: bool,
    pub description: String,
    /// Omitted by older clients: retain the saved name, independently of data_name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub edit_permissions: TableEditPermissions,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColumnReadOnlyRequest {
    pub table_uuid: String,
    pub expected_revision: String,
    pub column_uuid: String,
    pub read_only: bool,
}

fn current(project: &mut Project, table_uuid: &str, revision: &str) -> Result<TableData> {
    project.ensure_table_loaded_by_uuid(table_uuid)?;
    let table = &project
        .find_table_by_uuid(table_uuid)
        .ok_or_else(|| invalid("Table not found"))?
        .data;
    if crate::cell_rules::revision(table) != revision {
        return Err(invalid(
            "The table was updated by another operation. Reload the data",
        ));
    }
    Ok(table.clone())
}

fn commit(
    project: &mut Project,
    table_uuid: String,
    revision: String,
    after: TableData,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<MutationResult> {
    project.execute_command(
        ReplaceTableCommand::new(table_uuid.clone(), revision, after, None)
            .with_edit_control_settings(),
        queue,
    )?;
    let table = project
        .find_table_by_uuid(&table_uuid)
        .unwrap()
        .data
        .clone();
    let context = crate::formula_context::ProjectFormulaContext::new(project, None)?;
    let presentation = context.presentation(&table);
    Ok(MutationResult {
        table,
        presentation,
    })
}

pub fn update_table_edit_settings(
    project: &mut Project,
    request: TableEditSettingsRequest,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<MutationResult> {
    let mut after = current(project, &request.table_uuid, &request.expected_revision)?;
    if let Some(display_name) = request.display_name {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err(invalid("Table display name must not be empty"));
        }
        after.display_name = display_name.to_owned();
    }
    after.description = request.description;
    after.metadata.initial_transposed = request.initial_transposed;
    after.metadata.edit_permissions = request.edit_permissions;
    commit(
        project,
        request.table_uuid,
        request.expected_revision,
        after,
        queue,
    )
}

pub fn set_column_read_only(
    project: &mut Project,
    request: ColumnReadOnlyRequest,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<MutationResult> {
    let mut after = current(project, &request.table_uuid, &request.expected_revision)?;
    let column = after
        .schema
        .columns
        .iter_mut()
        .find(|c| c.uuid == request.column_uuid)
        .ok_or_else(|| invalid("Column not found"))?;
    // This is table-local protection, including columns owned by an interface.
    column.read_only = request.read_only;
    commit(
        project,
        request.table_uuid,
        request.expected_revision,
        after,
        queue,
    )
}

/// Authoring tags retain user order and spelling, with exact duplicates removed.
pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if !tag.is_empty() && !result.iter().any(|v| v == tag) {
            result.push(tag.to_owned());
        }
    }
    result
}

/// Preserve existing spellings from external edits; normalize only newly authored entries.
pub(crate) fn normalize_tags_preserving_existing(
    tags: &[String],
    existing: &[String],
) -> Vec<String> {
    let mut result = Vec::new();
    for tag in tags {
        let value = if existing.contains(tag) {
            tag.as_str()
        } else {
            tag.trim()
        };
        if (!value.is_empty() || existing.contains(tag)) && !result.iter().any(|old| old == value) {
            result.push(value.to_owned());
        }
    }
    result
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordMetadataRequest {
    pub table_uuid: String,
    pub expected_revision: String,
    pub record_uuid: String,
    pub tags: Option<Vec<String>>,
    pub memo: Option<CellMemo>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CellMemo {
    pub column_uuid: String,
    pub text: String,
}

pub fn update_record_metadata(
    project: &mut Project,
    request: RecordMetadataRequest,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<MutationResult> {
    let mut after = current(project, &request.table_uuid, &request.expected_revision)?;
    if !after.metadata.edit_permissions.edit_cells {
        return Err(invalid(EDIT_CELLS_DISABLED));
    }
    if let Some(memo) = &request.memo {
        let column = after
            .schema
            .columns
            .iter()
            .find(|c| c.uuid == memo.column_uuid)
            .ok_or_else(|| invalid("Column not found"))?;
        require_cell_editable(&after, column)?;
    }
    let record = after
        .records
        .iter_mut()
        .find(|r| r.uuid == request.record_uuid)
        .ok_or_else(|| invalid("Record not found"))?;
    if let Some(tags) = request.tags {
        record.tags = normalize_tags_preserving_existing(&tags, &record.tags);
    }
    if let Some(memo) = request.memo {
        if memo.text.is_empty() {
            record.memo_texts.remove(&memo.column_uuid);
        } else {
            record.memo_texts.insert(memo.column_uuid, memo.text);
        }
    }
    commit(
        project,
        request.table_uuid,
        request.expected_revision,
        after,
        queue,
    )
}

#[cfg(test)]
mod fixed_settings_tests {
    use super::*;
    #[test]
    fn fixed_registry_protects_structure_but_allows_cell_and_display_edits() {
        let mut before: TableData = serde_json::from_value(serde_json::json!({
            "uuid":"0de0da47-cf7c-5dce-b945-b6583fec0148","display_name":"Registry","description":"",
            "metadata":{"data_name":"Registry","parent_uuid":"","interface_order":[],"initial_transposed":false,"edit_permissions":TableEditPermissions::default()},
            "interface_implementations":{},"schema":{"columns":[ColumnSchema{data_name:"enabled".into(),..Default::default()}]},"records":[]
        })).unwrap();
        normalize_settings_metadata(&mut before);
        assert!(!before.metadata.edit_permissions.add_columns);
        let mut after = before.clone();
        after.schema.columns[0].display_name = "My label".into();
        validate_transition(&before, &after, true).unwrap();
        after.schema.columns[0].data_name = "renamed_binding".into();
        assert!(validate_transition(&before, &after, true).is_err());
        after = before.clone();
        after.metadata.edit_permissions.add_columns = true;
        assert!(validate_transition(&before, &after, true).is_err());
        assert!(require_table_deletable(&before).is_err());
    }
}
