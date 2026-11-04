//! Project-local duplication, preserving internal references while assigning new identities.
use crate::column::ColumnSchema;
use crate::interface::{Interface, InterfaceChange};
use crate::{DevcelError, Project, Result, TableData, ValueType};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

fn invalid(message: impl Into<String>) -> DevcelError {
    DevcelError::InvalidOperation(message.into())
}
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn map_id(value: &mut String, ids: &HashMap<String, String>) {
    if let Some(id) = ids.get(value) {
        *value = id.clone();
    }
}
fn collect_columns(value: &Value, ids: &mut HashMap<String, String>) {
    match value {
        Value::Object(object) => {
            if object.contains_key("data_type") && object.contains_key("data_name") {
                if let Some(id) = object.get("uuid").and_then(Value::as_str) {
                    ids.entry(id.into()).or_insert_with(new_id);
                }
            }
            for value in object.values() {
                collect_columns(value, ids);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_columns(value, ids);
            }
        }
        _ => {}
    }
}
fn remap_metadata(value: &mut Value, key: &str, ids: &HashMap<String, String>) {
    // Cell payloads are user data, even when a column is named "uuid" or "extends".
    // Typed references have already been remapped separately.
    if key == "values" {
        return;
    }
    match value {
        Value::String(text)
            if matches!(
                key,
                "uuid"
                    | "current_version_id"
                    | "version_id"
                    | "parent_version_id"
                    | "second_parent_id"
                    | "interface_uuid"
                    | "interface_origin"
                    | "extends"
                    | "new_extends"
                    | "target_table_uuid"
                    | "display_column_uuid"
                    | "synced_version_id"
                    | "required_column_uuids"
                    | "interface_order"
            ) =>
        {
            map_id(text, ids)
        }
        Value::Array(values) => {
            for value in values {
                remap_metadata(value, key, ids);
            }
        }
        Value::Object(object) => {
            // These maps use column UUID keys, but their values are plain payloads.
            if !matches!(key, "interface_values" | "memo_texts") {
                for (key, value) in object.iter_mut() {
                    remap_metadata(value, key, ids);
                }
            }
            if matches!(
                key,
                "history" | "interface_implementations" | "interface_values" | "memo_texts"
            ) {
                let old = std::mem::take(object);
                for (mut key, value) in old {
                    map_id(&mut key, ids);
                    object.insert(key, value);
                }
            }
        }
        _ => {}
    }
}
type RecordIds = HashMap<String, HashMap<String, String>>;

fn remap_cell(
    value: &mut String,
    data_type: &ValueType,
    target_table: Option<&str>,
    ids: &HashMap<String, String>,
    record_ids: &RecordIds,
) {
    match data_type {
        ValueType::TableRef => map_id(value, ids),
        ValueType::Reference => {
            if let Some(map) = target_table.and_then(|target| record_ids.get(target)) {
                map_id(value, map);
            }
        }
        _ => {}
    }
}

fn remap_default(column: &mut ColumnSchema, ids: &HashMap<String, String>, records: &RecordIds) {
    remap_cell(
        &mut column.default_value,
        &column.data_type,
        column
            .reference_config
            .as_ref()
            .map(|c| c.target_table_uuid.as_str()),
        ids,
        records,
    );
}

fn remap_history_defaults(
    changes: &mut Vec<InterfaceChange>,
    mut columns: Vec<ColumnSchema>,
    ids: &HashMap<String, String>,
    records: &RecordIds,
) {
    // Track definitions at each change, rather than using today's names/types.
    // Reference configuration IDs are still original IDs until remap_metadata.
    let original_changes = std::mem::take(changes);
    for mut change in original_changes {
        let mut default_correction = None;
        match &mut change {
            InterfaceChange::AddColumn { column } => {
                columns.push(column.clone());
                remap_default(column, ids, records);
            }
            InterfaceChange::RemoveColumn { column_name } => {
                columns.retain(|c| &c.data_name != column_name);
            }
            InterfaceChange::ModifyColumn {
                column_name,
                new_type,
                ..
            } => {
                if let Some(column) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    let mut before = column.clone();
                    remap_default(&mut before, ids, records);
                    column.data_type = new_type.clone();
                    let mut after = column.clone();
                    remap_default(&mut after, ids, records);
                    if before.default_value != after.default_value {
                        // A type-only change retains the original default. Replay
                        // needs an explicit correction when its ID interpretation
                        // changes, especially Reference <-> String. Keep the DAG
                        // intact while preserving the value at every version.
                        default_correction = Some(InterfaceChange::ChangeDefault {
                            column_name: column_name.clone(),
                            new_default: Some(after.default_value),
                        });
                    }
                }
            }
            InterfaceChange::RenameColumn { old_name, new_name } => {
                if let Some(column) = columns.iter_mut().find(|c| &c.data_name == old_name) {
                    column.data_name = new_name.clone();
                }
            }
            InterfaceChange::ChangeDefault {
                column_name,
                new_default,
            } => {
                if let Some(column) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    column.default_value = new_default.clone().unwrap_or_default();
                    if let Some(value) = new_default {
                        remap_cell(
                            value,
                            &column.data_type,
                            column
                                .reference_config
                                .as_ref()
                                .map(|c| c.target_table_uuid.as_str()),
                            ids,
                            records,
                        );
                    }
                }
            }
            _ => {}
        }
        changes.push(change);
        if let Some(correction) = default_correction {
            changes.push(correction);
        }
    }
}

fn remap_interface_defaults(
    interface: &mut Interface,
    ids: &HashMap<String, String>,
    records: &RecordIds,
) -> Result<()> {
    // Replay only the original DAG: remapping an earlier version first would
    // otherwise make later Reference defaults look up already-renamed tables.
    let mut original = interface.clone();
    for column in &mut interface.columns {
        remap_default(column, ids, records);
    }
    for version in interface.history.values_mut() {
        let columns = if let Some(parent) = version.parent_version_id {
            original.current_version_id = parent;
            original.rebuild_current_columns()?;
            original.columns.clone()
        } else {
            Vec::new()
        };
        remap_history_defaults(&mut version.changes, columns, ids, records);
        if let Some(merge) = &mut version.merge_info {
            original.current_version_id = merge.second_parent_id;
            original.rebuild_current_columns()?;
            remap_history_defaults(
                &mut merge.second_parent_changes,
                original.columns.clone(),
                ids,
                records,
            );
        }
    }
    Ok(())
}

fn visit(path: &Path, result: &mut Vec<PathBuf>) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(DevcelError::Io)?;
    if meta.file_type().is_symlink() {
        return Err(invalid("Cannot duplicate content containing symlinks"));
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path).map_err(DevcelError::Io)? {
            visit(&entry.map_err(DevcelError::Io)?.path(), result)?;
        }
    } else if meta.is_file() {
        result.push(path.to_path_buf());
    } else {
        return Err(invalid("Only regular files can be duplicated"));
    }
    Ok(())
}
fn unique(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.into();
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let (stem, ext) = if let Some(stem) = name.strip_suffix(".table.toml") {
        (stem, ".table.toml")
    } else if let Some(stem) = name.strip_suffix(".interface.toml") {
        (stem, ".interface.toml")
    } else if path.is_dir() {
        (name.as_ref(), "")
    } else if let Some((stem, ext)) = name.rsplit_once('.') {
        (stem, &name[stem.len()..stem.len() + ext.len() + 1])
    } else {
        (name.as_ref(), "")
    };
    for n in 1.. {
        let candidate = path.with_file_name(format!("{stem}_{n}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Copies within Tables only. Unknown regular files are byte-preserved, never interpreted.
/// Interface DAGs retain their shape with new IDs; references to items outside the copied set remain external.
pub fn duplicate_entry(
    project: &mut Project,
    source: &Path,
    destination: &Path,
) -> Result<PathBuf> {
    let root = project
        .path
        .parent()
        .ok_or_else(|| invalid("Project path is invalid"))?
        .join("Tables")
        .canonicalize()
        .map_err(DevcelError::Io)?;
    let resolve = |path: &Path| -> Result<PathBuf> {
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(invalid("Parent traversal is not allowed"));
        }
        Ok(if path.is_absolute() {
            path.into()
        } else {
            root.join(path)
        })
    };
    let source = resolve(source)?;
    let destination = resolve(destination)?;
    if fs::symlink_metadata(&source)
        .map_err(DevcelError::Io)?
        .file_type()
        .is_symlink()
    {
        return Err(invalid("symlink cannot be copied"));
    }
    let source = source.canonicalize().map_err(DevcelError::Io)?;
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("Destination has no parent"))?
        .canonicalize()
        .map_err(DevcelError::Io)?;
    let destination = parent.join(
        destination
            .file_name()
            .ok_or_else(|| invalid("Destination name is invalid"))?,
    );
    if source == root
        || !source.starts_with(&root)
        || !parent.starts_with(&root)
        || (source.is_dir() && destination.starts_with(&source))
    {
        return Err(invalid(
            "The source and destination must be different locations within Tables",
        ));
    }
    let destination = unique(&destination);
    let mut files = Vec::new();
    visit(&source, &mut files)?;
    files.sort();
    let mut interfaces = HashMap::new();
    let mut tables = HashMap::new();
    let mut ids = HashMap::new();
    let mut record_ids = RecordIds::new();
    for path in &files {
        let name = path.to_string_lossy();
        if name.ends_with(".interface.toml") {
            let interface = Interface::load_from_file(path)?;
            ids.insert(interface.uuid.to_string(), new_id());
            for id in interface.history.keys() {
                ids.insert(id.to_string(), new_id());
            }
            let value = serde_json::to_value(&interface).map_err(|e| invalid(e.to_string()))?;
            collect_columns(&value, &mut ids);
            interfaces.insert(path.clone(), interface);
        } else if name.ends_with(".table.toml") {
            let table = if let Some(table) = project.tables_data.get(path) {
                table.data.clone()
            } else {
                TableData::from_toml(&fs::read_to_string(path)?)?
            };
            table.validate_storage_contract()?;
            Interface::validate_table_column_ids(&table, &project.interface_registry)?;
            ids.insert(table.uuid.clone(), new_id());
            for col in &table.schema.columns {
                if col.interface_origin.is_none() {
                    ids.entry(col.uuid.clone()).or_insert_with(new_id);
                }
            }
            record_ids.insert(
                table.uuid.clone(),
                table
                    .records
                    .iter()
                    .map(|r| (r.uuid.clone(), new_id()))
                    .collect(),
            );
            tables.insert(path.clone(), table);
        }
    }
    let directory = source.is_dir();
    let mut candidates = HashMap::with_capacity(tables.len());
    for (path, mut table) in tables {
        let old_table_id = table.uuid.clone();
        let records = &record_ids[&old_table_id];
        for record in &mut table.records {
            for column in &table.schema.columns {
                let value = if column.interface_origin.is_some() {
                    record.interface_values.get_mut(&column.uuid)
                } else {
                    record.values.get_mut(&column.data_name)
                };
                if let Some(value) = value {
                    remap_cell(
                        value,
                        &column.data_type,
                        column
                            .reference_config
                            .as_ref()
                            .map(|c| c.target_table_uuid.as_str()),
                        &ids,
                        &record_ids,
                    );
                }
            }
            map_id(&mut record.uuid, records);
            map_id(&mut record.parent_uuid, records);
        }
        for column in &mut table.schema.columns {
            remap_default(column, &ids, &record_ids);
        }
        map_id(&mut table.metadata.parent_uuid, &ids);
        let mut value = serde_json::to_value(table).map_err(|e| invalid(e.to_string()))?;
        remap_metadata(&mut value, "", &ids);
        let mut table: TableData = TableData::from_json_value(value)?;
        for implementation in table.interface_implementations.values_mut() {
            implementation.effective_fingerprint = None;
        }
        if !directory {
            let name = destination
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .trim_end_matches(".table.toml")
                .to_string();
            table.metadata.data_name = name.clone();
            table.display_name = name;
        }
        candidates.insert(path, table);
    }
    let tables = candidates;
    let overrides: Vec<_> = tables.values().collect();
    let formula_context = crate::formula_context::ProjectFormulaContext::new_with_overrides(
        project, None, &overrides,
    )?;
    let mut evaluate =
        |data: &TableData, column: &ColumnSchema, record: &crate::Record, formula: &str| {
            formula_context.evaluate_cell_with_override(data, column, record, formula)
        };
    let staging = root
        .parent()
        .ok_or_else(|| invalid("Project root is invalid"))?
        .join(format!(".devcel-copy-{}", new_id()));
    if directory {
        fs::create_dir(&staging).map_err(DevcelError::Io)?;
    }
    let operation = (|| -> Result<()> {
        // Preserve empty subdirectories too, without following links.
        if directory {
            fn dirs(src: &Path, dst: &Path) -> Result<()> {
                for entry in fs::read_dir(src).map_err(DevcelError::Io)? {
                    let entry = entry.map_err(DevcelError::Io)?;
                    if entry.file_type().map_err(DevcelError::Io)?.is_dir() {
                        let target = dst.join(entry.file_name());
                        fs::create_dir(&target).map_err(DevcelError::Io)?;
                        dirs(&entry.path(), &target)?;
                    }
                }
                Ok(())
            }
            dirs(&source, &staging)?;
        }
        for path in &files {
            let target = if directory {
                staging.join(
                    path.strip_prefix(&source)
                        .map_err(|e| invalid(e.to_string()))?,
                )
            } else {
                staging.clone()
            };
            let bytes = if let Some(mut interface) = interfaces.remove(path) {
                remap_interface_defaults(&mut interface, &ids, &record_ids)?;
                let mut value =
                    serde_json::to_value(interface).map_err(|e| invalid(e.to_string()))?;
                remap_metadata(&mut value, "", &ids);
                let mut interface: Interface = serde_json::from_value(value)?;
                if !directory {
                    interface.name = destination
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .trim_end_matches(".interface.toml")
                        .into();
                }
                interface.validate_storage_contract()?;
                toml::to_string_pretty(&interface)
                    .map_err(|e| invalid(e.to_string()))?
                    .into_bytes()
            } else if let Some(table) = tables.get(path) {
                let mut empty = table.clone();
                empty.records.clear();
                crate::cell_rules::validate_transition_with_evaluator(
                    &project.project_data.uuid,
                    &empty,
                    table,
                    None,
                    &mut evaluate,
                )?;
                crate::table_storage::to_toml(table)?.into_bytes()
            } else {
                fs::read(path).map_err(DevcelError::Io)?
            };
            fs::write(&target, bytes).map_err(DevcelError::Io)?;
        }
        crate::utils::rename_without_replace(&staging, &destination)?;
        Ok(())
    })();
    if operation.is_err() {
        if directory {
            let _ = fs::remove_dir_all(&staging);
        } else {
            let _ = fs::remove_file(&staging);
        }
    }
    operation?;
    project.reload_interfaces()?;
    for path in files {
        if path.to_string_lossy().ends_with(".table.toml") {
            let new_path = if directory {
                destination.join(
                    path.strip_prefix(&source)
                        .map_err(|e| invalid(e.to_string()))?,
                )
            } else {
                destination.clone()
            };
            project.load_table(&new_path)?;
        }
    }
    project.notify_interface_change(&destination);
    Ok(destination)
}
