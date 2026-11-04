//! Title-owned, saved-source import. No Studio, transport, or distribution service is required.
//! Each source remains a complete runtime database; UUIDs never merge across source IDs.
use crate::{codegen, json_export, AppError, Project, ProjectEntryType};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

type Result<T> = std::result::Result<T, AppError>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PullConfig {
    pub schema_version: u32,
    pub sources: Vec<PullSource>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PullSource {
    pub id: String,
    pub project: String,
    pub namespace: String,
    pub runtime_out: String,
    #[serde(default)]
    pub code_out: Option<String>,
    #[serde(default)]
    pub code_target: Option<String>,
    #[serde(default)]
    pub class_name: Option<String>,
    #[serde(default = "full")]
    pub mode: String,
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub row_include_tags: Vec<String>,
    #[serde(default)]
    pub row_exclude_tags: Vec<String>,
    #[serde(default)]
    pub column_include_tags: Vec<String>,
    #[serde(default)]
    pub column_exclude_tags: Vec<String>,
}
impl PullSource {
    pub fn tag_filter(&self) -> crate::tag_filter::TagFilter {
        crate::tag_filter::TagFilter {
            row_include_tags: self.row_include_tags.clone(),
            row_exclude_tags: self.row_exclude_tags.clone(),
            column_include_tags: self.column_include_tags.clone(),
            column_exclude_tags: self.column_exclude_tags.clone(),
        }
    }
}
fn full() -> String {
    "full".into()
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct SavedState {
    schema_version: u32,
    sources: Vec<SourceState>,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct SourceState {
    id: String,
    fingerprint: String,
    runtime_hash: String,
    code_hash: Option<String>,
    content_hash: String,
    pulled_at: String,
    error: Option<AppError>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SourceStatus {
    pub id: String,
    pub namespace: String,
    pub project: String,
    pub runtime_out: String,
    pub code_out: Option<String>,
    /// ready | needs_pull | error | pulled
    pub status: String,
    pub content_hash: Option<String>,
    pub pulled_at: Option<String>,
    pub error: Option<AppError>,
}
#[derive(Serialize, Deserialize)]
pub struct PullReport {
    pub config: String,
    pub success: bool,
    pub sources: Vec<SourceStatus>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::text(message.into())
}

// Resolve missing leaf paths through their nearest existing ancestor, including symlinks.
fn identity(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    // Resolve each existing component before applying `..`: lexical collapse can
    // point somewhere else when a preceding component is a directory symlink.
    let mut resolved = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::Prefix(_) => resolved.push(part.as_os_str()),
            Component::ParentDir => {
                resolved.pop();
            }
            _ => {
                resolved.push(part.as_os_str());
                if fs::symlink_metadata(&resolved).is_ok() {
                    resolved = fs::canonicalize(&resolved)?;
                }
            }
        }
    }
    Ok(resolved)
}
fn key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}
fn resolve(base: &Path, path: &str) -> Result<PathBuf> {
    if path.trim().is_empty() {
        return Err(invalid("The path must not be empty"));
    }
    identity(&base.join(path))
}
fn output_path(base: &Path, path: &str) -> Result<PathBuf> {
    resolve(base, path)
}
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    path.with_file_name(format!(
        "{}.devcel-{suffix}",
        path.file_name().unwrap().to_string_lossy()
    ))
}
fn file_hash(path: &Path) -> Result<String> {
    let mut reader = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let len = reader.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        hash.update(&buffer[..len]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn reject_source_symlinks(root: &Path) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(invalid(format!(
                    "The pull source tree cannot contain symlinks. Specify a source containing regular files: {}",
                    entry.path().display()
                )));
            }
            if kind.is_dir() {
                directories.push(entry.path());
            }
        }
    }
    Ok(())
}

fn load_config(config_path: &Path) -> Result<(PathBuf, PullConfig)> {
    let path = fs::canonicalize(config_path)?;
    let config: PullConfig = serde_json::from_slice(&fs::read(&path)?)?;
    resolve_config(path, config)
}

fn resolve_config(path: PathBuf, mut config: PullConfig) -> Result<(PathBuf, PullConfig)> {
    let base = path.parent().unwrap();
    if config.schema_version != 1 {
        return Err(invalid("Pull configuration requires schema_version 1"));
    }
    if config.sources.is_empty() {
        return Err(invalid("The pull configuration has no source"));
    }
    let mut ids = BTreeSet::new();
    let mut namespaces = BTreeSet::new();
    let mut outputs = BTreeSet::new();
    let mut roots = Vec::new();
    for source in &mut config.sources {
        if source.id.is_empty()
            || !source
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            || !ids.insert(source.id.to_lowercase())
        {
            return Err(invalid(format!(
                "Source IDs must be unique and contain only alphanumeric characters, underscores, or hyphens: {}",
                source.id
            )));
        }
        codegen::validate_namespace(&source.namespace)?;
        if let Some(name) = &source.class_name {
            codegen::validate_class_name(name)?;
        }
        source.namespace = source.namespace.trim().replace("::", ".");
        if !namespaces.insert(source.namespace.to_lowercase()) {
            return Err(invalid(format!("Namespace conflict: {}", source.namespace)));
        }
        if source.mode != "full" && source.mode != "minimal" {
            return Err(invalid(format!(
                "Mode must be full or minimal: {}",
                source.id
            )));
        }
        let project = resolve(base, &source.project)?;
        if !project.to_string_lossy().ends_with(".devcelproj.toml") {
            return Err(invalid(format!(
                "Specify a .devcelproj.toml file: {}",
                source.id
            )));
        }
        roots.push(project.parent().unwrap().to_path_buf());
        source.project = project.to_string_lossy().into();
        let runtime = output_path(base, &source.runtime_out)?;
        if runtime.extension().and_then(|s| s.to_str()) != Some("json") {
            return Err(invalid("runtime_out must specify a .json file"));
        }
        source.runtime_out = runtime.to_string_lossy().into();
        match (&source.code_out, &source.code_target) {
            (Some(out), Some(target)) if !out.is_empty() => {
                let extension = match target.as_str() {
                    "csharp" => "cs",
                    "cpp" => "h",
                    "typescript" => "ts",
                    _ => return Err(invalid("code_target must be csharp, cpp, or typescript")),
                };
                let code = output_path(base, out)?;
                if code.extension().and_then(|s| s.to_str()) != Some(extension) {
                    return Err(invalid(format!(
                        "code_out must specify a .{extension} file"
                    )));
                }
                source.code_out = Some(code.to_string_lossy().into());
            }
            (None, None) => {}
            _ => return Err(invalid("Specify code_out and code_target together")),
        }
        for output in std::iter::once(&source.runtime_out).chain(source.code_out.iter()) {
            let output = Path::new(output);
            if !outputs.insert(key(output))
                || output == path
                || output == sidecar(&path, "state.json")
                || output.is_dir()
            {
                return Err(invalid(format!(
                    "The output path is duplicated, points to the configuration, or is a directory: {}",
                    output.display()
                )));
            }
        }
    }
    for namespace in &namespaces {
        if namespaces
            .iter()
            .any(|other| other != namespace && other.starts_with(&(namespace.clone() + ".")))
        {
            return Err(invalid(
                "Ancestor/descendant namespaces are not allowed because they conflict with generated type names",
            ));
        }
    }
    for output in &outputs {
        if outputs
            .iter()
            .any(|other| other != output && other.starts_with(&(output.clone() + "/")))
        {
            return Err(invalid(
                "An output file overlaps another output destination folder",
            ));
        }
    }
    // Reject source aliases before staging bypasses the exporter destination check.
    // This deliberately rejects directory symlinks too, without following external trees.
    for root in &roots {
        reject_source_symlinks(root)?;
    }
    // Source trees are read-only, including all projects, tables, and interface histories.
    for output in &outputs {
        if roots
            .iter()
            .any(|root| output == &key(root) || output.starts_with(&(key(root) + "/")))
        {
            return Err(invalid(format!(
                "Place output paths outside the source project: {output}"
            )));
        }
    }
    // Sidecars cannot be another configured destination.
    for source in &config.sources {
        for output in std::iter::once(&source.runtime_out).chain(source.code_out.iter()) {
            for suffix in ["owner.json", "lock"] {
                if outputs.contains(&key(&sidecar(Path::new(output), suffix))) {
                    return Err(invalid("The output path conflicts with a managed file"));
                }
            }
        }
    }
    Ok((path, config))
}

fn fingerprint(source: &PullSource) -> Result<String> {
    let project = Project::open_project(&source.project)?;
    let mut files = BTreeSet::from([PathBuf::from(&source.project)]);
    for entry in project.get_project_entries()? {
        if entry.entry_type == ProjectEntryType::Table
            || entry.entry_type == ProjectEntryType::Interface
        {
            files.insert(project.resolve_table_path(&PathBuf::from(entry.path))?);
        }
    }
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(source)?);
    for file in files {
        hash.update(file.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update(file_hash(&file)?.as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

struct Lock {
    _file: fs::File,
}
impl Lock {
    fn acquire(path: PathBuf) -> Result<Self> {
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(invalid(format!(
                "The lock file cannot be a symlink: {}",
                path.display()
            )));
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        file.try_lock().map_err(|error| {
            invalid(format!(
                "Another pull operation is running: {}: {error}",
                path.display()
            ))
        })?;
        // Never unlink this inode: waiting processes must lock the same file. The OS
        // releases the advisory lock when this handle closes, including process death.
        Ok(Self { _file: file })
    }
}

fn owner(config: &Path, source: &PullSource) -> serde_json::Value {
    {
        let mut hash = Sha256::new();
        hash.update(config.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update(source.id.as_bytes());
        serde_json::json!({"owner":format!("{:x}", hash.finalize())})
    }
}
fn check_owner(path: &Path, expected: &serde_json::Value) -> Result<()> {
    let claim = sidecar(path, "owner.json");
    if path.exists() && !claim.exists() {
        return Err(invalid(format!(
            "Existing unmanaged files will not be overwritten. Choose a new output path: {}",
            path.display()
        )));
    }
    if claim.exists()
        && serde_json::from_slice::<serde_json::Value>(&fs::read(claim)?)? != *expected
    {
        return Err(invalid(format!(
            "The output path belongs to another source: {}",
            path.display()
        )));
    }
    Ok(())
}

fn restore_backup(backup: tempfile::NamedTempFile, destination: &Path) -> std::io::Result<()> {
    backup
        .persist(destination)
        .map(|_| ())
        .map_err(|mut error| {
            // Keep the last recoverable old bytes if rollback itself fails.
            error.file.disable_cleanup(true);
            std::io::Error::other(format!(
                "{}; backup of the existing output: {}",
                error.error,
                error.file.path().display()
            ))
        })
}

// All generation and validation completes first. Each replacement is atomic; a failed
// replacement restores earlier outputs. Readers must still reopen only after success,
// because multiple files cannot be made visible simultaneously on all supported OSes.
fn publish(files: &[(PathBuf, PathBuf)]) -> Result<()> {
    let mut backups = Vec::new();
    for (_, destination) in files {
        let backup = if destination.exists() {
            let backup = tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
            fs::copy(destination, backup.path())?;
            Some(backup)
        } else {
            None
        };
        backups.push(backup);
    }
    let mut replacements = Vec::new();
    for (staged, destination) in files {
        let mut replacement = tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
        std::io::copy(&mut fs::File::open(staged)?, replacement.as_file_mut())?;
        replacement.as_file().sync_all()?;
        replacements.push(replacement);
    }
    for (index, replacement) in replacements.into_iter().enumerate() {
        if let Err(error) = replacement.persist(&files[index].1) {
            let mut rollback_errors = Vec::new();
            for previous in (0..index).rev() {
                let dest = &files[previous].1;
                let result = if let Some(backup) = backups[previous].take() {
                    restore_backup(backup, dest)
                } else {
                    fs::remove_file(dest)
                };
                if let Err(e) = result {
                    rollback_errors.push(format!("{}: {e}", dest.display()));
                }
            }
            return Err(invalid(format!(
                "Failed to replace output: {}; restore errors: {:?}",
                error.error, rollback_errors
            )));
        }
    }
    Ok(())
}

fn pull_source(config: &Path, source: &PullSource) -> Result<SourceState> {
    let expected_owner = owner(config, source);
    let outputs: Vec<PathBuf> = std::iter::once(&source.runtime_out)
        .chain(source.code_out.iter())
        .map(PathBuf::from)
        .collect();
    let mut locks = Vec::new();
    for output in &outputs {
        fs::create_dir_all(output.parent().unwrap())?;
        locks.push(Lock::acquire(sidecar(output, "lock"))?);
        if sidecar(output, "owner.json").exists() || !output.exists() {
            check_owner(output, &expected_owner)?;
        }
    }
    let before = fingerprint(source)?;
    let mut project = Project::open_project(&source.project)?;
    let staging = tempfile::tempdir_in(Path::new(&source.runtime_out).parent().unwrap())?;
    let runtime = staging.path().join("runtime.json");
    let mode = if source.mode == "minimal" {
        json_export::ExportMode::Minimal
    } else {
        json_export::ExportMode::Full
    };
    let summary = json_export::export_runtime_bundle_to_file_with_filters(
        &mut project,
        mode,
        source.version,
        false,
        &source.tag_filter(),
        &runtime,
    )?;
    let mut files = vec![(runtime.clone(), outputs[0].clone())];
    if let Some(target) = &source.code_target {
        let code = codegen::generate_code_with_class_name_for_filters(
            &mut project,
            codegen::CodegenTarget::from_name(target).unwrap(),
            Some(&source.namespace),
            source.class_name.as_deref(),
            source.version,
            &source.tag_filter(),
        )?;
        let staged = staging.path().join("generated-code");
        json_export::write_export_file(&staged, &code)?;
        files.push((staged, outputs[1].clone()));
    }
    if fingerprint(source)? != before {
        return Err(invalid(
            "The source changed during pull. Import it again after saving completes",
        ));
    }
    // A clean Git clone has no machine-local owner markers. Adopt only byte-identical
    // code and semantically identical runtime data, never a merely plausible asset.
    for (index, (staged, output)) in files.iter().enumerate() {
        if output.exists() && !sidecar(output, "owner.json").exists() {
            let same = if index == 0 {
                let normalize = |bytes: Vec<u8>| -> Result<serde_json::Value> {
                    let mut value: serde_json::Value = serde_json::from_slice(&bytes)?;
                    if let Some(manifest) = value
                        .get_mut("manifest")
                        .and_then(serde_json::Value::as_object_mut)
                    {
                        manifest.remove("generated_at");
                        manifest.remove("data_revision");
                    }
                    Ok(value)
                };
                normalize(fs::read(output)?)? == normalize(fs::read(staged)?)?
            } else {
                fs::read(output)? == fs::read(staged)?
            };
            if !same {
                check_owner(output, &expected_owner)?;
            }
        } else {
            check_owner(output, &expected_owner)?;
        }
    }
    let result = SourceState {
        id: source.id.clone(),
        fingerprint: before,
        runtime_hash: file_hash(&runtime)?,
        code_hash: if files.len() > 1 {
            Some(file_hash(&files[1].0)?)
        } else {
            None
        },
        content_hash: summary.manifest.content_hash,
        pulled_at: chrono::Utc::now().to_rfc3339(),
        error: None,
    };
    for (index, output) in outputs.iter().enumerate() {
        let staged = staging.path().join(format!("owner-{index}.json"));
        json_export::write_export_file(&staged, &serde_json::to_string_pretty(&expected_owner)?)?;
        files.push((staged, sidecar(output, "owner.json")));
    }
    publish(&files)?;
    Ok(result)
}

/// Read-only status or explicit reimport, optionally for one stable source ID.
/// A report is returned even when individual sources fail; check `success`.
/// Save validated settings atomically while excluding concurrent imports.
/// Relative paths remain relative in the saved, portable configuration.
pub fn save_config(config_path: &Path, config: &PullConfig) -> Result<()> {
    save_config_if_revision(config_path, config, None).map(|_| ())
}

/// Optimistic revision for editors; "missing" represents a new configuration.
pub fn config_revision(config_path: &Path) -> Result<String> {
    if config_path.exists() {
        file_hash(config_path)
    } else {
        Ok("missing".into())
    }
}

/// Reject stale editor writes while holding the same lock used by pull.
pub fn save_config_if_revision(
    config_path: &Path,
    config: &PullConfig,
    expected: Option<&str>,
) -> Result<String> {
    let path = identity(config_path)?;
    let _lock = Lock::acquire(sidecar(&path, "lock"))?;
    if expected.is_some() && expected != Some(config_revision(&path)?.as_str()) {
        return Err(invalid(
            "The configuration was updated in another window. Reload it before making changes.",
        ));
    }
    let (_, resolved) = resolve_config(path.clone(), config.clone())?;
    let previous = if path.exists() {
        Some(load_config(&path)?.1)
    } else {
        None
    };
    for source in &resolved.sources {
        let filter = source.tag_filter();
        if filter.is_empty() {
            continue;
        }
        let project = Project::open_project(&source.project)?;
        let old = previous
            .as_ref()
            .and_then(|config| {
                config
                    .sources
                    .iter()
                    .find(|old| old.id == source.id && old.project == source.project)
            })
            .map(PullSource::tag_filter)
            .unwrap_or_default();
        for (name, values, existing) in [
            (
                "row_include_tags",
                &filter.row_include_tags,
                &old.row_include_tags,
            ),
            (
                "row_exclude_tags",
                &filter.row_exclude_tags,
                &old.row_exclude_tags,
            ),
            (
                "column_include_tags",
                &filter.column_include_tags,
                &old.column_include_tags,
            ),
            (
                "column_exclude_tags",
                &filter.column_exclude_tags,
                &old.column_exclude_tags,
            ),
        ] {
            for tag in values.iter().filter(|tag| !existing.contains(tag)) {
                crate::project_tags::validate_authored_name(tag)?;
            }
            let removed_orphans = existing
                .iter()
                .filter(|tag| {
                    !project.project_data.tag_presets.contains(tag) && !values.contains(tag)
                })
                .count();
            let new_orphans = values
                .iter()
                .filter(|tag| {
                    !project.project_data.tag_presets.contains(tag) && !existing.contains(tag)
                })
                .count();
            if new_orphans > removed_orphans {
                return Err(invalid(format!("Unknown tag preset in source '{}' {name}. Select a registered preset. Existing orphan filters may be preserved or explicitly repaired.", source.id)));
            }
        }
    }
    json_export::write_export_file(&path, &serde_json::to_string_pretty(config)?)?;
    config_revision(&path)
}

/// Validate and resolve a title-owned importer configuration without writing outputs.
pub fn validated_config(config_path: &Path) -> Result<PullConfig> {
    load_config(config_path).map(|(_, config)| config)
}

pub fn run(config_path: &Path, selected: Option<&str>, status_only: bool) -> Result<PullReport> {
    let path = fs::canonicalize(config_path)?;
    let _lock = if status_only {
        None
    } else {
        Some(Lock::acquire(sidecar(&path, "lock"))?)
    };
    let (path, config) = load_config(&path)?;
    if selected.is_some_and(|id| !config.sources.iter().any(|s| s.id == id)) {
        return Err(invalid(
            "The specified source ID is not in the configuration",
        ));
    }
    let state_path = sidecar(&path, "state.json");
    let mut state: SavedState = if state_path.exists() {
        serde_json::from_slice(&fs::read(&state_path)?)?
    } else {
        SavedState {
            schema_version: 1,
            sources: vec![],
        }
    };
    if state.schema_version != 1 {
        return Err(invalid("Invalid pull state schema_version"));
    }
    state
        .sources
        .retain(|saved| config.sources.iter().any(|s| s.id == saved.id));
    let mut report = PullReport {
        config: path.to_string_lossy().into(),
        success: true,
        sources: Vec::new(),
    };
    for source in config
        .sources
        .iter()
        .filter(|s| selected.is_none_or(|id| s.id == id))
    {
        let previous = state.sources.iter().find(|s| s.id == source.id).cloned();
        let mut status = SourceStatus {
            id: source.id.clone(),
            namespace: source.namespace.clone(),
            project: source.project.clone(),
            runtime_out: source.runtime_out.clone(),
            code_out: source.code_out.clone(),
            status: "needs_pull".into(),
            content_hash: previous
                .as_ref()
                .filter(|p| !p.content_hash.is_empty())
                .map(|p| p.content_hash.clone()),
            pulled_at: previous
                .as_ref()
                .filter(|p| !p.pulled_at.is_empty())
                .map(|p| p.pulled_at.clone()),
            error: None,
        };
        if status_only {
            let current = (|| -> Result<bool> {
                let mut missing_owner = false;
                for output in std::iter::once(&source.runtime_out).chain(source.code_out.iter()) {
                    if sidecar(Path::new(output), "owner.json").exists() {
                        check_owner(Path::new(output), &owner(&path, source))?;
                    } else {
                        missing_owner = true;
                    }
                }
                let current = fingerprint(source)?;
                Ok(previous.as_ref().is_some_and(|p| {
                    !missing_owner
                        && p.fingerprint == current
                        && file_hash(Path::new(&source.runtime_out)).ok().as_ref()
                            == Some(&p.runtime_hash)
                        && source
                            .code_out
                            .as_ref()
                            .map(|out| file_hash(Path::new(out)).ok())
                            == p.code_hash.as_ref().map(|hash| Some(hash.clone()))
                }))
            })();
            match current {
                Ok(true) => status.status = "ready".into(),
                Ok(false) => {}
                Err(error) => {
                    status.status = "error".into();
                    status.error = Some(error);
                }
            }
            if status.error.is_none() {
                if let Some(error) = previous.and_then(|p| p.error) {
                    status.status = "error".into();
                    status.error = Some(error);
                }
            }
        } else {
            let next = match pull_source(&path, source) {
                Ok(next) => {
                    status.status = "pulled".into();
                    status.content_hash = Some(next.content_hash.clone());
                    status.pulled_at = Some(next.pulled_at.clone());
                    next
                }
                Err(error) => {
                    status.status = "error".into();
                    status.error = Some(error.clone());
                    let mut next = previous.unwrap_or_default();
                    next.id = source.id.clone();
                    next.error = Some(error);
                    next
                }
            };
            state.sources.retain(|p| p.id != source.id);
            state.sources.push(next);
        }
        if status.error.is_some() {
            report.success = false;
        }
        report.sources.push(status);
    }
    if !status_only {
        json_export::write_export_file(state_path, &serde_json::to_string_pretty(&state)?)?;
    }
    Ok(report)
}

#[cfg(test)]
mod importer_safety_tests {
    use super::*;
    #[test]
    fn failed_rollback_retains_old_file_for_recovery() {
        let root = tempfile::tempdir().unwrap();
        let backup = tempfile::NamedTempFile::new_in(root.path()).unwrap();
        fs::write(backup.path(), b"original asset").unwrap();
        let backup_path = backup.path().to_path_buf();
        let destination = root.path().join("blocked");
        fs::create_dir(&destination).unwrap();
        let error = restore_backup(backup, &destination).unwrap_err();
        assert!(error
            .to_string()
            .contains(&backup_path.to_string_lossy().to_string()));
        assert_eq!(fs::read(&backup_path).unwrap(), b"original asset");
    }
    #[test]
    fn ownerless_existing_file_is_not_claimed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("existing.json");
        fs::write(&path, b"unrelated asset").unwrap();
        assert!(check_owner(&path, &serde_json::json!({"owner":"test"})).is_err());
        assert_eq!(fs::read(path).unwrap(), b"unrelated asset");
    }
}
