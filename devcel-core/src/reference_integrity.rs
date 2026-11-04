//! Restrict row deletion against the final atomic transaction state.
//! Deletions and reference writes bind persisted dependencies to their commit.
use crate::{DevcelError, Project, Result, TableData};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub(crate) type DeletedRecords = HashMap<String, HashSet<String>>;

pub(crate) fn collect_deleted(before: &TableData, after: &TableData, deleted: &mut DeletedRecords) {
    if before.records.len() == after.records.len()
        && before
            .records
            .iter()
            .zip(&after.records)
            .all(|(a, b)| a.uuid == b.uuid)
    {
        return;
    }
    let surviving: HashSet<_> = after.records.iter().map(|r| r.uuid.as_str()).collect();
    let removed: HashSet<_> = before
        .records
        .iter()
        .filter(|r| !surviving.contains(r.uuid.as_str()))
        .map(|r| r.uuid.clone())
        .collect();
    if !removed.is_empty() {
        deleted.insert(before.uuid.clone(), removed);
    }
}

pub(crate) const INVENTORY_REVISION: &str = "inventory:";

pub(crate) fn inventory_revision(root: &Path) -> Result<String> {
    let mut paths = Vec::new();
    crate::table_catalog::find_table_paths(root, &mut paths, true)?;
    paths.sort();
    Ok(format!(
        "{INVENTORY_REVISION}{}",
        crate::project_tags::raw_revision(&serde_json::to_vec(&paths)?)
    ))
}

/// Bind reference validation to actual disk snapshots, including read-only
/// dependencies. Publication locks and rechecks this read set before any write.
pub(crate) fn validate_deletions(
    project: &mut Project,
    deleted: &DeletedRecords,
    overrides: &[&TableData],
) -> Result<HashMap<PathBuf, String>> {
    let targets: HashSet<_> = overrides
        .iter()
        .flat_map(|data| {
            data.schema
                .columns
                .iter()
                .filter(|column| {
                    data.records.iter().any(|row| {
                        data.effective_cell_input(row, column)
                            .map_or(true, |value| !value.is_empty())
                    })
                })
                .filter_map(|c| {
                    c.reference_config
                        .as_ref()
                        .map(|r| r.target_table_uuid.clone())
                })
        })
        .collect();
    if deleted.is_empty() && targets.is_empty() {
        return Ok(HashMap::new());
    }
    let root = project.resolve_table_path(&PathBuf::new())?;
    let inventory = inventory_revision(&root)?;
    let mut paths = Vec::new();
    if !deleted.is_empty() {
        crate::table_catalog::find_table_paths(&root, &mut paths, true)?;
    } else {
        for target in &targets {
            let entry = project
                .get_table_catalog()?
                .into_iter()
                .find(|entry| &entry.uuid == target)
                .ok_or_else(|| {
                    DevcelError::Validation(
                        "A referenced table is missing. Reload before editing".into(),
                    )
                })?;
            paths.push(PathBuf::from(entry.path));
        }
    }
    paths.sort();
    paths.dedup();
    let mut expected = HashMap::new();
    let mut disk_tables = Vec::new();
    for path in paths {
        project.resolve_table_path(&path)?;
        let raw = std::fs::read(&path)?;
        let data = TableData::from_toml(
            std::str::from_utf8(&raw)
                .map_err(|error| DevcelError::Validation(error.to_string()))?,
        )?;
        // A stale cached reader is not authority to delete or create references.
        // Never replace its draft silently; require an explicit reload instead.
        if !overrides
            .iter()
            .any(|candidate| candidate.uuid == data.uuid)
        {
            if let Some(live) = project.find_table_by_uuid(&data.uuid) {
                if crate::cell_rules::revision(&live.data) != crate::cell_rules::revision(&data) {
                    return Err(DevcelError::Validation(
                        "A reference dependency changed on disk. Reload before editing".into(),
                    ));
                }
            }
        }
        expected.insert(
            path,
            format!("raw:{}", crate::project_tags::raw_revision(&raw)),
        );
        disk_tables.push(data);
    }
    if inventory_revision(&root)? != inventory {
        return Err(DevcelError::Validation(
            "The table inventory changed. Retry after reload".into(),
        ));
    }
    expected.insert(root, inventory);
    if deleted.is_empty() {
        return Ok(expected);
    }
    // Formula references see fresh persisted dependencies and this transaction's
    // final candidates, not stale loaded siblings or an intermediate deletion.
    let final_tables: Vec<_> = disk_tables
        .iter()
        .filter(|data| {
            !overrides
                .iter()
                .any(|candidate| candidate.uuid == data.uuid)
        })
        .chain(overrides.iter().copied())
        .collect();
    let context = crate::formula_context::ProjectFormulaContext::new_with_overrides(
        project,
        None,
        &final_tables,
    )?;
    for data in final_tables {
        if let Some(removed) = deleted.get(&data.uuid) {
            if data
                .records
                .iter()
                .any(|r| removed.contains(&r.parent_uuid))
            {
                return Err(DevcelError::InvalidOperation("Cannot delete a parent row while child rows remain. Delete the parent and children together".into()));
            }
        }
        let mut resolver = None;
        for column in &data.schema.columns {
            let Some(config) = &column.reference_config else {
                continue;
            };
            let Some(removed) = deleted.get(&config.target_table_uuid) else {
                continue;
            };
            let resolver =
                resolver.get_or_insert_with(|| crate::table::InheritanceResolver::new(data));
            for (record_index, record) in data.records.iter().enumerate() {
                let value = reference_value(&context, data, column, record, resolver)?;
                if removed.contains(&value) {
                    return Err(DevcelError::Diagnostics(vec![
                        crate::types::Diagnostic::Code {
                            code: "error.referencedRowDelete".into(),
                            params: serde_json::json!({ "table": data.display_name, "row": record.display_label_diagnostic(record_index), "column": column.display_name }),
                        },
                    ]));
                }
            }
        }
    }
    Ok(expected)
}

pub(crate) fn reference_value<'a>(
    context: &crate::formula_context::ProjectFormulaContext<'_>,
    data: &'a TableData,
    column: &'a crate::ColumnSchema,
    record: &'a crate::Record,
    resolver: &crate::table::InheritanceResolver<'a>,
) -> Result<String> {
    let raw = resolver.input(record, column)?;
    if raw.starts_with('=') {
        match context.evaluate_cell_with_override(data, column, record, raw) {
            crate::types::FormulaResult::Value(value) => Ok(value),
            crate::types::FormulaResult::Error(error) => {
                Err(DevcelError::Diagnostics(vec![error.diagnostic()]))
            }
        }
    } else {
        Ok(raw.to_owned())
    }
}
