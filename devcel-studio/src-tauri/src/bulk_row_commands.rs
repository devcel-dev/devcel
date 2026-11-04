//! A count dialog collects intent only; the main grid commits one normal mutation.
use crate::{state::ProjectState, AppError};
use devcel_core::table_mutation::{prepare_record_batch, TableMutation, MAX_BULK_RECORDS};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const SESSION_TTL: Duration = Duration::from_secs(1800);

#[derive(Clone, Serialize)]
pub struct BulkRowDialogData {
    table_name: String,
    max_count: usize,
}

struct BulkRowSession {
    table_uuid: String,
    expected_revision: String,
    expected_project_session: String,
    data: BulkRowDialogData,
    result: Option<TableMutation>,
    creator: String,
    created: Instant,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, BulkRowSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn dialog_error(code: &str) -> AppError {
    AppError::code(code, serde_json::json!({}))
}

fn check_dialog(session_id: &str, window: &tauri::WebviewWindow) -> Result<(), AppError> {
    if window.label() != format!("bulk-rows-{session_id}") {
        return Err(dialog_error("grid.bulk.wrongWindow"));
    }
    Ok(())
}

#[tauri::command]
pub fn create_bulk_row_session(
    table_uuid: String,
    expected_revision: String,
    expected_project_session: String,
    window: tauri::WebviewWindow,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let data = state
        .lock()
        .map_err(AppError::from)?
        .with_project(|project| {
            let project = project
                .as_ref()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            crate::ensure_project_session(project, &expected_project_session)?;
            let table = project.read_table_data_by_uuid(&table_uuid)?;
            if devcel_core::cell_rules::revision(&table) != expected_revision {
                return Err(dialog_error("grid.bulk.staleTable"));
            }
            Ok::<_, AppError>(BulkRowDialogData {
                table_name: table.display_name.clone(),
                max_count: MAX_BULK_RECORDS,
            })
        })?;
    let mut sessions = SESSIONS.lock().map_err(AppError::from)?;
    sessions.retain(|_, session| session.created.elapsed() < SESSION_TTL);
    if sessions.len() >= 32 {
        return Err(dialog_error("grid.bulk.tooManyDialogs"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sessions.insert(
        id.clone(),
        BulkRowSession {
            table_uuid,
            expected_revision,
            expected_project_session,
            data,
            result: None,
            creator: window.label().to_owned(),
            created: Instant::now(),
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn get_bulk_row_session(
    session_id: &str,
    window: tauri::WebviewWindow,
) -> Result<BulkRowDialogData, AppError> {
    check_dialog(session_id, &window)?;
    SESSIONS
        .lock()
        .map_err(AppError::from)?
        .get(session_id)
        .filter(|session| session.created.elapsed() < SESSION_TTL)
        .map(|session| session.data.clone())
        .ok_or_else(|| dialog_error("grid.bulk.expired"))
}

#[tauri::command]
pub fn resolve_bulk_row_session(
    session_id: &str,
    count_input: &str,
    window: tauri::WebviewWindow,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<(), AppError> {
    check_dialog(session_id, &window)?;
    let mut sessions = SESSIONS.lock().map_err(AppError::from)?;
    let session = sessions
        .get_mut(session_id)
        .filter(|session| session.created.elapsed() < SESSION_TTL)
        .ok_or_else(|| dialog_error("grid.bulk.expired"))?;
    if session.result.is_some() {
        return Err(dialog_error("grid.bulk.alreadySubmitted"));
    }
    // Holding the session gate makes simultaneous submissions resolve at most once.
    let mutation = state
        .lock()
        .map_err(AppError::from)?
        .with_project(|project| {
            let project = project
                .as_ref()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            crate::ensure_project_session(project, &session.expected_project_session)?;
            prepare_record_batch(
                project,
                &session.table_uuid,
                &session.expected_revision,
                count_input,
            )
            .map_err(AppError::from)
        })?;
    session.result = Some(mutation);
    Ok(())
}

#[tauri::command]
pub fn take_bulk_row_result(
    session_id: &str,
    window: tauri::WebviewWindow,
) -> Result<Option<TableMutation>, AppError> {
    let mut sessions = SESSIONS.lock().map_err(AppError::from)?;
    if sessions
        .get(session_id)
        .is_some_and(|session| session.creator != window.label())
    {
        return Err(dialog_error("grid.bulk.wrongWindow"));
    }
    // Close, cancel, failed creation and table/project switches all consume the session.
    Ok(sessions
        .remove(session_id)
        .filter(|session| session.created.elapsed() < SESSION_TTL)
        .and_then(|session| session.result))
}
