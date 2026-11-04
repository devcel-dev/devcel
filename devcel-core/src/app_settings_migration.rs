//! Source-level three-way upgrades of ordinary personal settings projects.
//!
//! The caller owns the staging directory and keeps the old project as a recovery
//! copy. Stable table, column and row UUIDs are the migration contract. There is
//! no historical JSON compatibility. Explicit release steps are supplied by the
//! caller. The retired bundled sample has a narrow, identity-bound cleanup.
use crate::{DevcelError, Result, TableData};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use toml::Value;

#[derive(Clone)]
struct Document {
    path: PathBuf,
    value: Value,
}
type Documents = BTreeMap<String, Document>;
fn invalid(message: impl Into<String>) -> DevcelError {
    DevcelError::Validation(message.into())
}

/// Upgrade a fresh current-standard project in place. Inputs may be project files
/// or directories containing exactly one `.devcelproj.toml` file. Only the new
/// staging project is written. Unrecognized destructive changes return an error;
/// the caller must retain the previous project and must not activate this stage.
pub fn merge_projects(
    old_baseline: &Path,
    old_user: &Path,
    new_project: &Path,
    validator: &dyn Fn(&Path) -> Result<()>,
) -> Result<Vec<String>> {
    merge_projects_with_steps(old_baseline, old_user, new_project, &[], validator)
}

/// Ordered, explicitly reviewed release transforms. A skipped upgrade applies
/// the same ordered steps after the identity-bound bundled-sample cleanup.
pub enum MigrationStep<'a> {
    ConvertColumn {
        table_uuid: &'a str,
        column_uuid: &'a str,
        from: crate::ValueType,
        to: crate::ValueType,
        convert: fn(&str) -> Result<String>,
    },
    RemoveColumn {
        table_uuid: &'a str,
        column_uuid: &'a str,
    },
}

pub fn merge_projects_with_steps(
    old_baseline: &Path,
    old_user: &Path,
    new_project: &Path,
    steps: &[MigrationStep<'_>],
    validator: &dyn Fn(&Path) -> Result<()>,
) -> Result<Vec<String>> {
    let (new_root, project_file) = project_location(new_project)?;
    let (base_root, base_project_file) = project_location(old_baseline)?;
    let (user_root, user_project_file) = project_location(old_user)?;
    if new_root.starts_with(&base_root)
        || base_root.starts_with(&new_root)
        || new_root.starts_with(&user_root)
        || user_root.starts_with(&new_root)
    {
        return Err(invalid(
            "Settings migration requires a separate staging project",
        ));
    }
    let original_project = fs::read(&project_file)?;
    let merged_project =
        merge_tag_presets(&base_project_file, &user_project_file, &original_project)?;
    // Reject malformed predecessor source before compiling the new standard.
    // Failure retries must not repeatedly pay for unrelated standard validation.
    let mut user = read_documents(&user_root)?;
    let mut base = read_documents(&base_root)?;
    let standard = read_documents(&new_root)?;
    validator(&project_file)?;
    let mut warnings = Vec::new();
    retire_hello_world_sample(&mut base, &mut user, &standard, &mut warnings);
    for step in steps {
        apply_step(&mut base, step)?;
        apply_step(&mut user, step)?;
        if let MigrationStep::RemoveColumn {
            table_uuid,
            column_uuid,
        } = step
        {
            warnings.push(format!("Release migration explicitly retired column {column_uuid} in table {table_uuid}; its prior values remain in the previous project."));
        }
    }
    let mut unsupported = Vec::new();
    let mut merged = standard.clone();
    let ids: BTreeSet<_> = base.keys().chain(user.keys()).cloned().collect();
    for id in ids {
        let b = base.get(&id);
        let u = user.get(&id);
        let n = standard.get(&id);
        if let (Some(b), Some(u), Some(n)) = (b, u, n) {
            if b.value != u.value {
                let columns = |v: &Value| -> BTreeMap<String, Value> {
                    v.get("schema")
                        .and_then(|s| s.get("columns"))
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|c| {
                            Some((
                                c.get("uuid")?.as_str()?.to_owned(),
                                c.get("data_type")?.clone(),
                            ))
                        })
                        .collect()
                };
                let current = columns(&n.value);
                for (column, old_type) in columns(&b.value) {
                    if current.get(&column).is_some_and(|kind| *kind != old_type) {
                        return Err(invalid(format!("Column {column} changed type without an explicit release conversion; the previous user project was retained")));
                    }
                }
            }
        }
        let value = merge_value(
            b.map(|x| &x.value),
            u.map(|x| &x.value),
            n.map(|x| &x.value),
            &id,
            &mut unsupported,
        );
        if let Some(value) = value {
            let path = match (b, u, n) {
                (Some(b), Some(u), _) if b.path != u.path => u.path.clone(),
                (_, _, Some(n)) => n.path.clone(),
                (_, Some(u), _) => u.path.clone(),
                _ => continue,
            };
            merged.insert(id, Document { path, value });
        } else {
            merged.remove(&id);
        }
    }
    if !unsupported.is_empty() {
        return Err(invalid(unsupported.join("\n")));
    }
    // Coupled locales/themes and references are validated as one proposal.
    // A rejected proposal is never published as a partially successful upgrade.
    if let Some(bytes) = &merged_project {
        crate::utils::write_atomic(&project_file, bytes)?;
    }
    if let Err(error) =
        install_and_validate(&new_root, &project_file, &standard, &merged, validator)
    {
        // Attempt both restorations even when one fails; the stage must never
        // activate after rejection and the predecessor inputs remain untouched.
        let project_restore = if merged_project.is_some() {
            crate::utils::write_atomic(&project_file, &original_project)
        } else {
            Ok(())
        };
        let tables_restore = replace_documents(&new_root, &merged, &standard);
        project_restore?;
        tables_restore?;
        return Err(error);
    }
    Ok(warnings)
}

/// Retire only the former bundled sample, never arbitrary user plugin data.
/// Prior source projects are untouched and remain the recovery copy. Repurposed
/// tables/rows are treated as user additions rather than discarded.
fn retire_hello_world_sample(
    base: &mut Documents,
    user: &mut Documents,
    standard: &Documents,
    warnings: &mut Vec<String>,
) {
    const TABLE: &str = "86fb28f4-3974-584c-9aa2-34d044d0c039";
    const STATES: &str = "0de0da47-cf7c-5dce-b945-b6583fec0148";
    const ROW: &str = "6cf1f0b5-5996-5750-810f-9704d49924ca";
    const PLUGIN_ID: &str = "5041794f-89ab-5c1e-a048-55eaaf168f56";
    let is_sample_table = |doc: &Document| {
        doc.value
            .get("metadata")
            .and_then(|m| m.get("data_name"))
            .and_then(Value::as_str)
            == Some("HelloWorldSettings")
    };
    if !standard.contains_key(TABLE) && base.get(TABLE).is_some_and(is_sample_table) {
        let prior = base.remove(TABLE).unwrap();
        if user.get(TABLE).is_some_and(is_sample_table) {
            let removed = user.remove(TABLE).unwrap();
            if removed.value != prior.value {
                warnings.push("The retired Hello World sample settings were removed; their edited values remain in the previous project.".into());
            }
        }
    }
    let rows = |doc: &Document| {
        doc.value
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let is_sample_row = |row: &Value| {
        row.get("uuid").and_then(Value::as_str) == Some(ROW)
            && row
                .get("values")
                .and_then(|v| v.get(PLUGIN_ID))
                .and_then(Value::as_str)
                == Some("hello-world")
    };
    let still_bundled = standard
        .get(STATES)
        .is_some_and(|doc| rows(doc).iter().any(is_sample_row));
    let old_row = base
        .get(STATES)
        .and_then(|doc| rows(doc).into_iter().find(is_sample_row));
    if !still_bundled {
        if let Some(old_row) = old_row {
            for (documents, is_user) in [(base, false), (user, true)] {
                if let Some(records) = documents
                    .get_mut(STATES)
                    .and_then(|doc| doc.value.get_mut("records"))
                    .and_then(Value::as_array_mut)
                {
                    records.retain(|row| {
                        if !is_sample_row(row) { return true; }
                        if is_user && row != &old_row {
                            warnings.push("The retired Hello World sample activation setting was removed; its previous value remains in the previous project.".into());
                        }
                        false
                    });
                }
            }
        }
    }
}

/// Merge only the project vocabulary. Preserve deliberate user ordering and
/// removals, then append newly introduced standard names; an untouched collection
/// advances to the new standard. Missing defaults are empty.
fn merge_tag_presets(base: &Path, user: &Path, new_bytes: &[u8]) -> Result<Option<Vec<u8>>> {
    let read = |bytes: &[u8]| -> Result<crate::project_impl::ProjectFileData> {
        let text = std::str::from_utf8(bytes).map_err(|e| invalid(e.to_string()))?;
        toml::from_str(text).map_err(|e| invalid(e.to_string()))
    };
    let baseline = read(&fs::read(base)?)?;
    let user = read(&fs::read(user)?)?;
    let standard = read(new_bytes)?;
    let presets = if user.tag_presets == baseline.tag_presets {
        standard.tag_presets.clone()
    } else {
        let mut merged = user.tag_presets;
        for name in &standard.tag_presets {
            if !baseline.tag_presets.contains(name) && !merged.contains(name) {
                merged.push(name.clone());
            }
        }
        merged
    };
    if presets == standard.tag_presets {
        return Ok(None);
    }
    let text = std::str::from_utf8(new_bytes).map_err(|e| invalid(e.to_string()))?;
    let mut project: Value = toml::from_str(text).map_err(|e| invalid(e.to_string()))?;
    project
        .as_table_mut()
        .ok_or_else(|| invalid("Invalid project settings"))?
        .insert(
            "tag_presets".into(),
            Value::Array(presets.into_iter().map(Value::String).collect()),
        );
    Ok(Some(
        toml::to_string(&project)
            .map_err(|e| invalid(e.to_string()))?
            .into_bytes(),
    ))
}

fn apply_step(documents: &mut Documents, step: &MigrationStep<'_>) -> Result<()> {
    let (table, column) = match step {
        MigrationStep::ConvertColumn {
            table_uuid,
            column_uuid,
            ..
        }
        | MigrationStep::RemoveColumn {
            table_uuid,
            column_uuid,
        } => (*table_uuid, *column_uuid),
    };
    let Some(doc) = documents.get_mut(table) else {
        return Ok(());
    };
    let columns = doc
        .value
        .get_mut("schema")
        .and_then(|s| s.get_mut("columns"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid("Missing columns"))?;
    let Some(index) = columns
        .iter()
        .position(|c| c.get("uuid").and_then(Value::as_str) == Some(column))
    else {
        return Ok(());
    };
    match step {
        MigrationStep::ConvertColumn {
            from, to, convert, ..
        } => {
            let source = Value::try_from(from).map_err(|e| invalid(e.to_string()))?;
            let target = Value::try_from(to).map_err(|e| invalid(e.to_string()))?;
            let actual = columns[index].get("data_type");
            if actual == Some(&target) {
                return Ok(());
            }
            if actual != Some(&source) {
                return Err(invalid(format!(
                    "Unsupported source type for column {column}"
                )));
            }
            let definition = columns[index].as_table_mut().unwrap();
            if let Some(default) = definition.get("default_value").and_then(Value::as_str) {
                let converted = convert(default)?;
                definition.insert("default_value".into(), Value::String(converted));
            }
            definition.insert("data_type".into(), target);
            if let Some(records) = doc.value.get_mut("records").and_then(Value::as_array_mut) {
                for row in records {
                    for map in ["values", "interface_values"] {
                        if let Some(values) = row.get_mut(map).and_then(Value::as_table_mut) {
                            if let Some(raw) = values.get(column).and_then(Value::as_str) {
                                let converted = convert(raw)?;
                                values.insert(column.to_owned(), Value::String(converted));
                            }
                        }
                    }
                }
            }
        }
        MigrationStep::RemoveColumn { .. } => {
            columns.remove(index);
            if let Some(records) = doc.value.get_mut("records").and_then(Value::as_array_mut) {
                for row in records {
                    for map in ["values", "interface_values", "memo_texts"] {
                        if let Some(values) = row.get_mut(map).and_then(Value::as_table_mut) {
                            values.remove(column);
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn project_location(path: &Path) -> Result<(PathBuf, PathBuf)> {
    let path = fs::canonicalize(path)?;
    let file = if path.is_dir() {
        let mut files = Vec::new();
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".devcelproj.toml")
            {
                files.push(entry.path());
            }
        }
        if files.len() != 1 {
            return Err(invalid("Expected exactly one settings project file"));
        }
        files.remove(0)
    } else {
        path
    };
    Ok((
        file.parent()
            .ok_or_else(|| invalid("Project has no parent"))?
            .to_owned(),
        file,
    ))
}
fn read_documents(root: &Path) -> Result<Documents> {
    fn visit(root: &Path, dir: &Path, out: &mut Documents) -> Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(invalid("Settings migration does not follow symlinks"));
            }
            if kind.is_dir() {
                visit(root, &entry.path(), out)?;
            } else if entry.file_name().to_string_lossy().ends_with(".table.toml") {
                let data = TableData::from_toml(&fs::read_to_string(entry.path())?)?;
                let id = data.uuid.clone();
                let mut value = Value::try_from(&data).map_err(|e| invalid(e.to_string()))?;
                key_cells_by_uuid(&mut value, false)?;
                let doc = Document {
                    path: entry
                        .path()
                        .strip_prefix(root)
                        .map_err(|e| invalid(e.to_string()))?
                        .to_owned(),
                    value,
                };
                if out.insert(id.clone(), doc).is_some() {
                    return Err(invalid(format!("Duplicate table UUID {id}")));
                }
            }
        }
        Ok(())
    }
    let mut docs = BTreeMap::new();
    visit(root, &root.join("Tables"), &mut docs)?;
    Ok(docs)
}
// Raw values use names on disk; modes and interface values already use UUIDs.
// Comparing ordinary values by UUID automatically handles column renames while
// preserving absent cells, explicit empty strings, defaults and inheritance.
fn key_cells_by_uuid(value: &mut Value, to_names: bool) -> Result<()> {
    let mut names = BTreeMap::new();
    if let Some(columns) = value
        .get("schema")
        .and_then(|s| s.get("columns"))
        .and_then(Value::as_array)
    {
        for column in columns {
            if column.get("interface_origin").is_some() {
                continue;
            }
            if let (Some(id), Some(name)) = (
                column.get("uuid").and_then(Value::as_str),
                column.get("data_name").and_then(Value::as_str),
            ) {
                let (from, to) = if to_names { (id, name) } else { (name, id) };
                names.insert(from.to_owned(), to.to_owned());
            }
        }
    }
    if let Some(records) = value.get_mut("records").and_then(Value::as_array_mut) {
        for record in records {
            if let Some(values) = record.get_mut("values").and_then(Value::as_table_mut) {
                let old = std::mem::take(values);
                for (key, value) in old {
                    let name = names.get(&key).ok_or_else(|| {
                        invalid(format!("Cell column {key} is no longer supported"))
                    })?;
                    if values.insert(name.clone(), value).is_some() {
                        return Err(invalid("Column rename caused a cell collision"));
                    }
                }
            }
        }
    }
    Ok(())
}
fn merge_value(
    base: Option<&Value>,
    user: Option<&Value>,
    new: Option<&Value>,
    context: &str,
    warnings: &mut Vec<String>,
) -> Option<Value> {
    if user == base {
        return new.cloned();
    }
    if new == base || user == new {
        return user.cloned();
    }
    if base.is_some() && new.is_none() {
        if user.is_some() {
            warnings.push(format!("An edit to removed standard item {context} could not be preserved; keep the previous project for recovery."));
        }
        return None;
    }
    if let (Some(Value::Table(b)), Some(Value::Table(u)), Some(Value::Table(n))) = (base, user, new)
    {
        let mut merged = toml::map::Map::new();
        let keys: BTreeSet<_> = b.keys().chain(u.keys()).chain(n.keys()).collect();
        for key in keys {
            if let Some(v) = merge_value(
                b.get(key),
                u.get(key),
                n.get(key),
                &format!("{context}.{key}"),
                warnings,
            ) {
                merged.insert(key.clone(), v);
            }
        }
        return Some(Value::Table(merged));
    }
    if let (Some(Value::Array(b)), Some(Value::Array(u)), Some(Value::Array(n))) = (base, user, new)
    {
        let id = |v: &Value| {
            v.get("uuid")
                .and_then(Value::as_str)
                .or_else(|| {
                    if context.ends_with(".options") {
                        v.get("value").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .map(str::to_owned)
        };
        if b.iter().chain(u).chain(n).all(|v| id(v).is_some()) {
            let baseline_order: Vec<_> = b.iter().map(|v| id(v).unwrap()).collect();
            let user_order: Vec<_> = u.iter().map(|v| id(v).unwrap()).collect();
            let new_order: Vec<_> = n.iter().map(|v| id(v).unwrap()).collect();
            // Keep deliberate user ordering (including custom rows). New release
            // items follow in their standard order; never sort user rows by UUID.
            let mut order = if user_order != baseline_order {
                user_order.clone()
            } else {
                new_order.clone()
            };
            for key in new_order.iter().chain(&user_order) {
                if !order.contains(key) {
                    order.push(key.clone());
                }
            }
            let b: BTreeMap<_, _> = b.iter().map(|v| (id(v).unwrap(), v)).collect();
            let u: BTreeMap<_, _> = u.iter().map(|v| (id(v).unwrap(), v)).collect();
            let nm: BTreeMap<_, _> = n.iter().map(|v| (id(v).unwrap(), v)).collect();
            let mut merged = Vec::new();
            for key in order {
                if let Some(v) = merge_value(
                    b.get(&key).copied(),
                    u.get(&key).copied(),
                    nm.get(&key).copied(),
                    &format!("{context}[{key}]"),
                    warnings,
                ) {
                    merged.push(v);
                }
            }
            return Some(Value::Array(merged));
        }
    }
    // A user's explicit scalar/collection edit wins a concurrent standard edit.
    user.cloned()
}
fn install_and_validate(
    root: &Path,
    file: &Path,
    old: &Documents,
    next: &Documents,
    validator: &dyn Fn(&Path) -> Result<()>,
) -> Result<()> {
    replace_documents(root, old, next)?;
    validator(file)
}
fn replace_documents(root: &Path, old: &Documents, next: &Documents) -> Result<()> {
    // Prepare all bytes before touching disk so contract/path collisions cannot
    // partially install a proposal. Actual I/O errors are propagated to caller.
    let mut files = BTreeMap::new();
    for doc in next.values() {
        let mut value = doc.value.clone();
        key_cells_by_uuid(&mut value, true)?;
        let data = TableData::from_toml_value(value)?;
        let bytes = crate::table_storage::to_toml(&data)?;
        if files.insert(doc.path.clone(), bytes).is_some() {
            return Err(invalid("Settings tables have colliding paths"));
        }
    }
    for doc in old.values() {
        if !files.contains_key(&doc.path) && root.join(&doc.path).exists() {
            fs::remove_file(root.join(&doc.path))?;
        }
    }
    for (path, bytes) in files {
        let path = root.join(path);
        fs::create_dir_all(path.parent().ok_or_else(|| invalid("Invalid table path"))?)?;
        fs::write(path, bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reordered_user_rows_survive_new_standard_rows() {
        let row = |id: &str| {
            let mut t = toml::map::Map::new();
            t.insert("uuid".into(), Value::String(id.into()));
            Value::Table(t)
        };
        let base = Value::Array(vec![row("a"), row("b")]);
        let user = Value::Array(vec![row("b"), row("custom-z"), row("a"), row("custom-a")]);
        let new = Value::Array(vec![row("a"), row("b"), row("new")]);
        let mut warnings = Vec::new();
        let result = merge_value(
            Some(&base),
            Some(&user),
            Some(&new),
            "records",
            &mut warnings,
        )
        .unwrap();
        let ids: Vec<_> = result
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["uuid"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["b", "custom-z", "a", "custom-a", "new"]);
        assert!(warnings.is_empty());
    }
    #[test]
    fn concurrent_standard_and_user_select_options_are_both_retained() {
        let option = |value: &str| {
            let mut t = toml::map::Map::new();
            t.insert("value".into(), Value::String(value.into()));
            t.insert("label".into(), Value::String(value.into()));
            Value::Table(t)
        };
        let base = Value::Array(vec![option("en")]);
        let user = Value::Array(vec![option("en"), option("custom")]);
        let new = Value::Array(vec![option("en"), option("new-standard")]);
        let mut warnings = Vec::new();
        let merged = merge_value(
            Some(&base),
            Some(&user),
            Some(&new),
            "locale.select_config.options",
            &mut warnings,
        )
        .unwrap();
        let values: Vec<_> = merged
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["value"].as_str().unwrap())
            .collect();
        assert_eq!(values, vec!["en", "custom", "new-standard"]);
        assert!(warnings.is_empty());
    }
}
