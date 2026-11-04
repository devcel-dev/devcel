//! Package index and ordinary plugin settings publication share one journal.
//! Callers hold the package-store lock; this layer then takes launch, editor and
//! snapshot locks in that order. No plugin code runs here. A failed proposal
//! never rewrites user files, and an uncertain outcome is never replayed.
use crate::{app_settings_store, AppError};
use devcel_core::plugin_resources::ResourceTables;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(crate) const JOURNAL_FILE: &str = "plugin-resources-transaction.json";
const MAX_INDEX: u64 = 1024 * 1024;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 4096;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema_version: u8,
    id: String,
    generation: String,
    index_path: PathBuf,
    before_index: Option<String>,
    after_index: String,
    before_source: String,
    after_source: String,
}
struct Locks {
    _launch: File,
    _editor: File,
    _snapshot: File,
}
fn code(key: &str) -> AppError {
    AppError::code(key, serde_json::json!({}))
}
fn error_context(
    mut error: AppError,
    phase: &str,
    from: &Path,
    to: Option<&Path>,
    os_code: Option<i32>,
) -> AppError {
    if let AppError::Code { params, .. } = &mut error {
        if let Some(params) = params.as_object_mut() {
            // Keep the deepest concrete operation; localized code/details and
            // nested app-owned causes are unchanged and never stringified.
            params.entry("resourceTransaction").or_insert_with(|| {
                serde_json::json!({
                    "phase": phase, "from": from.to_string_lossy(),
                    "to": to.map(|path| path.to_string_lossy()), "osCode": os_code,
                })
            });
        }
    }
    error
}
pub(crate) fn io_context(
    error: std::io::Error,
    phase: &str,
    from: &Path,
    to: Option<&Path>,
) -> AppError {
    let os_code = error.raw_os_error();
    error_context(error.into(), phase, from, to, os_code)
}
fn phase_context(error: AppError, phase: &str, path: &Path) -> AppError {
    if matches!(&error, AppError::Code { code, .. } if code == "error.io") {
        error_context(error, phase, path, None, None)
    } else {
        error
    }
}
fn recovery_error(config: &Path, error: AppError) -> AppError {
    AppError::code(
        "settings.resourcesRecoveryRequired",
        serde_json::json!({
            "path": config.to_string_lossy(), "error": error,
        }),
    )
}
fn committed_warning(error: AppError) -> AppError {
    AppError::code(
        "settings.resourcesCommittedWarning",
        serde_json::json!({ "error": error }),
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn journal_path(config: &Path) -> PathBuf {
    config.join("settings-state").join(JOURNAL_FILE)
}
/// A read-only check: settings readers must never acquire the package lock.
pub(crate) fn pending(config: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(journal_path(config)) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            Err(code("settings.sourceFileInvalid"))
        }
        Ok(meta) => Ok(meta.len() > 0),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
fn transaction_paths(config: &Path, id: &str) -> (PathBuf, PathBuf) {
    (
        config.join(format!(".settings-resources-stage-{id}")),
        config.join(format!(".settings-resources-backup-{id}")),
    )
}
fn locks(config: &Path) -> Result<Locks, AppError> {
    fs::create_dir_all(config)?;
    // Same lock as settings_mode::open_launch_lock. Acquiring it first also
    // fences a starting editor before it has obtained its source-writer lease.
    let launch = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config.join("settings-editor.launch.lock"))?;
    launch.try_lock().map_err(|_| code("settings.editorBusy"))?;
    let editor = app_settings_store::acquire_update_lock(config)?;
    let snapshot = app_settings_store::transaction_snapshot_lock(config)?;
    Ok(Locks {
        _launch: launch,
        _editor: editor,
        _snapshot: snapshot,
    })
}
fn regular(path: &Path) -> Result<fs::Metadata, AppError> {
    let meta =
        fs::symlink_metadata(path).map_err(|error| io_context(error, "metadata", path, None))?;
    if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
        return Err(code("settings.sourceSymlink"));
    }
    Ok(meta)
}
fn read_file(path: &Path, limit: u64) -> Result<Vec<u8>, AppError> {
    if !regular(path)?.is_file() {
        return Err(code("settings.sourceFileInvalid"));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| io_context(error, "open_read", path, None))?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_context(error, "read_bytes", path, None))?;
    if bytes.len() as u64 > limit {
        return Err(code("settings.fileTooLarge"));
    }
    Ok(bytes)
}
fn trusted_index_path(path: &Path) -> Result<PathBuf, AppError> {
    if path.file_name().is_none_or(|name| name != "index.json") {
        return Err(code("settings.sourceFileInvalid"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| code("settings.stateDirectoryMissing"))?;
    if !regular(parent)?.is_dir() {
        return Err(code("settings.stateDirectoryMissing"));
    }
    let canonical = parent.canonicalize()?.join("index.json");
    if canonical.try_exists()? && !regular(&canonical)?.is_file() {
        return Err(code("settings.sourceFileInvalid"));
    }
    Ok(canonical)
}
fn index_bytes(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    if path.try_exists()? {
        read_file(path, MAX_INDEX).map(Some)
    } else {
        Ok(None)
    }
}
fn sync_dir(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| code("settings.stateDirectoryMissing"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| io_context(error, "atomic_create", path, None))?;
    temporary
        .write_all(bytes)
        .map_err(|error| io_context(error, "atomic_write", path, None))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| io_context(error, "atomic_sync", path, None))?;
    temporary.persist(path).map_err(|error| {
        let os_code = error.error.raw_os_error();
        error_context(
            AppError::technical(&error),
            "atomic_persist",
            path,
            None,
            os_code,
        )
    })?;
    // Failure here can occur after publication. Callers must check the target,
    // never equate this Result with proof that the rename did not happen.
    sync_dir(parent)
}
fn is_sidecar(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy();
        name.starts_with('.') && name.ends_with(".devcel-write.lock")
    })
}
fn source_entries(root: &Path) -> Result<Vec<PathBuf>, AppError> {
    fn visit(
        root: &Path,
        path: &Path,
        depth: usize,
        files: &mut Vec<PathBuf>,
    ) -> Result<(), AppError> {
        if depth > 32 {
            return Err(code("settings.sourceNestingTooDeep"));
        }
        if !regular(path)?.is_dir() {
            return Err(code("settings.sourceFileInvalid"));
        }
        for entry in fs::read_dir(path)? {
            let path = entry?.path();
            let meta = regular(&path)?;
            if meta.is_dir() {
                files.push(
                    path.strip_prefix(root)
                        .map_err(AppError::technical)?
                        .to_path_buf(),
                );
                if files.len() > MAX_FILES {
                    return Err(code("settings.sourceTooManyFiles"));
                }
                visit(root, &path, depth + 1, files)?;
            } else {
                // Legacy sidecars are not user documents and are not copied into new source trees.
                if is_sidecar(&path) {
                    continue;
                }
                files.push(
                    path.strip_prefix(root)
                        .map_err(AppError::technical)?
                        .to_path_buf(),
                );
                if files.len() > MAX_FILES {
                    return Err(code("settings.sourceTooManyFiles"));
                }
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, root, 0, &mut files)?;
    files.sort();
    Ok(files)
}
fn source_digest(root: &Path) -> Result<String, AppError> {
    let mut hash = Sha256::new();
    let mut total = 0;
    for path in source_entries(root)? {
        let meta = regular(&root.join(&path))?;
        let bytes = if meta.is_dir() {
            Vec::new()
        } else {
            read_file(&root.join(&path), MAX_BYTES)?
        };
        total += bytes.len() as u64;
        if total > MAX_BYTES {
            return Err(code("settings.sourceTooLarge"));
        }
        let name = path.as_os_str().as_encoded_bytes();
        hash.update([u8::from(meta.is_dir())]);
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name);
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn maybe_source_digest(root: &Path) -> Result<Option<String>, AppError> {
    if root.try_exists()? {
        source_digest(root).map(Some)
    } else {
        Ok(None)
    }
}
// Flush through the handle that wrote the staged bytes. On Windows a read-only
// File::open handle cannot FlushFileBuffers; reopening writable would also reject
// preserved read-only user documents. Keep this handle through permission copy.
fn write_staged_file(
    path: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> Result<(), AppError> {
    write_staged_file_with_sync(path, bytes, permissions, File::sync_all)
}
fn write_staged_file_with_sync(
    path: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
    sync: impl FnOnce(&File) -> std::io::Result<()>,
) -> Result<(), AppError> {
    let mut file =
        File::create(path).map_err(|error| io_context(error, "stage_create", path, None))?;
    file.write_all(bytes)
        .map_err(|error| io_context(error, "stage_write", path, None))?;
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)
            .map_err(|error| io_context(error, "stage_permissions", path, None))?;
    }
    sync(&file).map_err(|error| io_context(error, "stage_sync", path, None))?;
    Ok(())
}
fn copy_source(source: &Path, target: &Path) -> Result<(), AppError> {
    fs::create_dir(target).map_err(|error| io_context(error, "stage_directory", target, None))?;
    let mut total = 0;
    let entries = source_entries(source)?;
    for relative in &entries {
        let original = source.join(relative);
        if regular(&original)?.is_dir() {
            fs::create_dir_all(target.join(relative))?;
            continue;
        }
        let data = read_file(&original, MAX_BYTES)?;
        total += data.len() as u64;
        if total > MAX_BYTES {
            return Err(code("settings.sourceTooLarge"));
        }
        let path = target.join(relative);
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| code("settings.stateDirectoryMissing"))?,
        )?;
        write_staged_file(&path, &data, Some(regular(&original)?.permissions()))?;
    }
    // Keep even empty user directories and their permissions. Apply directory
    // permissions last so a read-only directory does not prevent copying.
    for relative in entries.iter().rev() {
        let meta = regular(&source.join(relative))?;
        if meta.is_dir() {
            fs::set_permissions(target.join(relative), meta.permissions())?;
        }
    }
    fs::set_permissions(target, regular(source)?.permissions())?;
    Ok(())
}
fn sync_directories(path: &Path) -> Result<(), AppError> {
    for entry in fs::read_dir(path)? {
        let child = entry?.path();
        if regular(&child)?.is_dir() {
            sync_directories(&child)?;
        }
    }
    // Every staged document was flushed on its writing handle. Sidecar files
    // are hardlinked coordination locks, not changed documents to reopen/flush.
    sync_dir(path)
}
fn prepare_candidate(
    config: &Path,
    resources: &ResourceTables,
    stage: &Path,
) -> Result<(), AppError> {
    copy_source(&config.join("settings"), stage)?;
    let entry = stage.join("studio.devcelproj.toml");
    // Project::open_project intentionally leaves table bodies lazy. Resource
    // merging must see every authored registry/table, not an empty map that
    // would mistake an existing install for first-time package defaults.
    let mut project = devcel_core::localization::load(&entry)?;
    let original = project
        .tables_data
        .iter()
        .map(|(path, table)| {
            toml::to_string(&table.data)
                .map(|data| (path.clone(), data))
                .map_err(AppError::technical)
        })
        .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
    let original_interfaces = project
        .interface_registry
        .get_all_interfaces_with_paths()
        .into_iter()
        .map(|(path, contract)| {
            Ok((
                path.clone(),
                contract.to_document_toml().map_err(AppError::technical)?,
            ))
        })
        .collect::<Result<std::collections::BTreeMap<_, _>, AppError>>()?;
    devcel_core::plugin_resources::merge_resources(&mut project, resources)?;
    for (path, contract) in project.interface_registry.get_all_interfaces_with_paths() {
        let serialized = contract.to_document_toml().map_err(AppError::technical)?;
        if original_interfaces.get(path) == Some(&serialized) {
            continue;
        }
        let relative = Path::new(path);
        if relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(code("settings.sourceFileInvalid"));
        }
        let target = stage.join("Tables").join(relative);
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| code("settings.stateDirectoryMissing"))?,
        )?;
        write_staged_file(&target, serialized.as_bytes(), None)?;
    }

    for table in project.tables_data.values().filter(|table| table.is_dirty) {
        let serialized = toml::to_string(&table.data).map_err(AppError::technical)?;
        if original.get(&table.path) == Some(&serialized) {
            // A repeated registration must not rewrite authored formatting or
            // comments when the actual table data did not change.
            continue;
        }
        let relative = table
            .path
            .strip_prefix(stage)
            .map_err(AppError::technical)?;
        if relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(code("settings.sourceFileInvalid"));
        }
        let path = stage.join(relative);
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| code("settings.stateDirectoryMissing"))?,
        )?;
        write_staged_file(&path, serialized.as_bytes(), None)?;
    }
    // Reload the staged bytes, not just the merge's in-memory objects. Every
    // ordinary table and both resource projections must compile before publish.
    let staged = devcel_core::localization::load(&entry)?;
    crate::settings_seed::compile_runtime(&staged)?;
    sync_directories(stage)
}
fn check_journal(config: &Path, index_path: &Path, journal: &Journal) -> Result<(), AppError> {
    if journal.schema_version != 1
        || uuid::Uuid::parse_str(&journal.id).is_err()
        || journal.index_path != index_path
        || app_settings_store::current_generation(config)? != journal.generation
        || [
            &journal.after_index,
            &journal.before_source,
            &journal.after_source,
        ]
        .into_iter()
        .chain(journal.before_index.iter())
        .any(|hash| hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(code("settings.transactionInterrupted"));
    }
    Ok(())
}
fn clear_journal(config: &Path) -> Result<(), AppError> {
    fs::remove_file(journal_path(config))?;
    sync_dir(&config.join("settings-state"))
}
fn check_copies(config: &Path, journal: &Journal) -> Result<(), AppError> {
    let (stage, backup) = transaction_paths(config, &journal.id);
    for (path, expected) in [
        (stage, &journal.after_source),
        (backup, &journal.before_source),
    ] {
        if maybe_source_digest(&path)?.is_some_and(|actual| &actual != expected) {
            return Err(code("settings.sourceChanging"));
        }
    }
    Ok(())
}
fn rollback_source(config: &Path, journal: &Journal) -> Result<(), AppError> {
    check_copies(config, journal)?;
    let root = config.join("settings");
    let (stage, backup) = transaction_paths(config, &journal.id);
    match maybe_source_digest(&root)?.as_deref() {
        Some(hash) if hash == journal.before_source => {}
        Some(hash) if hash == journal.after_source => {
            if source_digest(&backup)? != journal.before_source || stage.try_exists()? {
                return Err(code("settings.sourceChanging"));
            }
            fs::rename(&root, &stage).map_err(|error| {
                io_context(error, "rollback_source_candidate", &root, Some(&stage))
            })?;
            if let Err(error) = fs::rename(&backup, &root) {
                // Preserve both directories even if restoring the active path fails.
                let _ = fs::rename(&stage, &root);
                return Err(io_context(
                    error,
                    "rollback_restore_backup",
                    &backup,
                    Some(&root),
                ));
            }
        }
        None => {
            if source_digest(&backup)? != journal.before_source {
                return Err(code("settings.sourceChanging"));
            }
            fs::rename(&backup, &root).map_err(|error| {
                io_context(error, "rollback_restore_backup", &backup, Some(&root))
            })?;
        }
        _ => return Err(code("settings.sourceChanging")),
    }
    sync_dir(config)?;
    clear_journal(config)?;
    // The proposal is a disposable copy, never the only surviving user source.
    if stage.exists() {
        fs::remove_dir_all(stage)?;
    }
    if backup.exists() {
        fs::remove_dir_all(backup)?;
    }
    Ok(())
}
fn finish_committed(config: &Path, journal: &Journal) -> Result<(), AppError> {
    check_copies(config, journal)?;
    if source_digest(&config.join("settings"))? != journal.after_source {
        return Err(code("settings.sourceChanging"));
    }
    clear_journal(config)?;
    let (stage, backup) = transaction_paths(config, &journal.id);
    if stage.exists() {
        fs::remove_dir_all(stage)?;
    }
    if backup.exists() {
        fs::remove_dir_all(backup)?;
    }
    sync_dir(config)
}
fn recover_locked(config: &Path, index_path: &Path) -> Result<Option<AppError>, AppError> {
    let path = journal_path(config);
    if !pending(config)? {
        return Ok(None);
    }
    let journal: Journal = serde_json::from_slice(&read_file(&path, MAX_INDEX)?)?;
    check_journal(config, index_path, &journal)?;
    let current = index_bytes(index_path)?.as_deref().map(digest);
    let root = maybe_source_digest(&config.join("settings"))?;
    if current == journal.before_index
        && (current.as_deref() != Some(&journal.after_index)
            || root.as_deref() != Some(&journal.after_source))
    {
        // Even an index-byte no-op has distinguishable source images. A crash
        // before publishing its source proposal must restore the old source.
        rollback_source(config, &journal)?;
        Ok(None)
    } else if current.as_deref() == Some(&journal.after_index) {
        if root.as_deref() != Some(&journal.after_source) {
            return Err(code("settings.sourceChanging"));
        }
        match finish_committed(config, &journal) {
            Ok(()) => Ok(None),
            // A retained journal must block later index mutations, otherwise
            // the next operation would overwrite its only commit evidence.
            Err(error) if !pending(config)? => Ok(Some(committed_warning(error))),
            Err(error) => Err(error),
        }
    } else {
        Err(code("settings.transactionInterrupted"))
    }
}
/// Called only under the package-store lock, before reading or mutating its index.
pub(crate) fn recover_resources(
    config: &Path,
    index_path: &Path,
) -> Result<Option<AppError>, AppError> {
    if !pending(config)? {
        return Ok(None);
    }
    let index_path = trusted_index_path(index_path)?;
    let _locks = locks(config)?;
    recover_locked(config, &index_path).map_err(|error| recovery_error(config, error))
}
fn complete_publication(
    config: &Path,
    index_path: &Path,
    journal: &Journal,
    write: Result<(), AppError>,
) -> Result<Option<AppError>, AppError> {
    match write {
        Ok(()) => Ok(finish_committed(config, journal)
            .err()
            .map(committed_warning)),
        Err(error) => match index_bytes(index_path).map(|bytes| bytes.as_deref().map(digest)) {
            Ok(image) if image.as_deref() == Some(&journal.after_index) => {
                // The package committed. Never turn cleanup failure into a
                // retryable install error; any retained journal blocks replay.
                let _ = finish_committed(config, journal);
                Ok(Some(committed_warning(error)))
            }
            Ok(image) if image == journal.before_index => {
                rollback_source(config, journal)
                    .map_err(|rollback| recovery_error(config, rollback))?;
                Err(error)
            }
            _ => Err(recovery_error(config, error)),
        },
    }
}
/// Both index images are internally prepared under the package-store lock.
/// Only a proven committed publication returns Ok; post-commit failures are warnings.
pub(crate) fn register_resources(
    config: &Path,
    resources: &ResourceTables,
    index_path: &Path,
    expected_index: Option<&[u8]>,
    next_index: &[u8],
) -> Result<Option<AppError>, AppError> {
    if next_index.len() as u64 > MAX_INDEX {
        return Err(code("settings.fileTooLarge"));
    }
    let index_path = trusted_index_path(index_path)?;
    if pending(config)? {
        return Err(recovery_error(
            config,
            code("settings.transactionInterrupted"),
        ));
    }
    if index_bytes(&index_path)?.as_deref() != expected_index {
        return Err(code("settings.stale"));
    }
    if resources.tables.is_empty() {
        return match atomic_write(&index_path, next_index) {
            Ok(()) => Ok(None),
            Err(error) => match index_bytes(&index_path) {
                Ok(bytes) if bytes.as_deref() == Some(next_index) => {
                    Ok(Some(committed_warning(error)))
                }
                Ok(bytes) if bytes.as_deref() == expected_index => Err(error),
                _ => Err(recovery_error(config, error)),
            },
        };
    }
    let _locks = locks(config)?;
    if let Some(warning) =
        recover_locked(config, &index_path).map_err(|error| recovery_error(config, error))?
    {
        return Err(recovery_error(config, warning));
    }
    let source = app_settings_store::read_source_locked(config)
        .map_err(|error| phase_context(error, "read_source", config))?;
    let _source_locks = app_settings_store::source_read_locks(config)
        .map_err(|error| phase_context(error, "source_locks", config))?;
    let id = uuid::Uuid::new_v4().to_string();
    let (stage, backup) = transaction_paths(config, &id);
    let before_source = source_digest(&config.join("settings"))?;
    if let Err(error) = prepare_candidate(config, resources, &stage) {
        let _ = fs::remove_dir_all(&stage);
        return Err(phase_context(error, "prepare_candidate", &stage));
    }
    let proposed = (|| {
        if source_digest(&config.join("settings"))? != before_source
            || index_bytes(&index_path)?.as_deref() != expected_index
        {
            return Err(code("settings.sourceChanging"));
        }
        let journal = Journal {
            schema_version: 1,
            id,
            generation: source.generation,
            index_path: index_path.clone(),
            before_index: expected_index.map(digest),
            after_index: digest(next_index),
            before_source,
            after_source: source_digest(&stage)?,
        };
        atomic_write(&journal_path(config), &serde_json::to_vec(&journal)?)?;
        let publish = (|| {
            let root = config.join("settings");
            fs::rename(&root, &backup).map_err(|error| {
                io_context(error, "publish_source_backup", &root, Some(&backup))
            })?;
            fs::rename(&stage, &root).map_err(|error| {
                io_context(error, "publish_source_candidate", &stage, Some(&root))
            })?;
            sync_dir(config)
        })();
        if let Err(error) = publish {
            rollback_source(config, &journal).map_err(|rollback| {
                recovery_error(
                    config,
                    AppError::code(
                        "settings.transactionUncertain",
                        serde_json::json!({"error": rollback, "originalError": error}),
                    ),
                )
            })?;
            return Err(error);
        }
        complete_publication(
            config,
            &index_path,
            &journal,
            atomic_write(&index_path, next_index),
        )
    })();
    // A surviving journal owns both copies until explicit checked recovery.
    if !journal_path(config).exists() && stage.exists() {
        let _ = fs::remove_dir_all(stage);
    }
    proposed
}

#[cfg(test)]
mod tests {
    use super::*;
    use devcel_core::plugin_resources::{ResourceCardinality, ResourceKind, ResourceTable};

    const BEFORE: &[u8] = br#"{"version":1}"#;
    const AFTER: &[u8] = br#"{"version":2}"#;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("settings-state")).unwrap();
        fs::write(dir.path().join("settings-state/generation.json"),
            serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"generation":uuid::Uuid::new_v4().to_string()})).unwrap()).unwrap();
        let packages = dir.path().join("packages");
        fs::create_dir(&packages).unwrap();
        let index = packages.join("index.json");
        fs::write(&index, BEFORE).unwrap();
        (dir, index)
    }
    fn crash_fixture(noop_index: bool) -> (tempfile::TempDir, PathBuf, Journal) {
        let (dir, index) = setup();
        let root = dir.path().join("settings");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("user.data"), b"original user bytes").unwrap();
        fs::create_dir(root.join("empty user folder")).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let (stage, _) = transaction_paths(dir.path(), &id);
        copy_source(&root, &stage).unwrap();
        fs::write(stage.join("plugin.data"), b"new package defaults").unwrap();
        let journal = Journal {
            schema_version: 1,
            id,
            generation: app_settings_store::current_generation(dir.path()).unwrap(),
            // Match the production writer, including Windows verbatim paths.
            index_path: trusted_index_path(&index).unwrap(),
            before_index: Some(digest(BEFORE)),
            after_index: digest(if noop_index { BEFORE } else { AFTER }),
            before_source: source_digest(&root).unwrap(),
            after_source: source_digest(&stage).unwrap(),
        };
        atomic_write(
            &journal_path(dir.path()),
            &serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        (dir, index, journal)
    }
    fn publish_source(config: &Path, journal: &Journal) {
        let (stage, backup) = transaction_paths(config, &journal.id);
        fs::rename(config.join("settings"), backup).unwrap();
        fs::rename(stage, config.join("settings")).unwrap();
    }
    fn assert_code(error: &AppError, expected: &str) {
        assert!(
            matches!(error, AppError::Code {code,..} if code == expected),
            "{error:?}"
        );
    }
    fn resource_fixture(
        id: &str,
        kind: ResourceKind,
        cardinality: ResourceCardinality,
        source: &str,
    ) -> ResourceTable {
        use devcel_core::interface::{Interface, InterfaceChange, InterfaceRegistry};
        let original: devcel_core::TableData = toml::from_str(source).unwrap();
        let mut contract = Interface::new(
            devcel_core::plugin_resources::contract_name("example.plugin", id),
            None,
        );
        let changes = original
            .schema
            .columns
            .iter()
            .map(|old| {
                let mut c = old.clone();
                c.uuid = uuid::Uuid::new_v4().to_string();
                c.interface_origin = None;
                c.interface_origin_name_fallback = None;
                InterfaceChange::AddColumn { column: c }
            })
            .collect();
        contract.create_new_version(changes, None, None).unwrap();
        let mut interfaces = InterfaceRegistry::new();
        interfaces.add_interface(contract.clone()).unwrap();
        let mut data = original.clone();
        data.uuid = uuid::Uuid::new_v4().to_string();
        data.metadata.data_name = devcel_core::plugin_resources::table_name("example.plugin", id);
        data.schema.columns.clear();
        data.records.clear();
        data.interface_implementations.clear();
        data.metadata.interface_order.clear();
        let mut table = devcel_core::Table {
            path: PathBuf::new(),
            data,
            is_dirty: false,
            undo_history: vec![],
            redo_history: vec![],
        };
        table.apply_interface(&contract, &interfaces, true).unwrap();
        for old in &original.records {
            let mut row = devcel_core::Record::new();
            for (column, previous) in table
                .data
                .schema
                .columns
                .iter()
                .zip(&original.schema.columns)
            {
                if let Some(value) = old.get_cell_value(previous) {
                    row.set_cell_value(column, value.clone());
                }
            }
            table.data.records.push(row);
        }
        ResourceTable {
            id: id.into(),
            kind,
            cardinality,
            table: table.data,
            contract,
        }
    }
    fn resources() -> ResourceTables {
        ResourceTables {
            owner: "example.plugin".into(),
            previous_tables: vec![],
            tables: vec![resource_fixture(
                "preferences",
                ResourceKind::Settings,
                ResourceCardinality::Singleton,
                include_str!("../../app-settings/Tables/Plugins/csv-exporter/settings.table.toml"),
            )],
        }
    }
    fn set_cell(table: &mut devcel_core::TableData, row: usize, name: &str, value: &str) {
        let column = table
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == name)
            .unwrap();
        table.records[row].set_cell_value(column, value.into());
    }
    fn cell<'a>(table: &'a devcel_core::TableData, row: usize, name: &str) -> &'a str {
        let column = table
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == name)
            .unwrap();
        table.records[row].get_cell_value(column).unwrap()
    }

    #[test]
    fn staged_copy_flushes_readonly_documents_without_copying_legacy_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let stage = dir.path().join("stage");
        fs::create_dir_all(source.join("empty folder")).unwrap();
        let document = source.join("readonly.bin");
        let sidecar = source.join(".readonly.bin.devcel-write.lock");
        let writable = source.join("writable.data");
        fs::write(&writable, b"unchanged original").unwrap();
        fs::write(&document, b"\x00unchanged user document\xff").unwrap();
        fs::write(&sidecar, b"unchanged coordination bytes").unwrap();
        let sidecar_guard = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&sidecar)
            .unwrap();
        sidecar_guard.lock().unwrap();
        let original_permissions = fs::metadata(&document).unwrap().permissions();
        let sidecar_permissions = fs::metadata(&sidecar).unwrap().permissions();
        let mut readonly = original_permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&document, readonly).unwrap();
        let mut readonly = sidecar_permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&sidecar, readonly).unwrap();
        copy_source(&source, &stage).unwrap();
        sync_directories(&stage).unwrap();
        let copied_document = stage.join("readonly.bin");
        let copied_sidecar = stage.join(".readonly.bin.devcel-write.lock");
        assert!(!copied_sidecar.exists());
        // Leave an existing old-version lock untouched, even while it is held.
        drop(sidecar_guard);
        for path in [&document, &copied_document] {
            assert_eq!(fs::read(path).unwrap(), b"\x00unchanged user document\xff");
            assert!(fs::metadata(path).unwrap().permissions().readonly());
        }
        assert_eq!(fs::read(&sidecar).unwrap(), b"unchanged coordination bytes");
        assert!(fs::metadata(&sidecar).unwrap().permissions().readonly());
        assert!(stage.join("empty folder").is_dir());
        // Changed table bytes use the same writer without replacing permissions.
        let copied_writable = stage.join("writable.data");
        let was_readonly = fs::metadata(&copied_writable)
            .unwrap()
            .permissions()
            .readonly();
        write_staged_file(&copied_writable, b"changed staged bytes", None).unwrap();
        assert_eq!(fs::read(&copied_writable).unwrap(), b"changed staged bytes");
        assert_eq!(fs::read(&writable).unwrap(), b"unchanged original");
        assert_eq!(
            fs::metadata(&copied_writable)
                .unwrap()
                .permissions()
                .readonly(),
            was_readonly
        );
        // Restore only this temporary fixture's original permissions for cleanup.
        fs::set_permissions(&sidecar, sidecar_permissions).unwrap();
        fs::set_permissions(&document, original_permissions.clone()).unwrap();
        fs::set_permissions(&copied_document, original_permissions).unwrap();
    }

    #[test]
    fn staged_flush_failure_is_returned_without_mutating_source_or_index() {
        let (dir, index) = setup();
        let root = dir.path().join("settings");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("user.data"), b"original user bytes").unwrap();
        let stage = dir.path().join("stage");
        copy_source(&root, &stage).unwrap();
        let before_source = source_digest(&root).unwrap();
        let before_index = fs::read(&index).unwrap();
        let error = write_staged_file_with_sync(
            &stage.join("user.data"),
            b"uncommitted staged bytes",
            None,
            |_| Err(std::io::Error::other("injected staged file sync failure")),
        )
        .unwrap_err();
        assert_code(&error, "error.io");
        assert_eq!(source_digest(&root).unwrap(), before_source);
        assert_eq!(fs::read(&index).unwrap(), before_index);
        assert_eq!(
            fs::read(stage.join("user.data")).unwrap(),
            b"uncommitted staged bytes"
        );
        assert!(!journal_path(dir.path()).exists());
        // This isolates flush-error propagation. Registration tests separately
        // cover invalid-candidate no-publication and confirmed-precommit rollback.
    }

    #[test]
    fn recovery_rejects_a_different_canonical_index_without_mutation() {
        let (dir, index, mut journal) = crash_fixture(false);
        let alternate = dir.path().join("other-packages");
        fs::create_dir(&alternate).unwrap();
        let alternate_index = alternate.join("index.json");
        fs::write(&alternate_index, BEFORE).unwrap();
        journal.index_path = trusted_index_path(&alternate_index).unwrap();
        atomic_write(
            &journal_path(dir.path()),
            &serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        let journal_bytes = fs::read(journal_path(dir.path())).unwrap();
        assert_code(
            &recover_resources(dir.path(), &index).unwrap_err(),
            "settings.resourcesRecoveryRequired",
        );
        assert_eq!(
            source_digest(&dir.path().join("settings")).unwrap(),
            journal.before_source
        );
        let (stage, backup) = transaction_paths(dir.path(), &journal.id);
        assert_eq!(source_digest(&stage).unwrap(), journal.after_source);
        assert!(!backup.exists());
        assert_eq!(fs::read(index).unwrap(), BEFORE);
        assert_eq!(fs::read(alternate_index).unwrap(), BEFORE);
        assert_eq!(fs::read(journal_path(dir.path())).unwrap(), journal_bytes);
    }

    #[test]
    fn recovery_rolls_back_every_precommit_source_phase_including_noop_index() {
        for noop in [false, true] {
            for phase in 0..3 {
                let (dir, index, journal) = crash_fixture(noop);
                let (stage, backup) = transaction_paths(dir.path(), &journal.id);
                if phase >= 1 {
                    fs::rename(dir.path().join("settings"), &backup).unwrap();
                }
                if phase >= 2 {
                    fs::rename(&stage, dir.path().join("settings")).unwrap();
                }
                // An identical index post-image plus published source is already
                // a complete no-op package commit, not a rollback candidate.
                let committed = noop && phase == 2;
                assert!(recover_resources(dir.path(), &index).unwrap().is_none());
                assert_eq!(
                    source_digest(&dir.path().join("settings")).unwrap(),
                    if committed {
                        journal.after_source
                    } else {
                        journal.before_source
                    }
                );
                assert_eq!(fs::read(&index).unwrap(), BEFORE);
                assert_eq!(
                    fs::read(dir.path().join("settings/user.data")).unwrap(),
                    b"original user bytes"
                );
                assert!(dir.path().join("settings/empty user folder").is_dir());
                assert!(!pending(dir.path()).unwrap());
                assert!(!stage.exists());
                assert!(!backup.exists());
                assert!(recover_resources(dir.path(), &index).unwrap().is_none());
            }
        }
    }

    #[test]
    fn recovery_finishes_committed_images_without_rolling_back_or_replaying() {
        let (dir, index, journal) = crash_fixture(false);
        let sidecar = dir.path().join("settings/.user.data.devcel-write.lock");
        fs::write(&sidecar, b"inert lock bytes").unwrap();
        let orphan = tempfile::Builder::new()
            .prefix(".settings-resources-locks-")
            .tempdir_in(dir.path())
            .unwrap()
            .keep();
        fs::hard_link(&sidecar, orphan.join("0.lock")).unwrap();
        publish_source(dir.path(), &journal);
        fs::write(&index, AFTER).unwrap();
        assert!(recover_resources(dir.path(), &index).unwrap().is_none());
        assert_eq!(fs::read(&index).unwrap(), AFTER);
        assert_eq!(
            source_digest(&dir.path().join("settings")).unwrap(),
            journal.after_source
        );
        assert!(!pending(dir.path()).unwrap());
        assert!(recover_resources(dir.path(), &index).unwrap().is_none());
        assert_eq!(
            fs::read(orphan.join("0.lock")).unwrap(),
            b"inert lock bytes"
        );
        assert_eq!(
            fs::read(dir.path().join("settings/user.data")).unwrap(),
            b"original user bytes"
        );
    }

    #[test]
    fn ambiguous_or_externally_changed_images_keep_every_copy_and_fail_closed() {
        for damaged in ["index", "source", "backup", "generation"] {
            let (dir, index, journal) = crash_fixture(false);
            publish_source(dir.path(), &journal);
            let (_, backup) = transaction_paths(dir.path(), &journal.id);
            fs::write(&index, AFTER).unwrap();
            match damaged {
                "index" => fs::write(&index, b"foreign index").unwrap(),
                "source" => fs::write(dir.path().join("settings/user.data"), b"foreign source edit").unwrap(),
                "backup" => fs::write(backup.join("user.data"), b"foreign backup edit").unwrap(),
                "generation" => fs::write(dir.path().join("settings-state/generation.json"),
                    serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"generation":uuid::Uuid::new_v4().to_string()})).unwrap()).unwrap(),
                _ => unreachable!(),
            }
            let source_before = source_digest(&dir.path().join("settings")).unwrap();
            let backup_before = source_digest(&backup).unwrap();
            let index_before = fs::read(&index).unwrap();
            assert_code(
                &recover_resources(dir.path(), &index).unwrap_err(),
                "settings.resourcesRecoveryRequired",
            );
            assert_eq!(
                source_digest(&dir.path().join("settings")).unwrap(),
                source_before
            );
            assert_eq!(source_digest(&backup).unwrap(), backup_before);
            assert_eq!(fs::read(&index).unwrap(), index_before);
            assert!(pending(dir.path()).unwrap());
            assert_code(
                &app_settings_store::acquire_editor(dir.path())
                    .err()
                    .unwrap(),
                "settings.resourcesRecoveryRequired",
            );
        }
    }

    #[test]
    fn postcommit_durability_error_is_success_warning_matching_actual_bytes() {
        let (dir, index, journal) = crash_fixture(false);
        publish_source(dir.path(), &journal);
        fs::write(&index, AFTER).unwrap();
        let warning = complete_publication(
            dir.path(),
            &index,
            &journal,
            Err(AppError::technical("injected directory fsync failure")),
        )
        .unwrap()
        .unwrap();
        assert_code(&warning, "settings.resourcesCommittedWarning");
        let json = serde_json::to_value(&warning).unwrap();
        assert_eq!(json["params"]["error"]["kind"], "code");
        assert_eq!(
            json["params"]["error"]["params"]["details"],
            "injected directory fsync failure"
        );
        assert_eq!(fs::read(&index).unwrap(), AFTER);
        assert_eq!(
            source_digest(&dir.path().join("settings")).unwrap(),
            journal.after_source
        );
        assert!(!pending(dir.path()).unwrap());
    }

    #[test]
    fn postcommit_cleanup_failure_warns_but_blocks_new_mutation_until_recovered() {
        let (dir, index, journal) = crash_fixture(false);
        publish_source(dir.path(), &journal);
        fs::write(&index, AFTER).unwrap();
        let (_, backup) = transaction_paths(dir.path(), &journal.id);
        fs::write(
            backup.join("user.data"),
            b"preserve this external backup edit",
        )
        .unwrap();
        let warning = complete_publication(dir.path(), &index, &journal, Ok(()))
            .unwrap()
            .unwrap();
        assert_code(&warning, "settings.resourcesCommittedWarning");
        assert!(pending(dir.path()).unwrap());
        assert!(recover_resources(dir.path(), &index).is_err());
        let empty = ResourceTables {
            owner: "empty".into(),
            previous_tables: vec![],
            tables: vec![],
        };
        assert_code(
            &register_resources(dir.path(), &empty, &index, Some(AFTER), b"must not publish")
                .unwrap_err(),
            "settings.resourcesRecoveryRequired",
        );
        assert_eq!(fs::read(&index).unwrap(), AFTER);
        assert_eq!(
            fs::read(backup.join("user.data")).unwrap(),
            b"preserve this external backup edit"
        );
    }

    #[test]
    fn confirmed_precommit_failure_restores_source_and_index_exactly() {
        let (dir, index, journal) = crash_fixture(false);
        publish_source(dir.path(), &journal);
        assert!(complete_publication(
            dir.path(),
            &index,
            &journal,
            Err(AppError::technical("injected index rename failure"))
        )
        .is_err());
        assert_eq!(fs::read(&index).unwrap(), BEFORE);
        assert_eq!(
            source_digest(&dir.path().join("settings")).unwrap(),
            journal.before_source
        );
        assert!(!pending(dir.path()).unwrap());
    }

    #[test]
    fn registration_rejects_stale_index_and_active_editor_without_writing() {
        let (dir, index) = setup();
        let resources = resources();
        assert_code(
            &register_resources(dir.path(), &resources, &index, None, AFTER).unwrap_err(),
            "settings.stale",
        );
        let guard = app_settings_store::acquire_update_lock(dir.path()).unwrap();
        assert_code(
            &register_resources(dir.path(), &resources, &index, Some(BEFORE), AFTER).unwrap_err(),
            "settings.editorBusy",
        );
        drop(guard);
        assert_eq!(fs::read(&index).unwrap(), BEFORE);
        assert!(!dir.path().join("settings").exists());
        assert!(!pending(dir.path()).unwrap());
    }

    #[test]
    fn registration_and_additive_upgrade_preserve_authored_values_and_other_documents() {
        let (dir, index) = setup();
        let root = dir.path().join("settings");
        crate::settings_seed::seed_project(&root).unwrap();
        fs::create_dir_all(root.join("User documents/empty folder")).unwrap();
        fs::write(
            root.join("User documents/readme.bin"),
            b"\x00literal user data\xff",
        )
        .unwrap();
        let user_path = root.join("Tables/UserSettings.table.toml");
        let user_bytes = fs::read(&user_path).unwrap();
        let mut rows = resource_fixture(
            "profiles",
            ResourceKind::Settings,
            ResourceCardinality::Rows,
            include_str!("../../app-settings/Tables/Plugins/csv-exporter/settings.table.toml"),
        );
        rows.id = "profiles".into();
        rows.cardinality = ResourceCardinality::Rows;
        rows.table.metadata.data_name =
            devcel_core::plugin_resources::table_name("example.plugin", "profiles");
        let mut second = rows.table.records[0].clone();
        second.uuid = uuid::Uuid::new_v4().to_string();
        second.label = "second profile".into();
        rows.table.records.push(second);
        let translations = resource_fixture(
            "translations",
            ResourceKind::Translations,
            ResourceCardinality::Rows,
            include_str!("../../app-settings/Tables/Plugins/csv-exporter/translations.table.toml"),
        );
        let mut resources = resources();
        resources.tables.push(rows);
        resources.tables.push(translations);
        assert!(
            register_resources(dir.path(), &resources, &index, Some(BEFORE), AFTER)
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(&index).unwrap(), AFTER);
        assert_eq!(fs::read(&user_path).unwrap(), user_bytes);
        assert_eq!(
            fs::read(root.join("User documents/readme.bin")).unwrap(),
            b"\x00literal user data\xff"
        );
        assert!(root.join("User documents/empty folder").is_dir());
        let path = root.join("Tables/Plugins/example.plugin/preferences.table.toml");
        let mut authored: devcel_core::TableData =
            toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        authored.display_name = "My editable table {literal} 日本語".into();
        authored.metadata.initial_transposed = true;
        set_cell(&mut authored, 0, "defaultDelimiter", ";");
        let record_uuid = authored.records[0].uuid.clone();
        fs::write(&path, toml::to_string(&authored).unwrap()).unwrap();
        let rows_path = root.join("Tables/Plugins/example.plugin/profiles.table.toml");
        let mut row_table: devcel_core::TableData =
            toml::from_str(&fs::read_to_string(&rows_path).unwrap()).unwrap();
        resources.previous_tables = resources.tables.clone();
        set_cell(&mut row_table, 1, "defaultDelimiter", "|");
        let second_uuid = row_table.records[1].uuid.clone();
        let deleted_uuid = row_table.records.remove(0).uuid;
        fs::write(&rows_path, toml::to_string(&row_table).unwrap()).unwrap();
        let mut added_row = resources.tables[1].table.records[0].clone();
        added_row.uuid = uuid::Uuid::new_v4().to_string();
        added_row.label = "third profile".into();
        resources.tables[1].table.records.push(added_row);
        let translations_path = root.join("Tables/Plugins/example.plugin/translations.table.toml");
        let mut translations: devcel_core::TableData =
            toml::from_str(&fs::read_to_string(&translations_path).unwrap()).unwrap();
        set_cell(&mut translations, 0, "text", "My literal translation");
        let translation_uuid = translations.records[0].uuid.clone();
        fs::write(&translations_path, toml::to_string(&translations).unwrap()).unwrap();
        let mut added = resources.tables[0].table.schema.columns[1].clone();
        added.uuid = uuid::Uuid::new_v4().to_string();
        added.data_name = "additionalEncoding".into();
        added.interface_origin = None;
        added.interface_origin_name_fallback = None;
        let resource = &mut resources.tables[0];
        resource
            .contract
            .create_new_version(
                vec![devcel_core::interface::InterfaceChange::AddColumn { column: added }],
                None,
                None,
            )
            .unwrap();
        let mut registry = devcel_core::interface::InterfaceRegistry::new();
        registry.add_interface(resource.contract.clone()).unwrap();
        let mut fresh = resource.table.clone();
        let old_rows = fresh.records.clone();
        let old_columns = fresh.schema.columns.clone();
        fresh.schema.columns.clear();
        fresh.records.clear();
        fresh.interface_implementations.clear();
        fresh.metadata.interface_order.clear();
        let mut view = devcel_core::Table {
            path: PathBuf::new(),
            data: fresh,
            is_dirty: false,
            undo_history: vec![],
            redo_history: vec![],
        };
        view.apply_interface(&resource.contract, &registry, true)
            .unwrap();
        for old in old_rows {
            let mut row = old.clone();
            row.values.clear();
            row.interface_values.clear();
            for column in &view.data.schema.columns {
                let value = old_columns
                    .iter()
                    .find(|c| c.uuid == column.uuid)
                    .and_then(|c| old.get_cell_value(c))
                    .cloned()
                    .unwrap_or_else(|| "utf-8".into());
                row.set_cell_value(column, value);
            }
            view.data.records.push(row);
        }
        resource.table = view.data;
        let upgrade = br#"{"version":3}"#;
        assert!(
            register_resources(dir.path(), &resources, &index, Some(AFTER), upgrade)
                .unwrap()
                .is_none()
        );
        let updated: devcel_core::TableData =
            toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(updated.uuid, authored.uuid);
        assert_eq!(updated.display_name, "My editable table {literal} 日本語");
        assert!(updated.metadata.initial_transposed);
        assert_eq!(updated.records[0].uuid, record_uuid);
        assert_eq!(cell(&updated, 0, "defaultDelimiter"), ";");
        assert_eq!(cell(&updated, 0, "additionalEncoding"), "utf-8");
        let rows: devcel_core::TableData =
            toml::from_str(&fs::read_to_string(&rows_path).unwrap()).unwrap();
        assert_eq!(rows.records.len(), 2);
        assert!(!rows.records.iter().any(|r| r.uuid == deleted_uuid));
        assert_eq!(rows.records[0].uuid, second_uuid);
        assert_eq!(cell(&rows, 0, "defaultDelimiter"), "|");
        let translations: devcel_core::TableData =
            toml::from_str(&fs::read_to_string(&translations_path).unwrap()).unwrap();
        assert_eq!(translations.records[0].uuid, translation_uuid);
        assert_eq!(cell(&translations, 0, "text"), "My literal translation");
        assert_eq!(fs::read(&user_path).unwrap(), user_bytes);
        let comment_bytes = format!(
            "# user-authored note: keep exactly\n{}",
            fs::read_to_string(&path).unwrap()
        );
        fs::write(&path, &comment_bytes).unwrap();
        let unchanged = source_digest(&root).unwrap();
        assert!(
            register_resources(dir.path(), &resources, &index, Some(upgrade), upgrade)
                .unwrap()
                .is_none()
        );
        assert_eq!(source_digest(&root).unwrap(), unchanged);
        assert_eq!(fs::read_to_string(&path).unwrap(), comment_bytes);
        let mut reopened = devcel_core::Project::open_project(
            &root.join("studio.devcelproj.toml").to_string_lossy(),
        )
        .unwrap();
        reopened.load_table(&path).unwrap();
        let reopened = &reopened.tables_data[&path].data;
        assert_eq!(reopened.display_name, "My editable table {literal} 日本語");
        assert!(reopened.metadata.initial_transposed);
        assert_eq!(cell(reopened, 0, "defaultDelimiter"), ";");
        // Reject the entire next proposal before touching either active image.
        resources.tables[0].table.schema.columns[0].data_type = devcel_core::ValueType::Boolean;
        let source_before = source_digest(&root).unwrap();
        assert!(register_resources(
            dir.path(),
            &resources,
            &index,
            Some(upgrade),
            b"invalid upgrade"
        )
        .is_err());
        assert_eq!(source_digest(&root).unwrap(), source_before);
        assert_eq!(fs::read(&index).unwrap(), upgrade);
        assert!(!pending(dir.path()).unwrap());
        let cached = app_settings_store::load(dir.path());
        assert_eq!(cached.source, "project");
        fs::write(journal_path(dir.path()), b"{}").unwrap();
        let protected = app_settings_store::load(dir.path());
        assert_eq!(protected.source, "lastValid");
        assert_eq!(protected.bundle, cached.bundle);
        assert!(protected
            .warning
            .as_ref()
            .unwrap()
            .iter()
            .any(|error| matches!(error,
            AppError::Code {code,..} if code == "settings.resourcesRecoveryRequired")));
        assert_eq!(source_digest(&root).unwrap(), source_before);
        assert_eq!(fs::read(&index).unwrap(), upgrade);
        fs::remove_file(journal_path(dir.path())).unwrap();
    }

    #[test]
    fn empty_journal_does_not_lock_readers_or_create_a_recovery_cycle() {
        let (dir, index) = setup();
        fs::write(journal_path(dir.path()), b"").unwrap();
        assert!(!pending(dir.path()).unwrap());
        assert!(recover_resources(dir.path(), &index).unwrap().is_none());
    }
    #[test]
    fn phase_context_preserves_semantic_code_literal_details_and_deepest_operation() {
        let io = std::io::Error::from_raw_os_error(5);
        let literal = io.to_string();
        let from = Path::new("literal source {name}");
        let to = Path::new("literal target 日本語");
        let error = io_context(io, "publish_source_backup", from, Some(to));
        let enriched = phase_context(error, "outer_phase", Path::new("not used"));
        let value = serde_json::to_value(&enriched).unwrap();
        assert_eq!(value["code"], "error.io");
        assert_eq!(value["params"]["details"], literal);
        assert_eq!(
            value["params"]["resourceTransaction"]["phase"],
            "publish_source_backup"
        );
        assert_eq!(
            value["params"]["resourceTransaction"]["from"],
            "literal source {name}"
        );
        assert_eq!(
            value["params"]["resourceTransaction"]["to"],
            "literal target 日本語"
        );
        assert_eq!(value["params"]["resourceTransaction"]["osCode"], 5);
        let semantic = AppError::code(
            "settings.transactionUncertain",
            serde_json::json!({
                "error": AppError::code("error.settingsSingleton", serde_json::json!({"count": 2})),
                "path": "authored path {literal}",
            }),
        );
        let original_bytes = serde_json::to_vec(&semantic).unwrap();
        assert_eq!(
            serde_json::to_vec(&phase_context(semantic, "outer_phase", from)).unwrap(),
            original_bytes
        );
        let authored = AppError::text("literal custom error");
        assert_eq!(
            serde_json::to_value(phase_context(authored.clone(), "stage", from)).unwrap(),
            serde_json::to_value(authored).unwrap()
        );
    }
}
