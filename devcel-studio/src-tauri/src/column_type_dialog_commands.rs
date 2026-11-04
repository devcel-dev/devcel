//! In-app type chooser sessions collect intent only; column writes remain in the editor.
use crate::{state::ProjectState, AppError};
use devcel_core::column_editor::{self, EditorTarget};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const SESSION_TTL: Duration = Duration::from_secs(1800);

#[derive(Clone, Serialize)]
pub struct ColumnTypeDialogData {
    value: String,
    allow_select: bool,
}

struct ColumnTypeSession {
    target: EditorTarget,
    expected_revision: Option<String>,
    expected_project_session: String,
    data: ColumnTypeDialogData,
    result: Option<String>,
    resolved: bool,
    creator: String,
    created: Instant,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, ColumnTypeSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn remove_owner_sessions(sessions: &mut HashMap<String, ColumnTypeSession>, owner: &str) {
    sessions.retain(|_, session| session.creator != owner);
}

/// Sessions belong to their invoking window; there are no independent chooser windows.
pub fn cleanup_for_owner<R: tauri::Runtime>(owner: &str, _app: &tauri::AppHandle<R>) {
    let mut sessions = SESSIONS.lock().unwrap_or_else(|error| error.into_inner());
    remove_owner_sessions(&mut sessions, owner);
}

fn dialog_error(code: &str) -> AppError {
    AppError::code(code, serde_json::json!({}))
}

fn check_owner(session: &ColumnTypeSession, owner: &str) -> Result<(), AppError> {
    if session.creator != owner {
        return Err(dialog_error("column.typePicker.wrongWindow"));
    }
    Ok(())
}

fn check_context(
    state: &ProjectState,
    target: &EditorTarget,
    expected_project_session: &str,
    expected_revision: &Option<String>,
) -> Result<column_editor::EditorContext, AppError> {
    state.with_project(|project| {
        let project = project
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        crate::ensure_project_session(project, expected_project_session)?;
        let context = column_editor::load(project, target).map_err(AppError::from)?;
        if context.revision != *expected_revision {
            return Err(dialog_error("column.staleNotice"));
        }
        if context.interface_owned {
            return Err(dialog_error("column.typePicker.locked"));
        }
        Ok(context)
    })
}

fn selectable(value: &str, existing: &devcel_core::ValueType) -> bool {
    matches!(
        value,
        "String"
            | "I8"
            | "U8"
            | "I16"
            | "U16"
            | "I32"
            | "U32"
            | "I64"
            | "U64"
            | "F32"
            | "F64"
            | "Boolean"
            | "Reference"
            | "TableRef"
            | "Curve"
            | "Color32"
            | "ColorFloat"
    ) || (value == "Select" && *existing == devcel_core::ValueType::Select)
}

#[tauri::command]
pub fn create_column_type_session(
    target: EditorTarget,
    expected_revision: Option<String>,
    expected_project_session: String,
    value: String,
    window: tauri::WebviewWindow,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let context = check_context(
        &*state.lock().map_err(AppError::from)?,
        &target,
        &expected_project_session,
        &expected_revision,
    )?;
    // An unsupported existing type can be displayed, but never introduced as a new choice.
    if !selectable(&value, &context.column.data_type)
        && value != format!("{:?}", context.column.data_type)
    {
        return Err(dialog_error("column.typePicker.invalidType"));
    }
    let mut sessions = SESSIONS.lock().map_err(AppError::from)?;
    sessions.retain(|_, session| session.created.elapsed() < SESSION_TTL);
    if sessions.len() >= 32 {
        return Err(dialog_error("column.typePicker.tooManyDialogs"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sessions.insert(
        id.clone(),
        ColumnTypeSession {
            target,
            expected_revision,
            expected_project_session,
            data: ColumnTypeDialogData {
                value,
                allow_select: context.column.data_type == devcel_core::ValueType::Select,
            },
            result: None,
            resolved: false,
            creator: window.label().to_owned(),
            created: Instant::now(),
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn get_column_type_session(
    session_id: &str,
    window: tauri::WebviewWindow,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<ColumnTypeDialogData, AppError> {
    let sessions = SESSIONS.lock().map_err(AppError::from)?;
    let session = sessions
        .get(session_id)
        .filter(|session| session.created.elapsed() < SESSION_TTL)
        .ok_or_else(|| dialog_error("column.typePicker.expired"))?;
    check_owner(session, window.label())?;
    check_context(
        &*state.lock().map_err(AppError::from)?,
        &session.target,
        &session.expected_project_session,
        &session.expected_revision,
    )?;
    Ok(session.data.clone())
}

#[tauri::command]
pub fn resolve_column_type_session(
    session_id: &str,
    value: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<(), AppError> {
    let mut sessions = SESSIONS.lock().map_err(AppError::from)?;
    let session = sessions
        .get_mut(session_id)
        .filter(|session| session.created.elapsed() < SESSION_TTL)
        .ok_or_else(|| dialog_error("column.typePicker.expired"))?;
    check_owner(session, window.label())?;
    if session.resolved {
        return Err(dialog_error("column.typePicker.alreadySubmitted"));
    }
    if let Some(value) = &value {
        let context = check_context(
            &*state.lock().map_err(AppError::from)?,
            &session.target,
            &session.expected_project_session,
            &session.expected_revision,
        )?;
        if !selectable(value, &context.column.data_type) {
            return Err(dialog_error("column.typePicker.invalidType"));
        }
    }
    // Cancellation remains possible after a project switch, without validating or mutating it.
    session.result = value;
    session.resolved = true;
    Ok(())
}

#[tauri::command]
pub fn take_column_type_result(
    session_id: &str,
    window: tauri::WebviewWindow,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<Option<String>, AppError> {
    let mut sessions = SESSIONS.lock().map_err(AppError::from)?;
    if sessions
        .get(session_id)
        .is_some_and(|session| session.creator != window.label())
    {
        return Err(dialog_error("column.typePicker.wrongWindow"));
    }
    let Some(session) = sessions
        .remove(session_id)
        .filter(|session| session.created.elapsed() < SESSION_TTL)
    else {
        return Ok(None);
    };
    if session.result.is_some() {
        // Selection can become stale even between resolution and result retrieval.
        check_context(
            &*state.lock().map_err(AppError::from)?,
            &session.target,
            &session.expected_project_session,
            &session.expected_revision,
        )?;
    }
    Ok(session.result)
}
#[cfg(test)]
mod owner_cleanup_tests {
    use super::*;
    use devcel_core::column_editor::EditorMode;

    fn session(owner: &str, result: Option<&str>) -> ColumnTypeSession {
        ColumnTypeSession {
            target: EditorTarget {
                mode: EditorMode::Table,
                target_uuid: "00000000-0000-0000-0000-000000000001".into(),
                column_uuid: None,
                insert_index: None,
            },
            expected_revision: None,
            expected_project_session: "project".into(),
            data: ColumnTypeDialogData {
                value: "I32".into(),
                allow_select: false,
            },
            result: result.map(str::to_owned),
            resolved: result.is_some(),
            creator: owner.into(),
            created: Instant::now(),
        }
    }

    #[test]
    fn only_the_creator_can_read_or_resolve_the_intent() {
        let session = session("main", None);
        assert!(check_owner(&session, "main").is_ok());
        assert!(check_owner(&session, "other-window").is_err());
        assert!(check_owner(&session, "column-type-chosen").is_err());
    }

    #[test]
    fn removes_only_destroyed_owner_and_is_idempotent() {
        let mut sessions = HashMap::from([
            ("first".into(), session("main", None)),
            ("resolved".into(), session("main", Some("U16"))),
            ("other".into(), session("table_view", Some("I64"))),
        ]);
        remove_owner_sessions(&mut sessions, "main");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions["other"].result.as_deref(), Some("I64"));
        remove_owner_sessions(&mut sessions, "main");
        assert_eq!(sessions.len(), 1);
    }

    #[test]
    fn other_window_destroy_keeps_result_for_live_owner() {
        let mut sessions = HashMap::from([("chosen".into(), session("main", Some("U16")))]);
        remove_owner_sessions(&mut sessions, "other-window");
        assert_eq!(sessions["chosen"].result.as_deref(), Some("U16"));
    }
}
