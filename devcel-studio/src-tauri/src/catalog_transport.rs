//! Explicit, bounded catalog reads. No redirects, cookies, authentication or code execution.
use devcel_core::AppError;
use futures::StreamExt;
use serde_json::json;

pub async fn fetch(url: &str) -> Result<crate::plugin_catalog::PluginCatalog, AppError> {
    if url.len() > 2048 {
        return Err(AppError::code(
            "settings.schema.catalogUrlLength",
            json!({"max": 2048}),
        ));
    }
    let url = url::Url::parse(url).map_err(|e| {
        AppError::code(
            "plugin.catalog.error.urlParse",
            json!({"details": e.to_string()}),
        )
    })?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::code(
            "settings.schema.catalogUrlSecurity",
            json!({}),
        ));
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| {
            AppError::code(
                "plugin.catalog.error.client",
                json!({"details": e.to_string()}),
            )
        })?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| {
            AppError::code(
                "plugin.catalog.error.fetch",
                json!({"details": e.to_string()}),
            )
        })?;
    if !response.status().is_success() {
        return Err(AppError::code(
            "plugin.catalog.error.status",
            json!({"status": response.status().as_u16()}),
        ));
    }
    const MAX: usize = 1024 * 1024;
    if response.content_length().is_some_and(|n| n > MAX as u64) {
        return Err(AppError::code(
            "plugin.catalog.error.size",
            json!({"max": 1024 * 1024}),
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            AppError::code(
                "plugin.catalog.error.receive",
                json!({"details": e.to_string()}),
            )
        })?;
        if chunk.len() > MAX - bytes.len() {
            return Err(AppError::code(
                "plugin.catalog.error.size",
                json!({"max": 1024 * 1024}),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let json = std::str::from_utf8(&bytes)
        .map_err(|_| AppError::code("plugin.catalog.error.encoding", json!({})))?;
    crate::plugin_catalog::validate_catalog_json(json)
}
