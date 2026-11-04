//! Exact application-version ownership. Only completed ordinary projects are migration sources.
//! Initialization is journaled outside the live profile; no old profile is modified.
use crate::AppError;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;
const PROJECT: &str = "studio.devcelproj.toml";
const MANIFEST: &str = "profile.json";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    app_version: String,
    baseline_digest: String,
    migrated_from: Option<String>,
    warnings: Vec<String>,
}
pub(crate) fn directory(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(AppError::technical)?
        .join("settings-versions")
        .join(app.package_info().version.to_string()))
}
fn regular(path: &Path) -> Result<(), AppError> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(AppError::code(
            "settings.sourceSymlink",
            serde_json::json!({}),
        ));
    }
    Ok(())
}
fn read_profile(root: &Path) -> Result<Profile, AppError> {
    read_manifest(
        root,
        root.file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| AppError::code("settings.profileInvalid", serde_json::json!({})))?,
    )
}
fn read_manifest(root: &Path, expected_version: &str) -> Result<Profile, AppError> {
    regular(root)?;
    let path = root.join(MANIFEST);
    regular(&path)?;
    let mut bytes = Vec::new();
    File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(AppError::code(
            "settings.fileTooLarge",
            serde_json::json!({}),
        ));
    }
    let profile: Profile = serde_json::from_slice(&bytes)?;
    let version = Version::parse(&profile.app_version).map_err(|error| {
        AppError::code(
            "settings.profileInvalid",
            serde_json::json!({ "details": error.to_string() }),
        )
    })?;
    if version.to_string() != expected_version {
        return Err(AppError::code(
            "settings.profileInvalid",
            serde_json::json!({}),
        ));
    }
    Ok(profile)
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), AppError> {
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or_else(|| {
            AppError::code("settings.stateDirectoryMissing", serde_json::json!({}))
        })?)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(AppError::technical)?;
    Ok(())
}
fn sync_tree(root: &Path) -> Result<(), AppError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        regular(&path)?;
        if entry.file_type()?.is_dir() {
            sync_tree(&path)?;
        } else if entry.file_type()?.is_file() {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)?
                .sync_all()?;
        }
    }
    #[cfg(unix)]
    File::open(root)?.sync_all()?;
    Ok(())
}
fn sync_directory(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn baseline_digest(root: &Path) -> Result<String, AppError> {
    fn visit(
        root: &Path,
        path: &Path,
        depth: usize,
        files: &mut Vec<PathBuf>,
    ) -> Result<(), AppError> {
        regular(path)?;
        if depth > 32 {
            return Err(AppError::code(
                "settings.sourceNestingTooDeep",
                serde_json::json!({}),
            ));
        }
        if files.len() > 512 {
            return Err(AppError::code(
                "settings.sourceTooManyFiles",
                serde_json::json!({}),
            ));
        }
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let path = entry.path();
            regular(&path)?;
            if entry.file_type()?.is_dir() {
                visit(root, &path, depth + 1, files)?;
            } else if path.extension().is_some_and(|v| v == "toml") {
                files.push(
                    path.strip_prefix(root)
                        .map_err(AppError::technical)?
                        .to_owned(),
                );
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, root, 0, &mut files)?;
    files.sort();
    let mut hash = Sha256::new();
    let mut total = 0usize;
    for relative in files {
        let mut bytes = Vec::new();
        File::open(root.join(&relative))?
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        total += bytes.len();
        if total > 64 * 1024 * 1024 {
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
fn previous(versions: &Path, current: &Version) -> Result<Option<PathBuf>, AppError> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(versions)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(version) = Version::parse(&name) else {
            continue;
        };
        if !version.pre.is_empty() || version.cmp_precedence(current) != std::cmp::Ordering::Less {
            continue;
        }
        if entry.file_type()?.is_symlink() {
            return Err(AppError::code(
                "settings.sourceSymlink",
                serde_json::json!({}),
            ));
        }
        if !entry.file_type()?.is_dir() || !entry.path().join(MANIFEST).is_file() {
            continue;
        }
        candidates.push((version, name, entry.path()));
    }
    candidates.sort_by(|a, b| a.0.cmp_precedence(&b.0).then(a.1.cmp(&b.1)));
    Ok(candidates.pop().map(|v| v.2))
}
/// Release-owned changes are selected using the actual predecessor and target.
/// This is the first released settings contract, so no historical transforms exist.
/// Future releases append their ordered column conversions/removals here; skipped
/// upgrades receive every applicable transform rather than only the final hop.
fn release_steps(
    from: &Version,
    to: &Version,
) -> Result<Vec<devcel_core::app_settings_migration::MigrationStep<'static>>, AppError> {
    if from.cmp_precedence(to) != std::cmp::Ordering::Less {
        return Err(AppError::code(
            "settings.migrationVersionInvalid",
            serde_json::json!({}),
        ));
    }
    Ok(Vec::new())
}
pub(crate) fn migration_source(config: &Path) -> Option<String> {
    read_profile(config).ok().and_then(|p| p.migrated_from)
}
/// Keep direct temporary-root store tests independent from application version selection.
/// Every app entry point supplies settings-versions/<exact-version>.
pub(crate) fn prepare(config: &Path) -> Result<(), AppError> {
    prepare_internal(config, false)
}
/// Only structural/parse failures justify abandoning an uncommitted migration.
/// I/O, permissions, busy editors and unknown errors must remain retryable.
pub(crate) fn recover_uninitialized(config: &Path, error: &AppError) -> Result<bool, AppError> {
    let repairable = matches!(error, AppError::Code { code, .. } if matches!(code.as_str(),
        "settings.baselineInvalid" | "settings.profileInvalid" | "settings.generationInvalid"
        | "settings.migrationSourceMissing" | "error.parse" | "error.invalidData"));
    if !repairable {
        return Ok(false);
    }
    // The predecessor remains in its version directory. Partial current files
    // move to a unique backup before the normal validated, journaled seed publish.
    reset_uninitialized(config, "uninitialized")
}
/// Explicit reset may abandon a failed migration, preserving its partial files.
pub(crate) fn reset_uninitialized(config: &Path, expected: &str) -> Result<bool, AppError> {
    if expected != "uninitialized"
        || config
            .parent()
            .is_none_or(|p| p.file_name().is_none_or(|n| n != "settings-versions"))
        || config.join(MANIFEST).exists()
    {
        return Ok(false);
    }
    prepare_internal(config, true)?;
    Ok(true)
}
#[cfg(test)]
thread_local! {
    static SOURCE_VALIDATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn validate_source(source: &Path) -> Result<(), AppError> {
    #[cfg(test)]
    SOURCE_VALIDATIONS.with(|count| count.set(count.get() + 1));
    let project = devcel_core::localization::load(&source.join(PROJECT))?;
    crate::settings_seed::compile_runtime(&project)?;
    Ok(())
}
fn merge_projects_with_steps(
    base: &Path,
    user: &Path,
    next: &Path,
    steps: &[devcel_core::app_settings_migration::MigrationStep<'_>],
) -> devcel_core::Result<Vec<String>> {
    devcel_core::app_settings_migration::merge_projects_with_steps(
        base,
        user,
        next,
        steps,
        &|file| {
            crate::settings_seed::compile_runtime(&devcel_core::localization::load(file)?)
                .map(|_| ())
        },
    )
}

fn prepare_internal(config: &Path, fresh: bool) -> Result<(), AppError> {
    let Some(versions) = config
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "settings-versions"))
    else {
        return Ok(());
    };
    if config.join(MANIFEST).is_file() {
        if fresh {
            return Err(AppError::code(
                "settings.staleGeneration",
                serde_json::json!({}),
            ));
        }
        read_profile(config)?;
        return Ok(());
    }
    let name = config
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| AppError::code("settings.profileInvalid", serde_json::json!({})))?;
    let version = Version::parse(name).map_err(|error| {
        AppError::code(
            "settings.profileInvalid",
            serde_json::json!({ "details": error.to_string() }),
        )
    })?;
    fs::create_dir_all(versions)?;
    regular(versions)?;
    let lock_path = versions.join(format!(".{name}.initialize.lock"));
    if lock_path.exists() {
        regular(&lock_path)?;
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    lock.lock()?;
    if config.join(MANIFEST).is_file() {
        if fresh {
            return Err(AppError::code(
                "settings.staleGeneration",
                serde_json::json!({}),
            ));
        }
        read_profile(config)?;
        return Ok(());
    }
    let staged = versions.join(format!(".{name}.initializing"));
    if fresh {
        let backup = versions.join(format!(".{name}.reset-backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&backup)?;
        if config.exists() {
            regular(config)?;
            fs::rename(config, backup.join("profile"))?;
        }
        if staged.exists() {
            regular(&staged)?;
            fs::rename(&staged, backup.join("initializing"))?;
        }
    }
    if staged.exists() {
        regular(&staged)?;
    }
    // A ready manifest is a durable initialization journal. Complete its pending renames.
    let resuming_ready = staged.join(MANIFEST).is_file();
    if !resuming_ready {
        if staged.exists() {
            fs::remove_dir_all(&staged)?;
        }
        fs::create_dir(&staged)?;
        crate::settings_seed::seed_project(&staged.join("baseline"))?;
        crate::settings_seed::seed_project(&staged.join("settings"))?;
        let old = if fresh {
            None
        } else {
            previous(versions, &version)?
        };
        let mut warnings = Vec::new();
        let migrated_from = if let Some(old) = old {
            let profile = read_profile(&old)?;
            if baseline_digest(&old.join("baseline"))? != profile.baseline_digest {
                return Err(AppError::code(
                    "settings.baselineInvalid",
                    serde_json::json!({}),
                ));
            }
            // Missing source is structural damage; permission/stat failures remain I/O.
            if !old.join("settings").join(PROJECT).try_exists()?
                || !old.join("settings-state/generation.json").try_exists()?
            {
                return Err(AppError::code(
                    "settings.migrationSourceMissing",
                    serde_json::json!({}),
                ));
            }
            // Never initialize or repair a predecessor with the current binary.
            crate::app_settings_store::current_generation(&old)?;
            // This lease rejects an active editor without interrupting it. Source locks
            // additionally fence the ordinary editor's file-level save transactions.
            let _editor = crate::app_settings_store::acquire_editor(&old)?;
            let _snapshot = crate::app_settings_store::transaction_snapshot_lock(&old)?;
            let _sources = crate::app_settings_store::source_read_locks(&old)?;
            let steps = release_steps(
                &Version::parse(&profile.app_version).map_err(|error| {
                    AppError::code(
                        "settings.profileInvalid",
                        serde_json::json!({ "details": error.to_string() }),
                    )
                })?,
                &version,
            )?;
            warnings = merge_projects_with_steps(
                &old.join("baseline").join(PROJECT),
                &old.join("settings").join(PROJECT),
                &staged.join("settings").join(PROJECT),
                &steps,
            )?;
            Some(profile.app_version)
        } else {
            None
        };
        // A successful merge already compiled the complete proposal. A fresh seed
        // still needs validation; neither path may publish unvalidated source.
        if migrated_from.is_none() {
            validate_source(&staged.join("settings"))?;
        }
        fs::create_dir(staged.join("settings-state"))?;
        write_json(
            &staged.join("settings-state/generation.json"),
            &serde_json::json!({"schemaVersion":1,"generation":uuid::Uuid::new_v4().to_string()}),
        )?;
        let profile = Profile {
            app_version: name.into(),
            baseline_digest: baseline_digest(&staged.join("baseline"))?,
            migrated_from,
            warnings,
        };
        sync_tree(&staged)?;
        write_json(&staged.join(MANIFEST), &profile)?;
        sync_directory(&staged)?;
        sync_directory(versions)?;
    }
    // A crash may leave children on either side. Validate the complete logical
    // transaction before publishing any further entries, including its journal.
    let journal = read_manifest(&staged, name)?;
    let child_root = |child: &str| -> Result<PathBuf, AppError> {
        let from = staged.join(child);
        let to = config.join(child);
        let selected = match (from.exists(), to.exists()) {
            (true, false) => from,
            (false, true) => to,
            _ => {
                return Err(AppError::code(
                    "settings.initializationConflict",
                    serde_json::json!({}),
                ))
            }
        };
        regular(&selected)?;
        Ok(selected)
    };
    if baseline_digest(&child_root("baseline")?)? != journal.baseline_digest {
        return Err(AppError::code(
            "settings.baselineInvalid",
            serde_json::json!({}),
        ));
    }
    let source = child_root("settings")?;
    // Only this invocation's validated source may skip a second compilation.
    // A recovered journal must never inherit an in-memory validation guarantee.
    if resuming_ready {
        validate_source(&source)?;
    }
    let state = child_root("settings-state")?;
    let generation_path = state.join("generation.json");
    regular(&generation_path)?;
    let generation: serde_json::Value = serde_json::from_slice(&fs::read(generation_path)?)?;
    if generation["schemaVersion"] != 1
        || generation["generation"]
            .as_str()
            .is_none_or(|value| uuid::Uuid::parse_str(value).is_err())
    {
        return Err(AppError::code(
            "settings.generationInvalid",
            serde_json::json!({}),
        ));
    }
    fs::create_dir_all(config)?;
    regular(config)?;
    for child in ["baseline", "settings", "settings-state"] {
        let from = staged.join(child);
        let to = config.join(child);
        if from.exists() {
            if to.exists() {
                return Err(AppError::code(
                    "settings.initializationConflict",
                    serde_json::json!({}),
                ));
            }
            fs::rename(&from, &to)?;
            sync_directory(config)?;
            sync_directory(&staged)?;
        } else if !to.is_dir() {
            return Err(AppError::code(
                "settings.initializationIncomplete",
                serde_json::json!({}),
            ));
        }
    }
    fs::rename(staged.join(MANIFEST), config.join(MANIFEST))?;
    sync_directory(config)?;
    sync_directory(versions)?;
    let _ = fs::remove_dir(&staged);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn path(root: &Path, version: &str) -> PathBuf {
        root.join("settings-versions").join(version)
    }
    #[test]
    fn exact_versions_seed_independently_and_reuse_completed_profile() {
        let dir = tempfile::tempdir().unwrap();
        let first = path(dir.path(), "0.1.0");
        SOURCE_VALIDATIONS.with(|count| count.set(0));
        prepare(&first).unwrap();
        assert_eq!(SOURCE_VALIDATIONS.with(|count| count.get()), 1);
        let original = fs::read(first.join("settings-state/generation.json")).unwrap();
        prepare(&first).unwrap();
        assert_eq!(
            original,
            fs::read(first.join("settings-state/generation.json")).unwrap()
        );
        let second = path(dir.path(), "0.1.1");
        prepare(&second).unwrap();
        assert_eq!(
            SOURCE_VALIDATIONS.with(|count| count.get()),
            1,
            "completed and migrated profiles add no redundant native compilation"
        );
        assert_eq!(
            read_profile(&second).unwrap().migrated_from.as_deref(),
            Some("0.1.0")
        );
        assert_ne!(
            original,
            fs::read(second.join("settings-state/generation.json")).unwrap()
        );
        assert_eq!(
            original,
            fs::read(first.join("settings-state/generation.json")).unwrap()
        );
    }
    #[test]
    fn automatically_carries_user_edit_and_preserves_old_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let old = path(dir.path(), "0.1.0");
        prepare(&old).unwrap();
        let table = old.join("settings/Tables/UserSettings.table.toml");
        let text = fs::read_to_string(&table)
            .unwrap()
            .replace("\ntheme = \"system\"", "\ntheme = \"dark\"");
        fs::write(&table, &text).unwrap();
        let new = path(dir.path(), "0.3.0");
        prepare(&new).unwrap();
        assert_eq!(fs::read_to_string(table).unwrap(), text);
        let result = crate::app_settings_store::load(&new);
        assert_eq!(result.bundle["values"]["theme"], "dark");
        assert_eq!(result.source, "project");
    }
    #[test]
    fn damaged_baseline_recovers_to_persistent_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let old = path(dir.path(), "0.1.0");
        prepare(&old).unwrap();
        fs::write(old.join("baseline").join(PROJECT), "damaged").unwrap();
        let new = path(dir.path(), "0.2.0");
        let fallback = crate::app_settings_store::load(&new);
        assert_eq!(fallback.source, "project");
        assert!(!fallback.migration_failed);
        assert!(new.join(MANIFEST).exists());
        let restarted = crate::app_settings_store::refresh(&new, None).unwrap();
        assert_eq!(restarted.generation, fallback.generation);
        assert_eq!(restarted.source, "project");
        assert_eq!(
            fs::read_to_string(old.join("baseline").join(PROJECT)).unwrap(),
            "damaged"
        );
    }
    #[test]
    fn incomplete_publish_recovers_from_ready_journal() {
        let dir = tempfile::tempdir().unwrap();
        let current = path(dir.path(), "0.1.0");
        prepare(&current).unwrap();
        let staged = current.parent().unwrap().join(".0.1.0.initializing");
        fs::rename(&current, &staged).unwrap();
        fs::create_dir(&current).unwrap();
        fs::rename(staged.join("baseline"), current.join("baseline")).unwrap();
        SOURCE_VALIDATIONS.with(|count| count.set(0));
        let table = staged.join("settings/Tables/UserSettings.table.toml");
        let original = fs::read(&table).unwrap();
        fs::write(&table, "corrupt recovered source").unwrap();
        assert!(prepare(&current).is_err());
        assert!(!current.join(MANIFEST).exists());
        assert_eq!(SOURCE_VALIDATIONS.with(|count| count.get()), 1);
        fs::write(&table, original).unwrap();
        prepare(&current).unwrap();
        assert_eq!(SOURCE_VALIDATIONS.with(|count| count.get()), 2);
        assert!(current.join(MANIFEST).is_file());
        assert!(!staged.exists());
        assert_eq!(crate::app_settings_store::load(&current).source, "project");
    }
    #[test]
    fn same_version_concurrent_first_start_has_one_generation() {
        let dir = tempfile::tempdir().unwrap();
        let current = path(dir.path(), "0.1.0");
        let a = current.clone();
        let b = current.clone();
        let a = std::thread::spawn(move || {
            prepare(&a).unwrap();
            fs::read(a.join("settings-state/generation.json")).unwrap()
        });
        let b = std::thread::spawn(move || {
            prepare(&b).unwrap();
            fs::read(b.join("settings-state/generation.json")).unwrap()
        });
        assert_eq!(a.join().unwrap(), b.join().unwrap());
    }
    #[test]
    fn older_start_never_imports_newer_or_prerelease_settings() {
        let dir = tempfile::tempdir().unwrap();
        prepare(&path(dir.path(), "0.3.0")).unwrap();
        prepare(&path(dir.path(), "0.2.0-beta.1")).unwrap();
        let old = path(dir.path(), "0.2.0");
        prepare(&old).unwrap();
        assert!(read_profile(&old).unwrap().migrated_from.is_none());
    }
    #[test]
    fn malformed_or_wrong_version_journal_is_never_published() {
        for corrupt in [
            "not json",
            r#"{"appVersion":"9.9.9","baselineDigest":"bad","migratedFrom":null,"warnings":[]}"#,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let current = path(dir.path(), "0.1.0");
            let staged = current.parent().unwrap().join(".0.1.0.initializing");
            fs::create_dir_all(&staged).unwrap();
            fs::write(staged.join(MANIFEST), corrupt).unwrap();
            assert!(prepare(&current).is_err());
            assert!(!current.join(MANIFEST).exists());
            assert_eq!(fs::read_to_string(staged.join(MANIFEST)).unwrap(), corrupt);
        }
    }
    #[test]
    fn missing_predecessor_source_is_never_reseeded_by_new_binary() {
        let dir = tempfile::tempdir().unwrap();
        let old = path(dir.path(), "0.1.0");
        prepare(&old).unwrap();
        fs::remove_dir_all(old.join("settings")).unwrap();
        fs::remove_dir_all(old.join("settings-state")).unwrap();
        let manifest = fs::read(old.join(MANIFEST)).unwrap();
        let new = path(dir.path(), "0.2.0");
        assert!(prepare(&new).is_err());
        assert!(!old.join("settings").exists());
        assert!(!old.join("settings-state").exists());
        assert_eq!(fs::read(old.join(MANIFEST)).unwrap(), manifest);
        assert!(!new.join(MANIFEST).exists());
    }
    #[test]
    fn corrupt_user_source_recovers_and_remains_editable() {
        let dir = tempfile::tempdir().unwrap();
        let old = path(dir.path(), "0.1.0");
        prepare(&old).unwrap();
        let old_table = old.join("settings/Tables/UserSettings.table.toml");
        fs::write(&old_table, "invalid user source").unwrap();
        let new = path(dir.path(), "0.2.0");
        let fallback = crate::app_settings_store::load(&new);
        assert!(!fallback.migration_failed);
        assert_eq!(fallback.source, "project");
        let table = new.join("settings/Tables/UserSettings.table.toml");
        let text = fs::read_to_string(&table)
            .unwrap()
            .replace("\ntheme = \"system\"", "\ntheme = \"dark\"");
        fs::write(&table, text).unwrap();
        let restarted = crate::app_settings_store::refresh(&new, None).unwrap();
        assert_eq!(restarted.bundle["values"]["theme"], "dark");
        assert_eq!(restarted.generation, fallback.generation);
        let reset = crate::app_settings_store::reset(&new, &fallback.generation).unwrap();
        assert_eq!(reset.source, "project");
        assert!(!reset.migration_failed);
        assert_eq!(
            fs::read_to_string(old_table).unwrap(),
            "invalid user source"
        );
        assert!(read_profile(&new).unwrap().migrated_from.is_none());
    }
    #[test]
    fn recovery_never_resets_io_busy_or_unknown_failures() {
        let dir = tempfile::tempdir().unwrap();
        let current = path(dir.path(), "0.2.0");
        let staged = current.parent().unwrap().join(".0.2.0.initializing");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("sentinel"), "preserve").unwrap();
        for code in [
            "error.io",
            "error.command",
            "settings.editorBusy",
            "settings.sourceSymlink",
        ] {
            assert!(
                !recover_uninitialized(&current, &AppError::code(code, serde_json::json!({})))
                    .unwrap()
            );
            assert_eq!(
                fs::read_to_string(staged.join("sentinel")).unwrap(),
                "preserve"
            );
            assert!(!current.exists());
        }
    }
}
