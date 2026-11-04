//! Native access to the ordinary settings project and its compiled runtime bundle.
use crate::{app_settings_store, AppError};
use app_settings_store::AppSettingsSnapshot;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;
use tauri::Emitter;

static REFRESH_QUEUE: OnceLock<mpsc::Sender<Option<String>>> = OnceLock::new();
fn directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    crate::settings_profile::directory(app)
}
#[tauri::command]
pub async fn get_app_settings(app: tauri::AppHandle) -> Result<AppSettingsSnapshot, AppError> {
    let config = directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || app_settings_store::load(&config))
        .await
        .map_err(AppError::technical)
}
fn notify(app: &tauri::AppHandle, snapshot: &AppSettingsSnapshot) {
    // The bundle is published as one unit. Readers treat notifications as
    // invalidations and also refresh on focus for cross-process recovery.
    if let Err(error) = app.emit("devcel-app-settings-changed", snapshot) {
        eprintln!("Settings notification failed: {error}");
    }
}
/// Invoked after the standard save queue reports an actual committed save,
/// including successful mutation, undo, and redo. Compilation is coalesced away
/// from the save callback and must still match the editor's generation.
pub fn source_saved(_app: &tauri::AppHandle, generation: &str) {
    if let Some(queue) = REFRESH_QUEUE.get() {
        let _ = queue.send(Some(generation.to_owned()));
    }
}
/// A missing watcher is not a startup failure: focus refresh remains available.
pub fn initialize(app: &tauri::AppHandle) {
    if REFRESH_QUEUE.get().is_some() {
        return;
    }
    let config = match directory(app) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Settings directory unavailable: {error:?}");
            return;
        }
    };
    let (sender, receiver) = mpsc::channel::<Option<String>>();
    if REFRESH_QUEUE.set(sender.clone()).is_err() {
        return;
    }
    let app = app.clone();
    let source = config.join("settings");
    let snapshot_file = config.join("settings-state/last-valid.json");
    let generation_file = config.join("settings-state/generation.json");
    let result = std::thread::Builder::new()
        .name("devcel-settings-compile".into())
        .spawn(move || {
            // Disk reads, first-run seeding, and source compilation never run on
            // Tauri setup/UI thread. The frontend can render its embedded bundle.
            if let Err(error) = std::fs::create_dir_all(&config) {
                eprintln!("Settings directory unavailable: {error}");
            }
            let callback_sender = sender.clone();
            let watcher = RecommendedWatcher::new(
                move |event: Result<notify::Event, notify::Error>| match event {
                    Ok(event)
                        if !event.kind.is_access()
                            && (event.need_rescan()
                                || event.paths.iter().any(|path| {
                                    path.starts_with(&source)
                                        || path == &snapshot_file
                                        || path == &generation_file
                                })) =>
                    {
                        let _ = callback_sender.send(None);
                    }
                    Err(error) => {
                        eprintln!("Settings source watcher error: {error}");
                        let _ = callback_sender.send(None);
                    }
                    _ => {}
                },
                Config::default(),
            );
            let _watcher = match watcher {
                Ok(mut watcher) => match watcher.watch(&config, RecursiveMode::Recursive) {
                    Ok(()) => Some(watcher),
                    Err(error) => {
                        eprintln!("Settings watcher unavailable; focus refresh is active: {error}");
                        None
                    }
                },
                Err(error) => {
                    eprintln!("Settings watcher unavailable; focus refresh is active: {error}");
                    None
                }
            };
            let initial = app_settings_store::load(&config);
            notify(&app, &initial);
            while let Ok(mut expected) = receiver.recv() {
                // A filesystem invalidation covers the current generation; queued
                // save callbacks remain generation-bound unless such an event exists.
                while let Ok(next) = receiver.recv_timeout(Duration::from_millis(120)) {
                    if expected.is_some() {
                        expected = next;
                    }
                }
                if let Some(generation) = expected.as_deref() {
                    if app_settings_store::current_generation(&config)
                        .ok()
                        .as_deref()
                        != Some(generation)
                    {
                        continue;
                    }
                }
                match app_settings_store::refresh(&config, expected.as_deref()) {
                    Ok(snapshot) => notify(&app, &snapshot),
                    Err(_) => notify(&app, &app_settings_store::load(&config)),
                }
            }
        });
    if let Err(error) = result {
        eprintln!("Settings worker unavailable; focus refresh is active: {error}");
    }
}
#[tauri::command]
pub async fn reset_settings_project(
    app: tauri::AppHandle,
    expected_generation: String,
) -> Result<AppSettingsSnapshot, AppError> {
    let config = directory(&app)?;
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        app_settings_store::reset(&config, &expected_generation)
    })
    .await
    .map_err(AppError::technical)??;
    notify(&app, &snapshot);
    Ok(snapshot)
}
