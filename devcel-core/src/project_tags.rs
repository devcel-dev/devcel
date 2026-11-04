//! Project-owned tag vocabulary. Unknown names from merges remain editable data.
use crate::file_save_queue::FileBasedSaveQueueManager;
use crate::{DevcelError, Project, Result, TableData};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};

fn invalid(message: impl Into<String>) -> DevcelError {
    DevcelError::Validation(message.into())
}
pub(crate) fn diagnostic(key: &str, params: serde_json::Value) -> DevcelError {
    DevcelError::Diagnostics(vec![crate::types::Diagnostic::Code {
        code: format!("projectTags.error.{key}"),
        params,
    }])
}
fn error(key: &str) -> DevcelError {
    diagnostic(key, serde_json::json!({}))
}
/// Reuse the common data-name contract without exposing raw English validation errors.
pub(crate) fn validate_authored_name(name: &str) -> Result<()> {
    crate::validate_data_name(name).map_err(|_| error("invalidName"))
}
pub(crate) fn raw_revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[derive(Clone, Serialize)]
pub struct TagState {
    pub presets: Vec<String>,
    pub revision: String,
    pub project_session: String,
}
#[derive(Clone, Default, Serialize)]
pub struct TagUsage {
    pub name: String,
    pub rows: usize,
    pub columns: usize,
    pub tables: usize,
    pub registered: bool,
}
#[derive(Serialize)]
pub struct TagUsageResult {
    pub usage: Vec<TagUsage>,
    pub scanned_tables: usize,
}
#[derive(Clone, Serialize)]
pub struct TagProgress {
    pub project_session: String,
    pub phase: String,
    pub scanned_tables: usize,
    pub total_tables: usize,
}
#[derive(Serialize)]
pub struct TagUpdateResult {
    pub state: TagState,
    pub scanned_tables: usize,
    pub changed_tables: usize,
    pub changed_rows: usize,
    pub changed_columns: usize,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TagOperation {
    Add,
    Rename,
    Delete,
}

pub fn state(project: &Project) -> TagState {
    TagState {
        presets: project.project_data.tag_presets.clone(),
        revision: raw_revision(&serde_json::to_vec(&project.project_data).unwrap()),
        project_session: project.get_instance_id().into(),
    }
}
fn paths(project: &Project) -> Result<BTreeSet<PathBuf>> {
    let root = project
        .path
        .parent()
        .ok_or_else(|| invalid("Invalid project path"))?
        .join("Tables");
    let mut paths = BTreeSet::new();
    for path in project.tables_data.keys() {
        paths.insert(std::fs::canonicalize(path)?);
    }
    let mut pending = if root.exists() { vec![root] } else { vec![] };
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(".table.toml")
            {
                paths.insert(std::fs::canonicalize(entry.path())?);
            }
        }
    }
    Ok(paths)
}
fn live_keys(project: &Project) -> Result<HashMap<PathBuf, PathBuf>> {
    let mut keys = HashMap::new();
    for key in project.tables_data.keys() {
        if keys
            .insert(std::fs::canonicalize(key)?, key.clone())
            .is_some()
        {
            return Err(invalid(
                "The same table is loaded under multiple paths. Reopen the project",
            ));
        }
    }
    Ok(keys)
}
fn add_usage(usage: &mut BTreeMap<String, TagUsage>, data: &TableData, presets: &[String]) {
    let mut seen = HashSet::new();
    for (tags, row) in data
        .records
        .iter()
        .map(|r| (&r.tags, true))
        .chain(data.schema.columns.iter().map(|c| (&c.tags, false)))
    {
        for name in tags.iter().collect::<HashSet<_>>() {
            let item = usage.entry(name.clone()).or_insert_with(|| TagUsage {
                name: name.clone(),
                registered: presets.contains(name),
                ..Default::default()
            });
            if row {
                item.rows += 1;
            } else {
                item.columns += 1;
            }
            seen.insert(name.clone());
        }
    }
    for name in seen {
        usage.get_mut(&name).unwrap().tables += 1;
    }
}
pub fn usage(project: &Project) -> Result<TagUsageResult> {
    let paths = paths(project)?;
    let live_keys = live_keys(project)?;
    let mut usage = BTreeMap::new();
    for path in &paths {
        let data = if let Some(table) = live_keys
            .get(path)
            .and_then(|key| project.tables_data.get(key))
        {
            table.data.clone()
        } else {
            toml::from_str(&std::fs::read_to_string(path)?)?
        };
        add_usage(&mut usage, &data, &project.project_data.tag_presets);
    }
    Ok(TagUsageResult {
        usage: usage.into_values().collect(),
        scanned_tables: paths.len(),
    })
}
fn replace(data: &mut TableData, old: &str, new: &str) -> (usize, usize) {
    fn tags(tags: &mut Vec<String>, old: &str, new: &str) -> bool {
        if !tags.iter().any(|tag| tag == old) {
            return false;
        }
        for tag in tags.iter_mut() {
            if tag == old {
                *tag = new.into();
            }
        }
        let mut seen = HashSet::new();
        tags.retain(|tag| seen.insert(tag.clone()));
        true
    }
    let rows = data
        .records
        .iter_mut()
        .filter(|r| r.tags.iter().any(|t| t == old))
        .map(|r| usize::from(tags(&mut r.tags, old, new)))
        .sum();
    let columns = data
        .schema
        .columns
        .iter_mut()
        .map(|c| usize::from(tags(&mut c.tags, old, new)))
        .sum();
    (rows, columns)
}
fn rewrite_history(project: &mut Project, old: &str, new: &str) {
    // Keep command.data identity: multi-table history ordering is based on it.
    // Only immutable table snapshots are replayed; command payloads are never re-executed.
    let mut snapshots = HashMap::new();
    let mut rewrite = |command: &mut crate::commands::Command| {
        let key = Arc::as_ptr(&command.table_snapshots) as usize;
        let rewritten = snapshots.entry(key).or_insert_with(|| {
            let mut rewritten = command.table_snapshots.as_ref().clone();
            for snapshot in rewritten.values_mut() {
                for data in [&mut snapshot.before, &mut snapshot.after] {
                    if data
                        .records
                        .iter()
                        .any(|r| r.tags.iter().any(|tag| tag == old))
                        || data
                            .schema
                            .columns
                            .iter()
                            .any(|c| c.tags.iter().any(|tag| tag == old))
                    {
                        replace(Arc::make_mut(data), old, new);
                    }
                }
            }
            Arc::new(rewritten)
        });
        command.table_snapshots = rewritten.clone();
    };
    for table in project.tables_data.values_mut() {
        for command in table
            .undo_history
            .iter_mut()
            .chain(table.redo_history.iter_mut())
        {
            rewrite(command);
        }
    }
    for (undo, redo) in project.interface_history.values_mut() {
        for command in undo.iter_mut().chain(redo.iter_mut()) {
            rewrite(command);
        }
    }
}

pub struct TagUpdateRequest<'a> {
    pub operation: TagOperation,
    pub name: &'a str,
    pub new_name: Option<&'a str>,
    pub expected_revision: &'a str,
    pub expected_session: &'a str,
}

pub fn update(
    project: &mut Project,
    request: TagUpdateRequest<'_>,
    queue: Option<&Arc<FileBasedSaveQueueManager>>,
    mut progress: impl FnMut(TagProgress),
) -> Result<TagUpdateResult> {
    let TagUpdateRequest {
        operation,
        name,
        new_name,
        expected_revision,
        expected_session,
    } = request;
    if project.get_instance_id() != expected_session || state(project).revision != expected_revision
    {
        return Err(error("stale"));
    }
    let root = project
        .path
        .parent()
        .ok_or_else(|| invalid("Invalid project path"))?
        .to_path_buf();
    let root = if root.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        root
    };
    let _transaction_lock = crate::tag_transaction_journal::acquire_lock(&root)?;
    ensure_ready(project)?;
    // Existing externally supplied spellings must remain addressable for repair/removal.
    let name = if matches!(operation, TagOperation::Add) {
        name.trim()
    } else {
        name
    };
    if matches!(operation, TagOperation::Add) && name.is_empty() {
        return Err(error("nameRequired"));
    }
    let mut next = project.project_data.clone();
    let index = next.tag_presets.iter().position(|tag| tag == name);
    let replacement = match operation {
        TagOperation::Add => {
            validate_authored_name(name)?;
            if index.is_some() {
                return Err(error("duplicate"));
            }
            next.tag_presets.push(name.into());
            None
        }
        TagOperation::Delete => {
            let index = index.ok_or_else(|| error("missing"))?;
            next.tag_presets.remove(index);
            None
        }
        TagOperation::Rename => {
            let index = index.ok_or_else(|| error("missing"))?;
            let new = new_name.unwrap_or("").trim();
            if new.is_empty() {
                return Err(error("nameRequired"));
            }
            validate_authored_name(new)?;
            if next.tag_presets.iter().any(|tag| tag == new) {
                return Err(error("duplicate"));
            }
            next.tag_presets[index] = new.into();
            Some(new.to_owned())
        }
    };
    let disk_project = std::fs::read(&project.path)?;
    let persisted: crate::project_impl::ProjectFileData =
        toml::from_str(std::str::from_utf8(&disk_project).map_err(|e| invalid(e.to_string()))?)?;
    if persisted.tag_presets != project.project_data.tag_presets {
        return Err(error("registryChangedOnDisk"));
    }
    // Preserve external unrelated project settings rather than silently overwriting them.
    if raw_revision(&serde_json::to_vec(&persisted).unwrap()) != state(project).revision {
        return Err(error("settingsChangedOnDisk"));
    }
    let paths = if matches!(operation, TagOperation::Add) {
        BTreeSet::new()
    } else {
        paths(project)?
    };
    let live_keys = if matches!(operation, TagOperation::Add) {
        HashMap::new()
    } else {
        live_keys(project)?
    };
    let total = paths.len();
    let mut files = vec![(
        project.path.clone(),
        Some(
            toml::to_string(&next)
                .map_err(|e| invalid(e.to_string()))?
                .into_bytes(),
        ),
    )];
    let mut expected = HashMap::from([(
        project.path.clone(),
        format!("raw:{}", raw_revision(&disk_project)),
    )]);
    let mut live = Vec::new();
    let mut changed_tables = 0;
    let mut changed_rows = 0;
    let mut changed_columns = 0;
    for (i, path) in paths.iter().enumerate() {
        if i % 100 == 0 {
            progress(TagProgress {
                project_session: expected_session.into(),
                phase: "scanning".into(),
                scanned_tables: i,
                total_tables: total,
            });
        }
        let disk = std::fs::read(path)?;
        let mut disk_data: TableData =
            TableData::from_toml(std::str::from_utf8(&disk).map_err(|e| invalid(e.to_string()))?)?;
        let data = project
            .tables_data
            .get(live_keys.get(path).unwrap_or(path))
            .map(|t| &t.data)
            .unwrap_or(&disk_data);
        if let Some(table) = live_keys
            .get(path)
            .and_then(|key| project.tables_data.get(key))
        {
            if !table.is_dirty
                && crate::cell_rules::revision(&table.data)
                    != crate::cell_rules::revision(&disk_data)
            {
                return Err(error("tableChangedOnDisk"));
            }
        }
        if matches!(operation, TagOperation::Delete) {
            let mut found = BTreeMap::new();
            add_usage(&mut found, data, &project.project_data.tag_presets);
            add_usage(&mut found, &disk_data, &project.project_data.tag_presets);
            if found.contains_key(name) {
                return Err(diagnostic(
                    "inUse",
                    serde_json::json!({"name":name,"table":data.display_name}),
                ));
            }
        }
        let mut disk_changed = false;
        if let Some(new) = &replacement {
            let rows: HashSet<_> = data
                .records
                .iter()
                .chain(disk_data.records.iter())
                .filter(|r| r.tags.iter().any(|tag| tag == name))
                .map(|r| &r.uuid)
                .collect();
            let columns: HashSet<_> = data
                .schema
                .columns
                .iter()
                .chain(disk_data.schema.columns.iter())
                .filter(|c| c.tags.iter().any(|tag| tag == name))
                .map(|c| &c.uuid)
                .collect();
            changed_rows += rows.len();
            changed_columns += columns.len();
            if !rows.is_empty() || !columns.is_empty() {
                changed_tables += 1;
            }
            if let Some(table) = live_keys
                .get(path)
                .and_then(|key| project.tables_data.get(key))
            {
                if table
                    .data
                    .records
                    .iter()
                    .any(|r| r.tags.iter().any(|tag| tag == name))
                    || table
                        .data
                        .schema
                        .columns
                        .iter()
                        .any(|c| c.tags.iter().any(|tag| tag == name))
                {
                    let mut candidate = table.data.clone();
                    replace(&mut candidate, name, new);
                    live.push((live_keys[path].clone(), candidate));
                }
            }
            let (rows, columns) = replace(&mut disk_data, name, new);
            disk_changed = rows + columns > 0;
        }
        expected.insert(path.clone(), format!("raw:{}", raw_revision(&disk)));
        // Include the whole scanned read set in the transaction/CAS, even unchanged files.
        files.push((
            path.clone(),
            if disk_changed {
                Some(crate::table_storage::to_toml(&disk_data)?.into_bytes())
            } else {
                None
            },
        ));
    }
    progress(TagProgress {
        project_session: expected_session.into(),
        phase: "saving".into(),
        scanned_tables: total,
        total_tables: total,
    });
    let mut invalidate_paths: HashSet<_> = files
        .iter()
        .filter(|(_, bytes)| bytes.is_some())
        .map(|(path, _)| path.clone())
        .collect();
    invalidate_paths.extend(live.iter().map(|(path, _)| path.clone()));
    for (path, _) in &live {
        invalidate_paths.insert(std::fs::canonicalize(path)?);
    }
    let persisted = crate::table_mutation::persist_prepared_files_checked(
        files,
        &expected,
        queue,
        Some(&root),
        Some(&project.path),
        Some(&invalidate_paths),
        || {
            if !matches!(operation, TagOperation::Add) && self::paths(project)? != paths {
                return Err(error("tableChangedOnDisk"));
            }
            Ok(())
        },
    );
    if let Err(failure) = persisted {
        if crate::tag_transaction_journal::pending(&root) {
            eprintln!("Tag transaction requires recovery: {failure}");
            return Err(error("recoveryRequired"));
        }
        return Err(failure);
    }
    project.project_disk_baseline = Some(next.clone());
    project.project_data = next;
    for (path, data) in live {
        project.tables_data.get_mut(&path).unwrap().data = data;
    }
    if let Some(new) = replacement {
        rewrite_history(project, name, &new);
    }
    progress(TagProgress {
        project_session: expected_session.into(),
        phase: "complete".into(),
        scanned_tables: total,
        total_tables: total,
    });
    Ok(TagUpdateResult {
        state: state(project),
        scanned_tables: total,
        changed_tables,
        changed_rows,
        changed_columns,
    })
}

/// Existing unknown tags survive merges and ordinary edits. Only corrections of
/// existing orphans may introduce another unknown name; fresh additions use presets.
pub(crate) fn validate_transition(
    presets: &[String],
    before: &TableData,
    after: &TableData,
) -> Result<()> {
    fn check(presets: &HashSet<&str>, before: &[String], after: &[String]) -> Result<()> {
        if before == after {
            return Ok(());
        }
        for tag in after.iter().filter(|tag| !before.contains(tag)) {
            validate_authored_name(tag)?;
        }
        let removed_orphans = before
            .iter()
            .filter(|tag| !presets.contains(tag.as_str()) && !after.contains(tag))
            .count();
        let new_orphans = after
            .iter()
            .filter(|tag| !presets.contains(tag.as_str()) && !before.contains(tag))
            .count();
        if new_orphans > removed_orphans {
            return Err(error("choosePreset"));
        }
        Ok(())
    }
    // Ordinary cell/memo edits retain aligned identities and tags. Avoid building
    // a 100k-row index for this overwhelmingly common path.
    if before.records.len() == after.records.len()
        && before.schema.columns.len() == after.schema.columns.len()
        && before
            .records
            .iter()
            .zip(&after.records)
            .all(|(a, b)| a.uuid == b.uuid && a.tags == b.tags && a.label == b.label)
        && before
            .schema
            .columns
            .iter()
            .zip(&after.schema.columns)
            .all(|(a, b)| a.uuid == b.uuid && a.tags == b.tags)
    {
        return Ok(());
    }
    let presets: HashSet<_> = presets.iter().map(String::as_str).collect();
    let rows: HashMap<_, _> = before
        .records
        .iter()
        .map(|r| (r.uuid.as_str(), r))
        .collect();
    let columns: HashMap<_, _> = before
        .schema
        .columns
        .iter()
        .map(|c| (c.uuid.as_str(), c.tags.as_slice()))
        .collect();
    for record in &after.records {
        let previous = rows.get(record.uuid.as_str()).copied();
        if !record.label.is_empty() && previous.is_none_or(|old| old.label != record.label) {
            validate_authored_name(&record.label)?;
        }
        check(
            &presets,
            previous.map(|row| row.tags.as_slice()).unwrap_or(&[]),
            &record.tags,
        )?;
    }
    for column in &after.schema.columns {
        check(
            &presets,
            columns.get(column.uuid.as_str()).copied().unwrap_or(&[]),
            &column.tags,
        )?;
    }
    Ok(())
}

/// A failed restoration leaves its journal for recovery and blocks further writes.
pub(crate) fn ensure_ready(project: &Project) -> Result<()> {
    if let Some(root) = project.path.parent() {
        if crate::tag_transaction_journal::pending(root) {
            return Err(error("recoveryRequired"));
        }
    }
    Ok(())
}

/// Refresh registry metadata after another instance committed it. No writes,
/// history mutation, or notifications: callers own session-fenced invalidation.
pub fn reload(project: &mut Project) -> Result<bool> {
    ensure_ready(project)?;
    let root = project
        .path
        .parent()
        .ok_or_else(|| invalid("Invalid project path"))?;
    let _lock = crate::tag_transaction_journal::acquire_lock(if root.as_os_str().is_empty() {
        std::path::Path::new(".")
    } else {
        root
    })?;
    ensure_ready(project)?;
    let persisted: crate::project_impl::ProjectFileData =
        toml::from_str(&std::fs::read_to_string(&project.path)?)?;
    if persisted.uuid != project.project_data.uuid {
        return Err(error("stale"));
    }
    let changed = persisted.tag_presets != project.project_data.tag_presets;
    if let Some(baseline) = &mut project.project_disk_baseline {
        baseline.tag_presets = persisted.tag_presets.clone();
    }
    project.project_data.tag_presets = persisted.tag_presets;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    #[test]
    fn open_project_recovers_interrupted_registry_and_table_publication_before_loading() {
        let dir = tempfile::tempdir().unwrap();
        let mut project =
            crate::Project::create_project("Recovery", dir.path().to_str().unwrap(), "", "#123456")
                .unwrap();
        let state = super::state(&project);
        super::update(
            &mut project,
            super::TagUpdateRequest {
                operation: super::TagOperation::Add,
                name: "old",
                new_name: None,
                expected_revision: &state.revision,
                expected_session: &state.project_session,
            },
            None,
            |_| {},
        )
        .unwrap();
        let table_path = project.create_table("Values.table.toml".into()).unwrap();
        let mut before = project.tables_data[&table_path].data.clone();
        let mut row = crate::Record::new();
        row.tags = vec!["old".into()];
        before.records.push(row);
        let table_before = crate::table_storage::to_toml(&before).unwrap().into_bytes();
        std::fs::write(&table_path, &table_before).unwrap();
        let project_before = std::fs::read(&project.path).unwrap();
        let mut next = project.project_data.clone();
        next.tag_presets = vec!["new".into()];
        let project_after = toml::to_string(&next).unwrap().into_bytes();
        let mut after = before.clone();
        super::replace(&mut after, "old", "new");
        let table_after = crate::table_storage::to_toml(&after).unwrap().into_bytes();
        let _journal = crate::tag_transaction_journal::Journal::prepare(
            project.path.parent().unwrap(),
            &project.path,
            &[
                (
                    project.path.clone(),
                    project_after.clone(),
                    Some(project_before.clone()),
                ),
                (table_path.clone(), table_after, Some(table_before.clone())),
            ],
        )
        .unwrap();
        // Simulate process exit after the registry was published but before tables.
        std::fs::write(&project.path, project_after).unwrap();
        assert!(project.save_project().is_err());
        let reopened = crate::Project::open_project(project.path.to_str().unwrap()).unwrap();
        assert_eq!(reopened.project_data.tag_presets, ["old"]);
        assert_eq!(std::fs::read(&project.path).unwrap(), project_before);
        assert_eq!(std::fs::read(&table_path).unwrap(), table_before);
        assert!(!crate::tag_transaction_journal::pending(
            project.path.parent().unwrap()
        ));
    }
    #[test]
    fn unchanged_tags_validation_scales_to_one_hundred_thousand_rows() {
        let mut before = crate::cell_rules::canonical_revision_tests::full_table();
        before.records = (0..100_000)
            .map(|_| {
                let mut row = crate::Record::new();
                row.tags = vec!["registered".into(), "orphan".into()];
                row
            })
            .collect();
        let mut after = before.clone();
        after
            .records
            .last_mut()
            .unwrap()
            .memo_texts
            .insert("column".into(), "unrelated edit".into());
        let started = std::time::Instant::now();
        super::validate_transition(&["registered".into()], &before, &after).unwrap();
        eprintln!(
            "100000-row unchanged tag validation: {:?}",
            started.elapsed()
        );
        after.records.last_mut().unwrap().tags[1] = "corrected_orphan".into();
        let started = std::time::Instant::now();
        super::validate_transition(&["registered".into()], &before, &after).unwrap();
        eprintln!("100000-row changed tag validation: {:?}", started.elapsed());
    }
}
