//! The existing color picker edits the ordinary settings project's typed swatch tables.
use crate::AppError;
use devcel_core::ColorSwatch;
#[path = "color_swatch_settings_store.rs"]
mod store;
pub use crate::settings_transactions::UserColorSwatches;

#[tauri::command]
pub async fn get_user_color_swatches(app: tauri::AppHandle) -> Result<UserColorSwatches, AppError> {
    let config = crate::settings_profile::directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || crate::settings_transactions::read(&config))
        .await
        .map_err(AppError::technical)?
}

#[tauri::command]
pub async fn set_user_color_swatches(
    expected_revision: String,
    swatches: Vec<ColorSwatch>,
    app: tauri::AppHandle,
) -> Result<UserColorSwatches, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::settings_transactions::replace(&app, expected_revision, swatches)
    })
    .await
    .map_err(AppError::technical)?
}

/// Apply only an explicitly matching precision type. UI decoration is a separate
/// opaque-byte adapter; it never clamps HDR, drops alpha, or converts color spaces.
#[tauri::command]
pub fn apply_color_swatch(swatch: ColorSwatch, target_type: String) -> Result<String, AppError> {
    store::apply(swatch, &target_type)
}
