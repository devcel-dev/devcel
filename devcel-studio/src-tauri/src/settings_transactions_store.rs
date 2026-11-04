//! Strict source reads and generation/content CAS for ordinary palette transactions.
//! The caller holds the writer lease; this layer never falls back to a snapshot.
use crate::{app_settings_store, AppError};
use devcel_core::{ColorSwatch, Project};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserColorSwatches {
    pub revision: String,
    pub swatches: Vec<ColorSwatch>,
    #[serde(default)]
    pub warning: Option<devcel_core::types::Diagnostic>,
    #[serde(default = "default_writable")]
    pub writable: bool,
}
fn default_writable() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SwatchRevision {
    schema_version: u8,
    generation: String,
    source_revision: String,
}

fn revision(source: &app_settings_store::StrictSource) -> Result<String, AppError> {
    Ok(serde_json::to_string(&SwatchRevision {
        schema_version: 1,
        generation: source.generation.clone(),
        source_revision: source.source_revision.clone(),
    })?)
}

pub(crate) fn checked_revision(value: &str) -> Result<SwatchRevision, AppError> {
    if value.len() > 512 {
        return Err(AppError::code(
            "color.swatches.stale",
            serde_json::json!({}),
        ));
    }
    let revision: SwatchRevision = serde_json::from_str(value)
        .map_err(|_| AppError::code("color.swatches.stale", serde_json::json!({})))?;
    if revision.schema_version != 1
        || uuid::Uuid::parse_str(&revision.generation).is_err()
        || revision.source_revision.len() != 64
        || !revision
            .source_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::code(
            "color.swatches.stale",
            serde_json::json!({}),
        ));
    }
    Ok(revision)
}

fn swatches(source: &app_settings_store::StrictSource) -> Result<UserColorSwatches, AppError> {
    let values: Vec<ColorSwatch> = serde_json::from_value(
        source
            .bundle
            .get("userSwatches")
            .ok_or_else(|| AppError::code("settings.swatchTablesMissing", serde_json::json!({})))?
            .clone(),
    )?;
    devcel_core::validate_color_swatches(&values).map_err(AppError::from)?;
    Ok(UserColorSwatches {
        revision: revision(source)?,
        swatches: values,
        warning: None,
        writable: true,
    })
}

/// Invalid source remains an error. The palette cannot turn a fallback into source data.
pub(crate) fn read(config: &Path) -> Result<UserColorSwatches, AppError> {
    let _snapshot = app_settings_store::transaction_snapshot_lock(config)?;
    swatches(&app_settings_store::read_source_locked(config)?)
}

pub(crate) fn transaction(
    config: &Path,
    generation: &str,
    project: &mut Project,
    queue: Option<&Arc<devcel_core::file_save_queue::FileBasedSaveQueueManager>>,
    expected_revision: &str,
    values: Vec<ColorSwatch>,
) -> Result<UserColorSwatches, AppError> {
    transaction_observed(
        config,
        generation,
        project,
        queue,
        expected_revision,
        values,
    )
    .0
}

pub(crate) fn transaction_observed(
    config: &Path,
    generation: &str,
    project: &mut Project,
    queue: Option<&Arc<devcel_core::file_save_queue::FileBasedSaveQueueManager>>,
    expected_revision: &str,
    values: Vec<ColorSwatch>,
) -> (Result<UserColorSwatches, AppError>, bool) {
    transaction_observed_with_refresh(
        config,
        generation,
        project,
        queue,
        expected_revision,
        values,
        |config| swatches(&app_settings_store::read_source_locked(config)?),
    )
}

fn transaction_observed_with_refresh(
    config: &Path,
    generation: &str,
    project: &mut Project,
    queue: Option<&Arc<devcel_core::file_save_queue::FileBasedSaveQueueManager>>,
    expected_revision: &str,
    values: Vec<ColorSwatch>,
    refresh: impl FnOnce(&Path) -> Result<UserColorSwatches, AppError>,
) -> (Result<UserColorSwatches, AppError>, bool) {
    let mut committed = false;
    let saved = (|| {
        let expected = checked_revision(expected_revision)?;
        let values = devcel_core::normalize_color_swatches(values).map_err(AppError::from)?;
        let _snapshot = app_settings_store::transaction_snapshot_lock(config)?;
        let source = app_settings_store::read_source_locked(config)?;
        if source.generation != generation
            || expected.generation != generation
            || source.source_revision != expected.source_revision
        {
            return Err(AppError::code(
                "color.swatches.stale",
                serde_json::json!({}),
            ));
        }
        let current = swatches(&source)?;
        if current.swatches == values {
            return Ok(current);
        }
        devcel_core::app_catalog::replace_user_swatches(
            project,
            values.clone(),
            crate::settings_seed::message_contract()?,
            queue,
        )
        .map_err(AppError::from)?;
        committed = true;
        // Commit is complete. A later external source edit must never trigger a replay
        // or an attempt to reconstruct this project from the old compiled snapshot.
        match refresh(config) {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => Ok(UserColorSwatches {
                // No usable CAS token exists until a strict read succeeds. The
                // returned values are the confirmed commit, not a fallback cache.
                revision: String::new(),
                swatches: values,
                warning: Some(devcel_core::types::Diagnostic::Code {
                    code: "color.swatches.committedReloadRequired".into(),
                    params: serde_json::json!({ "error": error }),
                }),
                writable: false,
            }),
        }
    })();
    (saved, committed)
}

#[cfg(test)]
mod warning_tests {
    use super::*;

    #[test]
    fn committed_swatches_survive_refresh_failure_without_replay_and_reload_recovers() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path();
        let initial = read(config).unwrap();
        let lease = app_settings_store::acquire_editor(config).unwrap();
        let mut project = Project::open_project(&lease.project_path.to_string_lossy()).unwrap();
        let values = devcel_core::normalize_color_swatches(vec![ColorSwatch {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Keep literal UserSettings text".into(),
            data_type: devcel_core::ValueType::ColorFloat,
            value: "[-0.25,4,0.5,0]".into(),
        }])
        .unwrap();
        let user_path = config.join("settings/Tables/UserSettings.table.toml");
        let user_bytes = std::fs::read(&user_path).unwrap();
        let palette_path = config.join("settings/Tables/UserColorFloatSwatches.table.toml");
        let before_bytes = std::fs::read(&palette_path).unwrap();
        let (result, committed) = transaction_observed_with_refresh(
            config,
            &lease.generation,
            &mut project,
            None,
            &initial.revision,
            values.clone(),
            |config| {
                // An unrelated editor can invalidate the source after the write.
                let mut table: toml::Value =
                    toml::from_str(std::str::from_utf8(&user_bytes).unwrap()).unwrap();
                table["records"] = toml::Value::Array(vec![]);
                std::fs::write(&user_path, toml::to_string(&table).unwrap()).unwrap();
                swatches(&app_settings_store::read_source_locked(config)?)
            },
        );
        assert!(committed);
        let result = result.expect("a successful disk commit must not become a retryable failure");
        assert!(!result.writable);
        assert!(result.revision.is_empty());
        assert_eq!(result.swatches, values);
        let round_trip: UserColorSwatches =
            serde_json::from_value(serde_json::to_value(&result).unwrap()).unwrap();
        assert_eq!(round_trip, result);
        let warning = serde_json::to_value(&result.warning).unwrap();
        assert_eq!(warning["code"], "color.swatches.committedReloadRequired");
        assert_eq!(
            warning["params"]["error"]["diagnostics"][0]["code"],
            "settings.schema.singleton"
        );
        let committed_bytes = std::fs::read(&palette_path).unwrap();
        assert_ne!(committed_bytes, before_bytes);
        assert!(read(config).is_err());
        assert_eq!(std::fs::read(&palette_path).unwrap(), committed_bytes);
        // Empty CAS cannot replay a successful commit while source validation is broken.
        assert!(transaction(
            config,
            &lease.generation,
            &mut project,
            None,
            &result.revision,
            vec![]
        )
        .is_err());
        assert_eq!(std::fs::read(&palette_path).unwrap(), committed_bytes);
        std::fs::write(&user_path, &user_bytes).unwrap();
        let recovered = read(config).unwrap();
        assert!(recovered.writable);
        assert!(recovered.warning.is_none());
        assert!(!recovered.revision.is_empty());
        assert_eq!(recovered.swatches, values);
        assert_eq!(std::fs::read(&palette_path).unwrap(), committed_bytes);
    }
}
