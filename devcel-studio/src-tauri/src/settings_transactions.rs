//! One bounded settings-source writer, whether its ordinary editor is open or closed.
use crate::{app_settings_store, settings_mode, state::ProjectState, AppError};
use devcel_core::ColorSwatch;
use tauri::{Emitter, Manager};
#[path = "settings_transactions_store.rs"]
mod store;
pub(crate) use store::read;
pub use store::UserColorSwatches;
use store::{checked_revision, transaction, transaction_observed};

fn notify_palette(app: &tauri::AppHandle, saved: &UserColorSwatches) {
    if let Err(error) = app.emit(
        "user-color-swatches-changed",
        serde_json::json!({"revision": saved.revision}),
    ) {
        eprintln!("Settings swatches committed; notification failed: {error}");
    }
}

/// Called only by the internal command lane, including authenticated gateway requests.
pub(crate) fn replace_in_editor(
    app: &tauri::AppHandle,
    expected_revision: String,
    values: Vec<ColorSwatch>,
) -> Result<UserColorSwatches, AppError> {
    let generation = settings_mode::editor_generation(app)?;
    let config = crate::settings_profile::directory(app)?;
    let state = app.state::<ProjectState>();
    let (saved, committed, session, tables) = state.with_project_mut_save(|project, queue| {
        let project = project
            .as_mut()
            .ok_or_else(|| AppError::code("settings.editorNotReady", serde_json::json!({})))?;
        if project.path.canonicalize()?
            != app_settings_store::project_path(&config).canonicalize()?
        {
            return Err(AppError::code(
                "settings.sourceIdentityChanged",
                serde_json::json!({}),
            ));
        }
        let (saved, committed) = transaction_observed(
            &config,
            &generation,
            project,
            queue,
            &expected_revision,
            values,
        );
        let tables: Vec<String> = project
            .tables_data
            .values()
            .map(|table| table.data.uuid.clone())
            .collect();
        Ok((
            saved,
            committed,
            project.get_instance_id().to_owned(),
            tables,
        ))
    })?;
    if !committed {
        return saved;
    }
    crate::app_settings::source_saved(app, &generation);
    // Refresh presentation only. The Project instance and normal command history survive.
    if let Err(error) = app.emit(
        "settings-project-data-changed",
        serde_json::json!({
            "project_session": session, "table_uuids": tables,
        }),
    ) {
        eprintln!("Settings editor refresh notification failed: {error}");
    }
    let saved = saved?;
    notify_palette(app, &saved);
    Ok(saved)
}

pub(crate) fn submit_in_editor(
    app: &tauri::AppHandle,
    expected_revision: String,
    values: Vec<ColorSwatch>,
) -> Result<UserColorSwatches, AppError> {
    let handle = app.clone();
    app.state::<crate::command_dispatcher::CommandDispatcher>()
        .submit_native(move || replace_in_editor(&handle, expected_revision, values))
}

/// No network failure is retried or converted into a second local write.
pub(crate) fn replace(
    app: &tauri::AppHandle,
    expected_revision: String,
    values: Vec<ColorSwatch>,
) -> Result<UserColorSwatches, AppError> {
    checked_revision(&expected_revision)?;
    let values = devcel_core::normalize_color_swatches(values).map_err(AppError::from)?;
    if app
        .state::<settings_mode::ApplicationMode>()
        .is_settings_editor()
    {
        return submit_in_editor(app, expected_revision, values);
    }
    let handle = app.clone();
    app.state::<crate::command_dispatcher::CommandDispatcher>()
        .submit_native(move || replace_without_editor(&handle, expected_revision, values))
}

fn replace_without_editor(
    app: &tauri::AppHandle,
    expected_revision: String,
    values: Vec<ColorSwatch>,
) -> Result<UserColorSwatches, AppError> {
    let config = crate::settings_profile::directory(app)?;
    // Fences startup and updates while we choose exactly one writer.
    let _launch = settings_mode::transaction_launch_lock(&config)?;
    let saved = match app_settings_store::acquire_editor(&config) {
        Ok(lease) => {
            let mut project =
                devcel_core::Project::open_project(&lease.project_path.to_string_lossy())?;
            let saved = transaction(
                &config,
                &lease.generation,
                &mut project,
                None,
                &expected_revision,
                values,
            )?;
            crate::app_settings::source_saved(app, &lease.generation);
            saved
        }
        Err(AppError::Code { ref code, .. }) if code == "settings.editorBusy" => {
            // The lock may be held by an updater or a starting/closing editor.
            // Only a live authenticated editor endpoint can accept this one request.
            settings_mode::replace_swatches_via_gateway(&config, expected_revision, values)?
        }
        Err(error) => return Err(error),
    };
    notify_palette(app, &saved);
    Ok(saved)
}
