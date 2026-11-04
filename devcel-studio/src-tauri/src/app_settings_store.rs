//! One ordinary, machine-local Devcel project is the settings source of truth.
//! A compiled snapshot is a disposable cache, never a second editable owner.
//! Settings bundles are validated before they enter the atomic snapshot store.
use crate::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const STATE: &str = "settings-state";
const PROJECT: &str = "studio.devcelproj.toml";
const MAX_BYTES: u64 = 64 * 1024 * 1024;
static VALIDATED_REVISIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static READ_CACHE: OnceLock<Mutex<HashMap<PathBuf, (String, AppSettingsSnapshot)>>> =
    OnceLock::new();
fn read_cache() -> &'static Mutex<HashMap<PathBuf, (String, AppSettingsSnapshot)>> {
    READ_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsSnapshot {
    pub revision: String,
    pub generation: String,
    pub bundle: Value,
    pub warning: Option<Vec<AppError>>,
    pub migration_failed: bool,
    pub app_version: String,
    pub migrated_from_version: Option<String>,
    pub source: String,
    pub project_path: String,
    pub resolved_locale: String,
    pub available_locales: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Generation {
    schema_version: u32,
    generation: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSnapshot {
    schema_version: u32,
    generation: String,
    source_revision: String,
    revision: String,
    bundle: Value,
}
/// Hold for the entire settings-editor process lifetime. Reset never interrupts
/// an active editor, so queued writes cannot restore pre-reset source tables.
pub struct EditorLease {
    pub generation: String,
    pub project_path: PathBuf,
    _lock: File,
}
pub fn project_path(config: &Path) -> PathBuf {
    config.join("settings").join(PROJECT)
}
fn state_path(config: &Path, file: &str) -> PathBuf {
    config.join(STATE).join(file)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn bounded_read(path: &Path) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(AppError::code(
            "settings.fileTooLarge",
            serde_json::json!({}),
        ));
    }
    Ok(bytes)
}
fn atomic_write(path: &Path, value: &impl Serialize) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::code("settings.stateDirectoryMissing", serde_json::json!({})))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(AppError::technical)?;
    Ok(())
}
fn open_lock(config: &Path, name: &str) -> Result<File, AppError> {
    std::fs::create_dir_all(config.join(STATE))?;
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(state_path(config, name))?)
}
fn snapshot_lock(config: &Path) -> Result<File, AppError> {
    crate::settings_profile::prepare(config)?;
    let file = open_lock(config, "snapshot.lock")?;
    file.lock()?;
    Ok(file)
}
fn editor_lock(config: &Path) -> Result<File, AppError> {
    crate::settings_profile::prepare(config)?;
    let file = open_lock(config, "editor.lock")?;
    file.try_lock()
        .map_err(|_| AppError::code("settings.editorBusy", serde_json::json!({})))?;
    Ok(file)
}
pub fn current_generation(config: &Path) -> Result<String, AppError> {
    let value: Generation =
        serde_json::from_slice(&bounded_read(&state_path(config, "generation.json"))?)?;
    if value.schema_version != 1 || uuid::Uuid::parse_str(&value.generation).is_err() {
        return Err(AppError::code(
            "settings.generationInvalid",
            serde_json::json!({}),
        ));
    }
    Ok(value.generation)
}
fn write_generation(config: &Path, generation: &str) -> Result<(), AppError> {
    atomic_write(
        &state_path(config, "generation.json"),
        &Generation {
            schema_version: 1,
            generation: generation.into(),
        },
    )
}
fn validate_bundle(bundle: &Value) -> Result<(), AppError> {
    let _: devcel_core::app_catalog::CompiledAppSettings = serde_json::from_value(bundle.clone())?;
    // The checksum detects damaged cache data. Structural checks prevent an
    // unrelated JSON object from masquerading as a compiled settings snapshot.
    if bundle["schemaVersion"] != 2
        || !bundle["values"].is_object()
        || !bundle["themes"].is_array()
        || !bundle["themeCss"].is_string()
        || !bundle["localization"]["locales"].is_object()
        || !bundle["localization"]["messages"].is_object()
        || !bundle["values"]["automaticUpdateChecks"].is_boolean()
    {
        return Err(AppError::code(
            "settings.snapshotInvalid",
            serde_json::json!({}),
        ));
    }
    for key in ["locale", "theme", "color32Display", "colorFloatDisplay"] {
        if !bundle["values"][key].is_string() {
            return Err(AppError::code(
                "settings.compiledValueInvalid",
                serde_json::json!({ "key": key }),
            ));
        }
    }
    Ok(())
}
fn revision(generation: &str, source: &str, bundle: &Value) -> Result<String, AppError> {
    Ok(digest(&serde_json::to_vec(&(generation, source, bundle))?))
}
fn read_stored(config: &Path, generation: &str) -> Result<StoredSnapshot, AppError> {
    let stored: StoredSnapshot =
        serde_json::from_slice(&bounded_read(&state_path(config, "last-valid.json"))?)?;
    validate_bundle(&stored.bundle)?;
    if stored.schema_version != 1
        || stored.generation != generation
        || stored.revision != revision(&stored.generation, &stored.source_revision, &stored.bundle)?
    {
        return Err(AppError::code(
            "settings.cacheInvalid",
            serde_json::json!({}),
        ));
    }
    Ok(stored)
}
fn user_settings_singleton_error(error: &AppError) -> bool {
    let matches = |code: &str, params: &Value| {
        code == "error.settingsSingleton"
            || (code == "settings.schema.singleton" && params["table"] == "UserSettings")
    };
    match error {
        AppError::Code { code, params } => matches(code, params),
        AppError::Diagnostics { diagnostics } => diagnostics.iter().any(|diagnostic| {
            matches!(diagnostic, devcel_core::types::Diagnostic::Code { code, params } if matches(code, params))
        }),
        _ => false,
    }
}

fn snapshot(
    config: &Path,
    stored: StoredSnapshot,
    source: &str,
    warning: Option<AppError>,
) -> AppSettingsSnapshot {
    let mut warnings: Vec<AppError> = warning.into_iter().collect();
    if warnings.iter().any(user_settings_singleton_error) {
        // Recovery is explicit and non-destructive. Keep the malformed source
        // and the last-valid/default values; never choose a row on the user's behalf.
        let table = config.join("settings/Tables/UserSettings.table.toml");
        let repair_path = if table.is_file() {
            table
        } else {
            config.join("settings")
        };
        warnings.push(AppError::code(
            "settings.singletonRepair",
            serde_json::json!({
                "path": repair_path.to_string_lossy(), "source": source,
            }),
        ));
    }
    if let Some(items) = stored.bundle["warnings"].as_array() {
        warnings.extend(items.iter().map(|item| {
            // Only legacy cache entries are text. Current compiler diagnostics
            // retain their code and parameters through the native boundary.
            if let Some(details) = item.as_str() {
                AppError::code(
                    "settings.legacyWarning",
                    serde_json::json!({ "details": details }),
                )
            } else {
                serde_json::from_value(item.clone())
                    .expect("settings bundle warnings are validated")
            }
        }));
    }
    let warning = (!warnings.is_empty()).then_some(warnings);
    let available_locales = stored.bundle["localization"]["locales"]
        .as_object()
        .map(|locales| {
            locales
                .keys()
                .filter(|locale| locale.as_str() != "en-XA" || cfg!(debug_assertions))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected = stored.bundle["values"]["locale"]
        .as_str()
        .unwrap_or("system");
    let resolved_locale = if selected == "system" {
        crate::locale_settings::system_locale_for(&available_locales)
    } else {
        selected.to_owned()
    };
    AppSettingsSnapshot {
        revision: stored.revision,
        generation: stored.generation,
        bundle: stored.bundle,
        warning,
        migration_failed: false,
        migrated_from_version: crate::settings_profile::migration_source(config),
        app_version: if config
            .parent()
            .is_some_and(|p| p.file_name().is_some_and(|n| n == "settings-versions"))
        {
            config.file_name().unwrap().to_string_lossy().into_owned()
        } else {
            serde_json::from_str::<serde_json::Value>(include_str!("../tauri.conf.json"))
                .expect("valid Tauri configuration")["version"]
                .as_str()
                .expect("Studio product version")
                .into()
        },
        source: source.into(),
        project_path: project_path(config).to_string_lossy().into_owned(),
        resolved_locale,
        available_locales,
    }
}
fn embedded(config: &Path, generation: &str, warning: Option<AppError>) -> AppSettingsSnapshot {
    let bundle: Value = serde_json::from_str(include_str!(
        "../../src/app/settings/generated/catalog.json"
    ))
    .expect("validated settings catalog is bundled at build time");
    let revision = revision(generation, "embedded", &bundle).expect("bundled catalog serializes");
    snapshot(
        config,
        StoredSnapshot {
            schema_version: 1,
            generation: generation.into(),
            source_revision: "embedded".into(),
            revision,
            bundle,
        },
        "embedded",
        warning,
    )
}
fn collect_sources(
    root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    if directory
        .strip_prefix(root)
        .map_err(AppError::technical)?
        .components()
        .count()
        > 32
    {
        return Err(AppError::code(
            "settings.sourceNestingTooDeep",
            serde_json::json!({}),
        ));
    }
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_symlink() {
            return Err(AppError::code(
                "settings.sourceSymlink",
                serde_json::json!({}),
            ));
        }
        if kind.is_dir() {
            collect_sources(root, &path, files)?;
        } else if kind.is_file()
            && path
                .extension()
                .is_some_and(|extension| extension == "toml")
        {
            files.push(
                path.strip_prefix(root)
                    .map_err(AppError::technical)?
                    .to_owned(),
            );
            if files.len() > 512 {
                return Err(AppError::code(
                    "settings.sourceTooManyFiles",
                    serde_json::json!({}),
                ));
            }
        }
    }
    Ok(())
}
/// Normal table commands (including Undo/Redo) do not hold snapshot.lock.
/// Share their temporary target locks so compilation cannot observe the interval
/// between the two renames of an ordinary multi-table transaction. Lock ordering
/// is snapshot -> sorted source paths, identical to the typed gateway's writes.
pub(crate) fn source_read_locks(
    config: &Path,
) -> Result<Vec<devcel_core::write_locks::LockGuard>, AppError> {
    Ok(source_read_locks_with_paths(config)?
        .into_iter()
        .map(|(_, file)| file)
        .collect())
}

fn source_read_locks_with_paths(
    config: &Path,
) -> Result<Vec<(PathBuf, devcel_core::write_locks::LockGuard)>, AppError> {
    let root = config.join("settings");
    if std::fs::symlink_metadata(&root)?.file_type().is_symlink() {
        return Err(AppError::code(
            "settings.sourceSymlink",
            serde_json::json!({}),
        ));
    }
    let mut files = Vec::new();
    collect_sources(&root, &root, &mut files)?;
    files.sort();
    let targets = files
        .iter()
        .map(|relative| root.join(relative))
        .collect::<Vec<_>>();
    let locks =
        devcel_core::write_locks::lock_files(targets.iter().map(|path| path.as_path()), true)?;
    // A renamed/added source while acquiring locks is not covered by this set.
    let mut after = Vec::new();
    collect_sources(&root, &root, &mut after)?;
    after.sort();
    if after != files {
        return Err(AppError::code(
            "settings.sourceChanging",
            serde_json::json!({}),
        ));
    }
    Ok(locks)
}

fn reject_pending_resources(config: &Path) -> Result<(), AppError> {
    if crate::settings_resources_store::pending(config)? {
        return Err(AppError::code(
            "settings.resourcesRecoveryRequired",
            serde_json::json!({
                "path": config.to_string_lossy(),
                "error": AppError::code("settings.transactionInterrupted", serde_json::json!({})),
            }),
        ));
    }
    Ok(())
}
fn quick_stamp(config: &Path) -> Result<String, AppError> {
    reject_pending_resources(config)?;
    let root = config.join("settings");
    if std::fs::symlink_metadata(&root)?.file_type().is_symlink() {
        return Err(AppError::code(
            "settings.sourceSymlink",
            serde_json::json!({}),
        ));
    }
    let mut files = Vec::new();
    collect_sources(&root, &root, &mut files)?;
    files.sort();
    let mut hash = Sha256::new();
    for relative in files {
        let metadata = std::fs::metadata(root.join(&relative))?;
        hash.update(relative.to_string_lossy().as_bytes());
        hash.update(metadata.len().to_le_bytes());
        hash.update(
            metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(AppError::technical)?
                .as_nanos()
                .to_le_bytes(),
        );
    }
    // Small state metadata invalidates cached fallback/warnings across processes.
    hash.update(current_generation(config)?.as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}
fn cache_success(config: &Path, snapshot: &AppSettingsSnapshot, expected_stamp: Option<String>) {
    if let Ok(stamp) = quick_stamp(config) {
        if expected_stamp.as_ref() != Some(&stamp) {
            return;
        }
        if let Ok(mut cache) = read_cache().lock() {
            cache.insert(config.to_owned(), (stamp, snapshot.clone()));
        }
    }
}
fn source_revision(root: &Path) -> Result<String, AppError> {
    if std::fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(AppError::code(
            "settings.sourceSymlink",
            serde_json::json!({}),
        ));
    }
    let mut files = Vec::new();
    collect_sources(root, root, &mut files)?;
    files.sort();
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    for relative in files {
        let bytes = bounded_read(&root.join(&relative))?;
        total += bytes.len() as u64;
        if total > MAX_BYTES {
            return Err(AppError::code(
                "settings.sourceTooLarge",
                serde_json::json!({}),
            ));
        }
        let name = relative.to_string_lossy();
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn compile(path: &Path) -> Result<Value, AppError> {
    let project = devcel_core::localization::load(path).map_err(AppError::from)?;
    let compiled = crate::settings_seed::compile_runtime(&project).map_err(AppError::from)?;
    let bundle = serde_json::to_value(compiled)?;
    validate_bundle(&bundle)?;
    Ok(bundle)
}
fn seed_staged(config: &Path) -> Result<tempfile::TempDir, AppError> {
    let staged = tempfile::Builder::new()
        .prefix(".settings-seed-")
        .tempdir_in(config)?;
    crate::settings_seed::seed_project(staged.path()).map_err(AppError::from)?;
    compile(&staged.path().join(PROJECT))?;
    Ok(staged)
}
/// Called only under snapshot lock. Existing or incomplete state is never
/// mistaken for first run and never silently reseeded.
fn ensure_source(config: &Path) -> Result<String, AppError> {
    // Registration recovery needs the package-store lock first. Readers never
    // take that lock in reverse order or guess which index image committed.
    reject_pending_resources(config)?;
    let generation = state_path(config, "generation.json");
    if generation.exists() {
        return current_generation(config);
    }
    if config.join("profile.json").exists()
        || config.join("settings").exists()
        || state_path(config, "last-valid.json").exists()
    {
        return Err(AppError::code(
            "settings.generationMissing",
            serde_json::json!({}),
        ));
    }
    let staged = seed_staged(config)?;
    std::fs::rename(staged.path(), config.join("settings"))?;
    let generation = uuid::Uuid::new_v4().to_string();
    write_generation(config, &generation)?;
    Ok(generation)
}
fn refresh_locked(config: &Path, generation: &str) -> Result<AppSettingsSnapshot, AppError> {
    let _source_locks = source_read_locks(config)?;
    let root = config.join("settings");
    let before_stamp = quick_stamp(config)?;
    let before = source_revision(&root)?;
    if let Ok(stored) = read_stored(config, generation) {
        let validated = VALIDATED_REVISIONS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(AppError::from)?;
        if stored.source_revision == before && validated.contains(&stored.revision) {
            return Ok(snapshot(config, stored, "project", None));
        }
    }
    let bundle = compile(&project_path(config))?;
    if source_revision(&root)? != before
        || quick_stamp(config)? != before_stamp
        || current_generation(config)? != generation
    {
        return Err(AppError::code(
            "settings.sourceChanging",
            serde_json::json!({}),
        ));
    }
    let stored = StoredSnapshot {
        schema_version: 1,
        generation: generation.into(),
        revision: revision(generation, &before, &bundle)?,
        source_revision: before,
        bundle,
    };
    atomic_write(&state_path(config, "last-valid.json"), &stored)?;
    if let Ok(mut validated) = VALIDATED_REVISIONS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    {
        if validated.len() > 2048 {
            validated.clear();
        }
        validated.insert(stored.revision.clone());
    }
    Ok(snapshot(config, stored, "project", None))
}
/// Strict refresh for a queued editor generation; retired work cannot publish.
pub fn refresh(
    config: &Path,
    expected_generation: Option<&str>,
) -> Result<AppSettingsSnapshot, AppError> {
    let _lock = snapshot_lock(config)?;
    if let Ok(mut cache) = read_cache().lock() {
        cache.remove(config);
    }
    let generation = ensure_source(config)?;
    let stamp = quick_stamp(config).ok();
    if expected_generation.is_some_and(|expected| expected != generation) {
        return Err(AppError::code(
            "settings.staleGeneration",
            serde_json::json!({}),
        ));
    }
    let snapshot = refresh_locked(config, &generation)?;
    cache_success(config, &snapshot, stamp);
    Ok(snapshot)
}
/// Startup/focus never fail merely because the editable source is incomplete.
/// Preserve source and return the last compiled value, or embedded baseline.
pub fn load(config: &Path) -> AppSettingsSnapshot {
    // Focus refresh normally only stats the small set of source files. Actual
    // saves/watch invalidations call refresh(), which always hashes source bytes.
    if let Ok(stamp) = quick_stamp(config) {
        if let Ok(cache) = read_cache().lock() {
            if let Some((cached_stamp, snapshot)) = cache.get(config) {
                if *cached_stamp == stamp {
                    return snapshot.clone();
                }
            }
        }
    }
    match refresh(config, None) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            if config
                .parent()
                .is_some_and(|p| p.file_name().is_some_and(|n| n == "settings-versions"))
                && !config.join("profile.json").is_file()
            {
                match crate::settings_profile::recover_uninitialized(config, &error) {
                    Ok(true) => match refresh(config, None) {
                        Ok(snapshot) => return snapshot,
                        Err(recovery_error) => {
                            eprintln!("Settings recovery publish failed: {recovery_error}")
                        }
                    },
                    Ok(false) => {}
                    Err(recovery_error) => eprintln!("Settings recovery failed: {recovery_error}"),
                }
                eprintln!("Settings migration failed: {error}");
                let mut snapshot = embedded(config, "uninitialized", None);
                snapshot.migration_failed = true;
                return snapshot;
            }
            let generation = current_generation(config).unwrap_or_else(|_| "uninitialized".into());
            let warning = Some(error);
            match read_stored(config, &generation) {
                Ok(stored) => snapshot(config, stored, "lastValid", warning),
                Err(_) => embedded(config, &generation, warning),
            }
        }
    }
}
/// A gateway transaction holds this lock while validating and committing source.
/// It never reads a last-valid bundle as an editable source.
pub(crate) fn transaction_snapshot_lock(config: &Path) -> Result<File, AppError> {
    snapshot_lock(config)
}

pub(crate) struct StrictSource {
    pub generation: String,
    pub source_revision: String,
    pub bundle: Value,
}

/// Caller holds transaction_snapshot_lock and, for writes, the editor writer lease.
pub(crate) fn read_source_locked(config: &Path) -> Result<StrictSource, AppError> {
    let generation = ensure_source(config)?;
    let _source_locks = source_read_locks(config)?;
    let before_stamp = quick_stamp(config)?;
    let before = source_revision(&config.join("settings"))?;
    let bundle = compile(&project_path(config))?;
    if quick_stamp(config)? != before_stamp
        || source_revision(&config.join("settings"))? != before
        || current_generation(config)? != generation
    {
        return Err(AppError::code(
            "settings.sourceChanging",
            serde_json::json!({}),
        ));
    }
    Ok(StrictSource {
        generation,
        source_revision: before,
        bundle,
    })
}

/// Keep this guard until update installation/restart completes or is cancelled.
pub fn acquire_update_lock(config: &Path) -> Result<File, AppError> {
    editor_lock(config)
}
pub fn acquire_editor(config: &Path) -> Result<EditorLease, AppError> {
    let lock = editor_lock(config)?;
    let _snapshot_lock = snapshot_lock(config)?;
    let generation = ensure_source(config)?;
    quick_stamp(config)?; // Reject root or descendant symlinks before the editor opens.
                          // Invalid cells must remain editable. Only the project entrypoint must exist;
                          // compilation errors are shown through load() while normal editing repairs it.
    if !project_path(config).is_file() {
        return Err(AppError::code(
            "settings.projectMissing",
            serde_json::json!({}),
        ));
    }
    Ok(EditorLease {
        generation,
        project_path: project_path(config),
        _lock: lock,
    })
}
/// Explicit all-settings reset. The intact old project is retained beside the
/// fresh project. An active editor causes rejection rather than stale-save races.
pub fn reset(config: &Path, expected_generation: &str) -> Result<AppSettingsSnapshot, AppError> {
    reject_pending_resources(config)?;
    if crate::settings_profile::reset_uninitialized(config, expected_generation)? {
        return refresh(config, None);
    }
    let _editor = editor_lock(config)?;
    let _snapshot = snapshot_lock(config)?;
    ensure_source(config)?;
    let actual = current_generation(config).unwrap_or_else(|_| "uninitialized".into());
    if actual != expected_generation {
        return Err(AppError::code(
            "settings.staleGeneration",
            serde_json::json!({}),
        ));
    }
    let staged = seed_staged(config)?;
    let root = config.join("settings");
    let backup = config.join(format!("settings-backup-{}", uuid::Uuid::new_v4()));
    if root.exists() {
        std::fs::rename(&root, &backup)?;
    }
    if let Err(error) = std::fs::rename(staged.path(), &root) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &root);
        }
        return Err(error.into());
    }
    let generation = uuid::Uuid::new_v4().to_string();
    write_generation(config, &generation)?;
    refresh_locked(config, &generation)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn user_table(config: &Path) -> PathBuf {
        config.join("settings/Tables/UserSettings.table.toml")
    }
    fn edited_theme(config: &Path, theme: &str) -> String {
        std::fs::read_to_string(user_table(config))
            .unwrap()
            .replace("\ntheme = \"system\"", &format!("\ntheme = \"{theme}\""))
    }
    #[test]
    fn seeds_real_project_without_reading_previous_owners() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("ui-preferences.json"),
            "do not read or change",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("app-settings.json"),
            "do not read or change",
        )
        .unwrap();
        let snapshot = load(dir.path());
        assert_eq!(snapshot.source, "project", "{:?}", snapshot.warning);
        assert_eq!(snapshot.bundle["values"]["locale"], "system");
        assert!(project_path(dir.path()).is_file());
        assert!(user_table(dir.path()).is_file());
        for name in ["ui-preferences.json", "app-settings.json"] {
            assert_eq!(
                std::fs::read_to_string(dir.path().join(name)).unwrap(),
                "do not read or change"
            );
        }
    }
    #[test]
    fn committed_edits_undo_and_redo_compile_the_entire_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path();
        let initial = load(config);
        let original = std::fs::read(user_table(config)).unwrap();
        let dark = edited_theme(config, "dark");
        std::fs::write(user_table(config), &dark).unwrap();
        let edited = refresh(config, Some(&initial.generation)).unwrap();
        assert_eq!(edited.bundle["values"]["theme"], "dark");
        assert_ne!(initial.revision, edited.revision);
        assert!(edited.bundle["localization"]["messages"].is_object());
        std::fs::write(user_table(config), original).unwrap();
        let undo = refresh(config, Some(&initial.generation)).unwrap();
        assert_eq!(undo.bundle["values"]["theme"], "system");
        std::fs::write(user_table(config), dark).unwrap();
        assert_eq!(
            refresh(config, Some(&initial.generation)).unwrap().bundle["values"]["theme"],
            "dark"
        );
    }
    #[test]
    fn invalid_intermediate_source_preserves_last_valid_and_source_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path();
        let initial = load(config);
        let snapshot_bytes = std::fs::read(state_path(config, "last-valid.json")).unwrap();
        let invalid = edited_theme(config, "missing-theme");
        std::fs::write(user_table(config), &invalid).unwrap();
        let fallback = load(config);
        assert_eq!(fallback.source, "lastValid");
        assert_eq!(fallback.revision, initial.revision);
        assert!(fallback.warning.is_some());
        assert_eq!(
            std::fs::read_to_string(user_table(config)).unwrap(),
            invalid
        );
        assert_eq!(
            std::fs::read(state_path(config, "last-valid.json")).unwrap(),
            snapshot_bytes
        );
        std::fs::write(user_table(config), "[invalid").unwrap();
        assert_eq!(load(config).source, "lastValid");
    }
    #[test]
    fn singleton_warning_keeps_semantic_code_and_last_valid_values_and_source_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path();
        let initial = load(config);
        let original = std::fs::read_to_string(user_table(config)).unwrap();
        let snapshot_bytes = std::fs::read(state_path(config, "last-valid.json")).unwrap();
        for count in [0, 2] {
            let mut table: toml::Value = toml::from_str(&original).unwrap();
            let first = table["records"].as_array().unwrap()[0].clone();
            let mut second = first.clone();
            second["uuid"] = toml::Value::String(uuid::Uuid::new_v4().to_string());
            second["label"] = toml::Value::String("Recovery fixture second record".into());
            second["values"]["theme"] = toml::Value::String("dark".into());
            table["records"] = toml::Value::Array(if count == 0 {
                vec![]
            } else {
                vec![first, second]
            });
            let invalid = toml::to_string(&table).unwrap();
            std::fs::write(user_table(config), &invalid).unwrap();
            let result = load(config);
            assert_eq!(result.source, "lastValid");
            assert_eq!(result.bundle, initial.bundle);
            let wire = serde_json::to_value(result).unwrap();
            assert_eq!(
                wire["warning"][0]["diagnostics"][0]["code"],
                "settings.schema.singleton"
            );
            assert_eq!(
                wire["warning"][0]["diagnostics"][0]["params"]["count"],
                count
            );
            assert_eq!(wire["warning"][1]["code"], "settings.singletonRepair");
            assert_eq!(wire["warning"][1]["params"]["source"], "lastValid");
            assert_eq!(
                wire["warning"][1]["params"]["path"],
                user_table(config).to_string_lossy().as_ref()
            );
            assert!(!wire["warning"].to_string().contains("Validation error:"));
            assert_eq!(
                std::fs::read_to_string(user_table(config)).unwrap(),
                invalid
            );
            assert_eq!(
                std::fs::read(state_path(config, "last-valid.json")).unwrap(),
                snapshot_bytes
            );
        }
        // Returning focus after an explicit source repair recovers without a reset.
        std::fs::write(user_table(config), original).unwrap();
        let recovered = load(config);
        assert_eq!(recovered.source, "project");
        assert!(recovered.warning.is_none());
        assert_eq!(recovered.bundle, initial.bundle);
    }

    #[test]
    fn legacy_cache_warnings_remain_readable_and_new_warnings_keep_parameters() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path();
        let initial = load(config);
        let mut stored = read_stored(config, &initial.generation).unwrap();
        stored.bundle["warnings"] = serde_json::json!(["old compiler warning"]);
        validate_bundle(&stored.bundle).unwrap();
        let legacy = snapshot(config, stored, "lastValid", None);
        let wire = serde_json::to_value(legacy).unwrap();
        assert_eq!(wire["warning"][0]["code"], "settings.legacyWarning");
        assert_eq!(
            wire["warning"][0]["params"]["details"],
            "old compiler warning"
        );
        let mut stored = read_stored(config, &initial.generation).unwrap();
        stored.bundle["warnings"] = serde_json::json!([{
            "kind": "code", "code": "settings.translationMissingFallback",
            "params": { "key": "literal.key", "locale": "fr" }
        }]);
        validate_bundle(&stored.bundle).unwrap();
        let current = snapshot(config, stored, "project", None);
        let wire = serde_json::to_value(current).unwrap();
        assert_eq!(
            wire["warning"][0]["code"],
            "settings.translationMissingFallback"
        );
        assert_eq!(wire["warning"][0]["params"]["key"], "literal.key");
    }

    #[test]
    fn corrupt_cache_and_source_fall_back_without_repair() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path();
        load(config);
        std::fs::write(user_table(config), "invalid source").unwrap();
        std::fs::write(state_path(config, "last-valid.json"), "invalid snapshot").unwrap();
        let fallback = load(config);
        assert_eq!(fallback.source, "embedded");
        assert!(fallback.warning.is_some());
        assert_eq!(
            std::fs::read_to_string(user_table(config)).unwrap(),
            "invalid source"
        );
        assert_eq!(
            std::fs::read_to_string(state_path(config, "last-valid.json")).unwrap(),
            "invalid snapshot"
        );
    }
    #[test]
    fn reset_requires_closed_editor_preserves_backup_and_retires_generation() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path();
        let initial = load(config);
        let update = acquire_update_lock(config).unwrap();
        assert!(acquire_editor(config).is_err());
        assert!(reset(config, &initial.generation).is_err());
        drop(update);
        let lease = acquire_editor(config).unwrap();
        assert_eq!(lease.generation, initial.generation);
        assert_eq!(lease.project_path, project_path(config));
        assert!(acquire_update_lock(config).is_err());
        assert!(acquire_editor(config).is_err());
        assert!(reset(config, &initial.generation).is_err());
        std::fs::write(user_table(config), "unfinished personal edit").unwrap();
        drop(lease);
        let fresh = reset(config, &initial.generation).unwrap();
        assert_ne!(fresh.generation, initial.generation);
        assert_eq!(fresh.bundle["values"]["theme"], "system");
        let backups: Vec<_> = std::fs::read_dir(config)
            .unwrap()
            .map(|v| v.unwrap().path())
            .filter(|v| {
                v.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("settings-backup-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            std::fs::read_to_string(backups[0].join("Tables/UserSettings.table.toml")).unwrap(),
            "unfinished personal edit"
        );
        assert!(refresh(config, Some(&initial.generation)).is_err());
        assert!(reset(config, &initial.generation).is_err());
        assert_eq!(load(config).generation, fresh.generation);
    }
    #[test]
    fn atomic_snapshot_failure_does_not_modify_source() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path();
        let initial = load(config);
        let dark = edited_theme(config, "dark");
        std::fs::write(user_table(config), &dark).unwrap();
        std::fs::remove_file(state_path(config, "last-valid.json")).unwrap();
        std::fs::create_dir(state_path(config, "last-valid.json")).unwrap();
        assert!(refresh(config, Some(&initial.generation)).is_err());
        assert_eq!(std::fs::read_to_string(user_table(config)).unwrap(), dark);
        assert!(state_path(config, "last-valid.json").is_dir());
    }
    #[test]
    fn startup_unwritable_state_and_missing_generation_never_destroy_source() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path();
        std::fs::write(config.join(STATE), "occupied").unwrap();
        assert_eq!(load(config).source, "embedded");
        assert_eq!(
            std::fs::read_to_string(config.join(STATE)).unwrap(),
            "occupied"
        );
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path();
        std::fs::create_dir(config.join("settings")).unwrap();
        std::fs::write(config.join("settings/keep.txt"), "personal source").unwrap();
        assert_eq!(load(config).source, "embedded");
        assert_eq!(
            std::fs::read_to_string(config.join("settings/keep.txt")).unwrap(),
            "personal source"
        );
        assert!(!project_path(config).exists());
    }
    fn source_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("settings/Tables")).unwrap();
        std::fs::write(
            dir.path().join("settings/studio.devcelproj.toml"),
            b"project bytes",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("settings/Tables/a.table.toml"),
            b"authored bytes",
        )
        .unwrap();
        dir
    }
    fn assert_temp_writer_blocked(path: &Path) {
        let writer = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        assert!(matches!(
            writer.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
    }
    #[test]
    fn temp_source_locks_survive_swap_and_rollback_without_project_artifacts() {
        let dir = source_fixture();
        let config = dir.path();
        let root = config.join("settings");
        let stage = config.join("stage");
        let backup = config.join("backup");
        let guard = source_read_locks(config).unwrap();
        let target = root.join("Tables/a.table.toml");
        let lock = devcel_core::write_locks::path_for_target(&target).unwrap();
        assert!(!lock.starts_with(config));
        assert_temp_writer_blocked(&lock);
        let reader = source_read_locks(config).unwrap();
        drop(reader);
        std::fs::create_dir_all(stage.join("Tables")).unwrap();
        std::fs::write(stage.join("studio.devcelproj.toml"), b"project bytes").unwrap();
        std::fs::write(stage.join("Tables/a.table.toml"), b"proposed bytes").unwrap();
        std::fs::rename(&root, &backup).unwrap();
        assert_temp_writer_blocked(&lock);
        std::fs::rename(&stage, &root).unwrap();
        assert_eq!(
            devcel_core::write_locks::path_for_target(&target).unwrap(),
            lock
        );
        assert_temp_writer_blocked(&lock);
        std::fs::rename(&root, &stage).unwrap();
        std::fs::rename(&backup, &root).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"authored bytes");
        drop(guard);
        assert!(!lock.exists());
        fn no_locks(path: &Path) {
            for entry in std::fs::read_dir(path).unwrap() {
                let p = entry.unwrap().path();
                assert!(!p.file_name().unwrap().to_string_lossy().contains(".lock"));
                if p.is_dir() {
                    no_locks(&p);
                }
            }
        }
        no_locks(config);
    }
    #[test]
    fn temp_source_locks_release_on_unwind_without_cleanup_files() {
        let dir = source_fixture();
        let target = dir.path().join("settings/Tables/a.table.toml");
        let lock = devcel_core::write_locks::path_for_target(&target).unwrap();
        let panic = std::panic::catch_unwind(|| {
            let _guard = source_read_locks(dir.path()).unwrap();
            assert_temp_writer_blocked(&lock);
            panic!("injected source publication unwind");
        });
        assert!(panic.is_err());
        assert!(!lock.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
