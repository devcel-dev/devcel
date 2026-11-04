#![allow(dead_code)]
use crate::AppError;

use devcel_core::change_detection::{ChangeEvent, SequenceId};
use std::sync::Mutex;
use tauri::{Emitter, State};

/// Initialize change detection
#[tauri::command]
pub async fn initialize_change_detection(
    state: State<'_, crate::state::ProjectState>,
) -> Result<String, AppError> {
    let project_state = &*state;

    // Run asynchronous work on a separate thread
    let project_clone = project_state.project.clone();
    tokio::spawn(async move {
        let mut project_lock = project_clone.lock().await;
        if let Some(project) = project_lock.as_mut() {
            let _ = project.use_default_change_detector().await;
        }
    });

    Ok("ok".to_string())
}

/// Get the current sequence ID
#[tauri::command]
pub fn get_current_sequence(
    state: State<'_, Mutex<crate::state::ProjectState>>,
) -> Result<String, AppError> {
    let project_state = state
        .lock()
        .map_err(|e| format!("Failed to lock state: {e}"))?;

    project_state.with_project_mut(|project_opt| {
        if let Some(project) = project_opt {
            if let Some(seq) = project.get_current_sequence() {
                serde_json::to_string(&seq).map_err(AppError::from)
            } else {
                Err("Change detector not initialized".into())
            }
        } else {
            Err("No project loaded".into())
        }
    })
}

/// Get changes after the specified sequence
#[tauri::command]
pub async fn get_changes_since(
    state: State<'_, crate::state::ProjectState>,
    sequence: String,
) -> Result<Vec<ChangeEvent>, AppError> {
    let seq: SequenceId =
        serde_json::from_str(&sequence).map_err(|e| format!("Failed to parse sequence: {e}"))?;

    let project = {
        let project_state = &*state;
        project_state.project.clone()
    };

    let project = project.lock().await;

    if let Some(project) = project.as_ref() {
        project
            .get_changes_since(&seq)
            .await
            .map_err(AppError::from)
    } else {
        Err("No project loaded".into())
    }
}

/// Manually check for changes (for polling)
#[tauri::command]
pub async fn check_for_external_changes(
    state: State<'_, crate::state::ProjectState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, AppError> {
    let project = {
        let project_state = &*state;
        project_state.project.clone()
    };

    let project = project.lock().await;

    if let Some(project) = project.as_ref() {
        // Read the version file to check for external changes
        let project_path = project.get_project_path();
        let project_dir = std::path::Path::new(&project_path)
            .parent()
            .ok_or("Invalid project path")?;

        let version_file = project_dir.join(".devcel_version");

        if version_file.exists() {
            let content = tokio::fs::read_to_string(&version_file)
                .await
                .map_err(|e| format!("Failed to read version file: {e}"))?;

            if let Ok(file_version) = content.trim().parse::<u64>() {
                if let Some(SequenceId::Simple(current_version)) = project.get_current_sequence() {
                    if file_version > current_version {
                        // External change detected
                        app_handle
                            .emit(
                                "project-changed",
                                &serde_json::json!({
                                    "version": file_version,
                                    "source": "external"
                                }),
                            )
                            .map_err(|e| format!("Failed to emit event: {e}"))?;

                        return Ok(true);
                    }
                }
            }
        }

        Ok(false)
    } else {
        Err("No project loaded".into())
    }
}
