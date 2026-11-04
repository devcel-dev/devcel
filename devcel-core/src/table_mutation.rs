//! One UUID-based, revision-checked write boundary for grids, CLI, plugins and FFI.
//! Preparing a row never changes the project. Validation precedes persistence and history.
use crate::commands::CommandData;
use crate::file_save_queue::FileBasedSaveQueueManager;
use crate::{DevcelError, Project, Record, Result, TableData};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitialValue {
    pub column_uuid: String,
    pub value: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CellPatch {
    pub record_uuid: String,
    pub column_uuid: String,
    pub value: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionPatch {
    pub record_uuid: String,
    pub min_version: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColumnVersionPatch {
    pub column_uuid: String,
    pub min_version: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRecord {
    pub record_uuid: String,
    #[serde(default)]
    pub values: Vec<InitialValue>,
    #[serde(default)]
    pub before_record_uuid: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TableMutation {
    pub table_uuid: String,
    pub expected_revision: String,
    #[serde(default)]
    pub cells: Vec<CellPatch>,
    #[serde(default)]
    pub versions: Vec<VersionPatch>,
    #[serde(default)]
    pub column_versions: Vec<ColumnVersionPatch>,
    #[serde(default)]
    pub create_records: Vec<CreateRecord>,
    #[serde(default)]
    pub delete_record_uuids: Vec<String>,
    #[serde(default)]
    pub acknowledgement: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordDraft {
    pub table_uuid: String,
    pub record_uuid: String,
    pub revision: String,
    pub values: Vec<InitialValue>,
    pub columns: Vec<crate::ColumnSchema>,
}
#[derive(Serialize)]
pub struct MutationResult {
    pub table: TableData,
    pub presentation: crate::cell_rules::TablePresentation,
}
pub(crate) fn parse_content_version(input: &str) -> Result<u32> {
    if input.is_empty() || input.len() > 10 || !input.bytes().all(|c| c.is_ascii_digit()) {
        return Err(invalid(
            "Enter a version as an integer between 0 and 4294967295",
        ));
    }
    input
        .parse()
        .map_err(|_| invalid("Enter a version as an integer between 0 and 4294967295"))
}
fn invalid(message: impl Into<String>) -> DevcelError {
    crate::app_error::authoring_error(message)
}

pub fn prepare_record_draft(project: &Project, table_uuid: &str) -> Result<RecordDraft> {
    let table = project.read_table_data_by_uuid(table_uuid)?;
    let record_uuid = uuid::Uuid::new_v4().to_string();
    Ok(RecordDraft {
        table_uuid: table_uuid.into(),
        record_uuid,
        revision: crate::cell_rules::revision(&table),
        columns: table.schema.columns.clone(),
        // Do not materialize defaults: absent/empty values continue to inherit the schema default.
        values: table
            .schema
            .columns
            .iter()
            .map(|column| InitialValue {
                column_uuid: column.uuid.clone(),
                value: String::new(),
            })
            .collect(),
    })
}

/// Bounded authoring operation, distinct from the general mutation wire limit.
pub const MAX_BULK_RECORDS: usize = 10_000;

/// Keep the raw input intact until Rust validates it (no rounding or exponent parsing).
pub fn parse_bulk_record_count(input: &str) -> Result<usize> {
    let invalid_count = || {
        DevcelError::Diagnostics(vec![crate::types::Diagnostic::Code {
            code: "grid.bulk.invalidCount".into(),
            params: serde_json::json!({ "max": MAX_BULK_RECORDS }),
        }])
    };
    // Reject oversized input before parsing/allocating a batch, including long zero prefixes.
    if input.is_empty() || input.len() > 5 || !input.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid_count());
    }
    let count = input.parse::<usize>().map_err(|_| invalid_count())?;
    if !(1..=MAX_BULK_RECORDS).contains(&count) {
        return Err(invalid_count());
    }
    Ok(count)
}

/// Prepare a single atomic mutation without changing data, history or persistence.
/// UUIDs and default inheritance are owned by Rust, just like single-row creation.
pub fn prepare_record_batch(
    project: &Project,
    table_uuid: &str,
    expected_revision: &str,
    count_input: &str,
) -> Result<TableMutation> {
    let count = parse_bulk_record_count(count_input)?;
    let table = project.read_table_data_by_uuid(table_uuid)?;
    if crate::cell_rules::revision(&table) != expected_revision {
        return Err(invalid(
            "The table was updated by another operation. Reload it and try again",
        ));
    }
    if !table.metadata.edit_permissions.add_rows {
        return Err(invalid(crate::edit_controls::ADD_ROWS_DISABLED));
    }
    Ok(TableMutation {
        table_uuid: table_uuid.into(),
        expected_revision: expected_revision.into(),
        cells: Vec::new(),
        versions: Vec::new(),
        column_versions: Vec::new(),
        create_records: (0..count)
            .map(|_| CreateRecord {
                record_uuid: uuid::Uuid::new_v4().to_string(),
                values: Vec::new(),
                before_record_uuid: None,
            })
            .collect(),
        delete_record_uuids: Vec::new(),
        acknowledgement: None,
    })
}

fn normalize_value(column: &crate::ColumnSchema, value: &str) -> Result<String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let value = column.validate_value(&value.to_owned())?;
    if !value.starts_with('=')
        && matches!(
            column.data_type,
            crate::ValueType::F32 | crate::ValueType::F64
        )
        && !value.parse::<f64>().is_ok_and(f64::is_finite)
    {
        return Err(invalid("Numeric values must be finite"));
    }
    Ok(value)
}

fn candidate(
    before: &TableData,
    request: &TableMutation,
    session: &str,
) -> Result<(TableData, VerifiedTableRevision)> {
    let revision = crate::cell_rules::revision(before);
    if request.expected_revision != revision {
        return Err(invalid(
            "The table was updated by another operation. Reload it and try again",
        ));
    }
    if !request.create_records.is_empty() && !before.metadata.edit_permissions.add_rows {
        return Err(invalid(crate::edit_controls::ADD_ROWS_DISABLED));
    }
    if !request.delete_record_uuids.is_empty() && !before.metadata.edit_permissions.delete_rows {
        return Err(invalid(crate::edit_controls::DELETE_ROWS_DISABLED));
    }
    if !request.cells.is_empty() && !before.metadata.edit_permissions.edit_cells {
        return Err(invalid(crate::edit_controls::EDIT_CELLS_DISABLED));
    }
    let count = request
        .cells
        .len()
        .saturating_add(request.versions.len())
        .saturating_add(request.column_versions.len())
        .saturating_add(request.create_records.len())
        .saturating_add(request.delete_record_uuids.len());
    if count == 0 || count > 100_000 {
        return Err(invalid("Invalid number of changes"));
    }
    let mut after = before.clone();
    let columns: HashMap<_, _> = before
        .schema
        .columns
        .iter()
        .map(|c| (c.uuid.as_str(), c))
        .collect();
    let mut ids: HashSet<_> = before.records.iter().map(|r| r.uuid.clone()).collect();
    let mut deleted = HashSet::new();
    for id in &request.delete_record_uuids {
        if !ids.contains(id) || !deleted.insert(id.clone()) {
            return Err(invalid("Rows to delete are missing or duplicated"));
        }
    }
    after.records.retain(|r| !deleted.contains(&r.uuid));
    for create in &request.create_records {
        uuid::Uuid::parse_str(&create.record_uuid)
            .map_err(|_| invalid("Invalid UUID for the new row"))?;
        if !ids.insert(create.record_uuid.clone()) {
            return Err(invalid("Duplicate row UUID"));
        }
        let mut record = Record::new();
        record.uuid = create.record_uuid.clone();
        let mut seen = HashSet::new();
        for initial in &create.values {
            if !seen.insert(&initial.column_uuid) {
                return Err(invalid("Duplicate initial-value column"));
            }
            let column = columns
                .get(initial.column_uuid.as_str())
                .ok_or_else(|| invalid("Initial-value column not found"))?;
            if !initial.value.is_empty() {
                crate::edit_controls::require_cell_editable(before, column)?;
            }
            record.set_cell_value(column, normalize_value(column, &initial.value)?);
        }
        let index = match &create.before_record_uuid {
            Some(anchor) => after
                .records
                .iter()
                .position(|r| &r.uuid == anchor)
                .ok_or_else(|| invalid("Insertion target row not found"))?,
            None => after.records.len(),
        };
        after.records.insert(index, record);
    }
    let mut seen_cells = HashSet::new();
    for patch in &request.cells {
        if !seen_cells.insert((&patch.record_uuid, &patch.column_uuid)) {
            return Err(invalid("Duplicate changes to the same cell"));
        }
        let column = columns
            .get(patch.column_uuid.as_str())
            .ok_or_else(|| invalid("Column to change not found"))?;
        crate::edit_controls::require_cell_editable(before, column)?;
        let record = after
            .records
            .iter_mut()
            .find(|r| r.uuid == patch.record_uuid)
            .ok_or_else(|| invalid("Row to change not found"))?;
        record.set_cell_value(column, normalize_value(column, &patch.value)?);
    }
    let mut seen_versions = HashSet::new();
    for patch in &request.versions {
        if !seen_versions.insert(&patch.record_uuid) {
            return Err(invalid("Duplicate row-version changes"));
        }
        let value = parse_content_version(&patch.min_version)?;
        let record = after
            .records
            .iter_mut()
            .find(|r| r.uuid == patch.record_uuid)
            .ok_or_else(|| invalid("Row for the version change not found"))?;
        record.min_version = value;
    }
    let mut seen_column_versions = HashSet::new();
    for patch in &request.column_versions {
        if !seen_column_versions.insert(&patch.column_uuid) {
            return Err(invalid("Duplicate column-version changes"));
        }
        let value = parse_content_version(&patch.min_version)?;
        let column = after
            .schema
            .columns
            .iter_mut()
            .find(|c| c.uuid == patch.column_uuid)
            .ok_or_else(|| invalid("Column for the version change not found"))?;
        if column.interface_origin.is_some() {
            return Err(invalid(crate::commands::INTERFACE_COLUMN_LOCKED_MSG));
        }
        column.min_version = value;
    }
    if after
        .records
        .iter()
        .any(|r| !r.parent_uuid.is_empty() && deleted.contains(&r.parent_uuid))
    {
        return Err(invalid(
            "Cannot delete a parent row while child rows remain. Delete the parent and children together",
        ));
    }
    Ok((
        after,
        VerifiedTableRevision {
            session: session.into(),
            table_uuid: before.uuid.clone(),
            revision,
        },
    ))
}

pub fn apply(
    project: &mut Project,
    request: TableMutation,
    save_queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<MutationResult> {
    project.ensure_table_loaded_by_uuid(&request.table_uuid)?;
    let before = &project
        .find_table_by_uuid(&request.table_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?
        .data;
    let (after, verified) = candidate(before, &request, project.get_instance_id())?;
    // Explicit values and mixed operations remain fully validated. Only a pure
    // addition of default-only rows establishes a repairable, persisted baseline.
    let default_record_creation = !request.create_records.is_empty()
        && request.cells.is_empty()
        && request.versions.is_empty()
        && request.column_versions.is_empty()
        && request.delete_record_uuids.is_empty()
        && request
            .create_records
            .iter()
            .all(|record| record.values.iter().all(|value| value.value.is_empty()));
    project.execute_verified_replacement(
        ReplaceTableCommand::new(
            request.table_uuid.clone(),
            request.expected_revision,
            after,
            request.acknowledgement,
        )
        .with_default_record_creation(default_record_creation),
        verified,
        save_queue,
    )?;
    let table = project
        .find_table_by_uuid(&request.table_uuid)
        .unwrap()
        .data
        .clone();
    let context = crate::formula_context::ProjectFormulaContext::new(project, None)?;
    let presentation = crate::cell_rules::presentation_with_evaluator(
        &table,
        &mut |data, column, record, formula| {
            context.evaluate_cell_with_override(data, column, record, formula)
        },
    );
    Ok(MutationResult {
        table,
        presentation,
    })
}

/// A non-cloneable proof created only beside a real before-revision check.
/// It never escapes this module's synchronous mutation/commit call. The dedicated
/// Project entry point also binds it to the session and this exact replacement.
/// Generic commands and subsequent execution of a history command get no proof.
pub(crate) struct VerifiedTableRevision {
    session: String,
    table_uuid: String,
    revision: String,
}
impl VerifiedTableRevision {
    pub(crate) fn bind(
        self,
        project: &Project,
        command: &mut ReplaceTableCommand,
    ) -> Result<Option<(String, String)>> {
        if self.session != project.get_instance_id()
            || self.table_uuid != command.table_uuid
            || self.revision != command.expected_revision
        {
            return Err(invalid("The prevalidated table or project has changed"));
        }
        // An invalid project may contain duplicate UUIDs. Its other loaded
        // snapshots must retain their independent comparisons; do not reuse a
        // UUID-bound proof for more than the single table that was checked.
        if project
            .tables_data
            .values()
            .filter(|table| table.data.uuid == self.table_uuid)
            .count()
            != 1
        {
            return Ok(None);
        }
        command.revision_verified = true;
        Ok(Some((self.table_uuid, self.revision)))
    }
}

/// Only Rust callers can build structural candidates. External callers use UUID patches or
/// the plugin contract, which additionally protects interface ownership and table identity.
pub(crate) struct ReplaceTableCommand {
    table_uuid: String,
    expected_revision: String,
    revision_verified: bool,
    after: Arc<TableData>,
    before: Option<Arc<TableData>>,
    acknowledgement: Option<String>,
    default_record_creation: bool,
    edit_control_settings: bool,
}
impl ReplaceTableCommand {
    pub(crate) fn new(
        table_uuid: String,
        expected_revision: String,
        after: TableData,
        acknowledgement: Option<String>,
    ) -> Self {
        Self {
            table_uuid,
            expected_revision,
            revision_verified: false,
            after: Arc::new(after),
            before: None,
            acknowledgement,
            default_record_creation: false,
            edit_control_settings: false,
        }
    }
    pub(crate) fn with_edit_control_settings(mut self) -> Self {
        self.edit_control_settings = true;
        self
    }
    fn with_default_record_creation(mut self, enabled: bool) -> Self {
        self.default_record_creation = enabled;
        self
    }
}
impl CommandData for ReplaceTableCommand {
    fn is_edit_control_settings(&self) -> bool {
        self.edit_control_settings
    }

    fn allows_default_record_creation(&self) -> bool {
        self.default_record_creation
    }

    fn execute(&mut self, project: &mut Project) -> Result<()> {
        let table = project
            .find_table_by_uuid_mut(&self.table_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?;
        // Consume the proof once. A command subsequently reused from history
        // must perform the ordinary stale-revision check again.
        if !std::mem::take(&mut self.revision_verified)
            && crate::cell_rules::revision(&table.data) != self.expected_revision
        {
            return Err(invalid("The table was updated by another operation"));
        }
        if self.after.uuid != self.table_uuid {
            return Err(invalid("The table UUID cannot be changed"));
        }
        // The live table stays independently mutable. Keep its replaced value
        // as the immutable before-state, shared with the project's history.
        self.before = Some(Arc::new(std::mem::replace(
            &mut table.data,
            self.after.as_ref().clone(),
        )));
        table.is_dirty = true;
        Ok(())
    }
    fn undo(&mut self, project: &mut Project) -> Result<()> {
        let before = self
            .before
            .as_ref()
            .ok_or_else(|| invalid("No edit history is available"))?;
        let table = project
            .find_table_by_uuid_mut(&self.table_uuid)
            .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?;
        table.data = before.as_ref().clone();
        table.is_dirty = true;
        Ok(())
    }
    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
    fn validation_acknowledgement(&self) -> Option<&str> {
        self.acknowledgement.as_deref()
    }

    fn shared_table_history_snapshot(
        &self,
        table_uuid: &str,
    ) -> Option<crate::commands::TableHistorySnapshot> {
        if table_uuid != self.table_uuid {
            return None;
        }
        Some(crate::commands::TableHistorySnapshot {
            before: self.before.as_ref()?.clone(),
            after: self.after.clone(),
        })
    }
}

/// A new destination must still be absent while its cross-process write lock is held.
pub(crate) const EXPECTED_ABSENT_REVISION: &str = "\0expected-absent";

/// Stage every file before replacing any destination. Preserve originals for rollback;
/// no save listener is notified unless the entire operation has committed.
pub(crate) fn persist_tables(
    files: &[(&std::path::Path, &TableData)],
    expected: &HashMap<PathBuf, String>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<()> {
    let selected = files
        .iter()
        .map(|(path, data)| (*path, Some(*data)))
        .collect::<Vec<_>>();
    persist_selected_tables(&selected, expected, queue)
}

/// A None candidate is an unchanged read dependency, not an omitted precondition.
/// Every path is still locked and revision-checked before any write is published.
pub(crate) fn persist_selected_tables(
    files: &[(&std::path::Path, Option<&TableData>)],
    expected: &HashMap<PathBuf, String>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<()> {
    let mut serialized = Vec::new();
    for (path, data) in files {
        let bytes = if let Some(data) = data {
            let text = crate::table_storage::to_toml(data)?;
            crate::table_file_revision::remember_serialized(&text, data);
            Some(text.into_bytes())
        } else {
            None
        };
        serialized.push((path.to_path_buf(), bytes));
    }
    persist_prepared_files(serialized, expected, queue)
}

pub(crate) fn persist_files(
    serialized: Vec<(PathBuf, Vec<u8>)>,
    expected: &HashMap<PathBuf, String>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<()> {
    persist_prepared_files(
        serialized
            .into_iter()
            .map(|(path, bytes)| (path, Some(bytes)))
            .collect(),
        expected,
        queue,
    )
}

pub(crate) fn persist_prepared_files(
    serialized: Vec<(PathBuf, Option<Vec<u8>>)>,
    expected: &HashMap<PathBuf, String>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<()> {
    persist_prepared_files_checked(serialized, expected, queue, None, None, None, || Ok(()))
}

/// Tag transactions add a durable before-image journal and a namespace read-set
/// check; ordinary table mutations retain their existing persistence contract.
pub(crate) fn persist_prepared_files_checked(
    mut serialized: Vec<(PathBuf, Option<Vec<u8>>)>,
    expected: &HashMap<PathBuf, String>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
    journal_root: Option<&std::path::Path>,
    journal_project: Option<&std::path::Path>,
    invalidate_paths: Option<&HashSet<PathBuf>>,
    validate_inventory: impl Fn() -> Result<()>,
) -> Result<()> {
    serialized.sort_by(|a, b| a.0.cmp(&b.0));
    let write = || -> Result<()> {
        // Stable Temp sentinels survive atomic destination replacement. Lock all paths in
        // one order, across processes, before checking revisions or publishing files.
        let _locks = crate::write_locks::lock_files(
            serialized
                .iter()
                .map(|(path, _)| path.as_path())
                .chain(expected.keys().map(|path| path.as_path())),
            false,
        )?;
        for (path, revision) in expected {
            {
                if revision.starts_with(crate::reference_integrity::INVENTORY_REVISION) {
                    if crate::reference_integrity::inventory_revision(path)? != *revision {
                        return Err(invalid("The table inventory changed. Reload and retry"));
                    }
                    continue;
                }
                if revision == EXPECTED_ABSENT_REVISION {
                    if path.try_exists()? {
                        return Err(invalid(format!(
                            "New table destination already exists: {}",
                            path.display()
                        )));
                    }
                    continue;
                }
                let text = std::fs::read_to_string(path)?;
                if let Some(raw) = revision.strip_prefix("raw:") {
                    if crate::project_tags::raw_revision(text.as_bytes()) != raw {
                        return Err(invalid(
                            "The project or table file changed. Reload and try again",
                        ));
                    }
                    continue;
                }
                if crate::table_file_revision::from_toml(&text)? != *revision {
                    return Err(invalid(
                        "The table file was updated by another operation. Reload it",
                    ));
                }
            }
        }
        let mut staged = Vec::new();
        let mut originals = Vec::new();
        let mut changed_indices = Vec::new();
        for (source_index, (path, bytes)) in serialized.iter().enumerate() {
            let Some(bytes) = bytes else { continue };
            let parent = path
                .parent()
                .ok_or_else(|| invalid("Invalid destination"))?;
            let original = match std::fs::read(path) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            };
            // Keep the full locked/CAS-checked read set, but do not rewrite bytes
            // that already match the validated candidate.
            if !expected
                .get(path)
                .is_some_and(|revision| revision == EXPECTED_ABSENT_REVISION)
                && original.as_deref() == Some(bytes.as_slice())
            {
                continue;
            }
            let mut temp = crate::utils::new_atomic_save_temp(parent)?;
            if let Ok(metadata) = std::fs::metadata(path) {
                temp.as_file().set_permissions(metadata.permissions())?;
            }
            temp.write_all(bytes)?;
            temp.as_file().sync_all()?;
            staged.push(temp);
            originals.push(original);
            changed_indices.push(source_index);
        }
        // Recheck table inventory immediately before publication, under all path
        // locks. Arbitrary external VCS writers do not honor our locks; detected
        // changes fail closed rather than silently leaving a scanned table out.
        for (path, revision) in expected {
            if revision.starts_with(crate::reference_integrity::INVENTORY_REVISION)
                && crate::reference_integrity::inventory_revision(path)? != *revision
            {
                return Err(invalid("The table inventory changed. Reload and retry"));
            }
        }
        validate_inventory()?;
        let journal = if let Some(root) = journal_root {
            let changes: Vec<_> = changed_indices
                .iter()
                .enumerate()
                .map(|(i, index)| {
                    (
                        serialized[*index].0.clone(),
                        serialized[*index].1.as_ref().unwrap().clone(),
                        originals[i].clone(),
                    )
                })
                .collect();
            Some(crate::tag_transaction_journal::Journal::prepare(
                root,
                journal_project.ok_or_else(|| invalid("Missing project journal identity"))?,
                &changes,
            )?)
        } else {
            None
        };
        let sync_directories = || -> Result<()> {
            #[cfg(unix)]
            {
                let parents: std::collections::BTreeSet<_> = changed_indices
                    .iter()
                    .filter_map(|index| serialized[*index].0.parent())
                    .collect();
                for parent in parents {
                    std::fs::File::open(parent)?.sync_all()?;
                }
            }
            Ok(())
        };
        let restore = |count: usize| -> Vec<String> {
            let mut errors = Vec::new();
            for previous in (0..count).rev() {
                let path = &serialized[changed_indices[previous]].0;
                let restored = match &originals[previous] {
                    Some(bytes) => crate::utils::write_atomic(path, bytes),
                    None => std::fs::remove_file(path).map_err(DevcelError::Io),
                };
                if let Err(error) = restored {
                    errors.push(format!("{}: {error}", path.display()));
                }
            }
            if let Err(error) = sync_directories() {
                errors.push(error.to_string());
            }
            errors
        };
        for (index, temp) in staged.into_iter().enumerate() {
            let path = &serialized[changed_indices[index]].0;
            // Other table creators use create_new rather than this sidecar lock.
            // Keep the absent-file precondition atomic at publication as well.
            let published = if expected
                .get(path)
                .is_some_and(|revision| revision == EXPECTED_ABSENT_REVISION)
            {
                temp.persist_noclobber(path)
            } else {
                temp.persist(path)
            };
            if let Err(error) = published {
                let recovery_errors = restore(index);
                if !recovery_errors.is_empty() {
                    return Err(invalid(format!(
                        "Save failed: {}. Restoration failed: {}",
                        error.error,
                        recovery_errors.join("; ")
                    )));
                }
                if let Some(journal) = journal {
                    journal.rollback_completed()?;
                }
                return Err(DevcelError::Io(error.error));
            }
        }
        if let Some(journal) = journal {
            if let Err(error) = sync_directories().and_then(|()| journal.commit()) {
                if !journal.rollback_is_safe()? {
                    return Err(error);
                }
                let recovery_errors = restore(changed_indices.len());
                if !recovery_errors.is_empty() {
                    return Err(invalid(format!(
                        "Tag transaction commit failed: {error}. Restoration failed: {}",
                        recovery_errors.join("; ")
                    )));
                }
                journal.rollback_completed()?;
                return Err(error);
            }
        }
        Ok(())
    };
    if let Some(queue) = queue {
        queue.save_directly_fenced(|| {
            let result = write();
            let notify_paths = if result.is_ok() {
                serialized
                    .iter()
                    .filter(|(_, bytes)| journal_root.is_none() || bytes.is_some())
                    .map(|(path, _)| path.clone())
                    .collect()
            } else {
                Vec::new()
            };
            let invalidated = if result.is_ok() {
                invalidate_paths
                    .map(|paths| paths.iter().cloned().collect())
                    .unwrap_or_else(|| serialized.iter().map(|(path, _)| path.clone()).collect())
            } else if journal_root.is_some_and(crate::tag_transaction_journal::pending) {
                // A partial rollback is unavailable until recovery. Do not let our
                // own pre-transaction queue create divergent third-state files.
                serialized.iter().map(|(path, _)| path.clone()).collect()
            } else {
                Vec::new()
            };
            (result, invalidated, notify_paths)
        })
    } else {
        write()
    }
}

/// Commit a candidate prepared by a Rust structural editor. Caller-held Project lock
/// and the revision are rechecked by the same command boundary as ordinary cells.
pub fn commit_candidate(
    project: &mut Project,
    table_uuid: &str,
    after: TableData,
    acknowledgement: Option<String>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<()> {
    project.ensure_table_loaded_by_uuid(table_uuid)?;
    let before = &project
        .find_table_by_uuid(table_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?
        .data;
    let expected = crate::cell_rules::revision(before);
    let verified = VerifiedTableRevision {
        session: project.get_instance_id().into(),
        table_uuid: table_uuid.into(),
        revision: expected.clone(),
    };
    project.execute_verified_replacement(
        ReplaceTableCommand::new(table_uuid.into(), expected, after, acknowledgement),
        verified,
        queue,
    )
}

/// Apply pending automatic interface updates as one revision-checked command.
/// Even a metadata-only sync changes the table revision: never publish it in
/// memory before persistence succeeds, or the next ordinary edit fails disk CAS.
pub fn sync_pending_interface_updates(
    project: &mut Project,
    table_uuid: &str,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<bool> {
    project.ensure_table_loaded_by_uuid(table_uuid)?;
    let table = project
        .find_table_by_uuid(table_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?;
    let mut roots: Vec<_> = table
        .data
        .interface_implementations
        .iter()
        .filter_map(|(id, implementation)| {
            project
                .get_interface(id)
                .filter(|interface| {
                    interface.table_needs_sync(implementation, &project.interface_registry)
                })
                .map(|_| *id)
        })
        .collect();
    roots.sort();
    if roots.is_empty() {
        return Ok(false);
    }
    let after = reconcile_interface_set(table, &project.interface_registry, &roots)?;
    if crate::cell_rules::revision(&after) == crate::cell_rules::revision(&table.data) {
        return Ok(false);
    }
    commit_candidate(project, table_uuid, after, None, queue)?;
    Ok(true)
}

/// Project a coherent set before validation or publication. Every selected root's
/// synchronization identity advances inside one disposable candidate, so shared
/// ancestor fields are never reconciled against a half-updated sibling.
pub(crate) fn reconcile_interface_set(
    table: &crate::Table,
    registry: &crate::interface::InterfaceRegistry,
    roots: &[uuid::Uuid],
) -> Result<TableData> {
    let updates = roots
        .iter()
        .map(|id| {
            registry
                .get_interface(id)
                .ok_or_else(|| invalid("A required interface is missing"))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut candidate = table.clone();
    let old_required: HashSet<_> = candidate
        .data
        .interface_implementations
        .keys()
        .flat_map(|id| crate::Interface::required_ids(&candidate.data, id, registry))
        .collect();
    // All pending fingerprints and required identity sets move together only
    // inside this disposable candidate. Nothing is published before commit.
    for interface in &updates {
        let columns = interface.get_effective_columns(registry)?;
        if let Some(implementation) = candidate
            .data
            .interface_implementations
            .get_mut(&interface.uuid)
        {
            implementation.synced_version_id = interface.current_version_id;
            implementation.effective_fingerprint = Some(interface.effective_fingerprint(registry));
            implementation.required_column_uuids =
                Some(columns.iter().map(|column| column.uuid.clone()).collect());
        }
    }
    for interface in updates {
        let result = interface.reconcile_table(&mut candidate, registry)?;
        for warning in result.warnings {
            eprintln!("Warning: {warning}");
        }
    }
    let required: HashSet<_> = candidate
        .data
        .interface_implementations
        .keys()
        .flat_map(|id| crate::Interface::required_ids(&candidate.data, id, registry))
        .collect();
    let removed: HashSet<_> = candidate
        .data
        .schema
        .columns
        .iter()
        .filter(|column| {
            column.interface_origin.is_some()
                && old_required.contains(&column.uuid)
                && !required.contains(&column.uuid)
        })
        .map(|column| column.uuid.clone())
        .collect();
    candidate
        .data
        .schema
        .columns
        .retain(|column| !removed.contains(&column.uuid));
    for row in &mut candidate.data.records {
        row.interface_values.retain(|id, _| !removed.contains(id));
        row.memo_texts.retain(|id, _| !removed.contains(id));
    }
    Ok(candidate.data)
}

pub fn sync_interface(
    project: &mut Project,
    table_uuid: &str,
    interface_uuid: &uuid::Uuid,
    reconcile: bool,
    apply_safe_changes: bool,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<crate::interface::ApplyResult> {
    sync_interface_checked(
        project,
        table_uuid,
        interface_uuid,
        reconcile,
        apply_safe_changes,
        None,
        queue,
    )
}

pub fn sync_interface_checked(
    project: &mut Project,
    table_uuid: &str,
    interface_uuid: &uuid::Uuid,
    reconcile: bool,
    apply_safe_changes: bool,
    acknowledgement: Option<String>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<crate::interface::ApplyResult> {
    project.ensure_table_loaded_by_uuid(table_uuid)?;
    let interface = project
        .get_interface(interface_uuid)
        .ok_or_else(|| DevcelError::NotFound("Interface not found".into()))?
        .clone();
    let mut candidate = project
        .find_table_by_uuid(table_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?
        .clone();
    let previous = candidate
        .data
        .interface_implementations
        .get(interface_uuid)
        .ok_or_else(|| invalid("The table does not implement this interface"))?;
    let from = previous.synced_version_id;
    let result = if reconcile {
        interface.reconcile_table(&mut candidate, &project.interface_registry)
    } else {
        interface.apply_to_table(&mut candidate, from, &project.interface_registry)
    }?;
    if !apply_safe_changes && !result.type_changes.is_empty() {
        return Err(invalid("Type changes require manual review"));
    }
    if let Some(info) = candidate
        .data
        .interface_implementations
        .get_mut(interface_uuid)
    {
        // Actual wall-clock sync time remains persisted/displayed. The acknowledgement
        // fingerprint normalizes only this generated metadata, never schema/values/versions.
        info.last_sync_date = chrono::Utc::now();
        info.synced_version_id = interface.current_version_id;
    }
    commit_candidate(project, table_uuid, candidate.data, acknowledgement, queue)?;
    Ok(result)
}

pub fn remove_interface(
    project: &mut Project,
    table_uuid: &str,
    interface_uuid: &uuid::Uuid,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<crate::interface::ApplyResult> {
    remove_interface_checked(project, table_uuid, interface_uuid, None, queue)
}

pub fn remove_interface_checked(
    project: &mut Project,
    table_uuid: &str,
    interface_uuid: &uuid::Uuid,
    acknowledgement: Option<String>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<crate::interface::ApplyResult> {
    project.ensure_table_loaded_by_uuid(table_uuid)?;
    let interface = project
        .get_interface(interface_uuid)
        .ok_or_else(|| DevcelError::NotFound("Interface not found".into()))?
        .clone();
    let mut candidate = project
        .find_table_by_uuid(table_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?
        .clone();
    let legacy: Vec<_> = candidate
        .data
        .interface_implementations
        .iter()
        .filter(|(_, implementation)| implementation.required_column_uuids.is_none())
        .map(|(id, _)| *id)
        .collect();
    for id in legacy {
        let ids = crate::Interface::required_ids(&candidate.data, &id, &project.interface_registry)
            .into_iter()
            .collect();
        candidate
            .data
            .interface_implementations
            .get_mut(&id)
            .unwrap()
            .required_column_uuids = Some(ids);
    }
    let result = interface.remove_from_table(&mut candidate)?;
    for column in &mut candidate.data.schema.columns {
        if let Some(owner) = column
            .interface_origin
            .as_ref()
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .and_then(|id| project.get_interface(&id))
        {
            column.interface_origin_name_fallback = Some(owner.name.clone());
        }
    }
    commit_candidate(project, table_uuid, candidate.data, acknowledgement, queue)?;
    Ok(result)
}

/// Apply an interface to a disposable table and preserve the same candidate on warn retry.
pub fn apply_interface_checked(
    project: &mut Project,
    table_uuid: &str,
    interface_uuid: &uuid::Uuid,
    auto_add_columns: bool,
    acknowledgement: Option<String>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
) -> Result<()> {
    project.ensure_table_loaded_by_uuid(table_uuid)?;
    let interface = project
        .get_interface(interface_uuid)
        .ok_or_else(|| DevcelError::NotFound("Interface not found".into()))?
        .clone();
    let mut candidate = project
        .find_table_by_uuid(table_uuid)
        .ok_or_else(|| crate::app_error::authoring_error("Table not found"))?
        .clone();
    candidate.apply_interface(&interface, &project.interface_registry, auto_add_columns)?;
    if let Some(info) = candidate
        .data
        .interface_implementations
        .get_mut(interface_uuid)
    {
        info.last_sync_date = chrono::Utc::now();
    }
    commit_candidate(project, table_uuid, candidate.data, acknowledgement, queue)
}

#[cfg(test)]
mod read_dependency_tests {
    use super::*;
    #[test]
    fn unchanged_read_dependency_is_revision_checked_and_locked() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.txt");
        let source = dir.path().join("source.txt");
        std::fs::write(&target, b"before").unwrap();
        std::fs::write(&source, b"read").unwrap();
        let expected = HashMap::from([(
            source.clone(),
            format!("raw:{}", crate::project_tags::raw_revision(b"read")),
        )]);
        persist_prepared_files_checked(
            vec![(target.clone(), Some(b"after".to_vec()))],
            &expected,
            None,
            None,
            None,
            None,
            || {
                let lock = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(crate::write_locks::path_for_target(&source)?)?;
                assert!(
                    lock.try_lock().is_err(),
                    "read-only source must be locked through publication"
                );
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"after");
        std::fs::write(&source, b"external-new-reference").unwrap();
        assert!(persist_files(vec![(target.clone(), b"bad".to_vec())], &expected, None).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"after");
    }
}
