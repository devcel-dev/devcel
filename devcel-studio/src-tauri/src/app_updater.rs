//! Build-time update configuration only. No endpoints, keys or credentials are generated.
use base64::Engine;
use devcel_core::Diagnostic;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterConfiguration {
    pub current_version: String,
    pub platform: String,
    pub supported: bool,
    pub configuration_status: String,
    pub reason: Diagnostic,
    pub platform_reason: Option<Diagnostic>,
    pub endpoints: Vec<String>,
}

// Validate exactly the compiled configuration also consumed by tauri-plugin-updater.
// Returning a disabled status (instead of failing plugin setup) keeps other app features usable.
fn validate_configuration(value: Option<&Value>) -> (String, Diagnostic, Vec<String>) {
    let diagnostic = |code: &str| Diagnostic::Code {
        code: code.into(),
        params: serde_json::json!({}),
    };
    let Some(value) = value else {
        return (
            "unconfigured".into(),
            diagnostic("updater.configuration.unconfigured"),
            vec![],
        );
    };
    if value.get("active").and_then(Value::as_bool) == Some(false) {
        return (
            "unconfigured".into(),
            diagnostic("updater.configuration.disabled"),
            vec![],
        );
    }
    let invalid = |code: &str| ("invalid".into(), diagnostic(code), vec![]);
    if !value.is_object() {
        return invalid("updater.configuration.invalidFormat");
    }
    if [
        "dangerousInsecureTransportProtocol",
        "dangerous-insecure-transport-protocol",
        "dangerousAcceptInvalidCerts",
        "dangerous-accept-invalid-certs",
        "dangerousAcceptInvalidHostnames",
        "dangerous-accept-invalid-hostnames",
    ]
    .iter()
    .any(|name| value.get(name).and_then(Value::as_bool) == Some(true))
    {
        return invalid("updater.configuration.insecureTransport");
    }
    if ["allowDowngrades", "allow-downgrades"]
        .iter()
        .any(|name| value.get(name).and_then(Value::as_bool) == Some(true))
    {
        return invalid("updater.configuration.downgrades");
    }
    let endpoints = match value.get("endpoints") {
        None => {
            return (
                "unconfigured".into(),
                diagnostic("updater.configuration.missingEndpoint"),
                vec![],
            )
        }
        Some(Value::Array(items)) if items.is_empty() => {
            return (
                "unconfigured".into(),
                diagnostic("updater.configuration.missingEndpoint"),
                vec![],
            )
        }
        Some(Value::Array(items)) => items,
        _ => return invalid("updater.configuration.endpointFormat"),
    };
    let mut safe_endpoints = Vec::new();
    for endpoint in endpoints {
        let Some(endpoint) = endpoint.as_str() else {
            return invalid("updater.configuration.endpointType");
        };
        let Ok(url) = url::Url::parse(endpoint) else {
            return invalid("updater.configuration.endpointUrl");
        };
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return invalid("updater.configuration.endpointSecurity");
        }
        safe_endpoints.push(endpoint.to_owned());
    }
    let Some(key) = value
        .get("pubkey")
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
    else {
        return (
            "unconfigured".into(),
            diagnostic("updater.configuration.missingPublicKey"),
            safe_endpoints,
        );
    };
    // Tauri public keys are base64-encoded minisign public-key documents, not private keys.
    let valid_key = base64::engine::general_purpose::STANDARD
        .decode(key)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| minisign_verify::PublicKey::decode(&text).ok())
        .is_some();
    if !valid_key {
        return invalid("updater.configuration.invalidPublicKey");
    }
    if serde_json::from_value::<tauri_plugin_updater::Config>(value.clone()).is_err() {
        return invalid("updater.configuration.invalidPlugin");
    }
    (
        "ready".into(),
        diagnostic("updater.configuration.ready"),
        safe_endpoints,
    )
}

#[tauri::command]
pub fn get_updater_configuration(app: tauri::AppHandle) -> UpdaterConfiguration {
    configuration(&app)
}

fn configuration(app: &tauri::AppHandle) -> UpdaterConfiguration {
    let (configuration_status, reason, endpoints) =
        validate_configuration(app.config().plugins.0.get("updater"));
    let target = tauri_plugin_updater::target();
    let supported = target.is_some();
    UpdaterConfiguration {
        current_version: app.package_info().version.to_string(),
        platform: target
            .unwrap_or_else(|| format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)),
        supported,
        configuration_status,
        reason,
        platform_reason: if supported {
            None
        } else {
            Some(Diagnostic::Code {
                code: "updater.configuration.unsupportedPlatform".into(),
                params: serde_json::json!({}),
            })
        },
        endpoints,
    }
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let status = configuration(app);
    if status.configuration_status == "ready" && status.supported {
        app.plugin(tauri_plugin_updater::Builder::new().build())?;
    }
    Ok(())
}
