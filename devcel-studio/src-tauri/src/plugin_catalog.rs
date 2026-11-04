//! Data-only API validating local/HTTPS catalogs. Does not fetch, execute, or automatically install packages.
use crate::plugin_packages::{valid_digest, validate_manifest, PluginManifest, PluginMetadata};
use devcel_core::AppError;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCatalogEntry {
    pub metadata: PluginMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCatalog {
    pub format_version: u32,
    pub plugins: Vec<PluginCatalogEntry>,
}

pub fn validate_catalog_json(json: &str) -> Result<PluginCatalog, AppError> {
    if json.len() > 1024 * 1024 {
        return Err(AppError::code(
            "plugin.catalog.error.size",
            json!({"max": 1024 * 1024}),
        ));
    }
    let mut catalog: PluginCatalog = serde_json::from_str(json).map_err(|e| {
        AppError::code(
            "plugin.catalog.error.json",
            json!({"details": e.to_string()}),
        )
    })?;
    if catalog.format_version != 1 {
        return Err(AppError::code(
            "plugin.catalog.error.version",
            json!({"actual": catalog.format_version, "supported": 1}),
        ));
    }
    if catalog.plugins.len() > 200 {
        return Err(AppError::code(
            "plugin.catalog.error.count",
            json!({"max": 200}),
        ));
    }
    let mut ids = BTreeSet::new();
    for entry in &mut catalog.plugins {
        validate_manifest(&PluginManifest {
            format_version: 1,
            metadata: entry.metadata.clone(),
            main: "main.js".into(),
            permissions: vec!["full-app-access".into()],
            capabilities: vec![],
            resources: Default::default(),
        })?;
        if !ids.insert(entry.metadata.id.clone()) {
            return Err(AppError::code(
                "plugin.catalog.error.duplicateId",
                json!({"id": entry.metadata.id}),
            ));
        }
        if entry
            .digest
            .as_ref()
            .is_some_and(|digest| !valid_digest(digest))
        {
            return Err(AppError::code(
                "plugin.catalog.error.digest",
                json!({"id": entry.metadata.id}),
            ));
        }
        if let Some(download_url) = &mut entry.download_url {
            if download_url.len() > 2048 {
                return Err(AppError::code(
                    "plugin.catalog.error.downloadLength",
                    json!({"max": 2048}),
                ));
            }
            let parsed = url::Url::parse(download_url).map_err(|e| {
                AppError::code(
                    "plugin.catalog.error.downloadParse",
                    json!({"details": e.to_string()}),
                )
            })?;
            if parsed.scheme() != "https"
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.fragment().is_some()
            {
                return Err(AppError::code(
                    "plugin.catalog.error.downloadSecurity",
                    json!({}),
                ));
            }
            *download_url = parsed.to_string();
        }
    }
    Ok(catalog)
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[test]
    fn catalog_format_json_and_manifest_errors_keep_their_codes() {
        let error = serde_json::to_value(
            validate_catalog_json(r#"{"formatVersion":7,"plugins":[]}"#).unwrap_err(),
        )
        .unwrap();
        assert_eq!(error["code"], "plugin.catalog.error.version");
        assert_eq!(error["params"], json!({"actual":7,"supported":1}));
        let error = serde_json::to_value(validate_catalog_json("{").unwrap_err()).unwrap();
        assert_eq!(error["code"], "plugin.catalog.error.json");
        assert!(error["params"]["details"]
            .as_str()
            .is_some_and(|details| !details.is_empty()));
        let error = serde_json::to_value(validate_catalog_json(r#"{"formatVersion":1,"plugins":[{"metadata":{"id":"../unsafe","name":"raw name","version":"1.0.0","description":"Invalid plugin ID","author":"raw","devcelVersion":"*"}}]}"#).unwrap_err()).unwrap();
        assert_eq!(error["code"], "plugin.package.error.id");
        assert_eq!(error["params"]["id"], "../unsafe");
    }
}
