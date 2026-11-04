//! Server-authoritative in-memory replication. Snapshots contain resolved data,
//! not commands: replaying commands would generate different record/column and
//! interface version UUIDs. Disk writes belong to the original editing instance.
use crate::app_error::diagnostic;
use crate::interface::{Interface, InterfaceRegistry};
use crate::project_impl::ProjectFileData;
use crate::table::{Table, TableData};
use crate::types::ProjectEntryType;
use crate::{Project, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot<T = TableData> {
    format: u32,
    project: ProjectFileData,
    /// Complete file inventory, including tables not loaded on the server.
    table_paths: Vec<String>,
    tables: HashMap<String, T>,
    interfaces: Vec<(String, Interface)>,
}

fn relative_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || path.to_string_lossy().contains('\\')
    {
        return Err(diagnostic(
            "error.invalidPath",
            json!({"path": path.to_string_lossy()}),
        ));
    }
    Ok(())
}

pub fn capture(project: &Project) -> Result<serde_json::Value> {
    let root = project
        .path
        .parent()
        .ok_or_else(|| diagnostic("error.invalidPath", json!({})))?
        .join("Tables");
    let relative = |path: &Path| -> Result<String> {
        let path = if let Ok(relative) = path.strip_prefix(&root) {
            relative
        } else if path.is_absolute() {
            return Err(diagnostic(
                "error.invalidPath",
                json!({"path": path.to_string_lossy()}),
            ));
        } else {
            path
        };
        #[cfg(windows)]
        let normalized = path.to_string_lossy().replace('\\', "/");
        #[cfg(not(windows))]
        let normalized = path.to_string_lossy().to_string();
        relative_path(Path::new(&normalized))?;
        Ok(normalized)
    };
    let mut table_paths = project
        .get_project_entries()?
        .into_iter()
        .filter(|e| e.entry_type == ProjectEntryType::Table)
        .map(|e| relative(Path::new(&e.path)))
        .collect::<Result<Vec<_>>>()?;
    table_paths.sort();
    let tables = project
        .tables_data
        .iter()
        .map(|(path, table)| Ok((relative(path)?, table.data.clone())))
        .collect::<Result<HashMap<_, _>>>()?;
    let mut interfaces: Vec<_> = project
        .interface_registry
        .get_all_interfaces_with_paths()
        .into_iter()
        .map(|(path, interface)| (path.clone(), interface.clone()))
        .collect();
    interfaces.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(serde_json::to_value(Snapshot {
        format: 1,
        project: project.project_data.clone(),
        table_paths,
        tables,
        interfaces,
    })?)
}

/// Validate the complete snapshot before changing any part of the live project.
/// Paths are relative and cannot choose another project or write files.
/// Deletion checks may read incoming-reference tables from the local catalog.
pub(crate) fn apply(project: &mut Project, value: serde_json::Value) -> Result<()> {
    let raw: Snapshot<serde_json::Value> = serde_json::from_value(value)?;
    // Decode application storage contracts outside serde's string-only error channel.
    let snapshot = Snapshot {
        format: raw.format,
        project: raw.project,
        table_paths: raw.table_paths,
        tables: raw
            .tables
            .into_iter()
            .map(|(path, value)| TableData::from_json_value(value).map(|data| (path, data)))
            .collect::<Result<HashMap<_, _>>>()?,
        interfaces: raw.interfaces,
    };
    if snapshot.format != 1 || snapshot.project.uuid != project.project_data.uuid {
        return Err(diagnostic(
            "error.replication.snapshotIdentity",
            json!({"format": snapshot.format, "id": snapshot.project.uuid}),
        ));
    }
    let root = project
        .path
        .parent()
        .ok_or_else(|| diagnostic("error.invalidPath", json!({})))?
        .join("Tables");
    let mut inventory = HashSet::new();
    for path in &snapshot.table_paths {
        relative_path(Path::new(path))?;
        if !inventory.insert(root.join(path)) {
            return Err(diagnostic(
                "error.replication.duplicateIdentity",
                json!({"item": path}),
            ));
        }
    }
    let mut table_ids = HashSet::new();
    for (path, data) in &snapshot.tables {
        data.validate_storage_contract()?;
        relative_path(Path::new(path))?;
        if !inventory.contains(&root.join(path)) || !table_ids.insert(&data.uuid) {
            return Err(diagnostic(
                "error.replication.tableInventory",
                json!({"id": data.uuid, "path": path}),
            ));
        }
        for column in &data.schema.columns {
            crate::cell_rules::validate_column_definition(column)?;
        }
        let mut columns = HashSet::new();
        let mut records = HashSet::new();
        if data
            .schema
            .columns
            .iter()
            .any(|c| c.uuid.is_empty() || !columns.insert(&c.uuid))
            || data
                .records
                .iter()
                .any(|r| r.uuid.is_empty() || !records.insert(&r.uuid))
        {
            return Err(diagnostic(
                "error.replication.emptyIdentity",
                json!({"table": data.uuid}),
            ));
        }
    }
    let mut registry = InterfaceRegistry::new();
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for (path, interface) in snapshot.interfaces {
        relative_path(Path::new(&path))?;
        if !ids.insert(interface.uuid) || !paths.insert(path.clone()) {
            return Err(diagnostic(
                "error.replication.duplicateIdentity",
                json!({"item": path, "id": interface.uuid}),
            ));
        }
        for column in &interface.columns {
            crate::cell_rules::validate_column_definition(column)?;
        }
        interface.validate_storage_contract()?;
        registry.add_interface_with_path(path, interface)?;
    }
    // Run validation again with all parents present, independent of map order.
    for interface in registry.get_all_interfaces() {
        interface.check_circular_dependency(&registry, &mut HashSet::new())?;
    }
    let mut replacements: Vec<(PathBuf, TableData, bool)> = Vec::new();
    for (path, data) in snapshot.tables {
        let path = root.join(path);
        Interface::validate_table_column_ids(&data, &registry)?;
        // An unopened local table still supplies the before-state for row deletion.
        if !project.tables_data.contains_key(&path) && path.exists() {
            project.ensure_table_loaded_with_save_queue(&path, None, None)?;
        }
        let changed = match project.tables_data.get(&path) {
            Some(old) => serde_json::to_value(&old.data)? != serde_json::to_value(&data)?,
            None => true,
        };
        replacements.push((path, data, changed));
    }
    let mut deleted = crate::reference_integrity::DeletedRecords::new();
    for (path, data, _) in &replacements {
        if let Some(before) = project.tables_data.get(path) {
            crate::reference_integrity::collect_deleted(&before.data, data, &mut deleted);
        }
    }
    let final_tables: Vec<_> = replacements.iter().map(|(_, data, _)| data).collect();
    crate::reference_integrity::validate_deletions(project, &deleted, &final_tables)?;
    // Invalidate the entire shared transaction history when any participant is
    // replaced or removed, before changing the table inventory.
    let invalidated: Vec<String> = project
        .tables_data
        .iter()
        .filter(|(path, _)| {
            !inventory.contains(*path)
                || replacements
                    .iter()
                    .any(|(replacement, _, changed)| *changed && replacement == *path)
        })
        .map(|(_, table)| table.data.uuid.clone())
        .collect();
    for uuid in invalidated {
        project.clear_table_undo_redo_stacks(&uuid)?;
    }
    // The origin may have durably saved metadata before its snapshot arrives.
    // Adopt that exact confirmed baseline, never an unrelated newer disk state.
    let confirmed = std::fs::read_to_string(&project.path)
        .ok()
        .and_then(|raw| toml::from_str::<ProjectFileData>(&raw).ok())
        .filter(|persisted| persisted == &snapshot.project);
    if let Some(persisted) = confirmed {
        project.project_disk_baseline = Some(persisted);
    }
    project.project_data = snapshot.project;
    project.replace_replica_interfaces(registry);
    project
        .tables_data
        .retain(|path, _| inventory.contains(path));
    for (path, data, changed) in replacements {
        if !changed {
            continue;
        } // Preserve the origin's own undo history.
        project.tables_data.insert(
            path.clone(),
            Table {
                path,
                data,
                is_dirty: false,
                undo_history: Vec::new(),
                redo_history: Vec::new(),
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod typed_storage_tests {
    use super::*;

    #[test]
    fn snapshot_storage_error_stays_typed_and_does_not_mutate_project() {
        let directory = tempfile::tempdir().unwrap();
        let mut project =
            Project::create_project("Replica", directory.path().to_str().unwrap(), "", "#123456")
                .unwrap();
        let path = project.create_table("Values.table.toml".into()).unwrap();
        project.load_table(&path).unwrap();
        project
            .tables_data
            .get_mut(&path)
            .unwrap()
            .data
            .schema
            .columns
            .push(crate::ColumnSchema {
                data_name: "value".into(),
                display_name: "value".into(),
                ..Default::default()
            });
        let before = capture(&project).unwrap();
        let mut malformed = before.clone();
        let table = malformed["tables"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        table["schema"]["columns"][0]["data_name"] = json!("");
        let error = apply(&mut project, malformed).unwrap_err();
        let error = serde_json::to_value(crate::AppError::from(error)).unwrap();
        assert_eq!(
            error["diagnostics"][0]["code"],
            "column.validation.emptyName"
        );
        assert_eq!(capture(&project).unwrap(), before);
        apply(&mut project, before.clone()).unwrap();
        assert_eq!(capture(&project).unwrap(), before);
    }

    #[test]
    fn confirmed_snapshot_metadata_advances_only_its_matching_disk_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let mut origin = Project::create_project(
            "MetadataReplica",
            directory.path().to_str().unwrap(),
            "old",
            "#123456",
        )
        .unwrap();
        let mut replica = Project::open_project(&origin.get_project_path()).unwrap();
        origin.project_data.project_description = "saved remotely".into();
        origin.save_project().unwrap();
        let snapshot = capture(&origin).unwrap();
        apply(&mut replica, snapshot.clone()).unwrap();
        replica.save_project().unwrap();
        origin.project_data.project_description = "newer external change".into();
        origin.save_project().unwrap();
        let newest = std::fs::read(&origin.path).unwrap();
        apply(&mut replica, snapshot).unwrap();
        assert!(replica.save_project().is_err());
        assert_eq!(std::fs::read(&origin.path).unwrap(), newest);
    }
}
