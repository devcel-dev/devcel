//! Project-session-bound invalidation for formula inputs changed outside Studio.
//! Notifications do not authorize overwriting dirty or queued in-memory edits.
use crate::{state::ProjectState, AppError};
use notify::{
    event::{CreateKind, ModifyKind, RemoveKind},
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, LazyLock, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

static SOURCE_ERROR: LazyLock<Mutex<Option<(String, AppError)>>> =
    LazyLock::new(|| Mutex::new(None));
static SOURCE_OWNER: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

// Invalidate at the OS callback, before the debounce/project-lock wait. A
// notification that has not reached JavaScript cannot authorize snapshot reuse.
static SOURCE_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn source_epoch() -> u64 {
    SOURCE_EPOCH.load(Ordering::SeqCst)
}

fn invalidate_sources() {
    SOURCE_EPOCH.fetch_add(1, Ordering::SeqCst);
}

fn record_callback_error(session: &str, error: AppError) {
    // Retired watcher callbacks must not overwrite a new session's error.
    if let Ok(owner) = SOURCE_OWNER.lock() {
        if owner.as_deref() == Some(session) {
            if let Ok(mut stored) = SOURCE_ERROR.lock() {
                *stored = Some((session.to_owned(), error));
            }
        }
    }
}

pub(crate) fn check_source_error(session: &str) -> Result<(), AppError> {
    let error = SOURCE_ERROR.lock().map_err(AppError::from)?;
    match error.as_ref().filter(|(owner, _)| owner == session) {
        Some((_, error)) => Err(error.clone()),
        None => Ok(()),
    }
}

pub(crate) struct FormulaSourceWatcher {
    stopped: Arc<AtomicBool>,
}
impl FormulaSourceWatcher {
    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
}
impl Drop for FormulaSourceWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn source_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|v| v.to_str())
        .is_some_and(|name| name.ends_with(".table.toml") || name.ends_with(".interface.toml"))
}

fn source_event(event: &Event, root: &Path, directories: &HashSet<PathBuf>) -> bool {
    if event.need_rescan() {
        return true;
    }
    if event.kind.is_access() {
        return false;
    }
    let tables = root.join("Tables");
    event.paths.iter().any(|path| {
        if !path.starts_with(&tables) {
            return false;
        }
        if source_file(path) {
            return true;
        }
        match event.kind {
            EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder) => true,
            EventKind::Modify(ModifyKind::Name(_)) | EventKind::Any => {
                directories.contains(path)
                    || std::fs::symlink_metadata(path).is_ok_and(|metadata| {
                        metadata.is_dir() && !metadata.file_type().is_symlink()
                    })
            }
            _ => false,
        }
    })
}

fn source_directories(root: &Path) -> HashSet<PathBuf> {
    let mut found = HashSet::new();
    let tables = root.join("Tables");
    let Ok(project_scope) = std::fs::canonicalize(root) else {
        return found;
    };
    if !std::fs::symlink_metadata(&tables)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        return found;
    }
    let Ok(scope) = std::fs::canonicalize(&tables) else {
        return found;
    };
    if !scope.starts_with(project_scope) {
        return found;
    }
    let mut visited = HashSet::new();
    let mut pending = vec![tables];
    while let Some(path) = pending.pop() {
        if !std::fs::symlink_metadata(&path)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        {
            continue;
        }
        let Ok(canonical) = std::fs::canonicalize(&path) else {
            continue;
        };
        if !canonical.starts_with(&scope) || !visited.insert(canonical) {
            continue;
        }
        found.insert(path.clone());
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    pending.push(entry.path());
                }
            }
        }
    }
    found
}

fn source_path_error(path: &Path) -> AppError {
    AppError::code(
        "error.formulaSourcePath",
        serde_json::json!({"path":path.to_string_lossy()}),
    )
}
fn source_read_error(path: &Path, error: AppError) -> AppError {
    AppError::code(
        "error.formulaSourceRead",
        serde_json::json!({"path":path.to_string_lossy(),"error":error}),
    )
}
fn watcher_error(error: impl std::fmt::Display) -> AppError {
    // notify's library/OS detail is literal, not an application message to translate.
    AppError::code(
        "error.formulaWatcher",
        serde_json::json!({"error":AppError::text(error)}),
    )
}

/// Check components from the trusted Tables root outward before reading a loaded
/// table too: a previously normal directory may have been replaced by a link.
fn check_source_path(root: &Path, path: &Path) -> Result<(), AppError> {
    let tables = root.join("Tables");
    let relative = path
        .strip_prefix(&tables)
        .map_err(|_| source_path_error(path))?;
    let mut current = tables.clone();
    let scope = match std::fs::canonicalize(&tables) {
        Ok(scope) => Some(scope),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(AppError::from(error)),
    };
    for component in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(component) = component {
            match component {
                std::path::Component::Normal(name) => current.push(name),
                std::path::Component::CurDir => continue,
                _ => return Err(source_path_error(path)),
            }
        }
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(AppError::from(error)),
        };
        if metadata.file_type().is_symlink()
            || scope.as_ref().is_some_and(|scope| {
                std::fs::canonicalize(&current).is_ok_and(|canonical| !canonical.starts_with(scope))
            })
        {
            return Err(source_path_error(&current));
        }
    }
    Ok(())
}

/// Reload only genuinely changed clean tables, keeping Undo after our own saves.
/// Inspect all loaded tables: a later unrelated event must not clear an earlier
/// source conflict while the invalid source is still on disk.
fn reconcile_sources(
    project: &mut devcel_core::Project,
    state: &ProjectState,
) -> Result<(), AppError> {
    reconcile_for_snapshot(project, state, None, None).map(|_| ())
}

/// The caller's evidence was obtained by rereading inventory and source bytes.
/// Only previously reconciled byte-identical files bypass TOML parsing. Changed
/// or unknown files retain the dirty/save-queue/Undo protections below.
pub(crate) fn reconcile_for_snapshot(
    project: &mut devcel_core::Project,
    state: &ProjectState,
    baseline: Option<&devcel_core::formula_context::FormulaSnapshotValidity>,
    current: Option<&devcel_core::formula_context::FormulaSnapshotValidity>,
) -> Result<bool, AppError> {
    let mut live_changed = false;
    if !baseline
        .zip(current)
        .is_some_and(|(before, after)| before.interface_sources_unchanged(after))
    {
        project
            .reload_interfaces_preserving_pending()
            .map_err(AppError::from)?;
        live_changed = true;
    }
    let loaded: Vec<_> = project
        .tables_data
        .iter()
        .map(|(path, table)| (path.clone(), table.data.uuid.clone(), table.is_dirty))
        .collect();
    for (path, uuid, dirty) in loaded {
        check_source_path(
            project
                .path
                .parent()
                .ok_or_else(|| source_path_error(&project.path))?,
            &path,
        )?;
        if baseline
            .zip(current)
            .is_some_and(|(before, after)| before.source_unchanged(after, &path))
        {
            continue;
        }
        let pending = state
            .save_queue
            .as_ref()
            .is_some_and(|queue| queue.has_pending_saves_for_path_sync(&path));
        let source = match std::fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !dirty && !pending => {
                project
                    .clear_table_undo_redo_stacks(&uuid)
                    .map_err(AppError::from)?;
                project.tables_data.remove(&path);
                live_changed = true;
                continue;
            }
            Err(error) => return Err(source_read_error(&path, error.into())),
        };
        let disk: devcel_core::TableData = devcel_core::TableData::from_toml(&source)
            .map_err(|error| source_read_error(&path, error.into()))?;
        let revision = devcel_core::cell_rules::revision(
            &project
                .tables_data
                .get(&path)
                .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?
                .data,
        );
        if revision == devcel_core::cell_rules::revision(&disk) {
            continue;
        }
        if dirty || pending {
            return Err(AppError::code(
                "error.sourceConflict",
                serde_json::json!({"path":path.to_string_lossy()}),
            ));
        }
        // Existing reload validates identities/interfaces and retires shared Undo.
        project
            .reload_table_with_save_queue(&uuid, state.save_queue.as_deref())
            .map_err(AppError::from)?;
        live_changed = true;
    }
    Ok(live_changed)
}

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<(), std::io::Error> {
    let state = app.state::<ProjectState>().inner().clone();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("devcel-formula-sources".into())
        .spawn(move || {
            watch_sources(state, stop, |session, error| {
                let _ = handle.emit(
                    "formula-sources-changed",
                    serde_json::json!({ "project_session": session, "error": error }),
                );
            });
        })?;
    app.manage(FormulaSourceWatcher { stopped });
    Ok(())
}

fn watch_sources(
    state: ProjectState,
    stop: Arc<AtomicBool>,
    emit: impl Fn(&str, Option<AppError>),
) {
    let (send, receive) = mpsc::sync_channel::<(String, notify::Result<Event>)>(256);
    let overflow = Arc::new(AtomicBool::new(false));
    let mut owner: Option<(String, PathBuf)> = None;
    let mut watcher: Option<RecommendedWatcher> = None;
    let mut directories = HashSet::new();
    let mut pending: Option<(Instant, Instant)> = None;
    let mut watch_error: Option<AppError> = None;
    let mut retry_at = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        // A formula read cannot block this thread or hold the lifecycle lock.
        // Session changes are accepted only while the authoritative guard is available.
        if let Ok(mut guard) = state.project.try_lock() {
            let target = guard.as_ref().and_then(|project| {
                project
                    .path
                    .parent()
                    .map(|root| (project.get_instance_id().to_owned(), root.to_path_buf()))
            });
            if target != owner {
                invalidate_sources();
                watcher = None;
                pending = None;
                watch_error = None;
                overflow.store(false, Ordering::Relaxed);
                if let Ok(mut source_owner) = SOURCE_OWNER.lock() {
                    *source_owner = target.as_ref().map(|(session, _)| session.clone());
                    if let Ok(mut error) = SOURCE_ERROR.lock() {
                        *error = None;
                    }
                }
                owner = target;
                retry_at = Instant::now();
            }
            if let Some((session, root)) = owner.as_ref() {
                if watcher.is_none() && Instant::now() >= retry_at {
                    let send = send.clone();
                    let callback_session = session.clone();
                    let overflow = overflow.clone();
                    let created = RecommendedWatcher::new(
                        move |event: notify::Result<Event>| {
                            if event.as_ref().is_ok_and(|event: &Event| {
                                event.kind.is_access() && !event.need_rescan()
                            }) {
                                return;
                            }
                            invalidate_sources();
                            if let Err(error) = &event {
                                record_callback_error(&callback_session, watcher_error(error));
                            }
                            if send.try_send((callback_session.clone(), event)).is_err() {
                                invalidate_sources();
                                overflow.store(true, Ordering::Relaxed);
                            }
                        },
                        Config::default().with_follow_symlinks(false),
                    )
                    .and_then(|mut watcher| {
                        watcher.watch(root, RecursiveMode::Recursive)?;
                        Ok(watcher)
                    });
                    match created {
                        Ok(created) => {
                            watcher = Some(created);
                            directories = source_directories(root);
                            watch_error = None;
                            // Close the open/switch-to-watch gap by reconciling
                            // once after the OS subscription is active.
                            pending = Some((Instant::now(), Instant::now()));
                        }
                        Err(error) => {
                            invalidate_sources();
                            watch_error = Some(watcher_error(error));
                            if let Ok(mut stored) = SOURCE_ERROR.lock() {
                                *stored = watch_error.clone().map(|error| (session.clone(), error));
                            }
                        }
                    }
                    retry_at = Instant::now() + Duration::from_secs(1);
                    if watch_error.is_some() {
                        pending = Some((Instant::now(), Instant::now() - Duration::from_secs(1)));
                    }
                }
                while let Ok((event_session, event)) = receive.try_recv() {
                    if &event_session != session {
                        continue;
                    }
                    let relevant = match event {
                        Ok(event) => source_event(&event, root, &directories),
                        Err(error) => {
                            watcher = None;
                            retry_at = Instant::now() + Duration::from_secs(1);
                            watch_error = Some(watcher_error(error));
                            true
                        }
                    };
                    if relevant {
                        let now = Instant::now();
                        let first = pending.map_or(now, |(first, _)| first);
                        pending = Some((first, now));
                    }
                }
                if overflow.swap(false, Ordering::Relaxed) {
                    invalidate_sources();
                    pending = Some((Instant::now(), Instant::now()));
                }
                let due = pending.is_some_and(|(first, last)| {
                    last.elapsed() >= Duration::from_millis(250)
                        || first.elapsed() >= Duration::from_secs(1)
                });
                if due {
                    pending = None;
                    let error = watch_error.clone().or_else(|| {
                        guard
                            .as_mut()
                            .and_then(|project| reconcile_sources(project, &state).err())
                    });
                    if let Ok(mut stored) = SOURCE_ERROR.lock() {
                        *stored = error.clone().map(|error| (session.clone(), error));
                    }
                    emit(session, error.clone());
                    directories = source_directories(root);
                    // Recheck failed/transient/pending sources, so a successful
                    // save or repair restores evaluation without restarting Studio.
                    if error.is_some() {
                        pending =
                            Some((Instant::now(), Instant::now() + Duration::from_millis(750)));
                    }
                }
            } else {
                while receive.try_recv().is_ok() {}
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    drop(watcher);
}

#[cfg(test)]
mod native_snapshot_watcher_regression_tests {
    use super::*;

    #[test]
    fn source_failures_keep_semantic_codes_and_nested_technical_details() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("outside {literal}.table.toml");
        let rejected =
            serde_json::to_value(check_source_path(root.path(), &path).unwrap_err()).unwrap();
        assert_eq!(rejected["code"], "error.formulaSourcePath");
        assert_eq!(rejected["params"]["path"], path.to_string_lossy().as_ref());
        let nested = source_read_error(
            &path,
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "OS detail {literal}").into(),
        );
        let nested = serde_json::to_value(nested).unwrap();
        assert_eq!(nested["code"], "error.formulaSourceRead");
        assert_eq!(nested["params"]["error"]["code"], "error.io");
        assert_eq!(
            nested["params"]["error"]["params"]["details"],
            "OS detail {literal}"
        );
        let watched = serde_json::to_value(watcher_error("native detail {literal}")).unwrap();
        assert_eq!(watched["code"], "error.formulaWatcher");
        assert_eq!(
            watched["params"]["error"]["text"],
            "native detail {literal}"
        );
    }

    #[test]
    fn native_snapshot_watcher_epoch_invalidation_is_immediate() {
        let before = source_epoch();
        invalidate_sources();
        assert_ne!(source_epoch(), before);
        let access_rescan = Event::new(EventKind::Access(notify::event::AccessKind::Any))
            .set_flag(notify::event::Flag::Rescan);
        assert!(source_event(
            &access_rescan,
            Path::new("/unused"),
            &HashSet::new()
        ));
    }

    #[test]
    fn native_snapshot_watcher_callback_error_is_scoped_before_debounce() {
        let previous_owner = SOURCE_OWNER.lock().unwrap().clone();
        let previous_error = SOURCE_ERROR.lock().unwrap().clone();
        *SOURCE_OWNER.lock().unwrap() = Some("native-current-session".into());
        *SOURCE_ERROR.lock().unwrap() = None;
        record_callback_error("retired-session", AppError::text("retired watcher error"));
        assert!(check_source_error("native-current-session").is_ok());
        record_callback_error(
            "native-current-session",
            AppError::text("watcher source error"),
        );
        assert!(check_source_error("native-current-session").is_err());
        assert!(check_source_error("another-session").is_ok());
        record_callback_error(
            "retired-session",
            AppError::text("must not overwrite current error"),
        );
        match check_source_error("native-current-session") {
            Err(AppError::Text { text }) => assert_eq!(text, "watcher source error"),
            _ => panic!("Current-session source error was lost"),
        }
        *SOURCE_OWNER.lock().unwrap() = previous_owner;
        *SOURCE_ERROR.lock().unwrap() = previous_error;
    }
}
