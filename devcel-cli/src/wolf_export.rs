//! Safe WOLF bridge: canonical JSON -> headered UTF-8/BOM CSV and explicit type/UUID maps.
//! No WOLF binary database format is read or written. All CSV fields use string storage.
use devcel_core::{importer_pull, json_export::RuntimeBundle};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const OWNER: &str = ".devcel-owner.json";
const ID_COLUMN: &str = "__devcel_record_uuid";
const DATA_NAME_MARKER: &str = "<<!--DATANAME--!>>";
fn io<T>(result: std::io::Result<T>) -> Result<T> {
    result.map_err(|e| e.to_string())
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}
fn overlaps(a: &Path, b: &Path) -> bool {
    let a = key(a);
    let b = key(b);
    a == b || a.starts_with(&(b.clone() + "/")) || b.starts_with(&(a + "/"))
}
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    path.with_file_name(format!(
        "{}.devcel-{suffix}",
        path.file_name().unwrap().to_string_lossy()
    ))
}
fn reject_links(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        if component == Component::ParentDir {
            return Err("Resolved WOLF output paths must not contain ..".into());
        }
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(format!(
                    "Symlinks are not allowed in WOLF output: {}",
                    current.display()
                ))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
fn lock(path: &Path) -> Result<fs::File> {
    reject_links(path)?;
    let f = io(fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path))?;
    f.try_lock()
        .map_err(|e| format!("Another import is running: {}: {e}", path.display()))?;
    Ok(f)
}
fn quoted(value: &str) -> Result<String> {
    if value.contains('\0') || value.contains(DATA_NAME_MARKER) {
        return Err(
            "Values containing WOLF CSV reserved markers or NUL cannot be imported safely. The source and existing output are preserved"
                .into(),
        );
    }
    Ok(format!("\"{}\"", value.replace('"', "\"\"")))
}
fn csv_line<'a>(values: impl IntoIterator<Item = &'a str>) -> Result<String> {
    let cells: Result<Vec<_>> = values.into_iter().map(quoted).collect();
    Ok(cells?.join(",") + "\r\n")
}
fn materialize(
    bundle: &RuntimeBundle,
    source: &importer_pull::PullSource,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let m = &bundle.manifest;
    if m.schema_version != devcel_core::json_export::RUNTIME_SCHEMA_VERSION
        || m.content_hash.is_empty()
    {
        return Err("WOLF conversion requires canonical schema v1 runtime data".into());
    }
    if m.content_version != source.version {
        return Err("Content Version does not match the configuration. Reimport first".into());
    }
    let mut files = BTreeMap::new();
    let mut mappings = Vec::new();
    let mut table_ids = BTreeSet::new();
    let mut table_names = BTreeSet::new();
    for table in &bundle.tables {
        if table.uuid.is_empty()
            || table.name.is_empty()
            || !table_ids.insert(&table.uuid)
            || !table_names.insert(&table.name)
        {
            return Err("Table names/UUIDs are empty or duplicated".into());
        }
        if table.columns.len() > 99 || table.records.len() > 10000 {
            return Err(format!("{}: WOLF bridge supports at most 99 columns plus a UUID column and 10000 records per type. Data will not be truncated",table.name));
        }
        let file = format!("table_{}.csv", &hash(table.uuid.as_bytes())[..24]);
        let mut csv = String::from("\u{feff}");
        csv += &csv_line(
            std::iter::once(ID_COLUMN).chain(table.columns.iter().map(|c| c.name.as_str())),
        )?;
        let mut column_names = BTreeSet::from([ID_COLUMN]);
        let mut columns = vec![
            json!({"index":0,"name":ID_COLUMN,"devcel_type":"RecordUuid","wolf_type":"string"}),
        ];
        for (index, column) in table.columns.iter().enumerate() {
            if column.name.is_empty() || !column_names.insert(column.name.as_str()) {
                return Err(format!(
                    "{}: Column names are empty, duplicated, or reserved",
                    table.name
                ));
            }
            columns.push(json!({"index":index+1,"name":column.name,"devcel_type":column.data_type,"wolf_type":"string","reference_config":column.reference_config,"table_ref_config":column.table_ref_config,"curve_config":column.curve_config}));
        }
        let mut ids = BTreeSet::new();
        let mut records = Vec::new();
        let mut multiline = false;
        for (index, record) in table.records.iter().enumerate() {
            if record.id.is_empty() || !ids.insert(&record.id) {
                return Err(format!(
                    "{}: Record UUIDs are empty or duplicated",
                    table.name
                ));
            }
            if record
                .values
                .keys()
                .any(|k| !column_names.contains(k.as_str()) || k == ID_COLUMN)
            {
                return Err(format!(
                    "{}: Values exist for undefined columns",
                    table.name
                ));
            }
            let mut row = vec![record.id.clone()];
            for column in &table.columns {
                let raw = record
                    .values
                    .get(&column.name)
                    .cloned()
                    .or_else(|| {
                        column
                            .default_value
                            .clone()
                            .filter(|value| !value.is_empty())
                    })
                    .unwrap_or_else(|| column.data_type.default_value());
                // Devcel's full/minimal runtime values remain exact strings, including U64 and HDR colors.
                if !column.data_type.validate(&raw) {
                    return Err(format!(
                        "{}/{}/{}: Value does not match the type",
                        table.name, record.id, column.name
                    ));
                }
                multiline |= raw.contains(['\r', '\n']);
                row.push(raw);
            }
            csv += &csv_line(row.iter().map(String::as_str))?;
            records.push(json!({"index":index,"uuid":record.id}));
        }
        if files.insert(file.clone(), csv.into_bytes()).is_some() {
            return Err("Table filenames collide".into());
        }
        mappings.push(json!({"table_name":table.name,"table_uuid":table.uuid,"interfaces":table.interfaces,"csv":file,"has_header":true,"record_count":table.records.len(),"contains_multiline_cells":multiline,"columns":columns,"records":records}));
    }
    let schema = json!({"schema_version":1,"source_id":source.id,"namespace":source.namespace,"class_name":source.class_name,"content_version":source.version,"runtime_manifest":bundle.manifest,"encoding":"UTF-8 with BOM","line_ending":"CRLF","csv_dialect":"RFC4180; header row; all fields quoted; doubled quotes; multiline cells unchanged","storage":"Every WOLF DB item must be string. No numeric narrowing or reference-ID conversion is performed.","tables":mappings});
    files.insert(
        "schema.json".into(),
        serde_json::to_vec_pretty(&schema).map_err(|e| e.to_string())?,
    );
    files.insert("IMPORT.txt".into(),format!("Devcel WOLF Import / Configuration ID {}\r\n\r\n1. Back up your game project.\r\n2. Create a dedicated empty variable-database type for each table in schema.json. Do not import into existing types.\r\n3. Create fields in columns index order and make every field a string. Field 0 is the record UUID.\r\n4. Set the data count to record_count and import each CSV using the official CSV import command. The first row contains field names.\r\n5. First validate Japanese text, commas, quotes, and multiline cells with a new test type. Native compatibility testing in WOLF itself is still required.\r\n6. Check the schema and record count when reimporting. Deleted rows may remain in WOLF, so update the dedicated type's data count too.\r\n\r\nI64/U64, floating-point values, HDR colors, Curve, and Reference remain original strings. Values are not truncated, RGB is not clamped, and types are not implicitly converted.\r\nReference/TableRef values are UUIDs. Find table_uuid/records.uuid from the same import configuration in schema.json and map them to indices.\r\nRecord indices may change after reimporting. Use UUIDs as persistent game IDs.\r\nThe CLI and configuration files are not required in the distributed product. After manually importing the data, use WOLF's normal save and distribution process.\r\n",source.id).into_bytes());
    Ok(files)
}
fn inventory(directory: &Path) -> Result<BTreeMap<String, String>> {
    reject_links(directory)?;
    let mut result = BTreeMap::new();
    for item in io(fs::read_dir(directory))? {
        let entry = io(item)?;
        let metadata = io(entry.file_type())?;
        if !metadata.is_file() {
            return Err(format!(
                "The output destination contains an unmanaged directory or symlink: {}",
                entry.path().display()
            ));
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "The output destination contains a non-UTF-8 name".to_string())?;
        if name != OWNER {
            result.insert(name, hash(&io(fs::read(entry.path()))?));
        }
    }
    Ok(result)
}
fn verify_owned(target: &Path, owner: &str) -> Result<()> {
    if !target.exists() {
        return Ok(());
    }
    let found = inventory(target)?;
    let marker: Value =
        serde_json::from_slice(&io(fs::read(target.join(OWNER))).map_err(|_| {
            format!(
                "Will not overwrite an existing unmanaged folder: {}",
                target.display()
            )
        })?)
        .map_err(|e| e.to_string())?;
    if marker.get("schema_version") != Some(&json!(1))
        || marker.get("owner").and_then(Value::as_str) != Some(owner)
    {
        return Err(format!(
            "Will not overwrite output owned by another configuration or unmanaged output: {}",
            target.display()
        ));
    }
    let expected: BTreeMap<String, String> =
        serde_json::from_value(marker["files"].clone()).map_err(|e| e.to_string())?;
    if expected != found {
        return Err(format!("WOLF output has been edited, deleted, or added. Choose another runtime output destination, or back up the output and move the managed folder aside: {}",target.display()));
    }
    Ok(())
}
fn publish(target: &Path, owner: &str, files: BTreeMap<String, Vec<u8>>) -> Result<()> {
    reject_links(target)?;
    verify_owned(target, owner)?;
    let parent = target
        .parent()
        .ok_or("The WOLF output parent folder is missing")?;
    io(fs::create_dir_all(parent))?;
    let name = target.file_name().unwrap().to_string_lossy();
    let stage = parent.join(format!(".{name}.stage-{}", uuid::Uuid::new_v4()));
    let backup = parent.join(format!(".{name}.backup-{}", uuid::Uuid::new_v4()));
    io(fs::create_dir(&stage))?;
    let prepared = (|| {
        let mut hashes = BTreeMap::new();
        for (filename, bytes) in files {
            let mut f = io(fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(stage.join(&filename)))?;
            io(f.write_all(&bytes))?;
            io(f.sync_all())?;
            hashes.insert(filename, hash(&bytes));
        }
        let marker =
            serde_json::to_vec_pretty(&json!({"schema_version":1,"owner":owner,"files":hashes}))
                .map_err(|e| e.to_string())?;
        let mut f = io(fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(stage.join(OWNER)))?;
        io(f.write_all(&marker))?;
        io(f.sync_all())?;
        // Check again immediately before replacing an existing owned generation.
        verify_owned(target, owner)?;
        let had_previous = target.exists();
        if had_previous {
            io(fs::rename(target, &backup))?;
        }
        if let Err(error) = fs::rename(&stage, target) {
            if had_previous {
                fs::rename(&backup, target).map_err(|restore| {
                    format!(
                        "Publication failed: {error}; restoration failed: {restore}; existing output is at {}",
                        backup.display()
                    )
                })?;
            }
            return Err(error.to_string());
        }
        if had_previous {
            fs::remove_dir_all(&backup).map_err(|e| {
                format!(
                    "New output was published, but cleanup of the previous output failed: {}: {e}",
                    backup.display()
                )
            })?;
        }
        Ok(())
    })();
    if stage.exists() {
        let _ = fs::remove_dir_all(&stage);
    }
    prepared
}
/// Convert existing successfully-pulled canonical JSON; never accesses a WOLF database.
pub fn export(config: &Path, selected: Option<&str>) -> Result<Value> {
    let path = io(fs::canonicalize(config))?;
    let _config_lock = lock(&sidecar(&path, "lock"))?;
    let status = importer_pull::run(&path, selected, true).map_err(|e| e.to_string())?;
    if !status.success || status.sources.iter().any(|source| source.status != "ready") {
        return Err(
            "The source, configuration, or runtime has not been imported or has changed. Reimport first"
                .into(),
        );
    }
    let config = importer_pull::validated_config(&path).map_err(|e| e.to_string())?;
    if selected.is_some_and(|id| !config.sources.iter().any(|s| s.id == id)) {
        return Err("The configuration does not contain a configuration ID".into());
    }
    let sources: Vec<_> = config
        .sources
        .iter()
        .filter(|s| selected.is_none_or(|id| s.id == id))
        .collect();
    let mut targets = Vec::new();
    let mut locks = Vec::new();
    // Validate every destination before creating a staging directory.
    for source in &sources {
        let runtime = Path::new(&source.runtime_out);
        let target = runtime
            .parent()
            .ok_or("The runtime output parent folder is missing")?
            .join("wolf")
            .join(&source.id);
        reject_links(&target)?;
        for other in &config.sources {
            let project_root = Path::new(&other.project)
                .parent()
                .ok_or("The source parent folder is missing")?;
            if overlaps(&target, project_root)
                || overlaps(&target, Path::new(&other.runtime_out))
                || other
                    .code_out
                    .as_ref()
                    .is_some_and(|p| overlaps(&target, Path::new(p)))
            {
                return Err(
                    "The WOLF output destination overlaps the source or a configured output".into(),
                );
            }
        }
        if overlaps(&target, &path) || targets.iter().any(|p: &PathBuf| overlaps(p, &target)) {
            return Err(
                "The WOLF output destination conflicts with this or another configuration".into(),
            );
        }
        targets.push(target);
    }
    for target in &targets {
        io(fs::create_dir_all(target.parent().unwrap()))?;
        locks.push(lock(&sidecar(target, "lock"))?);
    }
    // Parse and stage the complete data in memory before replacing any source output.
    let mut prepared = Vec::new();
    for (source, target) in sources.iter().zip(&targets) {
        let runtime = Path::new(&source.runtime_out);
        reject_links(runtime)?;
        let bytes = io(fs::read(runtime))?;
        let bundle: RuntimeBundle =
            serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", runtime.display()))?;
        let owner = hash(format!("{}\0{}", path.display(), source.id).as_bytes());
        verify_owned(target, &owner)?;
        prepared.push((owner, materialize(&bundle, source)?));
    }
    let mut report = Vec::new();
    for ((source, target), (owner, files)) in sources.iter().zip(&targets).zip(prepared) {
        publish(target, &owner, files)?;
        report.push(json!({"id":source.id,"status":"exported","directory":target,"schema":target.join("schema.json")}));
    }
    drop(locks);
    Ok(json!({"success":true,"sources":report}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn minimal_blank_numeric_boolean_defaults_match_full_values() {
        let source:importer_pull::PullSource=serde_json::from_value(json!({"id":"source","project":"project.devcelproj.toml","namespace":"Game","runtime_out":"runtime.json"})).unwrap();
        let base = json!({"manifest":{"schema_version":1,"content_hash":"test","mode":"minimal","data_revision":1,"generated_at":"2026-10-01T00:00:00Z"},"project_name":"WOLF","tables":[{"uuid":"table","name":"Values","columns":[{"name":"number","data_type":"I32","default_value":""},{"name":"flag","data_type":"Boolean","default_value":""},{"name":"text","data_type":"String","default_value":""}],"records":[{"id":"row","values":{}}]}]});
        let minimal: RuntimeBundle = serde_json::from_value(base.clone()).unwrap();
        let mut full = base;
        full["manifest"]["mode"] = json!("full");
        full["tables"][0]["records"][0]["values"] = json!({"number":"0","flag":"false","text":""});
        let full: RuntimeBundle = serde_json::from_value(full).unwrap();
        let a = materialize(&minimal, &source).unwrap();
        let b = materialize(&full, &source).unwrap();
        let csv = a.keys().find(|name| name.ends_with(".csv")).unwrap();
        assert_eq!(a[csv], b[csv]);
        assert!(std::str::from_utf8(&a[csv])
            .unwrap()
            .contains("\"row\",\"0\",\"false\",\"\""));
    }
}
